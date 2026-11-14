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

it('清除确认只说明重新登录方式，区分服主和成员', async () => {
  const owner = await renderDialog(true, false, '', 'remove');
  expect(owner).toContain('aria-modal="true"');
  expect(owner).toContain('清除后，再次登录需要已设置的恢复密码或已绑定的登录方式');
  expect(owner).not.toContain('结束通话');
  expect(owner).not.toContain('你是服主');
  expect(owner.indexOf('>取消</button>')).toBeLessThan(owner.indexOf('>清除登录信息</button>'));
  const member = await renderDialog(false, false, '', 'remove');
  expect(member).toContain('服主提供的恢复链接或已绑定的登录方式');
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
  expect(html).toContain('保存正在录制的录像与诊断记录');
  expect(html).toContain('未保存的即时回放将丢弃');
  expect(html).not.toContain('需要服务器维护者');
  expect(html).not.toContain('将清除本机');
});
