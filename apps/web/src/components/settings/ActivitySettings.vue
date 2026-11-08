<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import PresenceSettingsMenu from './PresenceSettingsMenu.vue';
import ActivityNameDialog from '../ActivityNameDialog.vue';
import DialogTransition from '../DialogTransition.vue';
import InlineFeedback from '../InlineFeedback.vue';
import ProfilePopover from '../ProfilePopover.vue';
import { useOwnVoiceTime } from '../../profile/useOwnVoiceTime';
import type { AuthUser } from '../../auth/authApi';
import { PRESENCE_STATUS_LABELS, type UserActivity, type UserPresenceStatus } from '../../presence/presenceApi';
import type { useActivityMappings } from '../../settings/useActivityMappings';
import type { PresenceMode } from '../../presence/usePresencePreference';

const props = defineProps<{ user: AuthUser; desktop: boolean; active: boolean; activity: UserActivity | null;
  status?: UserPresenceStatus;
  presenceMode?: PresenceMode; presenceReady?: boolean; presenceSyncing?: boolean; presenceError?: string;
  showActivity: boolean; showLastOnline: boolean; error: string; mappings: ReturnType<typeof useActivityMappings> }>();
const emit = defineEmits<{ visibility: [enabled: boolean]; lastOnlineVisibility: [enabled: boolean]; presenceMode: [mode: PresenceMode] }>();
const executable = ref('');
const editingName = ref(false);
const selectedName = computed(() => props.mappings.entries.value.find((entry) => entry.executable === executable.value)?.name
  ?? props.mappings.windows.value.find((window) => window.executable === executable.value)?.title ?? '');
const voiceTime = useOwnVoiceTime(() => props.active);

function openEditor() {
  if (!executable.value || props.mappings.busy.value || !props.mappings.ready.value) return;
  props.mappings.error.value = '';
  editingName.value = true;
}

function edit(entry: ActivityMapping) { executable.value = entry.executable; openEditor(); }
function resetSelection() { executable.value = ''; }
async function saveName(name: string) {
  if (await props.mappings.save(executable.value, name)) editingName.value = false;
}

watch(() => props.active, (active) => {
  editingName.value = false;
  resetSelection();
  if (active && props.desktop) void props.mappings.refreshWindows();
}, { immediate: true });
defineExpose({ editingName });
</script>

