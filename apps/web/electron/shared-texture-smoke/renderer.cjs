const output = document.querySelector('#output');
let sequence = 0;
window.addEventListener('message', async ({ data }) => {
  if (data?.type === 'shared-texture-smoke-rejected') {
    document.title = `bridge-smoke:result:receiverRejected:${++sequence}`;
    return;
  }
  if (data?.type !== 'shared-texture-smoke-frame') return;
  const frame = data.frame;
  try {
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });
    const writer = generator.writable.getWriter();
    output.srcObject = new MediaStream([generator]);
    await writer.write(frame);
    await output.play();
    window.__smokeTrack = generator;
    document.title = `bridge-smoke:result:frameWritten:${generator.kind}:${generator.readyState}:${++sequence}`;
    setTimeout(async () => {
      await writer.close();
      generator.stop();
      output.pause();
      output.srcObject = null;
    }, 100);
  } catch {
    document.title = `bridge-smoke:result:videoFrameRejected:${++sequence}`;
  } finally {
    frame.close();
  }
});
