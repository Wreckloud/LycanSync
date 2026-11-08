import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import LogoutConfirmDialog from './LogoutConfirmDialog.vue';

afterEach(() => vi.unstubAllGlobals());

async function renderDialog(administrator: boolean, busy = false, error = '', mode: 'logout' | 'remove' = 'logout') {
  vi.stubGlobal('document', { activeElement: null });
  vi.stubGlobal('HTMLElement', class {});
  return renderToString(createSSRApp(LogoutConfirmDialog, { administrator, busy, error, mode }));
}

it('退出前说明媒体与凭据影响，区分服主和成员的恢复方式', async () => {
  const owner = await renderDialog(true, false, '', 'remove');
  expect(owner).toContain('aria-modal="true"');
  expect(owner).toContain('将清除本机登录信息');
  expect(owner).toContain('不会注销账号或清理聊天缓存');
  expect(owner).toContain('已保存的录像和诊断报告会保留');
  expect(owner).toContain('请先确认已在服主管理中设置恢复密码');
  expect(owner.indexOf('>取消</button>')).toBeLessThan(owner.indexOf('>清除凭据</button>'));
  const member = await renderDialog(false, false, '', 'remove');
  expect(member).toContain('联系服主获取新的恢复登录链接');
  expect(member).not.toContain('你是服主');
});

it('退出中禁用两个操作，失败在卡片内展示', async () => {
  const busy = await renderDialog(true, true);
  expect(busy.match(/<button[^>]*disabled/g)).toHaveLength(2);
  expect(busy).not.toContain('正在处理…');
  const failed = await renderDialog(true, false, '服务暂时不可用');
  expect(failed).toContain('inline-feedback card-feedback');
  expect(failed).toContain('role="alert"');
  expect(failed).toContain('服务暂时不可用');
});

it('普通退出保留凭据，不要求再次恢复账号', async () => {
  const html = await renderDialog(true);
  expect(html).toContain('保留本机凭据');
  expect(html).not.toContain('需要服务器维护者');
  expect(html).not.toContain('将清除本机');
});
