import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // 挂载正式菜单，只有设置与媒体边界使用测试状态，不连接设备或服务。
  await page.route('**/src/main.ts*', async route => {
    const original = await (await route.fetch()).text();
    const vuePath = original.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)?.[1];
    if (!vuePath) throw new Error('未找到 Vite Vue 模块');
    await route.fulfill({ contentType: 'text/javascript', body: `
import { createApp, h, reactive } from ${JSON.stringify(vuePath)};
import CallControls from '/src/components/CallControls.vue';
import '/src/styles.css';
createApp({ setup() {
  const state = reactive({ voiceMode:'voice', pushToTalkBinding:'F2', processingEnabled:true, sharing:true, recordingActive:true, voiceVolumeBalance:true, gameName:'饥荒联机版' });
  window.quickControlsTest = state;
  return () => h('div', { class:'callbar', style:'position:fixed;bottom:20px;right:20px' }, [h(CallControls, {
    connected:true, desktop:true, microphoneEnabled:true, microphoneIntent:true, microphoneBusy:false,
    microphoneLevel:0.3, inputLevelPercent:30, listening:true, inputGain:1, outputVolume:1,
    shareBusy:false, choosingSource:false, shareLimitReached:false, quality:'standard', shareAudio:true, audioMode:'process',
    recordingElapsed:'03:24', replayActive:true,
    shortcutsSupported:true, shortcutsReady:true, ...state,
    onVoiceMode:mode => {state.voiceMode=mode;}, onProcessing:enabled => {state.processingEnabled=enabled;},
    onVoiceVolumeBalance:enabled => {state.voiceVolumeBalance=enabled;},
    onShare:() => {state.sharing=!state.sharing;state.recordingActive=false;}
  })]);
}}).mount('#root');` });
  });
  await page.goto('/');
});

test('麦克风快捷切换更新勾选，声音处理是一个开关且切换不改变菜单高度', async ({ page }, testInfo) => {
  const opener = page.getByRole('button', { name: '麦克风选项', exact: true });
  await opener.click();
  const menu = page.getByRole('region', { name: '麦克风选项', exact: true });
  const before = (await menu.boundingBox())!;
  expect(before.x).toBeGreaterThanOrEqual(0);
  expect(before.y).toBeGreaterThanOrEqual(0);
  await menu.getByRole('button', { name: '按键说话 F2' }).click();
  await expect(menu.getByRole('button', { name: '按键说话 F2' })).toHaveAttribute('aria-pressed', 'true');
  const processing = menu.getByRole('checkbox', { name: '智能声音处理' });
  await expect(processing).toBeChecked();
  await processing.uncheck();
  await expect(processing).not.toBeChecked();
  expect((await menu.boundingBox())!.height).toBe(before.height);
  await expect(menu).toHaveCSS('opacity', '1');
  await page.screenshot({ path: testInfo.outputPath('microphone-menu.png') });
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(opener).toBeFocused();
});

test('发言模式滑块双向过渡，减少动画时立即切换', async ({ page }) => {
  await page.getByRole('button', { name: '麦克风选项', exact: true }).click();
  const mode = page.getByRole('group', { name: '发言模式' });
  for (const label of ['按键说话 F2', '自由发言']) {
    const positions = await mode.getByRole('button', { name: label, exact: true }).evaluate(async element => {
      const slider = element.parentElement!.querySelector('.segmented-slider')!;
      const positions = [slider.getBoundingClientRect().x];
      (element as HTMLButtonElement).click();
      for (let frame = 0; frame < 18; frame++) {
        await new Promise(requestAnimationFrame);
        positions.push(slider.getBoundingClientRect().x);
      }
      return positions;
    });
    const first = positions[0]!, last = positions.at(-1)!;
    expect(Math.abs(last - first)).toBeGreaterThan(40);
    expect(positions.some(position => position > Math.min(first, last) + 1 && position < Math.max(first, last) - 1)).toBe(true);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(mode.locator('.segmented-slider')).toHaveCSS('transition-duration', '0s');
  await mode.getByRole('button', { name: '按键说话 F2' }).click();
  await expect(mode.getByRole('button', { name: '按键说话 F2' })).toHaveAttribute('aria-pressed', 'true');
});

test('共享菜单按操作顺序直接展示，画质保留二级调整，未共享时不重复开始共享', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 420, height: 720 });
  const opener = page.getByRole('button', { name: '共享选项', exact: true });
  await opener.click();
  const menu = page.getByRole('region', { name: '共享选项', exact: true });
  await expect(menu.getByRole('button')).toHaveText(['关闭共享', '停止录制 · 03:24', '共享画质标准', '保存即时回放', '共享与录制']);
  await expect(menu.getByRole('checkbox')).toHaveCount(0);
  await menu.getByRole('button', { name: '共享画质' }).click();
  const quality = page.getByRole('region', { name: '共享画质', exact: true });
  await expect(quality.getByRole('group', { name: '画质预设' }).getByRole('radio')).toHaveCount(4);
  await expect(quality.getByRole('checkbox', { name: '共享音频' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(quality).toBeHidden();
  await expect(menu.getByRole('button', { name: '共享画质' })).toBeFocused();
  await expect(menu).toHaveCSS('opacity', '1');
  await page.screenshot({ path: testInfo.outputPath('share-menu.png') });
  await menu.getByRole('button', { name: '关闭共享', exact: true }).click();
  await opener.click();
  await expect(menu.getByRole('button')).toHaveText(['快速共享 饥荒联机版', '开始共享并录制', '共享画质标准', '共享与录制']);
  await menu.getByRole('button', { name: '共享画质' }).click();
  await expect(quality.getByRole('radio').first()).toBeEnabled();
});

test('未绑定显示括号标记，收听音量平衡可直接切换', async ({ page }) => {
  await page.evaluate(() => {
    (window as unknown as { quickControlsTest: { pushToTalkBinding: string } }).quickControlsTest.pushToTalkBinding = '';
  });
  await page.getByRole('button', { name: '麦克风选项', exact: true }).click();
  await expect(page.getByRole('button', { name: '按键说话 (未设置)' })).toBeVisible();
  const hint = page.getByRole('button', { name: '请先为按键发言设置快捷键', exact: true });
  await expect(hint).toBeHidden();
  await page.getByRole('button', { name: '按键说话 (未设置)' }).click();
  await expect(hint).toBeVisible();
  const mode = (await page.getByRole('group', { name: '发言模式' }).boundingBox())!;
  const hintBounds = (await hint.boundingBox())!;
  expect(hintBounds.y).toBeGreaterThanOrEqual(mode.y + mode.height);
  expect(hintBounds.y).toBeLessThan((await page.getByText('智能声音处理', { exact: true }).boundingBox())!.y);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '麦克风选项', exact: true }).click();
  await expect(hint).toBeHidden();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '收听选项', exact: true }).click();
  const balance = page.getByRole('checkbox', { name: '平衡成员语音音量' });
  await expect(balance).toBeChecked();
  await balance.uncheck();
  await expect(balance).not.toBeChecked();
});
