<script setup lang="ts">
defineProps<{ state: StartupUpdateState | null }>();
defineEmits<{ skip: [] }>();
</script>

<template>
  <main class="startup-update-screen">
    <section class="startup-update-card" aria-labelledby="startup-update-title">
      <h1 id="startup-update-title">准备进入 LycanSync</h1>
      <p role="status">{{ state?.message || '正在准备…' }}</p>
      <template v-if="state?.phase === 'downloading' || state?.phase === 'installing'">
        <div class="startup-update-progress-label">
          <span>版本 {{ state.nextVersion }}</span><span>{{ state.percent ?? 0 }}%</span>
        </div>
        <progress :value="state.percent ?? 0" max="100" aria-label="更新下载进度" />
      </template>
      <div class="startup-update-actions">
        <button v-if="state?.phase !== 'installing'" type="button" @click="$emit('skip')">暂不更新</button>
      </div>
    </section>
  </main>
</template>

<style scoped>
.startup-update-screen { display: grid; place-items: center; flex: 1; min-height: 0; padding: 24px; }
.startup-update-card { width: min(420px, 100%); padding: 24px; border: 1px solid var(--border); border-radius: 10px; background: var(--panel); }
.startup-update-card h1 { margin: 0 0 8px; font-size: 22px; }
.startup-update-card p { margin: 0 0 20px; color: var(--muted); }
.startup-update-progress-label { display: flex; justify-content: space-between; gap: 16px; font-size: 13px; color: var(--muted); }
.startup-update-card progress { width: 100%; height: 8px; margin-top: 8px; accent-color: var(--accent); }
.startup-update-actions { display: flex; justify-content: flex-end; min-height: var(--button-height); margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); }
</style>
