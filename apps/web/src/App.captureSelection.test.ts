import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { effectScope, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { saveScreenShareAudioPreference, type NativeScreenAudioMode } from './rtc/nativeScreenAudioMode';
import type { CustomScreenShareQuality, ScreenShareQualityId } from './rtc/screenShareQuality';
import { useScreenShareSelection } from './rtc/useScreenShareSelection';

const script = parse(readFileSync(new URL('./App.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const sourceFile = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true);
const names = ['changeScreenShareAudio', 'changeScreenShareQuality'];
const callbacks = sourceFile.statements.filter(statement => ts.isFunctionDeclaration(statement)
  && names.includes(statement.name?.text ?? '')).map(statement => statement.getText(sourceFile)).join('\n');
const compiled = ts.transpile(callbacks, { target: ts.ScriptTarget.ES2022 });
const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); vi.unstubAllGlobals(); });

function setup(mode: NativeScreenAudioMode = 'process') {
  const setItem = vi.fn();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem });
  const scope = effectScope(); scopes.push(scope);
  const viewerNotice = ref('');
  const selection = scope.run(() => useScreenShareSelection({ notice: viewerNotice, sourcesElement: () => undefined,
    room: () => null, sharing: () => false, activity: () => null }))!;
  selection.captureQuality.value = 'custom';
  selection.captureCustomQuality.value = { resolution: 1440, fps: 120 };
  const rtc = { currentScreenShareAudioMode: mode, setScreenShareAudioEnabled: vi.fn(async () => true),
    currentCustomScreenShareQuality: { resolution: 1080, fps: 60 } as CustomScreenShareQuality, setScreenShareQuality: vi.fn(async () => true) };
  const state = { ...selection, viewerNotice };
  const app = runInNewContext(compiled + '\n({ changeScreenShareQuality, changeScreenShareAudio })', {
    ...state, rtc, localParticipant: ref({ isScreenShareEnabled: true }), saveScreenShareAudioPreference,
  }) as { changeScreenShareQuality(quality: ScreenShareQualityId, custom?: CustomScreenShareQuality): Promise<boolean>;
    changeScreenShareAudio(enabled: boolean): Promise<boolean> };
  return { app, state, rtc, setItem };
}

it.each([true, false])('共享中手动码率只在应用成功 %s 后保存', async (success) => {
  const { app, rtc, state, setItem } = setup();
  rtc.setScreenShareQuality.mockResolvedValueOnce(success);
  await app.changeScreenShareQuality('custom', { resolution: 1080, fps: 60, bitrateMbps: 6 });
  expect(setItem).toHaveBeenCalledTimes(success ? 1 : 0);
  expect(state.captureCustomQuality.value.bitrateMbps).toBe(success ? 6 : undefined);
});

it.each([true, false])('共享中自定义只有实际应用成功 %s 才更新偏好，默认读取当前共享而非选择器草稿', async (success) => {
  const { app, state, rtc, setItem } = setup();
  let complete!: (value: boolean) => void;
  rtc.setScreenShareQuality.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
  const changing = app.changeScreenShareQuality('custom');
  expect(rtc.setScreenShareQuality).toHaveBeenCalledWith('custom', { resolution: 1080, fps: 60 });
  expect(setItem).not.toHaveBeenCalled();
  complete(success);
  await changing;
  expect(setItem).toHaveBeenCalledTimes(success ? 1 : 0);
  expect(state.captureCustomQuality.value).toEqual(success ? { resolution: 1080, fps: 60 } : { resolution: 1440, fps: 120 });
});

it.each([true, false])('共享中开关仅在 RTC 操作成功 %s 后保存', async (success) => {
  const { app, rtc, setItem } = setup('systemMix');
  let complete!: (success: boolean) => void;
  rtc.setScreenShareAudioEnabled.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
  const changing = app.changeScreenShareAudio(true);
  expect(rtc.setScreenShareAudioEnabled).toHaveBeenCalledWith(true);
  expect(setItem).not.toHaveBeenCalled();
  complete(success);
  await changing;
  if (success) expect(setItem).toHaveBeenCalledWith('lycansync.screen-share-audio.systemMix', 'true');
  else expect(setItem).not.toHaveBeenCalled();
});
