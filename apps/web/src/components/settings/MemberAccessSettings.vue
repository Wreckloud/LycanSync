<script setup lang="ts">
import { ref, toRef } from 'vue';
import InlineFeedback from '../InlineFeedback.vue';
import { accessLinkStatus } from '../../auth/accountAccess';
import { useMemberAccess } from '../../settings/useMemberAccess';

const props = defineProps<{ active: boolean }>();
const linkInput = ref<HTMLInputElement | null>(null);
const { links, members, offset, memberOffset, note, target, generatedUrl, inviteError, recoveryError, linkError,
  recordsError, copyStatus, busy, refreshing, copying, locked, currentTime, refresh, generate, revoke, copyLink, page } = useMemberAccess(toRef(props, 'active'));

async function copy() {
  if (!await copyLink() && linkError.value) {
    linkInput.value?.focus();
    linkInput.value?.select();
  }
}
</script>

<template>
  <section class="settings-section member-access">
    <section class="settings-block">
      <h2>邀请新朋友</h2>
      <p>每人一条，3 天有效。成功加入后不能再使用。</p>
      <label for="invitation-note">备注<span>仅服主可见</span></label>
      <div class="access-form-row">
        <input id="invitation-note" v-model="note" maxlength="100" :readonly="busy" placeholder="朋友的名字或邀请用途" />
        <button :disabled="locked" @click="generate('INVITE')">邀请新朋友</button>
      </div>
      <InlineFeedback :message="inviteError" />
    </section>
    <section class="settings-block">
      <h2>恢复成员登录</h2>
      <p>12 小时有效；成功后旧设备登录失效，原资料与权限保留。</p>
      <label for="recovery-member">成员</label>
      <div class="access-form-row">
        <select id="recovery-member" v-model="target" :disabled="busy">
          <option value="">请选择成员</option>
          <option v-for="member in members" :key="member.id" :value="member.id">{{ member.nickname }} · {{ member.id }}</option>
        </select>
        <button :disabled="locked || !target" @click="generate('RECOVERY')">恢复成员登录</button>
      </div>
      <InlineFeedback :message="recoveryError" />
      <div v-if="memberOffset || members.length === 100" class="button-actions">
        <button :disabled="locked || memberOffset === 0" @click="page(-1, true)">上一页成员</button>
        <button :disabled="locked || members.length < 100" @click="page(1, true)">下一页成员</button>
      </div>
    </section>
    <section v-if="generatedUrl" class="settings-block generated-link">
      <h2>新链接</h2>
      <p>请保存并发给对应朋友；离开此页后无法再次查看原链接。</p>
      <div class="access-form-row">
        <input ref="linkInput" :value="generatedUrl" readonly aria-label="生成的链接" />
        <button :disabled="copying" @click="copy">{{ copying ? '正在复制…' : '复制链接' }}</button>
      </div>
      <InlineFeedback :message="linkError" :status="copyStatus" />
    </section>
    <section class="settings-block">
      <div class="access-records-heading"><h2>链接记录</h2><button :disabled="locked" @click="refresh(true)">刷新状态</button></div>
      <InlineFeedback :message="recordsError" :status="refreshing && !links.length ? '正在读取记录…' : ''" />
      <p v-if="!links.length && !refreshing && !recordsError">暂无记录</p>
      <article v-for="link in links" :key="link.id" class="access-record">
        <div class="access-record-details">
          <strong>{{ link.kind === 'INVITE' ? '邀请新朋友' : link.kind === 'RECOVERY' ? '恢复成员登录' : '激活服主' }} · {{ accessLinkStatus(link, currentTime) }}</strong>
          <span v-if="link.note">{{ link.note }}</span>
          <small>到期：{{ new Date(link.expiresAt).toLocaleString() }}</small>
          <small v-if="link.resultUserId">已完成成员：{{ link.resultUserId }}</small>
          <small v-if="link.lastFailure">上次失败：{{ link.lastFailure }}（失败不会消耗链接）</small>
        </div>
        <div v-if="!link.consumedAt" class="button-actions">
          <button :disabled="locked" @click="generate(link.kind === 'RECOVERY' ? 'RECOVERY' : 'INVITE', link.id)">重新生成</button>
          <button :disabled="locked || !!link.revokedAt" @click="revoke(link.id)">撤销</button>
        </div>
      </article>
      <div v-if="offset || links.length === 100" class="button-actions access-pagination">
        <button :disabled="locked || offset === 0" @click="page(-1)">上一页记录</button>
        <button :disabled="locked || links.length < 100" @click="page(1)">下一页记录</button>
      </div>
    </section>
  </section>
</template>

<style scoped>
.member-access .settings-block { gap: 4px; padding-bottom: 12px; }
.member-access h2 { margin: 0; }
.member-access .settings-block > p { margin: 0 0 8px; color: var(--muted); font-size: 13px; line-height: 20px; }
label { display: flex; align-items: baseline; gap: 8px; font-size: 14px; line-height: 20px; }
label span { color: var(--muted); font-size: 12px; }
.access-form-row { display: flex; align-items: center; gap: 12px; }
.access-form-row input, .access-form-row select { flex: 1; width: 0; min-width: 0; height: var(--button-height); padding: 5px 10px; border: 1px solid var(--border); border-radius: 5px; background: var(--panel); color: var(--text); font: inherit; font-size: 14px; line-height: 20px; }
.access-form-row button { flex-shrink: 0; min-width: 108px; white-space: nowrap; font-size: 14px; }
.access-records-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 4px; }
.access-record { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--border-soft); }
.access-record-details { display: grid; min-width: 0; gap: 4px; overflow-wrap: anywhere; font-size: 14px; line-height: 20px; }
.access-record-details small { color: var(--muted); font-size: 12px; }
.access-record .button-actions { flex-shrink: 0; }
.access-pagination { justify-content: flex-end; margin-top: 12px; }
@media (max-width: 600px) { .access-record { align-items: flex-start; flex-direction: column; gap: 8px; } }
@media (max-width: 380px) { .access-form-row { flex-wrap: wrap; gap: 8px; } .access-form-row input, .access-form-row select { flex-basis: 100%; width: 100%; } .access-form-row button { margin-left: auto; } }
</style>
