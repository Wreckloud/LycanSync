import { expect, test } from '@playwright/test';

test('伴奏持续有声时，弱谐波能贴底且主音和中等频段仍清晰', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const context = new AudioContext();
      const output = context.createMediaStreamDestination();
      // 锯齿波同时提供强基音和逐渐变弱的谐波，覆盖整排频段。
      const tone = context.createOscillator();
      tone.type = 'sawtooth';
      tone.frequency.value = 94;
      const gain = context.createGain();
      gain.gain.value = .12;
      tone.connect(gain).connect(output);
      tone.start();
      await context.resume();
      return output.stream;
    };
  });
  await page.goto('/controls-preview.html#accompaniment');
  const section = page.getByRole('region', { name: '本地伴奏频谱试听' });
  const card = section.locator('article').filter({ hasText: '灵敏版' });
  await section.getByRole('button', { name: '读取正在播放的声音' }).click();
  const bars = card.locator('.spectrum i');
  await expect.poll(() => bars.evaluateAll(items => Math.max(...items.map(item => item.clientHeight)))).toBeGreaterThan(65);
  await card.screenshot({ path: test.info().outputPath('harmonics.png') });
  const heights = await bars.evaluateAll(items => items.map(item => item.clientHeight));
  console.log('稳定谐波的各柱高度（px）', heights.join(', '));
  expect(heights.filter(h => h === 4).length).toBeGreaterThanOrEqual(2);
  expect(heights.some(h => h > 4 && h <= 12)).toBe(true);
  expect(heights.some(h => h > 12 && h < 50)).toBe(true);
});

test('伴奏静音与停止时柱高和峰值自然落零，重新播放立即响应', async ({ page }) => {
  await page.clock.install();
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
    peak: Math.max(0, ...bars.map(bar => parseFloat(getComputedStyle(bar, '::after').bottom) + 2)),
  }));
  await start.click();
  await expect.poll(async () => (await levels()).height).toBeGreaterThan(45);
  const heights = () => spectrum.locator('i').evaluateAll(bars => bars.map(bar => bar.clientHeight));
  const playing = await heights();
  expect(playing).toHaveLength(21);
  expect(Math.min(...playing)).toBe(4);
  await card.screenshot({ path: test.info().outputPath('playing.png') });
  // 同一组音降低 20 dB 后仍应有可读的柱高，同时保留一定强弱差。
  await volume(.1);
  await page.waitForTimeout(1200);
  const normalHeight = (await levels()).height;
  await volume(.01);
  await page.waitForTimeout(1200);
  const quietHeight = (await levels()).height;
  expect(quietHeight).toBeGreaterThan(normalHeight * .7);
  expect(quietHeight).toBeLessThan(normalHeight);
  console.log('同一合成音降低 20 dB 前后的最高柱（px）', normalHeight, quietHeight);
  await volume(0);
  await expect.poll(async () => (await levels()).peak).toBe(0);
  await expect(spectrum).toBeVisible();
  expect(await levels()).toEqual({ height: 0, peak: 0 });
  await volume(1);
  await expect.poll(async () => (await levels()).height).toBeGreaterThan(45);

  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 250));
  await stop.evaluate(button => (button as HTMLButtonElement).click());
  expect(await page.evaluate(() => (window as Window & { previewAudioTrack?: MediaStreamTrack }).previewAudioTrack?.readyState)).toBe('ended');
  await page.clock.runFor(160);
  const settling = await levels();
  expect(settling.peak).toBeGreaterThan(settling.height);
  await card.screenshot({ path: test.info().outputPath('settling.png') });
  await page.clock.runFor(480);
  const drifting = await levels();
  expect(drifting.height).toBe(4);
  expect(drifting.peak).toBeGreaterThan(drifting.height);
  expect(drifting.peak).toBeLessThan(settling.peak);
  await card.screenshot({ path: test.info().outputPath('peaks.png') });
  for (let tick = 0; tick < 32 && (await levels()).peak > 4; tick++) {
    expect(Math.min(...await heights())).toBeGreaterThanOrEqual(4);
    await page.clock.runFor(80);
  }
  expect(await heights()).toEqual(Array(21).fill(4));
  expect((await levels()).peak).toBe(4);
  expect(await spectrum.locator('i').evaluateAll(bars => bars.every(bar => getComputedStyle(bar, '::after').height === '0px'))).toBe(true);
  await card.screenshot({ path: test.info().outputPath('baseline.png') });
  await page.clock.runFor(319);
  expect(await heights()).toEqual(Array(21).fill(4));
  await page.clock.runFor(1);
  await expect(spectrum).toHaveCount(0);
  await card.screenshot({ path: test.info().outputPath('silent.png') });
  await page.clock.resume();

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
