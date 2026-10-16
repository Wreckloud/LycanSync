<script setup lang="ts">
import { onScopeDispose, watch } from 'vue';
import type { useVoiceOverlay } from '../../overlay/useVoiceOverlay';
import type { VoiceOverlaySettings } from '../../overlay/types';
import InlineFeedback from '../InlineFeedback.vue';

const props = defineProps<{ overlay: ReturnType<typeof useVoiceOverlay>; active: boolean }>();

async function toggleSetting(key: 'enabled' | 'includeInCapture', event: Event) {
  const input = event.target as HTMLInputElement;
  await props.overlay.configure({ [key]: input.checked });
  // 系统拒绝修改时也立即还原控件，不能让原生状态与开关显示不一致。
  input.checked = props.overlay.settings.value[key];
}

async function selectMode(mode: VoiceOverlaySettings['mode'], event: Event) {
  const fieldset = (event.target as HTMLInputElement).closest('fieldset');
  await props.overlay.configure({ mode });
  fieldset?.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach((input) => {
    input.checked = input.value === props.overlay.settings.value.mode;
  });
}
watch(() => props.active, (active) => {
  if (active) void props.overlay.refreshDisplays();
  else void props.overlay.edit(false);
}, { immediate: true });
onScopeDispose(() => { void props.overlay.edit(false); });
</script>

<template>
  <div class="settings-section overlay-settings">
    <p class="settings-intro">显示当前语音房间的成员。平时不接收鼠标操作，主窗口最小化后仍可显示。</p>
    <section class="settings-block">
      <h2>屏幕覆盖</h2>
      <label class="settings-toggle">
        <span><strong>开启屏幕覆盖</strong><small>离开语音后隐藏，下次加入语音继续使用。</small></span>
        <input type="checkbox" :checked="overlay.settings.value.enabled" :disabled="!overlay.ready.value || overlay.busy.value"
          @change="toggleSetting('enabled', $event)" />
      </label>
      <fieldset :disabled="!overlay.ready.value || overlay.busy.value" class="overlay-options">
        <legend>成员显示</legend>
        <label><input type="radio" name="overlay-mode" value="all" :checked="overlay.settings.value.mode === 'all'" @change="selectMode('all', $event)" />显示全部通话成员</label>
        <label><input type="radio" name="overlay-mode" value="speaking" :checked="overlay.settings.value.mode === 'speaking'" @change="selectMode('speaking', $event)" />只显示正在说话的人</label>
      </fieldset>
      <InlineFeedback :message="overlay.error.value" />
    </section>
    <section class="settings-block">
      <h2>位置与大小</h2>
      <label class="overlay-field"><span>显示器</span><select :value="overlay.settings.value.displayId ?? ''" :disabled="!overlay.ready.value || overlay.busy.value"
        @change="overlay.configure({ displayId: ($event.target as HTMLSelectElement).value === '' ? null : Number(($event.target as HTMLSelectElement).value) })">
        <option value="">主窗口所在屏幕（默认）</option><option v-for="display in overlay.displays.value" :key="display.id" :value="display.id">{{ display.label }}</option>
        <option v-if="overlay.settings.value.displayId !== null && !overlay.displays.value.some((display) => display.id === overlay.settings.value.displayId)" :value="overlay.settings.value.displayId">原显示器已断开（临时使用主屏）</option>
      </select></label>
      <label class="overlay-field"><span>整体大小 · {{ overlay.settings.value.scale }}%</span><input type="range" min="75" max="150" step="5"
        :value="overlay.settings.value.scale" :disabled="!overlay.ready.value || overlay.busy.value" aria-label="覆盖整体大小"
        @change="overlay.configure({ scale: Number(($event.target as HTMLInputElement).value) })" /></label>
      <label class="overlay-field"><span>每列宽度 · {{ overlay.settings.value.width }}</span><input type="range" min="180" max="420" step="10"
        :value="overlay.settings.value.width" :disabled="!overlay.ready.value || overlay.busy.value" aria-label="覆盖每列宽度"
        @change="overlay.configure({ width: Number(($event.target as HTMLInputElement).value) })" /></label>
      <div class="settings-toggle">
        <span><strong>编辑覆盖位置</strong><small>开启覆盖后可拖动顶部说明条；无通话时显示示例。离开本栏目即结束编辑。</small></span>
        <button class="settings-button" type="button" :disabled="!overlay.ready.value || !overlay.settings.value.enabled || overlay.busy.value"
          @click="overlay.edit(!overlay.editing.value)">{{ overlay.editing.value ? '完成编辑' : '编辑位置' }}</button>
      </div>
      <button class="settings-button" type="button" :disabled="!overlay.ready.value || overlay.busy.value" @click="overlay.configure({ displayId: null, x: 1, y: 0.5, scale: 100, width: 240 })">恢复默认位置与大小</button>
    </section>
    <section class="settings-block">
      <h2>屏幕共享</h2>
      <label class="settings-toggle">
        <span><strong>允许覆盖进入整屏共享</strong><small>默认排除在屏幕采集外，也可能影响其他录屏软件。开启后才允许出现在整屏画面中；不额外叠加到窗口共享。</small></span>
        <input type="checkbox" :checked="overlay.settings.value.includeInCapture" :disabled="!overlay.ready.value || overlay.busy.value"
          @change="toggleSetting('includeInCapture', $event)" />
      </label>
      <p class="settings-intro">适用于大多数桌面、窗口和无边框游戏。独占全屏、锁屏及系统安全界面可能无法显示；实际捕获排除效果仍取决于系统与录屏方式。</p>
    </section>
  </div>
</template>

<style scoped>
.overlay-options { display: flex; flex-wrap: wrap; gap: 16px; padding: 14px 0; border: 0; }
.overlay-options legend { padding: 0; font-weight: 600; }
.overlay-options label { display: flex; gap: 8px; align-items: center; }
.overlay-field { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 16px; align-items: center; padding: 12px 0; }
.overlay-field select { width: 100%; padding: 7px 9px; border: 1px solid var(--border); border-radius: 5px; background: var(--panel-soft); color: var(--text); font: inherit; }
@media (max-width: 760px) { .overlay-field { grid-template-columns: 1fr; gap: 8px; } }
</style>
