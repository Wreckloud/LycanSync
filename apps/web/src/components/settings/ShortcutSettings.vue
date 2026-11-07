<script setup lang="ts">
import { onScopeDispose, ref, watch, type UnwrapNestedRefs } from 'vue';
import InlineFeedback from '../InlineFeedback.vue';
import { shortcutFromKey, type AudioShortcutAction, type useAudioShortcuts } from '../../settings/useAudioShortcuts';

const props = defineProps<{ active: boolean; shortcuts: UnwrapNestedRefs<ReturnType<typeof useAudioShortcuts>> }>();
const draft = ref('');
const draftCode = ref('');
const keyError = ref('');
const actions = [{ id: 'microphone', label: '麦克风静音／恢复' }, { id: 'listening', label: '停止／恢复收听' },
  { id: 'pushToTalk', label: '按键说话' }, { id: 'replay', label: '保存即时回放' }] as const;

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
watch(() => props.shortcuts.capturing, () => { draft.value = ''; draftCode.value = ''; keyError.value = ''; });
watch(() => props.active, active => { if (!active) void props.shortcuts.cancelCapture(); });
onScopeDispose(() => { void props.shortcuts.cancelCapture(); });
</script>

<template>
  <div class="settings-section shortcut-settings">
    <p class="settings-intro">全局快捷键在游戏或其他窗口前台时也生效。语音操作只用于已连接的通话；保存回放需要提前开启缓存，不会自动采集或入房。默认不绑定。</p>
    <p v-if="!shortcuts.supported">全局快捷键仅在 Windows 桌面客户端提供。</p>
    <section class="settings-block">
      <h2>发言模式</h2>
      <label class="voice-mode"><input type="radio" name="voice-mode" :checked="shortcuts.voiceMode === 'voice'"
        :disabled="shortcuts.busy" @change="shortcuts.setVoiceMode('voice')" />自由发言</label>
      <label class="voice-mode"><input type="radio" name="voice-mode" :checked="shortcuts.voiceMode === 'pushToTalk'"
        :disabled="!shortcuts.supported || !shortcuts.ready || shortcuts.busy"
        @change="shortcuts.setVoiceMode('pushToTalk')" />按键说话</label>
      <small>按键说话需要先在通话中开启麦克风；手动静音、停止收听和离房始终优先。松开按键即停止发声。</small>
      <small v-if="shortcuts.voiceMode === 'pushToTalk'">{{ !shortcuts.bindings.pushToTalk
        ? '请设置下方的按键说话快捷键；设置前保持静音。' : shortcuts.held ? '按键已按住' : '等待按住快捷键' }}</small>
    </section>
    <section class="settings-block">
      <h2>语音快捷键</h2>
      <div v-for="action in actions" :key="action.id" class="shortcut-setting-row">
        <span>{{ action.label }}</span>
        <div class="settings-actions">
          <button type="button" class="shortcut-binding" :aria-label="`设置${action.label}快捷键`" :aria-pressed="shortcuts.capturing === action.id"
            :disabled="!shortcuts.supported || !shortcuts.ready || (shortcuts.busy && shortcuts.capturing !== action.id)"
            @click="shortcuts.startCapture(action.id)" @blur="shortcuts.cancelCapture()"
            @keydown="shortcuts.capturing === action.id && (keyDown($event), $event.preventDefault(), $event.stopPropagation())"
            @keyup="shortcuts.capturing === action.id && (keyUp(action.id, $event), $event.preventDefault(), $event.stopPropagation())">
            {{ shortcuts.capturing === action.id ? draft || '按下组合键，Esc 取消' : shortcuts.bindings[action.id] || '未设置' }}
          </button>
          <button type="button" :disabled="!shortcuts.supported || shortcuts.busy || !shortcuts.bindings[action.id]"
            :aria-label="`清除${action.label}快捷键`" @click="shortcuts.setBinding(action.id, '')">清除</button>
        </div>
      </div>
      <small>支持 Ctrl／Alt 加字母或数字，以及 F1–F11；不使用 Windows 保留键。松开按键后保存，长按不反复切换。</small>
      <InlineFeedback :message="keyError || shortcuts.error" />
      <button v-if="shortcuts.error && shortcuts.supported" type="button" :disabled="shortcuts.busy" @click="shortcuts.retry()">重新启用</button>
    </section>
  </div>
</template>

<style scoped>
.shortcut-setting-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; min-height: 44px; }
.shortcut-setting-row .settings-actions { margin: 0; }
.shortcut-binding { width: 208px; flex: 0 0 208px; white-space: nowrap; }
.voice-mode { display: flex; align-items: center; gap: 8px; }
.voice-mode input { margin: 0; accent-color: var(--accent); }
</style>
