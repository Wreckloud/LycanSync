import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Participant } from 'livekit-client';
import CallControls from './CallControls.vue';
import ParticipantCard from './ParticipantCard.vue';
import VoiceLevelMic from './VoiceLevelMic.vue';

afterEach(() => vi.unstubAllGlobals());

async function renderControls(enabled: boolean, listening: boolean, busy = false, intent = true) {
  vi.stubGlobal('document', { fullscreenEnabled: false });
  const participant = { identity: 'local', name: '自己', isMicrophoneEnabled: true,
    isSpeaking: true, isScreenShareEnabled: false, getTrackPublication: () => undefined } as unknown as Participant;
  const controls = await renderToString(createSSRApp(CallControls, {
    connected: true, desktop: true, microphoneEnabled: enabled, microphoneIntent: intent,
    microphoneBusy: busy, microphoneLevel: 0, inputLevelPercent: 0, listening, inputGain: 1,
    outputVolume: 1, sharing: false, shareBusy: false, choosingSource: false, shareLimitReached: false,
    quality: 'standard', shareAudio: false, audioMode: 'unavailable',
  }));
  const cards = await Promise.all((['card'] as const).map((variant) =>
    renderToString(createSSRApp(ParticipantCard, {
      participant, revision: 0, isLocal: true, isListening: listening,
      localMicrophoneEnabled: enabled, variant,
    }))));
  return { controls, cards };
}

describe('本机麦克风按钮的权威状态', () => {
  it('麦克风图标沿用人声刻度，成员卡单级发言状态保持不变', async () => {
    for (const [level, fill] of [[0, 0], [0.005, 0.25], [0.02, 0.5], [0.05, 0.75], [0.26, 1]]) {
      const html = await renderToString(createSSRApp(VoiceLevelMic, { level, size: 17 }));
      expect(html).toContain(`--voice-level:${fill}`);
    }
    for (const level of [0, 1]) {
      const html = await renderToString(createSSRApp(VoiceLevelMic, { level, steps: 1, size: 14 }));
      expect(html).toContain(`--voice-level:${level}`);
    }
  });

  it('SDK 仍报告开麦时，底栏和成员卡仍一致显示禁发和停止收听', async () => {
    const { controls, cards } = await renderControls(false, false, true);
    expect(controls).toContain('lucide-mic-off');
    expect(controls).toContain('lucide-headphone-off');
    for (const html of cards) {
      expect(html).toContain('lucide-mic-off');
      expect(html).toContain('lucide-headphone-off');
      expect(html).not.toContain('is-speaking');
    }
  });

  it('恢复等待或失败不画成已开麦，确认发布后才同步显示开启', async () => {
    const pending = await renderControls(false, true);
    expect(pending.controls).toContain('lucide-mic-off');
    pending.cards.forEach((html) => expect(html).toContain('lucide-mic-off'));
    const opened = await renderControls(true, true);
    expect(opened.controls).not.toContain('lucide-mic-off');
    opened.cards.forEach((html) => expect(html).not.toContain('lucide-mic-off'));
  });

  it('开麦启动中仍可点击关闭，而停止清理中禁止重复启动', async () => {
    const pending = await renderControls(false, true, true);
    const button = pending.controls.match(/<button[^>]*aria-label="关闭麦克风"[^>]*>/)?.[0];
    expect(button).toBeDefined();
    expect(button).not.toContain('disabled');
    const stopping = await renderControls(false, true, true, false);
    expect(stopping.controls.match(/<button[^>]*aria-label="开启麦克风"[^>]*>/)?.[0]).toContain('disabled');
  });

  it('独立观看不重复提供房间麦克风和收听按钮', async () => {
    const participant = { identity: 'local', name: '自己', isMicrophoneEnabled: true,
      isSpeaking: true, isScreenShareEnabled: false, getTrackPublication: () => undefined } as unknown as Participant;
    const html = await renderToString(createSSRApp(ParticipantCard, {
      participant, revision: 0, isLocal: true, isListening: true, localMicrophoneEnabled: true, variant: 'viewer',
    }));
    expect(html).not.toContain('关闭自己的麦克风');
    expect(html).not.toContain('停止接收所有成员声音');
    expect(html).not.toContain('is-speaking');
  });
});
