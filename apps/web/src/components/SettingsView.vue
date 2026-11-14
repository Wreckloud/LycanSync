<script setup lang="ts">
import '../settings/settings.css';
import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import type { AuthUser, ProfileUpdate } from '../auth/authApi';
import type { useAudioPreferences } from '../rtc/useAudioPreferences';
import type { useRtcRoom } from '../rtc/useRtcRoom';
import type { useMicrophoneTest } from '../rtc/useMicrophoneTest';
import type { useMicrophoneDevices } from '../rtc/useMicrophoneDevices';
import type { useAudioOutput } from '../rtc/useAudioOutput';
import type { useDiagnosticReport } from '../diagnostics/useDiagnosticReport';
import type { useActivityMappings } from '../settings/useActivityMappings';
import type { useVoiceOverlay } from '../overlay/useVoiceOverlay';
import AccountSettings from './settings/AccountSettings.vue';
import OwnerSettings from './settings/OwnerSettings.vue';
import ActivitySettings from './settings/ActivitySettings.vue';
import AudioSettings from './settings/AudioSettings.vue';
import ClientSettings from './settings/ClientSettings.vue';
import OverlaySettings from './settings/OverlaySettings.vue';
import ProfileSettings from './settings/ProfileSettings.vue';
import SoundSettings from './settings/SoundSettings.vue';
import ShortcutSettings from './settings/ShortcutSettings.vue';
import type { useAudioShortcuts } from '../settings/useAudioShortcuts';
import type { useCallSoundPreferences } from '../settings/useCallSoundPreferences';
import type { useCallSounds } from '../rtc/useCallSounds';
import RecordingSettings from './settings/RecordingSettings.vue';
import ScreenShareSettings from './settings/ScreenShareSettings.vue';
import type { CustomScreenShareQuality, ScreenShareQualityId } from '../rtc/screenShareQuality';
import type { useRecording } from '../recording/useRecording';
import { SETTINGS_SECTIONS, settingsSectionTitle, type SettingsSectionId } from '../settings/settingsSections';
import type { UserActivity, UserPresenceStatus } from '../presence/presenceApi';
import type { PresenceMode } from '../presence/usePresencePreference';
import type { GroupDetail } from '../group/groupApi';

const props = defineProps<{
  section: SettingsSectionId;
  user: AuthUser;
  blocked?: boolean;
  desktop: boolean;
  audioShortcuts: UnwrapNestedRefs<ReturnType<typeof useAudioShortcuts>>;
  callSoundPreferences: ReturnType<typeof useCallSoundPreferences>;
  callSounds: ReturnType<typeof useCallSounds>;
  recording?: ReturnType<typeof useRecording>;
  shareQuality: ScreenShareQualityId;
  customShareQuality: CustomScreenShareQuality;
  sharedAudio: boolean;
  changeShareQuality: (quality: ScreenShareQualityId, custom?: CustomScreenShareQuality) => Promise<boolean>;
  changeShareAudio: (enabled: boolean) => Promise<boolean>;
  overlay?: ReturnType<typeof useVoiceOverlay>;
  preferences: ReturnType<typeof useAudioPreferences>;
  rtc: UnwrapNestedRefs<ReturnType<typeof useRtcRoom>>;
  microphoneTest: UnwrapNestedRefs<ReturnType<typeof useMicrophoneTest>>;
  microphoneDevices: UnwrapNestedRefs<ReturnType<typeof useMicrophoneDevices>>;
  audioOutput: ReturnType<typeof useAudioOutput>;
  diagnosticReport: ReturnType<typeof useDiagnosticReport>;
  inputLevelPercent: number;
  activity: UserActivity | null;
  presenceStatus?: UserPresenceStatus;
  presenceMode?: PresenceMode;
  presenceReady?: boolean;
  presenceSyncing?: boolean;
  presenceError?: string;
  showActivity: boolean;
  showLastOnline: boolean;
  activityError: string;
  activityMappings: ReturnType<typeof useActivityMappings>;
  saveProfile: (profile: ProfileUpdate) => Promise<AuthUser>;
}>();
const emit = defineEmits<{ close: []; logout: []; groupUpdated: [group: GroupDetail]; groupRemoved: [id: string]; 'update:section': [section: SettingsSectionId]; activityVisibility: [enabled: boolean]; lastOnlineVisibility: [enabled: boolean]; presenceMode: [mode: PresenceMode] }>();
const ownerSettings = ref<InstanceType<typeof OwnerSettings> | null>(null);
const returningToClosure = ref(false);
async function resolveOwner() {
  await selectSection('members');
  if (activeSection.value !== 'members') return;
  returningToClosure.value = true;
  await nextTick();
  await ownerSettings.value?.beginTransfer();
}
const heading = ref<HTMLElement | null>(null);
const profileSettings = ref<InstanceType<typeof ProfileSettings> | null>(null);
const activitySettings = ref<InstanceType<typeof ActivitySettings> | null>(null);
const clientSettings = ref<InstanceType<typeof ClientSettings> | null>(null);
const activeSection = ref<SettingsSectionId>(props.section);
const leaving = ref(false);
const sectionTitle = computed(() => settingsSectionTitle(activeSection.value));
const sectionDescription = computed(() => SETTINGS_SECTIONS.find(item => item.id === activeSection.value)!.description);
const visibleSections = computed(() => SETTINGS_SECTIONS.filter((item) => (item.id !== 'members' || props.user.administrator)
  && (item.id !== 'recording' || (props.desktop && props.recording))
  && (item.id !== 'overlay' || (props.desktop && props.overlay))));
