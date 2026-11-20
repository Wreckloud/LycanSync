<script setup lang="ts">
import { computed, inject, onMounted, onScopeDispose, ref } from 'vue';
import { ArrowLeftToLine, ArrowRightToLine, Forward, Pause, Play, ScissorsLineDashed, SkipBack, X } from '@lucide/vue';
import { RECORDING_SHARE } from '../../recording/useRecordingShare';
import { recordingTime } from '../../recording/recordingTime';
import { keepDialogFocus } from '../dialogFocus';
import InlineFeedback from '../InlineFeedback.vue';
import RecordingTimeline from './RecordingTimeline.vue';
import RecordingTool from './RecordingTool.vue';

const props = defineProps<{ source: string; entry: RecordingLibraryEntry }>();
const emit = defineEmits<{ back: []; external: []; saved: [clip: RecordingLibraryEntry] }>();
const share = inject(RECORDING_SHARE);
const desktop = window.lycanDesktop;
const player = ref<HTMLVideoElement | null>(null);
const timeline = ref<InstanceType<typeof RecordingTimeline> | null>(null);
const workspace = ref<HTMLElement | null>(null);
const confirmation = ref<HTMLDialogElement | null>(null);
const failed = ref(false);
const editing = ref(false);
const playing = ref(false);
const duration = ref(0);
const aspectRatio = ref(16 / 9);
const cursor = ref(0);
const start = ref(0);
const end = ref(0);
const rate = ref(0);
const busy = ref(false);
const progress = ref(0);
const error = ref('');
const title = computed(() => (props.entry.applicationName || '未命名') + ' · ' + ({ recording: '录制', replay: '回放', clip: '剪辑' }[props.entry.kind ?? 'recording']));
const lastTime = computed(() => Math.min(duration.value, cursor.value + (rate.value ? 1 / rate.value : 0)));
const minLength = 0.1; // 桌面导出器的最短片段为 100 ms。
const validRange = computed(() => Math.round(end.value * 1000) - Math.round(start.value * 1000) >= 100);
let requestId = '';
let disposed = false;
let animation = 0;
let seekTimer: ReturnType<typeof setTimeout> | undefined;
let seekTarget: number | null = null;
function cancelSeek() {
  clearTimeout(seekTimer); seekTimer = undefined; seekTarget = null;
  player.value?.removeEventListener('seeked', flushSeek);
}
function flushSeek() {
  clearTimeout(seekTimer); seekTimer = undefined;
  const video = player.value;
  if (!video || seekTarget === null) return;
  if (video.seeking) { video.addEventListener('seeked', flushSeek, { once: true }); return; }
  const seconds = seekTarget;
  cancelSeek();
  video.currentTime = seconds;
}
function seek(seconds: number, precise: boolean) {
  player.value?.pause();
  cursor.value = seconds;
  seekTarget = seconds;
  if (precise) flushSeek();
  else if (seekTimer === undefined) seekTimer = setTimeout(flushSeek, 80);
}
function metadata(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  if (player.value?.videoHeight) aspectRatio.value = player.value.videoWidth / player.value.videoHeight;
  duration.value = seconds;
  if (!editing.value) end.value = seconds;
}
function endFrame() {
  return rate.value ? Math.max(start.value, (Math.ceil(end.value * rate.value - 1e-7) - 1) / rate.value) : end.value;
}
function snap(seconds: number, direction: 'nearest' | 'before' | 'after' = 'nearest') {
  if (!rate.value) return seconds;
  const frame = seconds * rate.value;
  if (direction === 'before') return Math.floor(frame + 1e-7) / rate.value;
  if (direction === 'after') return Math.ceil(frame - 1e-7) / rate.value;
  return Math.round(frame) / rate.value;
}
function position(marker: 'cursor' | 'start' | 'end', seconds: number, precise: boolean) {
  if (busy.value) return;
  const time = seconds >= duration.value ? duration.value : Math.max(0, Math.min(duration.value, snap(seconds)));
  if (marker === 'start') {
    start.value = Math.min(time, Math.max(0, snap(end.value - minLength, 'before')));
    seek(start.value, precise);
  } else if (marker === 'end') {
    end.value = Math.min(duration.value, Math.max(time, snap(start.value + minLength, 'after')));
    seek(endFrame(), precise);
  } else seek(time, precise);
}
function stopAtCursor() {
  const video = player.value;
  if (video && !video.paused) {
    cursor.value = video.currentTime;
    video.pause();
  }
}
function edit() {
  stopAtCursor();
  start.value = Math.max(0, snap(Math.min(cursor.value, duration.value - minLength), 'before'));
  end.value = Math.min(duration.value, snap(start.value + 12));
  editing.value = true;
  seek(start.value, true);
  workspace.value?.focus();
}
function mark(edge: 'start' | 'end') {
  stopAtCursor();
  const time = Math.min(duration.value, snap(cursor.value));
  if (edge === 'start' && end.value - time >= minLength) start.value = time;
  if (edge === 'end' && lastTime.value - start.value >= minLength) end.value = lastTime.value >= duration.value ? duration.value : Math.min(duration.value, snap(lastTime.value));
}
function step(marker: 'cursor' | 'start' | 'end', direction: number) {
  if (busy.value || !duration.value) return;
  if (player.value && !player.value.paused) {
    stopAtCursor();
    if (rate.value) seek(Math.floor(cursor.value * rate.value + 1e-6) / rate.value, true);
    return;
  }
  if (!rate.value) { error.value = '未能读取录像帧率，暂时无法逐帧定位。'; return; }
  const current = marker === 'start' ? start.value : marker === 'end' ? end.value : cursor.value;
  const next = Math.max(0, Math.min(duration.value, (Math.round(current * rate.value) + direction) / rate.value));
  timeline.value?.reveal(next);
  position(marker, next, true);
}
function play(fromStart = false) {
  const video = player.value;
  if (!video || busy.value || failed.value) return;
  if (!fromStart && !video.paused) { stopAtCursor(); return; }
  const target = editing.value && (fromStart || cursor.value < start.value || cursor.value >= endFrame())
    ? start.value : cursor.value >= duration.value ? 0 : cursor.value;
  cancelSeek();
  timeline.value?.reveal(target);
  video.currentTime = target;
  void video.play().catch(reason => {
    if (!disposed && reason.name !== 'AbortError') error.value = '暂时无法播放，请重试。';
  });
}
function syncClock() {
  const video = player.value;
  if (!video || video.seeking || seekTarget !== null) return;
  if (editing.value && !video.paused && video.currentTime >= end.value) seek(endFrame(), true);
  else cursor.value = video.currentTime;
}
function animate() {
  syncClock();
  if (player.value && !player.value.paused) animation = requestAnimationFrame(animate);
}
function playbackChanged() {
  cancelAnimationFrame(animation);
  playing.value = !!player.value && !player.value.paused;
  if (playing.value) animate();
}
function cancelEdit() {
  stopAtCursor(); cancelSeek(); editing.value = false; start.value = 0; end.value = duration.value; error.value = '';
  workspace.value?.focus();
}
function leave() {
  if (busy.value) return;
  stopAtCursor();
  if (editing.value && (start.value > 0 || end.value < duration.value)) confirmation.value?.showModal();
  else emit('back');
}
function keys(event: KeyboardEvent) {
  if (confirmation.value?.open || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  if (event.key === 'Escape') { event.stopPropagation(); leave(); }
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault(); step('cursor', event.key === 'ArrowLeft' ? -1 : 1);
  } else if (event.code === 'Space' && !(event.target as HTMLElement).closest('button')) {
    event.preventDefault(); if (!event.repeat) play();
  }
}
function shareRecording() { stopAtCursor(); cancelSeek(); share?.select(props.entry); }
const unsubscribe = desktop?.onRecordingClipProgress?.(event => { if (event.requestId === requestId) progress.value = event.percent; });
async function save() {
  if (!desktop || busy.value || !validRange.value) return;
  stopAtCursor(); cancelSeek(); busy.value = true; error.value = ''; progress.value = 0;
  requestId = crypto.randomUUID();
  try {
    const clip = await desktop.exportRecordingClip(requestId, props.entry.id, Math.round(start.value * 1000), Math.round(end.value * 1000));
    if (!disposed) emit('saved', clip);
  } catch (reason) {
    if (!disposed) error.value = reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : '片段保存失败，请重试。';
  } finally { requestId = ''; if (!disposed) busy.value = false; }
}
async function cancelSave() {
  try { await desktop?.cancelRecordingClip(requestId); }
  catch { if (!disposed) error.value = '未能取消保存，请重试。'; }
}
function playbackFailed() { failed.value = true; player.value?.pause(); }
onMounted(async () => {
  workspace.value?.focus();
  try {
    const fps = await desktop?.getRecordingFrameRate(props.entry.id);
    if (!disposed && fps && Number.isFinite(fps) && fps > 0) rate.value = fps;
  } catch { /* 仍可按时间拖动和导出；逐帧操作会提示缺少帧率。 */ }
});
onScopeDispose(() => {
  disposed = true; cancelSeek(); unsubscribe?.(); cancelAnimationFrame(animation);
  const video = player.value;
  if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
  if (requestId) void cancelSave();
});
</script>

