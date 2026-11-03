<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { LoaderCircle } from '@lucide/vue';
const props = defineProps<{ state: StartupUpdateState | null; modal?: boolean }>();
const emit = defineEmits<{ skip: [] }>();
const panel = ref<HTMLElement | null>(null);
const canSkip = computed(() => !['preparing', 'installing'].includes(props.state?.phase ?? ''));
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && canSkip.value) { event.preventDefault(); emit('skip'); }
  if (!props.modal || event.key !== 'Tab') return;
  event.preventDefault();
  (panel.value?.querySelector<HTMLButtonElement>('button') ?? panel.value)?.focus();
}
onMounted(() => { if (props.modal) panel.value?.focus(); });
</script>

<template>
  <main class="startup-update-screen">
    <section ref="panel" class="startup-update-card" aria-labelledby="startup-update-title"
      :role="modal ? 'dialog' : undefined" :aria-modal="modal || undefined" :tabindex="modal ? -1 : undefined" @keydown="keydown">
      <h1 id="startup-update-title">{{ modal ? '更新 LycanSync' : '准备进入 LycanSync' }}</h1>
      <p role="status">{{ state?.message || '正在准备…' }}</p>
      <template v-if="state?.phase === 'downloading'">
        <div class="startup-update-progress-label">
          <span>版本 {{ state.nextVersion }}</span><span>{{ state.percent ?? 0 }}%</span>
        </div>
        <progress :value="state.percent ?? 0" max="100" aria-label="更新下载进度" />
      </template>
      <LoaderCircle v-else-if="state?.phase !== 'ready'" class="startup-update-spinner" :size="18" aria-hidden="true" />
      <div class="startup-update-actions card-actions card-actions-no-primary">
        <button v-if="canSkip" type="button" class="settings-button" @click="$emit('skip')">暂不更新</button>
      </div>
    </section>
  </main>
</template>

<style scoped>
.startup-update-screen { display: grid; place-items: safe center; flex: 1; min-height: 0; overflow: auto; padding: 24px; }
.startup-update-card { width: min(420px, 100%); padding: 24px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); font-size: 14px; line-height: 20px; }
.startup-update-card h1 { margin: 0 0 4px; font-size: 22px; line-height: 32px; }
.startup-update-card p { margin: 0 0 20px; color: var(--muted); font-size: 13px; }
.startup-update-progress-label { display: flex; justify-content: space-between; gap: 16px; font-size: 13px; color: var(--muted); }
.startup-update-card progress { width: 100%; height: 8px; margin-top: 8px; accent-color: var(--accent); }
.startup-update-actions { min-height: calc(var(--button-height) + 16px); margin-top: 20px; }
.startup-update-actions > button { grid-row: 1; }
.startup-update-spinner { color: var(--muted); animation: app-loading-spin 1s linear infinite; }
@media (max-width: 420px) { .startup-update-card { padding: 20px; } .startup-update-card h1 { font-size: 20px; } }
</style>
