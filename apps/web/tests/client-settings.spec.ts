import { expect, test } from '@playwright/test';

test('客户端按应用、系统、日志、缓存排列，诊断选项可收起且不改变系统偏好', async ({ page }, testInfo) => {
  await page.route('**/api/**', route => route.abort());
  await page.route('**/src/main.ts*', async route => {
    const original = await (await route.fetch()).text();
    const vuePath = original.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)?.[1];
    if (!vuePath) throw new Error('未找到 Vite Vue 模块');
    await route.fulfill({ contentType: 'text/javascript', body: `
import { createApp, h, ref } from ${JSON.stringify(vuePath)};
import ClientSettings from '/src/components/settings/ClientSettings.vue';
import '/src/styles.css';
import '/src/settings/settings.css';
const calls = [];
window.lycanDesktop = {
  getAutoStart: async () => ({ supported:true, enabled:false }),
  getTraySettings: async () => ({ supported:true, enabled:true, error:'' }),
  setAutoStart: async () => { throw new Error('不应修改开机启动'); },
  setCloseToTray: async () => { throw new Error('不应修改托盘'); },
  getUpdateState: async () => ({ phase:'ready', version:'0.4.19', supported:true, message:'' }),
  onUpdateState: () => () => {},
  checkUpdates: async () => { calls.push('check'); return { phase:'ready', version:'0.4.19', supported:true, message:'当前已是最新版本。' }; },
  openExternal: async url => { calls.push(url); },
};
createApp({ setup() {
  const active = ref(true);
  const report = {
    recording:ref(true), automaticEnabled:ref(true), reason:ref(''), error:ref(''), saving:ref(false), notes:ref(''), latest:ref(null),
    savedReport:ref({ kind:'screen-media', endedAt:'2026-11-14T00:00:00Z', bytes:4096, clientVersion:'0.4.19' }),
    savedSizeBytes:ref(4096), persistenceError:ref(''), problemMarkers:ref([]),
    setViewing:open => { calls.push('view:'+open); }, setAutomatic:enabled => { report.automaticEnabled.value=enabled;report.recording.value=enabled; },
    save:async () => { calls.push('export'); }, savePrevious:async () => { calls.push('previous'); },
  };
  return () => h('main', { style:'padding:24px;max-width:868px;margin:auto' }, [
    h(ClientSettings,{ desktop:true,active:active.value,userId:'client-layout-test',room:null,report }),
    h('button',{onClick:()=>{active.value=!active.value;}},'切换测试页'),
    h('output',{'data-testid':'calls'},calls.join('|')),
  ]);
} }).mount('#root');` });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(['应用信息', '系统设置', '应用日志', '本地缓存']);
  await expect(page.getByRole('checkbox', { name: '开机自动启动', exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: '关闭时收起到托盘', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: '自动记录诊断', exact: true })).toBeChecked();
  await expect(page.getByRole('button', { name: '查看媒体诊断', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(page.getByText('当前已是最新版本。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '导出最近共享与观看报告', exact: true })).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('client-settings.png'), fullPage: true });
  await page.getByRole('button', { name: '更多诊断选项', exact: true }).click();
  await expect(page.getByText(/不是录像文件/)).toBeVisible();
  await page.getByRole('button', { name: '导出最近共享与观看报告', exact: true }).click();
  await page.getByRole('button', { name: '切换测试页', exact: true }).click();
  await page.getByRole('button', { name: '切换测试页', exact: true }).click();
  await expect(page.getByRole('button', { name: '导出最近共享与观看报告', exact: true })).toBeHidden();
  await page.setViewportSize({ width: 600, height: 820 });
  await expect(page.locator('main')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(600);
  await page.screenshot({ path: testInfo.outputPath('client-settings-narrow.png'), fullPage: true });
});
