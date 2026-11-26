<script setup lang="ts">
defineProps<{ percent?: number; label: string }>();
</script>

<template>
  <span class="app-progress" :class="{ 'is-indeterminate': percent === undefined }">
    <progress :aria-label="label" :value="percent" max="100" />
    <span aria-hidden="true" :style="percent === undefined ? undefined : { transform: 'scaleX(' + Math.max(0, Math.min(100, percent)) / 100 + ')' }" />
  </span>
</template>

<style>
:where(.app-progress) { position: relative; display: block; width: 100%; height: 4px; overflow: hidden; border-radius: 99px; background: color-mix(in srgb, var(--muted) 24%, var(--panel)); }
.app-progress progress { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; }
.app-progress > span { display: block; height: 100%; border-radius: inherit; background: var(--accent); transform-origin: left; transition: transform 180ms ease-out; }
.app-progress.is-indeterminate > span { width: 35%; animation: progress-travel 1.35s ease-in-out infinite alternate; }
@keyframes progress-travel { from { transform: translateX(0); } to { transform: translateX(185%); } }
@media (prefers-reduced-motion: reduce) {
  .app-progress > span { transition: none; }
  .app-progress.is-indeterminate > span { animation: none; }
}
</style>
