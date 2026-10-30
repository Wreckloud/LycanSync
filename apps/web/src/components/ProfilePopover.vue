<script setup lang="ts">
import { nextTick, onScopeDispose, ref, watch } from 'vue';
import { UserRound } from '@lucide/vue';
import type { UserPresenceStatus } from '../presence/presenceApi';
import { readAvatarTint } from '../profile/avatarTint';

const props = defineProps<{
  anchor: HTMLElement | null;
  placement: 'above' | 'left';
  label: string;
  nickname: string;
  avatar: string;
  signature?: string;
  status: UserPresenceStatus;
  statusLabel: string;
  activity?: string;
  loading?: boolean;
  error?: string;
  autofocus?: boolean;
}>();
const emit = defineEmits<{ close: []; enter: []; leave: []; retry: [] }>();
const surface = ref<HTMLElement | null>(null);
const avatarImage = ref<HTMLImageElement | null>(null);
const tint = ref<string>();
const position = ref({ left: '0px', top: '0px', visibility: 'hidden' as 'visible' | 'hidden' });
let observer: ResizeObserver | undefined;
let generation = 0;

function place() {
  const anchor = props.anchor;
  const element = surface.value;
  if (!anchor || !element) return;
  if (!anchor.isConnected) { emit('close'); return; }
  const bounds = anchor.getBoundingClientRect();
  const owner = anchor.ownerDocument.defaultView!;
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  let left = props.placement === 'above' ? bounds.right - width : bounds.left - width - 8;
  let top = props.placement === 'above' ? bounds.top - height - 8 : bounds.top;
  if (props.placement === 'left' && left < 8 && bounds.right + width + 8 <= owner.innerWidth) left = bounds.right + 8;
  left = Math.max(8, Math.min(left, owner.innerWidth - width - 8));
  top = Math.max(8, Math.min(top, owner.innerHeight - height - 8));
  position.value = { left: `${left}px`, top: `${top}px`, visibility: 'visible' };
}

function tintAvatar() {
  tint.value = avatarImage.value ? readAvatarTint(avatarImage.value) : undefined;
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
watch(() => props.anchor, async (anchor, _, onCleanup) => {
  const revision = ++generation;
  if (!anchor) return;
  position.value.visibility = 'hidden';
  const document = anchor.ownerDocument;
  const owner = document.defaultView!;
  document.addEventListener('pointerdown', dismissOutside);
  document.addEventListener('focusin', dismissOutside);
  document.addEventListener('keydown', dismissOnEscape, true);
  owner.addEventListener('resize', place);
  document.addEventListener('scroll', place, true);
  onCleanup(() => {
    document.removeEventListener('pointerdown', dismissOutside);
    document.removeEventListener('focusin', dismissOutside);
    document.removeEventListener('keydown', dismissOnEscape, true);
    owner.removeEventListener('resize', place);
    document.removeEventListener('scroll', place, true);
    observer?.disconnect();
    observer = undefined;
  });
  await nextTick();
  if (revision !== generation || !surface.value) return;
  place();
  tintAvatar();
  if (props.autofocus) surface.value.querySelector<HTMLButtonElement>('button')?.focus();
  observer = new owner.ResizeObserver(place);
  observer.observe(surface.value);
}, { immediate: true });
onScopeDispose(() => { generation++; });

defineExpose({ contains: (target: Node | null) => Boolean(surface.value?.contains(target)) });
</script>

<template>
  <Teleport to="body">
    <Transition name="profile-popover" @before-enter="($event as HTMLElement).inert = false" @before-leave="($event as HTMLElement).inert = true">
      <section v-if="anchor" ref="surface" class="profile-popover" :class="{ 'is-personal': placement === 'above' }"
        role="dialog" :aria-label="label" :style="{ ...position, '--profile-tint': tint }"
        @mouseenter="emit('enter')" @mouseleave="emit('leave')">
        <div class="profile-popover-banner" aria-hidden="true" />
        <div class="profile-popover-body">
          <div class="profile-popover-identity">
            <span class="personal-avatar">
              <img v-if="avatar" ref="avatarImage" :src="avatar" class="profile-avatar" alt="" @load="tintAvatar" />
              <span v-else class="profile-avatar-placeholder"><UserRound :size="28" /></span>
              <span class="status-dot" :class="status" aria-hidden="true" />
            </span>
            <strong>{{ nickname }}</strong>
          </div>
          <p class="profile-popover-status">{{ statusLabel }}</p>
          <div class="profile-popover-signature" :aria-busy="loading">
            <span v-if="loading" role="status">正在读取签名…</span>
            <template v-else-if="error"><span role="alert">{{ error }}</span><button type="button" @click="emit('retry')">重试</button></template>
            <p v-else>{{ signature || '尚未填写个性签名' }}</p>
          </div>
          <div v-if="activity" class="profile-popover-activity">{{ activity }}</div>
          <slot />
        </div>
      </section>
    </Transition>
  </Teleport>
</template>

<style>
.profile-popover { position: fixed; z-index: 60; width: min(292px, calc(100vw - 16px)); max-height: calc(100dvh - 16px); overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: var(--text); text-align: left; }
.profile-popover-banner { height: 38px; background: var(--profile-tint, var(--panel-raised)); }
.profile-popover-body { display: grid; gap: 8px; padding: 0 14px 12px; }
.profile-popover-identity { display: flex; align-items: flex-end; gap: 10px; min-width: 0; margin-top: -18px; }
.profile-popover-identity .personal-avatar { --avatar-size: 48px; flex-shrink: 0; }
.profile-popover-identity .personal-avatar > :first-child { border: 3px solid var(--panel); }
.profile-popover-identity strong { min-width: 0; padding-bottom: 3px; overflow-wrap: anywhere; font-size: 16px; line-height: 20px; }
.profile-popover-status { margin: 0; color: var(--muted); font-size: 12px; }
.profile-popover-signature { min-height: 28px; color: var(--muted); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; white-space: pre-wrap; }
.profile-popover-signature p { margin: 0; }
.profile-popover-signature [role='alert'] { color: var(--danger); }
.profile-popover-signature button { margin-left: 6px; padding: 0; border: 0; background: transparent; color: var(--accent); font-size: 12px; }
.profile-popover-activity { padding-top: 8px; border-top: 1px solid var(--border-soft); color: var(--muted); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.profile-popover-enter-active, .profile-popover-leave-active { transition: opacity var(--motion-surface-duration) var(--motion-ease), transform var(--motion-surface-duration) var(--motion-ease); }
.profile-popover-enter-from, .profile-popover-leave-to { opacity: 0; transform: translateY(4px); }
.profile-popover-leave-active { pointer-events: none; }
</style>
