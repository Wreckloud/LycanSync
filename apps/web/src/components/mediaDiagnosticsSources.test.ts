import { describe, expect, it } from 'vitest';
import { isStaleVideoSourceError, resetVideoSourceSelection } from './mediaDiagnosticsSources';

describe('resetVideoSourceSelection', () => {
  it('requires reselection even when a restarted helper reuses the same source id', () => {
    expect(resetVideoSourceSelection('window:1:0'))
      .toEqual({ sourceId: '', invalidated: true });
  });

  it('leaves an empty selection empty instead of choosing the first source', () => {
    expect(resetVideoSourceSelection(''))
      .toEqual({ sourceId: '', invalidated: false });
  });
});

describe('isStaleVideoSourceError', () => {
  it('recognizes expired ids and targets that disappeared before probe start', () => {
    expect(isStaleVideoSourceError(new Error('videoSourceExpired'))).toBe(true);
    expect(isStaleVideoSourceError(new Error('captureTargetClosed'))).toBe(true);
    expect(isStaleVideoSourceError(new Error('captureDisplayDisconnected'))).toBe(true);
    expect(isStaleVideoSourceError(new Error('captureStartFailed'))).toBe(false);
  });
});
