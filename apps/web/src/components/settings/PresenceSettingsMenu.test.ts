import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, markRaw, nextTick, reactive, ref, watch } from 'vue';
import { expect, it, vi } from 'vitest';

const script = parse(readFileSync(new URL('./PresenceSettingsMenu.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
function fixture() {
  const scope = effectScope();
  const emit = vi.fn();
  const props = reactive({ mode: 'online', ready: true, active: true, error: '' });
  const events = new EventTarget();
  const windowEvents = new EventTarget();
  const document = { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    defaultView: { addEventListener: windowEvents.addEventListener.bind(windowEvents), removeEventListener: windowEvents.removeEventListener.bind(windowEvents) } };
  const options = ['online', 'invisible'].map((mode, index) => ({ dataset: { presenceMode: mode }, focus: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, right: 280, top: index * 72, bottom: (index + 1) * 72 }) }));
  const state = scope.run(() => runInNewContext(`${ts.transpile(script.replace(/^import .*;\r?\n/gm, ''))}\n({ menu, trigger, open, modes, begin, move, finish, close, select, openKeyboard, navigate })`, {
    computed, nextTick, ref, watch, defineProps: () => props, defineEmits: () => emit,
  })) as { menu: { value: unknown }; trigger: { value: unknown }; open: { value: boolean }; modes: { value: string[] };
    begin(event: unknown): void; move(event: unknown): void; finish(event: unknown): void; close(): void;
    select(mode: string): void; openKeyboard(): Promise<void>; navigate(event: unknown): void };
  state.menu.value = markRaw({ ownerDocument: document, querySelectorAll: () => options, querySelector: () => options[0], contains: () => false });
  state.trigger.value = { focus: vi.fn() };
  const event = (y: number, x = 240) => ({ button: 0, pointerId: 1, clientX: x, clientY: y,
    preventDefault: vi.fn(), currentTarget: { setPointerCapture: vi.fn() } });
  return { scope, props, emit, state, options, events, windowEvents, event };
}

it('按住滑动到另一项，释放才提交；滑出、取消和读取未完成均不切换', () => {
  const f = fixture();
  try {
    f.state.begin(f.event(16));
    f.state.move(f.event(88));
    expect(f.emit).not.toHaveBeenCalled();
    f.state.finish(f.event(88));
    expect(f.emit).toHaveBeenCalledExactlyOnceWith('select', 'invisible');
    expect(f.state.open.value).toBe(false);
    f.emit.mockClear();
    f.state.begin(f.event(16)); f.state.finish(f.event(180, 400));
    expect(f.emit).not.toHaveBeenCalled();
    f.state.begin(f.event(16)); f.state.close(); f.state.finish(f.event(88));
    expect(f.emit).not.toHaveBeenCalled();
    f.props.ready = false;
    f.state.begin(f.event(16));
    expect(f.state.open.value).toBe(false);
  } finally { f.scope.stop(); }
});

it('当前状态排首项，同状态可重试错误；键盘、外部点击和窗口失焦正确收尾', async () => {
  const f = fixture();
  try {
    f.props.mode = 'invisible';
    expect(f.state.modes.value).toEqual(['invisible', 'online']);
    f.state.select('invisible');
    expect(f.emit).not.toHaveBeenCalled();
    f.props.error = '尚未确认同步'; f.state.select('invisible');
    expect(f.emit).toHaveBeenCalledWith('select', 'invisible');
    await f.state.openKeyboard();
    expect(f.options[0]!.focus).toHaveBeenCalled();
    f.state.navigate({ key: 'ArrowDown', target: f.options[0], preventDefault: vi.fn() });
    expect(f.options[1]!.focus).toHaveBeenCalled();
    f.state.navigate({ key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(f.state.open.value).toBe(false);
    await f.state.openKeyboard();
    f.events.dispatchEvent(new Event('pointerdown'));
    expect(f.state.open.value).toBe(false);
    await nextTick(); await f.state.openKeyboard();
    f.windowEvents.dispatchEvent(new Event('blur'));
    expect(f.state.open.value).toBe(false);
    await nextTick(); await f.state.openKeyboard();
    f.props.active = false; await nextTick();
    expect(f.state.open.value).toBe(false);
  } finally { f.scope.stop(); }
});