const interactionBlocked = computed(() => Boolean(props.blocked || profileSettings.value?.cropping
  || activitySettings.value?.editingName || clientSettings.value?.confirmingUpdate || clientSettings.value?.confirmingCache));

watch(() => props.section, (section) => { activeSection.value = section; });
watch(activeSection, async () => {
  await nextTick();
  heading.value?.focus();
});

onMounted(() => heading.value?.focus());
onScopeDispose(() => { void props.microphoneTest.stop(); });

async function selectSection(section: SettingsSectionId) {
  if (section === 'members' && !props.user.administrator) return;
  if (interactionBlocked.value || leaving.value || section === activeSection.value) return;
  if (activeSection.value === 'account' && !await profileSettings.value?.finishEditing()) return;
  activeSection.value = section;
  emit('update:section', section);
}

function closeSettings() {
  void leaveSettings(false);
}

function requestLogout() {
  void leaveSettings(true);
}

async function leaveSettings(logout: boolean) {
  if (interactionBlocked.value || leaving.value) return;
  leaving.value = true;
  try {
    if (!await profileSettings.value?.finishEditing()) {
      activeSection.value = 'account';
      emit('update:section', 'account');
      return;
    }
    if (logout) emit('logout');
    else emit('close');
  } finally {
    leaving.value = false;
  }
}
defineExpose({ selectSection, closeSettings, requestLogout, interactionBlocked, leaving });
</script>

<template>
  <main class="settings-view" aria-label="设置" :inert="interactionBlocked" @keydown.esc.stop="closeSettings">
    <nav class="settings-sidebar" aria-label="设置栏目">
      <div class="settings-navigation">
        <button v-for="item in visibleSections" :key="item.id" type="button"
          :class="{ 'is-selected': activeSection === item.id }" :aria-current="activeSection === item.id ? 'page' : undefined"
          :disabled="leaving" @click="selectSection(item.id)">{{ item.title }}</button>
      </div>
      <div class="settings-footer-space" aria-hidden="true" />
    </nav>
    <section class="settings-main">
      <header class="settings-header">
        <div class="settings-header-content">
          <h1 ref="heading" tabindex="-1">{{ sectionTitle }}</h1>
        </div>
      </header>
      <div class="settings-content">
        <p class="settings-intro settings-page-intro">{{ sectionDescription }}</p>
        <div v-if="user.administrator && activeSection === 'members'" class="owner-settings-page">
          <button v-if="returningToClosure" type="button" class="settings-button" @click="selectSection('account')">返回注销流程</button>
          <OwnerSettings ref="ownerSettings" :active="true" :leaving="leaving" />
        </div>
        <div v-show="activeSection === 'account'" class="settings-account-page">
          <ProfileSettings ref="profileSettings" :user="user" :save-profile="saveProfile" />
          <ActivitySettings ref="activitySettings" :user="user" :status="presenceStatus" :desktop="desktop" :activity="activity" :show-activity="showActivity" :show-last-online="showLastOnline"
            :presence-mode="presenceMode" :presence-ready="presenceReady" :presence-syncing="presenceSyncing" :presence-error="presenceError"
            @presence-mode="emit('presenceMode', $event)"
            :mappings="activityMappings" :active="activeSection === 'account'"
            :error="activityError" @visibility="emit('activityVisibility', $event)" @last-online-visibility="emit('lastOnlineVisibility', $event)" />
          <AccountSettings :active="activeSection === 'account'" :leaving="leaving" :administrator="user.administrator" :user-id="user.id" @logout="requestLogout"
            @resolve-owner="resolveOwner" @group-updated="emit('groupUpdated', $event)" @group-removed="emit('groupRemoved', $event)" />
        </div>
        <AudioSettings v-show="activeSection === 'audio'" :active="activeSection === 'audio'"
          :desktop="desktop" :preferences="preferences" :audio-output="audioOutput" :rtc="rtc" :microphone-test="microphoneTest" :microphone-devices="microphoneDevices"
          :input-level-percent="inputLevelPercent" />
        <SoundSettings v-show="activeSection === 'sound'" :user-id="user.id" :active="activeSection === 'sound'" :output="audioOutput"
          :preferences="callSoundPreferences" :sounds="callSounds" />
        <ShortcutSettings v-show="activeSection === 'shortcuts'" :active="activeSection === 'shortcuts'" :shortcuts="audioShortcuts" />
        <OverlaySettings v-if="desktop && overlay" v-show="activeSection === 'overlay'" :overlay="overlay" :active="activeSection === 'overlay'" />
        <div v-if="recording" v-show="activeSection === 'recording'" class="settings-recording-page">
          <ScreenShareSettings v-if="desktop" :active="activeSection === 'recording'" :rtc="rtc" :shared-audio="sharedAudio" :quality="shareQuality" :custom-quality="customShareQuality"
            :change-quality="changeShareQuality" :change-audio="changeShareAudio" />
          <RecordingSettings :recording="recording" :desktop="desktop" :sharing="rtc.screenShareActive" :active="activeSection === 'recording'" />
        </div>
        <ClientSettings ref="clientSettings" v-show="activeSection === 'client'" :desktop="desktop" :active="activeSection === 'client'" :user-id="user.id"
          :room="rtc.room" :report="diagnosticReport" />
      </div>
    </section>
  </main>
