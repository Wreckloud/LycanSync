<script setup lang="ts">
import { ref, watch } from 'vue';
import DialogTransition from '../DialogTransition.vue';
import MemberAccessDialog from '../MemberAccessDialog.vue';
import type { MemberAccessMode } from '../../settings/useMemberAccess';

const props = defineProps<{ active: boolean }>();
const emit = defineEmits<{ notice: [message: string] }>();
const mode = ref<MemberAccessMode | null>(null);
const invitationDraft = ref<{ id: string; note: string; savedNote: string } | null>(null);
const memberScroll = ref(0);
const memberSearch = ref('');
const origin = ref<'invite' | 'recovery' | null>(null);
function open(next: MemberAccessMode | null) { memberSearch.value = ''; memberScroll.value = 0; invitationDraft.value = null; origin.value = null; mode.value = next; }
function manage() { if (mode.value !== 'links') origin.value = mode.value; mode.value = 'links'; }
function back() { mode.value = origin.value; origin.value = null; }
watch(() => props.active, active => { if (!active) open(null); });
</script>

<template>
  <section class="settings-block">
    <h2>成员访问</h2>
    <small>邀请新朋友加入，或帮助无法登录的成员找回原账号。</small>
    <div class="member-access-actions">
      <button type="button" @click="open('invite')">邀请新朋友</button>
      <button type="button" @click="open('recovery')">恢复成员登录</button>
    </div>
    <small class="member-links-description">查看邀请与恢复链接的使用状态，重新生成或撤销链接。</small>
    <button type="button" @click="open('links')">链接管理</button>
  </section>
  <DialogTransition>
    <MemberAccessDialog v-if="active && mode" :key="mode" :active="active" :mode="mode" v-model:invitation-draft="invitationDraft" v-model:member-scroll="memberScroll" :return-to="origin" v-model:member-search="memberSearch" @notice="emit('notice', $event)" @manage="manage" @back="back" @close="open(null)" />
  </DialogTransition>
</template>

<style scoped>
.member-access-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.member-links-description { margin-top: 8px; }
</style>
