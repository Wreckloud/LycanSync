import { expect, it, vi } from 'vitest';
import { initializeViewerPage, type ViewerWindowState } from './viewerPage';

const visible: ViewerWindowState = { visible: true, focused: true, pinned: false };

function page() {
  let stateListener: ((state: ViewerWindowState) => void) | undefined;
  let disarmListener: (() => void) | undefined;
  let resolveReady!: (state: ViewerWindowState) => void;
  const ready = new Promise<ViewerWindowState>((resolve) => { resolveReady = resolve; });
  const root = { hidden: false, textContent: '' };
  const stopState = vi.fn(), stopDisarm = vi.fn(), postMessage = vi.fn();
  const view = Object.assign(new EventTarget(), {
    document: { getElementById: () => root },
    location: { hash: '#11111111-1111-4111-8111-111111111111', origin: 'lycan://app' },
    opener: { postMessage },
    lycanViewerWindow: {
      ready: () => ready,
      onState: (listener: typeof stateListener) => { stateListener = listener; return stopState; },
      onDisarm: (listener: () => void) => { disarmListener = listener; return stopDisarm; },
    },
  });
  return { view, root, stopState, stopDisarm, postMessage, resolveReady,
    initialize: () => initializeViewerPage(view as unknown as Window),
    state: (state: ViewerWindowState) => stateListener?.(state), disarm: () => disarmListener?.() };
}

it('窗口就绪才通知主页面，原生隐藏投影根节点；恢复不发送输入激活', async () => {
  const f = page(), disarm = vi.fn(), states: unknown[] = [];
  f.view.addEventListener('lycan-viewer-disarm', disarm);
  f.view.addEventListener('lycan-viewer-state', (event) => states.push((event as CustomEvent).detail));
  const initialized = f.initialize();
  expect(f.postMessage).not.toHaveBeenCalled();
  f.resolveReady(visible); await initialized;
  expect(f.postMessage).toHaveBeenCalledWith({ type: 'lycan-viewer-ready', id: f.view.location.hash.slice(1) }, 'lycan://app');
  f.state({ ...visible, visible: false });
  expect(f.root.hidden).toBe(true); expect(disarm).toHaveBeenCalledOnce();
  f.state(visible);
  expect(f.root.hidden).toBe(false); expect(disarm).toHaveBeenCalledOnce();
  f.disarm(); expect(disarm).toHaveBeenCalledTimes(2);
  expect(states).toHaveLength(3);
});

it('就绪请求中的新原生状态不被旧返回覆盖，关窗注销且迟到就绪不挂载', async () => {
  const f = page(), initialized = f.initialize();
  f.state({ ...visible, visible: false });
  f.resolveReady(visible); await initialized;
  expect(f.root.hidden).toBe(true);
  const pending = page(), loading = pending.initialize();
  pending.view.dispatchEvent(new Event('pagehide'));
  pending.resolveReady(visible); await loading;
  pending.state({ ...visible, visible: false });
  expect(pending.stopState).toHaveBeenCalledOnce(); expect(pending.stopDisarm).toHaveBeenCalledOnce();
  expect(pending.postMessage).not.toHaveBeenCalled();
  expect(pending.root.hidden).toBe(false);
});

it('无有效匿名窗口身份时明确失败，不调用窗口桥', async () => {
  const f = page();
  f.view.location.hash = '#not-an-id';
  await f.initialize();
  expect(f.root.textContent).toContain('来源无效');
  expect(f.postMessage).not.toHaveBeenCalled();
});

it('原生就绪失败显示失败，不向主页面伪报可以挂载', async () => {
  const f = page();
  f.view.lycanViewerWindow.ready = () => Promise.reject(new Error('window closed'));
  await f.initialize();
  expect(f.root.textContent).toContain('初始化失败');
  f.view.dispatchEvent(new Event('pagehide'));
  expect(f.stopState).toHaveBeenCalledOnce(); expect(f.stopDisarm).toHaveBeenCalledOnce();
  f.state({ ...visible, visible: false });
  expect(f.root.hidden).toBe(false);
  expect(f.postMessage).not.toHaveBeenCalled();
});
