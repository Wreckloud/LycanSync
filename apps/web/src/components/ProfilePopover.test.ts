import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, markRaw, nextTick, onScopeDispose, reactive, ref, watch } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { formatPresenceAgo, formatRecentGame } from '../profile/presenceHistory';

const script = parse(readFileSync(new URL('./ProfilePopover.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const parsed = ts.createSourceFile('ProfilePopover.ts', script, ts.ScriptTarget.Latest, true);
const clock = parsed.statements.filter(statement => (ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(item => ['activitySeconds', 'activityDuration', 'historyNow', 'lastOnline', 'recentGameDescription'].includes(item.name.getText(parsed))))
  || statement.getText(parsed).startsWith('watch(() => [props.anchor, props.activityStartedAt'))
  .map(statement => statement.getText(parsed)).join('\n');
const positioning = parsed.statements.filter(statement => statement.getText(parsed)
  .startsWith('watch(() => [props.anchor, surface.value, props.placement,')
  || statement.getText(parsed).startsWith('onScopeDispose('))
  .map(statement => statement.getText(parsed)).join('\n');
afterEach(() => { vi.useRealTimers(); });

it('卡片内部操作不关闭，Esc 关闭主卡并恢复入口焦点', () => {
  const target = {} as Node;
  const focus = vi.fn();
  const props = { anchor: { contains: () => false, focus } };
  const surface = ref({ contains: (node: Node) => node === target });
  const emit = vi.fn();
  const methods = parsed.statements.filter(statement => ts.isFunctionDeclaration(statement)
    && ['dismissOutside', 'dismissOnEscape'].includes(statement.name?.text ?? '')).map(statement => statement.getText(parsed)).join('\n');
  const callbacks = runInNewContext(`${ts.transpile(methods)}\n({ dismissOutside, dismissOnEscape })`, { props, surface, emit }) as {
    dismissOutside(event: { target: Node | null }): void; dismissOnEscape(event: KeyboardEvent): void;
  };
  callbacks.dismissOutside({ target });
  expect(emit).not.toHaveBeenCalled();
  const escape = () => ({ key: 'Escape', defaultPrevented: false,
    preventDefault(this: { defaultPrevented: boolean }) { this.defaultPrevented = true; }, stopPropagation: vi.fn() }) as unknown as KeyboardEvent;
  callbacks.dismissOnEscape(escape());
  expect(emit).toHaveBeenCalledWith('close');
  expect(focus).toHaveBeenCalledOnce();
});

function positioningFixture() {
  const events = new EventTarget();
  const document = { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) };
  const anchor = markRaw({ ownerDocument: document, isConnected: true }) as unknown as HTMLElement;
  const focus = vi.fn();
  const element = markRaw({ querySelector: () => ({ focus }) }) as unknown as HTMLElement;
  const props = reactive({ anchor: null as HTMLElement | null, placement: 'left', autofocus: true });
  const surface = ref<HTMLElement | null>(null);
  const position = ref({ left: '0px', top: '0px', visibility: 'hidden' });
  const pending: Array<{ resolve: (point: { x: number; y: number }) => void; reject: (error: Error) => void }> = [];
  const updates: Array<() => void> = [];
  const cleanups: Array<ReturnType<typeof vi.fn>> = [];
  const emit = vi.fn();
  const computePosition = vi.fn(() => new Promise<{ x: number; y: number }>((resolve, reject) => pending.push({ resolve, reject })));
  const autoUpdate = vi.fn((_anchor, _element, update: () => void) => {
    updates.push(update);
    update();
    const cleanup = vi.fn();
    cleanups.push(cleanup);
    return cleanup;
  });
  const scope = effectScope();
  scope.run(() => runInNewContext(ts.transpile(positioning, { target: ts.ScriptTarget.ES2022 }), {
    props, surface, position, generation: 0, watch, onScopeDispose, computePosition, autoUpdate,
    offset: vi.fn(), flip: vi.fn(), shift: vi.fn(), emit, tintAvatar: vi.fn(),
    dismissOutside: vi.fn(), dismissOnEscape: vi.fn(), console,
  }));
  return { props, surface, position, pending, updates, cleanups, emit, scope, anchor, element, focus, computePosition, autoUpdate };
}

it('只有展开资料卡才观察定位，首次定位完成再聚焦；关闭立即释放', async () => {
  const f = positioningFixture();
  try {
    expect(f.autoUpdate).not.toHaveBeenCalled();
    f.props.anchor = f.anchor; f.surface.value = f.element;
    await nextTick();
    expect(f.position.value.visibility).toBe('hidden');
    expect(f.focus).not.toHaveBeenCalled();
    f.pending[0]!.resolve({ x: 100, y: 80 });
    await nextTick();
    expect(f.position.value).toEqual({ left: '100px', top: '80px', visibility: 'visible' });
    expect(f.focus).toHaveBeenCalledOnce();
    f.updates[0]!();
    f.pending[1]!.resolve({ x: 100, y: 90 });
    await nextTick();
    expect(f.focus).toHaveBeenCalledOnce();
    f.props.anchor = null;
    await nextTick();
    expect(f.cleanups[0]).toHaveBeenCalledOnce();
  } finally { f.scope.stop(); }
});

it('快速换成员及尺寸变化时，迟到定位不能覆盖新卡片；销毁后不再写入', async () => {
  const f = positioningFixture();
  try {
    f.props.anchor = f.anchor; f.surface.value = f.element;
    await nextTick();
    f.props.anchor = markRaw({ ownerDocument: f.anchor.ownerDocument, isConnected: true }) as unknown as HTMLElement;
    await nextTick();
    expect(f.cleanups[0]).toHaveBeenCalledOnce();
    f.pending[0]!.resolve({ x: 900, y: 900 });
    await nextTick();
    expect(f.position.value.visibility).toBe('hidden');
    f.updates[1]!();
    f.pending[2]!.resolve({ x: 120, y: 150 });
    await nextTick();
    f.pending[1]!.resolve({ x: 800, y: 800 });
    await nextTick();
    expect(f.position.value.left).toBe('120px');
    f.updates[1]!();
    f.scope.stop();
    f.pending[3]!.resolve({ x: 700, y: 700 });
    await nextTick();
    expect(f.position.value.left).toBe('120px');
    expect(f.cleanups[1]).toHaveBeenCalledOnce();
  } finally { f.scope.stop(); }
});

it('同一入口更换卡片 DOM 重新绑定；定位失败或入口失效会结束卡片', async () => {
  const f = positioningFixture();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    f.props.anchor = f.anchor; f.surface.value = f.element;
    await nextTick();
    f.surface.value = markRaw({ querySelector: () => null }) as unknown as HTMLElement;
    await nextTick();
    expect(f.cleanups[0]).toHaveBeenCalledOnce();
    expect(f.autoUpdate).toHaveBeenCalledTimes(2);
    f.pending[1]!.reject(new Error('private failure details'));
    await nextTick(); await nextTick();
    expect(log).toHaveBeenCalledWith('无法定位资料卡');
    expect(f.emit).toHaveBeenCalledWith('close');
    f.emit.mockClear();
    Object.defineProperty(f.anchor, 'isConnected', { value: false });
    f.updates[1]!();
    expect(f.emit).toHaveBeenCalledWith('close');
    expect(f.computePosition).toHaveBeenCalledTimes(2);
  } finally { f.scope.stop(); log.mockRestore(); }
});

function fixture() {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'performance'] });
  vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
  const documentEvents = new EventTarget();
  const windowEvents = new EventTarget();
  const document = { visibilityState: 'visible', addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
    defaultView: { performance, setInterval, clearInterval, addEventListener: windowEvents.addEventListener.bind(windowEvents),
      removeEventListener: windowEvents.removeEventListener.bind(windowEvents) } };
  const props = reactive({ anchor: null as { ownerDocument: typeof document } | null, activityStartedAt: '2026-10-30T11:59:58Z', status: 'ONLINE', lastOnlineAt: null as string | null,
    recentGame: null as { name: string; endedAt: string; playedSeconds: number } | null });
  const scope = effectScope();
  const state = scope.run(() => runInNewContext(`${ts.transpile(clock, { target: ts.ScriptTarget.ES2022 })}\n({ activityDuration, lastOnline, recentGameDescription })`,
    { props, computed, ref, watch, Date, formatPresenceAgo, formatRecentGame })) as { activityDuration: { value: string }; lastOnline: { value: string }; recentGameDescription: { value: string } };
  return { props, state, scope, document, documentEvents };
}

