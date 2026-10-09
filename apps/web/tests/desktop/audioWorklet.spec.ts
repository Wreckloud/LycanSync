import { test, expect, _electron as electron } from '@playwright/test';
import { readdirSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

test('桌面音频模块在正式安全策略下加载且不依赖 Blob 脚本', async () => {
  const rendererRoot = resolve(process.env.LYCANSYNC_TEST_RENDERER_DIR ?? 'dist');
  const assets = readdirSync(resolve(rendererRoot, 'assets'));
  const modules = [
    { prefix: 'nativeMicrophoneAudio.worklet-', processor: 'lycan-native-microphone', channels: 1 },
    { prefix: 'nativeScreenAudio.worklet-', processor: 'lycan-screen-audio', channels: 2 },
  ].map((module) => {
    const files = assets.filter((file) => file.startsWith(module.prefix) && file.endsWith('.js'));
    expect(files).toHaveLength(1);
    return { ...module, url: `/assets/${files[0]}` };
  });
  const profile = test.info().outputPath('audio-worklet-profile');
  mkdirSync(profile, { recursive: true });
  const application = await electron.launch({ args: [
    resolve('tests/fixtures/audioWorklet.cjs'), rendererRoot, profile,
  ] });
  try {
    const page = await application.firstWindow();
    for (const module of modules) {
      const result = await page.evaluate(async ({ url, processor, channels }) => {
        const context = new AudioContext({ sampleRate: 48000 });
        let blobUrl: string | undefined;
        let node: AudioWorkletNode | undefined;
        try {
          const source = await (await fetch(url)).text();
          blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
          let blobBlocked = false;
          try { await context.audioWorklet.addModule(blobUrl); }
          catch { blobBlocked = true; }
          await context.audioWorklet.addModule(url);
          node = new AudioWorkletNode(context, processor, {
            numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [channels],
          });
          node.connect(context.createMediaStreamDestination());
          await context.resume();
          const accepted = new Promise<number>((resolveAccepted, reject) => {
            const timer = setTimeout(() => reject(new Error('Worklet did not accept PCM')), 3000);
            node!.port.onmessage = ({ data }) => {
              if (data?.type !== 'accepted') return;
              clearTimeout(timer);
              resolveAccepted(data.sequence);
            };
          });
          const pcm = new Float32Array(480 * channels).fill(0.25);
          node.port.postMessage({ type: 'chunk', sequence: 7, pcm: pcm.buffer }, [pcm.buffer]);
          return { blobBlocked, sequence: await accepted };
        } finally {
          node?.port.close();
          node?.disconnect();
          if (blobUrl) URL.revokeObjectURL(blobUrl);
          await context.close();
        }
      }, module);
      expect(result).toEqual({ blobBlocked: true, sequence: 7 });
    }
  } finally {
    await application.close();
  }
});
