<script setup lang="ts">
import { ref } from 'vue';
import MediaVideoSurface from '../MediaVideoSurface.vue';
import { useBackdropDismiss } from '../useBackdropDismiss';
import { keepDialogFocus } from '../dialogFocus';

defineProps<{ source: string }>();
const emit = defineEmits<{ close: []; external: [] }>();
const failed = ref(false);
const backdropEvents = useBackdropDismiss(() => emit('close'));
</script>

<template>
  <div class="dialog-backdrop" v-on="backdropEvents" @keydown.esc.stop="emit('close')">
    <section class="media-viewer-shell" role="dialog" aria-modal="true" aria-label="录像预览" tabindex="-1" @keydown="keepDialogFocus">
      <MediaVideoSurface :source="source" @close="emit('close')" @error="failed = true" />
      <div v-if="failed" class="media-viewer-feedback" role="alert">暂时无法预览这个录像。<button type="button" @click="emit('external')">使用系统播放器</button></div>
    </section>
  </div>
</template>
