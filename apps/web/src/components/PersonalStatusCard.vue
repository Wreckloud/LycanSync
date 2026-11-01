<script setup lang="ts">
import { ref, watch } from 'vue';
import { Check, ChevronDown, Keyboard, LogOut, Pencil, SlidersHorizontal, UserRound } from '@lucide/vue';
import ActivityStatus from './ActivityStatus.vue';
import ExpandSection from './ExpandSection.vue';
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
const hovered = ref(false);
const trigger = ref<HTMLElement | null>(null);
const statusExpanded = ref(false);
watch(() => props.active, active => { if (active === false) menuOpen.value = false; });
watch(menuOpen, open => { if (!open) statusExpanded.value = false; });

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
  <footer class="personal-card" aria-label="个人状态与设置" @mouseenter="hovered = true" @mouseleave="hovered = false">
    <component :is="menuEnabled ? 'button' : 'div'" ref="trigger" class="personal-identity" :class="{ 'is-interactive': menuEnabled }"
      :type="menuEnabled ? 'button' : undefined" :aria-label="menuEnabled ? '个人菜单' : undefined"
      :disabled="menuEnabled && active === false"
      :aria-expanded="menuEnabled ? menuOpen : undefined" :aria-haspopup="menuEnabled ? 'dialog' : undefined"
      @click="menuEnabled && active !== false && (menuOpen = !menuOpen)">
    <span class="personal-avatar">
      <img v-if="user.avatar" :src="user.avatar" class="profile-avatar" alt="" referrerpolicy="no-referrer" />
      <span v-else class="profile-avatar-placeholder"><UserRound :size="22" /></span>
      <span class="status-dot" :class="status" aria-hidden="true" />
    </span>
    <span class="personal-copy"><strong>{{ user.nickname }}</strong>
      <ActivityStatus v-if="activityStatus" :type="activityStatus.type" :text="activityStatus.text" :active="hovered" />
      <small v-else>{{ statusLabel }}</small>
    </span>
    </component>
    <slot />
    <ProfilePopover :anchor="menuEnabled && active !== false && menuOpen ? trigger : null" placement="above" label="个人菜单"
      :nickname="user.nickname" :avatar="user.avatar" :signature="user.signature" :status="status" :status-label="statusLabel"
      :activity="activityStatus?.text" :activity-started-at="activityStatus?.startedAt" autofocus @close="menuOpen = false">
      <div class="personal-menu-actions">
        <button type="button" @click="selectSettings('account')"><Pencil :size="15" />编辑个人资料</button>
        <template v-if="presenceMode">
          <button type="button" class="personal-presence-toggle" :disabled="!presenceReady" :aria-expanded="statusExpanded"
            aria-label="在线状态" aria-controls="personal-presence-options" :aria-busy="presenceSyncing || !presenceReady"
            @click="statusExpanded = !statusExpanded">
            <span class="personal-presence-dot" :class="presenceMode" aria-hidden="true" />
            <span>{{ presenceMode === 'invisible' ? '隐身' : '在线' }}</span><ChevronDown :size="14" :class="{ 'is-open': statusExpanded }" />
          </button>
          <ExpandSection :open="statusExpanded" id="personal-presence-options">
            <div class="personal-presence-options" aria-label="在线状态选择">
              <button type="button" aria-label="在线" :aria-pressed="presenceMode === 'online'" @click="emit('presenceMode', 'online')">
                <span class="personal-presence-dot online" aria-hidden="true" /><span>在线</span><Check v-if="presenceMode === 'online'" :size="14" />
              </button>
              <button type="button" aria-label="隐身" :aria-pressed="presenceMode === 'invisible'" @click="emit('presenceMode', 'invisible')">
                <span class="personal-presence-dot invisible" aria-hidden="true" /><span>隐身</span><Check v-if="presenceMode === 'invisible'" :size="14" />
              </button>
            </div>
          </ExpandSection>
          <ExpandSection :open="!!presenceError || !presenceReady || !!presenceSyncing">
            <InlineFeedback class="personal-presence-feedback" :message="presenceError"
              :status="!presenceReady ? '正在读取状态偏好…' : presenceSyncing ? '正在同步状态…' : ''" />
          </ExpandSection>
        </template>
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
.personal-menu-actions button { display: flex; align-items: center; justify-content: flex-start; gap: 8px; width: 100%; min-height: 32px; padding: 7px 0; border: 0; background: transparent; color: var(--muted); font-size: 13px; line-height: 18px; text-align: left; }
.personal-menu-actions button:hover:not(:disabled) { color: var(--text); }
.personal-menu-session { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--border-soft); }
.personal-menu-session button { color: var(--danger); }
.personal-presence-dot { flex-shrink: 0; width: 10px; height: 10px; margin: 0 2.5px; border-radius: 50%; background: var(--subtle); }
.personal-presence-dot.online { background: var(--good); }
.personal-presence-toggle > svg { margin-left: auto; transition: transform var(--motion-feedback-duration) ease; }
.personal-presence-toggle > svg.is-open { transform: rotate(180deg); }
.personal-presence-feedback { height: auto; padding: 4px 8px; }
.personal-presence-options { padding-left: 23px; }
.personal-presence-options button > svg { margin-left: auto; }
.personal-presence-options button[aria-pressed='true'] { color: var(--text); }
</style>
