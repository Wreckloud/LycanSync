import { effectScope, nextTick } from 'vue';
import { expect, it, vi } from 'vitest';
import { useActivityMappings } from './useActivityMappings';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

const option = { executable: 'c:\\game\\app.exe', title: '游戏 - 当前房间' };
const mapping = { executable: option.executable, name: '固定名称' };
async function settle() { for (let turn = 0; turn < 4; turn++) await nextTick(); }

function setup(stored: string | null = null) {
  const scope = effectScope();
  const bridge = { configureActivityMappings: vi.fn(async (_mappings: ActivityMapping[]) => {}),
    listActivityWindows: vi.fn(async () => [option]) };
  const storage = { getItem: vi.fn(() => stored), setItem: vi.fn() };
  const model = scope.run(() => useActivityMappings('member-a', bridge, storage))!;
  return { scope, bridge, storage, model };
}

it('先恢复当前账号名称，选择真实清单后才允许保存，名称不跟随标题变化', async () => {
  const { scope, model, bridge, storage } = setup();
  try {
    await settle();
    expect(bridge.configureActivityMappings).toHaveBeenCalledWith([]);
    expect(await model.save(option.executable, '虚构新增')).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
    await model.refreshWindows();
    const saving = deferred<void>();
    bridge.configureActivityMappings.mockReturnValueOnce(saving.promise);
    const pending = model.save(option.executable, ' 固定名称 ');
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(model.entries.value).toEqual([]);
    expect(await model.save(option.executable, '重复请求')).toBe(false);
    saving.resolve();
    expect(await pending).toBe(true);
    expect(model.entries.value).toEqual([mapping]);
    expect(storage.setItem).toHaveBeenCalledWith('lycansync.activity-mappings.v1.member-a', JSON.stringify([mapping]));
    bridge.listActivityWindows.mockResolvedValueOnce([{ ...option, title: '另一个房间' }]);
    await model.refreshWindows();
    expect(model.entries.value).toEqual([mapping]);
  } finally { scope.stop(); }
});

it('已保存但未运行的程序仍可改名或移除，不以名称凭空建立新条目', async () => {
  const { scope, model, bridge } = setup(JSON.stringify([mapping]));
  try {
    await settle();
    expect(model.windows.value).toEqual([]);
    expect(await model.save(mapping.executable, '更正名称')).toBe(true);
    expect(bridge.configureActivityMappings).toHaveBeenLastCalledWith([{ ...mapping, name: '更正名称' }]);
    expect(await model.save('c:\\unknown.exe', '新条目')).toBe(false);
    await model.remove(mapping.executable);
    expect(model.entries.value).toEqual([]);
    expect(bridge.configureActivityMappings).toHaveBeenLastCalledWith([]);
  } finally { scope.stop(); }
});

it('最近保存的程序排在名称优先序末尾，持久化及移除保留其余名称顺序', async () => {
  const lobby = { executable: 'c:\\game\\lobby.exe', name: '大厅名称' };
  const { scope, model, bridge, storage } = setup(JSON.stringify([lobby, mapping]));
  try {
    await settle();
    const renamedLobby = { ...lobby, name: '最新名称' };
    expect(await model.save(lobby.executable, renamedLobby.name)).toBe(true);
    expect(bridge.configureActivityMappings).toHaveBeenLastCalledWith([mapping, renamedLobby]);
    expect(storage.setItem).toHaveBeenLastCalledWith('lycansync.activity-mappings.v1.member-a',
      JSON.stringify([mapping, renamedLobby]));
    expect(await model.remove(lobby.executable)).toBe(true);
    expect(bridge.configureActivityMappings).toHaveBeenLastCalledWith([mapping]);
    expect(model.entries.value).toEqual([mapping]);
  } finally { scope.stop(); }
});

it('配置失败保留旧名称且不保存；存储失败只保留本次已生效配置并明确提示', async () => {
  const { scope, model, bridge, storage } = setup(JSON.stringify([mapping]));
  try {
    await settle();
    bridge.configureActivityMappings.mockRejectedValueOnce(new Error('helper failed'));
    expect(await model.save(mapping.executable, '失败名称')).toBe(false);
    expect(model.entries.value).toEqual([mapping]);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(model.error.value).toContain('未能应用');
    storage.setItem.mockImplementation(() => { throw new Error('disk denied'); });
    expect(await model.save(mapping.executable, '本次名称')).toBe(true);
    expect(model.entries.value[0].name).toBe('本次名称');
    expect(model.error.value).toContain('本次名称已生效');
  } finally { scope.stop(); }
});

it('读取失败不伪造恢复成功，窗口刷新不会清除名称设置错误', async () => {
  const { scope, model, bridge } = setup('invalid');
  try {
    await settle();
    expect(bridge.configureActivityMappings).toHaveBeenCalledWith([]);
    expect(model.error.value).toContain('无法读取');
    await model.refreshWindows();
    expect(model.error.value).toContain('无法读取');
    bridge.listActivityWindows.mockRejectedValueOnce(new Error('enumeration failed'));
    await model.refreshWindows();
    expect(model.windowError.value).toContain('无法读取运行窗口');
    expect(model.windows.value).toEqual([option]);
  } finally { scope.stop(); }
});

it('初始化失败可以重试，不把未应用的配置显示为已恢复', async () => {
  const scope = effectScope();
  const bridge = { configureActivityMappings: vi.fn().mockRejectedValueOnce(new Error('failed')).mockResolvedValue(undefined),
    listActivityWindows: vi.fn(async () => [option]) };
  const model = scope.run(() => useActivityMappings('member', bridge,
    { getItem: () => JSON.stringify([mapping]), setItem: vi.fn() }))!;
  try {
    await settle();
    expect(model.ready.value).toBe(false);
    expect(model.entries.value).toEqual([]);
    await model.initialize();
    expect(model.ready.value).toBe(true);
    expect(model.entries.value).toEqual([mapping]);
  } finally { scope.stop(); }
});

it('销毁后的窗口与保存结果不覆盖新页面，也不写入本机存储', async () => {
  const { scope, model, bridge, storage } = setup(JSON.stringify([mapping]));
  await settle();
  const listing = deferred<ActivityWindow[]>();
  const configuring = deferred<void>();
  bridge.listActivityWindows.mockReturnValueOnce(listing.promise);
  bridge.configureActivityMappings.mockReturnValueOnce(configuring.promise);
  const refresh = model.refreshWindows();
  const saving = model.save(mapping.executable, '迟到名称');
  scope.stop();
  listing.resolve([option]);
  configuring.resolve();
  await refresh;
  expect(await saving).toBe(false);
  expect(model.windows.value).toEqual([]);
  expect(model.entries.value).toEqual([mapping]);
  expect(storage.setItem).not.toHaveBeenCalled();
});

it('浏览器不读取系统窗口、不应用程序名称配置', async () => {
  const scope = effectScope();
  const storage = { getItem: vi.fn(), setItem: vi.fn() };
  const model = scope.run(() => useActivityMappings('member', undefined, storage))!;
  try {
    await model.refreshWindows();
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(model.windows.value).toEqual([]);
  } finally { scope.stop(); }
});
