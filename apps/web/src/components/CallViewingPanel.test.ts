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
const compiled = ts.transpile(callbacks + '\nglobalThis.api = { panel, toggleExpanded, expandMembers, escape, elapsed, now };', { target: ts.ScriptTarget.ES2022 });

function fixture() {
  const page = { exitFullscreen: vi.fn(), documentElement: { requestFullscreen: vi.fn() },
    defaultView: { lycanViewerWindow: { toggleFullscreen: vi.fn() } } };
  const element = { ownerDocument: page };
  const emit = vi.fn();
  const view = reactive({ shares: [], mode: 'grid', expanded: false, membersVisible: true, height: 240, collapse: vi.fn() });
  const context = { defineProps: () => ({ view }), defineEmits: () => emit,
    computed, ref, watch, onScopeDispose, onMounted: () => {}, VideoQuality, performance,
    api: null as unknown as { panel: { value: unknown }; toggleExpanded(): void; expandMembers(): void;
      escape(event: KeyboardEvent): void; elapsed(share: { observedAt: number }): string; now: { value: number } } };
  const scope = effectScope();
  scope.run(() => runInNewContext(compiled, context));
  context.api.panel.value = element;
  return { ...context.api, scope, view, page, element, emit };
}

it('占满窗口只切换布局，不调用系统全屏，不改变聚焦、折叠记忆或原高度', () => {
  const f = fixture();
  f.toggleExpanded();
  expect(f.view.expanded).toBe(true);
  expect(f.view.mode).toBe('grid');
  expect(f.view.membersVisible).toBe(true);
  expect(f.view.height).toBe(240);
  f.toggleExpanded();
  expect(f.view.expanded).toBe(false);
  expect(f.page.documentElement.requestFullscreen).not.toHaveBeenCalled();
  expect(f.page.exitFullscreen).not.toHaveBeenCalled();
  expect(f.page.defaultView.lycanViewerWindow.toggleFullscreen).not.toHaveBeenCalled();
  expect(f.emit).not.toHaveBeenCalled();
  f.scope.stop();
});

it('Esc 先恢复布局，再退出观看；展开成员恢复普通布局并显示成员', () => {
  const f = fixture();
  const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent;
  f.toggleExpanded();
  f.escape(event);
  expect(f.view.expanded).toBe(false);
  expect(f.view.collapse).not.toHaveBeenCalled();
  f.escape(event);
  expect(f.view.collapse).toHaveBeenCalledOnce();
  f.view.membersVisible = false;
  f.toggleExpanded();
  f.expandMembers();
  expect(f.view.expanded).toBe(false);
  expect(f.view.membersVisible).toBe(true);
  f.scope.stop();
});

it('共享观察时长不足小时不显示小时，按实际间隔更新并防止负数', () => {
  const f = fixture();
  f.now.value = 59000;
  expect(f.elapsed({ observedAt: 0 })).toBe('00:59');
  f.now.value = 3661000;
  expect(f.elapsed({ observedAt: 0 })).toBe('1:01:01');
  expect(f.elapsed({ observedAt: 4000000 })).toBe('00:00');
  f.scope.stop();
});
