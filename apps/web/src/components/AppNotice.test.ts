import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { effectScope, nextTick, onScopeDispose, reactive, ref, watch } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';

const script = parse(readFileSync(new URL('./AppNotice.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const source = ts.transpile(script.replace(/^import .*;\r?\n/gm, ''));
afterEach(() => vi.useRealTimers());

function fixture() {
  vi.useFakeTimers();
  const props = reactive<{ message: string; kind?: 'success' }>({ message: '连接失败，请重试。' });
  const emit = vi.fn();
  const scope = effectScope();
  const notice = scope.run(() => runInNewContext(`${source}\n({ visible, dismiss })`, {
    defineProps: () => props, defineEmits: () => emit, ref, watch, onScopeDispose, setTimeout, clearTimeout,
  })) as { visible: { value: boolean }; dismiss(): void };
  return { props, emit, scope, notice };
}

it('提示四秒后自动关闭，手动关闭也清理计时器', async () => {
  const f = fixture();
  try {
    await vi.advanceTimersByTimeAsync(3999);
    expect(f.notice.visible.value).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.notice.visible.value).toBe(false);
    expect(f.emit).toHaveBeenCalledWith('dismiss');
    f.props.message = '录像已保存';
    f.props.kind = 'success';
    await nextTick();
    expect(f.notice.visible.value).toBe(true);
    f.notice.dismiss();
    expect(f.notice.visible.value).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally { f.scope.stop(); }
});

it('新提示重新计时，销毁后不再触发关闭事件', async () => {
  const f = fixture();
  try {
    await vi.advanceTimersByTimeAsync(3000);
    f.props.message = '录像已保存';
    await nextTick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.notice.visible.value).toBe(true);
    expect(f.emit).not.toHaveBeenCalled();
    f.scope.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.emit).not.toHaveBeenCalled();
  } finally { f.scope.stop(); }
});
