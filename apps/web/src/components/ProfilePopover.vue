<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import { Headphones, UserRound } from '@lucide/vue';
import { formatSharedVoiceTime } from '../profile/sharedVoiceTime';
import type { UserPresenceStatus } from '../presence/presenceApi';
import { readAvatarTint } from '../profile/avatarTint';
import { formatPresenceAgo, formatRecentGame } from '../profile/presenceHistory';
import type { RecentGame } from '../group/groupApi';

const props = defineProps<{
  anchor: HTMLElement | null;
  placement: 'above' | 'left';
  label: string;
  nickname: string;
  avatar: string;
  signature?: string;
  deletedAt?: string | null;
  status: UserPresenceStatus;
  statusLabel: string;
  activity?: string;
  activityStartedAt?: string;
  lastOnlineAt?: string | null;
  recentGame?: RecentGame | null;
  profileKey?: string;
  loading?: boolean;
  error?: string;
  autofocus?: boolean;
  inline?: boolean;
  voiceSeconds?: number | null;
  ownVoice?: boolean;
  voiceError?: string;
}>();
const emit = defineEmits<{ close: []; enter: []; leave: []; retry: [] }>();
const surface = ref<HTMLElement | null>(null);
const avatarImage = ref<HTMLImageElement | null>(null);
const tint = ref<string>();
const position = ref({ left: '0px', top: '0px', visibility: 'hidden' as 'visible' | 'hidden' });
let generation = 0;
const activitySeconds = ref<number | null>(null);
const historyNow = ref(Date.now());
const lastOnline = computed(() => props.status === 'OFFLINE' ? formatPresenceAgo(props.lastOnlineAt, historyNow.value) : '');
const recentGameDescription = computed(() => formatRecentGame(props.recentGame, historyNow.value));
const voiceDescription = computed(() => props.voiceSeconds == null ? '' : formatSharedVoiceTime(props.voiceSeconds, props.ownVoice));
const activityDuration = computed(() => {
  const elapsed = activitySeconds.value;
  if (elapsed === null) return '';
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor(elapsed / 60) % 60;
  const seconds = elapsed % 60;
  return (hours ? `${hours}:` : '') + `${hours ? String(minutes).padStart(2, '0') : minutes}:${String(seconds).padStart(2, '0')}`;
});

watch(() => [props.anchor, props.activityStartedAt, props.lastOnlineAt, props.recentGame?.endedAt, props.status] as const, ([anchor, startedAt], _, onCleanup) => {
  activitySeconds.value = null;
  const started = Date.parse(startedAt ?? '');
  historyNow.value = Date.now();
  if (!anchor || (!Number.isFinite(started) && !lastOnline.value && !recentGameDescription.value)) return;
  const document = anchor.ownerDocument;
  const owner = document.defaultView!;
  const observedWallTime = Date.now();
  const observedAt = owner.performance.now();
  const tick = () => {
    historyNow.value = observedWallTime + owner.performance.now() - observedAt;
    activitySeconds.value = Number.isFinite(started) ? Math.floor(Math.max(0, (historyNow.value - started) / 1000)) : null;
  };
  let timer: number | undefined;
  const refresh = () => {
    owner.clearInterval(timer);
    timer = undefined;
    if (document.visibilityState === 'hidden') return;
    tick();
    timer = owner.setInterval(tick, Number.isFinite(started) ? 1000 : 60_000);
  };
  // 只在卡片可见时读秒；从开始时间推算，后台节流不会累计误差。
  refresh();
  document.addEventListener('visibilitychange', refresh);
  owner.addEventListener('focus', tick);
  onCleanup(() => {
    owner.clearInterval(timer);
    document.removeEventListener('visibilitychange', refresh);
    owner.removeEventListener('focus', tick);
  });
}, { immediate: true });

function tintAvatar() {
  tint.value = avatarImage.value ? readAvatarTint(avatarImage.value) : undefined;
}

function setCardActive(element: Element, active: boolean) {
  (element as HTMLElement).inert = !active;
  element.setAttribute('aria-hidden', String(!active));
}

function dismissOutside(event: Event) {
  const target = event.target as Node | null;
  if (!surface.value?.contains(target) && !props.anchor?.contains(target)) emit('close');
}

function dismissOnEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !props.anchor) return;
  event.preventDefault();
  event.stopPropagation();
  props.anchor.focus();
  emit('close');
}

watch(() => props.avatar, () => { tint.value = undefined; });
watch(() => [props.anchor, surface.value, props.placement] as const, ([anchor, element, placement], _, onCleanup) => {
  const revision = ++generation;
  if (props.inline || !anchor || !element) return;
  position.value.visibility = 'hidden';
  const document = anchor.ownerDocument;
  document.addEventListener('pointerdown', dismissOutside);
  document.addEventListener('focusin', dismissOutside);
  document.addEventListener('keydown', dismissOnEscape, true);
  let stopPositioning: (() => void) | undefined;
  onCleanup(() => {
    document.removeEventListener('pointerdown', dismissOutside);
    document.removeEventListener('focusin', dismissOutside);
    document.removeEventListener('keydown', dismissOnEscape, true);
    stopPositioning?.();
  });
  let request = 0;
  let positioned = false;
  function updatePosition() {
    if (!anchor!.isConnected) { emit('close'); return; }
    const currentRequest = ++request;
    void computePosition(anchor!, element!, {
      strategy: 'fixed', placement: placement === 'above' ? 'top-end' : 'left-start',
      middleware: [offset(placement === 'above' ? 8 : 20), flip({ padding: 8, crossAxis: false }),
        shift({ padding: 8, crossAxis: true })],
    }).then(({ x, y }) => {
      // 换成员、退场和尺寸变化后的旧计算不能覆盖当前卡片。
      if (revision !== generation || currentRequest !== request || props.anchor !== anchor || surface.value !== element) return;
      position.value = { left: `${x}px`, top: `${y}px`, visibility: 'visible' };
      if (!positioned && props.autofocus) element!.querySelector<HTMLButtonElement>('button')?.focus();
      positioned = true;
    }).catch(() => {
      if (revision !== generation || currentRequest !== request) return;
      console.error('无法定位资料卡');
      emit('close');
    });
  }
  tintAvatar();
  stopPositioning = autoUpdate(anchor, element, updatePosition);
}, { immediate: true, flush: 'post' });
onScopeDispose(() => { generation++; });

