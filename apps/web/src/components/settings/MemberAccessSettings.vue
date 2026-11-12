<script setup lang="ts">
import { ref, watch } from 'vue';
import DialogTransition from '../DialogTransition.vue';
import MemberAccessDialog from '../MemberAccessDialog.vue';
import type { MemberAccessMode } from '../../settings/useMemberAccess';

const props = defineProps<{ active: boolean }>();
const mode = ref<MemberAccessMode | null>(null);
watch(() => props.active, active => { if (!active) mode.value = null; });
</script>

<template>
  <section class="settings-block">
    <h2>成员访问</h2>
    <div class="settings-toggle-group">
      <div class="settings-action-row">
        <div><strong>邀请新朋友</strong><small>通过邀请链接加入服务器。</small></div>
        <button type="button" @click="mode = 'invite'">邀请新朋友</button>
      </div>
      <div class="settings-action-row">
        <div><strong>恢复成员登录</strong><small>帮助无法登录的朋友找回原账号。</small></div>
        <button type="button" @click="mode = 'recovery'">恢复成员登录</button>
      </div>
      <div class="settings-action-row">
        <div><strong>链接管理</strong><small>查看使用状态，重新生成或撤销链接。</small></div>
        <button type="button" @click="mode = 'links'">链接管理</button>
      </div>
    </div>
  </section>
  <DialogTransition>
    <MemberAccessDialog v-if="active && mode" :mode="mode" @close="mode = null" />
  </DialogTransition>
</template>
