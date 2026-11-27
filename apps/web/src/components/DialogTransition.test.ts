import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

const descriptor = parse(readFileSync(new URL('./DialogTransition.vue', import.meta.url), 'utf8')).descriptor;
const setup = descriptor.scriptSetup!.content.replace(/^import .*;$/gm, '');
const compiled = ts.transpile(`${descriptor.script!.content}\nfunction createDialog() { ${setup}\nreturn { isolate, retire, restore }; }`, { target: ts.ScriptTarget.ES2022 });

function fixture() {
  const cleanup: (() => void)[] = [];
  const document = { body: { children: [] as Surface[] }, activeElement: null as Surface | null };
  class Surface {
    inert = false;
    style = { zIndex: '' };
    isConnected = true;
    attributes = new Set<string>();
    hasAttribute(name: string) { return this.attributes.has(name); }
    ownerDocument = document;
    firstElementChild: Surface | null = null;
    focus = vi.fn();
  }
  const create = runInNewContext(`${compiled}\ncreateDialog`, { HTMLElement: Surface, defineProps: () => ({}), watch: vi.fn(), onScopeDispose: (callback: () => void) => cleanup.push(callback) }) as () => {
    isolate(element: Surface): void; retire(element: Surface): void; restore(element: Surface): void;
  };
  const background = new Surface(), share = new Surface(), library = new Surface(), preview = new Surface();
  preview.firstElementChild = new Surface();
  // 分享入口的 Teleport 先挂载，录像管理器与预览在打开设置后才挂载。
  document.body.children = [background, share, library, preview];
  return { create, cleanup, background, share, library, preview, document, notice: new Surface() };
}

it('弹窗按打开顺序置顶，不依赖 Teleport 在 body 中的位置，返回时恢复交互', () => {
  const f = fixture();
  const library = f.create(), preview = f.create(), share = f.create();
  f.notice.attributes.add('data-dialog-notice');
  f.document.body.children = [f.background, f.library, f.notice];
  library.isolate(f.library);
  expect(f.notice.inert).toBe(false);
  f.document.body.children.push(f.preview);
  preview.isolate(f.preview);
  f.document.body.children.splice(1, 0, f.share);
  f.document.activeElement = f.preview;
  share.isolate(f.share);
  expect(Number(f.share.style.zIndex)).toBeGreaterThan(Number(f.preview.style.zIndex));
  expect(f.preview.inert).toBe(true);
  expect(f.share.inert).toBe(false);
  share.restore(f.share);
  expect(f.preview.inert).toBe(false);
  expect(f.library.inert).toBe(true);
  expect(f.preview.focus).toHaveBeenCalledWith({ preventScroll: true });
  share.isolate(f.share);
  expect(Number(f.share.style.zIndex)).toBeGreaterThan(Number(f.preview.style.zIndex));
  share.restore(f.share);
  preview.restore(f.preview);
  library.restore(f.library);
  expect(f.background.inert).toBe(false);
  expect(f.share.style.zIndex).toBe('');
});

it('退场取消不重复叠加隔离，卸载后释放层级并保留原有 inert 和样式', () => {
  const f = fixture();
  f.background.inert = true;
  f.preview.style.zIndex = '105';
  const dialog = f.create();
  dialog.isolate(f.preview);
  dialog.retire(f.preview);
  expect(f.preview.firstElementChild!.inert).toBe(true);
  dialog.isolate(f.preview);
  expect(f.preview.firstElementChild!.inert).toBe(false);
  f.cleanup.forEach(callback => callback());
  expect(f.background.inert).toBe(true);
  expect(f.preview.style.zIndex).toBe('105');
  expect(f.library.inert).toBe(false);
});
