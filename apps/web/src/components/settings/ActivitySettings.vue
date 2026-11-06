<script setup lang="ts">
import { ref, watch } from 'vue';
import InlineFeedback from '../InlineFeedback.vue';
import ProfilePopover from '../ProfilePopover.vue';
import { useOwnVoiceTime } from '../../profile/useOwnVoiceTime';
import type { AuthUser } from '../../auth/authApi';
import { PRESENCE_STATUS_LABELS, type UserActivity, type UserPresenceStatus } from '../../presence/presenceApi';
import type { useActivityMappings } from '../../settings/useActivityMappings';

const props = defineProps<{ user: AuthUser; desktop: boolean; active: boolean; activity: UserActivity | null;
  status?: UserPresenceStatus;
  showActivity: boolean; showLastOnline: boolean; error: string; mappings: ReturnType<typeof useActivityMappings> }>();
const emit = defineEmits<{ visibility: [enabled: boolean]; lastOnlineVisibility: [enabled: boolean] }>();
const executable = ref('');
const name = ref('');
const voiceTime = useOwnVoiceTime(() => props.active);

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
    <aside class="activity-profile-preview" aria-label="资料卡预览">
      <ProfilePopover inline :anchor="null" placement="left" label="资料卡预览" :nickname="user.nickname" :avatar="user.avatar"
        :signature="user.signature" :status="status ?? 'ONLINE'" :status-label="PRESENCE_STATUS_LABELS[status ?? 'ONLINE']" :voice-seconds="voiceTime.seconds.value"
        :voice-error="voiceTime.error.value" own-voice
        :activity="showActivity && status !== 'OFFLINE' && activity ? `${activity.type === 'MUSIC' ? '正在听' : '正在玩'} ${activity.name}` : undefined" />
    </aside>
    <div class="activity-settings-controls">
    <h2>动态与在线展示</h2>
    <label class="settings-toggle activity-toggle">
      <span><strong>显示动态</strong><small>展示当前游戏或音乐，以及最近一次公开游戏；关闭后清除最近游戏记录。</small></span>
      <input type="checkbox" :checked="showActivity" aria-label="显示动态"
        @change="emit('visibility', ($event.target as HTMLInputElement).checked)" />
    </label>
    <label class="settings-toggle activity-toggle">
      <span><strong>显示上次在线时间</strong><small>离线时向同群成员展示上次公开在线时间，隐身期间不刷新。</small></span>
      <input type="checkbox" :checked="showLastOnline" aria-label="显示上次在线时间"
        @change="emit('lastOnlineVisibility', ($event.target as HTMLInputElement).checked)" />
    </label>
    <InlineFeedback :message="error" />
    <div class="activity-current">
      <strong>{{ activity ? activity.name : (desktop ? '未检测到动态' : '动态检测仅在 Windows 桌面版提供') }}</strong>
    </div>
    <div v-if="desktop" class="activity-mappings">
      <label for="activity-window">识别修正</label>
      <div class="activity-window-choice">
        <select id="activity-window" v-model="executable" :disabled="mappings.busy.value || !mappings.ready.value" @pointerdown="mappings.refreshWindows" @focus="mappings.refreshWindows" @change="chooseWindow">
          <option value="" disabled>{{ mappings.loading.value ? '正在读取窗口…' : '选择正在运行的窗口' }}</option>
          <option v-for="entry in mappings.windows.value" :key="entry.executable" :value="entry.executable">{{ entry.title }}</option>
          <option v-if="executable && !mappings.windows.value.some((entry) => entry.executable === executable)" :value="executable">{{ name }}（未运行）</option>
        </select>
        <button type="button" :disabled="!executable || mappings.busy.value" @click="cancelEdit">重置</button>
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
    </div>
  </section>
</template>

