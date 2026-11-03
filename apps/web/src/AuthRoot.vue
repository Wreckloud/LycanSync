<script setup lang="ts">
import { onMounted, onScopeDispose, ref, watch } from 'vue';
import { ChevronDown, Minus, Square, UserRound, X } from '@lucide/vue';
import App from './App.vue';
import AccountAccessPrompt from './components/AccountAccessPrompt.vue';
import WelcomeProfile from './components/WelcomeProfile.vue';
import StartupUpdate from './components/StartupUpdate.vue';
import AppNotice from './components/AppNotice.vue';
import InlineFeedback from './components/InlineFeedback.vue';
import LogoutConfirmDialog from './components/LogoutConfirmDialog.vue';
import DialogTransition from './components/DialogTransition.vue';
import ExpandSection from './components/ExpandSection.vue';
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
import { clearLocalContentCache } from './cache/localCache';
import { useIdentityTransition } from './profile/useIdentityTransition';

const desktop = window.lycanDesktop;
const application = ref<InstanceType<typeof App> | null>(null);
const pageOrigin = window.location.origin;
const SESSION_HEARTBEAT_INTERVAL_MS = 20_000;
const user = ref<AuthUser | null>(null);
const entryUser = ref<AuthUser | null>(null);
const autoLogin = ref(true);
const manualEntryRequired = ref(false);
const preferenceSaving = ref(false);
const removeConfirm = ref(false);
const removing = ref(false);
const logoutTarget = ref<AuthUser | null>(null);
const logoutBusy = ref(false);
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
const moreOpen = ref(false);
const applicationReady = ref(false);
watch(() => user.value?.id, () => { applicationReady.value = false; }, { flush: 'sync' });
let disposed = false;
let sessionHeartbeat: number | null = null;
let sessionHeartbeatInFlight = false;
let logoutInProgress = false;
let initializationRequest: AbortController | null = null;

useIdentityTransition(() => ({
  id: (user.value ?? entryUser.value)?.id ?? null,
  phase: startupChecking.value || accessOffer.value ? null
    : user.value ? (applicationReady.value ? 'main' : 'loading')
      : logoutBusy.value ? 'leaving' : onboarding.value ? 'profile' : 'account',
}));

function expired() {
  initializationRequest?.abort();
  user.value = null;
  entryUser.value = null;
  onboarding.value = false;
}
const removeAccessLink = desktop?.onAccessLink((offer) => {
  // 当前确认未结束前不切换链接，避免两次兑换的响应互相覆盖。
  if (!user.value && !entryUser.value && !logoutInProgress && !removing.value && !accessOffer.value) accessOffer.value = offer;
});
const removeMaximizedChange = desktop?.onMaximizedChange((maximized) => { windowMaximized.value = maximized; });
const removeUpdateState = desktop?.onUpdateState((state) => { updateState.value = state; });
const removeClose = desktop?.onClose(() => { if (!user.value && !logoutInProgress) desktop.finishClose(); });
void desktop?.isMaximized().then((maximized) => { windowMaximized.value = maximized; }).catch(() => undefined);
window.addEventListener('lycan:unauthorized', expired);
onScopeDispose(() => {
  disposed = true;
  initializationRequest?.abort();
  if (sessionHeartbeat !== null) window.clearInterval(sessionHeartbeat);
  removeMaximizedChange?.();
  removeClose?.();
  removeAccessLink?.();
  removeUpdateState?.();
  window.removeEventListener('lycan:unauthorized', expired);
});

