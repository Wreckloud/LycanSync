<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { Folder, RotateCcw } from '@lucide/vue';
import DialogTransition from '../DialogTransition.vue';
import InlineFeedback from '../InlineFeedback.vue';
import { keepDialogFocus } from '../dialogFocus';

const props = defineProps<{ kind: 'diagnostics' | 'recording'; label: string; disabled?: boolean }>();
type DirectoryBridge = NonNullable<typeof window.lycanDesktop>['saveDirectory'];
const location = ref<Awaited<ReturnType<DirectoryBridge>>>();
const busy = ref(false);
const error = ref('');
const confirming = ref(false);
const panel = ref<HTMLElement>();
const picker = ref<HTMLButtonElement>();
const parts = computed(() => {
  const path = location.value?.path ?? '';
  const end = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1;
  return [path.slice(0, end), path.slice(end)];
});

async function operate(action: Parameters<DirectoryBridge>[1]) {
  if (busy.value || (props.disabled && (action === 'choose' || action === 'reset'))) return;
  busy.value = true;
  error.value = '';
  try {
    location.value = await window.lycanDesktop!.saveDirectory(props.kind, action);
    if (action === 'reset') confirming.value = false;
  } catch {
    error.value = action === 'read' ? '无法读取保存位置。' : action === 'open' ? '无法打开文件夹，请检查目录是否可用。' : '保存位置未能更改，请重试。';
  } finally { busy.value = false; }
}
async function askToReset() {
  error.value = '';
  confirming.value = true;
  await nextTick();
  panel.value?.focus();
}
onMounted(() => void operate('read'));
</script>

<template>
  <section class="save-directory" role="group" :aria-label="label">
    <header><strong>{{ label }}</strong>
      <button v-if="location && !location.isDefault" class="directory-reset" type="button" :disabled="disabled || busy" @click="askToReset">
        <RotateCcw :size="13" aria-hidden="true" />恢复默认
      </button>
    </header>
    <div v-if="location" class="directory-controls">
      <button ref="picker" type="button" class="directory-picker" :title="location.path" :aria-label="`更改${label}：${location.path}`"
        :disabled="disabled || busy" @click="operate('choose')">
        <Folder :size="16" aria-hidden="true" />
        <span class="directory-path"><span>{{ parts[0] }}</span><b>{{ parts[1] }}</b></span>
        <span class="directory-change">更改…</span>
      </button>
      <button type="button" class="settings-button directory-open" :disabled="busy" @click="operate('open')">打开文件夹</button>
    </div>
    <button v-else-if="error" type="button" class="settings-button" @click="operate('read')">重新读取</button>
    <InlineFeedback v-if="!confirming" :message="error" :pending="busy && !location ? '正在读取保存位置…' : ''" />
    <DialogTransition :focus-fallback="picker">
      <div v-if="confirming && location" class="dialog-backdrop" @keydown.esc.stop="!busy && (confirming = false)">
        <section ref="panel" class="dialog-panel directory-confirm" role="dialog" aria-modal="true" aria-label="恢复默认保存位置？"
          tabindex="-1" @keydown="keepDialogFocus">
          <header><h2>恢复默认保存位置？</h2><p>之后的{{ kind === 'recording' ? '录像和回放' : '日志' }}将保存到以下文件夹。已有文件保留在原处。</p></header>
          <p class="directory-destination">{{ location.defaultPath }}</p>
          <footer class="card-actions">
            <button type="button" class="settings-button" :disabled="busy" @click="confirming = false">取消</button>
            <InlineFeedback class="card-feedback" :message="error" />
            <button type="button" class="confirm-button card-actions-end" :disabled="disabled || busy" @click="operate('reset')">恢复默认</button>
          </footer>
        </section>
      </div>
    </DialogTransition>
  </section>
</template>

<style scoped>
.save-directory { display: grid; min-width: 0; gap: 6px; }
.save-directory > header, .directory-controls { display: flex; align-items: center; gap: 8px; }
.save-directory > header { justify-content: space-between; min-height: 24px; }
.save-directory strong { font-size: 14px; font-weight: 500; }
.directory-controls button, .directory-reset { display: inline-flex; align-items: center; gap: 8px; }
.directory-picker { height: 38px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--muted); }
.directory-picker { flex: 1; min-width: 0; padding: 0 10px; }
.directory-open { height: 38px; flex: none; white-space: nowrap; }
.directory-path { display: flex; min-width: 0; color: var(--text); text-align: left; }
.directory-path > span, .directory-path b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.directory-path b { flex: 0 0 auto; max-width: calc(100% - 3ch); font-weight: inherit; }
.directory-picker:focus-visible .directory-path { display: block; overflow-wrap: anywhere; }
.directory-picker:focus-visible .directory-path > * { white-space: normal; }
.directory-picker:focus-visible { height: auto; min-height: 38px; }
.directory-picker svg, .directory-change { flex-shrink: 0; }
.directory-change { margin-left: auto; }
.directory-reset { padding: 2px 4px; color: var(--muted); background: transparent; border: 0; font-size: 12px; }
.directory-destination { margin: 16px 0 20px; overflow-wrap: anywhere; user-select: text; }
</style>
