export function resetVideoSourceSelection(selectedSourceId: string) {
  return { sourceId: '', invalidated: Boolean(selectedSourceId) };
}

export function isStaleVideoSourceError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return ['videoSourceExpired', 'captureTargetClosed', 'captureDisplayDisconnected']
    .some((code) => message.includes(code));
}
