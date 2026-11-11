import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

interface Processor {
  queue: unknown[];
  pendingAcknowledgements: number[];
  dropped: number;
  port: { onmessage: (event: { data: unknown }) => void };
  process(inputs: unknown[], outputs: Float32Array[][]): boolean;
}
function worklet(channels: number) {
  const acknowledgements: { sequence: number; droppedChunks: number }[] = [];
  let constructor!: new () => Processor;
  const filename = channels === 1 ? 'nativeMicrophoneAudio' : 'nativeScreenAudio';
  runInNewContext(readFileSync(new URL(`./${filename}.worklet.js`, import.meta.url), 'utf8'), {
    ArrayBuffer, Float32Array,
    AudioWorkletProcessor: class {
      port = { postMessage: (message: { sequence: number; droppedChunks: number }) => acknowledgements.push(message) };
    },
    registerProcessor: (_name: string, type: new () => Processor) => { constructor = type; },
  });
  const processor = new constructor();
  const send = (sequence: number) => {
    const samples = new Float32Array(480 * channels);
    for (let frame = 0; frame < 480; frame++) {
      for (let channel = 0; channel < channels; channel++) samples[frame * channels + channel] = sequence + channel / 2;
    }
    processor.port.onmessage({ data: { type: 'chunk', sequence, pcm: samples.buffer } });
  };
  const render = (frames = 480) => {
    const output = Array.from({ length: channels }, () => new Float32Array(frames));
    expect(processor.process([], [output])).toBe(true);
    return output;
  };
  return { processor, acknowledgements, send, render };
}

