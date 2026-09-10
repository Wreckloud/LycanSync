<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue';
import { Copy, Minus, Square, X } from '@lucide/vue';
import App from './App.vue';
import ProfileDialog from './components/ProfileDialog.vue';
import {
  authRequest,
  authenticatedFetch,
  setBrowserSession,
  type AuthSessionStatus,
  type AuthUser,
} from './auth/authApi';

const desktop = window.lycanDesktop;
const SESSION_HEARTBEAT_INTERVAL_MS = 20_000;
const user = ref<AuthUser | null>(null);
const ready = ref(false);
const initialized = ref(true);
const registrationMode = ref(false);
const username = ref('');
const password = ref('');
const passwordConfirmation = ref('');
const error = ref('');
const submitting = ref(false);
const profileOpen = ref(false);
const windowMaximized = ref(false);
let sessionHeartbeat: number | null = null;
let sessionHeartbeatInFlight = false;

const setupRequired = computed(() => !initialized.value);
const registering = computed(() => setupRequired.value || registrationMode.value);
const canSubmit = computed(() => Boolean(username.value.trim()) && Boolean(password.value)
  && (!registering.value || (password.value === passwordConfirmation.value && Boolean(passwordConfirmation.value)))
  && !submitting.value);

function expired() {
  user.value = null;
  profileOpen.value = false;
}
function toggleRegistrationMode() {
  registrationMode.value = !registrationMode.value;
  passwordConfirmation.value = '';
  error.value = '';
}
const removeMaximizedChange = desktop?.onMaximizedChange((maximized) => { windowMaximized.value = maximized; });
const removeClose = desktop?.onClose(() => { if (!user.value) desktop.finishClose(); });
void desktop?.isMaximized().then((maximized) => { windowMaximized.value = maximized; }).catch(() => undefined);
window.addEventListener('lycan:unauthorized', expired);
onScopeDispose(() => {
  if (sessionHeartbeat !== null) window.clearInterval(sessionHeartbeat);
  removeMaximizedChange?.();
  removeClose?.();
  window.removeEventListener('lycan:unauthorized', expired);
});

async function initialize() {
  error.value = '';
  try {
    const statusResponse = await authenticatedFetch('/api/system/initialization', {
      signal: AbortSignal.timeout(15000),
    });
    if (!statusResponse.ok) throw new Error('无法读取服务器初始化状态。');
    const status = await statusResponse.json() as { initialized: boolean };
    initialized.value = status.initialized;
    registrationMode.value = !status.initialized;
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
  initialized.value = true;
  registrationMode.value = false;
  username.value = '';
  password.value = '';
  passwordConfirmation.value = '';
}

async function verifyCurrentSession() {
  if (sessionHeartbeatInFlight) return;
  sessionHeartbeatInFlight = true;
  try {
    const session = await authRequest<AuthSessionStatus>('session');
    if (user.value?.id === session.id) {
      user.value = { ...user.value, nickname: session.nickname, administrator: session.administrator };
    }
  } catch {
    // 网络异常由下一次心跳重试；401 会由 authenticatedFetch 统一退出登录。
  } finally {
    sessionHeartbeatInFlight = false;
  }
}

async function openProfile() {
  error.value = '';
  try {
    user.value = await authRequest<AuthUser>('me');
  } catch (exception) {
    if (!user.value) return;
    error.value = exception instanceof Error ? exception.message : '无法读取个人资料';
  }
  profileOpen.value = true;
}

watch(user, (currentUser) => {
  if (sessionHeartbeat !== null) window.clearInterval(sessionHeartbeat);
  sessionHeartbeat = currentUser ? window.setInterval(() => {
    // 同账号在新设备登录后，旧客户端即使正在语音中也会及时收到 401 并退出。
    void verifyCurrentSession();
  }, SESSION_HEARTBEAT_INTERVAL_MS) : null;
});

async function submitCredentials() {
  error.value = '';
  if (registering.value && password.value !== passwordConfirmation.value) {
    error.value = '两次输入的密码不一致';
    return;
  }
  submitting.value = true;
  try {
    const result = registering.value
      ? await authRequest<{ sessionToken?: string; user: AuthUser }>('local/register', 'POST', {
        username: username.value.trim(), password: password.value,
      })
      : await authRequest<{ sessionToken?: string; user: AuthUser }>('local/login', 'POST', {
        username: username.value.trim(), password: password.value,
      });
    acceptSession(result);
  } catch (exception) {
    error.value = exception instanceof Error ? exception.message : (registering.value ? '注册失败' : '登录失败');
  } finally { submitting.value = false; }
}

async function logout() {
  error.value = '';
  try {
    await authRequest<void>('logout', 'POST');
    setBrowserSession(null);
    expired();
  } catch (exception) { error.value = exception instanceof Error ? exception.message : '退出登录失败'; }
}
async function clearLocalSession() {
  try { await desktop?.clearSession(); await initialize(); }
  catch { error.value = '清理本机凭据失败，请检查用户目录权限。'; }
}
onMounted(initialize);
</script>

<template>
  <App v-if="user" :user="user" :window-maximized="windowMaximized" @profile="openProfile" />
  <div v-else class="app-shell">
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
    <main class="auth-screen">
      <section class="auth-card">
        <h1>一起开黑，一起看</h1>
        <p>登录 LycanSync，继续和朋友一起玩。</p>
        <p v-if="!ready">正在连接服务器…</p>
        <template v-else>
          <p v-if="setupRequired">首次使用：创建本服务器的管理员账号。</p>
          <p v-else-if="registering">创建此服务器的登录账号。</p>
          <p v-else>使用此服务器的账号登录。</p>
          <form @submit.prevent="submitCredentials">
            <label>用户名
              <input v-model="username" autocomplete="username" minlength="3" maxlength="32"
                pattern="[A-Za-z0-9_]{3,32}" required :disabled="submitting" />
            </label>
            <label>密码
              <input v-model="password" type="password" :autocomplete="registering ? 'new-password' : 'current-password'"
                minlength="6" maxlength="64" required :disabled="submitting" />
            </label>
            <label v-if="registering">确认密码
              <input v-model="passwordConfirmation" type="password" autocomplete="new-password"
                minlength="6" maxlength="64" required :disabled="submitting" />
            </label>
            <button class="confirm-button" :disabled="!canSubmit">
              {{ submitting ? (registering ? '正在创建账号…' : '正在登录…') : (registering ? '创建账号' : '登录') }}
            </button>
            <button v-if="initialized" type="button" :disabled="submitting" @click="toggleRegistrationMode">
              {{ registering ? '已有账号，返回登录' : '没有账号，创建账号' }}
            </button>
          </form>
          <button v-if="error" type="button" @click="initialize">重新检查</button>
          <button v-if="desktop && error" type="button" @click="clearLocalSession">清理本机登录凭据</button>
        </template>
        <p v-if="error" role="alert" class="auth-error">{{ error }}</p>
      </section>
    </main>
  </div>
  <ProfileDialog v-if="profileOpen && user" :user="user" :error="error"
    @close="profileOpen = false" @updated="user = $event" @logout="logout" />
</template>
