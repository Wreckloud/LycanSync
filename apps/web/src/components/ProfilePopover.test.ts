import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';

const script = parse(readFileSync(new URL('./ProfilePopover.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const parsed = ts.createSourceFile('ProfilePopover.ts', script, ts.ScriptTarget.Latest, true);
const clock = parsed.statements.filter(statement => (ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(item => ['activitySeconds', 'activityDuration'].includes(item.name.getText(parsed))))
  || statement.getText(parsed).startsWith('watch(() => [props.anchor, props.activityStartedAt]'))
  .map(statement => statement.getText(parsed)).join('\n');
afterEach(() => { vi.useRealTimers(); });

function fixture() {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'performance'] });
  vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
  const documentEvents = new EventTarget();
  const windowEvents = new EventTarget();
  const document = { visibilityState: 'visible', addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
    defaultView: { performance, setInterval, clearInterval, addEventListener: windowEvents.addEventListener.bind(windowEvents),
      removeEventListener: windowEvents.removeEventListener.bind(windowEvents) } };
  const props = reactive({ anchor: null as { ownerDocument: typeof document } | null, activityStartedAt: '2026-10-30T11:59:58Z' });
  const scope = effectScope();
  const state = scope.run(() => runInNewContext(`${ts.transpile(clock, { target: ts.ScriptTarget.ES2022 })}\n({ activityDuration })`,
    { props, computed, ref, watch, Date })) as { activityDuration: { value: string } };
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