<template>
  <section ref="workspace" class="recording-workspace" role="dialog" aria-modal="true" aria-label="录像预览" tabindex="-1" @keydown="keepDialogFocus($event); keys($event)">
    <RecordingTool label="返回录像列表" class="close" :disabled="busy" @click="leave()"><X :size="24" /></RecordingTool>
    <div class="stage">
      <video v-if="!failed" ref="player" :src="source" :style="{ '--ratio': aspectRatio }" preload="metadata" playsinline @click="play()" @play="playbackChanged"
        @pause="playbackChanged" @timeupdate="syncClock" @ended="playbackChanged" @error="playbackFailed"
        @loadedmetadata="player?.videoWidth ? metadata(player.duration) : playbackFailed()" />
      <div v-else>暂时无法预览这个录像。<button @click="emit('external')">使用系统播放器</button></div>
    </div>
    <div class="dock">
      <InlineFeedback :message="error" :pending="busy ? `正在保存片段 ${progress}%…` : ''" />
      <div class="info"><strong>{{ title }}</strong>
        <span v-if="editing" class="selection">选区 {{ recordingTime(start, true) }} – {{ recordingTime(end, true) }}<span class="length">时长 {{ recordingTime(end - start, true) }}</span></span>
        <span class="clock">{{ recordingTime(cursor, editing) }} / {{ recordingTime(duration) }}</span></div>
      <RecordingTimeline ref="timeline" :source="source" :duration="duration" :cursor="cursor" :start="start" :end="end"
        :editing="editing" :playing="playing" :disabled="busy || failed" @position="position" @step="step" />
      <div class="tools">
        <div class="center">
          <RecordingTool v-if="editing" label="从选区开头播放" class="restart" :disabled="busy" @click="play(true)"><SkipBack :size="17" /></RecordingTool>
          <RecordingTool v-if="editing" label="设为起点" :disabled="busy || end - cursor < minLength" @click="mark('start')"><ArrowLeftToLine :size="18" /></RecordingTool>
          <RecordingTool v-else label="剪辑" :disabled="failed || duration < minLength" @click="edit"><ScissorsLineDashed :size="19" /></RecordingTool>
          <RecordingTool :label="playing ? '暂停' : editing ? '播放选段' : '播放'" :disabled="busy || failed || !duration" @click="play()"><component :is="playing ? Pause : Play" :size="16" fill="currentColor" /></RecordingTool>
          <RecordingTool v-if="editing" label="设为终点" :disabled="busy || lastTime - start < minLength" @click="mark('end')"><ArrowRightToLine :size="18" /></RecordingTool>
          <RecordingTool v-else label="分享到群聊" @click="shareRecording"><Forward :size="19" /></RecordingTool>
        </div>
        <div v-if="editing" class="actions"><button @click="busy ? cancelSave() : cancelEdit()">{{ busy ? '取消保存' : '取消' }}</button>
          <button class="confirm-button" :disabled="busy || !validRange" @click="save">保存片段</button></div>
      </div>
    </div>
    <dialog ref="confirmation" class="discard" @keydown.esc.stop>
      <h3>选区尚未保存</h3><p>放弃这次选区并返回录像列表？</p>
      <footer><button autofocus @click="confirmation?.close()">继续编辑</button><button @click="emit('back')">放弃并返回</button></footer>
    </dialog>
  </section>
