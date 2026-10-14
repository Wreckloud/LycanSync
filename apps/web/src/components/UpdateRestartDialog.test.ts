import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import UpdateRestartDialog from './UpdateRestartDialog.vue';

async function renderDialog(busy = false, error = '') {
  vi.stubGlobal('document', { activeElement: null });
  vi.stubGlobal('HTMLElement', class {});
  const context: { teleports?: Record<string, string> } = {};
  await renderToString(createSSRApp(UpdateRestartDialog, { version: '0.0.10', busy, error }), context);
  return context.teleports?.body ?? '';
}
afterEach(() => vi.unstubAllGlobals());

describe('更新重启确认卡片', () => {
  it('展示版本和中断影响，取消在左、重启在右，反馈有固定区域', async () => {
    const html = await renderDialog();
    expect(html).toContain('发现新版本 0.0.10');
    expect(html).toContain('结束当前通话、屏幕共享和远控');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('class="card-actions"');
    expect(html).toContain('confirm-button card-actions-end');
    expect(html.indexOf('>取消</button>')).toBeLessThan(html.indexOf('>重启更新</button>'));
    expect(html).toContain('inline-feedback card-feedback');
  });

  it('申请重启期间禁用两个操作，失败只在卡片内显示', async () => {
    const busy = await renderDialog(true);
    expect(busy.match(/<button[^>]*disabled/g)).toHaveLength(2);
    expect(busy).toContain('正在重启…');
    const failed = await renderDialog(false, '无法重启更新，请稍后重试。');
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('无法重启更新，请稍后重试。');
  });
});
