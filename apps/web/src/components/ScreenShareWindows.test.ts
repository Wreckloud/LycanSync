import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, nextTick, reactive, shallowReactive, shallowRef, watch } from 'vue';
import type { ScreenShareWindow } from '../viewing/useScreenShareWindows';
import { Track } from 'livekit-client';
import { EventEmitter } from 'node:events';
import { useScreenShareLayout } from '../viewing/useScreenShareLayout';
import type { Participant, Room } from 'livekit-client';
import { expect, it, vi } from 'vitest';

const script = parse(readFileSync(new URL('./ScreenShareWindows.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const source = ts.createSourceFile('ScreenShareWindows.ts', script, ts.ScriptTarget.Latest, true);
const callbacks = source.statements.filter(statement => !ts.isImportDeclaration(statement))
  .map(statement => statement.getText(source)).join('\n');
const compiled = ts.transpile(callbacks, { target: ts.ScriptTarget.ES2022 });

it('实际授权视频到达才打开控制窗；旧窗关闭和旧界面版本不能退出新会话', async () => {
  const publication = { trackSid: 'old-video' };
  const rtc = shallowReactive({ remoteControlActive: null as null | {
    identity: string; shareSessionId: string; controlSessionId: string; trackSid: string;
  }, revision: 0, participants: [{ identity: 'target', getTrackPublication: () => publication }],
  remoteControlPending: null as null | { identity: string },
  exitRemoteControl: vi.fn(), cancelPendingRemoteControl: vi.fn(),
  });
  const open = vi.fn(() => true);
  let closed!: (entry: ScreenShareWindow) => void;
  const scope = effectScope();
  scope.run(() => runInNewContext(compiled, {
    defineProps: () => ({ rtc }), defineEmits: () => vi.fn(), defineExpose: () => {},
    computed, watch, Track, reactive,
    useScreenShareLayout: () => ({ mode: 'collapsed', collapse: vi.fn() }),
    useScreenShareWindows: (options: { closed: typeof closed }) => {
      closed = options.closed;
      return { entries: shallowRef([]), openControl: open, openWatching: vi.fn(), closeControl: vi.fn(), closeAll: vi.fn(), disarmAll: vi.fn() };
    },
  }));
  try {
    rtc.remoteControlActive = { identity: 'target', shareSessionId: 'control-share', controlSessionId: 'control', trackSid: 'new-video' };
    await nextTick();
    expect(open).not.toHaveBeenCalled();
    publication.trackSid = 'new-video'; rtc.revision++;
    await nextTick();
    expect(open).toHaveBeenCalledExactlyOnceWith('target');
    rtc.revision++; await nextTick();
    expect(open).toHaveBeenCalledOnce();
    const old = { kind: 'control', participant: { identity: 'target' }, shareSessionId: 'old-share', controlSessionId: 'old-control' } as ScreenShareWindow;
    closed(old);
    closed({ ...old, shareSessionId: 'control-share' } as ScreenShareWindow);
    expect(rtc.exitRemoteControl).not.toHaveBeenCalled();
    closed({ ...old, shareSessionId: 'control-share', controlSessionId: 'control' } as ScreenShareWindow);
    expect(rtc.exitRemoteControl).toHaveBeenCalledOnce();
    rtc.remoteControlPending = { identity: 'target' };
    closed(old);
    closed({ kind: 'watching' } as ScreenShareWindow);
    expect(rtc.cancelPendingRemoteControl).not.toHaveBeenCalled();
    expect(rtc.exitRemoteControl).toHaveBeenCalledOnce();
  } finally { scope.stop(); }
});

function watchingFixture() {
  const entries = shallowRef<ScreenShareWindow[]>([]);
  const room = new EventEmitter() as unknown as Room;
  const rtc = shallowReactive({ room, status: 'connected', revision: 0,
    participants: ['A', 'B'].map(identity => ({ identity, isScreenShareEnabled: true,
      getTrackPublication: () => ({ trackSid: identity }) }) as unknown as Participant),
    remoteControlShares: {}, remoteControlActive: null,
  });
  let closed!: (entry: ScreenShareWindow) => void;
  const closeWatching = () => {
    for (const entry of entries.value) {
      entries.value = entries.value.filter(current => current !== entry);
      closed(entry);
    }
  };
  let nextId = 0;
  const openWatching = vi.fn(() => {
    if (!entries.value.length) entries.value = [{ kind: 'watching', room: rtc.room, id: String(++nextId),
      target: null } as ScreenShareWindow];
    return true;
  });
  const scope = effectScope();
  const api = scope.run(() => runInNewContext(`${compiled}\n({ view, select, detachWatching, returnWatching, closeAll })`, {
    defineProps: () => ({ rtc, controlPlaceholder: () => '' }), defineEmits: () => vi.fn(), defineExpose: () => {},
    computed, watch, Track, reactive, useScreenShareLayout,
    useScreenShareWindows: (options: { closed: typeof closed }) => {
      closed = options.closed;
      return { entries, openWatching, closeWatching, openControl: vi.fn(), closeControl: vi.fn(),
        closeAll: closeWatching, disarmAll: vi.fn() };
    },
  })) as { view: { mode: string; focused: number | null; membersVisible: boolean; height: number | null; expanded: boolean;
    select(identity: string): boolean; grid(): void; reset(): void };
    select(identity: string): boolean; detachWatching(): void; returnWatching(): void; closeAll(): void };
  return { scope, rtc, entries, closeWatching, openWatching, ...api };
}

it('主窗口点击只唤起已有观看窗；关闭恢复弹出前的聚焦、折叠、高度和占满状态', () => {
  const f = watchingFixture();
  try {
    f.select('A');
    const focused = f.view.focused;
    f.view.membersVisible = false; f.view.height = 240; f.view.expanded = true;
    f.detachWatching();
    expect(f.view.expanded).toBe(false);
    f.select('A'); f.select('B');
    expect(f.entries.value).toHaveLength(1);
    expect(f.openWatching).toHaveBeenCalledTimes(3);
    expect(f.view.focused).toBe(focused);
    f.view.select('B'); f.view.grid(); f.view.membersVisible = true; f.view.height = 300;
    f.closeWatching();
    expect(f.view.mode).toBe('focus');
    expect(f.view.focused).toBe(focused);
    expect(f.view.membersVisible).toBe(false);
    expect(f.view.height).toBe(240);
    expect(f.view.expanded).toBe(true);
  } finally { f.scope.stop(); }
});

it('主动返回沿用观看窗当前布局，离房关闭和已失效的原画面不恢复旧观看', () => {
  const f = watchingFixture();
  try {
    f.select('A'); f.detachWatching(); f.view.select('B');
    const current = f.view.focused;
    f.returnWatching();
    expect(f.view.focused).toBe(current);
    f.detachWatching();
    f.rtc.participants = f.rtc.participants.slice(0, 1); f.rtc.revision++;
    expect(f.view.mode).toBe('collapsed');
    f.select('A'); f.detachWatching();
    f.rtc.room = new EventEmitter() as unknown as Room;
    f.closeWatching();
    expect(f.view.mode).toBe('collapsed');
  } finally { f.scope.stop(); }
});
