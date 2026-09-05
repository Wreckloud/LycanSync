<script setup lang="ts">
import { ref, watch } from 'vue';
import type { RemoteAudioTrack } from 'livekit-client';

const props = defineProps<{ track: RemoteAudioTrack; volume: number }>();
const audioElement = ref<HTMLAudioElement | null>(null);

watch([audioElement, () => props.track], ([element, track], _, onCleanup) => {
  if (!element) return;
  track.attach(element);
  onCleanup(() => track.detach(element));
}, { flush: 'post' });

watch(() => [props.track, props.volume] as const, ([track, volume]) => {
  track.setVolume(volume);
}, { immediate: true });
</script>

<template>
  <!-- 只播放远端麦克风，避免回放自己的声音。 -->
  <audio ref="audioElement" autoplay />
</template>
