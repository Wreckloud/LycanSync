import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, nextTick, reactive, shallowReactive, shallowRef, watch } from 'vue';
import type { ScreenShareWindow } from '../viewing/useScreenShareWindows';
import { Track } from 'livekit-client';
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
    useScreenShareLayout: () => ({ mode: 'collapsed', single: null }),
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
