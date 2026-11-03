<script setup lang="ts">
import { nextTick, onScopeDispose, ref, watch } from 'vue';
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import { Check, ChevronLeft, ChevronRight, Keyboard, LogOut, Pencil, SlidersHorizontal, UserRound } from '@lucide/vue';
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
const statusExpanded = ref(false);
const statusTrigger = ref<HTMLButtonElement | null>(null);
const statusMenu = ref<HTMLElement | null>(null);
const statusSide = ref<'left' | 'right'>('left');
const statusPosition = ref({ left: '0px', top: '0px', visibility: 'hidden' as 'visible' | 'hidden' });
let closeStatusTimer: ReturnType<typeof setTimeout> | undefined;
let focusStatusOnOpen = false;
let positionGeneration = 0;

function openStatus(focus = false) {
  if (!menuOpen.value) return;
  clearTimeout(closeStatusTimer);
  focusStatusOnOpen ||= focus;
  if (!statusExpanded.value) statusPosition.value.visibility = 'hidden';
  statusExpanded.value = true;
  if (focus && statusMenu.value && statusPosition.value.visibility === 'visible') focusStatusOption();
}

function focusStatusOption() {
  const button = statusMenu.value?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]:not(:disabled)')
    ?? statusMenu.value?.querySelector<HTMLButtonElement>('button:not(:disabled)');
  if (button) { button.focus(); focusStatusOnOpen = false; }
}

function keepStatus() { clearTimeout(closeStatusTimer); }

function closeStatus(restoreFocus = false) {
  clearTimeout(closeStatusTimer);
  statusExpanded.value = false;
  focusStatusOnOpen = false;
  if (restoreFocus) statusTrigger.value?.focus();
}

function leaveStatus() {
  clearTimeout(closeStatusTimer);
  const focus = statusTrigger.value?.ownerDocument.activeElement ?? null;
  if (statusTrigger.value?.contains(focus) || statusMenu.value?.contains(focus)) return;
  closeStatusTimer = setTimeout(() => closeStatus(), 180);
}

function escapeStatus(event: KeyboardEvent) {
  if (!statusExpanded.value) return;
  event.preventDefault();
  event.stopPropagation();
  closeStatus(true);
}

