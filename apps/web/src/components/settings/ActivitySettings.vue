<script setup lang="ts">
import { ref, watch } from 'vue';
import { Gamepad2, Music2, RotateCw } from '@lucide/vue';
import InlineFeedback from '../InlineFeedback.vue';
import type { UserActivity } from '../../presence/presenceApi';
import type { useActivityMappings } from '../../settings/useActivityMappings';

const props = defineProps<{ desktop: boolean; active: boolean; activity: UserActivity | null;
  showActivity: boolean; error: string; mappings: ReturnType<typeof useActivityMappings> }>();
const emit = defineEmits<{ visibility: [enabled: boolean] }>();
const executable = ref('');
const name = ref('');

function chooseWindow() {
  const selected = props.mappings.windows.value.find((window) => window.executable === executable.value);
  name.value = props.mappings.entries.value.find((entry) => entry.executable === executable.value)?.name
    ?? selected?.title ?? '';
}

function edit(entry: ActivityMapping) { executable.value = entry.executable; name.value = entry.name; }
function cancelEdit() { executable.value = ''; name.value = ''; }
async function saveName() {
  if (await props.mappings.save(executable.value, name.value)) cancelEdit();
}

watch(() => props.active, (active) => {
  cancelEdit();
  if (active && props.desktop) void props.mappings.refreshWindows();
}, { immediate: true });
</script>

<template>
  <section class="settings-section activity-settings">
    <h2>当前动态</h2>
    <div class="activity-current">
      <Music2 v-if="activity?.type === 'MUSIC'" :size="40" aria-hidden="true" /><Gamepad2 v-else :size="40" aria-hidden="true" />
      <div><strong>{{ activity ? activity.name : (desktop ? '未检测到动态' : '动态检测仅在 Windows 桌面版提供') }}</strong>
        <span v-if="activity">{{ activity.type === 'MUSIC' ? '正在听' : '正在玩' }}</span></div>
    </div>
    <div v-if="desktop" class="activity-mappings">
      <label for="activity-window">识别修正</label>
      <div class="activity-window-choice">
        <select id="activity-window" v-model="executable" :disabled="mappings.busy.value || !mappings.ready.value" @change="chooseWindow">
          <option value="" disabled>{{ mappings.loading.value ? '正在读取窗口…' : '选择正在运行的窗口' }}</option>
          <option v-for="entry in mappings.windows.value" :key="entry.executable" :value="entry.executable">{{ entry.title }}</option>
          <option v-if="executable && !mappings.windows.value.some((entry) => entry.executable === executable)" :value="executable">{{ name }}（未运行）</option>
        </select>
        <button type="button" aria-label="刷新运行窗口" :disabled="mappings.loading.value || mappings.busy.value" @click="mappings.refreshWindows"><RotateCw :size="15" /></button>
      </div>
      <form v-if="executable" class="activity-name-editor" @submit.prevent="saveName">
        <input v-model="name" aria-label="动态显示名称" maxlength="80" :disabled="mappings.busy.value" placeholder="显示名称" />
        <button type="button" :disabled="mappings.busy.value" @click="cancelEdit">取消</button>
        <button type="submit" :disabled="mappings.busy.value || !name.trim()">保存名称</button>
      </form>
      <div v-if="mappings.entries.value.length" class="activity-saved-names">
        <div v-for="entry in mappings.entries.value" :key="entry.executable">
          <span>{{ entry.name }}</span><button type="button" :disabled="mappings.busy.value" :aria-label="`编辑动态名称 ${entry.name}`" @click="edit(entry)">编辑</button>
          <button type="button" :disabled="mappings.busy.value" :aria-label="`移除动态名称 ${entry.name}`" @click="mappings.remove(entry.executable)">移除</button>
        </div>
      </div>
      <small>名称按程序记忆，仍优先展示最新启动的游戏；音乐暂停后可能继续显示动态。</small>
      <div class="activity-mapping-feedback"><InlineFeedback :message="mappings.error.value || mappings.windowError.value" />
        <button v-if="!mappings.ready.value && !mappings.busy.value" type="button" @click="mappings.initialize">重试</button></div>
    </div>
    <label class="settings-toggle activity-toggle">
      <span><strong>显示当前动态</strong><small>向群组成员展示游戏或音乐动态，仅影响当前设备。</small></span>
      <input type="checkbox" :checked="showActivity" :disabled="!desktop" aria-label="显示当前动态"
        @change="emit('visibility', ($event.target as HTMLInputElement).checked)" />
    </label>
    <InlineFeedback :message="error" />
  </section>
</template>

<style scoped>
.activity-settings { gap: 12px; padding-bottom: 20px; border-bottom: 1px solid var(--border-soft); }
.activity-current { display: flex; align-items: center; gap: 16px; min-height: 64px; color: var(--muted); }
.activity-current svg { flex-shrink: 0; }
.activity-current > div { display: grid; gap: 5px; min-width: 0; }
.activity-current strong { overflow-wrap: anywhere; color: var(--text); font-size: 16px; font-weight: 500; }
.activity-current span { font-size: 13px; }
.activity-toggle { padding-bottom: 0; }
.activity-mappings { display: grid; gap: 8px; min-width: 0; }
.activity-window-choice, .activity-name-editor { display: flex; align-items: center; gap: 8px; min-width: 0; }
.activity-window-choice select, .activity-name-editor input { flex: 1; min-width: 0; width: 0; }
.activity-window-choice button, .activity-name-editor button { flex-shrink: 0; }
.activity-window-choice button { display: grid; place-items: center; }
.activity-window-choice select { height: var(--button-height); padding: var(--button-padding); border: 1px solid var(--border); border-radius: 6px; background: var(--background); color: var(--text); font: inherit; font-size: 13px; }
.activity-mappings small { color: var(--muted); font-size: 12px; line-height: 18px; }
.activity-mapping-feedback { display: flex; align-items: center; gap: 8px; min-height: 32px; }
.activity-mapping-feedback .inline-feedback { flex: 1; }
.activity-saved-names { display: grid; gap: 4px; }
.activity-saved-names > div { display: flex; align-items: center; gap: 8px; min-width: 0; }
.activity-saved-names span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.activity-saved-names button { padding: 2px 4px; min-height: 26px; border: 0; background: transparent; color: var(--muted); }
@media (max-width: 520px) { .activity-name-editor { flex-wrap: wrap; } .activity-name-editor input { flex-basis: 100%; } }
</style>
