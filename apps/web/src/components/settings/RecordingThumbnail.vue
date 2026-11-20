<script setup lang="ts">
import { onMounted, onScopeDispose, ref, watch } from 'vue';
import { Film, Play } from '@lucide/vue';
import { loadRecordingThumbnail, recordingThumbnailDuration } from '../../recording/recordingThumbnails';

const props = defineProps<{ source: string; disabled: boolean; playBadge?: boolean }>();
const emit = defineEmits<{ duration: [milliseconds: number] }>();
const frame = ref<HTMLElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const ready = ref(false);
const failed = ref(false);
let disposed = false;
let observer: IntersectionObserver | undefined;
let request: AbortController | undefined;
let visible = false;
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
    const duration = recordingThumbnailDuration(cover);
    if (duration !== undefined) emit('duration', duration);
  } catch {
    if (!current.signal.aborted && request === current) failed.value = true;
  } finally { if (request === current) request = undefined; }
}
watch(() => [props.source, props.disabled], () => {
  release();
  ready.value = false;
  failed.value = false;
  if (visible) void load();
});
onMounted(() => {
  observer = new IntersectionObserver(entries => {
    visible = entries.some(entry => entry.isIntersecting);
    if (visible) void load();
    else release();
  });
  if (frame.value) observer.observe(frame.value);
});
onScopeDispose(() => { disposed = true; observer?.disconnect(); release(); });
</script>

<template>
  <span ref="frame" class="recording-thumbnail" aria-hidden="true">
    <canvas ref="canvas" v-show="ready" aria-hidden="true" />
    <Play v-if="playBadge" class="play-badge" :size="24" aria-hidden="true" />
    <slot v-else-if="!ready"><Film :size="18" aria-hidden="true" /></slot>
  </span>
</template>

<style scoped>
.recording-thumbnail { position: relative; display: grid; place-items: center; flex: 0 0 120px; width: 120px; height: 68px; padding: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 6px; background: var(--background); }
.recording-thumbnail canvas { max-width: 100%; max-height: 100%; }
.play-badge { position: absolute; padding: 6px; box-sizing: content-box; border-radius: 50%; background: #171c22cc; color: #e1e6eb; }
</style>
