import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteAudioTrack } from 'livekit-client';
import { RemoteVoiceBalance } from './remoteVoiceBalance';

function setup(module = Promise.resolve()) {
  const addModule = vi.fn(() => module);
  const guard = { gain: { value: 1 }, disconnect: vi.fn() };
  const context = { audioWorklet: { addModule }, currentTime: 0, createGain: () => guard } as unknown as AudioContext;
  const plugins = vi.fn();
  let receivedVolume = 0;
  const track = { setWebAudioPlugins: plugins, setVolume: vi.fn((value: number) => { receivedVolume = value; }),
    getVolume: () => receivedVolume } as unknown as RemoteAudioTrack;
  const nodes: Array<{ parameters: Map<string, { setValueAtTime: ReturnType<typeof vi.fn> }>;
    port: { close: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> };
    disconnect: ReturnType<typeof vi.fn>; onprocessorerror: (() => void) | null }> = [];
  vi.stubGlobal('AudioWorkletNode', class {
    parameters = new Map(['enabled', 'audible'].map((key) => [key, { setValueAtTime: vi.fn() }]));
    port = { close: vi.fn(), postMessage: vi.fn() };
    disconnect = vi.fn();
    onprocessorerror = null;
    constructor(_context: unknown, _name: unknown, readonly options: AudioWorkletNodeOptions) { nodes.push(this); }
  });
  const error = vi.fn();
  let volume = 0;
  const balance = new RemoteVoiceBalance(context, track, () => volume, error);
  return { context, track, guard, nodes, addModule, error, balance,
    setVolume: (next: number) => { volume = next; receivedVolume = next; } };
}

afterEach(() => vi.unstubAllGlobals());

describe('远端平衡节点生命周期', () => {
  it('关闭时不加载，每个房间只加载一次；切换和静音不重建播放图', async () => {
    const { balance, addModule, nodes, context, track, guard, setVolume } = setup();
    await balance.setEnabled(false);
    expect(addModule).not.toHaveBeenCalled();
    await balance.setEnabled(true);
    expect(guard.gain.value).toBe(0);
    expect(track.setVolume).toHaveBeenLastCalledWith(0);
    setVolume(1.5);
    balance.setAudible(true);
    await balance.setEnabled(false);
    await balance.setEnabled(true);
    expect(track.setWebAudioPlugins).toHaveBeenCalledTimes(1);
    expect(nodes).toHaveLength(1);
    expect(guard.gain.value).toBe(1);
    balance.setAudible(false);
    expect(guard.gain.value).toBe(0);
    const second = new RemoteVoiceBalance(context, track, () => 0, vi.fn());
    await second.setEnabled(true);
    expect(addModule).toHaveBeenCalledTimes(1);
    balance.dispose(); second.dispose();
  });

  it.each(['关闭', '释放'])('模块加载期间%s，不把迟到节点接回旧轨道', async (action) => {
    let resolve!: () => void;
    const { balance, track, nodes } = setup(new Promise<void>((complete) => { resolve = complete; }));
    const loading = balance.setEnabled(true);
    if (action === '关闭') await balance.setEnabled(false);
    else balance.dispose();
    resolve(); await loading;
    expect(nodes).toHaveLength(0);
    expect(track.setWebAudioPlugins).not.toHaveBeenCalled();
    balance.dispose();
  });

  it('加载未完成时 SDK 已禁声，即使组件音量尚未更新也不能重新出声', async () => {
    let resolve!: () => void;
    const { balance, track, guard, setVolume } = setup(new Promise<void>((complete) => { resolve = complete; }));
    setVolume(1);
    const loading = balance.setEnabled(true);
    track.setVolume(0);
    resolve(); await loading;
    expect(guard.gain.value).toBe(0);
    expect(track.setVolume).toHaveBeenLastCalledWith(0);
    balance.dispose();
  });

  it('加载失败报告错误；处理器失败恢复普通播放仍保留零音量保护', async () => {
    const failed = setup(Promise.reject(new Error('blocked')));
    await failed.balance.setEnabled(true);
    expect(failed.error).toHaveBeenCalledTimes(1);
    expect(failed.track.setWebAudioPlugins).not.toHaveBeenCalled();
    failed.balance.dispose();
    const { balance, track, nodes, guard, error } = setup();
    await balance.setEnabled(true);
    nodes[0].onprocessorerror!();
    expect(error).toHaveBeenCalledTimes(1);
    expect(track.setWebAudioPlugins).toHaveBeenLastCalledWith([guard]);
    expect(guard.gain.value).toBe(0);
    expect(track.setVolume).toHaveBeenLastCalledWith(0);
    balance.dispose();
    expect(guard.disconnect).toHaveBeenCalled();
    expect(nodes[0].port.close).toHaveBeenCalledTimes(1);
  });
});
