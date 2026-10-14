import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, nextTick, onScopeDispose, reactive, ref, watch } from 'vue';
import { expect, it, vi } from 'vitest';
import type { StoredEntranceSound } from '../../rtc/entranceSound';

const script = parse(readFileSync(new URL('./SoundSettings.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const sourceFile = ts.createSourceFile('SoundSettings.ts', script, ts.ScriptTarget.Latest, true);
const callbacks = sourceFile.statements.filter((statement) => !ts.isImportDeclaration(statement))
  .map((statement) => statement.getText(sourceFile)).join('\n');
const compiled = ts.transpile(callbacks, { target: ts.ScriptTarget.ES2022 });
const clip: StoredEntranceSound = { name: '测试音效', mimeType: 'audio/wav', dataUrl: 'data:audio/wav;base64,YQ==' };

function setup() {
  const players: FakeAudio[] = [];
  class FakeAudio {
    volume = 1;
    pause = vi.fn();
    reject!: (error: Error) => void;
    play = vi.fn(() => new Promise<void>((_, reject) => { this.reject = reject; }));
    constructor(readonly src: string) { players.push(this); }
  }
  const scope = effectScope();
  const props = reactive({ active: true, userId: 'member' });
  const createEntranceSound = vi.fn(async () => clip);
  const saveEntranceSound = vi.fn(() => true);
  // 挂载真实监听和清理到 Vue scope；播放器仅记录调用，不产生声音或访问设备。
  const settings = scope.run(() => runInNewContext(`${compiled}\n({ playPreview, chooseSound, error, sound })`, {
    ref, computed, watch, onScopeDispose, defineProps: () => props, Audio: FakeAudio, Error,
    createEntranceSound, saveEntranceSound, loadEntranceSound: () => clip,
  })) as { playPreview: () => void; chooseSound: (event: Event) => Promise<void>;
    error: { value: string }; sound: { value: StoredEntranceSound } };
  return { scope, props, players, settings, createEntranceSound, saveEntranceSound };
}

it('新试听停止旧播放器，旧取消不覆盖当前反馈，当前播放失败仍提示', async () => {
  const { scope, players, settings } = setup();
  try {
    settings.playPreview();
    settings.playPreview();
    expect(players[0].pause).toHaveBeenCalledOnce();
    players[0].reject(new Error('old playback cancelled'));
    await Promise.resolve();
    expect(settings.error.value).toBe('');
    players[1].reject(new Error('current playback blocked'));
    await Promise.resolve();
    expect(settings.error.value).toBe('当前系统未允许播放声音');
  } finally { scope.stop(); }
});

it('切出音效栏目停止播放，迟到取消不显示错误，不在隐藏栏目重开试听', async () => {
  const { scope, props, players, settings } = setup();
  try {
    settings.playPreview();
    props.active = false;
    await nextTick();
    expect(players[0].pause).toHaveBeenCalledOnce();
    players[0].reject(new Error('preview stopped'));
    await Promise.resolve();
    settings.playPreview();
    expect(settings.error.value).toBe('');
    expect(players).toHaveLength(1);
  } finally { scope.stop(); }
});

it('销毁设置停止播放器，迟到拒绝不污染反馈', async () => {
  const { scope, players, settings } = setup();
  settings.playPreview();
  scope.stop();
  expect(players[0].pause).toHaveBeenCalledOnce();
  players[0].reject(new Error('settings disposed'));
  await Promise.resolve();
  expect(settings.error.value).toBe('');
});

it('选择新音效前停止旧试听，继续保存所选音效', async () => {
  const { scope, players, settings, saveEntranceSound } = setup();
  try {
    settings.playPreview();
    const input = { value: 'clip.wav', files: [{}] };
    await settings.chooseSound({ target: input } as unknown as Event);
    expect(players[0].pause).toHaveBeenCalledOnce();
    expect(input.value).toBe('');
    expect(saveEntranceSound).toHaveBeenCalledWith('member', clip);
    players[0].reject(new Error('old clip stopped'));
    await Promise.resolve();
    expect(settings.error.value).toBe('');
  } finally { scope.stop(); }
});
