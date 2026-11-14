<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, useId, watch } from 'vue';
import { ChevronRight, Monitor } from '@lucide/vue';
import { DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY, SCREEN_SHARE_QUALITIES, screenShareQuality, type CustomScreenShareQuality, type ScreenShareQualityId } from '../rtc/screenShareQuality';
import SegmentedControl from './SegmentedControl.vue';
import ScreenShareCustomQuality from './ScreenShareCustomQuality.vue';
import ExpandSection from './ExpandSection.vue';
import type { NativeScreenAudioMode } from '../rtc/nativeScreenAudioMode';
import InlineFeedback from './InlineFeedback.vue';
import { readScreenSharePreferences, type ScreenSharePreferences } from '../settings/screenSharePreferences';
import { useBackdropDismiss } from './useBackdropDismiss';
import { keepDialogFocus } from './dialogFocus';

const props = withDefaults(defineProps<{
  sources: { id: string; name: string; thumbnail?: string; type: 'window' | 'screen' }[];
  sourceType: 'window' | 'screen'; selectedId: string; quality: ScreenShareQualityId;
  audioMode: NativeScreenAudioMode; audioReady: boolean; audioFailed: boolean; shareAudio: boolean;
  loading: boolean; error: string; notice: string;
  customQuality?: CustomScreenShareQuality;
  followGameAvailable?: boolean;
}>(), { customQuality: () => ({ ...DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY }) });
const emit = defineEmits<{
  close: []; confirm: [settings: ScreenSharePreferences]; choose: [id: string]; refreshThumbnails: []; previewLoaded: [sourceId: string];
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
  if (borderSupport.value === false) return '共享此窗口时，Windows 会显示系统边框。';
  return '共享此窗口时会尽量隐藏系统边框；受系统或权限限制时仍可能显示。';
});
const canConfirm = computed(() => props.audioReady && !props.audioFailed && !props.error && !settingsError.value
  && props.sources.some((source) => source.id === props.selectedId));
const feedbackPending = computed(() => !props.audioReady ? '正在检查共享能力…'
  : props.loading && !sources.value.length ? '正在读取共享来源…' : '');
const feedbackStatus = computed(() => {
  if (feedbackPending.value) return '';
  if (props.notice) return props.notice;
  if (!sources.value.length) return '没有可共享的窗口或屏幕，请切换分类，或打开要分享的窗口。';
  // 勾选前就说明采集范围，不能让系统混音看起来只包含所选应用。
  if (props.audioMode === 'systemMix') return '将共享全部电脑声音，包括 lycanclaw 的声音，可能产生回声。';
  return props.audioMode === 'unavailable' ? '当前系统仅支持共享画面。' : '';
});
const backdropEvents = useBackdropDismiss(() => emit('close'));
const advancedOpen = ref(false);
const advancedId = useId();
const content = ref<HTMLElement | null>(null);
let heightObserver: ResizeObserver | undefined;
let heightFrame = 0;
let heightOwner: Window | undefined;

