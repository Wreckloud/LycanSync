<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import PresenceModeSwitch from '../PresenceModeSwitch.vue';
import ActivityNameDialog from '../ActivityNameDialog.vue';
import DialogTransition from '../DialogTransition.vue';
import InlineFeedback from '../InlineFeedback.vue';
import ProfilePopover from '../ProfilePopover.vue';
import { useOwnVoiceTime } from '../../profile/useOwnVoiceTime';
import type { AuthUser } from '../../auth/authApi';
import { PRESENCE_STATUS_LABELS, type UserActivity, type UserPresenceStatus } from '../../presence/presenceApi';
import type { useActivityMappings } from '../../settings/useActivityMappings';
import type { PresenceMode } from '../../presence/usePresencePreference';

const props = defineProps<{ user: AuthUser; desktop: boolean; active: boolean; activity: (UserActivity & Pick<DetectedActivity, 'selectedExecutable'>) | null;
  status?: UserPresenceStatus;
  presenceMode?: PresenceMode; presenceReady?: boolean; presenceSyncing?: boolean; presenceError?: string;
  showActivity: boolean; showLastOnline: boolean; error: string; mappings: ReturnType<typeof useActivityMappings> }>();
const emit = defineEmits<{ visibility: [enabled: boolean]; lastOnlineVisibility: [enabled: boolean]; presenceMode: [mode: PresenceMode] }>();
const offlineTarget = ref('');
const selected = computed(() => props.activity?.selectedExecutable ?? '');
const executable = computed(() => offlineTarget.value || selected.value);
const editingName = ref(false);
const editingExecutable = ref('');
const offlineEntries = computed(() => !props.mappings.windowsReady.value ? [] : props.mappings.entries.value.filter(entry => entry.executable !== selected.value
  && !props.mappings.windows.value.some(window => window.executable === entry.executable)));
const editingAlias = computed(() => props.mappings.entries.value.find(entry => entry.executable === editingExecutable.value)?.name);
const initialName = computed(() => editingAlias.value ?? (editingExecutable.value === selected.value ? props.activity?.name : '') ?? '');
const voiceTime = useOwnVoiceTime(() => props.active);
const presenceDescription = computed(() => {
  if (props.presenceMode === 'invisible') return '向朋友显示离线，仍可正常聊天、通话和共享画面。';
  if (props.status === 'AWAY') return '当前显示为闲置，回来后自动恢复在线。';
  return '离开电脑后自动显示闲置，回来后恢复在线。';
});

function openEditor() {
  if (!executable.value || props.mappings.busy.value || !props.mappings.ready.value) return;
  props.mappings.error.value = '';
  editingExecutable.value = executable.value;
  editingName.value = true;
}

async function selectProgram(event: Event) {
  const input = event.target as HTMLSelectElement;
  const target = input.value;
  input.value = executable.value;
  props.mappings.error.value = '';
  if (offlineEntries.value.some(entry => entry.executable === target)) {
    offlineTarget.value = target;
  } else if (target === selected.value || await props.mappings.select(target)) {
    offlineTarget.value = '';
  }
}

async function saveName(name: string) {
  if (await props.mappings.save(editingExecutable.value, name)) editingName.value = false;
}

async function removeName() {
  if (await props.mappings.remove(editingExecutable.value)) editingName.value = false;
}

