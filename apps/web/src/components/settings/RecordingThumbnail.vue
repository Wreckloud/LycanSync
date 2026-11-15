<script setup lang="ts">
import { onMounted, onScopeDispose, ref } from 'vue';
import { Play } from '@lucide/vue';
import { loadRecordingThumbnail } from '../../recording/recordingThumbnails';

const props = defineProps<{ source: string; disabled: boolean; passive?: boolean }>();
const emit = defineEmits<{ preview: [] }>();
const frame = ref<HTMLElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const ready = ref(false);
const failed = ref(false);
let disposed = false;
let observer: IntersectionObserver | undefined;
let request: AbortController | undefined;
function release() { request?.abort(); request = undefined; }
async function load() {
  if (disposed || request || ready.value || failed.value || props.disabled) return;
  const current = request = new AbortController();
  try {
    const cover = await loadRecordingThumbnail(props.source, current.signal);
    if (current.signal.aborted || request !== current || !canvas.value) return;
    const context = canvas.value.getContext('2d');
    if (!context) throw new Error('thumbnailCanvasUnavailable');
    canvas.value.width = cover.width; canvas.value.height = cover.height;
    context.putImageData(cover, 0, 0);
    ready.value = true;
  } catch {
    if (!current.signal.aborted && request === current) failed.value = true;
  } finally { if (request === current) request = undefined; }
}
onMounted(() => {
  observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) load();
    else release();
  });
  if (frame.value) observer.observe(frame.value);
});
onScopeDispose(() => { disposed = true; observer?.disconnect(); release(); });
</script>

<template>
  <component :is="passive ? 'div' : 'button'" ref="frame" type="button" class="recording-thumbnail" :disabled="passive ? undefined : disabled" :aria-label="passive ? '录像封面' : '预览录像'" :title="passive ? undefined : '预览录像'" @click="!passive && emit('preview')">
    <canvas ref="canvas" v-show="ready" aria-hidden="true" />
    <Play :size="24" aria-hidden="true" />
  </component>
</template>

<style scoped>
.recording-thumbnail { position: relative; display: grid; place-items: center; flex: 0 0 120px; width: 120px; height: 68px; padding: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 6px; background: var(--background); }
.recording-thumbnail canvas { max-width: 100%; max-height: 100%; }
.recording-thumbnail svg { position: absolute; padding: 6px; box-sizing: content-box; border-radius: 50%; background: #171c22cc; color: #e1e6eb; }
</style>
