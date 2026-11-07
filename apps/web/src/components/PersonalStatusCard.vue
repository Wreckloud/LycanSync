<script setup lang="ts">
import { ref, watch } from 'vue';
import { Check, Keyboard, LogOut, Pencil, SlidersHorizontal, UserRound } from '@lucide/vue';
import ActivityStatus from './ActivityStatus.vue';
import { useOwnVoiceTime } from '../profile/useOwnVoiceTime';
import InlineFeedback from './InlineFeedback.vue';
import ProfilePopover from './ProfilePopover.vue';
import type { PresenceMode } from '../presence/usePresencePreference';
import type { AuthUser } from '../auth/authApi';
import type { UserActivity, UserPresenceStatus } from '../presence/presenceApi';

const props = defineProps<{ user: AuthUser; status: UserPresenceStatus; statusLabel: string;
  activityStatus?: { type: UserActivity['type']; text: string; startedAt?: string } | null; menuEnabled?: boolean; active?: boolean;
  presenceMode?: PresenceMode; presenceReady?: boolean; presenceSyncing?: boolean; presenceError?: string }>();
const emit = defineEmits<{ settings: [section: 'account' | 'audio' | 'shortcuts', trigger: HTMLElement]; logout: [];
  presenceMode: [mode: PresenceMode] }>();
const menuOpen = defineModel<boolean>('menuOpen', { default: false });
const voiceTime = useOwnVoiceTime(() => menuOpen.value && props.active !== false);
const hovered = ref(false);
const trigger = ref<HTMLElement | null>(null);
const card = ref<HTMLElement | null>(null);

watch(() => props.active, active => { if (active === false) menuOpen.value = false; });

function selectSettings(section: 'account' | 'audio' | 'shortcuts') {
  menuOpen.value = false;
  if (trigger.value) emit('settings', section, trigger.value);
}

function logout() {
  menuOpen.value = false;
  trigger.value?.focus();
  emit('logout');
}
</script>

<template>
  <footer ref="card" class="personal-card" aria-label="个人状态与设置" @mouseenter="hovered = true" @mouseleave="hovered = false">
    <component :is="menuEnabled ? 'button' : 'div'" ref="trigger" class="personal-identity" data-identity="main" :class="{ 'is-interactive': menuEnabled }"
      :type="menuEnabled ? 'button' : undefined" :aria-label="menuEnabled ? '个人菜单' : undefined"
      :disabled="menuEnabled && active === false"
      :aria-expanded="menuEnabled ? menuOpen : undefined" :aria-haspopup="menuEnabled ? 'dialog' : undefined"
      @click="menuEnabled && active !== false && (menuOpen = !menuOpen)">
    <span class="personal-avatar">
      <img v-if="user.avatar" :src="user.avatar" class="profile-avatar" alt="" referrerpolicy="no-referrer" data-identity-avatar />
      <span v-else class="profile-avatar-placeholder" data-identity-avatar><UserRound :size="22" /></span>
      <span class="status-dot" :class="status" aria-hidden="true" />
    </span>
    <span class="personal-copy"><strong data-identity-name>{{ user.nickname }}</strong>
      <ActivityStatus v-if="activityStatus" :type="activityStatus.type" :text="activityStatus.text" :active="hovered" />
      <small v-else>{{ statusLabel }}</small>
    </span>
    </component>
    <slot />
    <ProfilePopover :anchor="menuEnabled && active !== false && menuOpen ? trigger : null" :position-anchor="card" placement="above" label="个人菜单"
      :nickname="user.nickname" :avatar="user.avatar" :signature="user.signature" :status="status" :status-label="statusLabel"
      :activity="activityStatus?.text" :activity-started-at="activityStatus?.startedAt" :voice-seconds="voiceTime.seconds.value"
      :voice-error="voiceTime.error.value"
      own-voice autofocus @close="menuOpen = false">
      <div v-if="presenceMode" class="personal-presence">
        <div class="personal-presence-row">
          <span>在线状态</span>
          <div class="presence-options" role="group" aria-label="在线状态" :aria-busy="presenceSyncing || !presenceReady">
            <button v-for="mode in (['online', 'invisible'] as const)" :key="mode" type="button" class="presence-option"
              :aria-label="mode === 'online' ? '在线' : '隐身'" :aria-pressed="presenceReady && presenceMode === mode" :disabled="!presenceReady"
              @click="emit('presenceMode', mode)">
              <span class="presence-option-dot" :class="mode" aria-hidden="true" />{{ mode === 'online' ? '在线' : '隐身' }}
              <Check :size="14" class="presence-option-check" aria-hidden="true" />
            </button>
          </div>
        </div>
        <InlineFeedback :message="presenceError" />
      </div>
      <div class="personal-menu-actions">
        <button type="button" @click="selectSettings('account')"><Pencil :size="15" />编辑个人资料</button>
        <button type="button" @click="selectSettings('audio')"><SlidersHorizontal :size="15" />语音与音频</button>
        <button type="button" @click="selectSettings('shortcuts')"><Keyboard :size="15" />快捷键</button>
        <div class="personal-menu-session">
          <button type="button" @click="logout"><LogOut :size="15" />退出登录</button>
        </div>
      </div>
    </ProfilePopover>
  </footer>
</template>

<style scoped>
.personal-identity { display: contents; }
.personal-identity.is-interactive { display: grid; grid-column: 1 / span 2; grid-template-columns: 32px minmax(0, 1fr); align-items: center; gap: 8px; min-width: 0; padding: 0; border: 0; border-radius: 5px; background: transparent; color: inherit; text-align: left; }
.personal-identity.is-interactive:hover, .personal-identity.is-interactive[aria-expanded='true'] { background: var(--panel-raised); }
.personal-menu-actions { display: grid; padding-top: 4px; border-top: 1px solid var(--border-soft); }
.personal-presence { display: grid; gap: 6px; padding-top: 8px; border-top: 1px solid var(--border-soft); }
.personal-presence-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; color: var(--muted); }
.personal-menu-actions button { display: flex; align-items: center; justify-content: flex-start; gap: 8px; width: 100%; min-height: 32px; padding: 7px 0; border: 0; background: transparent; color: var(--muted); font-size: 13px; line-height: 18px; text-align: left; }
.personal-menu-actions button:hover:not(:disabled) { color: var(--text); }
.personal-menu-session { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--border-soft); }
.personal-menu-session button { color: var(--danger); }
</style>