</template>

<style scoped>
.owner-settings-page { display: grid; justify-items: start; gap: 16px; }
.settings-recording-page { display: grid; gap: 24px; }
.settings-view {
  position: fixed;
  z-index: 3;
  inset: var(--titlebar-height) 0 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--member-panel-width);
  grid-template-areas: 'main sidebar';
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--panel);
  font-size: 14px;
}
.settings-sidebar {
  grid-area: sidebar;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-left: 1px solid var(--border);
  background: var(--panel-sidebar);
}
.settings-navigation { display: flex; flex-direction: column; gap: 4px; min-height: 0; overflow-y: auto; padding: 20px 14px; }
.settings-navigation > button { flex: 0 0 auto; min-height: 38px; padding: 8px 11px; border: 0; border-radius: 5px; background: transparent; color: var(--muted); text-align: left; cursor: pointer; }
.settings-navigation > button:hover { background: var(--panel-soft); color: var(--text); }
.settings-navigation > button.is-selected { background: var(--panel-raised); color: var(--text); }
.settings-footer-space { height: calc(var(--voice-bar-height) + var(--voice-bar-bottom-space)); }
.settings-main { grid-area: main; min-width: 0; min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); background: var(--panel); }
.settings-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 64px; padding: 12px 24px; border-bottom: 1px solid var(--border-soft); }
.settings-header-content { display: flex; align-items: center; justify-content: space-between; gap: 16px; width: 100%; max-width: 820px; margin-inline: auto; }
.settings-header h1 { margin: 0; font-size: 19px; font-weight: 600; }
.settings-header h1:focus { outline: none; }
.settings-content { min-width: 0; min-height: 0; overflow: auto; scrollbar-gutter: stable both-edges; padding: 20px 24px 24px; }
.settings-content > * { width: 100%; max-width: 820px; margin-inline: auto; }
.settings-page-intro { color: var(--muted); font-size: 14px; line-height: 1.6; margin-bottom: 24px; }
.settings-account-page { display: grid; gap: 24px; width: 100%; max-width: 820px; }
@media (max-width: 760px) {
  .settings-view { grid-template-columns: minmax(0, 1fr) 176px; }
  .settings-navigation { padding: 14px 8px; }
  .settings-header { min-height: 56px; padding: 10px 16px; }
  .settings-content { padding: 16px; }
}
@media (max-width: 520px) {
  .settings-view { grid-template-columns: minmax(0, 1fr) 132px; }
  .settings-navigation > button { padding: 7px 8px; font-size: 13px; }
}
</style>