onMounted(() => {
  const surface = panel.value!;
  const body = content.value!;
  const owner = surface.ownerDocument.defaultView!;
  heightOwner = owner;
  // 内层按可用窗口高度排版，外框只跟随实测高度，避免动画反过来挤压来源列表。
  const resize = () => { surface.style.height = `${body.getBoundingClientRect().height + 2}px`; };
  resize();
  heightObserver = new owner.ResizeObserver(() => {
    owner.cancelAnimationFrame(heightFrame);
    heightFrame = owner.requestAnimationFrame(resize);
  });
  heightObserver.observe(body);
});
onScopeDispose(() => {
  heightObserver?.disconnect();
  if (heightFrame) heightOwner?.cancelAnimationFrame(heightFrame);
});

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
  keepDialogFocus(event);
}
onMounted(async () => {
  try { captureSettings.value.hideCursor = readScreenSharePreferences().hideCursor; }
  catch { settingsError.value = '无法读取光标设置，请在共享与录制设置中重新保存后再试。'; }
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
        <div ref="content" class="capture-content">
        <header class="capture-header">
          <div><h2 id="capture-title">选择共享的窗口或屏幕</h2></div>
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
            <span class="capture-source-preview"><img v-if="source.thumbnail" :src="source.thumbnail" alt="" @load="emit('previewLoaded', source.id)" />
              <span v-else class="capture-source-placeholder"><Monitor :size="32" /></span>
              <span v-if="selectedId === source.id" class="capture-source-selected" aria-hidden="true">✓</span></span>
            <span class="capture-source-name">{{ source.name }}</span>
          </button>
        </div>
        <div class="capture-quality">
          <div id="capture-quality-description" class="capture-quality-description" role="tabpanel"
            :aria-labelledby="`capture-quality-${quality.id}`"><strong>{{ quality.description }}</strong><span>{{ quality.guidance }}</span>
            <p v-if="borderNotice" class="capture-border-notice">{{ borderNotice }}</p></div>
          <SegmentedControl class="capture-quality-tabs" :model-value="quality.id" :options="SCREEN_SHARE_QUALITIES"
            label="共享画质" tabs id-prefix="capture-quality" controls="capture-quality-description"
            @update:model-value="emit('update:quality', $event)" />
        </div>
        <ExpandSection :open="quality.id === 'custom'">
          <ScreenShareCustomQuality :model-value="customQuality"
          @update:model-value="emit('update:customQuality', $event)" />
        </ExpandSection>
        <div class="capture-advanced">
          <ExpandSection :open="advancedOpen" :id="advancedId">
          <div class="capture-advanced-content">
          <label v-if="sourceType === 'window'" class="capture-method">窗口采集方式
            <select v-model="captureSettings.windowMethod" aria-label="窗口采集方式">
              <option value="auto">自动</option>
              <option value="game">游戏采集</option>
            </select>
          </label>
          <label class="capture-audio-option"><input v-model="captureSettings.hideCursor" type="checkbox" />隐藏共享画面中的光标</label>
          <p v-if="sourceType === 'window'">自动选择适合此窗口的共享方式，仅分享应用内容。也可手动选择游戏采集。</p>
          <p v-else>整屏共享不显示系统黄框。高级选项仅对本次共享生效。</p>
          </div>
          </ExpandSection>
          <button type="button" class="disclosure-trigger" :aria-expanded="advancedOpen" :aria-controls="advancedId" @click="advancedOpen = !advancedOpen">
            <ChevronRight :size="12" aria-hidden="true" class="disclosure-arrow" :class="{ 'is-open': advancedOpen }" />高级选项
          </button>
        </div>
        <label v-if="followGameAvailable && sourceType === 'window' && (captureSettings.windowMethod ?? 'auto') === 'auto'"
          class="capture-audio-option capture-game-follow">
          <input v-model="followGame" type="checkbox" />跟随英雄联盟大厅与对局（包括大厅聊天画面）
        </label>
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
        </div>
      </section>
    </div>
</template>

<style scoped>
.capture-dialog { width: min(860px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow: hidden; border: 1px solid var(--border); background: var(--panel); border-radius: 8px; transition: height var(--motion-layout-duration) var(--motion-ease), transform var(--motion-surface-duration) var(--motion-ease); }
.capture-content { display: flex; flex-direction: column; max-height: calc(100dvh - 34px); overflow-y: auto; padding: 24px; }
.capture-header, .capture-tabs, .capture-quality, .card-actions { flex-shrink: 0; }
.capture-dialog :deep(.inline-feedback) { flex-shrink: 0; }
.capture-border-notice { margin: 0; color: var(--muted); font-size: 12px; line-height: 18px; }
.capture-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.capture-header h2 { margin: 0; font-size: 22px; line-height: 32px; }
.capture-header p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
.capture-tabs { display: flex; gap: 4px; padding: 4px; border-radius: 6px; background: var(--background); }
.capture-tabs { margin: 20px 0 12px; }
.capture-tabs button { flex: 1; min-height: 32px; padding: 5px 8px; border: 0; border-radius: 4px; background: transparent; color: var(--muted); white-space: nowrap; }
.capture-tabs button[aria-selected='true'] { background: var(--panel-raised); color: var(--text); }
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
.capture-advanced { margin: 4px 0; font-size: 13px; line-height: 20px; }
.capture-advanced-content { display: grid; gap: 8px; padding-top: 8px; }
.capture-content > .expand-section { flex-shrink: 0; }
.capture-advanced p { color: var(--muted); font-size: 12px; }
.capture-method { display: flex; align-items: center; gap: 12px; }
.capture-quality { display: flex; flex-direction: column; align-items: stretch; gap: 8px; margin: 8px 0 4px; }
.capture-quality-tabs { order: -1; flex-shrink: 0; }
.capture-quality-description { display: grid; gap: 2px; min-width: 0; line-height: 20px; }
.capture-quality-description strong { font-size: 14px; }
.capture-quality-description span { font-size: 12px; color: var(--muted); }
.capture-confirm { display: flex; align-items: center; gap: 12px; }
@media (max-width: 620px) { .capture-content { padding: 20px; } .capture-sources { grid-template-columns: repeat(2, minmax(0, 1fr)); } .capture-quality { align-items: stretch; flex-direction: column; gap: 8px; } }
@media (prefers-reduced-motion: reduce) { .capture-dialog { transition: none; } }
</style>
