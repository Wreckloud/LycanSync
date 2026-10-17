import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { describe, expect, it } from 'vitest';
import PersonalStatusCard from './PersonalStatusCard.vue';
import type { AuthUser } from '../auth/authApi';

const user = { id: 'self', nickname: '本人', avatar: '' } as AuthUser;

describe('底部个人名片', () => {
  it('无公开动态时保留在线状态，动态存在时与成员列表使用相同文字', async () => {
    const idle = await renderToString(createSSRApp(PersonalStatusCard, { user, status: 'ONLINE', statusLabel: '在线' }));
    expect(idle).toContain('在线');
    expect(idle).not.toContain('member-activity');
    const active = await renderToString(createSSRApp(PersonalStatusCard, { user, status: 'ONLINE', statusLabel: '在线',
      activityStatus: { type: 'GAME', text: '正在玩 游戏 · 1:00' } }));
    expect(active).toContain('正在玩 游戏 · 1:00');
    expect(active).toMatch(/class="[^"]*\bONLINE\b[^"]*\bstatus-dot\b/);
    expect(active).toContain('member-activity');
  });
});