watch(offlineEntries, entries => {
  if (!entries.some(entry => entry.executable === offlineTarget.value)) offlineTarget.value = '';
});
watch(() => props.active, (active) => {
  editingName.value = false;
  offlineTarget.value = '';
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
    <div class="settings-toggle">
      <span><strong>显示动态</strong><small>向朋友展示正在玩的游戏、正在听的音乐和最近游玩记录。</small></span>
      <input type="checkbox" :checked="showActivity" aria-label="显示动态"
        @change="emit('visibility', ($event.target as HTMLInputElement).checked)" />
    </div>
    <div class="settings-toggle">
      <span><strong>显示上次在线时间</strong><small>让朋友看到你最后一次在线的时间。</small></span>
      <input type="checkbox" :checked="showLastOnline" aria-label="显示上次在线时间"
        @change="emit('lastOnlineVisibility', ($event.target as HTMLInputElement).checked)" />
    </div>
    <div class="settings-toggle activity-presence">
      <span><strong>在线状态</strong><small id="activity-presence-description">{{ presenceDescription }}</small></span>
      <PresenceModeSwitch :mode="presenceMode" :ready="presenceReady" :syncing="presenceSyncing" :error="presenceError"
        :active="active" aria-describedby="activity-presence-description activity-visibility-feedback" @select="emit('presenceMode', $event)" />
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
        <select id="activity-window" :value="executable" :aria-busy="mappings.loading.value" aria-describedby="activity-mapping-feedback" :disabled="mappings.busy.value || !mappings.ready.value" @change="selectProgram" @pointerdown="mappings.refreshWindows" @focus="mappings.refreshWindows">
          <option value="" disabled>自动识别</option>
          <option v-for="entry in mappings.windows.value" :key="entry.executable" :value="entry.executable">{{ entry.title }}</option>
          <option v-if="selected && !mappings.windows.value.some(entry => entry.executable === selected)" :value="selected">{{ activity?.name }}</option>
          <option v-for="entry in offlineEntries" :key="entry.executable" :value="entry.executable">{{ entry.name }}（未运行）</option>
        </select>
        <div class="activity-window-actions">
          <button type="button" :disabled="!selected || !!offlineTarget || mappings.busy.value" title="恢复自动识别并移除当前程序的自定义名称" @click="mappings.reset">重置</button>
          <button type="button" :disabled="!executable || mappings.busy.value || !mappings.ready.value" @click="openEditor">修改名称</button>
        </div>
      </div>
      <div class="activity-mapping-feedback"><InlineFeedback id="activity-mapping-feedback" :message="(!editingName && mappings.error.value) || mappings.windowError.value"
        :pending="mappings.loading.value ? '正在读取窗口…' : ''" />
        <button v-if="!mappings.ready.value && !mappings.busy.value" type="button" @click="mappings.initialize">重试</button></div>
      <small>所选程序会优先展示，关闭后恢复自动识别。</small>
    </div>
  </section>
  <DialogTransition>
    <ActivityNameDialog v-if="editingName" :initial-name="initialName" :has-alias="!!editingAlias" :busy="mappings.busy.value" :error="mappings.error.value"
      @cancel="editingName = false" @remove="removeName" @save="saveName" />
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
.activity-presence { display: grid; grid-template-columns: minmax(0, 1fr) 152px; align-items: start; }
.activity-presence :deep(.presence-mode-switch) { width: 152px; max-width: 100%; margin-left: auto; }
.activity-mappings { grid-column: 1 / -1; display: grid; gap: 8px; min-width: 0; padding-top: 24px; border-top: 1px solid var(--border-soft); }
.activity-window-choice { display: grid; grid-template-columns: 100px minmax(0, 1fr) auto; align-items: center; gap: 12px; min-width: 0; }
.activity-window-actions { display: flex; gap: 8px; }
.activity-window-actions button { white-space: nowrap; }
.activity-window-choice select { min-width: 0; width: 100%; box-sizing: border-box; }
.activity-mappings small { color: var(--muted); font-size: 12px; line-height: 18px; }
.activity-mapping-feedback { display: flex; align-items: center; gap: 8px; }
.activity-mapping-feedback:not(:has(> *)) { display: none; }
.activity-mapping-feedback .inline-feedback { flex: 1; }
@media (max-width: 640px) {
  .activity-window-choice { grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .activity-window-choice label { grid-column: 1 / -1; }
  .activity-window-actions { justify-self: end; }
  .activity-mappings-heading { display: grid; gap: 4px; }
}
</style>
