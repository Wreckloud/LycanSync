<script setup lang="ts">
import { onMounted, onScopeDispose, ref, watch } from 'vue';
import { Copy, Minus, Square, X } from '@lucide/vue';
import App from './App.vue';
import AccountAccessPrompt from './components/AccountAccessPrompt.vue';
import WelcomeProfile from './components/WelcomeProfile.vue';
import type { AccessOffer } from './auth/accountAccess';
import {
  authRequest,
  authenticatedFetch,
  setBrowserSession,
  type AuthSessionStatus,
  type AuthUser,
  type ProfileUpdate,
} from './auth/authApi';
import { sendPresenceHeartbeat } from './presence/presenceApi';

const desktop = window.lycanDesktop;
const pageOrigin = window.location.origin;
const SESSION_HEARTBEAT_INTERVAL_MS = 20_000;
const user = ref<AuthUser | null>(null);
const ready = ref(false);
const accessOffer = ref<AccessOffer | null>(null);
const onboarding = ref(false);
const error = ref('');
const submitting = ref(false);
const windowMaximized = ref(false);
const serverAddress = ref('');
const serverEditable = ref(false);
const serverSaving = ref(false);
const serverError = ref('');
let sessionHeartbeat: number | null = null;
let sessionHeartbeatInFlight = false;
let logoutInProgress = false;

function expired() {
  user.value = null;
  onboarding.value = false;
}
const removeAccessLink = desktop?.onAccessLink((offer) => {
  // 当前确认未结束前不切换链接，避免两次兑换的响应互相覆盖。
  if (!accessOffer.value) accessOffer.value = offer;
});
const removeMaximizedChange = desktop?.onMaximizedChange((maximized) => { windowMaximized.value = maximized; });
const removeClose = desktop?.onClose(() => { if (!user.value && !logoutInProgress) desktop.finishClose(); });
void desktop?.isMaximized().then((maximized) => { windowMaximized.value = maximized; }).catch(() => undefined);
window.addEventListener('lycan:unauthorized', expired);
onScopeDispose(() => {
  if (sessionHeartbeat !== null) window.clearInterval(sessionHeartbeat);
  removeMaximizedChange?.();
  removeClose?.();
  removeAccessLink?.();
  window.removeEventListener('lycan:unauthorized', expired);
});

async function initialize() {
  error.value = '';
  try {
    const options = await authRequest<{ mode: 'invite' }>('options');
    if (options.mode !== 'invite') throw new Error('服务器尚未启用邀请登录，请联系服主。');
    // 没有 Cookie 或页面持久化凭据；桌面主进程会自动附加已保存会话。
    const response = await authenticatedFetch('/api/auth/me', { signal: AbortSignal.timeout(15000) });
    if (response.ok) {
      user.value = await response.json();
    }
    else if (response.status !== 401) throw new Error('无法恢复登录，请稍后重试。');
  } catch (exception) {
    error.value = exception instanceof Error ? exception.message : '无法连接服务器';
  } finally { ready.value = true; }
}

function acceptSession(result: { sessionToken?: string; user: AuthUser }) {
  if (!desktop) {
    if (!result.sessionToken) throw new Error('登录响应缺少会话');
    setBrowserSession(result.sessionToken);
  }
  user.value = result.user;
}
function completeAccess(result: { sessionToken?: string; user: AuthUser }, kind: string) {
  acceptSession(result);
  accessOffer.value = null;
  onboarding.value = kind !== 'RECOVERY';
}

async function verifyCurrentSession() {
  if (sessionHeartbeatInFlight) return;
  sessionHeartbeatInFlight = true;
  try {
    const session = await authRequest<AuthSessionStatus>('session');
    const currentUser = user.value;
    if (currentUser?.id === session.id
        && (currentUser.nickname !== session.nickname || currentUser.administrator !== session.administrator)) {
      user.value = { ...currentUser, nickname: session.nickname, administrator: session.administrator };
    }
  } catch {
    // 网络异常由下一次心跳重试；401 会由 authenticatedFetch 统一退出登录。
  } finally {
    sessionHeartbeatInFlight = false;
  }
}

async function saveProfile(profile: ProfileUpdate) {
  const currentUserId = user.value?.id;
  if (!currentUserId) throw new Error('登录状态已结束，请重新登录。');
  const updated = await authRequest<AuthUser>('me', 'PUT', profile);
  if (user.value?.id !== currentUserId) throw new Error('当前账号已切换，资料没有更新到新账号。');
  user.value = updated;
  return updated;
}

