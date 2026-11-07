import { computed, createSSRApp, effectScope, nextTick, reactive, ref, watch } from 'vue';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { renderToString } from '@vue/server-renderer';
import { describe, expect, it, vi } from 'vitest';
import PersonalStatusCard from './PersonalStatusCard.vue';
import type { AuthUser } from '../auth/authApi';

const user = { id: 'self', nickname: '本人', avatar: '' } as AuthUser;
const script = parse(readFileSync(new URL('./PersonalStatusCard.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;

it('按住当前状态向下滑动，只在释放时切换；移出菜单或取消不提交', () => {
  const scope = effectScope();
  const emit = vi.fn();
  const props = reactive({ presenceMode: 'online', presenceReady: true });
  const state = scope.run(() => runInNewContext(`${ts.transpile(script.replace(/^import .*;\r?\n/gm, ''))}\n({ presenceMenu, beginPresence, movePresence, finishPresence, closePresence, presenceOpen })`, {
    computed, nextTick, ref, watch, defineProps: () => props, defineEmits: () => emit, defineModel: () => ref(true),
    useOwnVoiceTime: () => ({}),
  })) as { presenceMenu: { value: unknown }; presenceOpen: { value: boolean }; beginPresence(event: unknown): void;
    movePresence(event: unknown): void; finishPresence(event: unknown): void; closePresence(): void };
  const capture = vi.fn();
  const event = (y: number, x = 20) => ({ button: 0, pointerId: 1, clientX: x, clientY: y,
    preventDefault: vi.fn(), currentTarget: { setPointerCapture: capture } });
  state.presenceMenu.value = { querySelectorAll: () => ['online', 'invisible'].map((mode, index) => ({
    dataset: { presenceMode: mode }, getBoundingClientRect: () => ({ left: 0, right: 88, top: index * 32, bottom: (index + 1) * 32 }),
  })) };
  try {
    state.beginPresence(event(16));
    state.movePresence(event(48));
    expect(emit).not.toHaveBeenCalled();
    state.finishPresence(event(48));
    expect(emit).toHaveBeenCalledExactlyOnceWith('presenceMode', 'invisible');
    expect(state.presenceOpen.value).toBe(false);
    emit.mockClear();
    state.beginPresence(event(16));
    state.finishPresence(event(80, 200));
    expect(emit).not.toHaveBeenCalled();
    state.beginPresence(event(16));
    state.closePresence();
    state.finishPresence(event(48));
    expect(emit).not.toHaveBeenCalled();
    props.presenceReady = false;
    state.beginPresence(event(16));
    expect(state.presenceOpen.value).toBe(false);
  } finally { scope.stop(); }
});

describe('底部个人名片', () => {
  it('无公开动态时保留在线状态，动态存在时与成员列表使用相同文字', async () => {
    const idle = await renderToString(createSSRApp(PersonalStatusCard, { user, status: 'ONLINE', statusLabel: '在线' }));
    expect(idle).toContain('在线');
    expect(idle).not.toContain('member-activity');
    const active = await renderToString(createSSRApp(PersonalStatusCard, { user, status: 'ONLINE', statusLabel: '在线',
      activityStatus: { type: 'GAME', text: '正在玩 游戏', startedAt: '2026-10-15T00:00:00Z' } }));
    expect(active).toContain('正在玩 游戏');
    expect(active).not.toContain('1:00');
    const statusClasses = active.match(/class="([^"]*\bstatus-dot\b[^"]*)"/)?.[1].split(' ');
    expect(statusClasses).toEqual(expect.arrayContaining(['status-dot', 'ONLINE']));
    expect(active).toContain('member-activity');
  });
});
