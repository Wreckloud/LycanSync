import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import type { SSRContext } from '@vue/server-renderer';
import { describe, expect, it } from 'vitest';
import ScreenSharePicker from './ScreenSharePicker.vue';
import type { NativeScreenAudioMode } from '../rtc/nativeScreenAudioMode';

async function renderPicker(audioMode: NativeScreenAudioMode, audioReady = true, shareAudio = false) {
  const context: SSRContext = {};
  await renderToString(createSSRApp(ScreenSharePicker, {
    sources: [{ id: 'window:1:0', name: '测试窗口', type: 'window' }],
    sourceType: 'window', selectedId: 'window:1:0', quality: 'standard',
    audioMode, audioReady, audioFailed: false, shareAudio,
    loading: false, error: '', notice: '',
  }), context);
  return context.teleports?.body ?? '';
}

describe('共享选择器的声音范围说明', () => {
  it('高级选项默认收起，提供真实采集方式且系统边框许可不默认勾选', async () => {
    const html = await renderPicker('process');
    expect(html.match(/<details[^>]*capture-advanced[^>]*>/)?.[0]).not.toContain('open');
    for (const method of ['auto', 'game', 'bitblt', 'wgc']) expect(html).toContain(`value="${method}"`);
    expect(html).toContain('允许显示系统共享边框（仅本次）');
    const border = html.match(/<input[^>]*>允许显示系统共享边框/);
    expect(border).not.toBeNull();
    expect(border![0]).not.toContain('checked');
  });
  it.each([false, true])('系统混音勾选 %s 时都说明全部声音范围', async (checked) => {
    const html = await renderPicker('systemMix', true, checked);
    expect(html).toContain('共享音频包含全部电脑声音，包括 LycanSync，可能产生回声。');
    expect(html).not.toContain('当前系统仅支持共享画面。');
  });

  it('能力确认不可用时说明仅共享画面，但仍可确认画面来源', async () => {
    const html = await renderPicker('unavailable');
    expect(html).toContain('当前系统仅支持共享画面。');
    expect(html.match(/<input[^>]*aria-label="共享音频"[^>]*>/)?.[0]).toContain('disabled');
    expect(html.match(/<button[^>]*class="confirm-button"[^>]*>/)?.[0]).not.toContain('disabled');
  });

  it('能力未返回前不误报仅支持画面，确认按钮保持禁用', async () => {
    const html = await renderPicker('unavailable', false);
    expect(html).toContain('正在检查共享能力');
    expect(html).not.toContain('当前系统仅支持共享画面。');
    expect(html.match(/<button[^>]*class="confirm-button"[^>]*>/)?.[0]).toContain('disabled');
  });
});