</template>

<style scoped>
.recording-workspace { position: fixed; inset: 0; z-index: 1; box-sizing: border-box; display: grid; grid-template-rows: minmax(0,1fr) auto; gap: 12px; padding: 60px min(72px,6vw) 27px; background: #080a0c; color: var(--text); outline: none; }
.stage { min-height: 0; display: grid; place-items: center; container-type: size; }
video { display: block; width: min(100cqw, calc(100cqh * var(--ratio))); height: auto; max-width: 100cqw; max-height: 100cqh; border-radius: 8px; object-fit: contain; cursor: pointer; }
.close { position: absolute; top: 18px; right: 18px; border-radius: 50%; background: #171c22; }
.close :deep(.tool-tag) { left: auto; right: 0; transform: none; }
.dock { min-width: 0; }.info { display: flex; align-items: baseline; gap: 12px; min-height: 20px; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.info strong { font-size: 14px; font-weight: 550; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.info span { white-space: nowrap; }.clock { margin-left: auto; }.length { margin-left: 12px; }
.dock:has(.selection) .tools { margin-top: 5px; }
.tools { display: grid; grid-template-columns: minmax(0,1fr) auto minmax(0,1fr); align-items: center; }
.center,.actions { display: flex; align-items: center; }.center { grid-column: 2; position: relative; border-radius: 6px; background: #171c22; }
.restart { position: absolute; right: calc(100% + 5px); background: #171c22; }
.actions { justify-self: end; gap: 6px; }.actions button { padding: 5px 10px; }
.actions .confirm-button:enabled { background: var(--accent); color: white; border-color: var(--accent); }
.discard { padding: 20px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: var(--text); }.discard::backdrop { background: #080a0cc9; }.discard h3 { margin: 0; }.discard footer { display: flex; justify-content: flex-end; gap: 8px; }
@media(max-width:600px) { .recording-workspace { padding: 52px 14px 26px; }.info { flex-wrap: wrap; gap: 4px 10px; }.selection { order: 1; flex-basis: 100%; }.info strong { flex: 1; }.tools { display: flex; justify-content: center; }.tools:has(.actions) { justify-content: space-between; padding-left: 44px; } }
@media(max-width:350px) { .tools:has(.actions) { flex-wrap: wrap; gap: 6px; }.actions { margin-left: auto; } }
</style>
