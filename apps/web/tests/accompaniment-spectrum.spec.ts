import { expect, test } from '@playwright/test';

test('伴奏静音与停止时柱高和峰值自然落零，重新播放立即响应', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const context = new AudioContext();
      const output = context.createMediaStreamDestination();
      const gain = context.createGain();
      gain.connect(output);
      for (const frequency of [110, 294, 659, 1568, 3520]) {
        const oscillator = context.createOscillator();
        oscillator.frequency.value = frequency;
        oscillator.connect(gain);
        oscillator.start();
      }
      await context.resume();
      const track = output.stream.getAudioTracks()[0];
      Object.assign(window, { previewAudioTrack: track, setTestVolume: (value: number) => { gain.gain.value = value; } });
      return output.stream;
    };
  });
  await page.goto('/controls-preview.html#accompaniment');
  const section = page.getByRole('region', { name: '本地伴奏频谱试听' });
  const card = section.locator('article').filter({ hasText: '灵敏版' });
  const spectrum = card.locator('.spectrum');
  const start = section.getByRole('button', { name: '读取正在播放的声音' });
  const stop = section.getByRole('button', { name: '停止试听' });
  const volume = (level: number) => page.evaluate(value => {
    (window as Window & { setTestVolume?: (n: number) => void }).setTestVolume!(value);
  }, level);
  const levels = () => spectrum.locator('i').evaluateAll(bars => ({
    height: Math.max(0, ...bars.map(bar => bar.clientHeight)),
    peak: Math.max(0, ...bars.map(bar => parseFloat(getComputedStyle(bar).getPropertyValue('--peak')) || 0)),
  }));
  await start.click();
  await expect.poll(async () => (await levels()).height).toBeGreaterThan(45);
  await card.screenshot({ path: test.info().outputPath('playing.png') });
  await volume(0);
  await expect.poll(async () => (await levels()).peak).toBe(0);
  await expect(spectrum).toBeVisible();
  expect(await levels()).toEqual({ height: 0, peak: 0 });
  await volume(1);
  await expect.poll(async () => (await levels()).height).toBeGreaterThan(45);

  await stop.click();
  expect(await page.evaluate(() => (window as Window & { previewAudioTrack?: MediaStreamTrack }).previewAudioTrack?.readyState)).toBe('ended');
  await expect.poll(async () => { const { height, peak } = await levels(); return peak > height && peak > 0; }).toBe(true);
  await card.screenshot({ path: test.info().outputPath('settling.png') });
  await expect(spectrum).toHaveCount(0);
  await card.screenshot({ path: test.info().outputPath('silent.png') });

  await start.click();
  await expect.poll(async () => (await levels()).height).toBeGreaterThan(45);
  await stop.click();
  await start.click();
  await expect.poll(async () => (await levels()).height).toBeGreaterThan(45);
  await expect(spectrum).toHaveCount(1);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(levels).toEqual({ height: 0, peak: 0 });
  await stop.click();
  await expect(spectrum).toHaveCount(0);
});
