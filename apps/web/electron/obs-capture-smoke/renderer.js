import { NativeScreenVideoSession } from '../../src/rtc/nativeScreenVideo';

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
function countPresented() {
  callback = video.requestVideoFrameCallback(() => { presented++; countPresented(); });
}
window.obsCaptureTest = {
  async start(sourceId = 'monitor:1:0') {
    errors = []; presented = 0;
    marker.style.background = '#f010c0';
    session = new NativeScreenVideoSession(window.lycanDesktop, { maxFps: 60, onError: (code) => errors.push(code) });
    track = await session.start(sourceId);
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
  async diagnostics() {
    const stats = await window.lycanDesktop.getNativeMediaDiagnostics();
    return { sourceKind: stats.sourceKind, captureSuspended: stats.captureSuspended, captureBackend: stats.captureBackend };
  },
  async configureFrameRate(maxFps) {
    const originalTrack = track.mediaStreamTrack;
    const result = await window.lycanDesktop.configureNativeVideo(session.captureSessionId, maxFps);
    return { changed: result.changed, sameTrack: originalTrack === track.mediaStreamTrack,
      readyState: track.mediaStreamTrack.readyState };
  },
  async stop() {
    if (callback !== undefined) video.cancelVideoFrameCallback(callback);
    video.pause(); video.srcObject = null;
    await session?.stop();
    return { readyState: track?.mediaStreamTrack.readyState, errors };
  },
};
