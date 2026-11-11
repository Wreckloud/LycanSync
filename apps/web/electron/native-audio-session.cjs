function validNativeAudioSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.length > 0 && Buffer.byteLength(sessionId, 'utf8') <= 128
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(sessionId);
}

module.exports = { validNativeAudioSessionId };
