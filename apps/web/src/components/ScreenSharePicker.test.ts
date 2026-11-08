import { computed, createSSRApp, ref } from 'vue';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { renderToString } from '@vue/server-renderer';
import { describe, expect, it, vi } from 'vitest';
import ScreenSharePicker from './ScreenSharePicker.vue';
import type { NativeScreenAudioMode } from '../rtc/nativeScreenAudioMode';
import type { ScreenSharePreferences } from '../settings/screenSharePreferences';

async function renderPicker(audioMode: NativeScreenAudioMode, audioReady = true, shareAudio = false,
  followGameAvailable = false) {
  return renderToString(createSSRApp(ScreenSharePicker, {
    sources: [{ id: 'window:1:0', name: '测试窗口', type: 'window' }],
    sourceType: 'window', selectedId: 'window:1:0', quality: 'standard',
    audioMode, audioReady, audioFailed: false, shareAudio,
    loading: false, error: '', notice: '', followGameAvailable,
  }));
}

describe('共享选择器的声音范围说明', () => {
  it('能力检查尚未返回时可先选择窗口，确认共享继续等待检查', async () => {
    const html = await renderPicker('process', false);
    const option = html.match(/<button[^>]*data-source-id="window:1:0"[^>]*>/)?.[0];
    expect(option).toBeDefined();
    expect(option).not.toContain('disabled');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>开始共享/);
  });
  it('仅识别到联盟时展示跟随选项，说明大厅内容范围且默认不勾选', async () => {
    expect(await renderPicker('process')).not.toContain('跟随英雄联盟');
    const html = await renderPicker('process', true, false, true);
    expect(html).toContain('跟随英雄联盟大厅与对局（包括大厅聊天画面）');
    expect(html.match(/<input[^>]*>跟随英雄联盟/)?.[0]).not.toContain('checked');
  });

  it('开始共享只确认本次所选来源，普通窗口允许系统边框，游戏和整屏不扩大范围', () => {
    const script = parse(readFileSync(new URL('./ScreenSharePicker.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
    const source = ts.createSourceFile('Picker.ts', script, ts.ScriptTarget.Latest, true);
    const statement = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'confirm')!;
    const compiled = ts.transpile(statement.getText(source), { target: ts.ScriptTarget.ES2022 });
    const captureSettings = ref<ScreenSharePreferences>({ hideCursor: true, hideBorder: true, windowMethod: 'auto' });
    const emit = vi.fn(), canConfirm = ref(false), followGame = ref(false);
    const props = { sourceType: 'window', followGameAvailable: true };
    const confirm = runInNewContext(compiled + '; confirm', { captureSettings, emit, canConfirm, props, followGame }) as () => void;
    confirm(); expect(emit).not.toHaveBeenCalled();
    canConfirm.value = true; confirm();
    expect(emit).toHaveBeenLastCalledWith('confirm', { hideCursor: true, hideBorder: false, windowMethod: 'auto' });
    followGame.value = true; confirm();
    expect(emit).toHaveBeenLastCalledWith('confirm', { hideCursor: true, hideBorder: false, windowMethod: 'auto', followGame: 'league' });
    captureSettings.value.windowMethod = 'game'; confirm();
    expect(emit).toHaveBeenLastCalledWith('confirm', { hideCursor: true, hideBorder: true, windowMethod: 'game' });
    props.sourceType = 'screen'; confirm();
    expect(emit).toHaveBeenLastCalledWith('confirm', { hideCursor: true, hideBorder: true, windowMethod: 'auto' });
  });
  it('边框说明在开始前可见，不再先失败后要求重新授权，也不提供重复方式', async () => {
    const html = await renderPicker('process');
    expect(html).toContain('系统边框');
    expect(html).toContain('共享此窗口时');
    expect(html).toContain('开始共享');
    expect(html).not.toContain('允许边框并共享');
    expect(html).not.toContain('允许显示系统共享边框');
    expect(html).not.toContain('value="wgc"');
    expect(html).not.toContain('value="bitblt"');
    expect(html).toMatch(/aria-expanded="false"[^>]*>[^]*?高级选项/);
    for (const method of ['auto', 'game']) expect(html).toContain('value="' + method + '"');
  });
  it('已知不支持隐藏边框时明确说明，未知或可能支持时不承诺无框', () => {
    const script = parse(readFileSync(new URL('./ScreenSharePicker.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
    const source = ts.createSourceFile('Picker.ts', script, ts.ScriptTarget.Latest, true);
    const statement = source.statements.find(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === 'borderNotice'))!;
    const compiled = ts.transpile(statement.getText(source), { target: ts.ScriptTarget.ES2022 });
    const props = { sourceType: 'window' }, captureSettings = ref({ windowMethod: 'auto' }), borderSupport = ref<boolean>();
    const notice = runInNewContext(compiled + '; borderNotice', { computed, props, captureSettings, borderSupport }) as { value: string };
    expect(notice.value).toContain('仍可能显示');
    borderSupport.value = false; expect(notice.value).toContain('会显示系统边框');
    borderSupport.value = true; expect(notice.value).toContain('仍可能显示');
    captureSettings.value.windowMethod = 'game'; expect(notice.value).toBe('');
    props.sourceType = 'screen'; expect(notice.value).toBe('');
  });
  it.each([false, true])('系统混音勾选 %s 时都说明全部声音范围', async (checked) => {
    const html = await renderPicker('systemMix', true, checked);
    expect(html).toContain('将共享全部电脑声音，包括 lycanclaw 的声音，可能产生回声。');
    expect(html).not.toContain('当前系统仅支持共享画面。');
  });

  it('系统混音和边框说明分别可见，边框不进入会滚动的反馈槽', async () => {
    const html = await renderPicker('systemMix', true, true);
    expect(html).toMatch(/<p class="capture-border-notice"[^>]*>[^<]*系统边框[^<]*<\/p>/);
    const footer = html.slice(html.indexOf('<footer'));
    const feedback = footer.slice(footer.indexOf('class="inline-feedback'), footer.indexOf('class="capture-confirm'));
    expect(feedback).toContain('全部电脑声音');
    expect(feedback).not.toContain('系统边框');
  });

  it('能力确认不可用时说明仅共享画面，但仍可确认画面来源', async () => {
    const html = await renderPicker('unavailable');
    expect(html).toContain('当前系统仅支持共享画面。');
    expect(html.match(/<input[^>]*aria-label="共享音频"[^>]*>/)?.[0]).toContain('disabled');
    expect(html.match(/<button[^>]*class="confirm-button"[^>]*>/)?.[0]).not.toContain('disabled');
  });

  it('能力未返回前不误报仅支持画面，确认按钮保持禁用', async () => {
    const html = await renderPicker('unavailable', false);
    expect(html).not.toContain('正在检查共享能力');
    expect(html).not.toContain('当前系统仅支持共享画面。');
    expect(html.match(/<button[^>]*class="confirm-button"[^>]*>/)?.[0]).toContain('disabled');
  });
});
