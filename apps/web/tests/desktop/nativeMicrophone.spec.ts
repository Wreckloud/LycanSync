import { test, expect, _electron as electron } from '@playwright/test';
import { mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

test('桌面真实麦克风经主进程管道传入音频模块并正常停止', async () => {
  test.skip(process.platform !== 'win32', 'Native microphone capture requires Windows');
  const worklet = readdirSync(resolve('dist/assets'))
    .find((file) => file.startsWith('nativeMicrophoneAudio.worklet-') && file.endsWith('.js'));
  expect(worklet).toBeTruthy();
  const profile = test.info().outputPath('native-microphone-profile');
  mkdirSync(profile, { recursive: true });
  // No account or RTC room is needed; this test samples the real default microphone locally.
  const application = await electron.launch({ args: [
    resolve('electron/main.cjs'), `--user-data-dir=${profile}`,
  ], env: { ...process.env, LYCANSYNC_API_URL: 'http://127.0.0.1:1' } });
  try {
    const page = await application.firstWindow();
    const result = await page.evaluate(async (workletUrl) => {
      const desktop = window.lycanDesktop!;
      const sessionId = crypto.randomUUID();
      const context = new AudioContext({ sampleRate: 48000 });
      let node: AudioWorkletNode | undefined;
      let started = false;
      let chunks = 0;
      let bytes = 0;
      let malformed = 0;
      let captureError: string | undefined;
      let removeChunks: (() => void) | undefined;
      const removeErrors = desktop.onNativeMicrophoneError((event) => {
        if (event.sessionId === sessionId) captureError = event.code;
      });
      try {
        await context.audioWorklet.addModule(workletUrl);
        node = new AudioWorkletNode(context, 'lycan-native-microphone', {
          numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
        });
        node.connect(context.createMediaStreamDestination());
        node.port.onmessage = ({ data }) => {
          if (data?.type === 'accepted') desktop.acknowledgeNativeMicrophoneChunk(sessionId, data.sequence, data.droppedChunks);
        };
        removeChunks = desktop.onNativeMicrophoneChunk((chunk) => {
          if (chunk.sessionId !== sessionId) return;
          if (chunk.frames !== 480 || chunk.sampleRate !== 48000 || chunk.channels !== 1
              || chunk.pcm.byteLength !== 1920) malformed++;
          chunks++;
          bytes += chunk.pcm.byteLength;
          const pcm = chunk.pcm.slice();
          node!.port.postMessage({ type: 'chunk', sequence: chunk.sequence, pcm: pcm.buffer }, [pcm.buffer]);
        });
        await context.resume();
        const format = await desktop.startNativeMicrophone(sessionId, {
          inputGain: 1, noiseSuppression: true, autoGainControl: true, voiceEnhancement: true,
        });
        started = true;
        await new Promise((resolveSample) => setTimeout(resolveSample, 3000));
        return { format, chunks, bytes, malformed, captureError };
      } finally {
        if (started) await desktop.stopNativeMicrophone(sessionId);
        removeChunks?.();
        removeErrors();
        node?.port.close();
        node?.disconnect();
        await context.close();
      }
    }, `/assets/${worklet}`);
    expect(result.format).toMatchObject({ sampleRate: 48000, channels: 1, bitsPerSample: 32, nominalChunkMs: 10 });
    expect(result.chunks).toBeGreaterThan(0);
    expect(result.bytes).toBe(result.chunks * 1920);
    expect(result.malformed).toBe(0);
    expect(result.captureError).toBeUndefined();
  } finally {
    await application.close();
  }
});
