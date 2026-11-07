<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue';
import { ChevronRight, Monitor } from '@lucide/vue';
import { DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY, SCREEN_SHARE_QUALITIES, screenShareQuality, type CustomScreenShareQuality, type ScreenShareQualityId } from '../rtc/screenShareQuality';
import ScreenShareCustomQuality from './ScreenShareCustomQuality.vue';
import ExpandSection from './ExpandSection.vue';
import type { NativeScreenAudioMode } from '../rtc/nativeScreenAudioMode';
import InlineFeedback from './InlineFeedback.vue';
import { readScreenSharePreferences, type ScreenSharePreferences } from '../settings/screenSharePreferences';
import { useBackdropDismiss } from './useBackdropDismiss';

const props = withDefaults(defineProps<{
  sources: { id: string; name: string; thumbnail?: string; type: 'window' | 'screen' }[];
  sourceType: 'window' | 'screen'; selectedId: string; quality: ScreenShareQualityId;
  audioMode: NativeScreenAudioMode; audioReady: boolean; audioFailed: boolean; shareAudio: boolean;
  loading: boolean; error: string; notice: string;
  customQuality?: CustomScreenShareQuality;
  followGameAvailable?: boolean;
}>(), { customQuality: () => ({ ...DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY }) });
const emit = defineEmits<{
  close: []; confirm: [settings: ScreenSharePreferences]; choose: [id: string]; refreshThumbnails: [];
  'update:sourceType': [type: 'window' | 'screen']; 'update:quality': [quality: ScreenShareQualityId];
  'update:shareAudio': [enabled: boolean];
  'update:customQuality': [quality: CustomScreenShareQuality];
}>();
const panel = ref<HTMLElement | null>(null);
const sourcesElement = ref<HTMLDivElement | null>(null);
const captureSettings = ref<ScreenSharePreferences>({ hideCursor: false, hideBorder: false, windowMethod: 'auto' });
const borderSupport = ref<boolean>();
const settingsError = ref('');
const followGame = ref(false);
watch(() => props.selectedId, () => { followGame.value = false; });
const sources = computed(() => props.sources.filter((source) => source.type === props.sourceType));
const quality = computed(() => screenShareQuality(props.quality, props.customQuality));
const borderNotice = computed(() => {
  if (props.sourceType !== 'window' || captureSettings.value.windowMethod === 'game') return '';
  if (borderSupport.value === false) return '自动选择系统窗口采集时，当前 Windows 会显示系统边框。';
  return '自动选择系统窗口采集时会尽量隐藏系统边框，系统限制或权限不允许时可能显示边框。';
});
const canConfirm = computed(() => props.audioReady && !props.audioFailed && !props.error && !settingsError.value
  && props.sources.some((source) => source.id === props.selectedId));
const feedbackPending = computed(() => !props.audioReady ? '正在检查共享能力…'
  : props.loading && !sources.value.length ? '正在读取共享来源…' : '');
const feedbackStatus = computed(() => {
  if (feedbackPending.value) return '';
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
const backdropEvents = useBackdropDismiss(() => emit('close'));
const advancedOpen = ref(false);
const advancedId = useId();

function confirm() {
  if (!canConfirm.value) return;
  // 选择器已说明可能出现系统边框；点击开始只确认本次所选窗口，不保存长期许可。
  emit('confirm', { ...captureSettings.value,
    ...(followGame.value && props.followGameAvailable && props.sourceType === 'window'
      && (captureSettings.value.windowMethod ?? 'auto') === 'auto' ? { followGame: 'league' as const } : {}),
    windowMethod: props.sourceType === 'window' ? captureSettings.value.windowMethod : 'auto',
    hideBorder: props.sourceType !== 'window' || captureSettings.value.windowMethod === 'game' });
}

function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); emit('close'); return; }
  if (event.key !== 'Tab') return;
  const buttons = [...(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)') ?? [])].filter((control) => control.getClientRects().length > 0 && !control.closest('[inert]'));
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
  const desktop = window.lycanDesktop;
  if (desktop?.getScreenShareSupport) {
    void desktop.getScreenShareSupport().then(support => {
      if (panel.value) borderSupport.value = support.hideBorder;
    }).catch(() => { console.error('无法确认共享边框隐藏能力，将按可能显示系统边框说明。'); });
  }
  await nextTick();
  if (!panel.value) return;
  panel.value.focus();
  emit('refreshThumbnails');
});
defineExpose({ sourcesElement });
</script>

