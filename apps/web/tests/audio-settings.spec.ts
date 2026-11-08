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
  return () => h('main', { style: 'padding:24px' }, [h(AudioSettings, {
    desktop: ${desktop}, preferences, active: true, inputLevelPercent: 0,
    rtc: { status: 'idle', busySources: [], setMicrophoneProcessing: async settings => {
      applied.value.push({ ...settings });
    } },
    microphoneTest: { state: 'idle', notice: '', inputLevelPercent: 0 },
    microphoneDevices: { devices: [], notice: '', changing: false, loading: false },
    audioOutput: { devices: ref([]), notice: ref(''), changing: ref(false), supported: true },
  }), h('output', { 'data-testid': 'applied-processing' }, JSON.stringify(applied.value))]);
} }).mount('#root');
` });
    });
    await page.goto('/');
    const toggle = page.getByRole('checkbox', { name: '智能声音处理', exact: true });
    await expect(toggle).toHaveJSProperty('indeterminate', true);
    await expect(toggle).toHaveAttribute('aria-checked', 'mixed');
    await expect(page.getByTestId('applied-processing')).toHaveText('[]');
    await expect(page.getByText('已保留之前的部分处理设置，开启后统一启用。')).toBeVisible();
    await expect(page.getByRole('checkbox')).toHaveCount(2);
    await expect(page.getByText('桌面版暂不支持回声消除，建议使用耳机通话。')).toHaveCount(0);
    if (!desktop) await expect(page.getByText('开启后同时请求浏览器进行回声消除。')).toBeVisible();

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
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem(
      'lycansync.audio-preferences.v1.audio-settings-test')!))).toMatchObject({
      ...disabled, inputGain: 1.4, outputVolume: 0.8, screenShareVolume: 0.4,
    });
    await page.reload();
    await expect(sharedVolume).toBeHidden();
    await expect(sharedVolumeToggle).toContainText('40%');
  });
}