function statusKeydown(event: KeyboardEvent) {
  const forward = statusSide.value === 'left' ? 'ArrowLeft' : 'ArrowRight';
  if (event.currentTarget === statusTrigger.value) {
    if (event.key === forward || event.key === 'ArrowDown') { event.preventDefault(); openStatus(true); }
    return;
  }
  if (event.key === (statusSide.value === 'left' ? 'ArrowRight' : 'ArrowLeft')) {
    event.preventDefault(); event.stopPropagation(); closeStatus(true);
  } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault();
    const buttons = [...statusMenu.value!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (!buttons.length) return;
    const current = buttons.findIndex(button => button === statusMenu.value!.ownerDocument.activeElement);
    const next = current < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
      : (current + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
    buttons[next]?.focus();
  }
}

function choosePresence(mode: PresenceMode) {
  if (!props.presenceReady) return;
  emit('presenceMode', mode);
  closeStatus(true);
}

watch(() => props.active, active => { if (active === false) menuOpen.value = false; });
watch(menuOpen, open => { if (!open) closeStatus(); else if (props.presenceError) openStatus(); });
watch(() => props.presenceError, error => { if (error && menuOpen.value) openStatus(); });
watch(() => [menuOpen.value, statusExpanded.value, statusTrigger.value, statusMenu.value] as const,
  ([mainOpen, open, anchor, menu], _, onCleanup) => {
    const generation = ++positionGeneration;
    if (!mainOpen || !open || !anchor || !menu) return;
    statusPosition.value.visibility = 'hidden';
    let request = 0;
    const stop = autoUpdate(anchor, menu, () => {
      const current = ++request;
      void computePosition(anchor, menu, { strategy: 'fixed', placement: 'left-start',
        // 状态行在卡片内缩进，间距需同时跨过这段内边距。
        middleware: [offset(24), flip({ padding: 8, fallbackPlacements: ['right-start'] }), shift({ padding: 8, crossAxis: true })],
      }).then(({ x, y, placement }) => {
        if (generation !== positionGeneration || current !== request || !statusExpanded.value || !menuOpen.value) return;
        statusSide.value = placement.startsWith('left') ? 'left' : 'right';
        statusPosition.value = { left: `${x}px`, top: `${y}px`, visibility: 'visible' };
        if (focusStatusOnOpen) void nextTick(() => {
          if (generation === positionGeneration && statusExpanded.value && menuOpen.value) focusStatusOption();
        });
      }).catch(() => {
        if (generation !== positionGeneration || current !== request) return;
        console.error('无法定位在线状态菜单');
        closeStatus(true);
      });
    });
    onCleanup(() => { positionGeneration++; stop(); });
  }, { flush: 'post' });
onScopeDispose(() => clearTimeout(closeStatusTimer));

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
    <ProfilePopover :anchor="menuEnabled && active !== false && menuOpen ? trigger : null" placement="above" label="个人菜单"
      :nickname="user.nickname" :avatar="user.avatar" :signature="user.signature" :status="status" :status-label="statusLabel"
      :activity="activityStatus?.text" :activity-started-at="activityStatus?.startedAt" :voice-seconds="voiceTime.seconds.value"
      :voice-error="voiceTime.error.value" :related-surface="statusExpanded ? statusMenu : null"
      own-voice autofocus @close="menuOpen = false" @escape="escapeStatus">
      <div class="personal-menu-actions">
        <button type="button" @click="selectSettings('account')"><Pencil :size="15" />编辑个人资料</button>
        <template v-if="presenceMode">
          <button ref="statusTrigger" type="button" class="personal-presence-toggle" :aria-expanded="statusExpanded"
            aria-label="在线状态" aria-controls="personal-presence-options" :aria-busy="presenceSyncing || !presenceReady"
            @mouseenter="openStatus()" @mouseleave="leaveStatus" @keydown="statusKeydown"
            @click="openStatus(true)">
            <span class="personal-presence-dot" :class="presenceMode" aria-hidden="true" />
            <span>{{ presenceMode === 'invisible' ? '隐身' : '在线' }}</span><component :is="statusSide === 'left' ? ChevronLeft : ChevronRight" :size="14" />
          </button>
        </template>
        <button type="button" @click="selectSettings('audio')"><SlidersHorizontal :size="15" />语音与音频</button>
        <button type="button" @click="selectSettings('shortcuts')"><Keyboard :size="15" />快捷键</button>
        <div class="personal-menu-session">
          <button type="button" @click="logout"><LogOut :size="15" />退出登录</button>
        </div>
      </div>
    </ProfilePopover>
    <Teleport to="body">
      <Transition name="personal-presence" @before-enter="($event as HTMLElement).inert = false" @before-leave="($event as HTMLElement).inert = true">
        <div v-if="menuOpen && statusExpanded" id="personal-presence-options" ref="statusMenu" class="personal-presence-panel"
          role="group" aria-label="在线状态选择" :style="statusPosition" @mouseenter="keepStatus"
          @mouseleave="leaveStatus" @keydown="statusKeydown"
          @focusout="($event.relatedTarget && !statusMenu?.contains($event.relatedTarget as Node) && !statusTrigger?.contains($event.relatedTarget as Node)) && closeStatus()">
          <button type="button" aria-label="在线" :aria-pressed="presenceReady && presenceMode === 'online'" :disabled="!presenceReady" @click="choosePresence('online')">
            <span class="personal-presence-dot online" aria-hidden="true" /><span>在线</span><Check v-if="presenceReady && presenceMode === 'online'" :size="14" />
          </button>
          <button type="button" aria-label="隐身" :aria-pressed="presenceReady && presenceMode === 'invisible'" :disabled="!presenceReady" @click="choosePresence('invisible')">
            <span class="personal-presence-dot invisible" aria-hidden="true" /><span>隐身</span><Check v-if="presenceReady && presenceMode === 'invisible'" :size="14" />
          </button>
          <InlineFeedback v-if="presenceError || !presenceReady || presenceSyncing" class="personal-presence-feedback" :message="presenceError"
            :status="!presenceReady ? '正在读取状态偏好…' : presenceSyncing ? '正在同步状态…' : ''" />
        </div>
      </Transition>
    </Teleport>
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
.personal-presence-toggle > svg { margin-left: auto; }
.personal-presence-panel { position: fixed; z-index: 61; width: min(156px, calc(100vw - 16px)); max-height: calc(100dvh - 16px); overflow-y: auto; padding: 6px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel-raised); }
.personal-presence-panel button { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 32px; padding: 6px 8px; border: 0; border-radius: 4px; background: transparent; color: var(--muted); font-size: 13px; text-align: left; }
.personal-presence-panel button:hover:not(:disabled) { background: var(--panel-soft); color: var(--text); }
.personal-presence-panel button > svg { margin-left: auto; }
.personal-presence-panel button[aria-pressed='true'] { color: var(--text); }
.personal-presence-feedback { height: auto; padding: 4px 8px; }
.personal-presence-enter-active, .personal-presence-leave-active { transition: opacity var(--motion-surface-duration) var(--motion-ease); }
.personal-presence-enter-from, .personal-presence-leave-to { opacity: 0; }
.personal-presence-leave-active { pointer-events: none; }
</style>
