import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import { createSSRApp, computed, effectScope, nextTick, reactive, ref, watch } from 'vue';
import { renderToString } from '@vue/server-renderer';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import ActivityStatus from './ActivityStatus.vue';

it('固定前缀和完整提示，游戏与音乐只在内容区展示名称', async () => {
  for (const [type, text] of [['GAME', '正在玩 一个很长的游戏名'], ['MUSIC', '正在听 歌曲名称']]) {
    const html = await renderToString(createSSRApp(ActivityStatus, { type, text, active: false }));
    expect(html).toContain(`title="${text}"`);
    expect(html).toContain('activity-prefix');
    expect(html).not.toContain('is-scrolling');
  }
});

it('只在悬浮且溢出时测量，文字或尺寸变化重算，移开及销毁释放观察', async () => {
  const script = parse(readFileSync(new URL('./ActivityStatus.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
  const source = ts.createSourceFile('ActivityStatus.ts', script, ts.ScriptTarget.Latest, true);
  const body = source.statements.filter(statement => !ts.isImportDeclaration(statement))
    .map(statement => statement.getText(source)).join('\n');
  const compiled = ts.transpile(body + '\nglobalThis.api = { viewport, content, distance };', { target: ts.ScriptTarget.ES2022 });
  const props = reactive({ type: 'GAME', text: '正在玩 游戏', active: false });
  const observers: { measure: () => void; disconnect: ReturnType<typeof vi.fn> }[] = [];
  class ResizeObserver {
    disconnect = vi.fn();
    observe = vi.fn();
    constructor(measure: () => void) { observers.push({ measure, disconnect: this.disconnect }); }
  }
  const context = { defineProps: () => props, computed, ref, watch,
    api: null as unknown as { viewport: { value: unknown }; content: { value: unknown }; distance: { value: number } } };
  const scope = effectScope();
  scope.run(() => runInNewContext(compiled, context));
  const viewport = { clientWidth: 100, ownerDocument: { defaultView: { ResizeObserver } } };
  const content = { scrollWidth: 220 };
  context.api.viewport.value = viewport;
  context.api.content.value = content;
  await nextTick();
  expect(observers).toHaveLength(0);
  props.active = true;
  await nextTick();
  expect(context.api.distance.value).toBe(120);
  viewport.clientWidth = 250;
  observers[0]!.measure();
  expect(context.api.distance.value).toBe(0);
  props.text = '正在玩 更新后的游戏';
  await nextTick();
  expect(observers[0]!.disconnect).toHaveBeenCalledOnce();
  props.active = false;
  await nextTick();
  expect(context.api.distance.value).toBe(0);
  expect(observers[1]!.disconnect).toHaveBeenCalledOnce();
  props.active = true;
  await nextTick();
  scope.stop();
  expect(observers[2]!.disconnect).toHaveBeenCalledOnce();
});
