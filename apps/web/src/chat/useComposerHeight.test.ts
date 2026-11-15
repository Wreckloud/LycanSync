import { afterEach, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useComposerHeight } from './useComposerHeight';

const hooks = vi.hoisted(() => ({ mount: () => {}, dispose: () => {} }));
vi.mock('vue', async importOriginal => ({ ...await importOriginal<typeof import('vue')>(),
  onMounted: (callback: () => void) => { hooks.mount = callback; },
  onScopeDispose: (callback: () => void) => { hooks.dispose = callback; },
}));
afterEach(() => { hooks.dispose(); vi.unstubAllGlobals(); });

it('附件增删、文字换行和窗口改宽都测量同一个容器，销毁停止观察', () => {
  let notify = () => {};
  const disconnect = vi.fn();
  const observe = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { notify = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  const input = { style: { height: '42px' }, scrollHeight: 42 };
  const viewport = { style: { height: '' } };
  let attachmentsHeight = 0;
  const content = { clientWidth: 500, get offsetHeight() { return parseFloat(input.style.height) + attachmentsHeight; } };
  const resize = useComposerHeight(ref(input as HTMLTextAreaElement), ref(viewport as HTMLElement), ref(content as HTMLElement));
  hooks.mount();
  expect(viewport.style.height).toBe('42px');
  attachmentsHeight = 34; notify();
  expect(viewport.style.height).toBe('76px');
  input.scrollHeight = 300; resize(); notify();
  expect(input.style.height).toBe('122px');
  expect(viewport.style.height).toBe('156px');
  attachmentsHeight = 0; input.scrollHeight = 64; content.clientWidth = 800; notify();
  expect(viewport.style.height).toBe('64px');
  input.scrollHeight = 42; resize(); notify();
  expect(viewport.style.height).toBe('42px');
  hooks.dispose();
  expect(disconnect).toHaveBeenCalledOnce();
});
