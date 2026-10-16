<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue';
import { Minus, X } from '@lucide/vue';
import App from './App.vue';
import AccountAccessPrompt from './components/AccountAccessPrompt.vue';
import WelcomeProfile from './components/WelcomeProfile.vue';
import StartupUpdate from './components/StartupUpdate.vue';
import AppNotice from './components/AppNotice.vue';
import InlineFeedback from './components/InlineFeedback.vue';
import type { AccessOffer } from './auth/accountAccess';
import {
  authRequest,
  authenticatedFetch,
  ApiRequestError,
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
const manualAccessLink = ref('');
const manualAccessError = ref('');
const startupChecking = ref(Boolean(desktop));
const updateState = ref<StartupUpdateState | null>(null);
const updateWarning = ref('');
const entryRoot = ref<HTMLElement | null>(null);
const windowMode = computed(() => {
  if (startupChecking.value) return 'startup';
  if (accessOffer.value) return 'invitation';
  if (!user.value) return 'account';
  return onboarding.value ? 'profile' : 'main';
});
let layoutFrame: number | undefined;
let layoutResizeObserver: ResizeObserver | undefined;
let layoutMutationObserver: MutationObserver | undefined;
let observedCard: HTMLElement | null = null;
let observedNotice: HTMLElement | null = null;
let lastWindowLayout = '';
let disposed = false;
let sessionHeartbeat: number | null = null;
let sessionHeartbeatInFlight = false;
let logoutInProgress = false;
let initializationRequest: AbortController | null = null;

function updateWindowLayout() {
  layoutFrame = undefined;
  if (!desktop || disposed) return;
  const card = entryRoot.value?.querySelector<HTMLElement>('.startup-update-card, .auth-card') ?? null;
  const notice = entryRoot.value?.querySelector<HTMLElement>('.app-notice') ?? null;
  if (windowMode.value !== 'main' && !card) return;
  if (card !== observedCard || notice !== observedNotice) {
    layoutResizeObserver?.disconnect();
    observedCard = card;
    observedNotice = notice;
    if (card) layoutResizeObserver?.observe(card);
    if (notice) layoutResizeObserver?.observe(notice);
  }
  const height = card ? Math.ceil(card.getBoundingClientRect().height
    + (entryRoot.value?.querySelector('.titlebar')?.getBoundingClientRect().height ?? 43)
    + (notice?.getBoundingClientRect().height ?? 0)) : 0;
  const signature = `${windowMode.value}:${height}`;
  if (signature === lastWindowLayout) return;
  lastWindowLayout = signature;
  void desktop.setWindowLayout(windowMode.value, height).catch(() => {
    if (!disposed) error.value = '窗口尺寸调整失败，请重新打开应用。';
  });
}

function scheduleWindowLayout() {
  if (layoutFrame === undefined) layoutFrame = requestAnimationFrame(updateWindowLayout);
}

watch([entryRoot, windowMode], ([root]) => {
  if (!desktop) return;
  layoutMutationObserver?.disconnect();
  layoutResizeObserver ??= new ResizeObserver(scheduleWindowLayout);
  layoutMutationObserver ??= new MutationObserver(scheduleWindowLayout);
  if (root) layoutMutationObserver.observe(root, { childList: true, subtree: true });
  scheduleWindowLayout();
}, { flush: 'post' });

function expired() {
  initializationRequest?.abort();
  user.value = null;
  onboarding.value = false;
}
const removeAccessLink = desktop?.onAccessLink((offer) => {
  // 当前确认未结束前不切换链接，避免两次兑换的响应互相覆盖。
  if (!user.value && !accessOffer.value) accessOffer.value = offer;
});
const removeMaximizedChange = desktop?.onMaximizedChange((maximized) => { windowMaximized.value = maximized; });
const removeUpdateState = desktop?.onUpdateState((state) => { updateState.value = state; });
const removeClose = desktop?.onClose(() => { if (!user.value && !logoutInProgress) desktop.finishClose(); });
void desktop?.isMaximized().then((maximized) => { windowMaximized.value = maximized; }).catch(() => undefined);
window.addEventListener('lycan:unauthorized', expired);
onScopeDispose(() => {
  disposed = true;
  if (layoutFrame !== undefined) cancelAnimationFrame(layoutFrame);
  layoutResizeObserver?.disconnect();
  layoutMutationObserver?.disconnect();
  initializationRequest?.abort();
  if (sessionHeartbeat !== null) window.clearInterval(sessionHeartbeat);
  removeMaximizedChange?.();
  removeClose?.();
  removeAccessLink?.();
  removeUpdateState?.();
  window.removeEventListener('lycan:unauthorized', expired);
});

async function initialize() {
  if (disposed) return;
  initializationRequest?.abort();
  const request = new AbortController();
  initializationRequest = request;
  error.value = '';
  try {
    const options = await authRequest<{ mode: 'invite' }>('options', 'GET', undefined, request.signal);
    if (request.signal.aborted) return;
    if (options.mode !== 'invite') throw new Error('服务器尚未启用邀请登录，请联系服主。');
    // 没有 Cookie 或页面持久化凭据；桌面主进程会自动附加已保存会话。
    const response = await authenticatedFetch('/api/auth/me', {
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
    });
    if (request.signal.aborted) return;
    if (response.ok) {
      const restoredUser = await response.json();
      // 邀请确认或新的重连已接管身份，旧响应正文也不能恢复先前账号。
      if (!request.signal.aborted) user.value = restoredUser;
    }
    else if (response.status !== 401) throw new Error('无法恢复登录，请稍后重试。');
  } catch (exception) {
    if (!request.signal.aborted) error.value = exception instanceof Error ? exception.message : '无法连接服务器';
  } finally {
    if (initializationRequest === request) {
      initializationRequest = null;
      if (!disposed) ready.value = true;
    }
  }
}

function acceptSession(result: { sessionToken?: string; user: AuthUser }) {
  if (!desktop) {
    if (!result.sessionToken) throw new Error('登录响应缺少会话');
    setBrowserSession(result.sessionToken);
  }
  initializationRequest?.abort();
  user.value = result.user;
}
function completeAccess(result: { sessionToken?: string; user: AuthUser }, kind: string) {
  acceptSession(result);
  accessOffer.value = null;
  onboarding.value = kind !== 'RECOVERY';
}

async function verifyCurrentSession() {
  const requestUser = user.value;
  if (disposed || !requestUser || sessionHeartbeatInFlight) return;
  sessionHeartbeatInFlight = true;
  try {
    const session = await authRequest<AuthSessionStatus>('session');
    // 保存资料或重新登录后账号对象已更换，旧心跳不能覆盖新的资料与身份展示。
    if (disposed || user.value !== requestUser) return;
    if (requestUser.id === session.id
        && (requestUser.nickname !== session.nickname || requestUser.administrator !== session.administrator)) {
      user.value = { ...requestUser, nickname: session.nickname, administrator: session.administrator };
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
  // 有效会话直接进入应用；打开邀请不能切换身份或遮住已有通话。
  if (currentUserId) accessOffer.value = null;
  if (sessionHeartbeat !== null) window.clearInterval(sessionHeartbeat);
  sessionHeartbeat = currentUserId ? window.setInterval(() => {
    // 同账号在新设备登录后，旧客户端即使正在语音中也会及时收到 401 并退出。
    void verifyCurrentSession();
  }, SESSION_HEARTBEAT_INTERVAL_MS) : null;
});

async function logout() {
  initializationRequest?.abort();
  error.value = '';
  const previousUser = user.value;
  logoutInProgress = true;
  user.value = null;
  await sendPresenceHeartbeat('OFFLINE', null, AbortSignal.timeout(1_200)).catch(() => undefined);
  try {
    // 退出期间已通过邀请接入新身份时，不再使用新会话发送旧退出请求。
    if (disposed || user.value) return;
    await authRequest<void>('logout', 'POST');
    if (disposed || user.value) return;
    setBrowserSession(null);
    expired();
  } catch (exception) {
    if (disposed || user.value) return;
    if (exception instanceof ApiRequestError
        && (exception.status === 401 || exception.code === 'LOCAL_SESSION_CLEAR_FAILED')) {
      setBrowserSession(null);
      expired();
      if (exception.status !== 401) error.value = exception.message;
      return;
    }
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
async function openManualAccessLink() {
  if (!desktop || submitting.value || serverSaving.value || user.value || accessOffer.value) return;
  submitting.value = true;
  manualAccessError.value = '';
  try {
    const offer = await desktop.parseAccessLink(manualAccessLink.value);
    if (disposed || user.value || accessOffer.value) return;
    manualAccessLink.value = '';
    accessOffer.value = offer;
  } catch (exception) {
    if (!disposed && !user.value && !accessOffer.value) {
      manualAccessError.value = exception instanceof Error
        ? exception.message.replace(/^Error invoking remote method 'auth:access:parse': Error: /, '')
        : '无法读取链接，请重新粘贴。';
    }
  } finally { submitting.value = false; }
}
onMounted(async () => {
  if (desktop) {
    try {
      updateState.value = await desktop.getUpdateState();
      const result = await desktop.runStartupUpdate();
      if (result.error) updateWarning.value = result.message;
    } catch {
      updateWarning.value = '启动更新不可用，仍可使用当前版本。请稍后重新打开应用。';
    }
    if (disposed) return;
    startupChecking.value = false;
  }
  // 更新期间不读走邀请、不恢复登录，也不挂载房间或启动心跳。
  void initialize();
  void desktop?.getAccessLink().then((offer) => { if (!user.value && offer && !accessOffer.value) accessOffer.value = offer; })
    .catch(() => { error.value = '无法读取邀请链接，请从网页重新打开。'; });
  void desktop?.getServerSettings?.().then((settings) => {
    serverAddress.value = settings.apiUrl;
    serverEditable.value = settings.editable;
  }).catch(() => { serverError.value = '无法读取服务器地址。'; });
});
</script>

<template>
  <App v-if="user && !onboarding" v-show="!accessOffer" :user="user" :window-maximized="windowMaximized" :save-profile="saveProfile"
    :startup-update-warning="updateWarning" @dismiss-update-warning="updateWarning = ''" @logout="logout" />
  <div v-if="!user || onboarding || accessOffer" ref="entryRoot" class="app-shell" :class="{ 'compact-auth': desktop }">
    <header class="titlebar" :class="{ 'desktop-titlebar': desktop }">
      <div class="brand">LycanSync</div>
      <div v-if="desktop" class="window-actions">
        <button aria-label="最小化窗口" @click="desktop.minimize()"><Minus :size="16" /></button>
        <button aria-label="关闭窗口" @click="desktop.close()"><X :size="17" /></button>
      </div>
    </header>
    <AppNotice v-if="updateWarning" :message="updateWarning" dismissible @dismiss="updateWarning = ''" />
    <StartupUpdate v-if="startupChecking" :state="updateState" @skip="desktop?.skipStartupUpdate()" />
    <WelcomeProfile v-else-if="user && onboarding" :user="user" :save-profile="saveProfile" @finish="onboarding = false" />
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
        <details v-if="desktop || serverEditable" class="auth-server-settings">
          <summary>更多</summary>
          <form v-if="desktop" @submit.prevent="openManualAccessLink">
            <label for="manual-access-link">邀请或恢复登录链接</label>
            <div class="auth-input-row">
              <input v-model="manualAccessLink" type="text" required maxlength="2048" autocomplete="off" spellcheck="false"
                id="manual-access-link" aria-describedby="manual-access-feedback" placeholder="粘贴服主发来的完整链接" :disabled="submitting || serverSaving" />
              <button type="submit" class="confirm-button" :disabled="submitting || serverSaving">检查链接</button>
            </div>
            <InlineFeedback id="manual-access-feedback" :message="manualAccessError"
              :status="submitting ? '正在检查…' : '在当前窗口打开，不会立即使用邀请；检查后仍需确认。'" />
          </form>
          <form v-if="serverEditable" @submit.prevent="saveServerAddress">
            <label for="auth-server-address">服务器地址</label>
            <div class="auth-input-row">
              <input v-model="serverAddress" id="auth-server-address" type="url" required autocomplete="off"
                aria-describedby="server-address-feedback" :disabled="submitting || serverSaving" />
              <button type="submit" class="confirm-button" :disabled="submitting || serverSaving">{{ serverSaving ? '正在重启…' : '保存并重启' }}</button>
            </div>
            <InlineFeedback id="server-address-feedback" :message="serverError"
              :status="serverSaving ? '正在重启…' : '保存后重启应用，使用该服务器的账号登录。'" />
          </form>
        </details>
      </section>
    </main>
  </div>
</template>

<style scoped>
.compact-auth { display: flex; flex-direction: column; }
.compact-auth > .titlebar { flex: 0 0 var(--titlebar-height); }
.compact-auth :deep(.auth-screen), .compact-auth :deep(.startup-update-screen) {
  display: block; flex: 1; min-height: 0; overflow: auto; padding: 0;
}
.compact-auth :deep(.auth-card), .compact-auth :deep(.startup-update-card) {
  width: 100%; border: 0; border-radius: 0; background: var(--panel);
}
.compact-auth :deep(.app-notice) { position: static; transform: none; width: 100%; flex: 0 0 auto; }
</style>
