import { createSSRApp, effectScope } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { describe, expect, it } from 'vitest';
import { Track } from 'livekit-client';
import AudioSettings from './AudioSettings.vue';
import { useAudioPreferences } from '../../rtc/useAudioPreferences';
import type { AudioProcessingSettings } from '../../rtc/audioPreferences';

async function renderAudioSettings(testState: 'idle' | 'listening' | 'stopping' = 'idle', busy = false,
  desktop = true, stored: Partial<AudioProcessingSettings> = {}) {
  const scope = effectScope();
  const preferences = scope.run(() => useAudioPreferences('test', { getItem: () => JSON.stringify(stored), setItem: () => {} }))!;
  try {
    return await renderToString(createSSRApp(AudioSettings, {
      desktop, preferences, active: true, inputLevelPercent: 0,
      rtc: { status: 'idle', busySources: busy ? [Track.Source.Microphone] : [],
        setMicrophoneProcessing: async () => {}, setMicrophoneInputGain: () => {} } satisfies InstanceType<typeof AudioSettings>['$props']['rtc'],
      audioOutput: { devices: { value: [] }, notice: { value: '' }, available: { value: true }, changing: { value: false }, supported: true, refresh: async () => {}, select: async () => {} },
      microphoneDevices: { devices: [], notice: '', changing: false, loading: false, refresh: async () => {}, select: async () => {} },
      microphoneTest: { state: testState, notice: '测试错误', inputLevelPercent: 45,
        start: async () => {}, stop: async () => {} },
    }));
  } finally { scope.stop(); }
}

describe('语音设置的本机试听入口', () => {
  it('统一处理开关按平台展示支持范围，试听排在处理之前', async () => {
    const desktop = await renderAudioSettings();
    expect(desktop).toMatch(/aria-label="智能声音处理"[^>]*checked[^>]*aria-checked="true"/);
    expect(desktop).not.toContain('桌面版暂不支持回声消除');
    expect(desktop).not.toMatch(/<strong[^>]*>自动增益<\/strong>/);
    expect([...desktop.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map(match => match[1]))
      .toEqual(['输入', '麦克风试听', '声音处理', '输出']);
    const browser = await renderAudioSettings('idle', false, false);
    expect(browser).toContain('同时使用浏览器的回声消除');
    expect(browser).not.toContain('桌面版暂不支持');
  });

  it('旧的混合选择明确显示部分开启，不因打开设置覆盖用户偏好', async () => {
    const partial = await renderAudioSettings('idle', false, true, { noiseSuppression: false });
    expect(partial).toContain('aria-checked="mixed"');
    expect(partial).toContain('仍在使用你之前的处理设置');
    const desktop = await renderAudioSettings('idle', false, true, { echoCancellation: false });
    expect(desktop).toContain('aria-checked="mixed"');
    const browser = await renderAudioSettings('idle', false, false, { echoCancellation: false });
    expect(browser).toContain('aria-checked="mixed"');
  });

  it('没有房间也能开始试听，没有旧的先入房提示', async () => {
    const html = await renderAudioSettings();
    expect(html).toMatch(/<button[^>]*class="settings-button(?: [^"]+)?"[^>]*>开始试听<\/button>/);
    expect([...html.matchAll(/<button[^>]*class="settings-button(?: [^"]+)?"[^>]*>/g)].at(-1)?.[0]).not.toContain('disabled');
    expect(html).not.toContain('请先加入通话');
    expect(html).toContain('class="inline-feedback"');
    expect(html).toContain('测试错误');
    expect(html).toContain('平衡成员语音音量');
    expect(html).toContain('不影响共享声音');
  });

  it('没有房间时显示测试输入等级，停止期间不能重复启动', async () => {
    const listening = await renderAudioSettings('listening');
    expect(listening).toContain('aria-valuenow="45"');
    expect(listening).toContain('停止麦克风试听');
    const stopping = await renderAudioSettings('stopping');
    expect([...stopping.matchAll(/<button[^>]*class="settings-button(?: [^"]+)?"[^>]*>/g)].at(-1)?.[0]).toContain('disabled');
    expect(stopping).toContain('停止麦克风试听');
    expect(stopping).not.toContain('正在停止');
  });

  it('麦克风操作未完成时禁用新的测试启动', async () => {
    const html = await renderAudioSettings('idle', true);
    expect([...html.matchAll(/<button[^>]*class="settings-button(?: [^"]+)?"[^>]*>/g)].at(-1)?.[0]).toContain('disabled');
  });
});
