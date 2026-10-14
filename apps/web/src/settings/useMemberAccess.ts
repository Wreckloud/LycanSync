import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import { authRequest, type AuthUser } from '../auth/authApi';
import { accessLinkStatus, type AccessLinkRecord } from '../auth/accountAccess';

export function useMemberAccess(active: Readonly<Ref<boolean>>) {
  const links = ref<AccessLinkRecord[]>([]);
  const members = ref<AuthUser[]>([]);
  const offset = ref(0);
  const memberOffset = ref(0);
  const note = ref('');
  const target = ref('');
  const generatedUrl = ref('');
  const inviteError = ref('');
  const recoveryError = ref('');
  const linkError = ref('');
  const recordsError = ref('');
  const copyStatus = ref('');
  const busy = ref(false);
  const refreshing = ref(false);
  const copying = ref(false);
  const currentTime = ref(Date.now());
  const locked = computed(() => busy.value || refreshing.value);
  let controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let generatedId = '';
  let membersLoaded = false;

  function visible() { return active.value && !controller.signal.aborted && document.visibilityState === 'visible'; }
  function current(request: AbortController) { return request === controller && !request.signal.aborted; }
  function requestSignal(request: AbortController) { return AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]); }
  function message(exception: unknown) { return exception instanceof Error ? exception.message : '操作失败，请重试。'; }

  function scheduleRefresh() {
    clearTimeout(timer);
    if (!visible()) return;
    // 只轮询当前页记录；待使用链接保持及时，其余状态和网络失败降低请求频率。
    const pending = links.value.some((link) => accessLinkStatus(link, Date.now()) === '待使用');
    timer = setTimeout(() => { void refresh(); }, pending && !recordsError.value ? 5_000 : 30_000);
  }

  async function refresh(includeMembers = false) {
    if (!visible() || locked.value) return;
    clearTimeout(timer);
    const request = controller;
    refreshing.value = true;
    // 过期由本地时间判断，读取失败也不能把已过期链接一直显示为待使用。
    currentTime.value = Date.now();
    includeMembers ||= !membersLoaded;
    try {
      const [records, memberPage] = await Promise.all([
        authRequest<AccessLinkRecord[]>(`access/links?offset=${offset.value}`, 'GET', undefined, requestSignal(request)),
        includeMembers ? authRequest<AuthUser[]>(`access/members?offset=${memberOffset.value}`, 'GET', undefined, requestSignal(request)) : undefined,
      ]);
      if (!current(request)) return;
      links.value = records;
      currentTime.value = Date.now();
      recordsError.value = '';
      if (memberPage) {
        members.value = memberPage;
        membersLoaded = true;
        if (!memberPage.some((member) => member.id === target.value)) target.value = '';
      }
    } catch (exception) {
      if (current(request)) recordsError.value = message(exception);
    } finally {
      if (current(request)) {
        refreshing.value = false;
        scheduleRefresh();
      }
    }
  }

  async function generate(kind: 'INVITE' | 'RECOVERY', id?: string) {
    if (!active.value || controller.signal.aborted || locked.value || (kind === 'RECOVERY' && !target.value && !id)) return;
    clearTimeout(timer);
    const request = controller;
    const feedback = id ? recordsError : kind === 'INVITE' ? inviteError : recoveryError;
    busy.value = true;
    feedback.value = '';
    let generated = false;
    try {
      const result = id
        ? await authRequest<{ record: AccessLinkRecord; url: string }>(`access/links/${id}/renew`, 'POST', undefined, requestSignal(request))
        : await authRequest<{ record: AccessLinkRecord; url: string }>('access/links', 'POST', { kind, targetId: kind === 'RECOVERY' ? target.value : null, note: note.value }, requestSignal(request));
      if (!current(request)) return;
      generatedUrl.value = result.url;
      generatedId = result.record.id;
      clearTimeout(copyTimer);
      linkError.value = '';
      copyStatus.value = '';
      generated = true;
    } catch (exception) {
      if (current(request)) feedback.value = message(exception);
    } finally {
      if (current(request)) {
        busy.value = false;
        if (generated) await refresh();
        scheduleRefresh();
      }
    }
  }

  async function revoke(id: string) {
    if (!active.value || controller.signal.aborted || locked.value || !window.confirm('撤销后该链接立即失效，是否继续？')) return;
    clearTimeout(timer);
    const request = controller;
    busy.value = true;
    recordsError.value = '';
    let revoked = false;
    try {
      await authRequest<void>(`access/links/${id}`, 'DELETE', undefined, requestSignal(request));
      if (!current(request)) return;
      if (generatedId === id) {
        generatedUrl.value = '';
        generatedId = '';
        linkError.value = '';
        copyStatus.value = '';
      }
      revoked = true;
    } catch (exception) {
      if (current(request)) recordsError.value = message(exception);
    } finally {
      if (current(request)) {
        busy.value = false;
        if (revoked) await refresh();
        scheduleRefresh();
      }
    }
  }

  async function copyLink() {
    if (!active.value || controller.signal.aborted || !generatedUrl.value || copying.value) return false;
    const request = controller;
    const url = generatedUrl.value;
    copying.value = true;
    clearTimeout(copyTimer);
    linkError.value = '';
    copyStatus.value = '';
    try {
      if (window.lycanDesktop) await window.lycanDesktop.copyText(url);
      else await navigator.clipboard.writeText(url);
      if (!current(request) || generatedUrl.value !== url) return false;
      copyStatus.value = '已复制链接';
      copyTimer = setTimeout(() => { copyStatus.value = ''; }, 4_000);
      return true;
    } catch {
      if (current(request) && generatedUrl.value === url) linkError.value = '复制失败，请选择链接手动复制。';
      return false;
    } finally {
      if (current(request)) copying.value = false;
    }
  }

  function page(direction: number, memberPage = false) {
    if (locked.value) return;
    if (memberPage) {
      memberOffset.value = Math.max(0, memberOffset.value + direction * 100);
      target.value = '';
    } else offset.value = Math.max(0, offset.value + direction * 100);
    void refresh(memberPage);
  }

  function visibilityChanged() {
    clearTimeout(timer);
    if (visible()) void refresh();
  }
  watch(active, (enabled) => {
    controller.abort();
    clearTimeout(timer);
    clearTimeout(copyTimer);
    busy.value = refreshing.value = copying.value = false;
    if (enabled) {
      controller = new AbortController();
      membersLoaded = false;
      void refresh(true);
    }
  }, { immediate: true, flush: 'sync' });
  document.addEventListener('visibilitychange', visibilityChanged);
  onScopeDispose(() => {
    controller.abort();
    clearTimeout(timer);
    clearTimeout(copyTimer);
    document.removeEventListener('visibilitychange', visibilityChanged);
  });

  return { links, members, offset, memberOffset, note, target, generatedUrl, inviteError, recoveryError, linkError,
    recordsError, copyStatus, busy, refreshing, copying, locked, currentTime, refresh, generate, revoke, copyLink, page };
}
