<script setup lang="ts">
import { onScopeDispose, ref, watch, type UnwrapNestedRefs } from 'vue';
import InlineFeedback from '../InlineFeedback.vue';
import VoiceModeSwitch from '../VoiceModeSwitch.vue';
import { shortcutFromKey, type AudioShortcutAction, type VoiceMode, type useAudioShortcuts } from '../../settings/useAudioShortcuts';

const props = defineProps<{ active: boolean; shortcuts: UnwrapNestedRefs<ReturnType<typeof useAudioShortcuts>> }>();
const draft = ref('');
const draftCode = ref('');
const keyError = ref('');
const missingTalkBinding = ref(false);
const actions = [{ id: 'microphone', label: '麦克风静音／恢复' }, { id: 'listening', label: '停止／恢复收听' },
  { id: 'pushToTalk', label: '按键说话' }, { id: 'replay', label: '保存即时回放' }] as const;

function chooseVoiceMode(mode: VoiceMode) {
  missingTalkBinding.value = mode === 'pushToTalk' && !props.shortcuts.bindings.pushToTalk;
  if (!missingTalkBinding.value) void props.shortcuts.setVoiceMode(mode);
}

function keyDown(event: KeyboardEvent) {
  if (props.shortcuts.busy) return;
  if (event.key === 'Escape') { void props.shortcuts.cancelCapture(); return; }
  if (event.repeat || /^(Control|Alt|Shift)(Left|Right)$/.test(event.code)) return;
  try { draft.value = shortcutFromKey(event); draftCode.value = event.code; keyError.value = ''; }
  catch (reason) { keyError.value = reason instanceof Error ? reason.message : '快捷键不可用'; }
}
function keyUp(action: AudioShortcutAction, event: KeyboardEvent) {
  if (props.shortcuts.busy || props.shortcuts.capturing !== action || !draft.value || event.code !== draftCode.value) return;
  const binding = draft.value;
  draft.value = ''; draftCode.value = '';
  void props.shortcuts.setBinding(action, binding);
}
watch(() => props.shortcuts.capturing, capturing => {
  draft.value = ''; draftCode.value = ''; keyError.value = '';
  if (capturing) missingTalkBinding.value = false;
});
watch(() => props.shortcuts.bindings.pushToTalk, binding => { if (binding) missingTalkBinding.value = false; });
watch(() => props.active, active => {
  if (!active) { missingTalkBinding.value = false; void props.shortcuts.cancelCapture(); }
});
onScopeDispose(() => { void props.shortcuts.cancelCapture(); });
</script>

<template>
  <div class="settings-section shortcut-settings">
    <p class="settings-intro">游戏中也可使用快捷键。语音操作需先加入通话，保存回放需先开启回放；默认不设置快捷键。</p>
    <p v-if="!shortcuts.supported">全局快捷键仅在 Windows 桌面客户端提供。</p>
    <section class="settings-block">
      <div class="voice-mode-row">
        <h2>发言模式</h2>
        <VoiceModeSwitch :model-value="shortcuts.voiceMode" :binding="shortcuts.bindings.pushToTalk" :disabled="shortcuts.busy" :aria-busy="shortcuts.busy"
          :push-to-talk-disabled="!shortcuts.supported || !shortcuts.ready" @update:model-value="chooseVoiceMode" />
      </div>
      <small>先设置快捷键，并在通话中开启麦克风。按住时说话，松开后静音；手动静音、停止收听或离开语音后不会发声。</small>
    </section>
    <section class="settings-block">
      <h2>语音快捷键</h2>
      <div v-for="action in actions" :key="action.id" class="shortcut-setting-row">
        <span>{{ action.label }}</span>
        <div class="settings-actions">
          <button type="button" class="settings-button shortcut-binding" :aria-label="`设置${action.label}快捷键`" :aria-pressed="shortcuts.capturing === action.id"
            :disabled="!shortcuts.supported || !shortcuts.ready || (shortcuts.busy && shortcuts.capturing !== action.id)"
            @click="shortcuts.startCapture(action.id)" @blur="shortcuts.cancelCapture()"
            @keydown="shortcuts.capturing === action.id && (keyDown($event), $event.preventDefault(), $event.stopPropagation())"
            @keyup="shortcuts.capturing === action.id && (keyUp(action.id, $event), $event.preventDefault(), $event.stopPropagation())">
            {{ shortcuts.capturing === action.id ? draft || '按下按键，Esc 取消' : shortcuts.bindings[action.id] || '未设置' }}
          </button>
          <button type="button" :disabled="!shortcuts.supported || shortcuts.busy || !shortcuts.bindings[action.id]"
            :aria-label="`清除${action.label}快捷键`" @click="shortcuts.setBinding(action.id, '')">清除</button>
        </div>
      </div>
      <small>支持字母、数字、常用符号和 F1–F11，也可搭配 Ctrl、Alt、Shift。松开后保存，长按不会重复触发。</small>
      <small>单键是全局快捷键，打字或游戏中按下也会触发，可能与其他按键操作冲突。</small>
      <InlineFeedback :message="keyError || (missingTalkBinding ? '请先为按键发言设置快捷键' : shortcuts.error)" />
      <button v-if="!missingTalkBinding && shortcuts.error && shortcuts.supported" type="button" :disabled="shortcuts.busy" @click="shortcuts.retry()">重新启用</button>
    </section>
  </div>
</template>

<style scoped>
.shortcut-setting-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; min-height: 44px; }
.shortcut-setting-row .settings-actions { margin: 0; }
.shortcut-binding { width: 208px; flex: 0 0 208px; white-space: nowrap; }
.voice-mode-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.voice-mode-row .voice-mode-switch { width: 280px; max-width: 70%; }
</style>