describe.each([1, 2])('native audio %i-channel playback flow control', (channels) => {
  it('plays a four-block burst without loss and defers acknowledgement until capacity returns', () => {
    const { processor, acknowledgements, send, render } = worklet(channels);
    for (let sequence = 1; sequence <= 4; sequence++) send(sequence);
    expect(acknowledgements.map((message) => message.sequence)).toEqual([1, 2, 3]);
    for (let sequence = 1; sequence <= 4; sequence++) {
      const output = render();
      for (let channel = 0; channel < channels; channel++) {
        expect(Array.from(output[channel])).toEqual(Array(480).fill(sequence + channel / 2));
      }
    }
    expect(processor.dropped).toBe(0);
    expect(acknowledgements.map((message) => message.sequence)).toEqual([1, 2, 3, 4]);
    expect(Array.from(render()[0])).toEqual(Array(480).fill(0));
  });
  it('bounds samples and deferred acknowledgements under overload and recovers', () => {
    const { processor, acknowledgements, send, render } = worklet(channels);
    for (let sequence = 1; sequence <= 30; sequence++) send(sequence);
    expect(processor.queue).toHaveLength(12);
    expect(processor.pendingAcknowledgements.length).toBeLessThanOrEqual(12);
    expect(processor.dropped).toBe(18);
    for (let sequence = 19; sequence <= 30; sequence++) {
      expect(Array.from(render()[0])).toEqual(Array(480).fill(sequence));
    }
    expect(processor.pendingAcknowledgements).toHaveLength(0);
    expect(acknowledgements.map((message) => message.sequence).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
    expect(acknowledgements.at(-1)?.droppedChunks).toBe(18);
    send(31);
    expect(Array.from(render()[0])).toEqual(Array(480).fill(31));
  });
  it('preserves samples across 128-frame render quanta', () => {
    const { processor, send, render } = worklet(channels);
    for (let sequence = 1; sequence <= 4; sequence++) send(sequence);
    const samples = Array.from({ length: 15 }, () => Array.from(render(128)[0])).flat();
    expect(samples).toEqual([1, 2, 3, 4].flatMap((sequence) => Array(480).fill(sequence)));
    expect(processor.dropped).toBe(0);
  });
});

interface AudioCapture {
  start(...args: unknown[]): Promise<unknown>;
  stop(sessionId: string): Promise<unknown>;
  acknowledge(sessionId: string, sequence: number, dropped: number): void;
  diagnostics(): Promise<{ microphoneCaptureDroppedChunks: number }>;
  droppedChunks: number;
}
const require = createRequire(import.meta.url);
const { createNativeMicrophone } = require('../../electron/native-microphone.cjs') as {
  createNativeMicrophone(options: Record<string, unknown>): AudioCapture;
};
const { createNativeScreenAudio } = require('../../electron/native-screen-audio.cjs') as {
  createNativeScreenAudio(options: Record<string, unknown>): AudioCapture;
};
const captures: AudioCapture[] = [];
afterEach(async () => { await Promise.all(captures.splice(0).map(capture => capture.stop('session-b'))); });

// 直接连接生产管道入口与 Worklet；宿主和管道均为受控对象，不访问真实设备。
async function mainAudio(channels: number) {
  const server = new class extends EventEmitter {
    listening = false;
    listen() { this.listening = true; queueMicrotask(() => this.emit('listening')); }
    close() { this.listening = false; }
  }();
  const sent: { sessionId: string; sequence: number; pcm: Uint8Array }[] = [];
  const format = { sampleRate: 48000, channels, bitsPerSample: 32, nominalChunkMs: 10 };
  const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false,
    send: (_channel: string, packet: typeof sent[number]) => sent.push(packet) } };
  const video = { sessionId: 'session-b', sourceId: 'monitor:7:0' };
  const capture = (channels === 1 ? createNativeMicrophone : createNativeScreenAudio)({
    host: { start: async () => format, startScreenAudio: async () => format,
      stop: async () => ({ changed: true }), stopScreenAudio: async () => ({ changed: true }),
      getDiagnostics: async () => ({ droppedChunks: 0 }) },
    getWindow: () => window, getVideo: () => video,
    getRecording: () => ({}), isClosing: () => false, platform: 'win32',
    capability: () => ({ available: true, reason: 'windowsApplicationLoopbackProcessTree' }),
    createPipeServer: () => server, writeDiagnostic: async () => {},
  });
  captures.push(capture);
  // 共享来源身份必须保持同一对象，不能在每次查询时伪造新的会话。
  const startArgs = channels === 1
    ? ['session-b', { noiseSuppression: true, autoGainControl: true, voiceEnhancement: true, inputGain: 1 }, 'default', false]
    : ['monitor:7:0', 'session-b'];
  await capture.start(...startArgs);
  const socket = new class extends EventEmitter {
    destroyed = false;
    setNoDelay() {}
    destroy() { this.destroyed = true; this.emit('close'); }
  }();
  server.emit('connection', socket);
  const packet = (value: number) => {
    const header = channels === 1 ? 8 : 4;
    const bytes = Buffer.alloc(header + 480 * channels * 4);
    bytes.writeUInt32LE(480);
    for (let index = 0; index < 480 * channels; index++) bytes.writeFloatLE(value, header + index * 4);
    return bytes;
  };
  const acknowledge = (sessionId = 'session-b', sequence = sent.at(-1)!.sequence, droppedChunks = 0) =>
    capture.acknowledge(sessionId, sequence, droppedChunks);
  return { sent, receive: (bytes: Buffer) => socket.emit('data', bytes), packet, acknowledge,
    stop: () => capture.stop('session-b'),
    drops: async () => channels === 1 ? (await capture.diagnostics()).microphoneCaptureDroppedChunks : capture.droppedChunks };
}
describe.each([1, 2])('native audio %i-channel pipe buffering', (channels) => {
  it('retains ten combined packets and sends one at a time until acknowledged', async () => {
    const main = await mainAudio(channels);
    const { sent, receive, packet, acknowledge } = main;
    receive(Buffer.concat(Array.from({ length: 10 }, (_, index) => packet(index + 1))));
    expect(sent).toHaveLength(1);
    expect(sent[0].sessionId).toBe('session-b');
    expect(await main.drops()).toBe(0);
    for (let index = 1; index < 10; index++) acknowledge();
    expect(sent.map((message) => Buffer.from(message.pcm).readFloatLE())).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    acknowledge();
    expect(sent).toHaveLength(10);
  });
  it('connects pipe acknowledgements to playback without gaps or an unbounded renderer backlog', async () => {
    const main = await mainAudio(channels);
    const playback = worklet(channels);
    let sentIndex = 0;
    let acknowledgementIndex = 0;
    const deliver = () => {
      while (sentIndex < main.sent.length) {
        const packet = main.sent[sentIndex++];
        playback.processor.port.onmessage({ data: { type: 'chunk', sequence: packet.sequence,
          pcm: packet.pcm.buffer.slice(packet.pcm.byteOffset, packet.pcm.byteOffset + packet.pcm.byteLength) } });
        while (acknowledgementIndex < playback.acknowledgements.length) {
          const acknowledgement = playback.acknowledgements[acknowledgementIndex++];
          main.acknowledge('session-b', acknowledgement.sequence, acknowledgement.droppedChunks);
        }
      }
    };
    main.receive(Buffer.concat(Array.from({ length: 10 }, (_, index) => main.packet(index + 1))));
    deliver();
    expect(playback.processor.queue).toHaveLength(4);
    const samples: number[] = [];
    for (let quantum = 0; quantum < 38; quantum++) {
      samples.push(...playback.render(128)[0]);
      while (acknowledgementIndex < playback.acknowledgements.length) {
        const acknowledgement = playback.acknowledgements[acknowledgementIndex++];
        main.acknowledge('session-b', acknowledgement.sequence, acknowledgement.droppedChunks);
      }
      deliver();
      expect(playback.processor.queue.length).toBeLessThanOrEqual(4);
    }
    expect(samples.slice(0, 4800)).toEqual(Array.from({ length: 10 }, (_, index) => Array(480).fill(index + 1)).flat());
    expect(await main.drops()).toBe(0);
    expect(playback.processor.dropped).toBe(0);
    main.acknowledge();
    expect(main.sent).toHaveLength(10);
    expect(playback.processor.pendingAcknowledgements).toHaveLength(0);
  });
  it('drops oldest queued packets on overload and ignores packets after stopping', async () => {
    const main = await mainAudio(channels);
    const { sent, receive, packet, acknowledge } = main;
    receive(packet(1));
    receive(Buffer.concat(Array.from({ length: 20 }, (_, index) => packet(index + 2))));
    expect(await main.drops()).toBe(8);
    for (let index = 0; index < 12; index++) acknowledge();
    expect(sent.map((message) => Buffer.from(message.pcm).readFloatLE())).toEqual([1, ...Array.from({ length: 12 }, (_, index) => index + 10)]);
    await main.stop();
    receive(packet(22));
    expect(sent).toHaveLength(13);
  });
  it('rejects a late acknowledgement from another session with the same sequence', async () => {
    const main = await mainAudio(channels);
    const { sent, receive, packet, acknowledge } = main;
    receive(Buffer.concat([packet(1), packet(2)]));
    expect(sent.at(-1)?.sequence).toBe(1);

    acknowledge('session-a', 1, 7);
    expect(sent.at(-1)?.sequence).toBe(1);
    expect(await main.drops()).toBe(0);
    expect(sent).toHaveLength(1);

    acknowledge('session-b', 1, 2);
    expect(sent.at(-1)?.sequence).toBe(2);
    expect(await main.drops()).toBe(2);
    expect(sent).toHaveLength(2);
    expect(sent[1].sessionId).toBe('session-b');
  });
  it('rejects missing or invalid acknowledgement session identifiers', async () => {
    const main = await mainAudio(channels);
    const { sent, receive, packet, acknowledge } = main;
    receive(Buffer.concat([packet(1), packet(2)]));
    acknowledge('', 1, 5);
    expect(sent.at(-1)?.sequence).toBe(1);
    expect(await main.drops()).toBe(0);
    expect(sent).toHaveLength(1);
  });
});
