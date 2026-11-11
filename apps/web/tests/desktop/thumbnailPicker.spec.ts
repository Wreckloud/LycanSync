import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('真实窗口缩略图首次与缓存加载验收，仅输出脱敏耗时和覆盖率', async ({}, testInfo) => {
  test.skip(process.env.LYCAN_THUMBNAIL_ACCEPTANCE !== '1', '真实窗口测试需显式授权并设置 LYCAN_THUMBNAIL_ACCEPTANCE=1');
  const profile = testInfo.outputPath('profile'); mkdirSync(profile, { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: [resolve('tests/desktop/fixtures/thumbnailPickerApp.cjs'), profile], env });
  try {
    const page = await application.firstWindow();
    await page.route('**/src/main.ts*', async route => {
      const original = await (await route.fetch()).text();
      const vuePath = original.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)?.[1];
      if (!vuePath) throw new Error('未找到 Vite Vue 模块');
      await route.fulfill({ contentType: 'text/javascript', body: `
import { createApp, ref, h } from ${JSON.stringify(vuePath)};
import ScreenSharePicker from '/src/components/ScreenSharePicker.vue';
import { useScreenShareSelection } from '/src/rtc/useScreenShareSelection.ts';
import '/src/styles.css';
window.thumbnailEvents = [];
createApp({ setup() {
  const picker = ref(null);
  const desktop = { ...window.lycanDesktop, reportCapturePickerTiming: (stage, durationMs, details) =>
    window.thumbnailEvents.push({ stage, durationMs, ...details }) };
  const selection = useScreenShareSelection({ desktop, sourcesElement: () => picker.value?.sourcesElement,
    room: () => ({}), sharing: () => false, activity: () => null, notice: ref('') });
  return () => h('div', [h('button', { onClick: () => selection.requestNativeScreenSource(Promise.resolve({})) }, '打开选择器'),
    selection.captureRequest.value && h(ScreenSharePicker, {
      ref: picker, sources: selection.captureRequest.value.sources, sourceType: selection.captureSourceType.value,
      quality: 'standard', selectedId: selection.selectedCaptureSourceId.value, shareAudio: false,
      audioMode: 'unavailable', audioReady: true, audioFailed: false, loading: selection.nativeSourceLoading.value,
      error: selection.nativeSourceError.value, notice: '',
      onChoose: selection.chooseCaptureSource, onRefreshThumbnails: selection.refreshVisibleSourceThumbnails,
      onPreviewLoaded: selection.reportRenderedPreviews, onClose: () => selection.selectCaptureSource(null),
    })]);
} }).mount('#root');` });
    });
    await page.goto(`http://127.0.0.1:${process.env.WEB_PORT ?? 4173}`);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.showInactive());
    const rounds: unknown[] = [];
    for (let iteration = 0; iteration < 5; iteration++) {
      for (const cold of [true, false]) {
        if (cold) await application.evaluate(() => (global as unknown as { thumbnailTest: { reset(): void } }).thumbnailTest.reset());
        await page.evaluate(() => { (window as unknown as { thumbnailEvents: unknown[] }).thumbnailEvents = []; });
        await page.getByRole('button', { name: '打开选择器' }).click();
        await expect.poll(() => page.evaluate(() => (window as unknown as { thumbnailEvents: { stage: string }[] }).thumbnailEvents
          .some(event => event.stage === 'screenPickerVisibleReady')), { timeout: 8000 }).toBe(true);
        await page.locator('[data-source-id]').first().click();
        await page.getByRole('button', { name: '取消', exact: true }).click();
        const events = await page.evaluate(() => (window as unknown as { thumbnailEvents: { stage: string; durationMs: number; sourceCount: number; readyCount: number }[] }).thumbnailEvents);
        const complete = events.find(event => event.stage === 'screenPickerVisibleReady')!;
        rounds.push({ iteration, cold, events });
        expect(complete.readyCount).toBeGreaterThan(0);
        expect(complete.readyCount).toBe(complete.sourceCount);
        expect(complete.durationMs).toBeLessThan(cold ? 1000 : 200);
      }
    }
    const baseline = [];
    for (let index = 0; index < 3; index++) baseline.push(await application.evaluate(async () =>
      (global as unknown as { thumbnailTest: { baseline(): Promise<unknown> } }).thumbnailTest.baseline()));
    const native = await application.evaluate(() => {
      const state = (global as unknown as { thumbnailTest: { timings: unknown[]; measurements: { variedPixels: number }[] } }).thumbnailTest;
      return { timings: state.timings, measurements: state.measurements };
    });
    expect(native.measurements.every(image => image.variedPixels > 0)).toBe(true);
    writeFileSync(testInfo.outputPath('thumbnail-acceptance.json'), JSON.stringify({ rounds, baseline, native }, null, 2));
  } finally { await application.close(); }
});
