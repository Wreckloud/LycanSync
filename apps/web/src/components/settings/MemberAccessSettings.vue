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
    <div class="button-actions">
      <button type="button" @click="mode = 'invite'">邀请新朋友</button>
      <button type="button" @click="mode = 'recovery'">恢复成员登录</button>
      <button type="button" @click="mode = 'links'">链接管理</button>
    </div>
  </section>
  <DialogTransition>
    <MemberAccessDialog v-if="active && mode" :mode="mode" @close="mode = null" />
  </DialogTransition>
</template>
