import type { RemoteAudioTrack } from 'livekit-client';
import processorUrl from './voiceVolumeBalance.worklet.js?url&no-inline';

const modules = new WeakMap<AudioContext, Promise<void>>();

/** 每条远端麦克风轨道一个节点，复用房间的混音上下文；播放和最终音量仍归 SDK。 */
export class RemoteVoiceBalance {
  private node?: AudioWorkletNode;
  private muteGuard?: GainNode;
  private loading?: Promise<void>;
  private enabled = false;
  private disposed = false;

  constructor(private readonly context: AudioContext, private readonly track: RemoteAudioTrack,
    private readonly volume: () => number, private readonly onError: () => void) {}

  setAudible(audible: boolean) {
    if (this.muteGuard) this.muteGuard.gain.value = audible ? 1 : 0;
    this.node?.parameters.get('audible')?.setValueAtTime(audible ? 1 : 0, this.context.currentTime);
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    if (this.disposed) return;
    if (this.node) {
      this.node.parameters.get('enabled')!.setValueAtTime(enabled ? 1 : 0, this.context.currentTime);
      return;
    }
    if (!enabled) return;
    if (this.loading) return this.loading;
    this.loading = this.install().finally(() => { this.loading = undefined; });
    return this.loading;
  }

  private async install() {
    try {
      let module = modules.get(this.context);
      if (!module) {
        module = this.context.audioWorklet.addModule(processorUrl);
        modules.set(this.context, module);
        void module.catch(() => modules.delete(this.context));
      }
      await module;
      if (this.disposed || !this.enabled) return;
      // App 的停止收听先同步禁声，子组件的 props 可能尚未刷新；不能覆盖 SDK 已收到的零音量。
      const volume = Math.min(this.volume(), this.track.getVolume());
      this.muteGuard ??= this.context.createGain();
      this.muteGuard.gain.value = volume > 0 ? 1 : 0;
      this.node = new AudioWorkletNode(this.context, 'lycan-voice-volume-balance', {
        parameterData: { enabled: 1, audible: volume > 0 ? 1 : 0 },
      });
      this.node.onprocessorerror = () => {
        if (this.disposed) return;
        console.warn('成员语音音量平衡处理器失效');
        this.restorePlayback();
        this.onError();
      };
      this.muteGuard.disconnect();
      this.track.setWebAudioPlugins([this.node, this.muteGuard]);
      // SDK 重建混音图时会跳过缓存的零音量；节点也必须保持禁声，不能短暂漏出声音。
      this.track.setVolume(volume);
    } catch (error) {
      if (!this.disposed && this.enabled) {
        console.warn('成员语音音量平衡初始化失败', error);
        this.restorePlayback();
        this.onError();
      }
    }
  }

  private restorePlayback() {
    if (this.node) {
      this.node.onprocessorerror = null;
      this.node.port.postMessage({ type: 'stop' });
      this.node.port.close();
      this.node.disconnect();
      this.node = undefined;
    }
    if (this.muteGuard) {
      const volume = Math.min(this.volume(), this.track.getVolume());
      this.muteGuard.gain.value = volume > 0 ? 1 : 0;
      this.muteGuard.disconnect();
      this.track.setWebAudioPlugins([this.muteGuard]);
      this.track.setVolume(volume);
    }
  }

  dispose() {
    this.disposed = true;
    if (!this.muteGuard) return;
    if (this.node) {
      this.node.onprocessorerror = null;
      this.node.port.postMessage({ type: 'stop' });
      this.node.port.close();
      this.node.disconnect();
    }
    this.muteGuard.disconnect();
    // 调用方先 detach，避免清理插件时重建仍在播放的音频图。
    this.track.setWebAudioPlugins([]);
    this.node = undefined;
    this.muteGuard = undefined;
  }
}
