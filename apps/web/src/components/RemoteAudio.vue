<script setup lang="ts">
import { ref, watch } from 'vue';
import type { RemoteAudioTrack } from 'livekit-client';

const props = defineProps<{ track: RemoteAudioTrack; volume: number }>();
const audioElement = ref<HTMLAudioElement | null>(null);

watch([audioElement, () => props.track], ([element, track], _, onCleanup) => {
  if (!element) return;
  track.attach(element);
  // 音量可能在元素挂载前已设为零；挂载后再应用一次，避免 SDK 的零值缓存被跳过。
  track.setVolume(props.volume);
  onCleanup(() => track.detach(element));
}, { flush: 'post' });

watch(() => [props.track, props.volume] as const, ([track, volume]) => {
  track.setVolume(volume);
}, { immediate: true });
</script>

<template>
  <!-- App 只为远端参与者挂载音轨，本地发布音轨不会回放到扬声器。 -->
  <audio ref="audioElement" autoplay />
</template>