async function initialize(automatic = false) {
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
      const restoredUser: AuthUser = await response.json();
      if (request.signal.aborted) return;
      entryUser.value = restoredUser;
      const previousPreference = autoLogin.value;
      autoLogin.value = false;
      const preference = desktop ? await desktop.getAutoLogin(restoredUser.id)
        : { enabled: previousPreference, manualEntryRequired: manualEntryRequired.value };
      // 只有进程启动可自动进入；退出、重连和勾选设置都只更新账号确认页。
      if (!request.signal.aborted) {
        autoLogin.value = preference.enabled;
        manualEntryRequired.value = preference.manualEntryRequired;
        entryUser.value = restoredUser;
        if (automatic && preference.enabled && !preference.manualEntryRequired && !accessOffer.value) { user.value = restoredUser; entryUser.value = null; }
      }
    }
    else if (response.status === 401) entryUser.value = null;
    else throw new Error('无法恢复登录，请稍后重试。');
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
  entryUser.value = result.user;
  user.value = null;
}
async function completeAccess(result: { sessionToken?: string; user: AuthUser }, kind: string) {
  acceptSession(result);
  accessOffer.value = null;
  onboarding.value = kind !== 'RECOVERY';
  autoLogin.value = true;
  manualEntryRequired.value = true;
  if (desktop) {
    preferenceSaving.value = true;
    try { await desktop.setAutoLogin(result.user.id, true, true); }
    catch { autoLogin.value = false; error.value = '自动登录设置保存失败，请重新选择后手动登录。'; }
    finally { preferenceSaving.value = false; }
  }
}

async function changeAutoLogin(event: Event) {
  const account = entryUser.value;
  if (!account || preferenceSaving.value || submitting.value || removing.value) return;
  const enabled = (event.target as HTMLInputElement).checked;
  const previous = autoLogin.value;
  autoLogin.value = enabled;
  preferenceSaving.value = true;
  error.value = '';
  try { if (desktop) await desktop.setAutoLogin(account.id, enabled, manualEntryRequired.value); }
  catch { autoLogin.value = previous; error.value = '自动登录设置保存失败，请重试。'; }
  finally { preferenceSaving.value = false; }
}

async function enterAccount() {
  if (!entryUser.value || submitting.value || preferenceSaving.value || logoutBusy.value || removing.value) return;
  const accountId = entryUser.value.id;
  submitting.value = true;
  error.value = '';
  let failureMessage = '通话资源尚未完全停止，请重试或重新打开应用。';
  try {
    if (desktop) await desktop.returnToAccountEntry();
    await initialize();
    if (entryUser.value && !error.value && !disposed) {
      if (entryUser.value.id !== accountId) { error.value = '账号已变化，请确认当前资料后再次登录。'; return; }
      failureMessage = '登录设置保存失败，请检查安装目录权限后重试。';
      if (desktop) await desktop.setAutoLogin(entryUser.value.id, autoLogin.value, false);
      if (disposed || !entryUser.value) return;
      manualEntryRequired.value = false;
      user.value = entryUser.value;
      entryUser.value = null;
    }
  } catch { error.value = failureMessage; }
  finally { submitting.value = false; }
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
  const currentUserId = (user.value ?? entryUser.value)?.id;
  if (!currentUserId) throw new Error('登录状态已结束，请重新登录。');
  const updated = await authRequest<AuthUser>('me', 'PUT', profile);
  if ((user.value ?? entryUser.value)?.id !== currentUserId) throw new Error('当前账号已切换，资料没有更新到新账号。');
  if (user.value) user.value = updated;
  else entryUser.value = updated;
  return updated;
}

watch(() => user.value?.id ?? null, (currentUserId) => {
  if (!logoutBusy.value && logoutTarget.value?.id !== currentUserId) logoutTarget.value = null;
  // 有效会话直接进入应用；打开邀请不能切换身份或遮住已有通话。
  if (currentUserId) accessOffer.value = null;
  if (sessionHeartbeat !== null) window.clearInterval(sessionHeartbeat);
  sessionHeartbeat = currentUserId ? window.setInterval(() => {
    // 同账号在新设备登录后，旧客户端即使正在语音中也会及时收到 401 并退出。
    void verifyCurrentSession();
  }, SESSION_HEARTBEAT_INTERVAL_MS) : null;
});

function requestLogout() {
  if (!user.value || logoutInProgress || logoutBusy.value) return;
  error.value = '';
  logoutTarget.value = user.value;
}

async function confirmLogout() {
  const target = logoutTarget.value;
  if (!target || logoutBusy.value || user.value?.id !== target.id) return;
  logoutBusy.value = true;
  try {
    await logout();
    if (user.value?.id !== target.id) logoutTarget.value = null;
  } finally { logoutBusy.value = false; }
}

