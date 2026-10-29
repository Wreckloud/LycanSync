const { createServer } = require('node:net');

// 仅转发当前录像选择的人声；两块 Worklet 在途 + 四块管道背压，不积压长期延迟。
function createRecordingVoice({ createPipeServer = createServer } = {}) {
  let current;
  async function open(id) {
    if (current) throw new Error('recordingVoiceUnavailable');
    const server = createPipeServer();
    const voice = { id, server, socket: undefined, dropped: 0, closed: false, lastPosition: -1 };
    current = voice;
    server.on('connection', socket => {
      if (current !== voice || voice.closed || voice.socket) { socket.destroy(); return; }
      voice.socket = socket;
      socket.on('error', () => { voice.closed = true; });
      socket.on('close', () => { voice.closed = true; });
    });
    server.on('error', () => { voice.closed = true; });
    try {
      await new Promise((resolve, reject) => {
        const failed = error => { server.removeListener('listening', ready); reject(error); };
        const ready = () => { server.removeListener('error', failed); resolve(); };
        server.once('error', failed); server.once('listening', ready);
        server.listen(`\\\\.\\pipe\\lycansync-recording-voice-${id}`);
      });
      if (current !== voice || voice.closed) {
        if (server.listening) server.close();
        throw new Error('recordingCancelled');
      }
    } catch (error) { await close(id); throw error; }
  }
  async function close(id) {
    const voice = current;
    if (!voice || voice.id !== id) return;
    voice.closed = true;
    voice.socket?.destroy();
    if (voice.server.listening) voice.server.close();
    if (current === voice) current = undefined;
    return voice.dropped;
  }
  function write(id, position, pcm) {
    const voice = current;
    if (!voice || voice.id !== id || voice.closed || !Number.isSafeInteger(position) || position < 0
        || position <= voice.lastPosition || !(pcm instanceof Uint8Array) || pcm.byteLength !== 1920) return false;
    voice.lastPosition = position;
    if (!voice.socket || voice.socket.destroyed || voice.socket.writableLength > 1932 * 4) { voice.dropped++; return false; }
    const packet = Buffer.allocUnsafe(1932);
    packet.writeUInt32LE(480, 0); packet.writeBigUInt64LE(BigInt(position), 4);
    Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(packet, 12);
    voice.socket.write(packet);
    return true;
  }
  return { open, close, write };
}

module.exports = { createRecordingVoice };
