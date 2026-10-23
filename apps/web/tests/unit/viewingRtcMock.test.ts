import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as vue from 'vue';
import { describe, expect, it, vi } from 'vitest';
import type { useRtcRoom } from '../../src/rtc/useRtcRoom';

function viewingRtc() {
  const source = ts.createSourceFile('viewing.spec.ts', readFileSync(new URL('../viewing.spec.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true);
  let fixture: ts.TemplateExpression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isTemplateExpression(node) && node.head.text.includes('import { ref, shallowRef, markRaw }')) fixture = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!fixture) throw new Error('观看 RTC 模拟不存在');
  const body = fixture.head.text + fixture.templateSpans.map((span, index) =>
    JSON.stringify(index === 0 ? 'vue' : 'livekit-client') + span.literal.text).join('');
  // 检查真实观看模拟的状态动作，但只提供内存中的画面对象，不启动浏览器或 captureStream。
  const video = { clone: () => video, stop: vi.fn() };
  const stream = { getVideoTracks: () => [video], getTracks: () => [video] };
  class VideoTrack { stop = vi.fn(); }
  class Publication { setTrack() {} on() {} }
  const sdk = { LocalVideoTrack: VideoTrack, RemoteVideoTrack: VideoTrack, RemoteTrackPublication: Publication,
    Track: { Kind: { Video: 'video' }, Source: { Microphone: 'microphone' } }, TrackEvent: { UpdateSettings: 'settings' }, RoomEvent: { Reconnected: 'reconnected', ParticipantDisconnected: 'participantDisconnected' } };
  const exports = {} as { useRtcRoom: typeof useRtcRoom };
  runInNewContext(ts.transpile(body, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }), {
    exports, require: (name: string) => name === 'vue' ? vue : sdk,
    window: { addEventListener: vi.fn() },
    document: { createElement: () => ({ getContext: () => ({ fillRect: vi.fn() }), captureStream: () => stream }) },
  });
  return exports.useRtcRoom();
}

describe('观看 RTC 模拟与当前调用方一致', () => {
  it('初值、入房和离房状态明确，允许播放入口存在', async () => {
    const rtc = viewingRtc();
    expect(rtc.listening.value).toBe(true);
    expect(rtc.microphoneIntent.value).toBe(false);
    expect(rtc.microphoneEnabled.value).toBe(false);
    expect(await rtc.join('viewing')).toBe(true);
    expect(rtc.microphoneIntent.value).toBe(true);
    expect(rtc.microphoneEnabled.value).toBe(true);
    await rtc.enableAudioPlayback();
    await rtc.leave();
    expect(rtc.microphoneIntent.value).toBe(false);
    expect(rtc.microphoneEnabled.value).toBe(false);
    expect(rtc.room.value).toBeNull();
  });

  it.each([true, false])('停听后恢复只沿用模拟用户的开麦意愿 %s', async (intent) => {
    const rtc = viewingRtc();
    await rtc.join('viewing');
    if (!intent) await rtc.toggleMedia('microphone' as Parameters<typeof rtc.toggleMedia>[0]);
    await rtc.updateListeningState(false);
    expect(rtc.listening.value).toBe(false);
    expect(rtc.microphoneEnabled.value).toBe(false);
    expect(rtc.microphoneIntent.value).toBe(intent);
    await rtc.updateListeningState(true);
    expect(rtc.microphoneEnabled.value).toBe(intent);
    expect(rtc.room.value?.localParticipant.isMicrophoneEnabled).toBe(intent);
  });
});
