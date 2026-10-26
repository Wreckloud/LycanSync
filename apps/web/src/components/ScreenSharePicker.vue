<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { Monitor } from '@lucide/vue';
import { DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY, SCREEN_SHARE_QUALITIES, screenShareQuality, type CustomScreenShareQuality, type ScreenShareQualityId } from '../rtc/screenShareQuality';
import ScreenShareCustomQuality from './ScreenShareCustomQuality.vue';
import type { NativeScreenAudioMode } from '../rtc/nativeScreenAudioMode';
import InlineFeedback from './InlineFeedback.vue';
import { readScreenSharePreferences, type ScreenSharePreferences } from '../settings/screenSharePreferences';

const props = withDefaults(defineProps<{
  sources: { id: string; name: string; thumbnail?: string; type: 'window' | 'screen' }[];
  sourceType: 'window' | 'screen'; selectedId: string; quality: ScreenShareQualityId;
  audioMode: NativeScreenAudioMode; audioReady: boolean; audioFailed: boolean; shareAudio: boolean;
  loading: boolean; error: string; notice: string;
  customQuality?: CustomScreenShareQuality;
}>(), { customQuality: () => ({ ...DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY }) });
const emit = defineEmits<{
  close: []; confirm: [settings: ScreenSharePreferences]; choose: [id: string]; refreshThumbnails: [];
  'update:sourceType': [type: 'window' | 'screen']; 'update:quality': [quality: ScreenShareQualityId];
  'update:shareAudio': [enabled: boolean];
  'update:customQuality': [quality: CustomScreenShareQuality];
}>();
const panel = ref<HTMLElement | null>(null);
const sourcesElement = ref<HTMLDivElement | null>(null);
const captureSettings = ref<ScreenSharePreferences>({ hideCursor: false, hideBorder: true, windowMethod: 'auto' });
const settingsError = ref('');
const sources = computed(() => props.sources.filter((source) => source.type === props.sourceType));
const quality = computed(() => screenShareQuality(props.quality, props.customQuality));
const canChoose = computed(() => props.audioReady && !props.audioFailed);
const canConfirm = computed(() => canChoose.value && !props.error && !settingsError.value
  && props.sources.some((source) => source.id === props.selectedId));
const feedbackStatus = computed(() => {
  if (!props.audioReady) return '正在检查共享能力…';
  if (props.loading && !sources.value.length) return '正在读取共享来源…';
  if (props.notice) return props.notice;
  if (!sources.value.length) return '没有可共享的来源，请切换分类或等待新窗口出现。';
  // 勾选前就说明采集范围，不能让系统混音看起来只包含所选应用。
  if (props.audioMode === 'systemMix') return '共享音频包含全部电脑声音，包括 LycanSync，可能产生回声。';
  return props.audioMode === 'unavailable' ? '当前系统仅支持共享画面。' : '';
});
const descriptions: Record<ScreenShareQualityId, string> = {
  economy: '减少带宽占用，适合网络受限时观看。', standard: '平衡清晰度与流畅度，适合日常游戏分享。',
  highFrameRate: '优先展示快速运动画面，对设备和网络要求较高。', custom: '按来源比例输出，尽量保持所选帧率。',
};
let returnFocus: HTMLElement | null = null;
const background = new Map<HTMLElement, boolean>();

function confirm() {
  if (!canConfirm.value) return;
  emit('confirm', { ...captureSettings.value,
    windowMethod: props.sourceType === 'window' ? captureSettings.value.windowMethod : 'auto',
    hideBorder: props.sourceType !== 'window' || captureSettings.value.hideBorder });
}

