import { afterEach, expect, it, vi } from 'vitest';
import { NativeScreenVideoSession, setNativeScreenPreviewDemand, type NativeVideoDesktopBridge } from './nativeScreenVideo';

afterEach(() => vi.unstubAllGlobals());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(maxFps = 120) {
  const target = new EventTarget();
  vi.stubGlobal('window', target);
  let time = 0;
  let frameSequence = 0;
  let eligible = true;
  let current = true;
  let parameters: RTCRtpSendParameters = { transactionId: 'demand-test', codecs: [], headerExtensions: [], rtcp: {}, encodings: [
    { rid: 'q', active: true, maxFramerate: 30, maxBitrate: 1_000_000 },
    { rid: 'h', active: true, maxFramerate: maxFps, maxBitrate: 20_000_000 },
  ] };
  const sender = { getParameters: vi.fn(() => structuredClone(parameters)),
    setParameters: vi.fn(async (next: RTCRtpSendParameters) => { parameters = structuredClone(next); }) };
  const write = vi.fn(async (_frame: VideoFrame) => {});
  const generator = { id: 'demand-track', writable: { getWriter: () => ({ write, close: vi.fn(async () => {}) }) }, stop: vi.fn() };
  const track = { mediaStreamTrack: generator, sender, stop: vi.fn(), publishOptions: {
    screenShareEncoding: { maxFramerate: maxFps, maxBitrate: 20_000_000 },
  } };
  const desktop: NativeVideoDesktopBridge = {
    recordScreenShareStartupTiming: vi.fn(),
    startNativeVideo: vi.fn(async () => ({ sessionId: 'demand-session', changed: true })),
    stopNativeVideo: vi.fn(async () => ({ changed: true })),
    configureNativeVideo: vi.fn(async () => ({ changed: true })),
    onNativeVideoError: () => () => {}, onNativeVideoSuspended: () => () => {},
  };
  const warning = vi.fn(), onError = vi.fn();
  const session = new NativeScreenVideoSession(desktop, { maxFps, now: () => time,
    isCurrentCapture: () => current,
    canReduceFrameRate: () => eligible, onFrameRateAdjustmentFailure: warning, onError,
    createGenerator: () => generator as never, createLocalTrack: () => track as never });
  const frame = async (advance = 500) => {
    time += advance;
    const event = new Event('message');
    Object.defineProperties(event, { source: { value: target }, data: { value: {
      type: 'lycan-native-screen-frame', sessionId: 'demand-session',
      frame: { close: vi.fn(), timestamp: ++frameSequence * 1000, displayWidth: 1920, displayHeight: 1080 },
    } } });
    target.dispatchEvent(event);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const ready = session.start('monitor:1:0');
  await Promise.resolve(); await frame(0); await ready;
  const low = () => { parameters.encodings[0].active = true; parameters.encodings[1].active = false; };
  const high = () => { parameters.encodings[1].active = true; };
  const settleLow = async () => { low(); for (let index = 0; index < 7; index++) await frame(); };
  return { session, sender, desktop, track, generator, warning, onError, frame, low, high, settleLow,
    parameters: () => parameters, setEligible: (value: boolean) => { eligible = value; },
    retire: () => { current = false; } };
}

it('低层需求稳定三秒才降低 OBS 帧率，高清需求恢复；用户设置、编码预算、轨道和会话不变', async () => {
  const f = await fixture();
  try {
    const originalParameters = f.parameters();
    f.low();
    for (let index = 0; index < 6; index++) await f.frame();
    expect(f.desktop.configureNativeVideo).not.toHaveBeenCalled();
    await f.frame();
    expect(f.desktop.configureNativeVideo).toHaveBeenCalledExactlyOnceWith('demand-session', 30, { width: 1920, height: 1080 });
    expect(f.session.readDiagnostics()).toMatchObject({ requestedFrameRate: 120, captureFrameRate: 30, frameRateAdjustmentFailed: false });
    expect(f.sender.setParameters).not.toHaveBeenCalled();
    expect(f.parameters()).toBe(originalParameters);
    expect(f.track.publishOptions.screenShareEncoding.maxFramerate).toBe(120);
    f.high(); await f.frame();
    expect(f.desktop.configureNativeVideo).toHaveBeenLastCalledWith('demand-session', 120, { width: 1920, height: 1080 });
    expect(f.session.readDiagnostics().captureFrameRate).toBe(120);
    expect(f.desktop.startNativeVideo).toHaveBeenCalledOnce();
    expect(f.desktop.stopNativeVideo).not.toHaveBeenCalled();
  } finally { await f.session.stop(); }
});

it('短暂低层和反复开关大窗不触发降档，高清层仍开启时不因低 FPS 或码率改变而降档', async () => {
  const f = await fixture();
  try {
    f.low(); await f.frame(2000); f.high(); await f.frame();
    f.low(); await f.frame(2000); f.high(); await f.frame();
    f.parameters().encodings[1].maxBitrate = 1000;
    for (let index = 0; index < 12; index++) await f.frame();
    expect(f.desktop.configureNativeVideo).not.toHaveBeenCalled();
  } finally { await f.session.stop(); }
});

it('来源帧高频到达只触发半秒一次的本地参数读取，不创建额外轮询定时器', async () => {
  const interval = vi.spyOn(globalThis, 'setInterval');
  const f = await fixture();
  try {
    expect(f.sender.getParameters).toHaveBeenCalledOnce();
    for (let index = 0; index < 20; index++) await f.frame(10);
    expect(f.sender.getParameters).toHaveBeenCalledOnce();
    await f.frame(300);
    expect(f.sender.getParameters).toHaveBeenCalledTimes(2);
    expect(interval).not.toHaveBeenCalled();
  } finally { await f.session.stop(); interval.mockRestore(); }
});

it.each(['single', 'unknown', 'both-off', 'reordered'] as const)('%s 发送状态不能冒充仅缩略图需求', async (mode) => {
  const f = await fixture();
  try {
    f.low();
    if (mode === 'single') f.parameters().encodings.pop();
    if (mode === 'unknown') delete f.parameters().encodings[1].active;
    if (mode === 'both-off') f.parameters().encodings[0].active = false;
    if (mode === 'reordered') f.parameters().encodings.reverse();
    for (let index = 0; index < 12; index++) await f.frame();
    expect(f.desktop.configureNativeVideo).not.toHaveBeenCalled();
  } finally { await f.session.stop(); }
});

it('重连、远控或失去当前发布资格时恢复用户目标，重新满足条件需重新等待', async () => {
  const f = await fixture();
  try {
    f.setEligible(false); await f.settleLow();
    expect(f.desktop.configureNativeVideo).not.toHaveBeenCalled();
    f.setEligible(true); await f.settleLow();
    expect(f.session.readDiagnostics().captureFrameRate).toBe(30);
    f.setEligible(false); await f.frame();
    expect(f.session.readDiagnostics().captureFrameRate).toBe(120);
    f.setEligible(true); await f.frame(2000);
    expect(f.desktop.configureNativeVideo).toHaveBeenCalledTimes(2);
  } finally { await f.session.stop(); }
});

it('本机多个大预览保留高清需求，最后一个关闭后重新计时，停止后旧预览不能操作新资源', async () => {
  const f = await fixture();
  const one = {} as HTMLVideoElement, two = {} as HTMLVideoElement;
  const demand = (preview: HTMLVideoElement, required: boolean) =>
    setNativeScreenPreviewDemand(f.generator as never, preview, required);
  await f.settleLow();
  demand(one, true); await f.frame(0);
  expect(f.session.readDiagnostics().captureFrameRate).toBe(120);
  demand(two, true); demand(one, false);
  await f.settleLow();
  expect(f.session.readDiagnostics().captureFrameRate).toBe(120);
  demand(two, false); await f.settleLow();
  expect(f.session.readDiagnostics().captureFrameRate).toBe(30);
  await f.session.stop();
  const count = vi.mocked(f.desktop.configureNativeVideo).mock.calls.length;
  demand(one, true); await f.frame(5000);
  expect(f.desktop.configureNativeVideo).toHaveBeenCalledTimes(count);
});

it('降档请求等待时不并发配置，高清迟到需求在确认后立即恢复', async () => {
  const f = await fixture();
  const pending = deferred<{ changed: boolean }>();
  try {
    vi.mocked(f.desktop.configureNativeVideo).mockReturnValueOnce(pending.promise);
    await f.settleLow(); f.high(); await f.frame(1000);
    expect(f.session.readDiagnostics().captureFrameRate).toBe(120);
    expect(f.desktop.configureNativeVideo).toHaveBeenCalledTimes(1);
    pending.resolve({ changed: true }); await f.frame(0);
    expect(f.desktop.configureNativeVideo).toHaveBeenCalledTimes(2);
    expect(f.session.readDiagnostics().captureFrameRate).toBe(120);
  } finally { await f.session.stop(); }
});

it('手动画质等待在途节流完成，按最后确认的采集状态更新，不覆盖 SDK active', async () => {
  const f = await fixture();
  const pending = deferred<{ changed: boolean }>();
  try {
    vi.mocked(f.desktop.configureNativeVideo).mockReturnValueOnce(pending.promise);
    await f.settleLow();
    const quality = f.session.configureQuality('custom', { resolution: 1440, fps: 120, bitrateMbps: 25 });
    expect(f.desktop.configureNativeVideo).toHaveBeenCalledTimes(1);
    pending.resolve({ changed: true }); await quality;
    expect(f.desktop.configureNativeVideo).toHaveBeenLastCalledWith('demand-session', 120, { width: 2560, height: 1440 });
    expect(f.session.readDiagnostics()).toMatchObject({ requestedFrameRate: 120, captureFrameRate: 120 });
    expect(f.track.publishOptions.screenShareEncoding).toMatchObject({ maxFramerate: 120, maxBitrate: 25_000_000 });
    expect(f.parameters().encodings[1].active).toBe(false);
    await f.frame(500);
    expect(f.desktop.configureNativeVideo).toHaveBeenCalledTimes(2);
  } finally { await f.session.stop(); }
});

it('停止优先于在途节流，旧确认不恢复帧率、不补发配置或警告', async () => {
  const f = await fixture();
  const pending = deferred<{ changed: boolean }>();
  vi.mocked(f.desktop.configureNativeVideo).mockReturnValueOnce(pending.promise);
  await f.settleLow();
  const quality = f.session.configureQuality('standard');
  const rejected = expect(quality).rejects.toThrow('nativeVideoConfigurationUnavailable');
  await f.session.stop();
  pending.resolve({ changed: true }); await rejected; await f.frame(1000);
  expect(f.desktop.configureNativeVideo).toHaveBeenCalledTimes(1);
  expect(f.warning).not.toHaveBeenCalled();
  expect(f.desktop.stopNativeVideo).toHaveBeenCalledExactlyOnceWith('demand-session');
});

it('房间已撤销采集资格但原生停止仍在等待时，不为旧会话恢复高帧率', async () => {
  const f = await fixture();
  try {
    await f.settleLow();
    f.retire(); f.high();
    await f.frame();
    expect(f.desktop.configureNativeVideo).toHaveBeenCalledTimes(1);
    expect(f.session.readDiagnostics().captureFrameRate).toBe(30);
  } finally { await f.session.stop(); }
});

it.each([false, true])('降档或恢复失败不伪报配置、不反复尝试或结束可用共享；恢复阶段=%s', async (restore) => {
  const f = await fixture();
  try {
    if (restore) await f.settleLow();
    vi.mocked(f.desktop.configureNativeVideo).mockResolvedValueOnce({ changed: false });
    if (restore) { f.high(); await f.frame(); }
    else await f.settleLow();
    const lastConfirmed = restore ? 30 : 120;
    expect(f.session.readDiagnostics()).toMatchObject({ requestedFrameRate: 120, captureFrameRate: lastConfirmed, frameRateAdjustmentFailed: true });
    expect(f.warning).toHaveBeenCalledExactlyOnceWith(lastConfirmed);
    const count = vi.mocked(f.desktop.configureNativeVideo).mock.calls.length;
    await f.frame(10000);
    expect(f.desktop.configureNativeVideo).toHaveBeenCalledTimes(count);
    expect(f.desktop.stopNativeVideo).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
    await f.session.configureQuality('highFrameRate');
    expect(f.session.readDiagnostics()).toMatchObject({ requestedFrameRate: 120, captureFrameRate: 120, frameRateAdjustmentFailed: false });
  } finally { await f.session.stop(); }
});

it('sender 读取失败按未知恢复，不把失败计为无人需要高清；30 FPS 用户目标不反复重设', async () => {
  const f = await fixture();
  try {
    await f.settleLow();
    f.sender.getParameters.mockImplementationOnce(() => { throw new Error('sender unavailable'); });
    await f.frame();
    expect(f.session.readDiagnostics().captureFrameRate).toBe(120);
  } finally { await f.session.stop(); }
  const low = await fixture(30);
  try { await low.settleLow(); expect(low.desktop.configureNativeVideo).not.toHaveBeenCalled(); }
  finally { await low.session.stop(); }
});

it('发送器重建后不沿用旧低清等待，异常拒绝只提示一次且不停止仍可用的共享', async () => {
  const f = await fixture();
  try {
    f.low(); await f.frame(); await f.frame(2500);
    f.track.sender = { ...f.sender };
    await f.frame(500);
    expect(f.desktop.configureNativeVideo).not.toHaveBeenCalled();
    vi.mocked(f.desktop.configureNativeVideo).mockRejectedValueOnce(new Error('native rejected'));
    await f.frame(3000);
    expect(f.warning).toHaveBeenCalledExactlyOnceWith(120);
    await f.frame(5000);
    expect(f.desktop.configureNativeVideo).toHaveBeenCalledTimes(1);
    expect(f.onError).not.toHaveBeenCalled();
    expect(f.session.needsFrameRateRecovery).toBe(true);
  } finally { await f.session.stop(); }
});
