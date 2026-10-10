<script setup lang="ts">
import { Gamepad2 } from '@lucide/vue';
import type { UserActivity } from '../../presence/presenceApi';

defineProps<{ desktop: boolean; activity: UserActivity | null; showActivity: boolean; error: string }>();
const emit = defineEmits<{ visibility: [enabled: boolean] }>();
</script>

<template>
  <section class="settings-section activity-settings">
    <h2>当前动态</h2>
    <div class="activity-current">
      <Gamepad2 :size="40" aria-hidden="true" />
      <div><strong>{{ activity ? activity.name : (desktop ? '未检测到游戏' : '动态检测仅在桌面版提供') }}</strong>
        <span v-if="activity">正在玩</span></div>
    </div>
    <label class="settings-toggle activity-toggle">
      <span><strong>显示当前动态</strong><small>让其他成员看到你正在玩的游戏，仅影响当前设备。</small></span>
      <input type="checkbox" :checked="showActivity" aria-label="显示当前动态"
        @change="emit('visibility', ($event.target as HTMLInputElement).checked)" />
    </label>
    <p v-if="error" class="settings-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.activity-settings { position: relative; gap: 12px; padding-bottom: 20px; border-bottom: 1px solid var(--border-soft); }
.activity-settings > .settings-error { position: absolute; right: 0; bottom: 2px; left: 0; max-height: 16px; overflow: auto; font-size: 12px; line-height: 16px; }
.activity-current { display: flex; align-items: center; gap: 16px; min-height: 64px; color: var(--muted); }
.activity-current svg { flex-shrink: 0; }
.activity-current > div { display: grid; gap: 5px; min-width: 0; }
.activity-current strong { overflow-wrap: anywhere; color: var(--text); font-size: 16px; font-weight: 500; }
.activity-current span { font-size: 13px; }
.activity-toggle { padding-bottom: 0; }
</style>
