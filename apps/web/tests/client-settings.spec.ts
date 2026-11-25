import { expect, test } from '@playwright/test';

test('客户端按应用、系统、日志、缓存排列，诊断选项可收起且不改变系统偏好', async ({ page }, testInfo) => {
  await page.route(url => url.pathname.startsWith('/api/'), route => route.abort());
  await page.route('**/src/main.ts*', async route => {
    const original = await (await route.fetch()).text();
    const vuePath = original.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)?.[1];
    if (!vuePath) throw new Error('未找到 Vite Vue 模块');
    await route.fulfill({ contentType: 'text/javascript', body: `
import { createApp, h, ref } from ${JSON.stringify(vuePath)};
import ClientSettings from '/src/components/settings/ClientSettings.vue';
import '/src/styles.css';
import '/src/settings/settings.css';
const calls = ref([]);
let updateListener;
let offerUpdate = false;
const defaultPath = ['D:', 'LycanSync', 'data', 'exports'].join(String.fromCharCode(92));
const customPath = ['E:', '游戏记录', '语音日志'].join(String.fromCharCode(92));
let logPath = defaultPath;
let chooseAttempts = 0;
window.lycanDesktop = {
  saveDirectory: async (kind, action) => {
    if (kind !== 'diagnostics') throw new Error('目录类型错误');
    if (action === 'choose' && ++chooseAttempts > 1) logPath = customPath;
    if (action === 'reset') logPath = defaultPath;
    if (action === 'open') calls.value.push('open:'+logPath);
    return { path:logPath, defaultPath, isDefault:logPath === defaultPath };
  },
  getAutoStart: async () => ({ supported:true, enabled:false }),
  getTraySettings: async () => ({ supported:true, enabled:true, error:'' }),
  setAutoStart: async () => { throw new Error('不应修改开机启动'); },
  setCloseToTray: async () => { throw new Error('不应修改托盘'); },
  getUpdateState: async () => ({ phase:'ready', version:'0.4.19', supported:true, message:'' }),
  onUpdateState: callback => { updateListener = callback; return () => { updateListener = undefined; }; },
  checkUpdates: async () => { calls.value.push('check'); return { phase:'ready', version:'0.4.19', supported:true,
    nextVersion:offerUpdate ? '0.4.20' : undefined, message:'当前已是最新版本。' }; },
  restartForUpdate: () => {
    updateListener({ phase:'installing', version:'0.4.19', supported:true, message:'即将开始安装，完成后自动打开应用…' });
    return new Promise(() => {});
  },
  openExternal: async url => { calls.value.push(url); },
};
createApp({ setup() {
  const active = ref(true);
  const report = {
    recording:ref(true), automaticEnabled:ref(true), reason:ref(''), error:ref(''), saving:ref(false), notes:ref(''), latest:ref(null),
    savedReport:ref({ kind:'screen-media', endedAt:'2026-11-14T00:00:00Z', bytes:4096, clientVersion:'0.4.19' }),
    savedSizeBytes:ref(4096), persistenceError:ref(''), problemMarkers:ref([]),
    setViewing:open => { calls.value.push('view:'+open); }, setAutomatic:enabled => { report.automaticEnabled.value=enabled;report.recording.value=enabled; },
    exportStatus:ref(''), save:async notes => { calls.value.push('export:'+notes); report.exportStatus.value='已导出'; },
    upload:async (notes = '') => { calls.value.push('upload:'+notes); report.exportStatus.value='日志已上传给服主。'; },
  };
  return () => h('main', { style:'padding:24px;max-width:868px;margin:auto' }, [
    h(ClientSettings,{ desktop:true,active:active.value,userId:'client-layout-test',room:null,report }),
    h('button',{onClick:()=>{active.value=!active.value;}},'切换测试页'),
    h('button',{onClick:()=>{offerUpdate=true;}},'模拟发现新版'),
    h('output',{'data-testid':'calls'},calls.value.join('|')),
  ]);
} }).mount('#root');` });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(['应用信息', '系统设置', '应用日志', '本地缓存']);
  await expect(page.getByRole('checkbox', { name: '开机自动启动', exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: '关闭时收起到托盘', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: '自动记录诊断', exact: true })).toBeHidden();
  const exportReport = page.getByRole('button', { name: '导出全部报告', exact: true });
  await expect(exportReport).toBeHidden();
  await page.locator('.diagnostic-report-settings').screenshot({ path: testInfo.outputPath('app-logs.png') });
  await expect(page.getByTestId('calls')).not.toContainText('upload');
  await page.getByRole('button', { name: '上传日志', exact: true }).click();
  await expect(page.getByTestId('calls')).toContainText('upload');
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(page.getByText('当前已是最新版本。', { exact: true })).toBeVisible();
  const dialog = page.getByRole('dialog', { name: '诊断报告' });
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: '更多诊断选项', exact: true }).click();
  const location = page.getByRole('group', { name: '日志保存位置' });
  const choose = location.getByRole('button', { name: /^更改日志保存位置/ });
  const reset = location.getByRole('button', { name: '恢复默认' });
  await expect(choose).toContainText('exports');
  await choose.click();
  await expect(reset).toBeHidden();
  await choose.click();
  await expect(choose).toContainText('语音日志');
  await location.getByRole('button', { name: '打开文件夹' }).click();
  await expect(page.getByTestId('calls')).toContainText('open:E:');
  await location.screenshot({ path: testInfo.outputPath('logs-directory.png') });
  await reset.click();
  const confirmation = page.getByRole('dialog', { name: '恢复默认保存位置？' });
  await expect(confirmation).toContainText('exports');
  await confirmation.screenshot({ path: testInfo.outputPath('restore-directory.png'), animations: 'disabled' });
  await confirmation.getByRole('button', { name: '取消' }).click();
  await expect(choose).toContainText('语音日志');
  await reset.click();
  await confirmation.getByRole('button', { name: '恢复默认' }).click();
  await expect(reset).toBeHidden();
  await expect(choose).toContainText('exports');
  await expect(choose).toBeFocused();
  await exportReport.click();
  await expect(page.getByTestId('calls')).toContainText('export:');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('checkbox', { name: '自动记录诊断', exact: true })).toBeChecked();
  await expect(page.getByRole('button', { name: '查看媒体诊断', exact: true })).toBeDisabled();
  await page.locator('.diagnostic-report-settings').screenshot({ path: testInfo.outputPath('app-logs-options.png') });
  await page.getByRole('textbox', { name: /问题说明/ }).fill('共享卡顿');
  await exportReport.click();
  await expect(page.getByTestId('calls')).toContainText('export:共享卡顿');
  await page.getByRole('button', { name: '上传日志' }).click();
  await expect(page.getByTestId('calls')).toContainText('upload:共享卡顿');
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: '收起诊断选项', exact: true }).click();
  await expect(exportReport).toBeHidden();
  await expect(page.getByRole('button', { name: '上传日志', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '切换测试页', exact: true }).click();
  await page.getByRole('button', { name: '切换测试页', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.setViewportSize({ width: 600, height: 820 });
  await page.getByRole('button', { name: '更多诊断选项', exact: true }).click();
  await expect(choose).toContainText('exports');
  await expect(page.locator('main')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(600);
  await page.screenshot({ path: testInfo.outputPath('client-settings-narrow.png'), fullPage: true });
  await page.getByRole('button', { name: '模拟发现新版' }).click();
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await page.getByRole('button', { name: '重启更新', exact: true }).click();
  await expect(page.getByText('即将开始安装，完成后自动打开应用…', { exact: true })).toBeVisible();
});
