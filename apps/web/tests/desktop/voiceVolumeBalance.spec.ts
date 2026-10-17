import { test, expect, _electron as electron } from '@playwright/test';
import { readdirSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

test('正式安全策略下的人声平衡模块处理合成信号，手动音量与静音仍优先', async () => {
  const rendererRoot = resolve(process.env.LYCANSYNC_TEST_RENDERER_DIR ?? 'dist');
  const file = readdirSync(resolve(rendererRoot, 'assets'))
    .find((name) => name.startsWith('voiceVolumeBalance.worklet-') && name.endsWith('.js'));
  expect(file).toBeTruthy();
  const profile = test.info().outputPath('voice-balance-profile');
  mkdirSync(profile, { recursive: true });
  const application = await electron.launch({ args: [resolve('tests/fixtures/audioWorklet.cjs'), rendererRoot, profile] });
  try {
    const page = await application.firstWindow();
    const result = await page.evaluate(async (url) => {
      async function render(amplitude: number, balance: boolean, volume: number) {
        // 离线合成到内存，不连接系统播放设备，也不请求采集权限。
        const rate = 48000;
        const context = new OfflineAudioContext(1, rate * 4, rate);
        await context.audioWorklet.addModule(url);
        const node = new AudioWorkletNode(context, 'lycan-voice-volume-balance', {
          parameterData: { enabled: Number(balance), audible: Number(volume > 0) },
        });
        const buffer = context.createBuffer(1, rate * 4, rate);
        const samples = buffer.getChannelData(0);
        for (let index = 0; index < samples.length; index++) samples[index] = amplitude * Math.sin(index * 2 * Math.PI * 440 / rate);
        const source = context.createBufferSource();
        source.buffer = buffer;
        const manual = context.createGain();
        manual.gain.value = volume;
        source.connect(node).connect(manual).connect(context.destination);
        source.start();
        const output = (await context.startRendering()).getChannelData(0);
        let power = 0;
        for (let index = rate * 3; index < output.length; index++) power += output[index] ** 2;
        node.port.postMessage({ type: 'stop' });
        node.port.close(); node.disconnect(); source.disconnect(); manual.disconnect();
        return Math.sqrt(power / rate);
      }
      return { quiet: await render(0.05, true, 1), loud: await render(0.5, true, 1),
        manual: await render(0.05, true, 0.5), muted: await render(0.5, true, 0),
        bypass: await render(0.5, false, 1) };
    }, `/assets/${file}`);
    expect(Math.abs(20 * Math.log10(result.quiet / result.loud))).toBeLessThan(1);
    expect(result.manual / result.quiet).toBeCloseTo(0.5, 4);
    expect(result.muted).toBe(0);
    expect(result.bypass).toBeCloseTo(0.5 / Math.SQRT2, 4);
    console.log('人声平衡合成测量（RMS）', result);
  } finally { await application.close(); }
});
