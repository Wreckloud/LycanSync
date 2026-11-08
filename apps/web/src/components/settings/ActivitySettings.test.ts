import { createSSRApp, ref } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { expect, it, vi } from 'vitest';
import ActivitySettings from './ActivitySettings.vue';
import type { UserActivity } from '../../presence/presenceApi';

async function render(activity: UserActivity | null, desktop = true, loading = false) {
  const mappings = { entries: ref([{ executable: 'c:\\game.exe', name: '固定游戏名' }]),
    windows: ref([{ executable: 'c:\\game.exe', title: '当前窗口' }]), busy: ref(false),
    loading: ref(loading), ready: ref(true), error: ref(''), windowError: ref(''),
    initialize: vi.fn(async () => {}), refreshWindows: vi.fn(async () => {}),
    save: vi.fn(async () => true), remove: vi.fn(async () => true) };
  const html = await renderToString(createSSRApp(ActivitySettings, {
    user: { id: 'self', nickname: '测试成员', avatar: '', administrator: false },
    active: false, activity, desktop, showActivity: true, showLastOnline: true, error: '', mappings,
    presenceMode: 'online', presenceReady: true,
  }));
  return { html, mappings };
}

it('动态与上次在线分别提供开关，游戏与音乐共用动态设置，提供窗口选择和已有条目编辑，不提供自由新增', async () => {
  const { html, mappings } = await render({ type: 'MUSIC', name: '歌曲' });
  expect(html).toContain('正在听');
  expect(html).toContain('歌曲');
  expect(html).toContain('选择正在运行的窗口');
  expect(html).toContain('编辑动态名称 固定游戏名');
  expect(html).toContain('移除动态名称 固定游戏名');
  expect(html.match(/type="checkbox"/g)).toHaveLength(2);
  expect(html).not.toContain('手动输入并回车');
  expect(mappings.refreshWindows).not.toHaveBeenCalled();
  expect((await render({ type: 'GAME', name: '游戏' })).html).toContain('正在玩');
});

it('浏览器不展示系统窗口入口，未检测到动态不误报正在玩', async () => {
  const { html } = await render(null, false);
  expect(html).toContain('动态检测仅在 Windows 桌面版提供');
  expect(html).not.toContain('activity-window');
  expect(html.match(/<aside[\s\S]*?<\/aside>/)?.[0]).not.toContain('正在玩');
  expect(html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0]).not.toContain('disabled');
});

it('识别结果放在修正标题旁，页面仅保留紧凑选择与操作，不预留名称编辑空白', async () => {
  const { html } = await render({ type: 'GAME', name: '游戏' });
  const current = html.match(/<p class="activity-current"[^>]*>([\s\S]*?)<\/p>/)?.[1];
  expect(current).toContain('游戏');
  expect(current).not.toContain('正在玩');
  expect(current).not.toContain('<svg');
  expect(current).toContain('当前识别：');
  expect(html).toContain('动态识别修正');
  expect(html).not.toContain('activity-name-editor');
  expect(html).not.toContain('activity-display-name');
  expect(html).toMatch(/<button[^>]*disabled[^>]*>重置<\/button>/);
  expect(html).toMatch(/<button[^>]*disabled[^>]*>修改名称<\/button>/);
  expect(html).toContain('关闭后隐藏，重新开启可恢复展示');
  expect(html).not.toContain('关闭后清除');
  expect(html).not.toContain('刷新运行窗口');
});

it('刷新窗口时保留选择框文字，不立即闪现读取状态', async () => {
  const { html } = await render(null, true, true);
  const select = html.match(/<select id="activity-window"[^>]*>[\s\S]*?<\/select>/)?.[0];
  expect(select).toContain('aria-busy="true"');
  expect(select).toContain('选择正在运行的窗口');
  expect(select).not.toContain('正在读取窗口');
  expect(html).not.toContain('正在读取窗口…');
});
