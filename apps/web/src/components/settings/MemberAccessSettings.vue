<script setup lang="ts">
import { ref, watch } from 'vue';
import DialogTransition from '../DialogTransition.vue';
import MemberAccessDialog from '../MemberAccessDialog.vue';
import type { MemberAccessMode } from '../../settings/useMemberAccess';

const props = defineProps<{ active: boolean }>();
const emit = defineEmits<{ notice: [message: string] }>();
const mode = ref<MemberAccessMode | null>(null);
watch(() => props.active, active => { if (!active) mode.value = null; });
</script>

<template>
  <section class="settings-block">
    <h2>成员访问</h2>
    <small>邀请新朋友加入，或帮助无法登录的成员找回原账号。</small>
    <div class="member-access-actions">
      <button type="button" @click="mode = 'invite'">邀请新朋友</button>
      <button type="button" @click="mode = 'recovery'">恢复成员登录</button>
    </div>
    <small class="member-links-description">查看邀请与恢复链接的使用状态，重新生成或撤销链接。</small>
    <button type="button" @click="mode = 'links'">链接管理</button>
  </section>
  <DialogTransition>
    <MemberAccessDialog v-if="active && mode" :key="mode" :mode="mode" @notice="emit('notice', $event)" @manage="mode = 'links'" @close="mode = null" />
  </DialogTransition>
</template>

<style scoped>
.member-access-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.member-links-description { margin-top: 8px; }
</style>
