import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, nextTick, onScopeDispose, reactive, ref, watch } from 'vue';
import { VideoQuality } from 'livekit-client';
import { motionDurationMs } from '../styles/motion';
import { expect, it, vi } from 'vitest';

const script = parse(readFileSync(new URL('./CallViewingPanel.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const source = ts.createSourceFile('CallViewingPanel.ts', script, ts.ScriptTarget.Latest, true);
const callbacks = source.statements.filter(statement => !ts.isImportDeclaration(statement))
  .map(statement => statement.getText(source)).join('\n');
const compiled = ts.transpile(callbacks + '\nglobalThis.api = { panel, toggleExpanded, expandMembers, escape, elapsed, now, select, sizing, tileStyle, videoSize };', { target: ts.ScriptTarget.ES2022 });

function fixture(width = 600, height = 300) {
  const page = { exitFullscreen: vi.fn(), documentElement: { requestFullscreen: vi.fn() },
    defaultView: { lycanViewerWindow: { toggleFullscreen: vi.fn() }, requestAnimationFrame: (callback: () => void) => callback() } };
  const element = { ownerDocument: page, isConnected: true };
  const emit = vi.fn();
  const view = reactive({ shares: [], displayed: [] as { key: number }[], mode: 'grid', focused: 1, expanded: false, membersVisible: true, height: 240, collapse: vi.fn(), grid: vi.fn(), select: vi.fn() });
  const context = { withDefaults: (props: object, defaults: object) => ({ ...defaults, ...props }), defineProps: () => ({ view }), defineEmits: () => emit,
    useViewingSize: () => ({ width: ref(width), height: ref(height), maximumHeight: ref(420), resizing: ref(false) }),
    computed, ref, watch, nextTick, onScopeDispose, setInterval, clearInterval, onMounted: () => {}, VideoQuality, performance, motionDurationMs,
    api: null as unknown as { panel: { value: unknown }; toggleExpanded(): void; expandMembers(): void;
      sizing: { value: { rows: number } }; tileStyle(share: { key: number }): { width: string; height: string };
      videoSize(key: number, size: { width: number; height: number }): void;
      select(share: { participant: { identity: string } }): void; escape(event: KeyboardEvent): void; elapsed(share: { observedAt: number }): string; now: { value: number } } };
  const scope = effectScope();
  scope.run(() => runInNewContext(compiled, context));
  context.api.panel.value = element;
  return { ...context.api, scope, view, page, element, emit };
}

it('同一画面连续点击始终按当前模式切换，不等待动画锁', () => {
  const f = fixture();
  const share = { participant: { identity: 'A' } };
  f.select(share);
  expect(f.view.select).toHaveBeenCalledWith('A');
  f.view.mode = 'focus';
  f.select(share);
  expect(f.view.grid).toHaveBeenCalledOnce();
  f.view.mode = 'grid';
  f.select(share);
  expect(f.view.select).toHaveBeenCalledTimes(2);
  f.scope.stop();
});

it('混合横竖屏按真实列宽装入网格，单路超宽画面不溢出，放大后使用整个舞台', () => {
  const f = fixture(1200, 600);
  try {
    for (const aspects of [[4], [4, 2 / 3, 16 / 9, 1, 2 / 3]]) {
      f.view.displayed = aspects.map((aspect, key) => {
        f.videoSize(key, { width: aspect * 900, height: 900 });
        return { key };
      });
      const rows = f.sizing.value.rows;
      const sizes = f.view.displayed.map(share => f.tileStyle(share));
      const columns = Math.ceil(sizes.length / rows);
      const contentWidth = Array.from({ length: columns }, (_, column) => Math.max(...sizes
        .slice(column * rows, (column + 1) * rows).map(size => Number.parseFloat(size.width))))
        .reduce((sum, width) => sum + width, 0) + (columns - 1) * 8;
      expect(contentWidth).toBeLessThanOrEqual(1200.01);
      expect(Number.parseFloat(sizes[0]!.height) * rows + (rows - 1) * 8).toBeLessThanOrEqual(600.01);
    }
    f.view.displayed = [{ key: 0 }];
    f.view.expanded = true;
    expect(f.tileStyle({ key: 0 })).toEqual({ width: '1200px', height: '600px' });
  } finally { f.scope.stop(); }
});

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
