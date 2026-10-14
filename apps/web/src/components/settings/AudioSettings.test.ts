import { createSSRApp, effectScope } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { describe, expect, it } from 'vitest';
import { Track } from 'livekit-client';
import AudioSettings from './AudioSettings.vue';
import { useAudioPreferences } from '../../rtc/useAudioPreferences';
import type { useRtcRoom } from '../../rtc/useRtcRoom';
import type { UnwrapNestedRefs } from 'vue';

async function renderAudioSettings(testState: 'idle' | 'listening' | 'stopping' = 'idle', busy = false) {
  const scope = effectScope();
  const preferences = scope.run(() => useAudioPreferences('test', { getItem: () => null, setItem: () => {} }))!;
  try {
    return await renderToString(createSSRApp(AudioSettings, {
      desktop: true, preferences, active: true, inputLevelPercent: 0,
      rtc: { status: 'idle', room: null, busySources: busy ? [Track.Source.Microphone] : [] } as unknown as
        UnwrapNestedRefs<ReturnType<typeof useRtcRoom>>,
      microphoneTest: { state: testState, notice: '测试错误', inputLevelPercent: 45,
        start: async () => {}, stop: async () => {} },
    }));
  } finally { scope.stop(); }
}

describe('语音设置的本机试听入口', () => {
  it('没有房间也能开始试听，没有旧的先入房提示', async () => {
    const html = await renderAudioSettings();
    expect(html).toMatch(/<button[^>]*class="settings-button"[^>]*>开始试听<\/button>/);
    expect(html.match(/<button[^>]*class="settings-button"[^>]*>/)?.[0]).not.toContain('disabled');
    expect(html).not.toContain('请先加入通话');
    expect(html).toContain('class="inline-feedback"');
    expect(html).toContain('测试错误');
  });

  it('没有房间时显示测试输入等级，停止期间不能重复启动', async () => {
    const listening = await renderAudioSettings('listening');
    expect(listening).toContain('aria-valuenow="45"');
    expect(listening).toContain('停止麦克风试听');
    const stopping = await renderAudioSettings('stopping');
    expect(stopping.match(/<button[^>]*class="settings-button"[^>]*>/)?.[0]).toContain('disabled');
    expect(stopping).toContain('正在停止');
  });

  it('麦克风操作未完成时禁用新的测试启动', async () => {
    const html = await renderAudioSettings('idle', true);
    expect(html.match(/<button[^>]*class="settings-button"[^>]*>/)?.[0]).toContain('disabled');
  });
});