async function logout() {
  initializationRequest?.abort();
  error.value = '';
  const previousUser = user.value;
  const visibility = application.value?.prepareLogout();
  logoutInProgress = true;
  user.value = null;
  entryUser.value = previousUser;
  onboarding.value = false;
  try {
    // 先卸载房间，再确认原生资源停止；保留加密凭据，不调用撤销会话接口。
    await sendPresenceHeartbeat('OFFLINE', null, AbortSignal.timeout(1_200), visibility).catch(() => undefined);
    if (desktop) await desktop.returnToAccountEntry();
  } catch { error.value = '部分通话资源未完全停止，请重试登录或重新打开应用；凭据已保留。'; }
  finally { logoutInProgress = false; }
}

function requestClearSession() {
  if (!ready.value || user.value || submitting.value || logoutBusy.value || removing.value || preferenceSaving.value) return;
  error.value = '';
  removeConfirm.value = true;
}

async function clearLocalSession() {
  if (user.value || !removeConfirm.value || removing.value) return;
  initializationRequest?.abort();
  removing.value = true;
  error.value = '';
  let revoked = false;
  let cacheCleared = false;
  try {
    try { await clearLocalContentCache(); cacheCleared = true; }
    catch { /* 缓存清理失败仍允许移除凭据，完成后明确提示残留。 */ }
    try { await authRequest<void>('logout', 'POST'); revoked = true; }
    catch { /* 离线或损坏的凭据仍允许从本机移除。 */ }
    if (desktop) await desktop.clearSession();
    setBrowserSession(null);
    expired();
    autoLogin.value = true;
    removeConfirm.value = false;
    if (!revoked) error.value = '本机凭据已移除；服务器会话未确认撤销，请联系服主恢复或撤销。';
    if (!cacheCleared) error.value += (error.value ? ' ' : '') + '本地聊天缓存未能清理，请检查安装目录权限后重试清理。';
  } catch { error.value = '清理本机凭据失败，请检查数据目录权限后重试。'; }
  finally { removing.value = false; }
}
async function saveServerAddress() {
  if (!desktop || submitting.value || serverSaving.value || entryUser.value || removing.value || logoutBusy.value) return;
  serverSaving.value = true;
  serverError.value = '';
  try { await desktop.setServerAddress(serverAddress.value); }
  catch (exception) {
    serverError.value = exception instanceof Error ? exception.message : '服务器地址保存失败';
    serverSaving.value = false;
  }
}
async function openManualAccessLink() {
  if (!desktop || submitting.value || serverSaving.value || user.value || entryUser.value || accessOffer.value) return;
  submitting.value = true;
  manualAccessError.value = '';
  try {
    const offer = await desktop.parseAccessLink(manualAccessLink.value);
    if (disposed || user.value || entryUser.value || accessOffer.value) return;
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
  void initialize(true);
  void desktop?.getAccessLink().then((offer) => { if (!user.value && !entryUser.value && offer && !accessOffer.value) accessOffer.value = offer; })
    .catch(() => { error.value = '无法读取邀请链接，请从网页重新打开。'; });
  void desktop?.getServerSettings?.().then((settings) => {
    serverAddress.value = settings.apiUrl;
    serverEditable.value = settings.editable;
  }).catch(() => { serverError.value = '无法读取服务器地址。'; });
});
</script>

