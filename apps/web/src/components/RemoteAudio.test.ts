import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { effectScope, nextTick, reactive, ref, watch } from 'vue';
import { expect, it, vi } from 'vitest';
import { prepareSharePlayback, setRemotePlaybackVolume } from '../rtc/remotePlaybackVolume';

const script = parse(readFileSync(new URL('./RemoteAudio.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const sourceFile = ts.createSourceFile('RemoteAudio.ts', script, ts.ScriptTarget.Latest, true);
const compiled = ts.transpile(sourceFile.statements.filter((statement) => !ts.isImportDeclaration(statement))
  .map((statement) => statement.getText(sourceFile)).join('\n'), { target: ts.ScriptTarget.ES2022 });

it('共享音轨接入前已经静音，布局变化只调当前节点，重连继承当前音量', async () => {
  const param = { value: 1, setTargetAtTime: vi.fn() };
  const gain = { gain: param, context: { currentTime: 2 }, disconnect: vi.fn() };
  const createGain = vi.fn(() => gain);
  const attachLevels: number[] = [];
  const track = { attach: () => attachLevels.push(param.value), detach: vi.fn(), setWebAudioPlugins: vi.fn(), setVolume: vi.fn() };
  const props = reactive({ track, context: { createGain }, volume: 0, balance: false, sharedAudio: true });
  const scope = effectScope();
  try {
    const element = scope.run(() => runInNewContext(`${compiled}\naudioElement`, {
      ref, watch, prepareSharePlayback, setRemotePlaybackVolume, defineProps: () => props, defineEmits: () => vi.fn(),
    })) as { value: unknown };
    element.value = {}; await nextTick();
    expect(attachLevels).toEqual([0]);
    props.volume = 0.35;
    expect(param.setTargetAtTime).toHaveBeenLastCalledWith(0.35, 2, 0.1);
    expect(createGain).toHaveBeenCalledTimes(1);
    element.value = null; await nextTick();
    expect(track.setWebAudioPlugins).toHaveBeenLastCalledWith([]);
    expect(gain.disconnect).toHaveBeenCalledOnce();
    element.value = {}; await nextTick();
    expect(attachLevels).toEqual([0, 0.35]);
  } finally { scope.stop(); }
});

it('播放组件保持单次挂载，静音同步生效且先分离音轨再释放插件', async () => {
  const order: string[] = [];
  const track = { attach: vi.fn(), detach: vi.fn(() => order.push('detach')), setVolume: vi.fn() };
  const props = reactive({ track, context: {}, volume: 1, balance: true });
  const enabled = vi.fn();
  const audible = vi.fn();
  const dispose = vi.fn(() => order.push('dispose'));
  const scope = effectScope();
  const { audioElement } = scope.run(() => runInNewContext(`${compiled}\n({ audioElement })`, {
    ref, watch, prepareSharePlayback, setRemotePlaybackVolume, defineProps: () => props, defineEmits: () => vi.fn(),
    RemoteVoiceBalance: class { setEnabled = enabled; setAudible = audible; dispose = dispose; },
  })) as { audioElement: { value: unknown } };
  audioElement.value = {};
  await nextTick();
  expect(track.attach).toHaveBeenCalledTimes(1);
  expect(enabled).toHaveBeenLastCalledWith(true);
  props.balance = false;
  await nextTick();
  expect(enabled).toHaveBeenLastCalledWith(false);
  props.volume = 0;
  expect(audible).toHaveBeenLastCalledWith(false);
  expect(track.setVolume).toHaveBeenLastCalledWith(0);
  expect(track.attach).toHaveBeenCalledTimes(1);
  scope.stop();
  expect(order).toEqual(['detach', 'dispose']);
});

it('输出未准备好不挂载声音，切换后可恢复；销毁不挂载迟到的播放器', async () => {
  const track = { attach: vi.fn(), detach: vi.fn(), setVolume: vi.fn() };
  let ready!: () => void;
  const waiting = new Promise<void>((resolve) => { ready = resolve; });
  const available = ref(true);
  const release = vi.fn();
  const output = { available, bindElement: vi.fn(() => ({ ready: waiting, release })) };
  const props = { track, context: null, volume: 1, balance: false, output };
  const scope = effectScope();
  const { audioElement } = scope.run(() => runInNewContext(`${compiled}\n({ audioElement })`, {
    ref, watch, prepareSharePlayback, setRemotePlaybackVolume, defineProps: () => props, defineEmits: () => vi.fn(),
  })) as { audioElement: { value: unknown } };
  audioElement.value = {};
  await nextTick();
  expect(track.attach).not.toHaveBeenCalled();
  ready();
  await Promise.resolve();
  expect(track.attach).toHaveBeenCalledOnce();
  available.value = false;
  await nextTick();
  expect(track.detach).toHaveBeenCalledOnce();
  available.value = true;
  await nextTick();
  await Promise.resolve();
  expect(track.attach).toHaveBeenCalledTimes(2);
  let lateReady!: () => void;
  output.bindElement.mockReturnValueOnce({ ready: new Promise<void>((resolve) => { lateReady = resolve; }), release });
  available.value = false;
  await nextTick();
  available.value = true;
  await nextTick();
  scope.stop();
  lateReady();
  await Promise.resolve();
  expect(track.attach).toHaveBeenCalledTimes(2);
  expect(release).toHaveBeenCalledTimes(3);
});
