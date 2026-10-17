import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

interface Processor {
  port: { onmessage: (event: { data: unknown }) => void };
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

function processor(sampleRate = 48000) {
  let Constructor!: new () => Processor;
  runInNewContext(readFileSync(new URL('./voiceVolumeBalance.worklet.js', import.meta.url), 'utf8'), {
    sampleRate,
    AudioWorkletProcessor: class { port = { onmessage: () => {} }; },
    registerProcessor: (_name: string, type: typeof Constructor) => { Constructor = type; },
  });
  const instance = new Constructor();
  let frame = 0;
  function render(amplitude: number, seconds = 1, enabled = true, audible = true, channels = 1, blockSize = 128) {
    let sum = 0;
    let count = 0;
    let peak = 0;
    let last: Float32Array[] = [];
    for (let block = 0; block < Math.ceil(seconds * sampleRate / blockSize); block++) {
      const input = Array.from({ length: channels }, (_, channel) => Float32Array.from({ length: blockSize },
        (_, index) => amplitude * Math.sin((frame + index) * 2 * Math.PI * 440 / sampleRate) * (channel ? 0.5 : 1)));
      last = input.map(() => new Float32Array(blockSize));
      instance.process([input], [last], { enabled: new Float32Array([Number(enabled)]), audible: new Float32Array([Number(audible)]) });
      if (block >= Math.floor(seconds * sampleRate / blockSize * 0.75)) {
        for (const value of last[0]) { sum += value * value; count++; }
      }
      for (const value of last[0]) peak = Math.max(peak, Math.abs(value));
      frame += blockSize;
    }
    return { rms: Math.sqrt(sum / count), peak, last };
  }
  return { instance, render };
}

describe('接收人声平衡的实际 PCM 处理', () => {
  it.each([44100, 48000])('把相差 20 dB 的讲话拉近至 1 dB 内，采样率 %s', (rate) => {
    const quiet = processor(rate).render(0.05, 4).rms;
    const loud = processor(rate).render(0.5, 4).rms;
    expect(Math.abs(20 * Math.log10(quiet / loud))).toBeLessThan(1);
    expect(quiet).toBeGreaterThan(0.09);
    expect(loud).toBeLessThan(0.11);
  });

  it('长时间静音与门限下底噪不被持续放大，增益上限为四倍', () => {
    const { render } = processor();
    expect(render(0, 4).peak).toBe(0);
    expect(render(0.002, 4).peak).toBeLessThanOrEqual(0.002001);
    expect(render(0.01, 4).peak).toBeLessThanOrEqual(0.040001);
    expect(render(0, 2).peak).toBe(0);
    expect(render(0.002, 2).peak).toBeLessThanOrEqual(0.0021);
  });

  it('小声转为突然大声时立即限峰，关闭后原样直通', () => {
    const { render } = processor();
    render(0.02, 4);
    expect(render(1, 0.2).peak).toBeLessThanOrEqual(0.900001);
    const bypass = render(0.4, 0.1, false);
    expect(bypass.peak).toBeCloseTo(0.4, 4);
    expect(bypass.rms).toBeGreaterThan(0.27);
  });

  it('双声道维持相对比例，禁声优先于开关且不缓冲旧声音', () => {
    const { render } = processor();
    const stereo = render(0.08, 2, true, true, 2, 256);
    stereo.last[0].forEach((value, index) => expect(stereo.last[1][index]).toBeCloseTo(value * 0.5, 6));
    expect(render(0.5, 0.1, true, false).peak).toBe(0);
    expect(render(0.5, 0.1, false, false).peak).toBe(0);
    expect(render(0, 0.1).peak).toBe(0);
  });

  it('释放通知结束处理器，不在断开后空转', () => {
    const { instance } = processor();
    instance.port.onmessage({ data: { type: 'stop' } });
    expect(instance.process([], [[new Float32Array(128)]], {})).toBe(false);
  });
});
