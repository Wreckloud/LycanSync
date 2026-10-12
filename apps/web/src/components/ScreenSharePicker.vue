<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { Monitor, X } from '@lucide/vue';
import { SCREEN_SHARE_QUALITIES, screenShareQuality, type ScreenShareQualityId } from '../rtc/screenShareQuality';
import type { NativeScreenAudioMode } from '../rtc/nativeScreenAudioMode';
import InlineFeedback from './InlineFeedback.vue';

const props = defineProps<{
  sources: { id: string; name: string; thumbnail?: string; type: 'window' | 'screen' }[];
  sourceType: 'window' | 'screen'; selectedId: string; quality: ScreenShareQualityId;
  audioMode: NativeScreenAudioMode; audioReady: boolean; audioFailed: boolean; shareAudio: boolean;
  loading: boolean; error: string; notice: string;
}>();
const emit = defineEmits<{
  close: []; confirm: []; choose: [id: string]; refreshThumbnails: [];
  'update:sourceType': [type: 'window' | 'screen']; 'update:quality': [quality: ScreenShareQualityId];
  'update:shareAudio': [enabled: boolean];
}>();
const panel = ref<HTMLElement | null>(null);
const sourcesElement = ref<HTMLDivElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const sources = computed(() => props.sources.filter((source) => source.type === props.sourceType));
const quality = computed(() => screenShareQuality(props.quality));
const canChoose = computed(() => props.audioReady && !props.audioFailed);
const canConfirm = computed(() => canChoose.value && !props.error && props.sources.some((source) => source.id === props.selectedId));
const descriptions: Record<ScreenShareQualityId, string> = {
  economy: '减少带宽占用，适合网络受限时观看。', standard: '平衡清晰度与流畅度，适合日常游戏分享。',
  highFrameRate: '优先展示快速运动画面，对设备和网络要求较高。', text: '优先保留文字和细节，适合文档与代码。',
};
let returnFocus: HTMLElement | null = null;
const background = new Map<HTMLElement, boolean>();

function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); emit('close'); return; }
  if (event.key !== 'Tab') return;
  const buttons = [...(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])];
  const first = buttons[0], last = buttons.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}
function qualityKeydown(event: KeyboardEvent) {
  const index = SCREEN_SHARE_QUALITIES.findIndex((preset) => preset.id === props.quality);
  let next = index;
  if (event.key === 'ArrowRight') next = (index + 1) % SCREEN_SHARE_QUALITIES.length;
  else if (event.key === 'ArrowLeft') next = (index + SCREEN_SHARE_QUALITIES.length - 1) % SCREEN_SHARE_QUALITIES.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = SCREEN_SHARE_QUALITIES.length - 1;
  else return;
  event.preventDefault();
  const preset = SCREEN_SHARE_QUALITIES[next];
  emit('update:quality', preset.id);
  panel.value?.querySelector<HTMLButtonElement>(`#capture-quality-${preset.id}`)?.focus();
}
onMounted(async () => {
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  await nextTick();
  if (!panel.value) return;
  // 弹层传送到 body 后隔离业务区域，保留媒体实例，仅限制背景交互。
  for (const element of document.body.children) {
    if (!(element instanceof HTMLElement) || element.contains(panel.value)) continue;
    background.set(element, element.inert); element.inert = true;
  }
  closeButton.value?.focus();
  emit('refreshThumbnails');
});
onBeforeUnmount(() => {
  for (const [element, inert] of background) element.inert = inert;
  background.clear();
  if (returnFocus?.isConnected) returnFocus.focus();
});
defineExpose({ sourcesElement });
</script>

