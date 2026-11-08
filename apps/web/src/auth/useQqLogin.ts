import { onScopeDispose, ref } from 'vue';
import { authRequest, type AuthUser } from './authApi';

/** 系统浏览器负责 QQ 授权，原窗口持有一次性校验值；不轮询授权状态。 */
export function useQqLogin(onLogin: (user: AuthUser, newAccount: boolean) => Promise<void> | void, onBound: () => Promise<void> | void = () => {}) {
  const desktop = typeof window === 'undefined' ? undefined : window.lycanDesktop;
  const busy = ref(false);
  const error = ref('');
  const finishing = ref(false);
  let pending: { request: string; verifier: string; binding: boolean } | null = null;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function cancel() {
    if (finishing.value) return;
    generation++; pending = null; busy.value = false; clearTimeout(timer);
  }

  async function start(binding = false) {
    if (busy.value) return;
    if (!desktop?.openQqLogin || !desktop.onQqLogin) { error.value = '当前客户端不支持 QQ 登录，请使用支持 QQ 登录的 Windows 客户端。'; return; }
    busy.value = true;
    error.value = '';
    const attempt = ++generation;
    try {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const verifier = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
      const challenge = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
      const response = await authRequest<{ request: string; authorizationUrl: string }>('qq/start', 'POST', { challenge, desktop: true, binding });
      if (generation !== attempt) return;
      if (!/^[A-Za-z0-9_-]{43}$/.test(response.request)) throw new Error('暂时无法开始 QQ 登录。');
      pending = { request: response.request, verifier, binding };
      timer = setTimeout(() => { cancel(); error.value = '本次 QQ 登录未完成，请重新发起。'; }, 10 * 60_000);
      await desktop.openQqLogin(response.authorizationUrl);
    } catch (reason) {
      if (generation === attempt) { cancel(); error.value = reason instanceof Error ? reason.message : '无法开始 QQ 授权'; }
    }
  }

  const remove = desktop?.onQqLogin?.(async request => {
    if (!pending || pending.request !== request) return;
    const flow = pending;
    pending = null;
    finishing.value = true;
    clearTimeout(timer);
    const attempt = generation;
    try {
      if (flow.binding) {
        await authRequest('qq/binding/confirm', 'POST', { request, verifier: flow.verifier });
        if (generation === attempt) await onBound();
      } else {
        const result = await authRequest<{ user: AuthUser; newAccount: boolean }>('qq/exchange', 'POST', { request, verifier: flow.verifier });
        if (typeof result.newAccount !== 'boolean') throw new Error('QQ 身份确认未完成。');
        if (generation === attempt) await onLogin(result.user, result.newAccount);
      }
    } catch (reason) {
      if (generation === attempt) error.value = reason instanceof Error ? reason.message : '无法完成 QQ 授权';
    } finally { finishing.value = false; if (generation === attempt) busy.value = false; }
  });
  onScopeDispose(() => { generation++; pending = null; clearTimeout(timer); remove?.(); });
  return { busy, finishing, error, start, cancel };
}
