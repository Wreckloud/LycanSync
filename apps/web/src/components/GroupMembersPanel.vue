<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { Crown, Gamepad2, Music2, Search } from '@lucide/vue';
import type { GroupMember } from '../group/groupApi';
import type { AuthUser } from '../auth/authApi';
import type { UserPresenceStatus } from '../presence/presenceApi';

const props = defineProps<{
  members: GroupMember[];
  memberCount?: number;
  user: AuthUser;
  loading: boolean;
  error: string;
  connectionLost: boolean;
  status: (member: GroupMember) => UserPresenceStatus;
  statusLabel: (member: GroupMember) => string;
  activity: (member: GroupMember) => { type: string; text: string } | null;
}>();
const searchOpen = ref(false);
const search = ref('');
const button = ref<HTMLButtonElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
const filtered = computed(() => props.members.filter((member) =>
  (member.userId === props.user.id ? props.user.nickname : member.nickname).toLowerCase().includes(search.value.trim().toLowerCase())));

async function toggleSearch() {
  searchOpen.value = !searchOpen.value;
  if (!searchOpen.value) search.value = '';
  await nextTick();
  (searchOpen.value ? input.value : button.value)?.focus();
}
</script>

<template>
  <aside class="members-directory" aria-label="群组成员">
    <header class="members-header">
      <strong>成员<span v-if="memberCount !== undefined"> · {{ memberCount }}</span></strong>
      <button ref="button" type="button" class="member-search-toggle" aria-label="搜索群组成员"
        :aria-expanded="searchOpen" aria-controls="group-member-search" @click="toggleSearch"><Search :size="16" /></button>
    </header>
    <div v-if="searchOpen" id="group-member-search" class="member-search">
      <input ref="input" v-model="search" type="search" aria-label="按名称搜索成员"
        placeholder="搜索成员名称" @keydown.esc.stop="toggleSearch" />
    </div>
    <div class="members-list">
      <p v-if="connectionLost" class="group-hint" role="status">成员状态同步中断，当前显示可能已过期。</p>
      <p v-if="error" role="alert" class="group-error">{{ error }}</p>
      <p v-else-if="loading" class="group-hint">正在读取成员…</p>
      <p v-if="search.trim() && !loading && !error && !filtered.length" class="group-hint" role="status">没有找到匹配的成员</p>
      <div v-for="member in filtered" :key="member.userId" class="group-member-row" :class="{ 'is-offline': status(member) === 'OFFLINE' }">
        <span class="group-member-avatar" :aria-label="statusLabel(member)">
          <img v-if="member.userId === user.id ? user.avatar : member.avatar" :src="member.userId === user.id ? user.avatar : member.avatar" alt="" />
          <span v-else class="group-member-initial">{{ member.nickname.slice(0, 1) }}</span>
          <span v-if="status(member) !== 'OFFLINE'" class="status-dot" :class="status(member)" />
        </span>
        <span class="group-member-info">
          <span class="group-member-name"><span>{{ member.userId === user.id ? user.nickname : member.nickname }}</span>
            <Crown v-if="member.role === 'OWNER'" :size="13" class="group-member-role" role="img" aria-label="群主" /></span>
          <span v-if="activity(member)" class="member-activity" :title="activity(member)?.text">
            <Music2 v-if="activity(member)?.type === 'MUSIC'" :size="12" aria-hidden="true" /><Gamepad2 v-else :size="12" aria-hidden="true" />
            <span>{{ activity(member)?.text }}</span>
          </span>
        </span>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.members-directory { border-left: 1px solid var(--border); background: var(--panel); }
.member-search-toggle { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; background: transparent; color: var(--muted); cursor: pointer; }
.member-search-toggle:hover { color: var(--text); }
</style>
