import { createSSRApp, ref } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { expect, it, vi } from 'vitest';
import ActivitySettings from './ActivitySettings.vue';
import type { UserActivity } from '../../presence/presenceApi';

async function render(activity: UserActivity | null, desktop = true) {
  const mappings = { entries: ref([{ executable: 'c:\\game.exe', name: '固定游戏名' }]),
    windows: ref([{ executable: 'c:\\game.exe', title: '当前窗口' }]), busy: ref(false),
    loading: ref(false), ready: ref(true), error: ref(''), windowError: ref(''),
    initialize: vi.fn(async () => {}), refreshWindows: vi.fn(async () => {}),
    save: vi.fn(async () => true), remove: vi.fn(async () => true) };
  const html = await renderToString(createSSRApp(ActivitySettings, {
    active: false, activity, desktop, showActivity: true, error: '', mappings,
  }));
  return { html, mappings };
}

it('游戏与音乐共用唯一展示开关，提供窗口选择和已有条目编辑，不提供自由新增', async () => {
  const { html, mappings } = await render({ type: 'MUSIC', name: '歌曲' });
  expect(html).toContain('正在听');
  expect(html).toContain('歌曲');
  expect(html).toContain('选择正在运行的窗口');
  expect(html).toContain('编辑动态名称 固定游戏名');
  expect(html).toContain('移除动态名称 固定游戏名');
  expect(html.match(/type="checkbox"/g)).toHaveLength(1);
  expect(html).not.toContain('手动输入并回车');
  expect(mappings.refreshWindows).not.toHaveBeenCalled();
  expect((await render({ type: 'GAME', name: '游戏' })).html).toContain('正在玩');
});

it('浏览器不展示系统窗口入口，未检测到动态不误报正在玩', async () => {
  const { html } = await render(null, false);
  expect(html).toContain('动态检测仅在 Windows 桌面版提供');
  expect(html).not.toContain('activity-window');
  expect(html).not.toContain('正在玩');
  expect(html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0]).toContain('disabled');
});
