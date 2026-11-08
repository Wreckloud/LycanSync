import { expect, test } from '@playwright/test';

for (const desktop of [true, false]) {
  test(`${desktop ? '桌面' : '浏览器'}声音处理保留旧选择，统一切换并记住偏好`, async ({ page }) => {
    // 独立挂载真实设置组件；不创建媒体轨道或连接语音服务器。
    await page.route('**/src/main.ts*', async route => {
      const original = await (await route.fetch()).text();
      const vuePath = original.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)?.[1];
      if (!vuePath) throw new Error('未找到 Vite Vue 模块');
      await route.fulfill({ contentType: 'text/javascript', body: `
import { createApp, ref, h } from ${JSON.stringify(vuePath)};
import AudioSettings from '/src/components/settings/AudioSettings.vue';
import { useAudioPreferences } from '/src/rtc/useAudioPreferences.ts';
import '/src/styles.css';
import '/src/settings/settings.css';
const key = 'lycansync.audio-preferences.v1.audio-settings-test';
if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({
  echoCancellation: false, noiseSuppression: false, autoGainControl: true, voiceEnhancement: true,
  inputGain: 1.4, outputVolume: 0.8, screenShareVolume: 0.6,
}));
createApp({ setup() {
  const preferences = useAudioPreferences('audio-settings-test');
  const applied = ref([]);
  const active = ref(true);
  const shown = ref(true);
  const refreshes = ref({ input: 0, output: 0 });
  return () => h('main', { style: 'padding:24px' }, [shown.value && h(AudioSettings, {
    desktop: ${desktop}, preferences, active: active.value, inputLevelPercent: 0,
    rtc: { status: 'idle', busySources: [], setMicrophoneProcessing: async settings => {
      applied.value.push({ ...settings });
    } },
    microphoneTest: { state: 'idle', notice: '', inputLevelPercent: 0, stop: async () => {} },
    microphoneDevices: { devices: [], notice: '', changing: false, loading: false,
      refresh: async () => { refreshes.value.input++; } },
    audioOutput: { devices: ref([]), notice: ref(''), changing: ref(false), supported: true,
      refresh: async () => { refreshes.value.output++; } },
  }), h('output', { 'data-testid': 'applied-processing' }, JSON.stringify(applied.value)),
    h('output', { 'data-testid': 'device-refreshes' }, JSON.stringify(refreshes.value)),
    h('button', { onClick: () => { active.value = !active.value; } }, '切换测试页'),
    h('button', { onClick: () => { shown.value = false; } }, '卸载测试页')]);
} }).mount('#root');
` });
    });
    await page.goto('/');
    const toggle = page.getByRole('checkbox', { name: '智能声音处理', exact: true });
    await expect(toggle).toHaveJSProperty('indeterminate', true);
    await expect(toggle).toHaveAttribute('aria-checked', 'mixed');
    await expect(page.getByTestId('applied-processing')).toHaveText('[]');
    await expect(page.getByText('仍在使用你之前的处理设置，开启后将统一启用声音处理。')).toBeVisible();
    await expect(page.getByRole('checkbox')).toHaveCount(2);
    await expect(page.getByText('桌面版暂不支持回声消除，建议使用耳机通话。')).toHaveCount(0);
    if (!desktop) await expect(page.getByText('同时使用浏览器的回声消除。')).toBeVisible();

    const enabled = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: true };
    const disabled = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, voiceEnhancement: false };
    await toggle.check();
    await expect(toggle).toHaveJSProperty('indeterminate', false);
    await expect(page.getByTestId('applied-processing')).toHaveText(JSON.stringify([enabled]));
    await toggle.uncheck();
    await expect(page.getByTestId('applied-processing')).toHaveText(JSON.stringify([enabled, disabled]));
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem(
      'lycansync.audio-preferences.v1.audio-settings-test')!))).toMatchObject({
      ...disabled, inputGain: 1.4, outputVolume: 0.8, screenShareVolume: 0.6,
    });
    await page.reload();
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toHaveJSProperty('indeterminate', false);
    await expect(page.getByTestId('applied-processing')).toHaveText('[]');
    const sharedVolume = page.getByRole('slider', { name: '共享播放音量', exact: true });
    const sharedVolumeToggle = page.getByRole('button', { name: /共享播放音量/ });
    await expect(sharedVolume).toBeHidden();
    await expect(sharedVolumeToggle).toContainText('60%');
    await sharedVolumeToggle.click();
    await expect(sharedVolumeToggle).toHaveAttribute('aria-expanded', 'true');
    await sharedVolume.fill('0.4');
    await sharedVolumeToggle.click();
    await expect(sharedVolume).toBeHidden();
    await expect(sharedVolumeToggle).toContainText('40%');
    await expect(page.getByRole('button', { name: '刷新设备', exact: true })).toHaveCount(0);
    const counts = () => page.getByTestId('device-refreshes').evaluate(element => JSON.parse(element.textContent!) as { input: number; output: number });
    const initial = await counts();
    expect(initial.input).toBeGreaterThan(0);
    expect(initial.output).toBeGreaterThan(0);
    await page.getByRole('combobox', { name: '麦克风设备', exact: true }).focus();
    await expect.poll(counts).toMatchObject({ input: initial.input + 1 });
    await page.getByRole('combobox', { name: '声音输出设备', exact: true }).focus();
    await expect.poll(counts).toMatchObject({ output: initial.output + 1 });
    const beforeFocus = await counts();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(counts).toEqual({ input: beforeFocus.input + 1, output: beforeFocus.output + 1 });
    await page.getByRole('button', { name: '切换测试页' }).click();
    const inactive = await counts();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    expect(await counts()).toEqual(inactive);
    await page.getByRole('button', { name: '切换测试页' }).click();
    await expect.poll(counts).toEqual({ input: inactive.input + 1, output: inactive.output + 1 });
    await page.getByRole('button', { name: '卸载测试页' }).click();
    const unmounted = await counts();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    expect(await counts()).toEqual(unmounted);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem(
      'lycansync.audio-preferences.v1.audio-settings-test')!))).toMatchObject({
      ...disabled, inputGain: 1.4, outputVolume: 0.8, screenShareVolume: 0.4,
    });
    await page.reload();
    await expect(sharedVolume).toBeHidden();
    await expect(sharedVolumeToggle).toContainText('40%');
  });
}
