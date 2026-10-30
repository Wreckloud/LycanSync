import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import type { Participant } from 'livekit-client';
import { expect, it } from 'vitest';
import ParticipantCard from './ParticipantCard.vue';

function renderCard(isLocal: boolean, recordingElapsed?: string) {
  const participant = { identity: 'member', name: '成员', getTrackPublication: () => undefined,
    isScreenShareEnabled: false, isMicrophoneEnabled: false, isSpeaking: false } as unknown as Participant;
  return renderToString(createSSRApp(ParticipantCard, { participant, revision: 0, isLocal, isListening: true, recordingElapsed }));
}

it('只有自己的共享卡片显示录制圆点与时长，其他成员和未录制状态不显示', async () => {
  const local = await renderCard(true, '1:02:03');
  expect(local).toContain('class="recording-indicator"');
  expect(local).toContain('aria-label="正在录制 1:02:03"');
  expect(local).toMatch(/<time[^>]*>1:02:03<\/time>/);
  expect(await renderCard(false, '1:02:03')).not.toContain('class="recording-indicator"');
  expect(await renderCard(true)).not.toContain('class="recording-indicator"');
});
