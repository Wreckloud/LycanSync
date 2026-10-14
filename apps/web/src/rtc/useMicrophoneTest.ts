import { onScopeDispose, ref, watch } from 'vue';
import { AudioPresets, Track, TrackEvent, createLocalAudioTrack, type LocalAudioTrack } from 'livekit-client';
import { normalizeAudioVolume, unappliedCaptureProcessing } from './audioPreferences';
import { MicrophoneAudioProcessor } from './microphoneAudioProcessor';
import { MicrophoneLoopback } from './microphoneLoopback';
import { NativeMicrophoneAudioSession, type NativeMicrophoneDesktopBridge } from './nativeMicrophoneAudio';
import type { useAudioPreferences } from './useAudioPreferences';
import { normalizeVoiceLevel } from './voiceLevel';

interface MicrophoneTestOptions {
  preferences: ReturnType<typeof useAudioPreferences>;
  desktop?: NativeMicrophoneDesktopBridge;
  publishedTrack: () => MediaStreamTrack | undefined;
  canStart: () => boolean;
}

interface TestSession {
  context: AudioContext;
  loopback: MicrophoneLoopback;
  borrowed: boolean;
  sourceTrack?: MediaStreamTrack;
  native?: NativeMicrophoneAudioSession;
  browserTrack?: LocalAudioTrack;
  processor?: MicrophoneAudioProcessor;
  removeEndedListener?: () => void;
  meterSource?: MediaStreamAudioSourceNode;
  meterTimer?: ReturnType<typeof setInterval>;
  starting?: Promise<void>;
}

const SETTINGS_NOTICE = '部分音频处理设置需要停止并重新试听后生效。';
const CLEANUP_NOTICE = '麦克风试听停止未确认，请重启客户端后再试。';

function captureMessage(error: unknown, desktop: boolean) {
  if (error instanceof Error) {
    if (error.name === 'NotAllowedError') return '麦克风未获授权，请允许后重试。';
    if (error.name === 'NotFoundError' || error.message === 'audioDeviceUnavailable') {
      return '默认麦克风不可用，请检查设备连接和录音权限。';
    }
    if (error.name === 'NotReadableError') return '麦克风无法采集，请检查录音权限或设备占用。';
    if (error.message === 'microphoneCaptureFormatUnsupported') return '当前麦克风音频格式暂不支持。';
    if (error.message === 'platformUnsupported') return '当前桌面系统不支持原生麦克风采集。';
  }
  return desktop ? '麦克风试听采集失败，请检查默认输入设备和 Windows 录音权限。'
    : '麦克风试听采集失败，请检查输入设备和浏览器权限。';
}

