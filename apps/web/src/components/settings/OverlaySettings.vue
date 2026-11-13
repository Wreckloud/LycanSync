<script setup lang="ts">
import { onScopeDispose, watch } from 'vue';
import type { useVoiceOverlay } from '../../overlay/useVoiceOverlay';
import InlineFeedback from '../InlineFeedback.vue';
import RangeValue from '../RangeValue.vue';
import { DEFAULT_OVERLAY_SETTINGS } from '../../overlay/useVoiceOverlay';
import SegmentedControl from '../SegmentedControl.vue';

const props = defineProps<{ overlay: ReturnType<typeof useVoiceOverlay>; active: boolean }>();
const memberModes = [{ id: 'all', label: '显示全部通话成员' }, { id: 'speaking', label: '只显示正在说话的人' }] as const;

async function toggleSetting(key: 'enabled', event: Event) {
  const input = event.target as HTMLInputElement;
  await props.overlay.configure({ [key]: input.checked });
  // 系统拒绝修改时也立即还原控件，不能让原生状态与开关显示不一致。
  input.checked = props.overlay.settings.value[key];
}

watch(() => props.active, (active) => {
  if (active) void props.overlay.refreshDisplays();
  else void props.overlay.edit(false);
}, { immediate: true });
onScopeDispose(() => { void props.overlay.edit(false); });
</script>

<template>
  <div class="settings-section overlay-settings">
    <p class="settings-intro">在游戏画面上查看通话成员和说话状态。</p>
    <section class="settings-block">
      <h2>屏幕覆盖</h2>
      <label class="settings-toggle">
        <span><strong>开启屏幕覆盖</strong><small>加入语音时显示，离开后隐藏。</small></span>
        <input type="checkbox" :checked="overlay.settings.value.enabled" :disabled="!overlay.ready.value || overlay.busy.value"
          @change="toggleSetting('enabled', $event)" />
      </label>
      <div class="overlay-options">
        <span>成员显示</span>
        <SegmentedControl :model-value="overlay.settings.value.mode" :options="memberModes" label="成员显示"
          :disabled="!overlay.ready.value || overlay.busy.value" :aria-busy="overlay.ready.value && overlay.busy.value"
          @update:model-value="overlay.configure({ mode: $event })" />
      </div>
      <InlineFeedback :message="overlay.error.value" />
    </section>
    <section class="settings-block">
      <h2>位置与大小</h2>
      <label class="overlay-field"><span>显示器</span><select :value="overlay.settings.value.displayId ?? ''" :disabled="!overlay.ready.value || overlay.busy.value"
        @change="overlay.configure({ displayId: ($event.target as HTMLSelectElement).value === '' ? null : Number(($event.target as HTMLSelectElement).value) })">
        <option value="">主窗口所在屏幕（默认）</option><option v-for="display in overlay.displays.value" :key="display.id" :value="display.id">{{ display.label }}</option>
        <option v-if="overlay.settings.value.displayId !== null && !overlay.displays.value.some((display) => display.id === overlay.settings.value.displayId)" :value="overlay.settings.value.displayId">原显示器已断开（临时使用主屏）</option>
      </select></label>
      <div class="settings-range-row"><span><label for="settings-overlay-scale">整体大小</label><RangeValue :value="overlay.settings.value.scale" :default-value="DEFAULT_OVERLAY_SETTINGS.scale" label="重置覆盖整体大小" :disabled="!overlay.ready.value || overlay.busy.value" @reset="overlay.configure({ scale: DEFAULT_OVERLAY_SETTINGS.scale })">{{ overlay.settings.value.scale }}%</RangeValue></span><input id="settings-overlay-scale" type="range" min="75" max="150" step="5"
        :value="overlay.settings.value.scale" :disabled="!overlay.ready.value || overlay.busy.value" aria-label="覆盖整体大小"
        @change="overlay.configure({ scale: Number(($event.target as HTMLInputElement).value) })" /></div>
      <div class="settings-toggle">
        <span><strong>编辑覆盖位置</strong><small>拖动头像或昵称，调整覆盖位置。</small></span>
        <button class="settings-button" type="button" :disabled="!overlay.ready.value || !overlay.settings.value.enabled || overlay.busy.value"
          @click="overlay.edit(!overlay.editing.value)">{{ overlay.editing.value ? '完成编辑' : '编辑位置' }}</button>
      </div>
      <label v-if="overlay.editing.value" class="settings-toggle">
        <span><strong>显示测试成员</strong><small>编辑时显示三个示例成员，预览昵称和布局。</small></span>
        <input type="checkbox" :checked="overlay.preview.value" @change="overlay.edit(true, ($event.target as HTMLInputElement).checked)" />
      </label>
      <button class="settings-button" type="button" :disabled="!overlay.ready.value || overlay.busy.value" @click="overlay.configure({ displayId: null, x: 1, y: 0.5, scale: 100 })">恢复默认位置与大小</button>
    </section>
    <p class="settings-intro">通常不会录入共享画面。独占全屏、锁屏等场景可能无法显示，是否入镜仍取决于系统和录屏方式。</p>
  </div>
</template>

<style scoped>
.overlay-options { display: grid; gap: 8px; margin-top: 4px; }
.overlay-options > span { font-weight: 500; }
.overlay-options .segmented-control { max-width: 400px; }
.overlay-field { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 16px; align-items: center; padding: 12px 0; }
.overlay-field select { width: 100%; }
@media (max-width: 760px) { .overlay-field { grid-template-columns: 1fr; gap: 8px; } }
</style>
