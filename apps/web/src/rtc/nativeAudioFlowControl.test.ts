import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

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

interface MainAudioState {
  sessionId: string;
  buffer: Buffer;
  queue: { frames: number; pcm: Uint8Array }[];
  sequence: number;
  inFlight?: number;
  stopping: boolean;
  droppedChunks: number;
  rendererDroppedChunks: number;
  sampleRate: number;
}
// Run the production parser and sender without launching Electron or accessing devices.
function mainAudio(channels: number) {
  const source = readFileSync(new URL('../../electron/main.cjs', import.meta.url), 'utf8');
  const kind = channels === 1 ? 'Microphone' : 'ScreenAudio';
  const extract = (name: string) => {
    const start = source.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`Missing production function ${name}`);
    return source.slice(start, source.indexOf('\nfunction ', start + 1));
  };
  const audio: MainAudioState = { sessionId: 'session-b', buffer: Buffer.alloc(0), queue: [], sequence: 0,
    stopping: false, droppedChunks: 0, rendererDroppedChunks: 0, sampleRate: 48000 };
  const sent: { sessionId: string; sequence: number; pcm: Uint8Array }[] = [];
  const mainWindow = { isDestroyed: () => false, webContents: {
    isDestroyed: () => false,
    send: (_channel: string, packet: { sessionId: string; sequence: number; pcm: Uint8Array }) => sent.push(packet),
  } };
  const receive = runInNewContext(
    `${extract(`handleNative${kind}PipeData`)}\n${extract(`sendNextNative${kind}Chunk`)}\nhandleNative${kind}PipeData`, {
      Buffer, Uint8Array, [`native${kind}Session`]: audio,
      [`notifyNative${kind}Error`]: (_audio: unknown, code: string) => { throw new Error(code); },
      mainWindow,
    },
  ) as (state: MainAudioState, incoming: Buffer) => void;
  const acknowledgeChunk = runInNewContext(
    `${extract('validNativeAudioSessionId')}\n${extract(`sendNextNative${kind}Chunk`)}\n${extract(`acknowledgeNative${kind}Chunk`)}\nacknowledgeNative${kind}Chunk`,
    { Buffer, Number, [`native${kind}Session`]: audio, mainWindow },
  ) as (sessionId: string, sequence: number, droppedChunks: number) => void;
  const packet = (value: number) => {
    const bytes = Buffer.alloc(4 + 480 * channels * 4);
    bytes.writeUInt32LE(480);
    for (let index = 0; index < 480 * channels; index++) bytes.writeFloatLE(value, 4 + index * 4);
    return bytes;
  };
  const acknowledge = (sessionId = audio.sessionId, sequence = audio.inFlight!, droppedChunks = 0) =>
    acknowledgeChunk(sessionId, sequence, droppedChunks);
  return { audio, sent, receive, packet, acknowledge };
}
describe.each([1, 2])('native audio %i-channel pipe buffering', (channels) => {
  it('retains ten combined packets and sends one at a time until acknowledged', () => {
    const { audio, sent, receive, packet, acknowledge } = mainAudio(channels);
    receive(audio, Buffer.concat(Array.from({ length: 10 }, (_, index) => packet(index + 1))));
    expect(sent).toHaveLength(1);
    expect(sent[0].sessionId).toBe('session-b');
    expect(audio.droppedChunks).toBe(0);
    for (let index = 1; index < 10; index++) acknowledge();
    expect(sent.map((message) => Buffer.from(message.pcm).readFloatLE())).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(audio.queue).toHaveLength(0);
  });
  it('connects pipe acknowledgements to playback without gaps or an unbounded renderer backlog', () => {
    const main = mainAudio(channels);
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
          if (main.audio.inFlight === acknowledgement.sequence) main.acknowledge();
        }
      }
    };
    main.receive(main.audio, Buffer.concat(Array.from({ length: 10 }, (_, index) => main.packet(index + 1))));
    deliver();
    expect(playback.processor.queue).toHaveLength(4);
    const samples: number[] = [];
    for (let quantum = 0; quantum < 38; quantum++) {
      samples.push(...playback.render(128)[0]);
      while (acknowledgementIndex < playback.acknowledgements.length) {
        const acknowledgement = playback.acknowledgements[acknowledgementIndex++];
        if (main.audio.inFlight === acknowledgement.sequence) main.acknowledge();
      }
      deliver();
      expect(playback.processor.queue.length).toBeLessThanOrEqual(4);
    }
    expect(samples.slice(0, 4800)).toEqual(Array.from({ length: 10 }, (_, index) => Array(480).fill(index + 1)).flat());
    expect(main.audio.droppedChunks).toBe(0);
    expect(playback.processor.dropped).toBe(0);
    expect(main.audio.queue).toHaveLength(0);
    expect(playback.processor.pendingAcknowledgements).toHaveLength(0);
  });
  it('drops oldest queued packets on overload and ignores packets after stopping', () => {
    const { audio, sent, receive, packet, acknowledge } = mainAudio(channels);
    receive(audio, packet(1));
    receive(audio, Buffer.concat(Array.from({ length: 20 }, (_, index) => packet(index + 2))));
    expect(audio.queue).toHaveLength(12);
    expect(audio.droppedChunks).toBe(8);
    for (let index = 0; index < 12; index++) acknowledge();
    expect(sent.map((message) => Buffer.from(message.pcm).readFloatLE())).toEqual([1, ...Array.from({ length: 12 }, (_, index) => index + 10)]);
    audio.stopping = true;
    receive(audio, packet(22));
    expect(audio.queue).toHaveLength(0);
    expect(sent).toHaveLength(13);
  });
  it('rejects a late acknowledgement from another session with the same sequence', () => {
    const { audio, sent, receive, packet, acknowledge } = mainAudio(channels);
    receive(audio, Buffer.concat([packet(1), packet(2)]));
    expect(audio.inFlight).toBe(1);
    expect(audio.queue).toHaveLength(1);

    acknowledge('session-a', 1, 7);
    expect(audio.inFlight).toBe(1);
    expect(audio.rendererDroppedChunks).toBe(0);
    expect(sent).toHaveLength(1);

    acknowledge('session-b', 1, 2);
    expect(audio.inFlight).toBe(2);
    expect(audio.rendererDroppedChunks).toBe(2);
    expect(sent).toHaveLength(2);
    expect(sent[1].sessionId).toBe('session-b');
  });
  it('rejects missing or invalid acknowledgement session identifiers', () => {
    const { audio, sent, receive, packet, acknowledge } = mainAudio(channels);
    receive(audio, Buffer.concat([packet(1), packet(2)]));
    acknowledge('', 1, 5);
    expect(audio.inFlight).toBe(1);
    expect(audio.rendererDroppedChunks).toBe(0);
    expect(sent).toHaveLength(1);
  });
});
