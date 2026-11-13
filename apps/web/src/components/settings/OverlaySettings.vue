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
      <div class="settings-range-row overlay-options">
        <span class="overlay-setting-copy">成员显示<small id="overlay-member-description">选择显示全部通话成员，或只在成员说话时显示。</small></span>
        <SegmentedControl :model-value="overlay.settings.value.mode" :options="memberModes" label="成员显示"
          aria-describedby="overlay-member-description"
          :disabled="!overlay.ready.value || overlay.busy.value" :aria-busy="overlay.ready.value && overlay.busy.value"
          @update:model-value="overlay.configure({ mode: $event })" />
      </div>
      <InlineFeedback :message="overlay.error.value" />
    </section>
    <section class="settings-block">
      <h2>位置与大小</h2>
      <label class="settings-range-row"><span class="overlay-setting-copy">显示器<small id="overlay-display-description">多屏使用时，可将通话成员放到指定屏幕上。</small></span><select aria-label="覆盖显示器" aria-describedby="overlay-display-description"
        :value="overlay.settings.value.displayId ?? ''" :disabled="!overlay.ready.value || overlay.busy.value"
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
    <p class="settings-intro">游戏中看不到屏幕覆盖时，可尝试将游戏切换为无边框窗口模式。</p>
  </div>
</template>

<style scoped>
.overlay-options { grid-template-columns: minmax(0, 1fr) minmax(0, 400px); }
.settings-range-row > .overlay-setting-copy { display: grid; gap: 4px; }
.overlay-setting-copy small { line-height: 1.5; }
@media (max-width: 760px) { .overlay-options { grid-template-columns: minmax(0, 1fr); } }
</style>
