import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import type { Participant } from 'livekit-client';
import { expect, it } from 'vitest';
import ParticipantCard from './ParticipantCard.vue';

function renderCard(isLocal: boolean, recordingElapsed?: string, isListening: boolean | null = true) {
  const participant = { identity: 'member', name: '成员', getTrackPublication: () => undefined,
    isScreenShareEnabled: false, isMicrophoneEnabled: false, isSpeaking: false } as unknown as Participant;
  return renderToString(createSSRApp(ParticipantCard, { participant, revision: 0, isLocal, isListening, recordingElapsed }));
}

it('群友闭麦在画面上显示状态，停止收听优先，未知收听状态不显示耳机', async () => {
  const muted = await renderCard(false, undefined, true);
  expect(muted).toContain('aria-label="麦克风已关闭"');
  expect(muted).toMatch(/<button[^>]*class="[^"]*volume-button[^"]*"[^>]*disabled[^>]*aria-label="成员的语音音量暂不可调"/);
  const deafened = await renderCard(false, undefined, false);
  expect(deafened).toContain('aria-label="已停止接收声音"');
  expect(deafened).not.toContain('aria-label="麦克风已关闭"');
  const unknown = await renderCard(false, undefined, null);
  expect(unknown).toContain('aria-label="麦克风已关闭"');
  expect(unknown).not.toContain('aria-label="已停止接收声音"');
});

it('只有自己的共享卡片显示录制圆点与时长，其他成员和未录制状态不显示', async () => {
  const local = await renderCard(true, '1:02:03');
  expect(local).toContain('class="recording-indicator"');
  expect(local).toContain('aria-label="正在录制 1:02:03"');
  expect(local).toMatch(/<time[^>]*>1:02:03<\/time>/);
  expect(await renderCard(false, '1:02:03')).not.toContain('class="recording-indicator"');
  expect(await renderCard(true)).not.toContain('class="recording-indicator"');
});
