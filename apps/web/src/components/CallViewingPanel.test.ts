import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, onScopeDispose, reactive, ref, watch } from 'vue';
import { VideoQuality } from 'livekit-client';
import { expect, it, vi } from 'vitest';

const script = parse(readFileSync(new URL('./CallViewingPanel.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const source = ts.createSourceFile('CallViewingPanel.ts', script, ts.ScriptTarget.Latest, true);
const callbacks = source.statements.filter(statement => !ts.isImportDeclaration(statement))
  .map(statement => statement.getText(source)).join('\n');
const compiled = ts.transpile(callbacks + '\nglobalThis.api = { panel, singleFullscreen, leaveSingle };', { target: ts.ScriptTarget.ES2022 });

function fixture() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const request = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const page = { fullscreenElement: null as unknown, exitFullscreen: vi.fn(async () => { page.fullscreenElement = null; }) };
  const element = { ownerDocument: page, requestFullscreen: vi.fn(() => request) };
  const emit = vi.fn();
  const view = reactive({ shares: [], single: null as number | null, mode: 'grid' });
  const context = { defineProps: () => ({ view }), defineEmits: () => emit,
    computed, ref, watch, onScopeDispose, onMounted: () => {}, VideoQuality,
    api: null as unknown as { panel: { value: unknown }; singleFullscreen(share: { key: number }): Promise<void>; leaveSingle(): Promise<void> } };
  const scope = effectScope();
  scope.run(() => runInNewContext(compiled, context));
  context.api.panel.value = element;
  return { ...context.api, scope, view, page, element, emit, resolve, reject };
}

it('请求全屏尚未结束时返回，迟到的成功退出全屏并保留原网格', async () => {
  const f = fixture();
  const starting = f.singleFullscreen({ key: 1 });
  await f.leaveSingle();
  f.page.fullscreenElement = f.element;
  f.resolve(); await starting;
  expect(f.page.exitFullscreen).toHaveBeenCalledOnce();
  expect(f.view.single).toBeNull();
  expect(f.view.mode).toBe('grid');
  expect(f.emit).not.toHaveBeenCalled();
  f.scope.stop();
});

it('旧全屏失败或组件销毁后的结果不能覆盖新的选择或弹出误导错误', async () => {
  const f = fixture();
  const starting = f.singleFullscreen({ key: 1 });
  f.scope.stop();
  f.view.single = 2;
  f.reject(new Error('旧请求失败')); await starting;
  expect(f.view.single).toBe(2);
  expect(f.emit).not.toHaveBeenCalled();
});
