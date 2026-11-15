<script setup lang="ts">
import { computed, inject, onScopeDispose, ref } from 'vue';
import { RECORDING_SHARE } from '../../recording/useRecordingShare';
import MediaVideoSurface from '../MediaVideoSurface.vue';
import InlineFeedback from '../InlineFeedback.vue';
import { useBackdropDismiss } from '../useBackdropDismiss';
import { keepDialogFocus } from '../dialogFocus';

const props = defineProps<{ source: string; entry: RecordingLibraryEntry }>();
const emit = defineEmits<{ close: []; external: []; saved: [] }>();
const share = inject(RECORDING_SHARE);
const surface = ref<InstanceType<typeof MediaVideoSurface> | null>(null);
const failed = ref(false);
const editing = ref(false);
const duration = ref(0);
const start = ref(0);
const end = ref(0);
const busy = ref(false);
const progress = ref(0);
const error = ref('');
const saved = ref<RecordingLibraryEntry | null>(null);
const previewingRange = ref(false);
const desktop = window.lycanDesktop;
let requestId = '';
let disposed = false;
const rangeStyle = computed(() => ({ '--start': `${start.value / duration.value * 100}%`, '--end': `${end.value / duration.value * 100}%` }));
const unsubscribe = desktop?.onRecordingClipProgress?.(event => { if (event.requestId === requestId) progress.value = event.percent; });
function metadata(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  duration.value = seconds; end.value = seconds;
}
function seekRange(edge: 'start' | 'end') {
  saved.value = null;
  previewingRange.value = false;
  if (!Number.isFinite(start.value)) start.value = 0;
  if (!Number.isFinite(end.value)) end.value = duration.value;
  if (edge === 'start') start.value = Math.max(0, Math.min(start.value, end.value - 0.1));
  else end.value = Math.min(duration.value, Math.max(end.value, start.value + 0.1));
  const video = surface.value?.player;
  if (video) { video.pause(); video.currentTime = edge === 'start' ? start.value : end.value; }
}
function reset() { start.value = 0; end.value = duration.value; saved.value = null; seekRange('start'); }
function previewRange() {
  const video = surface.value?.player;
  if (video) { video.currentTime = start.value; previewingRange.value = true; void video.play().catch(() => { error.value = '暂时无法播放，请重试。'; }); }
}
function timeChanged(seconds: number) {
  if (previewingRange.value && seconds >= end.value) { surface.value?.player?.pause(); previewingRange.value = false; }
}
async function save(andShare = false) {
  if (!desktop || busy.value) return;
  if (saved.value) { if (andShare) share?.select(saved.value); return; }
  surface.value?.player?.pause();
  requestId = crypto.randomUUID(); busy.value = true; error.value = ''; progress.value = 0;
  try {
    const clip = await desktop.exportRecordingClip(requestId, props.entry.id, Math.round(start.value * 1000), Math.round(end.value * 1000));
    if (disposed) return;
    saved.value = clip; emit('saved');
    if (andShare) share?.select(clip);
  } catch (reason) {
    if (!disposed) error.value = reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : '片段保存失败，请重试。';
  } finally { if (!disposed) { busy.value = false; requestId = ''; } }
}
onScopeDispose(() => { disposed = true; unsubscribe?.(); if (requestId) void desktop?.cancelRecordingClip(requestId).catch(() => {}); });
const backdropEvents = useBackdropDismiss(() => emit('close'));
</script>

<template>
  <div class="dialog-backdrop" v-on="backdropEvents" @keydown.esc.stop="emit('close')">
    <section class="media-viewer-shell" role="dialog" aria-modal="true" aria-label="录像预览" tabindex="-1" @keydown="keepDialogFocus">
      <MediaVideoSurface ref="surface" :source="source" :class="{ 'is-editing': editing }" @metadata="metadata" @time="timeChanged" @close="emit('close')" @error="failed = true">
        <template #controls>
          <div class="recording-preview-controls">
            <template v-if="editing">
              <div class="clip-range" :style="rangeStyle">
                <span />
                <input v-model.number="start" aria-label="片段起点" type="range" min="0" :max="duration" step="0.01" :disabled="busy" @input="seekRange('start')" />
                <input v-model.number="end" aria-label="片段终点" type="range" min="0" :max="duration" step="0.01" :disabled="busy" @input="seekRange('end')" />
              </div>
              <div class="clip-time-fields">
                <label>起点 <input v-model.number="start" type="number" min="0" :max="end - 0.1" step="0.1" :disabled="busy" @change="seekRange('start')" /> 秒</label>
                <label>终点 <input v-model.number="end" type="number" :min="start + 0.1" :max="duration" step="0.1" :disabled="busy" @change="seekRange('end')" /> 秒</label>
                <span>{{ (end - start).toFixed(1) }} 秒</span>
              </div>
              <InlineFeedback :message="error" :pending="busy ? `正在保存片段 ${progress}%…` : ''" />
              <p v-if="saved" class="clip-saved">片段已保存到本地录像管理器。</p>
            </template>
            <div class="clip-actions">
              <template v-if="editing">
                <button v-if="busy" @click="desktop?.cancelRecordingClip(requestId)">取消保存</button>
                <button v-else @click="editing = false; error = ''; previewingRange = false">返回</button>
                <button :disabled="busy" @click="reset">重置</button>
                <button :disabled="busy" @click="previewRange">预览片段</button>
                <span class="clip-action-spacer" />
                <button :disabled="busy || !!saved" @click="save()">保存片段</button>
                <button class="confirm-button" :disabled="busy" @click="save(true)">{{ saved ? '分享片段' : '保存并分享' }}</button>
              </template>
              <template v-else>
                <button :disabled="failed || duration < 0.1" @click="editing = true">剪辑</button>
                <button @click="share?.select(entry)">分享到群聊</button>
              </template>
            </div>
          </div>
        </template>
      </MediaVideoSurface>
      <div v-if="failed" class="media-viewer-feedback" role="alert">暂时无法预览这个录像。<button type="button" @click="emit('external')">使用系统播放器</button></div>
    </section>
  </div>
</template>

<style scoped>
.recording-preview-controls { position: absolute; bottom: 20px; left: min(72px, 6vw); right: min(72px, 6vw); display: grid; gap: 10px; }
.clip-actions { display: flex; gap: 8px; justify-content: center; align-items: center; }
.clip-action-spacer { flex: 1; }
.is-editing :deep(.media-video-stage) { bottom: 230px; }
.clip-range { position: relative; height: 26px; }
.clip-range > span { position: absolute; inset: 10px 0; border-radius: 4px; background: linear-gradient(to right, var(--border) var(--start), var(--accent) var(--start), var(--accent) var(--end), var(--border) var(--end)); }
.clip-range input { position: absolute; inset: 0; width: 100%; margin: 0; appearance: none; background: transparent; pointer-events: none; }
.clip-range input::-webkit-slider-thumb { pointer-events: auto; appearance: none; width: 12px; height: 26px; border-radius: 3px; background: var(--text); cursor: ew-resize; }
.clip-time-fields { display: flex; gap: 20px; align-items: center; color: var(--muted); font-size: 13px; }
.clip-time-fields input { width: 86px; height: 32px; box-sizing: border-box; border: 1px solid var(--border); border-radius: 4px; padding: 4px 8px; background: var(--background); color: var(--text); }
.clip-saved { margin: 0; font-size: 13px; color: var(--muted); }
</style>
