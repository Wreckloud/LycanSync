import { NativeScreenVideoSession } from '../../src/rtc/nativeScreenVideo';
import { screenShareQuality } from '../../src/rtc/screenShareQuality';

const video = document.querySelector('video');
const marker = document.querySelector('#marker');
const canvas = document.createElement('canvas');
canvas.width = 1; canvas.height = 1;
const context = canvas.getContext('2d', { willReadFrequently: true });
let session;
let track;
let errors = [];
let presented = 0;
let callback;
let senderConnection;
function countPresented() {
  callback = video.requestVideoFrameCallback(() => { presented++; countPresented(); });
}
window.obsCaptureTest = {
  async start(sourceId = 'monitor:1:0', resolution = { width: 1920, height: 1080 }, maxFps = 60) {
    errors = []; presented = 0;
    marker.style.background = '#f010c0';
    session = new NativeScreenVideoSession(window.lycanDesktop, { resolution, maxFps, onError: (code) => errors.push(code) });
    track = await session.start(sourceId);
    // 仅建立本机未连接的 sender 以调用真实参数 API；不发起房间或把本地播放冒充编码验收。
    senderConnection = new RTCPeerConnection({ iceServers: [] });
    track.sender = senderConnection.addTrack(track.mediaStreamTrack);
    await senderConnection.setLocalDescription(await senderConnection.createOffer());
    video.srcObject = new MediaStream([track.mediaStreamTrack]);
    await video.play();
    countPresented();
    return { readyState: track.mediaStreamTrack.readyState, ...session.readDiagnostics() };
  },
  probe(x, y) {
    let pixel = null;
    if (video.readyState >= 2 && video.videoWidth) {
      context.drawImage(video, x * video.videoWidth / 1920, y * video.videoHeight / 1080, 1, 1, 0, 0, 1, 1);
      pixel = [...context.getImageData(0, 0, 1, 1).data];
    }
    return { pixel, presented, errors, width: video.videoWidth, height: video.videoHeight,
      input: session?.readDiagnostics(), readyState: track?.mediaStreamTrack.readyState };
  },
  markerCyan() { marker.style.background = '#10d8f0'; },
  markerMagenta() { marker.style.background = '#f010c0'; },
  async diagnostics() {
    const stats = await window.lycanDesktop.getNativeMediaDiagnostics();
    return { sourceKind: stats.sourceKind, captureSuspended: stats.captureSuspended, captureBackend: stats.captureBackend };
  },
  async configureQuality(id, custom) {
    const originalTrack = track.mediaStreamTrack;
    await session.configureQuality(id, custom);
    return { changed: true, sameTrack: originalTrack === track.mediaStreamTrack,
      readyState: track.mediaStreamTrack.readyState,
      profile: screenShareQuality(id, custom), encodings: track.sender.getParameters().encodings };
  },
  async stop() {
    if (callback !== undefined) video.cancelVideoFrameCallback(callback);
    video.pause(); video.srcObject = null;
    senderConnection?.close(); senderConnection = undefined;
    await session?.stop();
    return { readyState: track?.mediaStreamTrack.readyState, errors };
  },
};
