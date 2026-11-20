<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { ChevronDown, ChevronUp } from '@lucide/vue';
import type { GroupSummary } from '../../group/groupApi';
import type { useRecordingShare } from '../../recording/useRecordingShare';
import RecordingThumbnail from './RecordingThumbnail.vue';
import MediaVideoSurface from '../MediaVideoSurface.vue';
import ExpandSection from '../ExpandSection.vue';
import defaultAvatar from '../../../../../services/api/src/main/resources/account/default.png';
import { keepDialogFocus } from '../dialogFocus';
import { useBackdropDismiss } from '../useBackdropDismiss';

const props = defineProps<{ share: ReturnType<typeof useRecordingShare>; groups: GroupSummary[] }>();
const dialog = ref<HTMLElement | null>(null);
const previewButton = ref<HTMLButtonElement | null>(null);
const search = ref<HTMLInputElement | null>(null);
const query = ref('');
const expanded = ref(false);
const preview = ref(false);
const previewError = ref(false);
const hasMore = computed(() => props.groups.length > 4);
const groups = computed(() => expanded.value && hasMore.value
  ? props.groups.filter(group => group.name.toLowerCase().includes(query.value.trim().toLowerCase()))
  : props.groups.slice(0, 4));
function close() { props.share.visible.value = false; }
const backdropEvents = useBackdropDismiss(() => { if (!preview.value) close(); });
async function toggleMore() {
  expanded.value = !expanded.value;
  query.value = '';
  if (expanded.value) { await nextTick(); search.value?.focus(); }
}
watch(preview, async visible => { if (!visible) { await nextTick(); previewButton.value?.focus({ preventScroll: true }); } });
onMounted(() => dialog.value?.focus());
</script>

<template>
  <div class="dialog-backdrop" v-on="backdropEvents" @keydown.esc.stop="preview ? preview = false : close()">
    <section ref="dialog" class="recording-share-dialog" role="dialog" aria-modal="true" aria-label="分享到群聊" tabindex="-1" :inert="preview" @keydown="keepDialogFocus">
      <h2>分享到群聊</h2>
      <button v-if="share.entry.value" ref="previewButton" type="button" class="share-recording" :aria-label="`预览 ${share.entry.value.applicationName || '录像'}`" @click="previewError = false; preview = true">
        <RecordingThumbnail play-badge :disabled="false" :source="`lycan://app/recordings/${share.entry.value.id}`" />
        <span>{{ share.entry.value.applicationName || '录像' }}<small>选择群聊后添加到待发送附件</small></span>
      </button>
      <div class="share-destinations">
        <div class="share-list-heading">
          <span>选择群聊</span>
          <button v-if="hasMore" class="share-more" type="button" :aria-expanded="expanded" @click="toggleMore">
            {{ expanded ? '收起' : '更多群聊' }}<component :is="expanded ? ChevronUp : ChevronDown" :size="14" />
          </button>
        </div>
        <ExpandSection :open="expanded && hasMore">
          <input ref="search" v-model="query" type="search" aria-label="搜索群聊" placeholder="搜索群聊" />
        </ExpandSection>
        <div class="share-groups">
          <button v-for="group in groups" :key="group.id" type="button" @click="share.choose(group.id)">
            <img :src="group.avatar || defaultAvatar" alt="" /><span>{{ group.name }}</span>
          </button>
          <p v-if="!groups.length">{{ query.trim() ? '没有匹配的群聊' : '暂无可分享的群聊' }}</p>
        </div>
      </div>
      <footer class="card-actions card-actions-no-primary"><button type="button" @click="close">取消</button></footer>
    </section>
    <section v-if="preview && share.entry.value" class="media-viewer-shell" role="dialog" aria-modal="true" aria-label="分享录像预览" @keydown="keepDialogFocus">
      <MediaVideoSurface :source="`lycan://app/recordings/${share.entry.value.id}`" @close="preview = false" @error="previewError = true" />
      <p v-if="previewError" class="media-viewer-feedback" role="alert">暂时无法预览此录像。</p>
    </section>
  </div>
</template>

<style scoped>
.recording-share-dialog { width: min(440px, calc(100vw - 32px)); max-height: calc(100dvh - 48px); box-sizing: border-box; padding: 24px; display: flex; flex-direction: column; gap: 20px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
h2 { margin: 0; font-size: 22px; line-height: 32px; }
.share-recording { display: flex; gap: 14px; align-items: center; min-width: 0; padding: 0; border: 0; border-radius: 6px; background: transparent; text-align: left; cursor: pointer; }
.share-recording:is(:hover, :focus-visible) { background: var(--panel-soft); }
.share-recording :deep(.recording-thumbnail) { width: 96px; height: 54px; flex-basis: 96px; }
.share-recording > span { min-width: 0; overflow-wrap: anywhere; font-size: 14px; }
small { display: block; color: var(--muted); font-size: 12px; margin-top: 6px; }
.share-destinations { min-height: 0; overflow-y: auto; }
.share-list-heading { display: flex; align-items: center; justify-content: space-between; min-height: 28px; margin-bottom: 8px; font-size: 13px; color: var(--muted); }
.share-more { display: inline-flex; align-items: center; gap: 4px; border: 0; padding: 4px 0 4px 8px; background: transparent; color: var(--muted); font-size: 12px; cursor: pointer; }
.share-more:hover, .share-more:focus-visible { color: var(--text); }
input { width: 100%; box-sizing: border-box; margin-bottom: 8px; padding: 7px 9px; border: 1px solid var(--border); border-radius: 5px; background: var(--background); color: var(--text); font-size: 13px; }
input:focus { border-color: var(--accent); }
.share-groups { max-height: 280px; overflow-y: auto; }
.share-groups button { display: flex; gap: 12px; align-items: center; justify-content: flex-start; width: 100%; border: 0; background: transparent; padding: 8px; text-align: left; }
.share-groups button:hover, .share-groups button:focus-visible { background: var(--panel-soft); }
.share-groups img { width: 32px; height: 32px; border-radius: 5px; }
.share-groups span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-actions, h2, .share-recording { flex-shrink: 0; }
p { font-size: 13px; color: var(--muted); }
</style>
