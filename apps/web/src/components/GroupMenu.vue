<script setup lang="ts">
import { onMounted, onScopeDispose, ref } from 'vue';
import { ChevronDown } from '@lucide/vue';
import type { GroupSummary } from '../group/groupApi';

defineProps<{ group: GroupSummary }>();
const emit = defineEmits<{ select: [action: 'edit' | 'invite' | 'members' | 'transfer' | 'leave' | 'dissolve'] }>();
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const open = ref(false);
function dismiss(event: PointerEvent) { if (!root.value?.contains(event.target as Node)) open.value = false; }
function dismissAfterFocus(event: FocusEvent) {
  if (event.relatedTarget && !root.value?.contains(event.relatedTarget as Node)) open.value = false;
}
function choose(action: 'edit' | 'invite' | 'members' | 'transfer' | 'leave' | 'dissolve') {
  open.value = false;
  // 菜单项会卸载，后续对话框应记住仍存在的菜单入口。
  trigger.value?.focus();
  emit('select', action);
}
onMounted(() => document.addEventListener('pointerdown', dismiss));
onScopeDispose(() => document.removeEventListener('pointerdown', dismiss));
</script>

<template>
  <div ref="root" class="group-menu" @keydown.esc.stop="open = false; trigger?.focus()" @focusout="dismissAfterFocus">
    <button ref="trigger" type="button" class="group-menu-trigger" aria-label="群组菜单" :aria-expanded="open" @click="open = !open">
      <h1>{{ group.name }}</h1><ChevronDown :size="18" :class="{ 'is-open': open }" />
    </button>
    <div v-if="open" class="group-menu-options" aria-label="群组操作">
      <template v-if="group.role === 'OWNER'">
        <button type="button" @click="choose('edit')">编辑群组资料</button>
        <button type="button" @click="choose('invite')">邀请成员</button>
        <button type="button" @click="choose('members')">管理成员</button>
        <button type="button" @click="choose('transfer')">转让群主</button>
        <button type="button" class="group-danger" @click="choose('dissolve')">解散群聊</button>
      </template>
      <button v-else type="button" class="group-danger" @click="choose('leave')">退出群聊</button>
    </div>
  </div>
</template>

<style scoped>
.group-menu { position: relative; min-width: 0; }
.group-menu-trigger { display: flex; align-items: center; gap: 8px; max-width: 100%; border: 0; padding: 0; background: transparent; text-align: left; }
.group-menu-trigger h1 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group-menu-trigger svg { flex-shrink: 0; color: var(--muted); }
.group-menu-trigger svg.is-open { transform: rotate(180deg); }
.group-menu-options { position: absolute; top: calc(100% + 8px); left: 0; z-index: 30; display: grid; min-width: 180px; padding: 6px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-raised); }
.group-menu-options button { justify-content: flex-start; padding: 7px 10px; border: 0; background: transparent; text-align: left; }
.group-menu-options button:hover { background: var(--panel-soft); }
.group-menu-options .group-danger { color: var(--danger); border-top: 1px solid var(--border-soft); margin-top: 4px; }
</style>
