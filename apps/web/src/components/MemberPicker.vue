<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';
import { Crown, UserRound } from '@lucide/vue';
import InlineFeedback from './InlineFeedback.vue';

export interface MemberOption { userId: string; nickname: string; avatar: string; role?: string; joined?: boolean }
const props = defineProps<{
  members?: MemberOption[];
  load?: (search: string, offset: number, signal: AbortSignal) => Promise<{ members: MemberOption[]; hasMore: boolean }>;
  disabled?: boolean; selected?: string; action?: string; label?: string; joinedIds?: string[];
}>();
const emit = defineEmits<{ select: [member: MemberOption] }>();
const search = defineModel<string>('search', { default: '' });
const results = ref<MemberOption[]>([]);
const loading = ref(false);
const error = ref('');
const hasMore = ref(false);
const list = ref<HTMLElement | null>(null);
const visibleMembers = computed(() => props.load ? results.value : (props.members ?? [])
  .filter(member => member.nickname.toLowerCase().includes(search.value.trim().toLowerCase())));
let request: AbortController | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let offset = 0;

async function loadMore() {
  if (!props.load || loading.value || props.disabled) return;
  const current = new AbortController(); request = current;
  loading.value = true; error.value = '';
  try {
    const page = await props.load(search.value.trim(), offset, current.signal);
    if (current.signal.aborted) return;
    offset += page.members.length;
    results.value = [...results.value, ...page.members.filter(member => !results.value.some(existing => existing.userId === member.userId))];
    hasMore.value = page.hasMore && page.members.length > 0;
  } catch (reason) {
    if (!current.signal.aborted) error.value = reason instanceof Error ? reason.message : '无法读取成员，请重试。';
  } finally {
    if (!current.signal.aborted) { loading.value = false; await nextTick(); checkScroll(); }
  }
}
function checkScroll() {
  const element = list.value;
  if (element && hasMore.value && !error.value && element.scrollHeight - element.scrollTop - element.clientHeight < 48) void loadMore();
}
function unavailable(member: MemberOption) {
  return props.disabled || loading.value || member.role === 'OWNER' || member.joined || props.joinedIds?.includes(member.userId);
}
watch(search, () => {
  request?.abort(); clearTimeout(timer); results.value = []; offset = 0; hasMore.value = false; error.value = '';
  if (list.value) list.value.scrollTop = 0;
  loading.value = !!props.load;
  timer = setTimeout(() => { loading.value = false; void loadMore(); }, 250);
});
watch(() => [props.load, props.disabled], () => { if (props.load && !props.disabled && offset === 0) void loadMore(); }, { immediate: true });
onScopeDispose(() => { request?.abort(); clearTimeout(timer); });
</script>

<template>
  <div class="member-picker">
    <input v-model="search" type="search" :disabled="disabled" maxlength="100" :aria-label="label ?? '搜索群成员'" placeholder="搜索成员" />
    <div ref="list" class="member-picker-list" :aria-label="label ?? '群成员'" :aria-busy="loading" @scroll.passive="checkScroll">
      <div v-for="member in visibleMembers" :key="member.userId" class="member-picker-row">
        <img v-if="member.avatar" :src="member.avatar" alt="" /><UserRound v-else :size="36" aria-hidden="true" />
        <strong><span>{{ member.nickname }}</span><Crown v-if="member.role === 'OWNER'" :size="13" aria-label="群主" /></strong>
        <button type="button" :disabled="unavailable(member)" :aria-pressed="selected === member.userId" @click="emit('select', member)"><slot name="action-label" :member="member">{{ member.joined || joinedIds?.includes(member.userId) ? '已加入' : selected === member.userId ? '已选择' : action ?? '选择' }}</slot></button>
      </div>
      <p v-if="!loading && !error && !visibleMembers.length">没有匹配的成员</p>
      <InlineFeedback :message="error" :pending="loading ? '正在查找成员…' : ''" />
      <button v-if="error" type="button" :disabled="disabled || loading" @click="loadMore">重新读取</button>
    </div>
  </div>
</template>

<style scoped>
.member-picker { display: grid; gap: 12px; min-width: 0; }
.member-picker > input { width: 100%; height: 40px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); font: inherit; }
.member-picker-list { height: 260px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--subtle) transparent; scrollbar-gutter: stable; overscroll-behavior: contain; }
.member-picker-row { display: flex; align-items: center; gap: 10px; min-height: 52px; padding: 5px 0; }
.member-picker-row img { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; }
.member-picker-row > svg { flex-shrink: 0; }
.member-picker-row strong { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; font-weight: 500; }
.member-picker-row strong span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.member-picker-row strong svg { flex-shrink: 0; color: var(--warning); }
.member-picker-row button { flex-shrink: 0; min-width: 64px; }
.member-picker-list > p { color: var(--muted); font-size: 13px; }
</style>
