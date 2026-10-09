import { test, expect, _electron as electron } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

test('麦克风试听本机 Opus 编解码并释放资源，不停止原音轨', async () => {
  const rendererRoot = test.info().outputPath('loopback-renderer');
  mkdirSync(resolve(rendererRoot, 'assets'), { recursive: true });
  const module = ts.transpileModule(readFileSync(resolve('src/rtc/microphoneLoopback.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  writeFileSync(resolve(rendererRoot, 'assets/microphoneLoopback.js'), module.outputText);
  const profile = test.info().outputPath('loopback-profile');
  mkdirSync(profile, { recursive: true });
  const application = await electron.launch({ args: [resolve('tests/fixtures/audioWorklet.cjs'), rendererRoot, profile] });
  try {
    const page = await application.firstWindow();
    const results = await page.evaluate(async () => {
      const moduleUrl = '/assets/microphoneLoopback.js';
      const { MicrophoneLoopback } = await import(moduleUrl);
      const input = new AudioContext({ sampleRate: 48000 });
      const oscillator = input.createOscillator();
      const destination = input.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      await input.resume();
      const original = destination.stream.getAudioTracks()[0];
      const results = [];
      try {
        for (let iteration = 0; iteration < 3; iteration++) {
          const peers: RTCPeerConnection[] = [];
          let output!: AudioContext;
          let analyser: AnalyserNode | undefined;
          const loopback = new MicrophoneLoopback({
            createPeer: () => { const peer = new RTCPeerConnection({ iceServers: [] }); peers.push(peer); return peer; },
            createContext: () => {
              output = new AudioContext({ sampleRate: 48000 });
              const createSource = output.createMediaStreamSource.bind(output);
              output.createMediaStreamSource = (stream) => {
                const source = createSource(stream);
                analyser = output.createAnalyser();
                source.connect(analyser);
                return source;
              };
              return output;
            },
          });
          try {
            // All audible output is muted; synthetic input never reaches speakers or a server.
            await loopback.start(original, 0, 64000, true);
            let packets = 0;
            let energy = 0;
            let codec = '';
            const deadline = performance.now() + 3000;
            while (performance.now() < deadline && (!packets || !energy)) {
              const stats = await peers[1].getStats();
              stats.forEach((report) => {
                if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                  packets = report.packetsReceived;
                  codec = stats.get(report.codecId)?.mimeType ?? '';
                }
              });
              if (analyser) {
                const samples = new Float32Array(analyser.fftSize);
                analyser.getFloatTimeDomainData(samples);
                energy = Math.max(...samples.map((sample) => Math.abs(sample)));
              }
              if (!packets || !energy) await new Promise((resolveWait) => setTimeout(resolveWait, 30));
            }
            if (iteration === 2) original.dispatchEvent(new Event('ended'));
            else loopback.stop();
            loopback.stop();
            await new Promise((resolveWait) => setTimeout(resolveWait, 50));
            results.push({ packets, energy, codec, original: original.readyState,
              peers: peers.map((peer) => peer.connectionState), output: output.state });
          } finally { loopback.stop(); }
        }
        return results;
      } finally {
        oscillator.stop();
        original.stop();
        await input.close();
      }
    });
    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.packets).toBeGreaterThan(0);
      expect(result.energy, JSON.stringify(results)).toBeGreaterThan(0);
      expect(result.codec.toLowerCase()).toBe('audio/opus');
      expect(result.original).toBe('live');
      expect(result.peers).toEqual(['closed', 'closed']);
      expect(result.output).toBe('closed');
    }
  } finally { await application.close(); }
});
