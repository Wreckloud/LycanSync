<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref } from 'vue';
import { Download, Music2, X } from '@lucide/vue';
import { desktopMediaUrl, downloadFile, fetchAttachment, fetchFilePreview, fetchCompatibleVideo, videoPreviewStatus, type ChatAttachment } from '../chat/chatApi';
import { chatMediaFormat } from '../chat/chatMedia';
import { useLoadingHint } from './useLoadingHint';
import { useBackdropDismiss } from './useBackdropDismiss';
import { keepDialogFocus } from './dialogFocus';
import MediaVideoSurface from './MediaVideoSurface.vue';
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
const converting = ref(false);
const compatible = ref(false);
const conversionStatus = ref('');
const conversionHint = useLoadingHint(() => converting.value);
const closeButton = ref<HTMLButtonElement | null>(null);
const player = ref<HTMLMediaElement | null>(null);
const loadingHint = useLoadingHint(() => loading.value);
const backdropEvents = useBackdropDismiss(close);
let request: AbortController | undefined;
let downloadRequest: AbortController | undefined;
let conversionRequest: AbortController | undefined;
let disposed = false;

function release() {
  player.value?.pause();
  player.value?.removeAttribute('src');
  player.value?.load();
  if (source.value.startsWith('blob:')) URL.revokeObjectURL(source.value);
  source.value = '';
}

function close() {
  disposed = true;
  request?.abort();
  conversionRequest?.abort();
  downloadRequest?.abort();
  release();
  emit('close');
}

async function load() {
  if (disposed) return;
  request?.abort();
  conversionRequest?.abort();
  compatible.value = false;
  const current = request = new AbortController();
  release();
  error.value = '';
  previewFailed.value = false;
  loading.value = true;
  try {
    const streamUrl = format.value?.kind === 'video' || format.value?.kind === 'audio'
      ? desktopMediaUrl(props.groupId, props.attachment.id) : null;
    if (streamUrl) { source.value = streamUrl; return; }
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

async function convertVideo(start = true) {
  if (converting.value || disposed) return;
  const current = conversionRequest = new AbortController();
  converting.value = true;
  conversionStatus.value = start ? '正在转换视频，关闭查看器不会中断转换。' : '正在检查可用预览…';
  if (start) error.value = '';
  try {
    let status = await videoPreviewStatus(props.groupId, props.attachment.id, start, current.signal);
    if (disposed || current.signal.aborted || conversionRequest !== current) return;
    if (!start && (status.status === 'absent' || status.status === 'failed')) return;
    error.value = '';
    conversionStatus.value = '正在转换视频，关闭查看器不会中断转换。';
    const deadline = Date.now() + 330_000;
    while (status.status === 'processing') {
      if (Date.now() > deadline) throw new Error('视频仍在转换，请稍后重新打开。');
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(current.signal.reason); };
        const timer = setTimeout(() => { current.signal.removeEventListener('abort', cancel); resolve(); }, 1000);
        current.signal.addEventListener('abort', cancel, { once: true });
        if (current.signal.aborted) cancel();
      });
      status = await videoPreviewStatus(props.groupId, props.attachment.id, false, current.signal);
      if (disposed || current.signal.aborted || conversionRequest !== current) return;
    }
    if (status.status !== 'ready') throw new Error(status.message || '兼容预览已清理，请重新转换。');
    conversionStatus.value = '正在加载视频…';
    const url = desktopMediaUrl(props.groupId, props.attachment.id, true);
    const blob = url ? null : await fetchCompatibleVideo(props.groupId, props.attachment.id, current.signal);
    if (disposed || current.signal.aborted || conversionRequest !== current) return;
    release();
    compatible.value = true;
    previewFailed.value = false;
    source.value = url || URL.createObjectURL(blob!);
  } catch (reason) {
    if (!disposed && !current.signal.aborted) error.value = reason instanceof Error ? reason.message : '视频转换失败，请重试。';
  } finally {
    if (conversionRequest === current) converting.value = false;
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
  if (!disposed) {
    previewFailed.value = true;
    error.value = format.value?.kind === 'video' && !compatible.value
      ? '这个视频无法直接播放，可以转换后播放或下载原文件。'
      : '这个文件暂时无法预览，可以下载后打开。';
    // 已有兼容版本直接复用；这个查询不会启动转换。
    if (format.value?.kind === 'video' && !compatible.value) void convertVideo(false);
  }
}
onMounted(() => { closeButton.value?.focus(); void load(); });
onScopeDispose(() => {
  disposed = true;
  request?.abort();
  downloadRequest?.abort();
  conversionRequest?.abort();
  release();
});
</script>

<template>
  <div class="dialog-backdrop chat-media-backdrop" v-on="backdropEvents" @keydown.esc.stop="close">
    <section class="chat-media-viewer" :class="{ 'media-viewer-shell': format?.kind === 'image' || format?.kind === 'video' }" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1" @keydown="keepDialogFocus">
      <header v-if="format?.kind === 'audio' || !source || (previewFailed && format?.kind === 'image')">
        <strong id="chat-media-title" :title="title">{{ title }}</strong>
        <button type="button" aria-label="下载文件" title="下载文件" :disabled="downloading || (imageMessage && !source)" @click="download"><Download :size="18" /></button>
        <button ref="closeButton" type="button" aria-label="关闭查看器" title="关闭" @click="close"><X :size="18" /></button>
      </header>
      <div class="chat-media-stage" :aria-busy="loading">
        <ChatImageSurface v-if="source && format?.kind === 'image' && !previewFailed" :source="source" :title="title" @close="close" @download="download" @error="playbackFailed" />
        <MediaVideoSurface v-else-if="source && format?.kind === 'video'" :key="source" :source="source" downloadable :downloading="downloading" @close="close" @download="download" @error="playbackFailed" />
        <div v-else-if="source && format?.kind === 'audio'" class="chat-media-audio">
          <Music2 :size="64" aria-hidden="true" />
          <audio ref="player" :src="source" controls preload="metadata" tabindex="0" @error="playbackFailed" />
        </div>
        <span v-else-if="loadingHint" role="status">正在加载…</span>
      </div>
      <footer v-if="error || conversionHint || (previewFailed && format?.kind === 'video' && !compatible)" class="chat-media-feedback">
        <span v-if="error" role="alert">{{ error }}</span>
        <span v-else-if="conversionHint" class="conversion-status" role="status">{{ conversionStatus }}</span>
        <button v-if="previewFailed && format?.kind === 'video' && !compatible" type="button" :disabled="converting" @click="convertVideo()">转换后播放</button>
        <button v-else-if="!source" type="button" @click="load">重试</button>
      </footer>
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
.chat-media-viewer.media-viewer-shell { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; border-radius: 0; background: transparent; }
.chat-media-viewer.media-viewer-shell .chat-media-stage { background: transparent; }
.chat-media-viewer.media-viewer-shell .chat-media-feedback { position: absolute; z-index: 2; bottom: 76px; align-self: center; max-width: calc(100vw - 48px); border: 1px solid var(--border); border-radius: 6px; background: var(--panel); }
.chat-media-audio { display: grid; justify-items: center; gap: 28px; width: min(440px, 90%); }
.chat-media-audio audio { width: 100%; }
.chat-media-feedback { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-top: 1px solid var(--border); color: var(--danger); font-size: 13px; }
.conversion-status { color: var(--muted); }
.chat-media-feedback button { flex-shrink: 0; }
</style>
