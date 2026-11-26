import { Track, type TrackPublication } from 'livekit-client';

export interface ApplicationAudioSource {
  id: string;
  application: string;
  name: string;
}

export function applicationAudioName(publication?: { trackName: string }) {
  return /^application-audio:([a-z]{1,24})$/.exec(publication?.trackName ?? '')?.[1];
}

// 两种声音共用服务器已有的发布权限；切换期间按发布名称识别各自拥有的轨道。
export function screenAudioPublication<T extends TrackPublication>(participant: {
  getTrackPublication(source: Track.Source): T | undefined;
  audioTrackPublications: Map<string, T>;
}) {
  const first = participant.getTrackPublication(Track.Source.ScreenShareAudio);
  if (!applicationAudioName(first)) return first;
  return [...participant.audioTrackPublications.values()].find(pub =>
    pub.source === Track.Source.ScreenShareAudio && !applicationAudioName(pub));
}
