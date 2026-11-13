import { effectScope, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { useCallSounds } from './useCallSounds';
import { useCallSoundPreferences } from '../settings/useCallSoundPreferences';

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const nodes: Array<{ stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  const context = { state: 'running', currentTime: 0, destination: {}, resume: vi.fn(async () => {}), close: vi.fn(async () => {}),
    decodeAudioData: vi.fn(async (_bytes: ArrayBuffer) => ({ duration: 1, numberOfChannels: 1,
      getChannelData: () => new Float32Array([0, 0.2, -0.1, 0.1]) })),
    createGain: vi.fn(() => ({ gain: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect() { return this; }, disconnect: vi.fn() })),
    createBufferSource: vi.fn(() => node()) };
  function node() {
    const source = { frequency: { setValueAtTime: vi.fn() }, type: '', buffer: null, onended: null,
      connect() { return context.createGain(); }, start: vi.fn(), stop: vi.fn(), disconnect: vi.fn() };
    nodes.push(source);
    return source;
  }
  const constructor = vi.fn(function () { return context; });
  vi.stubGlobal('AudioContext', constructor);
  const fetchAudio = vi.fn(async (_url: string, _options?: RequestInit) => ({ ok: true, status: 200,
    arrayBuffer: async () => new ArrayBuffer(8) }));
  vi.stubGlobal('fetch', fetchAudio);
  const scope = effectScope();
  const output = ref(1);
  const preferences = useCallSoundPreferences('self', { getItem: () => null, setItem: vi.fn() });
  const sounds = scope.run(() => useCallSounds(output, preferences))!;
  return { scope, output, preferences, sounds, context, nodes, constructor, fetchAudio };
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
  expect(f.fetchAudio).toHaveBeenCalledWith('/sounds/material/navigation_forward-selection.ogg', expect.anything());
  expect(f.context.decodeAudioData).toHaveBeenCalledOnce();
  expect(f.context.createBufferSource).toHaveBeenCalledOnce();
  f.preferences.setEnabled('participantJoined', false);
  await f.sounds.participantEntranceSound('other', new Uint8Array([1]));
  expect(f.context.createBufferSource).toHaveBeenCalledOnce();
  f.scope.stop();
  expect(f.context.close).toHaveBeenCalledOnce();
});

it('关闭试听会停止所有试听节点，迟到的恢复不能在退出栏目后播放', async () => {
  const f = fixture();
  await f.sounds.preview('joined');
  f.sounds.stopPreview();
  expect(f.nodes.every(node => node.stop.mock.calls.length === 1 && node.disconnect.mock.calls.length >= 1)).toBe(true);
  f.context.state = 'suspended';
  let resume!: () => void;
  f.context.resume.mockImplementationOnce(() => new Promise<void>(resolve => { resume = resolve; }));
  const playing = f.sounds.preview('microphoneOn');
  f.sounds.stopPreview();
  resume();
  expect(await playing).toBe(false);
  expect(f.nodes).toHaveLength(1);
  f.scope.stop();
});

it('默认音效复用解码，录制与共享按最终确认的素材播放', async () => {
  const f = fixture();
  try {
    await f.sounds.joined();
    await f.sounds.participantEntranceSound('friend', new Uint8Array([1]));
    // 自定义音效不占用默认素材缓存。
    f.preferences.setCustomEntrances(false);
    await f.sounds.participantEntranceSound('other', new Uint8Array([1]));
    expect(f.fetchAudio).toHaveBeenCalledOnce();
    await f.sounds.screenShareStarted(); await f.sounds.screenShareStopped();
    await f.sounds.recordingStarted(); await f.sounds.recordingStopped();
    expect(f.fetchAudio.mock.calls.map(([url]) => url)).toEqual([
      '/sounds/material/navigation_forward-selection.ogg',
      '/sounds/material/navigation_selection-complete-celebration.ogg',
      '/sounds/material/alert_error-02.ogg',
      '/sounds/material/notification_simple-01.ogg',
      '/sounds/material/navigation-cancel.ogg',
    ]);
  } finally { f.scope.stop(); }
});

it('首次加载的开麦音晚于静音操作返回时，不补播旧状态', async () => {
  const f = fixture();
  let complete!: (value: Awaited<ReturnType<typeof f.fetchAudio>>) => void;
  f.fetchAudio.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  try {
    const starting = f.sounds.microphoneChanged(true);
    await vi.waitFor(() => expect(f.fetchAudio).toHaveBeenCalledOnce());
    expect(await f.sounds.microphoneChanged(false)).toBe(true);
    complete({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });
    expect(await starting).toBe(false);
    expect(f.nodes).toHaveLength(1);
  } finally { f.scope.stop(); }
});

it('默认音效加载失败返回失败，后续试听能够重新加载', async () => {
  const f = fixture();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    f.fetchAudio.mockResolvedValueOnce({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
    expect(await f.sounds.preview('recordingStarted')).toBe(false);
    expect(f.nodes).toHaveLength(0);
    expect(await f.sounds.preview('recordingStarted')).toBe(true);
    expect(f.fetchAudio).toHaveBeenCalledTimes(2);
  } finally { warning.mockRestore(); f.scope.stop(); }
});

it('销毁会话取消素材读取，迟到数据不能创建播放节点', async () => {
  const f = fixture();
  let complete!: (value: Awaited<ReturnType<typeof f.fetchAudio>>) => void;
  f.fetchAudio.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const playing = f.sounds.preview('joined');
  await vi.waitFor(() => expect(f.fetchAudio).toHaveBeenCalledOnce());
  const signal = f.fetchAudio.mock.calls[0][1]!.signal!;
  f.scope.stop();
  expect(signal.aborted).toBe(true);
  complete({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });
  expect(await playing).toBe(false);
  expect(f.context.decodeAudioData).not.toHaveBeenCalled();
  expect(f.nodes).toHaveLength(0);
});