<template>
    <div class="dialog-backdrop" v-on="backdropEvents" @keydown.stop="keydown">
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
            :data-source-id="source.id" :aria-pressed="selectedId === source.id" @click="emit('choose', source.id)">
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
        <ExpandSection :open="quality.id === 'custom'">
          <ScreenShareCustomQuality :model-value="customQuality"
          @update:model-value="emit('update:customQuality', $event)" />
        </ExpandSection>
        <div class="capture-advanced">
          <button type="button" class="disclosure-trigger" :aria-expanded="advancedOpen" :aria-controls="advancedId" @click="advancedOpen = !advancedOpen">
            <ChevronRight :size="12" aria-hidden="true" class="disclosure-arrow" :class="{ 'is-open': advancedOpen }" />高级选项
          </button>
          <ExpandSection :open="advancedOpen" :id="advancedId">
          <div class="capture-advanced-content">
          <label v-if="sourceType === 'window'" class="capture-method">窗口采集方式
            <select v-model="captureSettings.windowMethod" aria-label="窗口采集方式">
              <option value="auto">自动</option>
              <option value="game">游戏采集</option>
            </select>
          </label>
          <label class="capture-audio-option"><input v-model="captureSettings.hideCursor" type="checkbox" />隐藏共享画面中的光标</label>
          <p v-if="sourceType === 'window'">自动选择适合所选窗口的采集方式，只分享应用内容区域。游戏采集用于手动指定游戏。</p>
          <p v-else>整屏使用 DXGI，无系统共享黄框。高级选项仅用于本次共享。</p>
          </div>
          </ExpandSection>
        </div>
        <label v-if="followGameAvailable && sourceType === 'window' && (captureSettings.windowMethod ?? 'auto') === 'auto'"
          class="capture-audio-option capture-game-follow">
          <input v-model="followGame" type="checkbox" />跟随英雄联盟大厅与对局（包括大厅聊天画面）
        </label>
        <p v-if="borderNotice" class="capture-border-notice">{{ borderNotice }}</p>
        <footer class="card-actions">
          <button type="button" class="settings-button" @click="emit('close')">取消</button>
          <InlineFeedback class="card-feedback" :message="audioFailed ? '无法确认共享能力，请关闭后重试。' : error || settingsError"
            :status="feedbackStatus" :pending="feedbackPending" />
          <div class="capture-confirm card-actions-end">
            <label class="capture-audio-option"><input type="checkbox" aria-label="共享音频" :checked="shareAudio"
              :disabled="!audioReady || audioMode === 'unavailable'" @change="emit('update:shareAudio', ($event.target as HTMLInputElement).checked)" />
              共享音频</label>
            <button type="button" class="confirm-button" :disabled="!canConfirm" @click="confirm">开始共享</button>
          </div>
        </footer>
      </section>
    </div>
</template>

<style scoped>
.capture-dialog { display: flex; flex-direction: column; width: min(860px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow-y: auto; padding: 24px; border: 1px solid var(--border); background: var(--panel); border-radius: 8px; }
.capture-header, .capture-tabs, .capture-quality, .card-actions { flex-shrink: 0; }
.capture-dialog :deep(.inline-feedback) { flex-shrink: 0; }
.capture-border-notice { flex-shrink: 0; margin: 8px 0 0; color: var(--muted); font-size: 12px; line-height: 18px; }
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
.capture-game-follow { margin: 12px 0; }
.capture-audio-option input { margin: 0; }
.capture-advanced { margin: 8px 0; font-size: 13px; line-height: 20px; }
.capture-advanced-content { display: grid; gap: 8px; padding-top: 8px; }
.capture-dialog > .expand-section { flex-shrink: 0; }
.capture-advanced p { color: var(--muted); font-size: 12px; }
.capture-method { display: flex; align-items: center; gap: 12px; }
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
