<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onScopeDispose, ref, watch } from 'vue';
import { useRecordingLibrary } from '../../recording/useRecordingLibrary';
import { RECORDING_SHARE } from '../../recording/useRecordingShare';
import ExpandSection from '../ExpandSection.vue';
import { ChevronUp, ChevronDown, FolderOpen, Forward, Trash2 } from '@lucide/vue';
import SegmentedControl from '../SegmentedControl.vue';
import DialogTransition from '../DialogTransition.vue';
import RecordingPreview from './RecordingPreview.vue';
import RecordingThumbnail from './RecordingThumbnail.vue';
import InlineFeedback from '../InlineFeedback.vue';
import { useBackdropDismiss } from '../useBackdropDismiss';
import { keepDialogFocus } from '../dialogFocus';

const props = defineProps<{ status: DesktopRecordingStatus }>();
const emit = defineEmits<{ close: [] }>();
const share = inject(RECORDING_SHARE);
const expandedUnavailable = ref(false);
const filters = [{ id: 'all', label: '全部' }, { id: 'recording', label: '录制' }, { id: 'replay', label: '回放' }, { id: 'clip', label: '剪辑' }] as const;
const kindLabel = (entry: RecordingLibraryEntry) => ({ recording: '录制', replay: '回放', clip: '剪辑' }[entry.kind ?? 'recording']);
const title = (entry: RecordingLibraryEntry) => `${entry.applicationName || '未命名'} · ${kindLabel(entry)}`;
const preview = ref<{ entry: RecordingLibraryEntry; autoplay: boolean } | null>(null);
const recordingSource = (id: string) => `lycan://app/recordings/${encodeURIComponent(id)}`;
const canPreview = (entry: RecordingLibraryEntry) => entry.state !== 'recording' && entry.availability === 'available' && (entry.bytes ?? 0) > 0;
const dialog = ref<HTMLElement | null>(null);
const content = ref<HTMLElement | null>(null);
const backdropEvents = useBackdropDismiss(() => emit('close'));
const library = useRecordingLibrary();
const { entries, hasMore, loading, pendingId, notice } = library;
const unavailable = computed(() => entries.value.filter(entry => entry.state !== 'recording' && entry.availability !== 'available'));
const groups = computed(() => {
  const result: { date: string; items: RecordingLibraryEntry[] }[] = [];
  for (const entry of entries.value.filter(item => !unavailable.value.includes(item))) {
    const date = new Date(entry.createdAt).toLocaleDateString();
    const group = result.find(item => item.date === date);
    if (group) group.items.push(entry); else result.push({ date, items: [entry] });
  }
  return result;
});
let displayedKind = library.kind.value;
watch(entries, async () => {
  const viewport = content.value;
  if (!viewport) return;
  const switched = displayedKind !== library.kind.value;
  displayedKind = library.kind.value;
  const top = viewport.getBoundingClientRect().top;
  const rows = [...viewport.querySelectorAll<HTMLElement>('[data-recording-id]')];
  const anchor = rows.find(row => row.getBoundingClientRect().bottom > top);
  const id = anchor?.dataset.recordingId;
  const offset = anchor ? anchor.getBoundingClientRect().top - top : 0;
  const previousTop = viewport.scrollTop;
  await nextTick();
  if (content.value !== viewport) return;
  if (switched) { viewport.scrollTop = 0; return; }
  const current = [...viewport.querySelectorAll<HTMLElement>('[data-recording-id]')].find(row => row.dataset.recordingId === id);
  if (current) viewport.scrollTop += current.getBoundingClientRect().top - viewport.getBoundingClientRect().top - offset;
  else viewport.scrollTop = previousTop;
});
watch(library.kind, () => { void library.load(); });
function previewSavedClip(clip: RecordingLibraryEntry) {
  preview.value = { entry: clip, autoplay: false };
  void library.load();
}
async function returnToList() {
  const id = preview.value?.entry.id;
  preview.value = null;
  await nextTick();
  const opener = id && dialog.value?.querySelector<HTMLButtonElement>(`[data-recording-id="${CSS.escape(id)}"] .library-preview:enabled`);
  (opener || dialog.value)?.focus({ preventScroll: true });
}
function openExternalPreview() {
  const entry = preview.value?.entry;
  if (!entry) return;
  preview.value = null;
  void library.file(entry, 'play');
}
function duration(milliseconds: number | null) {
  if (milliseconds === null) return '时长未知';
  const seconds = Math.floor(milliseconds / 1000);
  return (seconds >= 3600 ? `${Math.floor(seconds / 3600)}:` : '')
    + `${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function state(entry: RecordingLibraryEntry) {
  if (entry.state === 'recording') return '录制处理中';
  if (entry.availability === 'missing') return '原片已移动或删除';
  if (entry.availability === 'changed') return '原片已被替换';
  if (entry.availability === 'unavailable') return '暂时无法读取';
  return entry.state === 'saved' ? '已保存' : '保存未确认，请检查原片';
}
watch(() => [props.status.recordingId, props.status.phase, props.status.replay?.lastSavedId], () => { void library.load(); });
watch([entries, notice], () => {
  // 重试按钮或已删除的录像退场后，将丢失的键盘焦点留在管理器内。
  if (document.activeElement === document.body && !dialog.value?.inert) dialog.value?.focus();
}, { flush: 'post' });
function refreshOnReturn() {
  if (!loading.value && !pendingId.value) void library.load();
}
onMounted(() => { dialog.value?.focus(); void library.load(); window.addEventListener('focus', refreshOnReturn); });
onScopeDispose(() => window.removeEventListener('focus', refreshOnReturn));
</script>

<template>
  <div class="dialog-backdrop" v-on="backdropEvents" @keydown.esc.stop="emit('close')">
    <section ref="dialog" class="recording-library-dialog" role="dialog" aria-modal="true" aria-labelledby="recording-library-title" tabindex="-1" @keydown="keepDialogFocus">
      <h2 id="recording-library-title">本地录像管理器</h2>
      <p class="library-intro">查看录制和回放，截取精彩片段，分享给群里的朋友。</p>
      <SegmentedControl v-model="library.kind.value" :options="filters" label="录像类型" />
      <div ref="content" class="recording-library-content">
        <InlineFeedback :message="notice" :pending="loading ? '正在读取录像列表…' : ''" />
        <button v-if="notice" :disabled="loading" @click="library.load()">重新读取</button>
        <p v-if="!entries.length && !loading && !notice">暂无录像。</p>
        <section v-for="group in groups" :key="group.date" class="library-day">
          <h3>{{ group.date }}</h3>
          <article v-for="entry in group.items" :key="entry.id" :data-recording-id="entry.id" class="library-row">
            <button type="button" class="library-preview" :aria-label="`播放 ${title(entry)}`" :disabled="!canPreview(entry)" @click="preview = { entry, autoplay: true }">
              <RecordingThumbnail play-badge :source="recordingSource(entry.id)" :disabled="!canPreview(entry)" @duration="library.updateDuration(entry, $event)" />
              <span class="library-description">
                <strong>{{ title(entry) }}</strong>
                <small>{{ duration(entry.durationMs) }}<template v-if="entry.bytes !== null"> · {{ (entry.bytes / 1024 / 1024).toFixed(1) }} MiB</template></small>
                <small v-if="entry.state !== 'saved'">{{ state(entry) }}</small>
              </span>
            </button>
            <div class="library-actions">
              <button type="button" aria-label="分享" title="分享" :disabled="!canPreview(entry)" @click="share?.select(entry)"><Forward :size="16" /><span>分享</span></button>
              <button type="button" class="settings-button library-icon" aria-label="在文件夹中显示" title="在文件夹中显示" :disabled="!!pendingId || !canPreview(entry)" @click="library.file(entry, 'reveal')"><FolderOpen :size="16" /></button>
              <button type="button" class="settings-button library-icon library-delete" aria-label="删除录像" title="删除录像" :disabled="!!pendingId || entry.state === 'recording'" @click="library.file(entry, 'delete')"><Trash2 :size="16" /></button>
            </div>
          </article>
        </section>
        <section v-if="unavailable.length" class="library-unavailable">
          <ExpandSection :open="expandedUnavailable">
            <article v-for="entry in unavailable" :key="entry.id" :data-recording-id="entry.id" class="library-row">
              <div class="library-description"><strong>{{ title(entry) }}</strong><small>{{ new Date(entry.createdAt).toLocaleDateString() }} · {{ state(entry) }}</small></div>
              <button v-if="entry.availability === 'changed'" :disabled="!!pendingId" @click="library.file(entry, 'relink')">重新关联</button>
              <button :disabled="!!pendingId" @click="library.file(entry, 'delete')">移除记录</button>
            </article>
            <button v-if="unavailable.some(entry => ['missing', 'changed'].includes(entry.availability))" :disabled="!!pendingId" @click="library.file(unavailable[0]!, 'clearUnavailable')">清理失效记录</button>
          </ExpandSection>
          <button class="library-disclosure" :aria-expanded="expandedUnavailable" @click="expandedUnavailable = !expandedUnavailable"><component :is="expandedUnavailable ? ChevronUp : ChevronDown" :size="12" />{{ expandedUnavailable ? '收起' : '查看' }}无法读取的记录（{{ unavailable.length }}）</button>
        </section>
        <button v-if="hasMore" :disabled="loading || !!pendingId" @click="library.load(true)">加载更多</button>
      </div>
      <footer class="card-actions">
        <button @click="emit('close')">关闭</button>
      </footer>
    </section>
    <DialogTransition>
      <div v-if="preview" class="dialog-backdrop">
        <RecordingPreview :key="preview.entry.id" :entry="preview.entry" :source="recordingSource(preview.entry.id)" :autoplay="preview.autoplay" @back="returnToList" @external="openExternalPreview" @saved="previewSavedClip" />
      </div>
    </DialogTransition>
  </div>
</template>

<style scoped>
.recording-library-dialog { display: flex; flex-direction: column; gap: 16px; width: min(760px, calc(100vw - 32px)); height: min(700px, calc(100vh - 48px)); box-sizing: border-box; padding: 24px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
h2 { margin: 0; font-size: 22px; line-height: 32px; }
.library-intro { margin: 0; color: var(--muted); font-size: 13px; }
.recording-library-content { flex: 1; min-height: 0; overflow-y: auto; padding-right: 8px; }
.card-actions { flex-shrink: 0; }
.library-day h3 { margin: 16px 0 4px; color: var(--muted); font-size: 12px; font-weight: 400; }
.library-row { display: flex; align-items: center; gap: 12px; padding: 10px 0; }
.library-preview { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; padding: 0; border: 0; border-radius: 6px; text-align: left; background: transparent; cursor: pointer; }
.library-preview:is(:hover, :focus-visible):enabled strong { text-decoration: underline; }
.library-preview:disabled { cursor: default; }
.library-description { flex: 1; min-width: 0; display: grid; gap: 6px; }
.library-description strong { font-size: 14px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.library-description small { color: var(--muted); font-size: 12px; }
.library-actions { display: flex; flex-shrink: 0; gap: 6px; }
.library-actions button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-width: 32px; height: 32px; }
.library-actions .library-icon { width: 32px; padding: 0; }
.library-actions .library-delete { color: var(--danger); }
@media (max-width: 640px) {
  .library-actions span { display: none; }
  .library-actions button { padding: 0; }
  .library-preview { gap: 8px; }
  .library-preview .recording-thumbnail { width: 72px; height: 42px; flex-basis: 72px; }
}
.library-unavailable { border-top: 1px solid var(--border); margin-top: 16px; padding-top: 8px; }
.library-disclosure { display: flex; align-items: center; gap: 4px; border: 0; padding-left: 0; color: var(--muted); background: transparent; }
</style>
