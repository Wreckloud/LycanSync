import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { ref } from 'vue';
import { expect, it, vi } from 'vitest';

const script = parse(readFileSync(new URL('./App.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const source = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true);
const callbacks = source.statements.filter(statement => ts.isFunctionDeclaration(statement)
  && ['refreshRecordingAvailability', 'openSavedRecordings'].includes(statement.name?.text ?? ''));
const compiled = ts.transpile(callbacks.map(statement => statement.getText(source)).join('\n'), { target: ts.ScriptTarget.ES2022 });
function fixture() {
  const state = { desktop: { getRecordingLibrary: vi.fn() }, hasRecordings: ref<boolean | null>(null), recordingLibraryRevision: 0,
    appDisposed: false, appNotice: ref({ id: 1 }), console: { warn: vi.fn() }, settingsOpen: ref(false), settingsSection: ref('account'),
    settingsView: ref({ interactionBlocked: false, leaving: false }), recordingLibraryOpen: ref(false),
    openSettings: vi.fn(async () => { state.settingsOpen.value = true; state.settingsSection.value = 'recording'; }), dismissAppNotice: vi.fn() };
  const actions = runInNewContext(`${compiled}\n({refreshRecordingAvailability,openSavedRecordings})`, state) as {
    refreshRecordingAvailability(): Promise<void>; openSavedRecordings(event: unknown): Promise<void>;
  };
  return { state, ...actions };
}
it('只显示存在可读视频的入口，失效和活动条目不算，继续检查后续页', async () => {
  const f = fixture();
  f.state.desktop.getRecordingLibrary.mockResolvedValueOnce({ items: [
    { availability: 'missing', state: 'saved', bytes: 100 }, { availability: 'available', state: 'recording', bytes: 100 },
  ], hasMore: true }).mockResolvedValueOnce({ items: [{ availability: 'available', state: 'saved', bytes: 100 }], hasMore: false });
  await f.refreshRecordingAvailability();
  expect(f.state.hasRecordings.value).toBe(true);
  expect(f.state.desktop.getRecordingLibrary).toHaveBeenLastCalledWith(2);
  f.state.desktop.getRecordingLibrary.mockResolvedValue({ items: [], hasMore: false });
  await f.refreshRecordingAvailability();
  expect(f.state.hasRecordings.value).toBe(false);
});

it('打开设置期间出现的新通知不会被旧录像通知的跳转清掉', async () => {
  const f = fixture();
  f.state.openSettings.mockImplementationOnce(async () => {
    f.state.settingsOpen.value = true;
    f.state.settingsSection.value = 'recording';
    f.state.appNotice.value = { id: 2 };
  });
  await f.openSavedRecordings({});
  expect(f.state.recordingLibraryOpen.value).toBe(true);
  expect(f.state.dismissAppNotice).not.toHaveBeenCalled();
});
it('旧列表响应不能覆盖新保存结果，读取失败不假报有录像', async () => {
  const f = fixture();
  let resolve!: (value: unknown) => void;
  f.state.desktop.getRecordingLibrary.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const reading = f.refreshRecordingAvailability();
  f.state.recordingLibraryRevision++;
  f.state.hasRecordings.value = true;
  resolve({ items: [], hasMore: false });
  await reading;
  expect(f.state.hasRecordings.value).toBe(true);
  f.state.desktop.getRecordingLibrary.mockRejectedValueOnce(new Error('unavailable'));
  await f.refreshRecordingAvailability();
  expect(f.state.hasRecordings.value).toBeNull();
  expect(f.state.console.warn).toHaveBeenCalledOnce();
});
it('成功通知先进入录制设置再打开管理器，被设置编辑阻止时不叠加窗口', async () => {
  const f = fixture();
  const event = {};
  await f.openSavedRecordings(event);
  expect(f.state.openSettings).toHaveBeenCalledWith('recording', event);
  expect(f.state.recordingLibraryOpen.value).toBe(true);
  expect(f.state.settingsOpen.value).toBe(true);
  f.state.recordingLibraryOpen.value = false;
  f.state.settingsView.value.interactionBlocked = true;
  await f.openSavedRecordings(event);
  expect(f.state.recordingLibraryOpen.value).toBe(false);
  expect(f.state.dismissAppNotice).toHaveBeenCalledTimes(1);
});