<style scoped>
.activity-settings { grid-template-columns: minmax(0, 260px) minmax(0, 1fr); gap: 24px; padding-bottom: 20px; border-bottom: 1px solid var(--border-soft); }
.activity-settings-controls { display: grid; align-content: start; gap: 12px; min-width: 0; }
.activity-profile-preview { min-width: 0; align-self: start; }
@media (max-width: 1050px) { .activity-settings { grid-template-columns: minmax(0, 1fr); } .activity-profile-preview { max-width: 292px; } }
.activity-current { min-width: 0; color: var(--muted); }
.activity-current strong { overflow-wrap: anywhere; color: var(--text); font-size: 14px; font-weight: 500; }
.activity-toggle { padding: 0; border-top: 0; }
.activity-mappings { display: grid; gap: 8px; min-width: 0; }
.activity-mappings > label { font-size: 14px; font-weight: 500; }
.activity-window-choice, .activity-name-editor { display: flex; align-items: center; gap: 8px; min-width: 0; }
.activity-window-choice select, .activity-name-editor input { flex: 1; min-width: 0; width: 0; }
.activity-window-choice button, .activity-name-editor button { flex-shrink: 0; }
.activity-window-choice button { display: grid; place-items: center; }
.activity-window-choice select, .activity-name-editor input { height: var(--button-height); padding: var(--button-padding); border: 1px solid var(--border); border-radius: 6px; background: var(--background); color: var(--text); font: inherit; font-size: 13px; }
.activity-mappings small { color: var(--muted); font-size: 12px; line-height: 18px; }
.activity-mapping-feedback { display: flex; align-items: center; gap: 8px; min-height: 32px; }
.activity-mapping-feedback .inline-feedback { flex: 1; }
.activity-saved-names { display: grid; gap: 4px; }
.activity-saved-names > div { display: flex; align-items: center; gap: 8px; min-width: 0; }
.activity-saved-names span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.activity-saved-names button { padding: 2px 4px; min-height: 26px; border: 0; background: transparent; color: var(--muted); }
@media (max-width: 520px) { .activity-name-editor { flex-wrap: wrap; } .activity-name-editor input { flex-basis: 100%; } }
@supports (appearance: base-select) {
  .activity-window-choice select, .activity-window-choice select::picker(select) { appearance: base-select; }
  .activity-window-choice select { display: flex; align-items: center; gap: 8px; overflow: hidden; }
  .activity-window-choice select::picker-icon { flex-shrink: 0; margin-inline-start: auto; color: var(--muted); transition: transform var(--motion-surface-duration) var(--motion-ease); }
  .activity-window-choice select:open::picker-icon { transform: rotate(180deg); }
  .activity-window-choice select::picker(select) {
    min-width: anchor-size(width); max-width: calc(100vw - 32px); max-height: min(300px, 60dvh); margin-block: 4px;
    padding: 4px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--panel-soft); color: var(--text);
    opacity: 0; transform: translateY(-4px);
    transition: opacity var(--motion-surface-duration) var(--motion-ease), transform var(--motion-surface-duration) var(--motion-ease),
      display var(--motion-surface-duration) allow-discrete, overlay var(--motion-surface-duration) allow-discrete;
  }
  .activity-window-choice select:open::picker(select) { opacity: 1; transform: translateY(0); }
  .activity-window-choice select:not(:open)::picker(select) { pointer-events: none; }
  @starting-style { .activity-window-choice select:open::picker(select) { opacity: 0; transform: translateY(-4px); } }
  .activity-window-choice option { display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 6px 10px; border-radius: 4px; font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
  .activity-window-choice option:disabled { display: none; }
  .activity-window-choice option:hover, .activity-window-choice option:focus-visible, .activity-window-choice option:checked { background: var(--panel-raised); }
  .activity-window-choice option:checked { font-weight: 500; }
  .activity-window-choice option::checkmark { order: 1; margin-inline-start: auto; color: var(--accent); }
  @media (prefers-reduced-motion: reduce) { .activity-window-choice select::picker(select), .activity-window-choice select::picker-icon { transition: none; } }
}
</style>
