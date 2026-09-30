const sourceSelect = document.querySelector('#source');
const startButton = document.querySelector('#start');
const stopButton = document.querySelector('#stop');
const preview = document.querySelector('#preview');
const statusOutput = document.querySelector('#status');
let generator;
let writer;
let writing = false;
let stopRequested = false;
let latestStatus = {};

function renderStatus() {
  statusOutput.textContent = JSON.stringify(latestStatus, null, 2);
}

function stopTrack() {
  stopRequested = true;
  if (generator) generator.stop();
  if (writer) void writer.close().catch(() => {});
  generator = undefined;
  writer = undefined;
  preview.pause();
  preview.srcObject = null;
}

window.wgcSmoke.onSources((sources) => {
  sourceSelect.replaceChildren(new Option('请选择窗口或显示器', ''));
  for (const source of sources) {
    const option = new Option(`${source.kind} · ${source.title} · ${source.width}×${source.height}`, source.sourceId);
    sourceSelect.add(option);
  }
});

window.wgcSmoke.onStatus((status) => {
  latestStatus = status;
  renderStatus();
  startButton.disabled = status.state === 'running' || status.state === 'stopping';
  stopButton.disabled = status.state !== 'running' && status.state !== 'stopping';
});

window.wgcSmoke.onStopTrack(stopTrack);

window.addEventListener('message', async ({ data }) => {
  if (data?.type !== 'wgc-shared-frame') return;
  const frame = data.frame;
  if (writing || stopRequested) {
    frame.close();
    window.wgcSmoke.frameDropped();
    return;
  }
  writing = true;
  try {
    if (!generator) {
      generator = new MediaStreamTrackGenerator({ kind: 'video' });
      writer = generator.writable.getWriter();
      preview.srcObject = new MediaStream([generator]);
      void preview.play().catch(() => {
        latestStatus.lastCaptureError = 'videoPreviewPlayFailed';
        renderStatus();
      });
    }
    await writer.write(frame);
    window.wgcSmoke.frameWritten();
  } catch {
    window.wgcSmoke.frameDropped();
    latestStatus.lastCaptureError = 'videoFrameWriteFailed';
    renderStatus();
  } finally {
    frame.close();
    writing = false;
  }
});

startButton.addEventListener('click', async () => {
  if (!sourceSelect.value) {
    latestStatus.lastCaptureError = 'sourceSelectionRequired';
    renderStatus();
    return;
  }
  stopRequested = false;
  try {
    await window.wgcSmoke.start(sourceSelect.value);
  } catch (error) {
    latestStatus.lastCaptureError = String(error?.message || 'captureStartFailed');
    renderStatus();
  }
});

stopButton.addEventListener('click', async () => {
  stopTrack();
  try {
    await window.wgcSmoke.stop();
  } catch (error) {
    latestStatus.lastCaptureError = String(error?.message || 'captureStopFailed');
    renderStatus();
  }
});
