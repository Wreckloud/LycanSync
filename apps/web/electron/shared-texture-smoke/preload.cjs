const { sharedTexture } = require('electron');

sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, token) => {
  try {
    if (token === 'receiver-error') {
      window.postMessage({ type: 'shared-texture-smoke-rejected' }, '*');
      throw new Error('syntheticReceiverFailure');
    }
    if (token !== 'smoke-frame') throw new Error('unexpectedTextureMessage');
    const frame = importedSharedTexture.getVideoFrame();
    window.postMessage({ type: 'shared-texture-smoke-frame', frame }, '*', [frame]);
  } finally {
    importedSharedTexture.release();
  }
});