<template>
  <App v-if="user && !onboarding" v-show="!accessOffer" ref="application" :user="user" :window-maximized="windowMaximized" :save-profile="saveProfile"
    :interaction-blocked="Boolean(accessOffer || logoutTarget)"
    :startup-update-warning="updateWarning" @dismiss-update-warning="updateWarning = ''" @logout="requestLogout" @ready="applicationReady = true" />
  <DialogTransition>
    <LogoutConfirmDialog v-if="logoutTarget" :administrator="logoutTarget.administrator" :busy="logoutBusy" :error="error"
      @cancel="logoutTarget = null" @confirm="confirmLogout" />
  </DialogTransition>
  <DialogTransition>
    <LogoutConfirmDialog v-if="removeConfirm" mode="remove" :administrator="entryUser?.administrator ?? false"
      :busy="removing" :error="error" @cancel="removeConfirm = false" @confirm="clearLocalSession" />
  </DialogTransition>
  <Transition name="entry-shell" @before-enter="($event as HTMLElement).inert = false" @before-leave="($event as HTMLElement).inert = true">
  <div v-if="!user || onboarding || accessOffer" class="app-shell entry-shell">
    <header class="titlebar" :class="{ 'desktop-titlebar': desktop }">
      <div class="brand">LycanSync</div>
      <div v-if="desktop" class="window-actions">
        <button aria-label="最小化窗口" @click="desktop.minimize()"><Minus :size="16" /></button>
        <button :aria-label="windowMaximized ? '还原窗口' : '最大化窗口'" @click="desktop.toggleMaximize()"><Square :size="13" /></button>
        <button aria-label="关闭窗口" @click="desktop.close()"><X :size="17" /></button>
      </div>
    </header>
    <AppNotice v-if="updateWarning" :message="updateWarning" dismissible @dismiss="updateWarning = ''" />
    <div class="entry-pages">
    <Transition name="entry-page" @before-enter="($event as HTMLElement).inert = false" @before-leave="($event as HTMLElement).inert = true">
    <StartupUpdate v-if="startupChecking" key="startup" :state="updateState" @skip="desktop?.skipStartupUpdate()" />
    <WelcomeProfile v-else-if="entryUser && onboarding" key="profile" :user="entryUser" :save-profile="saveProfile" @finish="onboarding = false" />
    <main v-else :key="accessOffer ? 'invitation' : 'account'" class="auth-screen">
      <AccountAccessPrompt v-if="accessOffer && ready" :offer="accessOffer" :current-user="user ?? entryUser" :current-server="serverAddress || pageOrigin"
        @cancel="accessOffer = null" @joined="completeAccess" />
      <section v-else class="auth-card">
        <h1>一起开黑，一起看</h1>
        <p>登录 LycanSync，继续和朋友一起玩。</p>
        <p v-if="!ready">正在连接服务器…</p>
        <template v-else-if="ready">
          <div v-if="entryUser" class="account-preview" data-identity="account">
            <img v-if="entryUser.avatar" :src="entryUser.avatar" alt="账号头像" referrerpolicy="no-referrer" data-identity-avatar />
            <span v-else class="account-avatar-placeholder" data-identity-avatar><UserRound :size="26" aria-hidden="true" /></span>
            <div><strong data-identity-name>{{ entryUser.nickname }}</strong><small>{{ entryUser.administrator ? '服主' : '成员' }} · {{ serverAddress || pageOrigin }}</small></div>
          </div>
          <template v-if="entryUser">
            <label class="auto-login-option"><input type="checkbox" :checked="autoLogin"
              :disabled="submitting || preferenceSaving || logoutBusy || removing" @change="changeAutoLogin" />自动登录</label>
            <p class="account-entry-note">下次启动时自动进入；退出登录后仍在这里确认账号。</p>
            <div class="button-actions"><button class="confirm-button" :disabled="submitting || preferenceSaving || logoutBusy || removing"
              @click="enterAccount">{{ submitting ? '正在登录…' : '登录' }}</button></div>
          </template>
          <template v-else>
            <p>新成员使用服主发来的邀请链接；更换电脑或凭据失效时使用新的恢复登录链接。</p>
            <p>服主丢失凭据需由服务器维护者恢复，旧激活链接不能重复使用。</p>
          </template>
          <div v-if="error && !removeConfirm" class="button-actions">
            <button :disabled="submitting || logoutBusy || removing" @click="initialize()">重新连接</button>
          </div>
        </template>
        <p v-if="error && !removeConfirm && !logoutTarget" role="alert" class="auth-error">{{ error }}</p>
        <section v-if="desktop || serverEditable || entryUser" class="auth-server-settings">
          <button type="button" class="auth-more-toggle" :aria-expanded="moreOpen" aria-controls="account-more-options" @click="moreOpen = !moreOpen">
            更多<ChevronDown :size="14" :class="{ 'is-open': moreOpen }" />
          </button>
          <ExpandSection :open="moreOpen" id="account-more-options">
          <div class="auth-more-content">
          <button v-if="desktop || entryUser" type="button" :disabled="!ready || submitting || logoutBusy || removing || preferenceSaving"
            @click="requestClearSession">清除本机登录凭据</button>
          <p v-if="entryUser" class="account-entry-note">使用其他账号或服务器前，请先清除本机凭据。</p>
          <form v-if="desktop" @submit.prevent="openManualAccessLink">
            <label for="manual-access-link">邀请或恢复登录链接</label>
            <div class="auth-input-row">
              <input v-model="manualAccessLink" type="text" required maxlength="2048" autocomplete="off" spellcheck="false"
                id="manual-access-link" aria-describedby="manual-access-feedback" placeholder="粘贴服主发来的完整链接" :disabled="submitting || serverSaving || !!entryUser" />
              <button type="submit" class="confirm-button" :disabled="submitting || serverSaving || !!entryUser">检查链接</button>
            </div>
            <InlineFeedback id="manual-access-feedback" :message="manualAccessError"
              :status="submitting ? '正在检查…' : '在当前窗口打开，不会立即使用邀请；检查后仍需确认。'" />
          </form>
          <form v-if="serverEditable" @submit.prevent="saveServerAddress">
            <label for="auth-server-address">服务器地址</label>
            <div class="auth-input-row">
              <input v-model="serverAddress" id="auth-server-address" type="url" required autocomplete="off"
                aria-describedby="server-address-feedback" :disabled="submitting || serverSaving || !!entryUser" />
              <button type="submit" class="confirm-button" :disabled="submitting || serverSaving || !!entryUser">{{ serverSaving ? '正在重启…' : '保存并重启' }}</button>
            </div>
            <InlineFeedback id="server-address-feedback" :message="serverError"
              :status="serverSaving ? '正在重启…' : '保存后重启应用，使用该服务器的账号登录。'" />
          </form>
          </div>
          </ExpandSection>
        </section>
      </section>
    </main>
    </Transition>
    </div>
  </div>
  </Transition>
