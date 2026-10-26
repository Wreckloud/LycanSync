<script setup lang="ts">
import { ref } from 'vue';
import { UserRound } from '@lucide/vue';
import ActivityStatus from './ActivityStatus.vue';
import type { AuthUser } from '../auth/authApi';
import type { UserActivity, UserPresenceStatus } from '../presence/presenceApi';

defineProps<{ user: AuthUser; status: UserPresenceStatus; statusLabel: string;
  activityStatus?: { type: UserActivity['type']; text: string } | null }>();
const hovered = ref(false);
</script>

<template>
  <footer class="personal-card" aria-label="个人状态与设置" @mouseenter="hovered = true" @mouseleave="hovered = false">
    <span class="personal-avatar">
      <img v-if="user.avatar" :src="user.avatar" class="profile-avatar" alt="" referrerpolicy="no-referrer" />
      <span v-else class="profile-avatar-placeholder"><UserRound :size="22" /></span>
      <span class="status-dot" :class="status" aria-hidden="true" />
    </span>
    <span class="personal-copy"><strong>{{ user.nickname }}</strong>
      <ActivityStatus v-if="activityStatus" :type="activityStatus.type" :text="activityStatus.text" :active="hovered" />
      <small v-else>{{ statusLabel }}</small>
    </span>
    <slot />
  </footer>
</template>
