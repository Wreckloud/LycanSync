import { effectScope, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { useCallSounds } from './useCallSounds';
import { useCallSoundPreferences } from '../settings/useCallSoundPreferences';

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const nodes: Array<{ stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  const context = { state: 'running', currentTime: 0, destination: {}, resume: vi.fn(async () => {}), close: vi.fn(async () => {}),
    decodeAudioData: vi.fn(async () => ({ duration: 1 })),
    createGain: vi.fn(() => ({ gain: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect() { return this; }, disconnect: vi.fn() })),
    createOscillator: vi.fn(() => node()), createBufferSource: vi.fn(() => node()) };
  function node() {
    const source = { frequency: { setValueAtTime: vi.fn() }, type: '', buffer: null, onended: null,
      connect() { return context.createGain(); }, start: vi.fn(), stop: vi.fn(), disconnect: vi.fn() };
    nodes.push(source);
    return source;
  }
  const constructor = vi.fn(function () { return context; });
  vi.stubGlobal('AudioContext', constructor);
  const scope = effectScope();
  const output = ref(1);
  const preferences = useCallSoundPreferences('self', { getItem: () => null, setItem: vi.fn() });
  const sounds = scope.run(() => useCallSounds(output, preferences))!;
  return { scope, output, preferences, sounds, context, nodes, constructor };
}

it('关闭事件和总提示音静音时不创建播放器，不改变总输出音量', async () => {
  const f = fixture();
  f.preferences.setEnabled('microphoneOff', false);
  await f.sounds.microphoneChanged(false);
  expect(f.constructor).not.toHaveBeenCalled();
  f.preferences.setVolume(0);
  await f.sounds.joined();
  expect(f.constructor).not.toHaveBeenCalled();
  expect(f.output.value).toBe(1);
  f.scope.stop();
});

it('关闭自定义入场使用默认提示；关闭成员加入后不解码或播放', async () => {
  const f = fixture();
  f.preferences.setCustomEntrances(false);
  await f.sounds.participantEntranceSound('friend', new Uint8Array([1]));
  await Promise.resolve();
  expect(f.context.decodeAudioData).not.toHaveBeenCalled();
  expect(f.context.createOscillator).toHaveBeenCalledTimes(2);
  f.preferences.setEnabled('participantJoined', false);
  await f.sounds.participantEntranceSound('other', new Uint8Array([1]));
  expect(f.context.createOscillator).toHaveBeenCalledTimes(2);
  f.scope.stop();
  expect(f.context.close).toHaveBeenCalledOnce();
});

it('关闭试听会停止所有试听节点，迟到的恢复不能在退出栏目后播放', async () => {
  const f = fixture();
  await f.sounds.preview('joined');
  f.sounds.stopPreview();
  expect(f.nodes.every(node => node.stop.mock.calls.length >= 2 && node.disconnect.mock.calls.length >= 1)).toBe(true);
  f.context.state = 'suspended';
  let resume!: () => void;
  f.context.resume.mockImplementationOnce(() => new Promise<void>(resolve => { resume = resolve; }));
  const playing = f.sounds.preview('microphoneOn');
  f.sounds.stopPreview();
  resume();
  expect(await playing).toBe(false);
  expect(f.nodes).toHaveLength(2);
  f.scope.stop();
});