function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); emit('close'); return; }
  if (event.key !== 'Tab') return;
  const buttons = [...(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)') ?? [])];
  const first = buttons[0], last = buttons.at(-1);
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) { event.preventDefault(); last?.focus(); }
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
  try { captureSettings.value.hideCursor = readScreenSharePreferences().hideCursor; }
  catch { settingsError.value = '无法读取光标偏好，请重新保存客户端设置后再试。'; }
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  await nextTick();
  if (!panel.value) return;
  // 弹层传送到 body 后隔离业务区域，保留媒体实例，仅限制背景交互。
  for (const element of document.body.children) {
    if (!(element instanceof HTMLElement) || element.contains(panel.value)) continue;
    background.set(element, element.inert); element.inert = true;
  }
  panel.value.focus();
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
      <section ref="panel" class="capture-dialog" role="dialog" aria-modal="true" aria-labelledby="capture-title" tabindex="-1">
        <header class="capture-header">
          <div><h2 id="capture-title">选择共享的窗口或屏幕</h2><p>选择画面和画质，然后开始共享。</p></div>
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
        <div class="capture-quality">
          <div id="capture-quality-description" class="capture-quality-description" role="tabpanel"
            :aria-labelledby="`capture-quality-${quality.id}`"><strong>{{ quality.description }}</strong><span>{{ descriptions[quality.id] }}</span></div>
          <div class="capture-quality-tabs" role="tablist" aria-label="共享画质">
            <button v-for="preset in SCREEN_SHARE_QUALITIES" :key="preset.id" type="button" role="tab"
              :id="`capture-quality-${preset.id}`" aria-controls="capture-quality-description" @keydown="qualityKeydown"
              :aria-selected="quality.id === preset.id" @click="emit('update:quality', preset.id)">{{ preset.label }}</button>
          </div>
        </div>
        <ScreenShareCustomQuality v-if="quality.id === 'custom'" :model-value="customQuality"
          @update:model-value="emit('update:customQuality', $event)" />
        <details class="capture-advanced">
          <summary>高级选项</summary>
          <label v-if="sourceType === 'window'" class="capture-method">窗口采集方式
            <select v-model="captureSettings.windowMethod">
              <option value="auto">自动（优先无边框）</option>
              <option value="game">游戏采集</option>
              <option value="bitblt">兼容采集（BitBlt）</option>
              <option value="wgc">系统窗口采集（WGC）</option>
            </select>
          </label>
          <label class="capture-audio-option"><input v-model="captureSettings.hideCursor" type="checkbox" />隐藏共享画面中的光标</label>
          <label v-if="sourceType === 'window' && ['auto', 'wgc'].includes(captureSettings.windowMethod ?? 'auto')" class="capture-audio-option">
            <input type="checkbox" :checked="!captureSettings.hideBorder"
              @change="captureSettings.hideBorder = !($event.target as HTMLInputElement).checked" />允许显示系统共享边框（仅本次）
          </label>
          <p v-if="sourceType === 'window'">普通窗口分享应用内容区域；手动指定方式不可用时会提示，不自动换方式。Win10 的 WGC 通常需要允许系统边框，兼容采集可能不适合部分硬件加速应用。</p>
          <p v-else>整屏使用 DXGI，无系统共享黄框。高级选项仅用于本次共享。</p>
        </details>
        <footer class="card-actions">
          <button type="button" class="settings-button" @click="emit('close')">取消</button>
          <InlineFeedback class="card-feedback" :message="audioFailed ? '无法确认共享能力，请关闭后重试。' : error || settingsError"
            :status="feedbackStatus" />
          <div class="capture-confirm card-actions-end">
            <label class="capture-audio-option"><input type="checkbox" aria-label="共享音频" :checked="shareAudio"
              :disabled="!audioReady || audioMode === 'unavailable'" @change="emit('update:shareAudio', ($event.target as HTMLInputElement).checked)" />
              共享音频</label>
            <button type="button" class="confirm-button" :disabled="!canConfirm" @click="confirm">开始共享</button>
          </div>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.capture-dialog { display: flex; flex-direction: column; width: min(860px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow-y: auto; padding: 24px; border: 1px solid var(--border); background: var(--panel); border-radius: 8px; }
.capture-header, .capture-tabs, .capture-quality, .card-actions { flex-shrink: 0; }
.capture-dialog :deep(.inline-feedback) { flex-shrink: 0; }
.capture-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.capture-header h2 { margin: 0; font-size: 22px; line-height: 32px; }
.capture-header p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
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
.capture-audio-option { display: flex; align-items: center; flex-shrink: 0; gap: 8px; font-size: 13px; line-height: 20px; }
.capture-audio-option input { margin: 0; }
.capture-advanced { margin: 8px 0; font-size: 13px; line-height: 20px; }
.capture-advanced summary { color: var(--muted); cursor: pointer; }
.capture-advanced > label { margin-top: 8px; }
.capture-advanced p { color: var(--muted); font-size: 12px; }
.capture-method { display: flex; align-items: center; gap: 12px; }
.capture-method select { min-height: 32px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--background); color: var(--text); font: inherit; }
.capture-quality { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: 8px 0 12px; }
.capture-quality-tabs { flex-shrink: 0; }
.capture-quality-description { display: grid; gap: 2px; min-width: 0; line-height: 20px; }
.capture-quality-description strong { font-size: 14px; }
.capture-quality-description span { font-size: 12px; color: var(--muted); }
.capture-confirm { display: flex; align-items: center; gap: 12px; }
.capture-sources { scrollbar-width: none; }
.capture-sources::-webkit-scrollbar { display: none; }
@media (max-width: 620px) { .capture-dialog { padding: 20px; } .capture-sources { grid-template-columns: repeat(2, minmax(0, 1fr)); } .capture-quality { align-items: stretch; flex-direction: column; gap: 8px; } }
@media (max-width: 360px) { .capture-quality-tabs { flex-wrap: wrap; } .capture-quality-tabs button { flex-basis: 40%; } }
</style>
