import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { ref } from 'vue';
import { expect, it, vi } from 'vitest';
import type { SettingsSectionId } from '../settings/settingsSections';

const script = parse(readFileSync(new URL('./SettingsView.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const sourceFile = ts.createSourceFile('SettingsView.ts', script, ts.ScriptTarget.Latest, true);
const callbacks = ['selectSection', 'leaveSettings'].map((name) => {
  const declaration = sourceFile.statements.find((statement) => ts.isFunctionDeclaration(statement)
    && statement.name?.text === name);
  if (!declaration) throw new Error(`设置回调不存在：${name}`);
  return declaration.getText(sourceFile);
}).join('\n');
const compiled = ts.transpile(callbacks, { target: ts.ScriptTarget.ES2022 });

function setup() {
  const state = { activeSection: ref<SettingsSectionId>('account'), leaving: ref(false),
    profileSettings: ref({ finishEditing: vi.fn(async () => true) }),
    props: { user: { administrator: false } }, emit: vi.fn() };
  const callbacks = runInNewContext(`${compiled}\n({ selectSection, leaveSettings })`, state) as {
    selectSection: (section: SettingsSectionId) => Promise<void>; leaveSettings: (logout: boolean) => Promise<void>;
  };
  return { state, ...callbacks };
}

it('资料完成保存或失败回退后允许换栏目，普通成员不能进入邀请管理', async () => {
  const { state, selectSection } = setup();
  await selectSection('members');
  expect(state.profileSettings.value.finishEditing).not.toHaveBeenCalled();
  expect(state.activeSection.value).toBe('account');
  await selectSection('client');
  expect(state.profileSettings.value.finishEditing).toHaveBeenCalledOnce();
  expect(state.activeSection.value).toBe('client');
});

it.each([false, true])('返回/退出动作%s先等待资料处理，并阻止重复动作', async (logout) => {
  const { state, leaveSettings } = setup();
  let finish!: (allowed: boolean) => void;
  state.profileSettings.value.finishEditing.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const first = leaveSettings(logout);
  await leaveSettings(!logout);
  expect(state.emit).not.toHaveBeenCalled();
  finish(true);
  await first;
  expect(state.emit).toHaveBeenCalledExactlyOnceWith(logout ? 'logout' : 'close');
  expect(state.leaving.value).toBe(false);
});

it('头像尚未处理完时保留账号页，不发出返回或退出事件', async () => {
  const { state, leaveSettings } = setup();
  state.activeSection.value = 'audio';
  state.profileSettings.value.finishEditing.mockResolvedValue(false);
  await leaveSettings(false);
  expect(state.activeSection.value).toBe('account');
  expect(state.emit).not.toHaveBeenCalled();
  expect(state.leaving.value).toBe(false);
});
