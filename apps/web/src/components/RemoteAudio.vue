<script setup lang="ts">
import { ref, watch } from 'vue';
import type { RemoteAudioTrack } from 'livekit-client';
import { RemoteVoiceBalance } from '../rtc/remoteVoiceBalance';
import type { AudioOutputRouting } from '../rtc/useAudioOutput';

const props = defineProps<{
  track: RemoteAudioTrack;
  volume: number;
  context: AudioContext | null;
  balance: boolean;
  output?: AudioOutputRouting;
}>();
const emit = defineEmits<{ balanceError: []; playbackError: [] }>();
const audioElement = ref<HTMLAudioElement | null>(null);
let voiceBalance: RemoteVoiceBalance | undefined;

watch([audioElement, () => props.track, () => props.context, () => props.output?.available.value ?? true],
  ([element, track, context, available], _, onCleanup) => {
    if (!element || !available) return;
    let cancelled = false;
    let attached = false;
    const binding = props.output?.bindElement(element);
    function attach() {
      if (cancelled) return;
      track.attach(element!);
      attached = true;
      // 音量可能在元素挂载前已设为零；挂载后再应用一次，避免 SDK 的零值缓存被跳过。
      track.setVolume(props.volume);
      if (context) {
        voiceBalance = new RemoteVoiceBalance(context, track, () => props.volume, () => emit('balanceError'));
        void voiceBalance.setEnabled(props.balance);
      }
    }
    if (binding) {
      track.setVolume(0);
      // 路由失败由统一输出设置反馈；没有准备好的设备不能先播放到默认扬声器。
      void binding.ready.then(attach).catch(() => {
        if (!cancelled && props.output?.available.value) emit('playbackError');
      });
    } else attach();
    onCleanup(() => {
      cancelled = true;
      binding?.release();
      if (attached) track.detach(element);
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
