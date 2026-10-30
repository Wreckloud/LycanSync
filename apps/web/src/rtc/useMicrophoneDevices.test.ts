import { effectScope } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { useAudioPreferences } from './useAudioPreferences';
import { useMicrophoneDevices } from './useMicrophoneDevices';

function fixture(initial = 'default') {
  const scope = effectScope();
  const preferences = scope.run(() => useAudioPreferences('test', {
    getItem: () => JSON.stringify({ inputDeviceId: initial }), setItem: vi.fn(),
  }))!;
  const media = new EventTarget();
  const available = [{ id: 'mic-one', label: '麦克风一' }, { id: 'mic-two', label: '麦克风二' }];
  const desktop = { listMicrophoneDevices: vi.fn(async () => [...available]) };
  const stopTest = vi.fn(async () => {});
  const changeInput = vi.fn(async (_id: string) => {});
  const inputLost = vi.fn(async () => {});
  const control = scope.run(() => useMicrophoneDevices({ preferences, desktop, stopTest, changeInput, inputLost,
    mediaDevices: media as MediaDevices }))!;
  return { scope, preferences, media, available, desktop, stopTest, changeInput, inputLost, control };
}

describe('麦克风设备选择', () => {
  it('枚举不采集，明确选择后才切换并保留本机偏好', async () => {
    const f = fixture();
    await f.control.refresh();
    expect(f.changeInput).not.toHaveBeenCalled();
    await f.control.select('mic-two');
    expect(f.stopTest).toHaveBeenCalledOnce();
    expect(f.changeInput).toHaveBeenCalledWith('mic-two');
    expect(f.preferences.inputDeviceId.value).toBe('mic-two');
    expect(f.control.notice.value).toBe('');
    f.scope.stop();
  });

  it('指定设备拔出禁发，重新插入和新设备接入不自动开麦或换麦', async () => {
    const f = fixture('mic-one');
    await f.control.refresh();
    f.available.splice(0, 1);
    await f.control.refresh();
    expect(f.inputLost).toHaveBeenCalledOnce();
    expect(f.preferences.inputDeviceId.value).toBe('mic-one');
    expect(f.control.notice.value).toContain('已停止发声');
    f.available.push({ id: 'mic-one', label: '重新插入' });
    await f.control.refresh();
    expect(f.changeInput).not.toHaveBeenCalled();
    f.scope.stop();
  });

  it('默认设备变化交由当前默认采集处理，枚举失败不推断设备拔出', async () => {
    const f = fixture();
    await f.control.refresh();
    f.available.length = 0;
    await f.control.refresh();
    expect(f.inputLost).not.toHaveBeenCalled();
    f.desktop.listMicrophoneDevices.mockRejectedValueOnce(new Error('denied'));
    await f.control.refresh();
    expect(f.control.notice.value).toContain('无法读取');
    expect(f.inputLost).not.toHaveBeenCalled();
    f.scope.stop();
  });

  it('切换失败不保存新设备，销毁后移除事件监听', async () => {
    const f = fixture('mic-one');
    await f.control.refresh();
    f.changeInput.mockRejectedValueOnce(new Error('stop failed'));
    await f.control.select('mic-two');
    expect(f.preferences.inputDeviceId.value).toBe('mic-one');
    expect(f.control.notice.value).toContain('未完成');
    f.scope.stop();
    const count = f.desktop.listMicrophoneDevices.mock.calls.length;
    f.media.dispatchEvent(new Event('devicechange'));
    await Promise.resolve();
    expect(f.desktop.listMicrophoneDevices).toHaveBeenCalledTimes(count);
  });
});
