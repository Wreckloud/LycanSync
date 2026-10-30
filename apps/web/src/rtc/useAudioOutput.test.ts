import { effectScope } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAudioPreferences } from './useAudioPreferences';
import { useAudioOutput } from './useAudioOutput';

class OutputContext extends EventTarget {
  state = 'running';
  sinkId: string | { type: 'none' } = '';
  async setSinkId(id: string | { type: 'none' }) {
    this.sinkId = id;
    this.dispatchEvent(new Event('sinkchange'));
  }
}
class OutputElement extends EventTarget {
  sinkId = '';
  async setSinkId(id: string) { this.sinkId = id; }
}

function fixture(id = 'default') {
  vi.stubGlobal('AudioContext', OutputContext);
  vi.stubGlobal('HTMLMediaElement', OutputElement);
  const scope = effectScope();
  const preferences = scope.run(() => useAudioPreferences('test', {
    getItem: () => JSON.stringify({ outputDeviceId: id }), setItem: vi.fn(),
  }))!;
  const media = Object.assign(new EventTarget(), {
    enumerateDevices: vi.fn(async () => [...devices]),
  });
  const devices = [{ kind: 'audiooutput', deviceId: 'speaker-a', label: '设备一' },
    { kind: 'audiooutput', deviceId: 'speaker-b', label: '设备二' }];
  const output = scope.run(() => useAudioOutput(preferences, media as unknown as MediaDevices))!;
  const context = new OutputContext();
  const element = new OutputElement();
  return { scope, preferences, media, devices, output, context, element };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('统一声音输出', () => {
  it('同一选择同时应用混音上下文和播放元素，释放后不再改动原资源', async () => {
    const f = fixture();
    await f.output.refresh();
    const context = f.output.bindContext(f.context as unknown as AudioContext);
    const element = f.output.bindElement(f.element as unknown as HTMLMediaElement);
    await Promise.all([context.ready, element.ready]);
    await f.output.select('speaker-b');
    expect(f.context.sinkId).toBe('speaker-b');
    expect(f.element.sinkId).toBe('speaker-b');
    expect(f.preferences.outputDeviceId.value).toBe('speaker-b');
    element.release();
    await f.output.select('speaker-a');
    expect(f.context.sinkId).toBe('speaker-a');
    expect(f.element.sinkId).toBe('speaker-b');
    context.release();
    f.scope.stop();
  });

  it('拔出明确设备暂停输出，不暂停音频图；重新连接不自动恢复，手动默认可恢复', async () => {
    const f = fixture('speaker-a');
    await f.output.refresh();
    const context = f.output.bindContext(f.context as unknown as AudioContext);
    await context.ready;
    f.devices.splice(0, 1);
    await f.output.refresh();
    await context.ready;
    expect(f.output.available.value).toBe(false);
    expect(f.context.sinkId).toEqual({ type: 'none' });
    expect(f.context.state).toBe('running');
    expect(f.preferences.outputDeviceId.value).toBe('speaker-a');
    f.devices.push({ kind: 'audiooutput', deviceId: 'speaker-a', label: '重新接入' });
    await f.output.refresh();
    expect(f.output.available.value).toBe(false);
    await f.output.select('default');
    expect(f.output.available.value).toBe(true);
    expect(f.context.sinkId).toBe('');
    expect(f.preferences.outputDeviceId.value).toBe('default');
    f.scope.stop();
  });

  it('部分资源切换失败回到原选择，不保存成功假象', async () => {
    const f = fixture('speaker-a');
    await f.output.refresh();
    const context = f.output.bindContext(f.context as unknown as AudioContext);
    const element = f.output.bindElement(f.element as unknown as HTMLMediaElement);
    await Promise.all([context.ready, element.ready]);
    vi.spyOn(f.element, 'setSinkId').mockImplementation(async (id) => {
      if (id === 'speaker-b') throw new Error('not allowed');
      f.element.sinkId = id;
    });
    await f.output.select('speaker-b');
    expect(f.preferences.outputDeviceId.value).toBe('speaker-a');
    expect(f.context.sinkId).toBe('speaker-a');
    expect(f.element.sinkId).toBe('speaker-a');
    expect(f.output.notice.value).toContain('未保存');
    f.scope.stop();
  });

  it('SDK 默认设备事件不覆盖用户明确选择，销毁后移除监听', async () => {
    const f = fixture('speaker-b');
    await f.output.refresh();
    const calls = vi.spyOn(f.context, 'setSinkId');
    const context = f.output.bindContext(f.context as unknown as AudioContext);
    await context.ready;
    f.context.sinkId = '';
    f.context.dispatchEvent(new Event('sinkchange'));
    await vi.waitFor(() => expect(f.context.sinkId).toBe('speaker-b'));
    expect(calls).toHaveBeenCalledTimes(2);
    f.scope.stop();
    f.context.sinkId = '';
    f.context.dispatchEvent(new Event('sinkchange'));
    f.media.dispatchEvent(new Event('devicechange'));
    await Promise.resolve();
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('旧设备请求迟到失败不覆盖排队的新设备选择', async () => {
    const f = fixture('speaker-a');
    await f.output.refresh();
    let reject!: (error: Error) => void;
    const delayed = new Promise<void>((_, no) => { reject = no; });
    vi.spyOn(f.context, 'setSinkId').mockImplementationOnce(() => delayed);
    const context = f.output.bindContext(f.context as unknown as AudioContext);
    await Promise.resolve();
    await Promise.resolve();
    const change = f.output.select('speaker-b');
    reject(new Error('old device'));
    await change;
    await context.ready;
    expect(f.output.available.value).toBe(true);
    expect(f.output.notice.value).toBe('');
    expect(f.context.sinkId).toBe('speaker-b');
    f.scope.stop();
  });
});
