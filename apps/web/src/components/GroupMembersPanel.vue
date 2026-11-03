<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';
import { Crown, Search, X } from '@lucide/vue';
import ActivityStatus from './ActivityStatus.vue';
import ProfilePopover from './ProfilePopover.vue';
import { findGroupMemberProfile, type GroupMember, type GroupPresence } from '../group/groupApi';
import type { AuthUser } from '../auth/authApi';
import { PRESENCE_STATUS_LABELS, type UserPresenceStatus } from '../presence/presenceApi';
import { useOwnVoiceTime } from '../profile/useOwnVoiceTime';
import { useLoadingHint } from './useLoadingHint';

const props = defineProps<{
  members: GroupMember[];
  memberCount?: number;
  user: AuthUser;
  loading: boolean;
  error: string;
  connectionLost: boolean;
  status: (member: GroupMember) => UserPresenceStatus;
  statusLabel: (member: GroupMember) => string;
  activity: (member: GroupMember) => { type: string; text: string; startedAt?: string } | null;
  groupId: string;
  presences: Record<string, GroupPresence>;
  profileBlocked?: boolean;
}>();
const searchOpen = ref(false);
const search = ref('');
const hoveredMember = ref<string | null>(null);
const button = ref<HTMLButtonElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
const filtered = computed(() => props.members.filter((member) =>
  (member.userId === props.user.id ? props.user.nickname : member.nickname).toLowerCase().includes(search.value.trim().toLowerCase())));
const loadingHint = useLoadingHint(() => props.loading && !props.members.length && !props.error);
const profileAnchor = ref<HTMLElement | null>(null);
const profileUserId = ref('');
const profileMember = computed(() => props.members.find(member => member.userId === profileUserId.value));
const ownVoice = useOwnVoiceTime(() => !!profileAnchor.value && profileUserId.value === props.user.id);
const profilePresence = computed(() => props.presences[profileUserId.value]);
const profileSignature = ref('');
const sharedVoiceSeconds = ref<number | null>(null);
const profileLoading = ref(false);
const profileError = ref('');
const profileCard = ref<InstanceType<typeof ProfilePopover> | null>(null);
let openTimer: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let profileRequest: AbortController | undefined;
const profiles = new Map<string, { signature: string; sharedVoiceSeconds: number; fetchedAt: number }>();

function cancelProfileTimers() {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
}

function closeProfile() {
  cancelProfileTimers();
  profileRequest?.abort();
  profileRequest = undefined;
  profileLoading.value = false;
  profileAnchor.value = null;
}

async function loadProfile() {
  const member = profileMember.value;
  if (!profileAnchor.value || !member) return;
  profileRequest?.abort();
  profileError.value = '';
  if (member.userId === props.user.id) { profileSignature.value = props.user.signature ?? ''; sharedVoiceSeconds.value = null; return; }
  const controller = new AbortController();
  profileRequest = controller;
  profileLoading.value = true;
  const groupId = props.groupId;
  try {
    const profile = await findGroupMemberProfile(groupId, member.userId, controller.signal);
    if (controller.signal.aborted || profileRequest !== controller || props.groupId !== groupId) return;
    const seconds = profile.sharedVoiceSeconds;
    if (profile.userId !== member.userId || typeof profile.signature !== 'string'
      || typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 0) throw new Error('成员资料响应无效');
    profileSignature.value = profile.signature;
    sharedVoiceSeconds.value = seconds;
    if (profiles.size >= 8) profiles.delete(profiles.keys().next().value!);
    profiles.set(member.userId, { signature: profile.signature, sharedVoiceSeconds: seconds, fetchedAt: Date.now() });
  } catch (reason) {
    if (!controller.signal.aborted && profileRequest === controller) {
      profileError.value = reason instanceof Error ? reason.message : '无法读取成员资料';
    }
  } finally {
    if (profileRequest === controller) { profileRequest = undefined; profileLoading.value = false; }
  }
}

function showProfile(member: GroupMember, anchor: HTMLElement) {
  cancelProfileTimers();
  if (props.profileBlocked || !anchor.isConnected) return;
  if (profileUserId.value === member.userId && profileAnchor.value === anchor) return;
  closeProfile();
  profileUserId.value = member.userId;
  profileAnchor.value = anchor;
  profileError.value = '';
  const cached = profiles.get(member.userId);
  profileSignature.value = member.userId === props.user.id ? props.user.signature ?? '' : cached?.signature ?? '';
  sharedVoiceSeconds.value = member.userId === props.user.id ? null : cached?.sharedVoiceSeconds ?? null;
  if (member.userId !== props.user.id && (!cached || Date.now() - cached.fetchedAt >= 60_000)) void loadProfile();
}

function queueProfile(member: GroupMember, event: MouseEvent) {
  hoveredMember.value = member.userId;
  cancelProfileTimers();
  if (props.profileBlocked) return;
  const anchor = event.currentTarget as HTMLElement;
  openTimer = setTimeout(() => showProfile(member, anchor), 250);
}

function keepProfile() { clearTimeout(closeTimer); }

function leaveProfile() {
  hoveredMember.value = null;
  clearTimeout(openTimer);
  const focus = profileAnchor.value?.ownerDocument.activeElement ?? null;
  if (profileAnchor.value?.contains(focus) || profileCard.value?.contains(focus)) return;
  clearTimeout(closeTimer);
  closeTimer = setTimeout(closeProfile, 180);
}

