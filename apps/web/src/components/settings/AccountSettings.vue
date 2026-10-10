<script setup lang="ts">
import { ref, watch } from 'vue';

const props = defineProps<{ active: boolean; leaving: boolean }>();
const emit = defineEmits<{ logout: [] }>();
const expanded = ref<'password' | 'qq' | null>(null);

function toggleEntry(entry: 'password' | 'qq') {
  expanded.value = expanded.value === entry ? null : entry;
}
watch(() => props.active, (active) => { if (!active) expanded.value = null; });
</script>

<template>
  <section class="settings-section account-settings">
    <section class="settings-block">
      <h2>密码</h2>
      <div class="account-row"><div class="account-copy"><span>登录密码</span>
        <div class="account-row-description"><p v-if="expanded === 'password'" id="password-entry" class="account-entry-note">修改密码尚未接入，本页不会提交密码。</p></div></div>
        <button type="button" :aria-expanded="expanded === 'password'" aria-controls="password-entry" @click="toggleEntry('password')">修改密码</button></div>
    </section>
    <section class="settings-block">
      <h2>第三方账号</h2>
      <div class="account-row"><div class="account-copy"><span>QQ 登录</span>
        <div class="account-row-description"><p v-if="expanded === 'qq'" id="qq-entry" class="account-entry-note">QQ 账号绑定尚未接入，暂时不能用于登录或关联当前账号。</p><small v-else>尚未接入</small></div></div>
        <button type="button" :aria-expanded="expanded === 'qq'" aria-controls="qq-entry" @click="toggleEntry('qq')">连接 QQ</button></div>
    </section>
    <section class="settings-block account-session">
      <h2>账号操作</h2>
      <div class="account-row"><div class="account-copy"><span>退出当前账号</span></div>
        <button type="button" :disabled="leaving" @click="emit('logout')">退出登录</button></div>
      <div class="account-row"><div class="account-copy"><span>注销账号</span><small>永久注销尚未支持</small></div>
        <button type="button" class="account-danger" disabled>注销账号</button></div>
    </section>
  </section>
</template>

<style scoped>
.account-settings { max-width: 820px; }
.account-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; min-height: 44px; }
.account-copy { display: grid; gap: 4px; min-width: 0; flex: 1; }
.account-copy small { display: block; line-height: 16px; }
.account-row-description { height: 32px; overflow: auto; color: var(--muted); font-size: 12px; line-height: 16px; }
.account-row button { flex-shrink: 0; min-height: 34px; padding: 6px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel-raised); color: var(--text); cursor: pointer; }
.account-row .account-danger { color: var(--danger); }
.account-entry-note { font-size: 12px; line-height: 16px; }
.account-session { gap: 12px; border-bottom: 0; }
@media (max-width: 520px) { .account-row { align-items: flex-start; gap: 12px; } }
</style>