<template>
  <Teleport to="body">
    <div class="dialog-backdrop" @keydown.stop="keydown">
      <section ref="panel" class="capture-dialog" role="dialog" aria-modal="true" aria-labelledby="capture-title">
        <header class="capture-header">
          <div><h2 id="capture-title">选择共享的窗口或屏幕</h2><p>选择画面和画质，然后开始共享。</p></div>
          <button ref="closeButton" type="button" class="capture-close icon-button" aria-label="关闭共享选择器" @click="emit('close')"><X :size="18" /></button>
        </header>
        <div class="capture-tabs" role="tablist" aria-label="共享来源类型">
          <button v-for="type in (['window', 'screen'] as const)" :key="type" type="button" role="tab"
            :id="`capture-source-tab-${type}`" aria-controls="capture-source-options"
            @keydown.left.prevent="emit('update:sourceType', sourceType === 'window' ? 'screen' : 'window')"
            @keydown.right.prevent="emit('update:sourceType', sourceType === 'window' ? 'screen' : 'window')"
            :aria-selected="sourceType === type" @click="emit('update:sourceType', type)">{{ type === 'window' ? '应用窗口' : '整个屏幕' }}</button>
        </div>
        <div ref="sourcesElement" id="capture-source-options" class="capture-sources" role="tabpanel"
          :aria-labelledby="`capture-source-tab-${sourceType}`" @scroll.passive="emit('refreshThumbnails')">
          <button v-for="source in sources" :key="source.id" type="button" :aria-label="source.name"
            :data-source-id="source.id" :aria-pressed="selectedId === source.id" :disabled="!canChoose" @click="emit('choose', source.id)">
            <span class="capture-source-preview"><img v-if="source.thumbnail" :src="source.thumbnail" alt="" />
              <span v-else class="capture-source-placeholder"><Monitor :size="32" /></span>
              <span v-if="selectedId === source.id" class="capture-source-selected" aria-hidden="true">✓</span></span>
            <span class="capture-source-name">{{ source.name }}</span>
          </button>
        </div>
        <InlineFeedback :message="audioFailed ? '无法确认共享能力，请关闭后重试。' : error"
          :status="!audioReady ? '正在检查共享能力…' : loading && !sources.length ? '正在读取共享来源…' : notice || (!sources.length ? '没有可共享的来源，请切换分类或等待新窗口出现。' : '')" />
        <div class="capture-audio">
          <label class="capture-audio-option"><input type="checkbox" :checked="shareAudio"
            :disabled="!audioReady || audioMode === 'unavailable'" @change="emit('update:shareAudio', ($event.target as HTMLInputElement).checked)" />
            {{ audioMode === 'systemMix' ? '共享电脑播放的全部声音' : sourceType === 'window' ? '同时共享此应用的声音' : '同时共享系统声音（不含 LycanSync）' }}</label>
          <small>{{ audioMode === 'systemMix' ? '包含其他程序和 LycanSync 播放的声音，可能产生回声。' : audioMode === 'unavailable' && audioReady ? '当前系统仅支持共享画面。' : sourceType === 'window' ? '包含所选应用及其子进程的声音。' : '共享系统播放声音，排除 LycanSync。' }}</small>
        </div>
        <div class="capture-quality">
          <div class="capture-quality-tabs" role="tablist" aria-label="共享画质">
            <button v-for="preset in SCREEN_SHARE_QUALITIES" :key="preset.id" type="button" role="tab"
              :id="`capture-quality-${preset.id}`" aria-controls="capture-quality-description" @keydown="qualityKeydown"
              :aria-selected="quality.id === preset.id" @click="emit('update:quality', preset.id)">{{ preset.label }}</button>
          </div>
          <div id="capture-quality-description" class="capture-quality-description" role="tabpanel"
            :aria-labelledby="`capture-quality-${quality.id}`"><strong>{{ quality.description }}</strong><span>{{ descriptions[quality.id] }}</span><small>目标上限，实际表现取决于设备与网络。</small></div>
        </div>
        <footer class="capture-footer"><button type="button" class="confirm-button" :disabled="!canConfirm" @click="emit('confirm')">开始共享</button></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.capture-dialog { display: flex; flex-direction: column; width: min(860px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow-y: auto; padding: 24px; border: 1px solid var(--border); background: var(--panel); border-radius: 8px; }
.capture-header, .capture-tabs, .capture-audio, .capture-quality, .capture-footer { flex-shrink: 0; }
.capture-dialog :deep(.inline-feedback) { flex-shrink: 0; }
.capture-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.capture-header h2 { margin: 0; font-size: 22px; line-height: 32px; }
.capture-header p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
.capture-close { flex-shrink: 0; }
.capture-tabs, .capture-quality-tabs { display: flex; gap: 4px; padding: 4px; border-radius: 6px; background: var(--background); }
.capture-tabs { margin: 20px 0 12px; }
.capture-tabs button, .capture-quality-tabs button { flex: 1; min-height: 32px; padding: 5px 8px; border: 0; border-radius: 4px; background: transparent; color: var(--muted); white-space: nowrap; }
.capture-tabs button[aria-selected='true'], .capture-quality-tabs button[aria-selected='true'] { background: var(--panel-raised); color: var(--text); }
.capture-sources { display: grid; flex: 1; grid-auto-rows: min-content; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; min-height: 120px; max-height: 45vh; overflow-y: auto; }
.capture-sources button { display: flex; flex-direction: column; gap: 6px; align-items: stretch; padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel-soft); min-width: 0; text-align: left; }
.capture-sources button:hover, .capture-sources button[aria-pressed='true'] { border-color: var(--accent); }
.capture-source-preview { position: relative; display: block; width: 100%; aspect-ratio: 16 / 9; overflow: hidden; background: #080b0f; }
.capture-source-preview img { width: 100%; height: 100%; object-fit: contain; }
.capture-source-placeholder { height: 100%; display: grid; place-items: center; color: var(--muted); }
.capture-source-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 20px; }
.capture-source-selected { position: absolute; right: 6px; bottom: 6px; width: 22px; height: 22px; display: grid; place-items: center; border-radius: 50%; background: var(--accent); color: white; }
.capture-audio { display: grid; gap: 4px; margin-top: 8px; }
.capture-audio-option { display: flex; align-items: center; gap: 8px; }
.capture-audio small { color: var(--muted); margin-left: 24px; }
.capture-quality { display: flex; align-items: center; gap: 20px; margin: 20px 0; }
.capture-quality-tabs { flex-shrink: 0; }
.capture-quality-description { display: grid; gap: 3px; min-width: 0; }
.capture-quality-description span, .capture-quality-description small { font-size: 12px; color: var(--muted); }
.capture-footer { display: flex; justify-content: flex-end; padding-top: 16px; border-top: 1px solid var(--border); }
.confirm-button { border-color: var(--accent); background: var(--accent); }
.capture-sources { scrollbar-width: none; }
.capture-sources::-webkit-scrollbar { display: none; }
@media (max-width: 620px) { .capture-dialog { padding: 20px; } .capture-sources { grid-template-columns: repeat(2, minmax(0, 1fr)); } .capture-quality { align-items: stretch; flex-direction: column; gap: 10px; } }
@media (max-width: 360px) { .capture-quality-tabs { flex-wrap: wrap; } .capture-quality-tabs button { flex-basis: 40%; } }
</style>
