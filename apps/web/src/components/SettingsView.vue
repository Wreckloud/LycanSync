<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { ArrowLeft } from '@lucide/vue';
import type { AuthUser, ProfileUpdate } from '../auth/authApi';
import type { useAudioPreferences } from '../rtc/useAudioPreferences';
import type { useRtcRoom } from '../rtc/useRtcRoom';
import type { useMicrophoneTest } from '../rtc/useMicrophoneTest';
import IconButton from './IconButton.vue';
import PersonalStatusCard from './PersonalStatusCard.vue';
import AboutSettings from './settings/AboutSettings.vue';
import AccountSettings from './settings/AccountSettings.vue';
import MemberAccessSettings from './settings/MemberAccessSettings.vue';
import ActivitySettings from './settings/ActivitySettings.vue';
import AudioSettings from './settings/AudioSettings.vue';
import ClientSettings from './settings/ClientSettings.vue';
import ProfileSettings from './settings/ProfileSettings.vue';
import SoundSettings from './settings/SoundSettings.vue';
import { SETTINGS_SECTIONS, settingsSectionTitle, type SettingsSectionId } from '../settings/settingsSections';
import type { UserActivity, UserPresenceStatus } from '../presence/presenceApi';

const props = defineProps<{
  section: SettingsSectionId;
  user: AuthUser;
  presenceStatus: UserPresenceStatus;
  presenceLabel: string;
  desktop: boolean;
  preferences: ReturnType<typeof useAudioPreferences>;
  rtc: UnwrapNestedRefs<ReturnType<typeof useRtcRoom>>;
  microphoneTest: UnwrapNestedRefs<ReturnType<typeof useMicrophoneTest>>;
  inputLevelPercent: number;
  activity: UserActivity | null;
  showActivity: boolean;
  activityError: string;
  stageAutoFill: boolean;
  stagePreferenceError: string;
  saveProfile: (profile: ProfileUpdate) => Promise<AuthUser>;
}>();
const emit = defineEmits<{ close: []; logout: []; activityVisibility: [enabled: boolean]; stageAutoFill: [enabled: boolean] }>();
const heading = ref<HTMLElement | null>(null);
const profileSettings = ref<InstanceType<typeof ProfileSettings> | null>(null);
const activeSection = ref<SettingsSectionId>(props.section);
const leaving = ref(false);
const sectionTitle = computed(() => settingsSectionTitle(activeSection.value));
const visibleSections = computed(() => SETTINGS_SECTIONS.filter((item) => item.id !== 'members' || props.user.administrator));

watch(() => props.section, (section) => { activeSection.value = section; });
watch(activeSection, async () => {
  await nextTick();
  heading.value?.focus();
});

onMounted(() => heading.value?.focus());
onScopeDispose(() => { void props.microphoneTest.stop(); });

async function selectSection(section: SettingsSectionId) {
  if (section === 'members' && !props.user.administrator) return;
  if (leaving.value || section === activeSection.value) return;
  if (activeSection.value === 'account' && !await profileSettings.value?.save()) return;
  activeSection.value = section;
}

function closeSettings() {
  void leaveSettings(false);
}

function requestLogout() {
  void leaveSettings(true);
}

async function leaveSettings(logout: boolean) {
  if (leaving.value) return;
  leaving.value = true;
  try {
    if (!await profileSettings.value?.save()) {
      activeSection.value = 'account';
      return;
    }
    if (logout) emit('logout');
    else emit('close');
  } finally {
    leaving.value = false;
  }
}
</script>

