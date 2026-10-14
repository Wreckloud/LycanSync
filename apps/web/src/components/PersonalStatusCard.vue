<script setup lang="ts">
import { UserRound } from '@lucide/vue';
import type { AuthUser } from '../auth/authApi';
import type { UserPresenceStatus } from '../presence/presenceApi';

defineProps<{ user: AuthUser; status: UserPresenceStatus; statusLabel: string }>();
</script>

<template>
  <footer class="personal-card" aria-label="个人状态与设置">
    <span class="personal-avatar">
      <img v-if="user.avatar" :src="user.avatar" class="profile-avatar" alt="" referrerpolicy="no-referrer" />
      <span v-else class="profile-avatar-placeholder"><UserRound :size="18" /></span>
      <span class="status-dot" :class="status" aria-hidden="true" />
    </span>
    <span class="personal-copy"><strong>{{ user.nickname }}</strong><small>{{ statusLabel }}</small></span>
    <slot />
  </footer>
</template>
