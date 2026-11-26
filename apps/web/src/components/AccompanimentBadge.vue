<script setup lang="ts">
import { ref, watch } from 'vue';
import { Disc3 } from '@lucide/vue';

const props = defineProps<{ local: boolean; sharing?: string; icon?: string; open?: boolean; busy?: boolean }>();
const emit = defineEmits<{ activate: [event: MouseEvent] }>();
const iconFailed = ref(false);
watch(() => props.icon, () => { iconFailed.value = false; });
function turnRecord(event: Event) {
  if (!props.sharing || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const icon = (event.currentTarget as HTMLElement).querySelector('.record-icon');
  if (icon && !icon.getAnimations().length) {
    icon.animate([{ transform: 'rotate(0turn)' }, { transform: 'rotate(1turn)' }], { duration: 3600, easing: 'linear' });
  }
}
</script>

<template>
  <Transition name="badge-fade">
    <component :is="local ? 'button' : 'span'"
      class="media-badge audio-badge" :class="{ 'own-badge': local, 'is-sharing': sharing, 'is-open': local && open }"
      :disabled="local && busy || undefined" :type="local ? 'button' : undefined" :aria-expanded="local && !sharing ? !!open : undefined"
      :aria-label="local && sharing ? '暂停分享' : undefined"
      @pointerenter="turnRecord" @focus="turnRecord"
      @keydown.stop @keyup.stop @click.stop="local && emit('activate', $event)">
      <span :key="sharing" class="audio-badge-content">
        <span class="record-icon" aria-hidden="true">
          <img v-if="icon && !iconFailed" class="source-icon" :src="icon" alt="" @error="iconFailed = true" />
          <Disc3 v-else :size="16" />
        </span>
        <span class="badge-status">{{ sharing ? '正在分享' : '播放伴奏' }}</span>
        <span v-if="local && sharing" class="badge-action">暂停分享</span>
      </span>
    </component>
  </Transition>
</template>

<style scoped>
.media-badge { position: absolute; bottom: 6px; display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 22px; padding: 0 4px; border: 0; border-radius: 5px; background: #0b0f14cc; color: var(--text); font: inherit; font-size: 11px; line-height: 16px; }
.audio-badge { z-index: 2; left: 7px; background: #10161deb; font-size: 12px; white-space: nowrap; }
.audio-badge-content { display: inline-flex; align-items: center; gap: 5px; animation: group-content-reveal var(--motion-surface-duration) var(--motion-ease); }
.record-icon { display: flex; width: 16px; height: 16px; border-radius: 50%; overflow: hidden; }
.record-icon > svg { color: var(--muted); }
.badge-action, .own-badge.is-sharing:is(:hover, :focus-visible) .badge-status { display: none; }
.own-badge.is-sharing:is(:hover, :focus-visible) .badge-action { display: inline; }
.badge-fade-enter-active, .badge-fade-leave-active { transition: opacity var(--motion-surface-duration) var(--motion-ease); }
.badge-fade-enter-from, .badge-fade-leave-to { opacity: 0; }
.own-badge { cursor: pointer; opacity: 0; pointer-events: none; transition: opacity var(--motion-surface-duration) var(--motion-ease); }
.participant-card:hover .own-badge, .participant-card:focus-within .own-badge, .own-badge.is-sharing, .own-badge.is-open { opacity: 1; pointer-events: auto; }
.source-icon { width: 16px; height: 16px; object-fit: contain; flex: none; }
@media (hover: none), (pointer: coarse) { .own-badge { opacity: 1; pointer-events: auto; } }
@media (prefers-reduced-motion: reduce) { .own-badge { transition: none; } }
</style>