</template>

<style scoped>
.account-preview { display: flex; align-items: center; gap: 12px; margin: 20px 0; min-width: 0; }
.account-avatar-placeholder { display: grid; place-items: center; width: 48px; height: 48px; flex-shrink: 0; border-radius: 50%; background: var(--panel-raised); color: var(--muted); }
.account-preview img { width: 48px; height: 48px; border-radius: 50%; object-fit: cover; }
.account-preview > div { min-width: 0; }
.account-preview strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account-preview small { display: block; color: var(--muted); overflow-wrap: anywhere; }
.auto-login-option { display: flex; align-items: center; gap: 8px; margin-top: 16px; }
.auto-login-option input { flex-shrink: 0; width: 16px; height: 16px; margin: 0; padding: 0; }
.account-entry-note { color: var(--muted); font-size: 12px; line-height: 18px; }

.entry-shell { display: flex; flex-direction: column; }
.entry-shell > .titlebar { flex: 0 0 var(--titlebar-height); }
.entry-pages { position: relative; display: flex; flex: 1; min-height: 0; }
.entry-shell :deep(.auth-screen), .entry-shell :deep(.startup-update-screen) { flex: 1; }
.entry-shell :deep(.app-notice) { position: static; transform: none; width: 100%; flex: 0 0 auto; }
.auth-more-toggle { display: flex; align-items: center; gap: 6px; min-height: 24px; padding: 0; border: 0; background: transparent; color: var(--muted); font-size: 13px; }
.auth-more-toggle:hover { color: var(--text); }
.auth-more-toggle svg { transition: transform var(--motion-expand-duration) var(--motion-ease); }
.auth-more-toggle svg.is-open { transform: rotate(180deg); }
.auth-more-content { padding-top: 12px; }
</style>
