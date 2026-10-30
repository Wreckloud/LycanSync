import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

function fixture() {
  let Constructor!: new () => { port: { onmessage: (event: { data: unknown }) => void };
    process: (inputs: unknown[], outputs: Float32Array[][]) => boolean };
  const accepted: number[] = [];
  runInNewContext(readFileSync(new URL('./nativeMicrophoneAudio.worklet.js', import.meta.url), 'utf8'), {
    ArrayBuffer, Float32Array, sampleRate: 48000,
    AudioWorkletProcessor: class { port = { postMessage: (message: { sequence: number }) => accepted.push(message.sequence) }; },
    registerProcessor: (_name: string, value: typeof Constructor) => { Constructor = value; },
  });
  const processor = new Constructor();
  let sequence = 0;
  return {
    accepted,
    gate: (pushToTalk: boolean, held: boolean) => processor.port.onmessage({ data: { type: 'gate', pushToTalk, held } }),
    send: (value: number) => processor.port.onmessage({ data: { type: 'chunk', sequence: ++sequence,
      pcm: new Float32Array(480).fill(value).buffer } }),
    render: () => { const samples = new Float32Array(480); processor.process([], [[samples]]); return [...samples]; },
  };
}

it('按键外静音，开口清掉旧缓冲，松开清掉待播声音；确认仍正常回收容量', () => {
  const f = fixture();
  f.gate(true, false);
  f.send(0.75);
  expect(f.render().every(value => value === 0)).toBe(true);
  f.send(0.5);
  f.gate(true, true);
  expect(f.render().every(value => value === 0)).toBe(true);
  f.send(0.25);
  expect(f.render().every(value => value === 0.25)).toBe(true);
  for (let index = 0; index < 8; index++) f.send(0.75);
  f.gate(true, false);
  expect(f.render().every(value => value === 0)).toBe(true);
  expect(f.accepted).toHaveLength(11);
  expect(new Set(f.accepted).size).toBe(11);
});

it('没有新授权时 350 毫秒音频后静音，切回自由发言不保留过期限制', () => {
  const f = fixture();
  f.gate(true, true);
  for (let index = 0; index < 35; index++) { f.send(0.25); expect(f.render().every(value => value === 0.25)).toBe(true); }
  f.send(0.5);
  expect(f.render().every(value => value === 0)).toBe(true);
  f.gate(false, false);
  f.send(0.5);
  expect(f.render().every(value => value === 0.5)).toBe(true);
});
