<script setup lang="ts">
import { UserRound } from '@lucide/vue';
defineProps<{ member: { nickname: string; avatar: string } }>();
</script>

<template>
  <div class="member-identity">
    <img v-if="member.avatar" :src="member.avatar" alt="" /><UserRound v-else :size="40" aria-hidden="true" />
    <strong>{{ member.nickname }}</strong>
  </div>
</template>

<style scoped>
.member-identity { display: flex; align-items: center; gap: 12px; padding: 12px; border: 1px solid var(--border); border-radius: 6px; }
.member-identity img { width: 40px; height: 40px; object-fit: cover; border-radius: 50%; }
.member-identity img, .member-identity svg { flex-shrink: 0; }
.member-identity strong { min-width: 0; overflow-wrap: anywhere; user-select: text; }
</style>
