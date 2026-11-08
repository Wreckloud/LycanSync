import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { ref } from 'vue';
import { expect, it, vi } from 'vitest';

const script = parse(readFileSync(new URL('./App.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const source = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true);
const callback = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'closeSettings')!;
const compiled = ts.transpile(callback.getText(source), { target: ts.ScriptTarget.ES2022 });

function setup() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const stopped = new Promise<void>((complete, fail) => { resolve = complete; reject = fail; });
  const focus = vi.fn();
  const state = { microphoneTest: { stop: vi.fn(() => stopped) }, settingsOpen: ref(true),
    settingsReturnFocus: ref({ focus }), viewerNotice: ref(''), appDisposed: false, nextTick: async () => {} };
  const closeSettings = runInNewContext(`${compiled}\ncloseSettings`, state) as () => Promise<void>;
  return { state, focus, closeSettings, resolve, reject };
}

it('停止试听立即启动，等待原生回收时已能开始设置退场', async () => {
  const f = setup();
  const closing = f.closeSettings();
  expect(f.state.microphoneTest.stop).toHaveBeenCalledOnce();
  expect(f.state.settingsOpen.value).toBe(false);
  await vi.waitFor(() => expect(f.focus).toHaveBeenCalledOnce());
  f.resolve();
  await closing;
  expect(f.state.viewerNotice.value).toBe('');
});

it('停止失败保留明确提示，不阻挡界面退出或伪装回收成功', async () => {
  const f = setup();
  const closing = f.closeSettings();
  f.reject(new Error('stop failed'));
  await closing;
  expect(f.state.settingsOpen.value).toBe(false);
  expect(f.state.viewerNotice.value).toContain('停止麦克风试听时发生问题');
});

it('应用已销毁时迟到的停止失败不再更新界面', async () => {
  const f = setup();
  const closing = f.closeSettings();
  f.state.appDisposed = true;
  f.reject(new Error('stop failed'));
  await closing;
  expect(f.state.viewerNotice.value).toBe('');
});
