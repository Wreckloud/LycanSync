<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import type { CSSProperties } from 'vue';
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import { Headphones, UserRound } from '@lucide/vue';
import { formatSharedVoiceTime } from '../profile/sharedVoiceTime';
import type { UserPresenceStatus } from '../presence/presenceApi';
import { readAvatarTint } from '../profile/avatarTint';
import { formatPresenceAgo, formatRecentGame } from '../profile/presenceHistory';
import type { RecentGame } from '../group/groupApi';

const props = defineProps<{
  anchor: HTMLElement | null;
  positionAnchor?: HTMLElement | null;
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
const content = ref<HTMLElement | null>(null);
const avatarImage = ref<HTMLImageElement | null>(null);
const tint = ref<string>();
const position = ref<CSSProperties>({ left: '0px', top: '0px', visibility: 'hidden' });
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
watch(() => [props.anchor, surface.value, props.placement, props.positionAnchor] as const, ([anchor, element, placement, positionAnchor], _, onCleanup) => {
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
  const reference = positionAnchor ?? anchor;
  function focusOnce() {
    if (!positioned && props.autofocus) (element!.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
      ?? element!.querySelector<HTMLButtonElement>('button'))?.focus();
    positioned = true;
  }
  function updatePosition() {
    if (!anchor!.isConnected || !reference.isConnected) { emit('close'); return; }
    if (placement === 'above') {
      const rect = reference.getBoundingClientRect();
      const viewport = document.documentElement;
      // 个人面板固定右下锚点，内容增减只向上伸缩，不因高度变化翻转位置。
      const right = Math.min(Math.max(8, viewport.clientWidth - rect.right), Math.max(8, viewport.clientWidth - element!.offsetWidth - 8));
      position.value = { right: `${right}px`, bottom: `${Math.max(8, viewport.clientHeight - rect.top + 8)}px`,
        maxHeight: `${Math.max(0, rect.top - 16)}px`, visibility: 'visible' };
      focusOnce();
      return;
    }
    const currentRequest = ++request;
    void computePosition(anchor!, element!, {
      strategy: 'fixed', placement: 'left-start',
      middleware: [offset(20), flip({ padding: 8, crossAxis: false }),
        shift({ padding: 8, crossAxis: true })],
    }).then(({ x, y }) => {
      // 换成员、退场和尺寸变化后的旧计算不能覆盖当前卡片。
      if (revision !== generation || currentRequest !== request || props.anchor !== anchor || surface.value !== element) return;
      position.value = { left: `${x}px`, top: `${y}px`, visibility: 'visible' };
      focusOnce();
    }).catch(() => {
      if (revision !== generation || currentRequest !== request) return;
      console.error('无法定位资料卡');
      emit('close');
    });
  }
  tintAvatar();
  stopPositioning = autoUpdate(reference, element, updatePosition);
}, { immediate: true, flush: 'post' });

watch(() => [props.anchor, surface.value, content.value, props.placement, props.inline] as const,
  ([anchor, element, body, placement, inline], _, onCleanup) => {
    if (!anchor || !element || !body || placement !== 'above' || inline) return;
    const owner = element.ownerDocument.defaultView!;
    let frame = 0;
    const resize = () => {
      const height = `${body.getBoundingClientRect().height + 2}px`;
      if (element.style.height !== height) element.style.height = height;
    };
    resize();
    // 尺寸回调后再写外框高度，避免同一轮布局触发观察器循环。
    const observer = new ResizeObserver(() => {
      owner.cancelAnimationFrame(frame);
      frame = owner.requestAnimationFrame(resize);
    });
    observer.observe(body);
    onCleanup(() => { observer.disconnect(); owner.cancelAnimationFrame(frame); });
  }, { immediate: true, flush: 'post' });
onScopeDispose(() => { generation++; });

defineExpose({ contains: (target: Node | null) => Boolean(surface.value?.contains(target)) });
</script>

<template>
  <Teleport to="body" :disabled="inline">
    <Transition :name="placement === 'above' ? 'surface-panel' : 'profile-popover'" @before-enter="setCardActive($event, true)" @before-leave="setCardActive($event, false)">
      <section v-if="inline || anchor" :key="profileKey" ref="surface" class="profile-popover" :class="{ 'is-personal': placement === 'above', 'is-inline': inline }"
        :role="inline ? 'region' : 'dialog'" :aria-label="label" :style="{ ...(inline ? {} : position), '--profile-tint': tint }"
        @mouseenter="emit('enter')" @mouseleave="emit('leave')">
        <div ref="content" class="profile-popover-content">
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
            <p v-if="voiceDescription && !voiceError" class="profile-voice-time"><Headphones :size="13" aria-hidden="true" />{{ voiceDescription }}</p>
            <p v-else-if="voiceError" class="profile-voice-error" role="status">{{ voiceError }}</p>
            <slot />
          </div>
        </div>
      </section>
    </Transition>
  </Teleport>
</template>

<style>
.profile-deleted-account { color: var(--muted); font-size: 11px; }
.profile-popover { position: fixed; z-index: 60; width: min(292px, calc(100vw - 16px)); max-height: calc(100dvh - 16px); overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: var(--text); text-align: left; }
.profile-popover.is-personal { box-sizing: border-box; transition: height var(--motion-layout-duration) var(--motion-ease), opacity var(--motion-surface-duration) var(--motion-ease); }
.profile-popover.is-personal.surface-panel-enter-from, .profile-popover.is-personal.surface-panel-leave-to { transform: none; }
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
.profile-popover-enter-from, .profile-popover-leave-to { opacity: 0; transform: translateX(-4px); }
.profile-popover-leave-active { pointer-events: none; }
</style>
