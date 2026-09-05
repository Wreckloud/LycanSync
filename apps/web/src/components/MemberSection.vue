<script setup lang="ts">
import type { GroupMemberPreview } from '../groupPreviews';
defineProps<{ title: string; members: GroupMemberPreview[]; offline?: boolean }>();
</script>

<template>
  <section class="member-section">
    <h2>{{ title }}</h2>
    <div v-for="member in members" :key="member.name" class="member-row" :class="{ 'is-offline': offline }">
      <span class="member-avatar" aria-hidden="true">{{ member.name.slice(0, 1) }}<i v-if="!offline" class="presence-dot" /></span>
      <span><strong>{{ member.name }}</strong><small v-if="member.activity">{{ member.activity }}</small></span>
    </div>
  </section>
</template>