<template>
  <main class="settings-view" aria-label="设置" @keydown.esc.stop="closeSettings">
    <nav class="settings-sidebar" aria-label="设置栏目">
      <button v-for="item in visibleSections" :key="item.id" type="button"
        :class="{ 'is-selected': activeSection === item.id }" :aria-current="activeSection === item.id ? 'page' : undefined"
        :disabled="leaving" @click="selectSection(item.id)">{{ item.title }}</button>
      <div class="settings-sidebar-spacer" />
      <PersonalStatusCard class="settings-footer" aria-label="个人状态与返回应用"
        :user="user" :status="presenceStatus" :status-label="presenceLabel">
        <IconButton label="返回应用" :disabled="leaving" @click="closeSettings"><ArrowLeft :size="19" /></IconButton>
      </PersonalStatusCard>
    </nav>
    <section class="settings-main">
      <header class="settings-header">
        <div class="settings-header-content">
          <h1 ref="heading" tabindex="-1">{{ sectionTitle }}</h1>
        </div>
      </header>
      <div class="settings-content">
        <MemberAccessSettings v-if="user.administrator && activeSection === 'members'" :active="true" />
        <div v-show="activeSection === 'account'" class="settings-account-page">
          <ProfileSettings ref="profileSettings" :user="user" :save-profile="saveProfile" />
          <ActivitySettings :desktop="desktop" :activity="activity" :show-activity="showActivity"
            :error="activityError" @visibility="emit('activityVisibility', $event)" />
          <AccountSettings :active="activeSection === 'account'" :leaving="leaving" @logout="requestLogout" />
        </div>
        <AudioSettings v-show="activeSection === 'audio'" :active="activeSection === 'audio'"
          :desktop="desktop" :preferences="preferences" :rtc="rtc" :microphone-test="microphoneTest"
          :input-level-percent="inputLevelPercent" />
        <SoundSettings v-show="activeSection === 'sound'" :user-id="user.id" :active="activeSection === 'sound'" />
        <ClientSettings v-show="activeSection === 'client'" :desktop="desktop" :active="activeSection === 'client'"
          :stage-auto-fill="stageAutoFill" :stage-preference-error="stagePreferenceError" @stage-auto-fill="emit('stageAutoFill', $event)" />
        <AboutSettings v-show="activeSection === 'about'" :active="activeSection === 'about'" :rtc="rtc" />
      </div>
    </section>
  </main>
</template>

<style scoped>
.settings-view {
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
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 14px 0;
  border-left: 1px solid var(--border);
  background: #0d1116;
}
.settings-sidebar > button { flex: 0 0 auto; min-height: 38px; padding: 8px 11px; border: 0; border-radius: 5px; background: transparent; color: var(--muted); text-align: left; cursor: pointer; }
.settings-sidebar > button:hover { background: var(--panel-soft); color: var(--text); }
.settings-sidebar > button.is-selected { background: var(--panel-raised); color: var(--text); }
.settings-footer { position: sticky; bottom: 0; flex-shrink: 0; margin: 0 -14px; background: #0d1116; }
.settings-sidebar-spacer { flex: 1; min-height: 32px; }
.settings-main { grid-area: main; min-width: 0; min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); }
.settings-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 64px; padding: 12px 24px; border-bottom: 1px solid var(--border-soft); }
.settings-header-content { display: flex; align-items: center; justify-content: space-between; gap: 16px; width: 100%; max-width: 820px; margin-inline: auto; }
.settings-header h1 { margin: 0; font-size: 19px; font-weight: 600; }
.settings-header h1:focus { outline: none; }
.settings-content { min-width: 0; min-height: 0; overflow: auto; padding: 20px 24px 24px; }
.settings-content > * { width: 100%; max-width: 820px; margin-inline: auto; }
.settings-account-page { display: grid; gap: 16px; width: 100%; max-width: 820px; }
@media (max-width: 760px) {
  .settings-view { grid-template-columns: minmax(0, 1fr) 176px; }
  .settings-sidebar { padding: 14px 8px 0; }
  .settings-footer { margin-inline: -8px; }
  .settings-header { min-height: 56px; padding: 10px 16px; }
  .settings-content { padding: 16px; }
}
@media (max-width: 520px) {
  .settings-view { grid-template-columns: minmax(0, 1fr) 132px; }
  .settings-sidebar > button { padding: 7px 8px; font-size: 13px; }
}
</style>
