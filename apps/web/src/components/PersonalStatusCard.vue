<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { Check, ChevronDown, CircleUserRound, Keyboard, LogOut, Pencil, SlidersHorizontal, UserRound } from '@lucide/vue';
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
const presenceMenu = ref<HTMLElement | null>(null);
const presenceOpen = ref(false);
const highlightedMode = ref<PresenceMode | null>(null);
const presenceModes = computed(() => props.presenceMode === 'invisible'
  ? ['invisible', 'online'] as const : ['online', 'invisible'] as const);
let pointerId: number | null = null;
let pointerMoved = false;
let pointerStartY = 0;

function closePresence() {
  presenceOpen.value = false;
  highlightedMode.value = null;
  pointerId = null;
}

function choosePresence(mode: PresenceMode) {
  closePresence();
  if (props.presenceReady && (mode !== props.presenceMode || props.presenceError)) emit('presenceMode', mode);
}

async function openPresenceKeyboard() {
  presenceOpen.value = true;
  await nextTick();
  presenceMenu.value?.querySelector<HTMLElement>('[role="menuitemradio"]')?.focus();
}

function movePresenceKeyboard(event: KeyboardEvent) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  const options = [...presenceMenu.value!.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  const index = options.indexOf(event.target as HTMLElement);
  options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus();
}

function beginPresence(event: PointerEvent) {
  if (event.button !== 0 || !props.presenceReady) return;
  event.preventDefault();
  if (presenceOpen.value) { closePresence(); return; }
  presenceOpen.value = true;
  highlightedMode.value = props.presenceMode ?? null;
  pointerId = event.pointerId;
  pointerMoved = false;
  pointerStartY = event.clientY;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function movePresence(event: PointerEvent) {
  if (event.pointerId !== pointerId) return;
  if (Math.abs(event.clientY - pointerStartY) > 4) pointerMoved = true;
  highlightedMode.value = null;
  for (const option of presenceMenu.value?.querySelectorAll<HTMLElement>('[data-presence-mode]') ?? []) {
    const rect = option.getBoundingClientRect();
    if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) {
      highlightedMode.value = option.dataset.presenceMode as PresenceMode;
    }
  }
}

function finishPresence(event: PointerEvent) {
  if (event.pointerId !== pointerId) return;
  movePresence(event);
  pointerId = null;
  if (pointerMoved) {
    if (highlightedMode.value) choosePresence(highlightedMode.value);
    else closePresence();
  }
}

watch(menuOpen, open => { if (!open) closePresence(); });
watch(() => props.presenceReady, ready => { if (!ready) closePresence(); });
watch(presenceOpen, (open, _, onCleanup) => {
  const element = presenceMenu.value;
  if (!open || !element) return;
  const outside = (event: Event) => { if (!element.contains(event.target as Node)) closePresence(); };
  element.ownerDocument.addEventListener('pointerdown', outside);
  element.ownerDocument.addEventListener('focusin', outside);
  element.ownerDocument.defaultView?.addEventListener('blur', closePresence);
  onCleanup(() => {
    element.ownerDocument.removeEventListener('pointerdown', outside);
    element.ownerDocument.removeEventListener('focusin', outside);
    element.ownerDocument.defaultView?.removeEventListener('blur', closePresence);
  });
}, { flush: 'post' });

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
      <div class="personal-menu-actions">
        <div v-if="presenceMode" class="personal-presence">
          <div class="personal-presence-row">
            <span class="personal-presence-label"><CircleUserRound :size="15" />在线状态</span>
            <div ref="presenceMenu" class="personal-presence-control" :aria-busy="presenceSyncing || !presenceReady">
              <button type="button" class="personal-presence-trigger" aria-label="切换在线状态" aria-haspopup="menu"
                :aria-expanded="presenceOpen" :disabled="!presenceReady"
                @pointerdown="beginPresence" @pointermove="movePresence" @pointerup="finishPresence" @pointercancel="closePresence"
                @click="$event.detail === 0 && openPresenceKeyboard()"
                @keydown.down.prevent="openPresenceKeyboard">
                <span class="presence-option-dot" :class="presenceMode" aria-hidden="true" />{{ presenceMode === 'online' ? '在线' : '隐身' }}<ChevronDown :size="13" />
              </button>
              <div v-if="presenceOpen" class="personal-presence-menu" role="menu" aria-label="在线状态" @keydown="movePresenceKeyboard">
                <button v-for="mode in presenceModes" :key="mode" type="button" role="menuitemradio"
                  :data-presence-mode="mode" :aria-checked="presenceMode === mode" :class="{ 'is-highlighted': highlightedMode === mode }"
                  @click="choosePresence(mode)">
                  <span class="presence-option-dot" :class="mode" aria-hidden="true" />{{ mode === 'online' ? '在线' : '隐身' }}
                  <Check v-if="presenceMode === mode" :size="13" aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
          <InlineFeedback :message="presenceError" />
        </div>
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
.personal-presence-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 32px; font-size: 13px; color: var(--muted); }
.personal-presence-label { display: flex; align-items: center; gap: 8px; }
.personal-presence-control { position: relative; }
.personal-menu-actions button { display: flex; align-items: center; justify-content: flex-start; gap: 8px; width: 100%; height: 32px; padding: 7px 0; border: 0; background: transparent; color: var(--muted); font-size: 13px; line-height: 18px; text-align: left; }
.personal-menu-actions button:hover:not(:disabled) { color: var(--text); }
.personal-menu-actions .personal-presence-trigger { width: 88px; padding: 7px 8px; gap: 6px; touch-action: none; }
.personal-presence-menu { position: absolute; z-index: 1; top: 0; right: 0; width: 88px; padding: 0; border-radius: 5px; background: var(--panel-raised); box-shadow: 0 4px 16px #0006; }
.personal-presence-menu button { padding: 7px 8px; gap: 6px; border-radius: 5px; }
.personal-presence-menu button:hover, .personal-presence-menu button.is-highlighted { background: var(--panel-soft); color: var(--text); }
.personal-menu-session { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--border-soft); }
.personal-menu-session button { color: var(--danger); }
</style>
