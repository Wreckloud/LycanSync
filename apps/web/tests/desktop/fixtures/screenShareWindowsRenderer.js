import { RemoteVideoTrack, RemoteTrackPublication, Room, Track, VideoQuality } from '/sdk.js';
import { observeScreenShareView } from '/screenShareViewing.js';
import { observeLocalScreenPreview } from '/localScreenPreview.js';
import { RemoteInputPresses } from '/remoteControl.js';

const room = new Room({ adaptiveStream: false, dynacast: true });
const sources = new Map();
const viewers = new Map();
const errors = [];
const inputEvents = [];
const remoteInputs = new RemoteInputPresses();
let activeInput;
let disposed = false;
const ids = { red: '11111111-1111-4111-8111-111111111111', green: '22222222-2222-4222-8222-222222222222' };
let nativeVisibilityReceived = false;
window.lycanDesktop.onWindowVisibility((visible) => {
  nativeVisibilityReceived = true; document.body.hidden = !visible;
});
window.lycanDesktop.getWindowVisibility().then((visible) => {
  if (!nativeVisibilityReceived) document.body.hidden = !visible;
}).catch((error) => errors.push(String(error)));

for (const [id, color] of [['red', '#d02030'], ['green', '#20b060']]) {
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
  const context = canvas.getContext('2d');
  const stream = canvas.captureStream(0);
  const source = stream.getVideoTracks()[0];
  // 真实 SDK 远端轨道只借合成源验证 attach/detach，不模拟网络接收或运行接收统计。
  const track = new RemoteVideoTrack(source, id, undefined);
  const publication = new RemoteTrackPublication(Track.Kind.Video, {
    sid: id, name: id, type: 1, source: 3, simulcast: true,
  }, true);
  const video = document.createElement('video');
  video.autoplay = true; video.muted = true; video.width = 160; video.height = 90;
  document.body.append(video); track.attach(video);
  const preview = observeLocalScreenPreview(video, () => errors.push('preview playback failed'));
  const view = observeScreenShareView(publication, video, VideoQuality.LOW);
  let frames = 0;
  const draw = () => {
    context.fillStyle = color; context.fillRect(0, 0, 320, 180);
    context.fillStyle = '#ffffff'; context.fillRect(frames++ % 290, 130, 20, 20);
    source.requestFrame();
  };
  draw();
  const timer = setInterval(draw, 80);
  sources.set(id, { source, track, publication, video, preview, view, timer, frames: () => frames });
  document.getElementById(id).addEventListener('click', () => {
    void open(id).catch((error) => errors.push(String(error)));
  });
}

function releaseInputs(id) {
  if (activeInput !== id) return;
  inputEvents.push(...remoteInputs.releaseAll());
  activeInput = undefined;
}

async function open(id) {
  if (disposed) throw new Error('scenario stopped');
  const previous = viewers.get(id);
  if (previous) { previous.child.focus(); return; }
  const entry = sources.get(id);
  if (!entry) throw new Error('unknown source');
  const child = window.open(`/viewer.html#${ids[id]}`, `lycan-viewer-${ids[id]}`);
  if (!child) throw new Error('viewer was blocked');
  // 登记先于加载；关闭或停止期间的迟到加载只能回收，不能重新挂载。
  const state = { child };
  viewers.set(id, state);
  const cleanup = () => {
    releaseInputs(id);
    state.view?.stop(); state.preview?.();
    if (state.video) entry.track.detach(state.video);
    if (viewers.get(id) === state) viewers.delete(id);
  };
  state.cleanup = cleanup;
}

async function ready(child) {
  const found = [...viewers].find(([, state]) => state.child === child);
  if (!found || disposed || child.closed) { child.close(); return; }
  const [id, state] = found;
  const entry = sources.get(id);
  // 首次空白页也会 pagehide；只在固定观看页就绪后绑定其生命周期。
  child.addEventListener('pagehide', state.cleanup, { once: true });
  const video = child.document.createElement('video');
  video.autoplay = true; video.muted = true; video.playsInline = true; video.width = 320; video.height = 180;
  child.document.querySelector('main').append(video);
  state.video = video;
  entry.track.attach(video);
  state.preview = observeLocalScreenPreview(video, () => errors.push('viewer playback failed'));
  state.view = observeScreenShareView(entry.publication, video, VideoQuality.HIGH);
  const blur = () => releaseInputs(id);
  const keydown = (event) => {
    if (event.code === 'KeyA' && activeInput === id) inputEvents.push(...remoteInputs.pressKey('KeyA', 'letterA'));
  };
  child.addEventListener('blur', blur);
  child.addEventListener('lycan-viewer-disarm', blur);
  child.addEventListener('keydown', keydown);
  child.addEventListener('pagehide', () => {
    child.removeEventListener('blur', blur); child.removeEventListener('lycan-viewer-disarm', blur);
    child.removeEventListener('keydown', keydown);
  }, { once: true });
  await video.play();
}

window.screenShareWindowsScenario = {
  open, ready,
  sample(id) {
    const entry = sources.get(id), viewer = viewers.get(id), video = viewer?.video;
    return { connected: room.state, viewers: viewers.size, sourceState: entry.source.readyState,
      attached: entry.track.attachedElements.length, enabled: entry.publication.isEnabled,
      quality: entry.publication.videoQuality, frames: entry.frames(), mainPreviewPaused: entry.video.paused,
      childVisibility: video?.ownerDocument.visibilityState, played: video?.getVideoPlaybackQuality().totalVideoFrames ?? 0,
      sameSource: video?.srcObject?.getVideoTracks()[0] === entry.source, muted: video?.muted,
      audioElements: [...viewers.values()].reduce((count, value) => count + value.child.document.querySelectorAll('audio').length, document.querySelectorAll('audio').length),
      errors: errors.slice(), inputEvents: inputEvents.slice() };
  },
  activateInput(id) { releaseInputs(activeInput); activeInput = id; },
  pixel(id) {
    const video = viewers.get(id)?.video;
    if (!video) return null;
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data];
  },
  stop() {
    if (disposed) return;
    disposed = true;
    for (const state of [...viewers.values()]) { state.cleanup(); state.child.close(); }
    for (const entry of sources.values()) {
      clearInterval(entry.timer); entry.view.stop(); entry.preview(); entry.track.detach(entry.video);
      entry.source.stop(); entry.video.remove();
    }
  },
};
window.addEventListener('pagehide', () => window.screenShareWindowsScenario.stop(), { once: true });
window.addEventListener('message', (event) => {
  const found = [...viewers].find(([, state]) => state.child === event.source);
  if (!found || event.origin !== window.location.origin || event.data?.type !== 'lycan-viewer-ready'
      || event.data.id !== ids[found[0]]) return;
  void ready(found[1].child).catch((error) => errors.push(String(error)));
});
