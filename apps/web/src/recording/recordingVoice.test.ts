import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { RecordingVoice } from './recordingVoice';

afterEach(() => vi.unstubAllGlobals());

it('人声工作器最多保留两块在途，丢块保留采样位置，输出不在本机播放', () => {
  const messages: { position: number; pcm: ArrayBuffer }[] = [];
  let Constructor!: new () => { process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
    port: { onmessage(event: { data: { type: string } }): void } };
  const context = { currentFrame: 0, ArrayBuffer, Float32Array, Number, Math,
    AudioWorkletProcessor: class { port = { onmessage: () => {}, postMessage: (value: { position: number; pcm: ArrayBuffer }) => messages.push(value) }; },
    registerProcessor: (_name: string, constructor: typeof Constructor) => { Constructor = constructor; } };
  runInNewContext(readFileSync(new URL('./recordingVoice.worklet.js', import.meta.url), 'utf8'), context);
  const processor = new Constructor();
  const output = [[new Float32Array(480)]];
  for (let index = 0; index < 3; index++) {
    context.currentFrame = index * 480;
    expect(processor.process([[new Float32Array(480).fill(2)]], output)).toBe(true);
  }
  expect(messages).toHaveLength(2);
  expect(Array.from(new Float32Array(messages[0]!.pcm))).toEqual(Array(480).fill(1));
  expect(Array.from(output[0]![0]!)).toEqual(Array(480).fill(0));
  processor.port.onmessage({ data: { type: 'ack' } }); context.currentFrame = 1440;
  processor.process([[new Float32Array(480).fill(0.5)]], output);
  expect(messages[2]!.position).toBe(1440);
  processor.port.onmessage({ data: { type: 'stop' } });
  expect(processor.process([], output)).toBe(false);
});

it('混音仅借用提供的轨道，静音后断开，结束不停止原始麦克风或朋友轨道', async () => {
  class Node {
    gain = { value: 0 }; threshold = { value: 0 }; knee = { value: 0 }; ratio = { value: 0 };
    attack = { value: 0 }; release = { value: 0 };
    connect = vi.fn(() => this); disconnect = vi.fn();
    port = { postMessage: vi.fn(), close: vi.fn(), onmessage: null };
    onprocessorerror = null;
  }
  const sources: Node[] = [];
  const close = vi.fn(async () => {});
  vi.stubGlobal('AudioContext', class {
    sampleRate = 48000; state = 'running'; destination = new Node();
    audioWorklet = { addModule: vi.fn(async () => {}) };
    createMediaStreamSource() { const source = new Node(); sources.push(source); return source; }
    createGain() { return new Node(); } createDynamicsCompressor() { return new Node(); }
    resume = vi.fn(async () => {}); close = close;
  });
  vi.stubGlobal('AudioWorkletNode', Node);
  vi.stubGlobal('MediaStream', class { constructor(readonly tracks: MediaStreamTrack[]) {} });
  const mic = { readyState: 'live', stop: vi.fn() };
  const friend = { readyState: 'live', stop: vi.fn() };
  const graph = new RecordingVoice('recording', async () => true, vi.fn());
  await graph.start();
  graph.update([{ track: mic as unknown as MediaStreamTrack, gain: 1 }, { track: friend as unknown as MediaStreamTrack, gain: 0.5 }]);
  expect(sources).toHaveLength(2);
  graph.update([{ track: mic as unknown as MediaStreamTrack, gain: 0 }]);
  expect(sources.every(source => source.disconnect.mock.calls.length === 1)).toBe(true);
  await graph.stop(); await graph.stop();
  expect(close).toHaveBeenCalledTimes(1);
  expect(mic.stop).not.toHaveBeenCalled(); expect(friend.stop).not.toHaveBeenCalled();
});
