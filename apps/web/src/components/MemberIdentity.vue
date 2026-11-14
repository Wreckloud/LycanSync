<script setup lang="ts">
import { UserRound } from '@lucide/vue';
defineProps<{ member: { nickname: string; avatar: string }; description?: string }>();
</script>

<template>
  <div class="member-identity">
    <img v-if="member.avatar" :src="member.avatar" alt="" /><span v-else class="member-avatar-placeholder"><UserRound :size="26" aria-hidden="true" /></span>
    <div><strong>{{ member.nickname }}</strong><small v-if="description">{{ description }}</small></div>
  </div>
</template>

<style scoped>
.member-identity { display: flex; align-items: center; gap: 12px; min-width: 0; padding: 8px 0; }
.member-identity img, .member-avatar-placeholder { width: 48px; height: 48px; flex-shrink: 0; border-radius: 50%; }
.member-identity img { object-fit: cover; }
.member-avatar-placeholder { display: grid; place-items: center; background: var(--panel-raised); color: var(--muted); }
.member-identity > div { min-width: 0; }
.member-identity strong { display: block; overflow-wrap: anywhere; user-select: text; }
.member-identity small { display: block; margin-top: 2px; color: var(--muted); font-size: 12px; line-height: 18px; }
</style>
