<script setup lang="ts">
import { computed, onMounted, onScopeDispose, watch } from 'vue';
import { useRecordingLibrary } from '../../recording/useRecordingLibrary';
import InlineFeedback from '../InlineFeedback.vue';

const props = defineProps<{ status: DesktopRecordingStatus }>();
const library = useRecordingLibrary();
const { entries, hasMore, loading, pendingId, notice } = library;
const groups = computed(() => {
  const result: { id: string; createdAt: number; items: RecordingLibraryEntry[] }[] = [];
  for (const entry of entries.value) {
    const group = result.find(item => item.id === entry.sessionId);
    if (group) group.items.push(entry);
    else result.push({ id: entry.sessionId, createdAt: entry.createdAt, items: [entry] });
  }
  return result;
});
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
function refreshOnReturn() {
  if (!loading.value && !pendingId.value) void library.load();
}
onMounted(() => { void library.load(); window.addEventListener('focus', refreshOnReturn); });
onScopeDispose(() => window.removeEventListener('focus', refreshOnReturn));
</script>

<template>
  <section class="settings-block recording-library">
    <h2>本地录像</h2>
    <p>录像保存在本机，不会自动上传或清理，使用系统播放器打开。切换来源或画质时会分段保存。</p>
    <InlineFeedback :message="notice" :pending="loading ? '正在读取录像列表…' : ''" />
    <button v-if="notice" type="button" :disabled="loading || !!pendingId" @click="library.load()">重新读取</button>
    <p v-if="!entries.length && !loading && !notice">暂无录像记录。旧版保存的录像仍可在录像目录中找到。</p>
    <details v-for="group in groups" :key="group.id" :open="group.items.length === 1" class="library-session">
      <summary>{{ new Date(group.createdAt).toLocaleString() }}<small v-if="group.items.length > 1"> · {{ group.items.length }} 个文件段</small></summary>
      <ul>
        <li v-for="entry in group.items" :key="entry.id">
          <div class="library-description">
            <strong>{{ state(entry) }}</strong>
            <small>{{ new Date(entry.createdAt).toLocaleTimeString() }} · {{ duration(entry.durationMs) }} · {{ (entry.bytes / 1024 / 1024).toFixed(1) }} MiB<template v-if="entry.width && entry.height"> · {{ entry.width }} × {{ entry.height }}</template></small>
          </div>
          <div class="library-actions">
            <button type="button" :disabled="!!pendingId || entry.state === 'recording' || entry.availability !== 'available' || !entry.bytes" @click="library.file(entry, 'play')">播放</button>
            <button type="button" :disabled="!!pendingId || entry.state === 'recording' || entry.availability !== 'available' || !entry.bytes" @click="library.file(entry, 'reveal')">打开位置</button>
            <button type="button" class="settings-button" :disabled="!!pendingId || entry.state === 'recording'" @click="library.file(entry, 'delete')">{{ entry.availability === 'missing' || entry.availability === 'changed' ? '移除记录' : '删除' }}</button>
          </div>
        </li>
      </ul>
    </details>
    <button v-if="hasMore" type="button" :disabled="loading || !!pendingId" @click="library.load(true)">加载更多</button>
  </section>
</template>

<style scoped>
.library-session { border-top: 1px solid var(--border); padding: 12px 0; }
.library-session summary { cursor: pointer; font-size: 13px; }
.library-session small { color: var(--muted); }
.library-session ul { list-style: none; padding: 0; margin: 12px 0 0; }
.library-session li { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 12px; padding: 8px 0; }
.library-description { min-width: 0; display: grid; gap: 4px; }
.library-description strong { font-size: 13px; font-weight: 500; }
.library-description small { font-size: 12px; overflow-wrap: anywhere; }
.library-actions { display: flex; flex-wrap: wrap; gap: var(--button-gap); }
</style>
