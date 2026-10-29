const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { createRecordingVoice } = require('./recording-voice.cjs');

function fixture({ delayed = false } = {}) {
  const server = new EventEmitter();
  server.listen = () => { if (!delayed) queueMicrotask(() => { server.listening = true; server.emit('listening'); }); };
  server.close = () => { server.listening = false; };
  const packets = [];
  const socket = new EventEmitter();
  socket.writableLength = 0;
  socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
  socket.write = packet => packets.push(packet);
  return { voice: createRecordingVoice({ createPipeServer: () => server }), server, socket, packets };
}

test('只接受当前录像的固定块，保留采样位置并限制管道积压', async () => {
  const f = fixture(); await f.voice.open('current');
  f.server.emit('connection', f.socket);
  const pcm = new Uint8Array(1920); new DataView(pcm.buffer).setFloat32(0, 0.5, true);
  assert.equal(f.voice.write('old', 0, pcm), false);
  assert.equal(f.voice.write('current', 0, pcm), true);
  assert.equal(f.packets[0].length, 1932);
  assert.equal(f.packets[0].readUInt32LE(0), 480);
  assert.equal(f.packets[0].readBigUInt64LE(4), 0n);
  assert.equal(f.packets[0].readFloatLE(12), 0.5);
  assert.equal(f.voice.write('current', 0, pcm), false);
  assert.equal(f.voice.write('current', 480, new Uint8Array(100)), false);
  f.socket.writableLength = 1932 * 5;
  assert.equal(f.voice.write('current', 480, pcm), false);
  f.socket.writableLength = 0;
  assert.equal(f.voice.write('current', 960, pcm), true);
  assert.equal(f.packets[1].readBigUInt64LE(4), 960n);
  assert.equal(await f.voice.close('current'), 1);
  assert.equal(f.socket.destroyed, true); assert.equal(f.server.listening, false);
  assert.equal(f.voice.write('current', 1440, pcm), false);
});

test('监听完成前取消，迟到的监听不能遗留管道或接管新录像', async () => {
  const f = fixture({ delayed: true });
  const opened = f.voice.open('first');
  const rejected = assert.rejects(opened, /recordingCancelled/);
  await f.voice.close('first');
  f.server.listening = true; f.server.emit('listening');
  await rejected;
  assert.equal(f.server.listening, false);
  f.server.emit('connection', f.socket); assert.equal(f.socket.destroyed, true);
});
