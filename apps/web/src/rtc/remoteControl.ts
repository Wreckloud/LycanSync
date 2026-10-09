export const REMOTE_CONTROL_TOPIC = 'lycan-remote-control-v1';
export const REMOTE_CONTROL_MAX_MESSAGE_BYTES = 1024;
export const REMOTE_CONTROL_MAX_INPUTS_PER_SECOND = 120;

export type RemoteControlInput =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'buttonDown' | 'buttonUp'; button: 'left' | 'right'; x: number; y: number }
  | { kind: 'wheel'; delta: number }
  | { kind: 'keyDown' | 'keyUp'; key: RemoteControlKey };

export type RemoteControlKey = 'enter' | 'escape' | 'space' | 'tab' | 'backspace'
  | 'delete' | 'home' | 'end' | 'pageUp' | 'pageDown' | 'left' | 'right' | 'up' | 'down'
  | `digit${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  | `letter${'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S' | 'T' | 'U' | 'V' | 'W' | 'X' | 'Y' | 'Z'}`
  | 'shift' | 'control' | 'alt';

export function remoteKeyFromCode(code: string): RemoteControlKey | null {
  if (/^Key[A-Z]$/.test(code)) return `letter${code.slice(3)}` as RemoteControlKey;
  if (/^Digit[0-9]$/.test(code)) return `digit${code.slice(5)}` as RemoteControlKey;
  if (/^Numpad[0-9]$/.test(code)) return `digit${code.slice(6)}` as RemoteControlKey;
  const keys: Record<string, RemoteControlKey> = {
    Enter: 'enter', Escape: 'escape', Space: 'space', Tab: 'tab', Backspace: 'backspace', Delete: 'delete',
    Home: 'home', End: 'end', PageUp: 'pageUp', PageDown: 'pageDown', ArrowLeft: 'left', ArrowRight: 'right',
    ArrowUp: 'up', ArrowDown: 'down', ShiftLeft: 'shift', ShiftRight: 'shift',
    ControlLeft: 'control', ControlRight: 'control', AltLeft: 'alt', AltRight: 'alt',
  };
  return keys[code] ?? null;
}

/** 按物理键跟踪按住状态，沿用协议中的语义键名发送输入。 */
export class RemoteKeyPresses {
  private readonly pressed = new Map<string, RemoteControlKey>();

  press(code: string, key: RemoteControlKey): RemoteControlInput[] {
    if (this.pressed.has(code)) return [];
    const alreadyPressed = [...this.pressed.values()].includes(key);
    this.pressed.set(code, key);
    return alreadyPressed ? [] : [{ kind: 'keyDown', key }];
  }

  release(code: string): RemoteControlInput[] {
    const key = this.pressed.get(code);
    if (!key) return [];
    this.pressed.delete(code);
    return [...this.pressed.values()].includes(key) ? [] : [{ kind: 'keyUp', key }];
  }

  releaseAll(): RemoteControlInput[] {
    const keys = [...new Set(this.pressed.values())].map((key) => ({ kind: 'keyUp' as const, key }));
    this.pressed.clear();
    return keys;
  }
}

export class RemoteInputPresses {
  private readonly keys = new RemoteKeyPresses();
  private readonly buttons = new Map<'left' | 'right', { x: number; y: number }>();

  pressKey(code: string, key: RemoteControlKey) { return this.keys.press(code, key); }
  releaseKey(code: string) { return this.keys.release(code); }

  pressButton(button: 'left' | 'right', x: number, y: number): RemoteControlInput[] {
    if (this.buttons.has(button)) return [];
    this.buttons.set(button, { x, y });
    return [{ kind: 'buttonDown', button, x, y }];
  }

  moveButtons(point: { x: number; y: number }) {
    this.buttons.forEach((_, button) => this.buttons.set(button, point));
  }

  releaseButton(button: 'left' | 'right', point?: { x: number; y: number }): RemoteControlInput[] {
    const held = this.buttons.get(button);
    if (!held) return [];
    this.buttons.delete(button);
    return [{ kind: 'buttonUp', button, ...(point ?? held) }];
  }

  releaseAll(): RemoteControlInput[] {
    const releasedButtons = [...this.buttons].map(([button, point]) => ({ kind: 'buttonUp' as const, button, ...point }));
    this.buttons.clear();
    return [...releasedButtons, ...this.keys.releaseAll()];
  }
}

export type RemoteControlMessage =
  | { type: 'share'; shareSessionId: string; sourceKind: 'monitor' | 'window' }
  | { type: 'queryShare'; requestId: string }
  | { type: 'shareState'; shareSessionId: string; sourceKind: 'monitor' | 'window'; requestId: string }
  | { type: 'shareStopped'; shareSessionId: string }
  | { type: 'request'; shareSessionId: string; requestId: string }
  | { type: 'allow'; shareSessionId: string; requestId: string; controlSessionId: string }
  | { type: 'reject' | 'revoke'; shareSessionId: string; requestId: string; controlSessionId?: string }
  | { type: 'cancel'; shareSessionId: string; requestId: string }
  | { type: 'input'; shareSessionId: string; controlSessionId: string; sequence: number; input: RemoteControlInput };

export class RemoteControlAuthorization {
  private shareId: string | null = null;
  private pending: { identity: string; requestId: string } | null = null;
  private granted: { identity: string; requestId: string; controlSessionId: string;
    lastMoveSequence: number; lastReliableSequence: number } | null = null;
  private revokingControlSessionId: string | null = null;

  beginShare(shareId: string, kind: 'monitor' | 'window') {
    const revoking = this.revokingControlSessionId;
    this.clear();
    this.revokingControlSessionId = revoking;
    this.shareId = kind === 'monitor' ? shareId : null;
  }

  request(identity: string | undefined, shareId: string, requestId: string): 'accepted' | 'duplicate' | 'denied' {
    if (!identity || !this.shareId || shareId !== this.shareId) return 'denied';
    if (this.pending?.identity === identity && this.pending.requestId === requestId) return 'duplicate';
    if (this.pending || this.granted || this.revokingControlSessionId) return 'denied';
    this.pending = { identity, requestId };
    return 'accepted';
  }

  grant(identity: string, requestId: string, controlSessionId: string): boolean {
    if (this.revokingControlSessionId || !this.pending || this.pending.identity !== identity || this.pending.requestId !== requestId
        || !this.shareId || !validId(controlSessionId)) return false;
    this.granted = { ...this.pending, controlSessionId, lastMoveSequence: 0, lastReliableSequence: 0 };
    this.pending = null;
    return true;
  }

  reject(identity: string, requestId: string): boolean {
    if (!this.pending || this.pending.identity !== identity || this.pending.requestId !== requestId) return false;
    this.pending = null;
    return true;
  }

  acceptsInput(identity: string | undefined, shareId: string, controlSessionId: string, sequence: number,
    isMove: boolean): boolean {
    const grant = this.granted;
    if (!identity || !grant || identity !== grant.identity || shareId !== this.shareId
        || controlSessionId !== grant.controlSessionId || !Number.isSafeInteger(sequence) || sequence < 1) return false;
    if (isMove) {
      if (sequence <= grant.lastMoveSequence || sequence <= grant.lastReliableSequence) return false;
      grant.lastMoveSequence = sequence;
    } else {
      if (sequence <= grant.lastReliableSequence) return false;
      grant.lastReliableSequence = sequence;
    }
    return true;
  }

  beginRevoke(identity?: string, controlSessionId?: string): { identity: string; requestId: string; controlSessionId: string } | null {
    if (!this.granted || (identity !== undefined && this.granted.identity !== identity)
        || (controlSessionId !== undefined && this.granted.controlSessionId !== controlSessionId)) return null;
    const previous = this.granted;
    this.granted = null;
    this.revokingControlSessionId = previous.controlSessionId;
    return { identity: previous.identity, requestId: previous.requestId, controlSessionId: previous.controlSessionId };
  }

  finishRevoke(controlSessionId: string): boolean {
    if (this.revokingControlSessionId !== controlSessionId) return false;
    this.revokingControlSessionId = null;
    return true;
  }

  beginCleanup(controlSessionId: string) {
    if (this.granted?.controlSessionId === controlSessionId) this.granted = null;
    this.revokingControlSessionId = controlSessionId;
  }

  revoke(identity?: string, controlSessionId?: string): boolean {
    const current = this.beginRevoke(identity, controlSessionId);
    return current ? this.finishRevoke(current.controlSessionId) : false;
  }

  clear() {
    this.shareId = null;
    this.pending = null;
    this.granted = null;
  }

  get pendingRequest() { return this.pending ? { ...this.pending } : null; }
  get controller() { return this.granted ? { ...this.granted } : null; }
}

export class LatestValueSender<T> {
  private latest: T | null = null;
  private inFlight = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly send: (value: T) => Promise<unknown>, private readonly onError: () => void,
    private readonly intervalMs = 16) {}

  push(value: T) {
    if (this.disposed) return;
    this.latest = value;
    this.schedule();
  }

  clear() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.latest = null;
  }

  dispose() {
    this.clear();
    this.disposed = true;
  }

  private schedule() {
    if (this.disposed || this.inFlight || this.timer !== null || this.latest === null) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.intervalMs);
  }

  private async flush() {
    if (this.disposed || this.inFlight || this.latest === null) return;
    const value = this.latest;
    this.latest = null;
    this.inFlight = true;
    try { await this.send(value); } catch { this.onError(); }
    finally { this.inFlight = false; this.schedule(); }
  }
}

export function decodeRemoteControlMessage(payload: Uint8Array): RemoteControlMessage | null {
  if (!payload.byteLength || payload.byteLength > REMOTE_CONTROL_MAX_MESSAGE_BYTES) return null;
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    if (!value || typeof value !== 'object') return null;
    if (value.type === 'queryShare') return validId(value.requestId) ? value as RemoteControlMessage : null;
    if (!validId(value.shareSessionId)) return null;
    if (value.type === 'share') return value.sourceKind === 'monitor' || value.sourceKind === 'window'
      ? value as RemoteControlMessage : null;
    if (value.type === 'shareState') return (value.sourceKind === 'monitor' || value.sourceKind === 'window')
      && validId(value.requestId) ? value as RemoteControlMessage : null;
    if (value.type === 'shareStopped') return value as RemoteControlMessage;
    if (value.type === 'request' || value.type === 'allow' || value.type === 'reject'
        || value.type === 'revoke' || value.type === 'cancel') {
      if (!validId(value.requestId)) return null;
      if ((value.type === 'allow' || value.type === 'revoke') && !validId(value.controlSessionId)) return null;
      return value as RemoteControlMessage;
    }
    if (value.type !== 'input' || !validId(value.controlSessionId)
        || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !validInput(value.input)) return null;
    return value as RemoteControlMessage;
  } catch {
    return null;
  }
}

export function encodeRemoteControlMessage(message: RemoteControlMessage): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify(message));
  if (encoded.byteLength > REMOTE_CONTROL_MAX_MESSAGE_BYTES) throw new Error('remoteControlMessageTooLarge');
  return encoded;
}

export function mapRemotePointerToScreen(
  clientX: number,
  clientY: number,
  bounds: { left: number; top: number; width: number; height: number },
  video: { width: number; height: number },
): { x: number; y: number } | null {
  if (bounds.width <= 0 || bounds.height <= 0 || video.width <= 0 || video.height <= 0) return null;
  const scale = Math.min(bounds.width / video.width, bounds.height / video.height);
  const width = video.width * scale;
  const height = video.height * scale;
  const left = bounds.left + (bounds.width - width) / 2;
  const top = bounds.top + (bounds.height - height) / 2;
  if (clientX < left || clientY < top || clientX >= left + width || clientY >= top + height) return null;
  return {
    x: Math.max(0, Math.min(65535, Math.round((clientX - left) / width * 65535))),
    y: Math.max(0, Math.min(65535, Math.round((clientY - top) / height * 65535))),
  };
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128
    && /^[A-Za-z0-9:_-]+$/.test(value);
}

function validInput(value: unknown): value is RemoteControlInput {
  if (!value || typeof value !== 'object') return false;
  const input = value as Record<string, unknown>;
  if (input.kind === 'move') return Number.isInteger(input.x) && Number(input.x) >= 0 && Number(input.x) <= 65535
    && Number.isInteger(input.y) && Number(input.y) >= 0 && Number(input.y) <= 65535;
  if (input.kind === 'buttonDown' || input.kind === 'buttonUp') return (input.button === 'left' || input.button === 'right')
    && Number.isInteger(input.x) && Number(input.x) >= 0 && Number(input.x) <= 65535
    && Number.isInteger(input.y) && Number(input.y) >= 0 && Number(input.y) <= 65535;
  if (input.kind === 'wheel') return Number.isInteger(input.delta) && Math.abs(Number(input.delta)) <= 1200;
  if (input.kind === 'keyDown' || input.kind === 'keyUp') return typeof input.key === 'string'
    && /^(enter|escape|space|tab|backspace|delete|home|end|pageUp|pageDown|left|right|up|down|shift|control|alt|digit[0-9]|letter[A-Z])$/.test(input.key);
  return false;
}