/** 本机试听独立于房间；借用已发布音轨，否则持有只供本机使用的临时采集。 */
export function useMicrophoneTest(options: MicrophoneTestOptions) {
  const state = ref<'idle' | 'starting' | 'listening' | 'stopping'>('idle');
  const notice = ref('');
  const inputLevelPercent = ref(0);
  let session: TestSession | undefined;
  let cleanup: Promise<void> = Promise.resolve();
  let cleanupFailed = false;
  const preferences = options.preferences;

  function stop(): Promise<void> {
    const previous = session;
    if (!previous) return cleanup;
    // 先撤销启动资格，迟到的采集结果只释放，不能重新开始播放。
    session = undefined;
    state.value = 'stopping';
    inputLevelPercent.value = 0;
    if (previous.meterTimer !== undefined) clearInterval(previous.meterTimer);
    const playbackStop = Promise.resolve().then(() => previous.loopback.stop());
    const nativeStop = Promise.resolve().then(() => previous.native?.stop());
    // 停止可能先于启动完成；先观察拒绝，后面仍统一等待并报告。
    void playbackStop.catch(() => {});
    void nativeStop.catch(() => {});
    cleanup = (async () => {
      await previous.starting;
      const results = await Promise.allSettled([
        playbackStop,
        nativeStop,
        Promise.resolve().then(() => previous.removeEndedListener?.()),
        Promise.resolve().then(() => previous.meterSource?.disconnect()),
        Promise.resolve().then(async () => {
          // 处理器不拥有浏览器原始采集；两者都释放，不停止借来的通话音轨。
          try { await previous.processor?.destroy(); }
          finally { previous.browserTrack?.stop(); }
        }),
        Promise.resolve().then(() => previous.context.state !== 'closed' ? previous.context.close() : undefined),
      ]);
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, CLEANUP_NOTICE);
    })().catch((error) => {
      cleanupFailed = true;
      notice.value = CLEANUP_NOTICE;
      console.error('麦克风试听清理未完成', error);
      throw error;
    }).finally(() => { state.value = 'idle'; });
    // 切栏和销毁不等待 UI；入房及开麦调用方仍等待同一个清理结果。
    void cleanup.catch(() => {});
    return cleanup;
  }

  async function start() {
    if (state.value !== 'idle') return;
    if (cleanupFailed) { notice.value = CLEANUP_NOTICE; return; }
    if (!options.canStart()) { notice.value = '请等待麦克风或语音连接操作完成后再试听。'; return; }
    notice.value = '';
    const borrowedTrack = options.publishedTrack();
    let current: TestSession;
    try {
      // 点击时创建输出上下文，临时采集等待权限期间也保留用户的播放授权。
      const context = new AudioContext({ sampleRate: 48_000 });
      current = {
        context,
        borrowed: Boolean(borrowedTrack),
        sourceTrack: borrowedTrack,
        loopback: new MicrophoneLoopback({
          createContext: () => context,
          onError: (error) => { if (session === current) notice.value = error.message; },
          onStopped: () => { if (session === current) void stop(); },
        }),
      };
    } catch {
      notice.value = '麦克风试听无法初始化声音输出，请检查播放设备。';
      return;
    }
    session = current;
    state.value = 'starting';
    current.starting = startSession(current);
    await current.starting;
  }

  async function startSession(current: TestSession) {
    let captured = current.borrowed;
    try {
      await current.context.resume();
      if (session !== current) return;
      if (!current.borrowed) {
        if (options.desktop) {
          current.native = new NativeMicrophoneAudioSession(options.desktop, {
            onError: (code) => {
              if (session !== current) return;
              notice.value = captureMessage(new Error(code), true);
              void stop();
            },
          });
          const track = await current.native.start(crypto.randomUUID(), {
            inputGain: preferences.inputGain.value,
            noiseSuppression: preferences.processing.noiseSuppression,
            autoGainControl: preferences.processing.autoGainControl,
            voiceEnhancement: preferences.processing.voiceEnhancement,
          });
          current.sourceTrack = track.mediaStreamTrack;
        } else {
          current.browserTrack = await createLocalAudioTrack({
            echoCancellation: preferences.processing.echoCancellation,
            noiseSuppression: preferences.processing.noiseSuppression,
            autoGainControl: preferences.processing.autoGainControl,
          });
          if (session !== current) return;
          const track = current.browserTrack;
          const ended = () => {
            if (session !== current) return;
            notice.value = '麦克风已断开，请检查设备后重新试听。';
            void stop();
          };
          track.on(TrackEvent.Ended, ended);
          current.removeEndedListener = () => { track.off(TrackEvent.Ended, ended); };
          current.processor = new MicrophoneAudioProcessor(preferences.inputGain.value,
            preferences.processing.voiceEnhancement);
          // 测试直接持有处理器，避免交给 SDK 后重复清理；算法与通话一致。
          await current.processor.init({ kind: Track.Kind.Audio, track: track.mediaStreamTrack,
            audioContext: current.context });
          current.sourceTrack = current.processor.processedTrack;
        }
        if (session !== current) return;
        captured = true;
        await configure(current);
      }
      if (session !== current) return;
      if (!current.sourceTrack || current.sourceTrack.readyState !== 'live') throw new Error('麦克风音轨已停止。');
      startMeter(current);
      await current.loopback.start(current.sourceTrack, preferences.outputVolume.value, AudioPresets.music.maxBitrate, true);
      if (session === current) state.value = 'listening';
    } catch (error) {
      if (session !== current) return;
      notice.value = captured && error instanceof Error ? error.message : captureMessage(error, Boolean(options.desktop));
      void stop();
    }
  }

  function startMeter(current: TestSession) {
    const analyser = current.context.createAnalyser();
    analyser.fftSize = 512;
    current.meterSource = current.context.createMediaStreamSource(new MediaStream([current.sourceTrack!]));
    current.meterSource.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    current.meterTimer = setInterval(() => {
      if (session !== current) return;
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      inputLevelPercent.value = Math.round(normalizeVoiceLevel(rms) * 100);
    }, 120);
  }

  async function configure(current: TestSession) {
    if (session !== current || current.borrowed) return;
    const settings = { ...preferences.processing };
    try {
      if (current.native) {
        await current.native.configure({ inputGain: preferences.inputGain.value,
          noiseSuppression: settings.noiseSuppression, autoGainControl: settings.autoGainControl,
          voiceEnhancement: settings.voiceEnhancement });
      } else if (current.browserTrack) {
        current.processor?.setInputGain(preferences.inputGain.value);
        current.processor?.setVoiceEnhancement(settings.voiceEnhancement);
        await current.browserTrack.applyConstraints({
          echoCancellation: settings.echoCancellation,
          noiseSuppression: settings.noiseSuppression,
          autoGainControl: settings.autoGainControl,
        });
        if (session === current && unappliedCaptureProcessing(settings, current.browserTrack.getSourceTrackSettings()).length) {
          notice.value = SETTINGS_NOTICE;
          return;
        }
      }
      if (session === current && notice.value === SETTINGS_NOTICE) notice.value = '';
    } catch {
      if (session === current) notice.value = '试听麦克风设置未能应用，请停止并重新试听。';
    }
  }

  watch(() => [preferences.inputGain.value, { ...preferences.processing }] as const, () => {
    if (session?.sourceTrack) void configure(session);
  });
  watch(preferences.outputVolume, (volume) => session?.loopback.setVolume(normalizeAudioVolume(volume)));
  watch(options.publishedTrack, (track) => {
    if (session?.borrowed && session.sourceTrack !== track) void stop();
  }, { flush: 'sync' });
  onScopeDispose(() => { void stop(); });

  return { state, notice, inputLevelPercent, start, stop };
}