it('仅展开卡片每秒读秒，系统时间调整不跳时，关闭和销毁立即清理', async () => {
  const f = fixture();
  try {
    expect(vi.getTimerCount()).toBe(0);
    f.props.anchor = { ownerDocument: f.document }; await nextTick();
    expect(f.state.activityDuration.value).toBe('0:02');
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.state.activityDuration.value).toBe('0:03');
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.state.activityDuration.value).toBe('0:04');
    f.props.anchor = null; await nextTick();
    expect(f.state.activityDuration.value).toBe(''); expect(vi.getTimerCount()).toBe(0);
    f.props.anchor = { ownerDocument: f.document }; await nextTick();
    expect(vi.getTimerCount()).toBe(1);
  } finally { f.scope.stop(); }
  expect(vi.getTimerCount()).toBe(0);
});

it('后台不轮询，返回立即按实际经过时间补齐；换活动重置，未知时间不造假', async () => {
  const f = fixture();
  try {
    f.props.anchor = { ownerDocument: f.document }; await nextTick();
    f.document.visibilityState = 'hidden'; f.documentEvents.dispatchEvent(new Event('visibilitychange'));
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_600_000);
    f.document.visibilityState = 'visible'; f.documentEvents.dispatchEvent(new Event('visibilitychange'));
    expect(f.state.activityDuration.value).toBe('1:00:02'); expect(vi.getTimerCount()).toBe(1);
    f.props.activityStartedAt = new Date(Date.now() - 1000).toISOString(); await nextTick();
    expect(f.state.activityDuration.value).toBe('0:01'); expect(vi.getTimerCount()).toBe(1);
    f.props.activityStartedAt = 'invalid'; await nextTick();
    expect(f.state.activityDuration.value).toBe(''); expect(vi.getTimerCount()).toBe(0);
    f.props.activityStartedAt = new Date(Date.now() + 2000).toISOString(); await nextTick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.state.activityDuration.value).toBe('0:00');
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.state.activityDuration.value).toBe('0:01');
  } finally { f.scope.stop(); }
});

it('历史用同一计时器按分钟更新，在线不展示上次在线，收起即清理', async () => {
  const f = fixture();
  try {
    f.props.activityStartedAt = 'invalid';
    f.props.status = 'OFFLINE';
    f.props.lastOnlineAt = new Date(Date.now() - 30_000).toISOString();
    f.props.recentGame = { name: '游戏', endedAt: new Date(Date.now() - 30_000).toISOString(), playedSeconds: 3600 };
    f.props.anchor = { ownerDocument: f.document }; await nextTick();
    expect(f.state.lastOnline.value).toBe('刚刚');
    expect(f.state.recentGameDescription.value).toBe('刚刚玩了一个多小时的 游戏');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.state.lastOnline.value).toBe('1分钟前');
    f.props.status = 'ONLINE'; await nextTick();
    expect(f.state.lastOnline.value).toBe('');
    expect(f.state.recentGameDescription.value).toBe('刚刚玩了一个多小时的 游戏');
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(f.state.recentGameDescription.value).toBe('不久前玩了一个多小时的 游戏');
    f.props.anchor = null; await nextTick();
    expect(vi.getTimerCount()).toBe(0);
  } finally { f.scope.stop(); }
});
