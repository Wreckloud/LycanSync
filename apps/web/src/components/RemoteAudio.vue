<script setup lang="ts">
import { ref, watch } from 'vue';
import type { RemoteAudioTrack } from 'livekit-client';
import { RemoteVoiceBalance } from '../rtc/remoteVoiceBalance';

const props = defineProps<{
  track: RemoteAudioTrack;
  volume: number;
  context: AudioContext | null;
  balance: boolean;
}>();
const emit = defineEmits<{ balanceError: [] }>();
const audioElement = ref<HTMLAudioElement | null>(null);
let voiceBalance: RemoteVoiceBalance | undefined;

watch([audioElement, () => props.track, () => props.context], ([element, track, context], _, onCleanup) => {
  if (!element) return;
  track.attach(element);
  // 音量可能在元素挂载前已设为零；挂载后再应用一次，避免 SDK 的零值缓存被跳过。
  track.setVolume(props.volume);
  if (context) {
    voiceBalance = new RemoteVoiceBalance(context, track, () => props.volume, () => emit('balanceError'));
    void voiceBalance.setEnabled(props.balance);
  }
  onCleanup(() => {
    track.detach(element);
    voiceBalance?.dispose();
    voiceBalance = undefined;
  });
}, { flush: 'post' });

watch(() => props.balance, (enabled) => { void voiceBalance?.setEnabled(enabled); });
watch(() => [props.track, props.volume] as const, ([track, volume]) => {
  voiceBalance?.setAudible(volume > 0);
  track.setVolume(volume);
}, { immediate: true, flush: 'sync' });
</script>

<template>
  <!-- App 只为远端参与者挂载音轨，本地发布音轨不会回放到扬声器。 -->
  <audio ref="audioElement" autoplay />
</template>
