<script setup lang="ts">
import { nextTick, onScopeDispose, reactive, ref, watch } from 'vue';
import { authRequest } from '../../auth/authApi';
import DialogTransition from '../DialogTransition.vue';
import { useBackdropDismiss } from '../useBackdropDismiss';
import { keepDialogFocus } from '../dialogFocus';
import InlineFeedback from '../InlineFeedback.vue';

const props = defineProps<{ active: boolean; leaving: boolean }>();
interface QqSettings { enabled: boolean; appId: string; callbackUrl: string; appKeyConfigured: boolean; configurationError: string }
const saved = ref<QqSettings | null>(null);
const draft = reactive({ enabled: false, appId: '', appKey: '', callbackUrl: '' });
const expanded = ref(false);
const dialog = ref<HTMLFormElement | null>(null);
const backdropEvents = useBackdropDismiss(() => { if (!busy.value) close(); });
watch(expanded, async (open) => { if (open) { await nextTick(); dialog.value?.focus(); } });
const busy = ref(false);
const error = ref('');
let request: AbortController | undefined;

async function load() {
  request?.abort();
  const current = new AbortController();
  request = current;
  busy.value = true;
  error.value = '';
  try {
    const result = await authRequest<QqSettings>('server-settings/qq', 'GET', undefined, current.signal);
    if (!current.signal.aborted) {
      saved.value = result;
    }
  } catch (reason) {
    if (!current.signal.aborted) error.value = reason instanceof Error ? reason.message : '无法读取 QQ 登录配置';
  } finally {
    if (!current.signal.aborted) busy.value = false;
  }
}

function edit() {
  if (!saved.value || busy.value) return;
  Object.assign(draft, { enabled: saved.value.enabled, appId: saved.value.appId, appKey: '', callbackUrl: saved.value.callbackUrl });
  error.value = '';
  expanded.value = true;
}

function close() {
  expanded.value = false;
  draft.appKey = '';
  error.value = '';
}

async function save() {
  if (busy.value || props.leaving) return;
  const current = new AbortController();
  request = current;
  busy.value = true;
  error.value = '';
  try {
    const result = await authRequest<QqSettings>('server-settings/qq', 'PUT', { ...draft }, current.signal);
    if (!current.signal.aborted) {
      saved.value = result;
      close();
    }
  } catch (reason) {
    if (!current.signal.aborted) error.value = reason instanceof Error ? reason.message : 'QQ 登录配置未保存';
  } finally {
    if (!current.signal.aborted) busy.value = false;
  }
}

watch(() => props.active, active => {
  if (active) void load();
  else { request?.abort(); busy.value = false; close(); }
}, { immediate: true });
onScopeDispose(() => { request?.abort(); draft.appKey = ''; });
</script>

<template>
  <div class="qq-login-settings">
    <div class="settings-action-row">
      <div><strong>QQ 登录{{ saved ? (saved.configurationError ? ' · 配置未完成' : saved.enabled ? ' · 已开启' : ' · 未开启') : '' }}</strong>
        <small>配置你的 QQ 互联应用，让成员使用 QQ 登录或绑定现有账号。</small></div>
      <button type="button" class="settings-button settings-control" :disabled="busy || leaving || !saved || expanded" @click="edit">配置 QQ 登录</button>
    </div>

    <InlineFeedback v-if="!expanded" :message="error || saved?.configurationError" :pending="busy ? '正在读取 QQ 登录配置…' : ''" />
    <button v-if="error && !expanded" type="button" :disabled="busy || leaving" @click="load">重试</button>
  </div>
  <DialogTransition>
    <div v-if="expanded && active" class="dialog-backdrop" v-on="backdropEvents" @keydown.esc.stop="!busy && close()">
      <form ref="dialog" class="qq-configuration-form" role="dialog" aria-modal="true" aria-label="配置 QQ 登录" tabindex="-1" @keydown="keepDialogFocus" @submit.prevent="save">
        <h2>配置 QQ 登录</h2>
        <div class="settings-toggle"><span><strong>允许 QQ 登录</strong></span>
          <input v-model="draft.enabled" type="checkbox" aria-label="允许 QQ 登录" :disabled="busy || leaving" />
        </div>
        <label class="settings-field" for="qq-app-id">App ID
          <input id="qq-app-id" v-model="draft.appId" maxlength="20" inputmode="numeric" autocomplete="off" :disabled="busy || leaving" :required="draft.enabled" />
        </label>
        <label class="settings-field" for="qq-app-key">App Key
          <input id="qq-app-key" v-model="draft.appKey" type="password" maxlength="128" autocomplete="new-password" :disabled="busy || leaving"
            :placeholder="saved?.appKeyConfigured && draft.appId.trim() === saved.appId ? '已设置，留空保留原密钥' : '填写 QQ 互联应用密钥'" />
        </label>
        <label class="settings-field" for="qq-callback-url">回调地址
          <input id="qq-callback-url" v-model="draft.callbackUrl" type="url" maxlength="2048" placeholder="https://你的域名/api/auth/qq/callback"
            autocomplete="off" :disabled="busy || leaving" :required="draft.enabled" />
        </label>
        <small>使用服务器的 HTTPS 域名填写回调地址，与 QQ 互联保持一致。成员也需通过此域名连接服务器；应用需在 QQ 互联完成接入。</small>
        <InlineFeedback :message="error" :pending="busy ? '正在保存 QQ 登录配置…' : ''" />
        <footer class="card-actions">
          <button type="button" :disabled="busy || leaving" @click="close">取消</button>
          <button type="submit" class="confirm-button card-actions-end" :disabled="busy || leaving">保存</button>
        </footer>
      </form>
    </div>
  </DialogTransition>
</template>

<style scoped>
.qq-login-settings { display: grid; gap: 8px; }
.qq-login-settings > button { justify-self: start; }
.qq-configuration-form { display: grid; gap: 12px; width: min(480px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow-y: auto; padding: 24px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); font-size: 14px; }
.qq-configuration-form h2 { margin: 0; font-size: 22px; line-height: 32px; }
.qq-configuration-form small { color: var(--muted); font-size: 12px; line-height: 1.6; }
</style>
