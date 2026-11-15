<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref } from 'vue';
import { Download, Music2, X } from '@lucide/vue';
import { downloadFile, fetchAttachment, fetchFilePreview, type ChatAttachment } from '../chat/chatApi';
import { chatMediaFormat } from '../chat/chatMedia';
import { useLoadingHint } from './useLoadingHint';
import { useBackdropDismiss } from './useBackdropDismiss';
import { keepDialogFocus } from './dialogFocus';
import ChatImageSurface from './ChatImageSurface.vue';

const props = defineProps<{ groupId: string; attachment: ChatAttachment; imageMessage: boolean; previewBlob?: Blob }>();
const emit = defineEmits<{ close: [] }>();
const format = computed(() => chatMediaFormat(props.attachment));
const title = computed(() => props.attachment.fileName || '图片');
const source = ref('');
const error = ref('');
const previewFailed = ref(false);
const loading = ref(false);
const downloading = ref(false);
const closeButton = ref<HTMLButtonElement | null>(null);
const player = ref<HTMLMediaElement | null>(null);
const loadingHint = useLoadingHint(() => loading.value);
const backdropEvents = useBackdropDismiss(close);
let request: AbortController | undefined;
let downloadRequest: AbortController | undefined;
let disposed = false;

function release() {
  player.value?.pause();
  player.value?.removeAttribute('src');
  player.value?.load();
  if (source.value) URL.revokeObjectURL(source.value);
  source.value = '';
}

function close() {
  disposed = true;
  request?.abort();
  downloadRequest?.abort();
  release();
  emit('close');
}

async function load() {
  if (disposed) return;
  request?.abort();
  const current = request = new AbortController();
  release();
  error.value = '';
  previewFailed.value = false;
  loading.value = true;
  try {
    const blob = props.previewBlob ?? (props.imageMessage
      ? await fetchAttachment(props.groupId, props.attachment.id, current.signal)
      : await fetchFilePreview(props.groupId, props.attachment.id, current.signal));
    if (disposed || current.signal.aborted || request !== current) return;
    source.value = URL.createObjectURL(blob.slice(0, blob.size, format.value?.contentType || blob.type));
  } catch (reason) {
    if (!current.signal.aborted && !disposed) error.value = reason instanceof Error ? reason.message : '无法加载文件，请重试。';
  } finally {
    if (request === current) loading.value = false;
  }
}

async function download() {
  if (downloading.value) return;
  if (props.imageMessage) {
    if (!source.value) return;
    const link = document.createElement('a');
    link.href = source.value;
    link.download = props.attachment.fileName || `图片.${props.attachment.contentType === 'image/png' ? 'png' : 'jpg'}`;
    link.click();
    return;
  }
  const current = downloadRequest = new AbortController();
  downloading.value = true;
  try {
    await downloadFile(props.groupId, props.attachment, current.signal, () => {});
  } catch (reason) {
    if (!current.signal.aborted && !(reason instanceof DOMException && reason.name === 'AbortError')) {
      error.value = reason instanceof Error ? reason.message : '文件下载失败';
    }
  } finally { if (!disposed) downloading.value = false; }
}

function playbackFailed() {
  if (!disposed) { previewFailed.value = true; error.value = '这个文件暂时无法预览，可以下载后打开。'; }
}
onMounted(() => { closeButton.value?.focus(); void load(); });
onScopeDispose(() => {
  disposed = true;
  request?.abort();
  downloadRequest?.abort();
  release();
});
</script>

<template>
  <div class="dialog-backdrop chat-media-backdrop" v-on="backdropEvents" @keydown.esc.stop="close">
    <section class="chat-media-viewer" :class="{ 'is-image': format?.kind === 'image' }" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1" @keydown="keepDialogFocus">
      <header v-if="format?.kind !== 'image' || !source || previewFailed">
        <strong id="chat-media-title" :title="title">{{ title }}</strong>
        <button type="button" aria-label="下载文件" title="下载文件" :disabled="downloading || (imageMessage && !source)" @click="download"><Download :size="18" /></button>
        <button ref="closeButton" type="button" aria-label="关闭查看器" title="关闭" @click="close"><X :size="18" /></button>
      </header>
      <div class="chat-media-stage" :aria-busy="loading">
        <ChatImageSurface v-if="source && format?.kind === 'image' && !previewFailed" :source="source" :title="title" @close="close" @download="download" @error="playbackFailed" />
        <video v-else-if="source && format?.kind === 'video'" ref="player" :src="source" controls playsinline preload="metadata" tabindex="0" @error="playbackFailed" />
        <div v-else-if="source && format?.kind === 'audio'" class="chat-media-audio">
          <Music2 :size="64" aria-hidden="true" />
          <audio ref="player" :src="source" controls preload="metadata" tabindex="0" @error="playbackFailed" />
        </div>
        <span v-else-if="loadingHint" role="status">正在加载…</span>
      </div>
      <footer v-if="error" class="chat-media-feedback"><span role="alert">{{ error }}</span><button v-if="!source" type="button" @click="load">重试</button></footer>
    </section>
  </div>
</template>

<style scoped>
.chat-media-viewer { display: flex; flex-direction: column; width: min(1100px, calc(100vw - 48px)); height: min(780px, calc(100dvh - 48px)); min-width: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
.chat-media-viewer header { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
.chat-media-viewer header strong { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.chat-media-viewer header button { display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--muted); }
.chat-media-viewer header button:hover { background: var(--panel-raised); color: var(--text); }
.chat-media-stage { display: flex; align-items: center; justify-content: center; flex: 1; min-height: 0; overflow: auto; background: var(--background); color: var(--muted); }
.chat-media-stage > img, .chat-media-stage > video { display: block; max-width: 100%; max-height: 100%; object-fit: contain; }
.chat-media-stage > video { width: 100%; height: 100%; }
.chat-media-viewer.is-image { width: 100vw; height: 100dvh; border: 0; border-radius: 0; background: transparent; }
.chat-media-viewer.is-image .chat-media-stage { background: transparent; }
.chat-media-viewer.is-image .chat-media-feedback { position: absolute; z-index: 2; bottom: 80px; align-self: center; max-width: calc(100vw - 48px); border: 1px solid var(--border); border-radius: 6px; background: var(--panel); }
.chat-media-audio { display: grid; justify-items: center; gap: 28px; width: min(440px, 90%); }
.chat-media-audio audio { width: 100%; }
.chat-media-feedback { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-top: 1px solid var(--border); color: var(--danger); font-size: 13px; }
</style>
