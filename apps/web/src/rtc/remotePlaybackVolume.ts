import type { RemoteAudioTrack } from 'livekit-client';

const shareGains = new WeakMap<RemoteAudioTrack, GainNode>();

export function setRemotePlaybackVolume(track: RemoteAudioTrack, volume: number) {
  const gain = shareGains.get(track);
  if (gain) gain.gain.setTargetAtTime(volume, gain.context.currentTime, 0.1);
  else track.setVolume(volume);
}

export function prepareSharePlayback(track: RemoteAudioTrack, context: AudioContext, volume: number) {
  // SDK 每次连接的输出节点从 1 开始渐变。先在其上游设好实际增益，静音重连也不会漏出首帧。
  const gain = context.createGain();
  gain.gain.value = volume;
  track.setWebAudioPlugins([gain]);
  track.setVolume(1);
  shareGains.set(track, gain);
  return () => {
    shareGains.delete(track);
    track.setWebAudioPlugins([]);
    gain.disconnect();
  };
}