watch(() => props.profileBlocked, blocked => { if (blocked) closeProfile(); });
watch(profileMember, member => { if (!member) closeProfile(); });
watch(() => props.groupId, () => { closeProfile(); profiles.clear(); });
onScopeDispose(closeProfile);

async function toggleSearch() {
  searchOpen.value = !searchOpen.value;
  closeProfile();
  if (!searchOpen.value) search.value = '';
  await nextTick();
  (searchOpen.value ? input.value : button.value)?.focus();
}
</script>

<template>
  <aside class="members-directory" aria-label="群组成员">
    <header class="members-header">
      <strong v-show="!searchOpen">成员<span v-if="memberCount !== undefined"> · {{ memberCount }}</span></strong>
      <button v-show="!searchOpen" ref="button" type="button" class="member-search-toggle" aria-label="搜索群组成员"
        :aria-expanded="searchOpen" aria-controls="group-member-search" @click="toggleSearch"><Search :size="16" /></button>
      <Transition name="member-search" @before-enter="($event as HTMLElement).inert = false" @before-leave="($event as HTMLElement).inert = true">
      <div v-if="searchOpen" id="group-member-search" class="member-search">
        <input ref="input" v-model="search" type="search" aria-label="按名称搜索成员"
          placeholder="搜索成员名称" @keydown.esc.stop="toggleSearch" />
        <button type="button" class="member-search-toggle" aria-label="关闭成员搜索" @click="toggleSearch"><X :size="14" /></button>
      </div>
      </Transition>
    </header>
    <div class="members-list" :class="{ 'group-content-ready': members.length > 0 }">
      <p v-if="connectionLost" class="group-hint" role="status">成员状态同步中断，当前显示可能已过期。</p>
      <p v-if="error" role="alert" class="group-error">{{ error }}</p>
      <p v-else-if="loadingHint" class="group-hint" role="status">正在读取成员…</p>
      <p v-if="search.trim() && !loading && !error && !filtered.length" class="group-hint" role="status">没有找到匹配的成员</p>
      <div v-for="member in filtered" :key="member.userId" class="group-member-row" :class="{ 'is-offline': status(member) === 'OFFLINE' }"
        tabindex="0" role="button" :aria-label="`查看 ${member.userId === user.id ? user.nickname : member.nickname} 的资料`" aria-haspopup="dialog"
        @mouseenter="queueProfile(member, $event)" @mouseleave="leaveProfile"
        @focus="showProfile(member, $event.currentTarget as HTMLElement)"
        @click="showProfile(member, $event.currentTarget as HTMLElement)"
        @keydown.enter.prevent="showProfile(member, $event.currentTarget as HTMLElement)"
        @keydown.space.prevent="showProfile(member, $event.currentTarget as HTMLElement)">
        <span class="group-member-avatar" :aria-label="statusLabel(member)">
          <img v-if="member.userId === user.id ? user.avatar : member.avatar" :src="member.userId === user.id ? user.avatar : member.avatar" alt="" />
          <span v-else class="group-member-initial">{{ member.nickname.slice(0, 1) }}</span>
          <span v-if="status(member) !== 'OFFLINE'" class="status-dot" :class="status(member)" />
        </span>
        <span class="group-member-info">
          <span class="group-member-name"><span>{{ member.userId === user.id ? user.nickname : member.nickname }}</span>
            <Crown v-if="member.role === 'OWNER'" :size="13" class="group-member-role" role="img" aria-label="群主" /></span>
          <ActivityStatus v-if="activity(member)" :type="activity(member)!.type" :text="activity(member)!.text" :active="hoveredMember === member.userId" />
        </span>
      </div>
    </div>
    <ProfilePopover ref="profileCard" :anchor="profileAnchor" :profile-key="profileUserId" placement="left" label="成员资料"
      :nickname="profileMember?.userId === user.id ? user.nickname : profileMember?.nickname ?? ''"
      :avatar="profileMember?.userId === user.id ? user.avatar : profileMember?.avatar ?? ''"
      :signature="profileMember?.userId === user.id ? user.signature : profileSignature"
      :status="profileMember ? status(profileMember) : 'OFFLINE'" :status-label="profileMember ? PRESENCE_STATUS_LABELS[status(profileMember)] : ''"
      :activity="profileMember ? activity(profileMember)?.text : undefined"
      :last-online-at="profilePresence?.lastOnlineAt" :recent-game="profilePresence?.recentGame"
      :activity-started-at="profileMember ? activity(profileMember)?.startedAt : undefined" :loading="profileLoading" :error="profileError"
      :own-voice="profileUserId === user.id" :voice-error="profileUserId === user.id ? ownVoice.error.value : ''"
      :voice-seconds="profileUserId === user.id ? ownVoice.seconds.value : (!profileLoading && !profileError ? sharedVoiceSeconds : null)"
      @close="closeProfile" @enter="keepProfile" @leave="leaveProfile" @retry="loadProfile" />
  </aside>
</template>

<style scoped>
.members-directory { border-left: 1px solid var(--border); background: var(--panel-sidebar); }
.member-search-toggle { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; background: transparent; color: var(--muted); cursor: pointer; }
.member-search-toggle:hover { color: var(--text); }
</style>
