import { effectScope, nextTick, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { useClientUpdate } from './useClientUpdate';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

const current: StartupUpdateState = { phase: 'ready', version: '0.0.9', supported: true, message: '当前已是最新版本' };
const available: StartupUpdateState = { ...current, nextVersion: '0.0.10', message: '发现新版' };

async function setup() {
  const scope = effectScope();
  const active = ref(true);
  let listener!: (state: StartupUpdateState) => void;
  const removeListener = vi.fn();
  const bridge = {
    getUpdateState: vi.fn(async () => current),
    checkUpdates: vi.fn(async () => available),
    restartForUpdate: vi.fn(async () => {}),
    onUpdateState: vi.fn((callback: typeof listener) => { listener = callback; return removeListener; }),
  };
  const update = scope.run(() => useClientUpdate(bridge, () => active.value))!;
  await nextTick();
  return { scope, active, bridge, update, notify: (state: StartupUpdateState) => listener(state), removeListener };
}

describe('设置页确认重启更新', () => {
  it('发现新版只显示确认，用户确认后才申请重启；重复确认只执行一次', async () => {
    const { scope, update, bridge } = await setup();
    await update.check();
    expect(update.confirmationVersion.value).toBe('0.0.10');
    expect(bridge.restartForUpdate).not.toHaveBeenCalled();
    await update.restart();
    await update.restart();
    expect(bridge.restartForUpdate).toHaveBeenCalledOnce();
    expect(update.busy.value).toBe(true);
    scope.stop();
  });

  it('取消继续使用当前版本，不重启；再次检查可以重新确认', async () => {
    const { scope, update, bridge } = await setup();
    await update.check();
    update.cancel();
    await update.restart();
    expect(bridge.restartForUpdate).not.toHaveBeenCalled();
    expect(update.state.value?.nextVersion).toBe('0.0.10');
    await update.check();
    expect(update.confirmationVersion.value).toBe('0.0.10');
    scope.stop();
  });

  it('没有新版或检查失败时不询问重启，不伪造可更新状态', async () => {
    const { scope, update, bridge } = await setup();
    bridge.checkUpdates.mockResolvedValueOnce(current);
    await update.check();
    expect(update.confirmationVersion.value).toBe('');
    bridge.checkUpdates.mockResolvedValueOnce({ ...available, error: true, message: '检查失败' });
    await update.check();
    expect(update.confirmationVersion.value).toBe('');
    bridge.checkUpdates.mockRejectedValueOnce(new Error('IPC failed'));
    await update.check();
    expect(update.error.value).toContain('无法检查更新');
    expect(bridge.restartForUpdate).not.toHaveBeenCalled();
    scope.stop();
  });

  it('检查期间切栏再返回，迟到结果不重新弹出确认', async () => {
    const { scope, update, bridge, active } = await setup();
    const delayed = deferred<StartupUpdateState>();
    bridge.checkUpdates.mockReturnValueOnce(delayed.promise);
    const checking = update.check();
    await update.check();
    expect(bridge.checkUpdates).toHaveBeenCalledOnce();
    active.value = false;
    await nextTick();
    active.value = true;
    await nextTick();
    delayed.resolve(available);
    await checking;
    expect(update.confirmationVersion.value).toBe('');
    scope.stop();
  });

  it('重启申请失败保留确认并就近报错，允许取消或重试', async () => {
    const { scope, update, bridge } = await setup();
    await update.check();
    bridge.restartForUpdate.mockRejectedValueOnce(new Error('restart failed'));
    await update.restart();
    expect(update.error.value).toContain('无法重启更新');
    expect(update.confirmationVersion.value).toBe('0.0.10');
    expect(update.busy.value).toBe(false);
    update.cancel();
    expect(update.confirmationVersion.value).toBe('');
    scope.stop();
  });

  it('销毁后忽略迟到结果并移除状态监听', async () => {
    const { scope, update, bridge, removeListener, notify } = await setup();
    const delayed = deferred<StartupUpdateState>();
    bridge.checkUpdates.mockReturnValueOnce(delayed.promise);
    const checking = update.check();
    scope.stop();
    delayed.resolve(available);
    await checking;
    notify(available);
    expect(update.confirmationVersion.value).toBe('');
    expect(removeListener).toHaveBeenCalledOnce();
    expect(bridge.restartForUpdate).not.toHaveBeenCalled();
  });

  it('初始状态读取的迟到快照不会覆盖已收到的新状态', async () => {
    const scope = effectScope();
    const delayed = deferred<StartupUpdateState>();
    let listener!: (state: StartupUpdateState) => void;
    const bridge = { getUpdateState: () => delayed.promise,
      checkUpdates: async () => current, restartForUpdate: async () => {},
      onUpdateState: (callback: typeof listener) => { listener = callback; return () => {}; } };
    const update = scope.run(() => useClientUpdate(bridge, () => true))!;
    listener(available);
    delayed.resolve(current);
    await nextTick();
    expect(update.state.value).toEqual(available);
    scope.stop();
  });

  it('浏览器或不支持更新的入口不执行检查和重启', async () => {
    const scope = effectScope();
    const browser = scope.run(() => useClientUpdate(undefined, () => true))!;
    await browser.check();
    await browser.restart();
    expect(browser.confirmationVersion.value).toBe('');
    scope.stop();
    const setupDesktop = await setup();
    setupDesktop.notify({ ...current, supported: false });
    await setupDesktop.update.check();
    expect(setupDesktop.bridge.checkUpdates).not.toHaveBeenCalled();
    setupDesktop.scope.stop();
  });
});
