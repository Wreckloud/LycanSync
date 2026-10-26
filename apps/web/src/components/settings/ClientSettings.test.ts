import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue';
import { expect, it, vi } from 'vitest';
import { useClientUpdate } from '../../settings/useClientUpdate';

const script = parse(readFileSync(new URL('./ClientSettings.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const sourceFile = ts.createSourceFile('ClientSettings.ts', script, ts.ScriptTarget.Latest, true);
const callbacks = sourceFile.statements.filter((statement) => !ts.isImportDeclaration(statement))
  .map((statement) => statement.getText(sourceFile)).join('\n');
const compiled = ts.transpile(callbacks, { target: ts.ScriptTarget.ES2022 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

function setup(active = true) {
  const support = deferred<{ hideCursor: boolean; hideBorder: boolean }>();
  const autoStart = deferred<{ supported: boolean; enabled: boolean }>();
  const updateState: StartupUpdateState = { phase: 'ready', version: '0.0.10', supported: true, message: '' };
  const bridge = { getScreenShareSupport: vi.fn(() => support.promise), getAutoStart: vi.fn(() => autoStart.promise),
    setAutoStart: vi.fn(async (enabled: boolean) => ({ supported: true, enabled })),
    getUpdateState: vi.fn(async () => updateState), checkUpdates: vi.fn(async (): Promise<StartupUpdateState> => ({ ...updateState, nextVersion: '0.0.11' })),
    restartForUpdate: vi.fn(async () => {}), onUpdateState: vi.fn(() => () => {}) };
  const scope = effectScope();
  const props = reactive({ active, desktop: true });
  const savePreferences = vi.fn();
  const exposed = vi.fn();
  // 执行真实组件监听和更新流程，IPC 只返回受控数据，不修改系统设置。
  const settings = scope.run(() => runInNewContext(`${compiled}\n({ autoStartDescription,
    autoStartEnabled, autoStartBusy, autoStartError, screenPreferences, screenError,
    updateAutoStart, updateScreenPreference, checkUpdates, cancelUpdate, confirmingUpdate, updateDescription })`, {
    computed, reactive, ref, watch, useClientUpdate, Error, window: { lycanDesktop: bridge },
    defineProps: () => props, defineEmits: () => vi.fn(), defineExpose: exposed,
    readScreenSharePreferences: () => ({ hideCursor: false, hideBorder: false }), saveScreenSharePreferences: savePreferences,
  })) as {
    autoStartDescription: { value: string };
    autoStartEnabled: { value: boolean }; autoStartBusy: { value: boolean }; autoStartError: { value: string };
    screenPreferences: { hideCursor: boolean; hideBorder: boolean }; screenError: { value: string };
    updateAutoStart: (event: Event) => Promise<void>;
    updateScreenPreference: (key: 'hideCursor', event: Event) => void;
    checkUpdates: () => Promise<void>; cancelUpdate: () => void; confirmingUpdate: { value: boolean };
    updateDescription: { value: string };
  };
  return { scope, props, settings, support, autoStart, bridge, savePreferences, exposed };
}

const checked = { target: { checked: true } } as unknown as Event;

it('其他设置栏目不查更新，进入客户端栏目只查一次并更新原有小字，不自动弹确认', async () => {
  const { scope, props, settings, bridge } = setup(false);
  try {
    await nextTick();
    expect(bridge.getUpdateState).not.toHaveBeenCalled();
    expect(bridge.checkUpdates).not.toHaveBeenCalled();
    const pending = deferred<StartupUpdateState>();
    bridge.checkUpdates.mockReturnValueOnce(pending.promise);
    props.active = true;
    await nextTick(); await nextTick();
    expect(bridge.checkUpdates).toHaveBeenCalledOnce();
    expect(settings.updateDescription.value).toBe('正在检查更新…');
    pending.resolve({ phase: 'ready', version: '0.0.10', supported: true, message: '当前已是最新版本' });
    await nextTick();
    expect(settings.updateDescription.value).toBe('当前已是最新版本');
    expect(settings.confirmingUpdate.value).toBe(false);
    props.active = false;
    await nextTick(); await nextTick();
    expect(bridge.checkUpdates).toHaveBeenCalledOnce();
    expect(bridge.restartForUpdate).not.toHaveBeenCalled();
  } finally { scope.stop(); }
});

it('查询完成前显示读取中，仅确定不支持后显示限制', async () => {
  const { scope, settings, support, autoStart, bridge } = setup();
  try {
    expect(settings.autoStartDescription.value).toContain('正在读取');
    await settings.updateAutoStart(checked);
    expect(bridge.setAutoStart).not.toHaveBeenCalled();
    support.resolve({ hideCursor: true, hideBorder: false });
    autoStart.resolve({ supported: false, enabled: false });
    await nextTick();
    expect(settings.autoStartDescription.value).toContain('仅 Windows 安装版支持');
  } finally { scope.stop(); }
});

it('查询失败明确报错，不将未确认的支持情况显示为不支持', async () => {
  const { scope, settings, support, autoStart } = setup();
  try {
    support.reject(new Error('support unavailable'));
    autoStart.reject(new Error('login settings unavailable'));
    await nextTick();
    await nextTick();
    expect(settings.screenError.value).toContain('无法确认');
    expect(settings.autoStartError.value).toContain('无法读取');
    expect(settings.autoStartDescription.value).toContain('尚未确认');
  } finally { scope.stop(); }
});

it('共享偏好只保存已支持的设置，保存失败回退并提示', async () => {
  const { scope, settings, support, savePreferences } = setup();
  try {
    support.resolve({ hideCursor: true, hideBorder: false });
    await nextTick();
    settings.updateScreenPreference('hideCursor', checked);
    expect(settings.screenPreferences.hideCursor).toBe(true);
    savePreferences.mockImplementationOnce(() => { throw new Error('storage denied'); });
    const input = { checked: false };
    settings.updateScreenPreference('hideCursor', { target: input } as unknown as Event);
    expect(settings.screenPreferences.hideCursor).toBe(true);
    expect(input.checked).toBe(true);
    expect(settings.screenError.value).toContain('无法保存');
  } finally { scope.stop(); }
});

it('开机自启修改不并发，失败恢复原值；重试使用系统实际返回值', async () => {
  const { scope, settings, autoStart, bridge } = setup();
  try {
    autoStart.resolve({ supported: true, enabled: false });
    await nextTick();
    const pending = deferred<{ supported: boolean; enabled: boolean }>();
    bridge.setAutoStart.mockReturnValueOnce(pending.promise);
    const saving = settings.updateAutoStart(checked);
    await settings.updateAutoStart(checked);
    expect(bridge.setAutoStart).toHaveBeenCalledOnce();
    expect(settings.autoStartBusy.value).toBe(true);
    pending.reject(new Error('系统拒绝修改'));
    await saving;
    expect(settings.autoStartEnabled.value).toBe(false);
    expect(settings.autoStartError.value).toBe('系统拒绝修改');
    expect(settings.autoStartBusy.value).toBe(false);
    bridge.setAutoStart.mockResolvedValueOnce({ supported: true, enabled: false });
    await settings.updateAutoStart(checked);
    expect(settings.autoStartEnabled.value).toBe(false);
    expect(settings.autoStartError.value).toBe('');
  } finally { scope.stop(); }
});

it('只有更新确认期间向父页面报告隔离背景，取消后恢复', async () => {
  const { scope, settings, exposed } = setup();
  try {
    await nextTick();
    await nextTick();
    expect(exposed.mock.calls[0][0].confirmingUpdate).toBe(settings.confirmingUpdate);
    expect(settings.confirmingUpdate.value).toBe(false);
    await settings.checkUpdates();
    expect(settings.confirmingUpdate.value).toBe(true);
    settings.cancelUpdate();
    expect(settings.confirmingUpdate.value).toBe(false);
  } finally { scope.stop(); }
});