defineExpose({ contains: (target: Node | null) => Boolean(surface.value?.contains(target)) });
</script>

<template>
  <Teleport to="body" :disabled="inline">
    <Transition name="profile-popover" @before-enter="setCardActive($event, true)" @before-leave="setCardActive($event, false)">
      <section v-if="inline || anchor" :key="profileKey" ref="surface" class="profile-popover" :class="{ 'is-personal': placement === 'above', 'is-inline': inline }"
        :role="inline ? 'region' : 'dialog'" :aria-label="label" :style="{ ...(inline ? {} : position), '--profile-tint': tint }"
        @mouseenter="emit('enter')" @mouseleave="emit('leave')">
        <div class="profile-popover-banner" aria-hidden="true" />
        <div class="profile-popover-body">
          <div class="profile-popover-identity">
            <span class="personal-avatar" role="img" :aria-label="statusLabel">
              <img v-if="avatar" ref="avatarImage" :src="avatar" class="profile-avatar" alt="" @load="tintAvatar" />
              <span v-else class="profile-avatar-placeholder"><UserRound :size="28" /></span>
              <span class="status-dot" :class="status" aria-hidden="true" />
            </span>
            <strong>{{ nickname }}</strong><small v-if="deletedAt" class="profile-deleted-account">已注销</small>
          </div>
          <div class="profile-popover-signature" :aria-busy="loading">
            <span v-if="loading" role="status">正在读取签名…</span>
            <template v-else-if="error"><span role="alert">{{ error }}</span><button type="button" @click="emit('retry')">重试</button></template>
            <p v-else>{{ signature || '这只狼暂时没留下什么话。' }}</p>
          </div>
          <div v-if="activity" class="profile-popover-activity">{{ activity }}<span v-if="activityDuration"> · {{ activityDuration }}</span></div>
          <div v-if="lastOnline || recentGameDescription" class="profile-popover-history">
            <p v-if="lastOnline">上次在线：{{ lastOnline }}</p>
            <p v-if="recentGameDescription">{{ recentGameDescription }}</p>
          </div>
          <slot />
          <p v-if="voiceDescription && !voiceError" class="profile-voice-time"><Headphones :size="13" aria-hidden="true" />{{ voiceDescription }}</p>
          <p v-else-if="voiceError" class="profile-voice-error" role="status">{{ voiceError }}</p>
        </div>
      </section>
    </Transition>
  </Teleport>
</template>

<style>
.profile-deleted-account { color: var(--muted); font-size: 11px; }
.profile-popover { position: fixed; z-index: 60; width: min(292px, calc(100vw - 16px)); max-height: calc(100dvh - 16px); overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: var(--text); text-align: left; }
.profile-popover-banner { height: 38px; background: var(--profile-tint, var(--panel-raised)); }
.profile-popover.is-inline { position: relative; z-index: auto; width: 100%; max-height: none; overflow: visible; }
.profile-voice-time { display: flex; align-items: center; gap: 8px; margin: 0; padding-top: 10px; border-top: 1px solid var(--border-soft); color: var(--muted); font-size: 12px; line-height: 18px; }
.profile-voice-time > svg { flex-shrink: 0; }
.profile-voice-error { margin: 0; color: var(--muted); font-size: 12px; line-height: 18px; }
.profile-popover-body { display: grid; gap: 8px; padding: 0 14px 12px; }
.profile-popover-identity { display: flex; align-items: flex-end; gap: 10px; min-width: 0; margin-top: -18px; }
.profile-popover-identity .personal-avatar { --avatar-size: 48px; flex-shrink: 0; }
.profile-popover-identity .personal-avatar > :first-child { border: 3px solid var(--panel); }
.profile-popover-identity strong { min-width: 0; padding-bottom: 3px; overflow-wrap: anywhere; font-size: 16px; line-height: 20px; }
.profile-popover-signature { min-height: 28px; color: var(--muted); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; white-space: pre-wrap; }
.profile-popover-signature p { margin: 0; }
.profile-popover-signature [role='alert'] { color: var(--danger); }
.profile-popover-signature button { margin-left: 6px; padding: 0; border: 0; background: transparent; color: var(--accent); font-size: 12px; }
.profile-popover-activity { padding-top: 8px; border-top: 1px solid var(--border-soft); color: var(--muted); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.profile-popover-history { display: grid; gap: 4px; color: var(--muted); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.profile-popover-history p { margin: 0; }
.profile-popover-enter-active, .profile-popover-leave-active { transition: opacity var(--motion-surface-duration) var(--motion-ease), transform var(--motion-surface-duration) var(--motion-ease); }
.profile-popover-enter-from, .profile-popover-leave-to { opacity: 0; transform: translateY(4px); }
.profile-popover:not(.is-personal).profile-popover-enter-from, .profile-popover:not(.is-personal).profile-popover-leave-to { transform: translateX(-4px); }
.profile-popover-leave-active { pointer-events: none; }
</style>
