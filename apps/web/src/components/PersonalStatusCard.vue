<script setup lang="ts">
import { Gamepad2, Music2, UserRound } from '@lucide/vue';
import type { AuthUser } from '../auth/authApi';
import type { UserActivity, UserPresenceStatus } from '../presence/presenceApi';

defineProps<{ user: AuthUser; status: UserPresenceStatus; statusLabel: string;
  activityStatus?: { type: UserActivity['type']; text: string } | null }>();
</script>

<template>
  <footer class="personal-card" aria-label="个人状态与设置">
    <span class="personal-avatar">
      <img v-if="user.avatar" :src="user.avatar" class="profile-avatar" alt="" referrerpolicy="no-referrer" />
      <span v-else class="profile-avatar-placeholder"><UserRound :size="22" /></span>
      <span class="status-dot" :class="status" aria-hidden="true" />
    </span>
    <span class="personal-copy"><strong>{{ user.nickname }}</strong>
      <small v-if="activityStatus" class="member-activity" :title="activityStatus.text">
        <Music2 v-if="activityStatus.type === 'MUSIC'" :size="12" aria-hidden="true" /><Gamepad2 v-else :size="12" aria-hidden="true" />
        <span>{{ activityStatus.text }}</span>
      </small>
      <small v-else>{{ statusLabel }}</small>
    </span>
    <slot />
  </footer>
</template>
