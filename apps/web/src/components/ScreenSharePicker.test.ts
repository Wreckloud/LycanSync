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
  settingsFailure?: { sourceId: string; code: string }, followGameAvailable = false) {
  return renderToString(createSSRApp(ScreenSharePicker, {
    sources: [{ id: 'window:1:0', name: '测试窗口', type: 'window' }],
    sourceType: 'window', selectedId: 'window:1:0', quality: 'standard',
    audioMode, audioReady, audioFailed: false, shareAudio,
    loading: false, error: '', notice: '', settingsFailure, followGameAvailable,
  }));
}

describe('共享选择器的声音范围说明', () => {
  it('仅识别到联盟时展示跟随选项，说明大厅内容范围且默认不勾选', async () => {
    expect(await renderPicker('process')).not.toContain('跟随英雄联盟');
    const html = await renderPicker('process', true, false, undefined, true);
    expect(html).toContain('跟随英雄联盟大厅与对局（包括大厅聊天画面）');
    expect(html.match(/<input[^>]*>跟随英雄联盟/)?.[0]).not.toContain('checked');
  });

  it('只有明确确认同一窗口后才允许边框，改用兼容采集和取消不改变授权', () => {
    const script = parse(readFileSync(new URL('./ScreenSharePicker.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
    const source = ts.createSourceFile('Picker.ts', script, ts.ScriptTarget.Latest, true);
    const statements = source.statements.filter(statement =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'confirm'
      || ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration =>
        ts.isIdentifier(declaration.name) && declaration.name.text === 'needsBorderPermission'));
    const compiled = ts.transpile(statements.map(statement => statement.getText(source)).join('\n'), { target: ts.ScriptTarget.ES2022 });
    const captureSettings = ref<ScreenSharePreferences>({ hideCursor: true, hideBorder: true, windowMethod: 'auto' });
    const emit = vi.fn();
    const canConfirm = ref(true);
    const props = { sourceType: 'window', selectedId: 'window:1', followGameAvailable: true,
      settingsFailure: { sourceId: 'window:1', code: 'captureBorderUnsupported' } };
    const followGame = ref(false);
    const confirm = runInNewContext(`${compiled}; confirm`, { computed, captureSettings, emit, canConfirm, props, followGame }) as () => void;
    expect(captureSettings.value.hideBorder).toBe(true);
    expect(emit).not.toHaveBeenCalled();
    canConfirm.value = false;
    confirm();
    expect(emit).not.toHaveBeenCalled();
    expect(captureSettings.value.hideBorder).toBe(true);
    canConfirm.value = true;
    confirm();
    expect(emit).toHaveBeenLastCalledWith('confirm', { hideCursor: true, hideBorder: false, windowMethod: 'auto' });
    followGame.value = true;
    confirm();
    expect(emit).toHaveBeenLastCalledWith('confirm', { hideCursor: true, hideBorder: false, windowMethod: 'auto', followGame: 'league' });
    captureSettings.value = { hideCursor: true, hideBorder: true, windowMethod: 'bitblt' };
    confirm();
    expect(emit).toHaveBeenLastCalledWith('confirm', { hideCursor: true, hideBorder: true, windowMethod: 'bitblt' });
  });
  it.each(['captureBorderUnsupported', 'captureBorderAccessDenied'])('同一窗口的 %s 显示明确的本次带框确认', async (code) => {
    const html = await renderPicker('process', true, false, { sourceId: 'window:1:0', code });
    expect(html).toContain('允许边框并共享');
    expect(html).toContain('或在高级选项中选择兼容采集');
    expect(html.match(/<input[^>]*>允许显示系统共享边框/)![0]).not.toContain('checked');
  });
  it('旧窗口失败不能使另一窗口的开始按钮变成带框授权', async () => {
    const html = await renderPicker('process', true, false, { sourceId: 'window:old', code: 'captureBorderUnsupported' });
    expect(html).not.toContain('允许边框并共享');
    expect(html).toContain('开始共享');
  });
  it('高级选项默认收起，提供真实采集方式且系统边框许可不默认勾选', async () => {
    const html = await renderPicker('process');
    expect(html).toMatch(/aria-expanded="false"[^>]*>[^]*?高级选项/);
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
