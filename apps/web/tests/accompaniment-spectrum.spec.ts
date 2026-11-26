import { expect, test } from '@playwright/test';

test('伴奏退场即时释放音轨，频谱先落回底线再淡出', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const context = new AudioContext();
      const output = context.createMediaStreamDestination();
      const oscillator = context.createOscillator();
      oscillator.connect(output);
      oscillator.start();
      await context.resume();
      Object.assign(window, { previewAudioTrack: output.stream.getAudioTracks()[0] });
      return output.stream;
    };
  });
  await page.goto('/controls-preview.html#accompaniment');
  const section = page.getByRole('region', { name: '本地伴奏频谱试听' });
  await section.getByRole('button', { name: '读取正在播放的声音' }).click();
  const spectrum = section.locator('.spectrum').first();
  await expect(spectrum).toHaveCSS('opacity', '0.3');
  await expect.poll(() => spectrum.locator('i').evaluateAll(bars => Math.max(...bars.map(bar => bar.clientHeight)))).toBeGreaterThan(4);
  await page.addStyleTag({ content: ':root { --motion-surface-duration: 500ms; }' });
  await section.getByRole('button', { name: '停止试听' }).click();
  expect(await page.evaluate(() => (window as Window & { previewAudioTrack?: MediaStreamTrack }).previewAudioTrack?.readyState)).toBe('ended');
  await expect(spectrum).toHaveClass(/spectrum-reveal-leave-to/);
  const transitions = await spectrum.evaluate(el => el.getAnimations().filter(a => a instanceof CSSTransition)
    .map(a => ({ property: a.transitionProperty, delay: a.effect!.getTiming().delay })));
  expect(transitions).toEqual(expect.arrayContaining([{ property: 'transform', delay: 0 }, { property: 'opacity', delay: 500 }]));
  await expect(spectrum).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await section.getByRole('button', { name: '读取正在播放的声音' }).click();
  await expect(spectrum).toBeVisible();
  await section.getByRole('button', { name: '停止试听' }).click();
  await expect(spectrum).toHaveCount(0);
});