<template>
  <section class="settings-section activity-settings">
    <h2 class="activity-heading">动态与在线展示</h2>
    <aside class="activity-profile-preview" aria-label="资料卡预览">
      <ProfilePopover inline :anchor="null" placement="left" label="资料卡预览" :nickname="user.nickname" :avatar="user.avatar"
        :signature="user.signature" :status="status ?? 'ONLINE'" :status-label="PRESENCE_STATUS_LABELS[status ?? 'ONLINE']" :voice-seconds="voiceTime.seconds.value"
        :voice-error="voiceTime.error.value" own-voice
        :activity="showActivity && status !== 'OFFLINE' && activity ? `${activity.type === 'MUSIC' ? '正在听' : '正在玩'} ${activity.name}` : undefined" />
    </aside>
    <div class="activity-settings-controls">
    <label class="settings-toggle activity-toggle">
      <span><strong>显示动态</strong><small>展示当前游戏或音乐及最近一次公开游戏；关闭后隐藏并保留记录，重新开启可恢复展示。</small></span>
      <input type="checkbox" :checked="showActivity" aria-label="显示动态"
        @change="emit('visibility', ($event.target as HTMLInputElement).checked)" />
    </label>
    <label class="settings-toggle activity-toggle">
      <span><strong>显示上次在线时间</strong><small>离线时向同群成员展示上次公开在线时间，隐身期间不刷新。</small></span>
      <input type="checkbox" :checked="showLastOnline" aria-label="显示上次在线时间"
        @change="emit('lastOnlineVisibility', ($event.target as HTMLInputElement).checked)" />
    </label>
    <div class="settings-toggle activity-toggle activity-presence">
      <span><strong>在线状态</strong></span>
      <PresenceSettingsMenu :mode="presenceMode" :ready="presenceReady" :syncing="presenceSyncing" :error="presenceError"
        :active="active" @select="emit('presenceMode', $event)" />
    </div>
    <InlineFeedback id="activity-visibility-feedback" :message="error || presenceError" />
    <p v-if="!desktop">动态检测仅在 Windows 桌面版提供</p>
    </div>
    <div v-if="desktop" class="activity-mappings">
      <header class="activity-mappings-heading">
        <h2>动态识别修正</h2>
        <p class="activity-current" :title="activity?.name">{{ activity ? `当前识别：${activity.name}` : '未检测到动态' }}</p>
      </header>
      <div class="activity-window-choice">
        <label for="activity-window">运行中的程序</label>
        <select id="activity-window" v-model="executable" :aria-busy="mappings.loading.value" aria-describedby="activity-mapping-feedback" :disabled="mappings.busy.value || !mappings.ready.value" @pointerdown="mappings.refreshWindows" @focus="mappings.refreshWindows">
          <option value="" disabled>选择正在运行的窗口</option>
          <option v-for="entry in mappings.windows.value" :key="entry.executable" :value="entry.executable">{{ entry.title }}</option>
          <option v-if="executable && !mappings.windows.value.some((entry) => entry.executable === executable)" :value="executable">{{ selectedName }}（未运行）</option>
        </select>
        <div class="activity-window-actions">
          <button type="button" :disabled="!executable || mappings.busy.value" title="清除当前选择，保留已保存的修正" @click="resetSelection">重置</button>
          <button type="button" :disabled="!executable || mappings.busy.value || !mappings.ready.value" @click="openEditor">修改名称</button>
        </div>
      </div>
      <div class="activity-mapping-feedback"><InlineFeedback id="activity-mapping-feedback" :message="(!editingName && mappings.error.value) || mappings.windowError.value"
        :pending="mappings.loading.value ? '正在读取窗口…' : ''" />
        <button v-if="!mappings.ready.value && !mappings.busy.value" type="button" @click="mappings.initialize">重试</button></div>
      <div v-if="mappings.entries.value.length" class="activity-saved-names">
        <h3>已保存的修正</h3>
        <div v-for="entry in mappings.entries.value" :key="entry.executable">
          <span>{{ entry.name }}</span><button type="button" :disabled="mappings.busy.value" :aria-label="`编辑动态名称 ${entry.name}`" @click="edit(entry)">编辑</button>
          <button type="button" :disabled="mappings.busy.value" :aria-label="`移除动态名称 ${entry.name}`" @click="mappings.remove(entry.executable)">移除</button>
        </div>
      </div>
      <small>名称按程序记忆，仍优先展示最新启动的游戏；音乐暂停后可能继续显示动态。</small>
    </div>
  </section>
  <DialogTransition>
    <ActivityNameDialog v-if="editingName" :initial-name="selectedName" :busy="mappings.busy.value" :error="mappings.error.value"
      @cancel="editingName = false" @save="saveName" />
  </DialogTransition>
</template>

<style scoped>
.activity-settings { grid-template-columns: minmax(0, 260px) minmax(0, 1fr); gap: 24px; padding-bottom: 24px; border-bottom: 1px solid var(--border-soft); }
.activity-heading { grid-column: 1 / -1; }
.activity-settings-controls { display: grid; align-content: start; gap: 12px; min-width: 0; }
.activity-profile-preview { position: relative; min-width: 0; height: 216px; align-self: start; }
@media (max-width: 1050px) { .activity-settings { grid-template-columns: minmax(0, 1fr); } .activity-profile-preview { max-width: 292px; } }
.activity-mappings-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; min-width: 0; }
.activity-mappings-heading h2 { flex-shrink: 0; }
.activity-current { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.activity-toggle { padding: 0; border-top: 0; }
.activity-presence { flex-wrap: wrap; }
.activity-mappings { grid-column: 1 / -1; display: grid; gap: 8px; min-width: 0; padding-top: 24px; border-top: 1px solid var(--border-soft); }
.activity-window-choice { display: grid; grid-template-columns: 100px minmax(0, 1fr) auto; align-items: center; gap: 12px; min-width: 0; }
.activity-window-actions { display: flex; gap: 8px; }
.activity-window-actions button { white-space: nowrap; }
.activity-window-choice select { min-width: 0; width: 100%; box-sizing: border-box; }
.activity-mappings small { color: var(--muted); font-size: 12px; line-height: 18px; }
.activity-mapping-feedback { display: flex; align-items: center; gap: 8px; }
.activity-mapping-feedback:not(:has(> *)) { display: none; }
.activity-mapping-feedback .inline-feedback { flex: 1; }
.activity-saved-names { display: grid; gap: 4px; }
.activity-saved-names h3 { margin: 0 0 4px; color: var(--muted); font-size: 13px; font-weight: 500; }
.activity-saved-names > div { display: flex; align-items: center; gap: 8px; min-width: 0; }
.activity-saved-names span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 640px) {
  .activity-window-choice { grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
  .activity-window-choice label { grid-column: 1 / -1; }
  .activity-mappings-heading { display: grid; gap: 4px; }
}
</style>
