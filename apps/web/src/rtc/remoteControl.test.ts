import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeRemoteControlMessage, encodeRemoteControlMessage, mapRemotePointerToScreen,
  LatestValueSender, RemoteControlAuthorization, RemoteInputPresses, remoteKeyFromCode } from './remoteControl';

afterEach(() => vi.useRealTimers());

describe('remote control wire and coordinate bounds', () => {
  it('matches key release by physical code even when Shift changes the produced character', () => {
    const pressed = new RemoteInputPresses();
    const key = remoteKeyFromCode('Digit1');
    expect(key).toBe('digit1');
    expect(pressed.pressKey('Digit1', key!)).toEqual([{ kind: 'keyDown', key: 'digit1' }]);
    expect(pressed.pressKey('Digit1', key!)).toEqual([]);
    expect(remoteKeyFromCode('ShiftLeft')).toBe('shift');
    expect(pressed.pressKey('ShiftLeft', 'shift')).toEqual([{ kind: 'keyDown', key: 'shift' }]);
    expect(pressed.releaseKey('Digit1')).toEqual([{ kind: 'keyUp', key: 'digit1' }]);
    expect(pressed.releaseKey('Digit1')).toEqual([]);
    pressed.pressButton('left', 123, 456);
    pressed.moveButtons({ x: 200, y: 300 });
    expect(pressed.releaseAll()).toEqual([
      { kind: 'buttonUp', button: 'left', x: 200, y: 300 },
      { kind: 'keyUp', key: 'shift' },
    ]);
    expect(pressed.releaseAll()).toEqual([]);
  });

  it('maps keypad digits and releases a physical key once when control ends', () => {
    const pressed = new RemoteInputPresses();
    expect(remoteKeyFromCode('Numpad1')).toBe('digit1');
    pressed.pressKey('Numpad1', 'digit1');
    expect(pressed.releaseAll()).toEqual([{ kind: 'keyUp', key: 'digit1' }]);
    expect(pressed.releaseAll()).toEqual([]);
    expect(remoteKeyFromCode('F1')).toBeNull();
  });

  it('rejects oversized, malformed and session-less messages', () => {
    expect(decodeRemoteControlMessage(new Uint8Array(1025))).toBeNull();
    expect(decodeRemoteControlMessage(new TextEncoder().encode('{'))).toBeNull();
    expect(decodeRemoteControlMessage(new TextEncoder().encode('{"type":"request"}'))).toBeNull();
  });

  it('round trips a bounded input message and rejects an invalid sequence', () => {
    const message = { type: 'input' as const, shareSessionId: 'share-1', controlSessionId: 'control-1',
      sequence: 1, input: { kind: 'move' as const, x: 32768, y: 65535 } };
    expect(decodeRemoteControlMessage(encodeRemoteControlMessage(message))).toEqual(message);
    expect(decodeRemoteControlMessage(new TextEncoder().encode(JSON.stringify({ ...message, sequence: 0 })))).toBeNull();
  });

  it('requires screen coordinates on reliable mouse button events', () => {
    const button = { type: 'input' as const, shareSessionId: 'share-1', controlSessionId: 'control-1', sequence: 2,
      input: { kind: 'buttonDown' as const, button: 'left' as const, x: 1234, y: 5678 } };
    expect(decodeRemoteControlMessage(encodeRemoteControlMessage(button))).toEqual(button);
    const missing = { ...button, input: { kind: 'buttonUp', button: 'left' } };
    expect(decodeRemoteControlMessage(new TextEncoder().encode(JSON.stringify(missing)))).toBeNull();
  });

  it('maps only the actual video rectangle and excludes contain letterboxes', () => {
    const bounds = { left: 10, top: 10, width: 400, height: 400 };
    expect(mapRemotePointerToScreen(200, 90, bounds, { width: 1920, height: 1080 })).toBeNull();
    expect(mapRemotePointerToScreen(210, 210, bounds, { width: 1920, height: 1080 })).toEqual({ x: 32768, y: 32768 });
  });

  it('returns null for a collapsed video or viewport', () => {
    expect(mapRemotePointerToScreen(1, 1, { left: 0, top: 0, width: 0, height: 20 }, { width: 1, height: 1 })).toBeNull();
  });

  it('allows two viewers to watch while only one identity can receive control', () => {
    const lease = new RemoteControlAuthorization();
    lease.beginShare('share-1', 'monitor');
    expect(lease.request('viewer-a', 'share-1', 'request-a')).toBe('accepted');
    expect(lease.request('viewer-a', 'share-1', 'request-a')).toBe('duplicate');
    expect(lease.request('viewer-b', 'share-1', 'request-b')).toBe('denied');
    expect(lease.grant('viewer-a', 'request-a', 'control-a')).toBe(true);
    expect(lease.acceptsInput('viewer-a', 'share-1', 'control-a', 1, false)).toBe(true);
    expect(lease.acceptsInput('viewer-b', 'share-1', 'control-a', 2, true)).toBe(false);
    expect(lease.acceptsInput(undefined, 'share-1', 'control-a', 3, true)).toBe(false);
    expect(lease.acceptsInput('viewer-a', 'stale-share', 'control-a', 4, true)).toBe(false);
    expect(lease.acceptsInput('viewer-a', 'share-1', 'control-a', 1, false)).toBe(false);
  });

  it('accepts reliable key release after a newer lossy pointer and rejects stale positions', () => {
    const lease = new RemoteControlAuthorization();
    lease.beginShare('share-1', 'monitor');
    lease.request('viewer-a', 'share-1', 'request-a');
    lease.grant('viewer-a', 'request-a', 'control-a');
    expect(lease.acceptsInput('viewer-a', 'share-1', 'control-a', 1, false)).toBe(true);
    expect(lease.acceptsInput('viewer-a', 'share-1', 'control-a', 3, true)).toBe(true);
    expect(lease.acceptsInput('viewer-a', 'share-1', 'control-a', 2, false)).toBe(true);
    expect(lease.acceptsInput('viewer-a', 'share-1', 'control-a', 2, true)).toBe(false);
    expect(lease.acceptsInput('viewer-a', 'share-1', 'control-a', 4, true)).toBe(true);
  });

  it('keeps authorization locked until failed native revocation is explicitly completed', () => {
    const lease = new RemoteControlAuthorization();
    lease.beginShare('share-1', 'monitor');
    lease.request('viewer-a', 'share-1', 'request-a');
    lease.grant('viewer-a', 'request-a', 'control-a');
    expect(lease.beginRevoke('viewer-a', 'control-a')).toMatchObject({ controlSessionId: 'control-a' });
    expect(lease.acceptsInput('viewer-a', 'share-1', 'control-a', 1, true)).toBe(false);
    expect(lease.request('viewer-b', 'share-1', 'request-b')).toBe('denied');
    expect(lease.finishRevoke('control-a')).toBe(true);
    expect(lease.request('viewer-b', 'share-1', 'request-b')).toBe('accepted');
  });

  it('denies window sharing and invalidates requests on rejection, revoke and share end', () => {
    const lease = new RemoteControlAuthorization();
    lease.beginShare('window-share', 'window');
    expect(lease.request('viewer-a', 'window-share', 'request-a')).toBe('denied');
    lease.beginShare('monitor-share', 'monitor');
    expect(lease.request('viewer-a', 'monitor-share', 'request-a')).toBe('accepted');
    expect(lease.reject('viewer-a', 'request-a')).toBe(true);
    expect(lease.request('viewer-a', 'monitor-share', 'request-b')).toBe('accepted');
    lease.grant('viewer-a', 'request-b', 'control-b');
    expect(lease.revoke('viewer-b', 'control-b')).toBe(false);
    expect(lease.revoke('viewer-a', 'control-b')).toBe(true);
    lease.beginShare('next-share', 'monitor');
    expect(lease.acceptsInput('viewer-a', 'monitor-share', 'control-b', 2, false)).toBe(false);
  });

  it('keeps only the newest pointer while a send is in flight', async () => {
    vi.useFakeTimers();
    const resolveSend: (() => void)[] = [];
    const sent: number[] = [];
    const sender = new LatestValueSender<number>((value) => {
      sent.push(value);
      return new Promise<void>((resolve) => resolveSend.push(resolve));
    }, () => {});
    sender.push(1);
    sender.push(2);
    await vi.advanceTimersByTimeAsync(16);
    expect(sent).toEqual([2]);
    sender.push(3);
    sender.push(4);
    resolveSend.shift()?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(16);
    expect(sent).toEqual([2, 4]);
    resolveSend.shift()?.();
    sender.clear();
  });
});