watch(() => user.value?.id ?? null, (currentUserId) => {
  if (sessionHeartbeat !== null) window.clearInterval(sessionHeartbeat);
  sessionHeartbeat = currentUserId ? window.setInterval(() => {
    // 同账号在新设备登录后，旧客户端即使正在语音中也会及时收到 401 并退出。
    void verifyCurrentSession();
  }, SESSION_HEARTBEAT_INTERVAL_MS) : null;
});

async function logout() {
  error.value = '';
  const previousUser = user.value;
  logoutInProgress = true;
  user.value = null;
  await sendPresenceHeartbeat('OFFLINE', null, AbortSignal.timeout(1_200)).catch(() => undefined);
  try {
    await authRequest<void>('logout', 'POST');
    setBrowserSession(null);
    expired();
  } catch (exception) {
    if (exception instanceof Error && exception.name === 'ApiRequestError'
        && 'status' in exception && exception.status === 401) return;
    if (previousUser) user.value = previousUser;
    error.value = exception instanceof Error ? exception.message : '退出登录失败';
  } finally {
    logoutInProgress = false;
  }
}
async function clearLocalSession() {
  try { await desktop?.clearSession(); await initialize(); }
  catch { error.value = '清理本机凭据失败，请检查用户目录权限。'; }
}
async function saveServerAddress() {
  if (!desktop || submitting.value || serverSaving.value) return;
  serverSaving.value = true;
  serverError.value = '';
  try { await desktop.setServerAddress(serverAddress.value); }
  catch (exception) {
    serverError.value = exception instanceof Error ? exception.message : '服务器地址保存失败';
    serverSaving.value = false;
  }
}
onMounted(() => {
  void initialize();
  void desktop?.getAccessLink().then((offer) => { if (offer && !accessOffer.value) accessOffer.value = offer; })
    .catch(() => { error.value = '无法读取邀请链接，请从网页重新打开。'; });
  void desktop?.getServerSettings?.().then((settings) => {
    serverAddress.value = settings.apiUrl;
    serverEditable.value = settings.editable;
  }).catch(() => { serverError.value = '无法读取服务器地址。'; });
});
</script>

<template>
  <App v-if="user && !onboarding" v-show="!accessOffer" :user="user" :window-maximized="windowMaximized" :save-profile="saveProfile" @logout="logout" />
  <div v-if="!user || onboarding || accessOffer" class="app-shell">
    <header class="titlebar" :class="{ 'desktop-titlebar': desktop }">
      <div class="brand">LycanSync</div>
      <div v-if="desktop" class="window-actions">
        <button aria-label="最小化窗口" @click="desktop.minimize()"><Minus :size="16" /></button>
        <button :aria-label="windowMaximized ? '还原窗口' : '最大化窗口'" @click="desktop.toggleMaximize()">
          <Copy v-if="windowMaximized" :size="14" /><Square v-else :size="14" />
        </button>
        <button aria-label="关闭窗口" @click="desktop.close()"><X :size="17" /></button>
      </div>
    </header>
    <WelcomeProfile v-if="user && onboarding" :user="user" :save-profile="saveProfile" @finish="onboarding = false" />
    <main v-else class="auth-screen">
      <AccountAccessPrompt v-if="accessOffer && ready" :offer="accessOffer" :current-user="user" :current-server="serverAddress || pageOrigin"
        @cancel="accessOffer = null" @joined="completeAccess" />
      <section v-else class="auth-card">
        <h1>一起开黑，一起看</h1>
        <p>登录 LycanSync，继续和朋友一起玩。</p>
        <p v-if="!ready">正在连接服务器…</p>
        <template v-else-if="ready">
          <p>请打开服主发来的邀请或恢复登录链接；首次部署请使用服务器生成的激活链接。</p>
          <div v-if="error" class="button-actions">
            <button @click="initialize">重新连接</button>
            <button v-if="desktop" @click="clearLocalSession">清理本机登录凭据</button>
          </div>
        </template>
        <p v-if="error" role="alert" class="auth-error">{{ error }}</p>
        <details v-if="serverEditable" class="auth-server-settings">
          <summary>服务器地址</summary>
          <form @submit.prevent="saveServerAddress">
            <label>服务器地址
              <input v-model="serverAddress" type="url" required autocomplete="off" :disabled="submitting || serverSaving" />
            </label>
            <small>保存后重启应用，使用该服务器的账号登录。</small>
            <button type="submit" :disabled="submitting || serverSaving">{{ serverSaving ? '正在重启…' : '保存并重启' }}</button>
            <p v-if="serverError" role="alert" class="auth-error">{{ serverError }}</p>
          </form>
        </details>
      </section>
    </main>
  </div>
</template>
