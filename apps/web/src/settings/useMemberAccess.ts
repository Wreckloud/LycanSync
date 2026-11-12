import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import { authRequest, type AuthUser } from '../auth/authApi';
import { accessLinkStatus, type AccessLinkRecord } from '../auth/accountAccess';

export type MemberAccessMode = 'invite' | 'recovery' | 'links';

export function useMemberAccess(active: Readonly<Ref<boolean>>, mode: MemberAccessMode) {
  const links = ref<AccessLinkRecord[]>([]);
  const members = ref<AuthUser[]>([]);
  const offset = ref(0);
  const memberOffset = ref(0);
  const search = ref('');
  const membersError = ref('');
  const loadingMembers = ref(false);
  const note = ref('');
  const target = ref('');
  const generatedUrl = ref('');
  const generatedRecord = ref<AccessLinkRecord | null>(null);
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
  let memberRequest: AbortController | undefined;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  function visible() { return active.value && !controller.signal.aborted && document.visibilityState === 'visible'; }
  function current(request: AbortController) { return request === controller && !request.signal.aborted; }
  function requestSignal(request: AbortController) { return AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]); }
  function message(exception: unknown) { return exception instanceof Error ? exception.message : '操作失败。'; }

  function scheduleRefresh() {
    clearTimeout(timer);
    if (!visible() || mode !== 'links') return;
    // 只轮询当前页记录；待使用链接保持及时，其余状态和网络失败降低请求频率。
    const pending = links.value.some((link) => accessLinkStatus(link, Date.now()) === '待使用');
    timer = setTimeout(() => { void refresh(); }, pending && !recordsError.value ? 5_000 : 30_000);
  }

  async function refresh() {
    if (!visible() || mode !== 'links' || locked.value) return;
    clearTimeout(timer);
    const request = controller;
    refreshing.value = true;
    // 过期由本地时间判断，读取失败也不能把已过期链接一直显示为待使用。
    currentTime.value = Date.now();
    try {
      const records = await authRequest<AccessLinkRecord[]>(`access/links?offset=${offset.value}`, 'GET', undefined, requestSignal(request));
      if (!current(request)) return;
      links.value = records;
      currentTime.value = Date.now();
      recordsError.value = '';
    } catch (exception) {
      if (current(request)) recordsError.value = message(exception);
    } finally {
      if (current(request)) {
        refreshing.value = false;
        scheduleRefresh();
      }
    }
  }

  async function loadMembers() {
    if (!visible() || mode !== 'recovery' || busy.value || generatedUrl.value) return;
    memberRequest?.abort();
    const request = new AbortController();
    memberRequest = request;
    loadingMembers.value = true;
    membersError.value = '';
    target.value = '';
    try {
      const query = new URLSearchParams({ offset: String(memberOffset.value), search: search.value.trim() });
      const result = await authRequest<AuthUser[]>(`access/members?${query}`, 'GET', undefined,
        AbortSignal.any([controller.signal, request.signal, AbortSignal.timeout(15_000)]));
      if (!request.signal.aborted && active.value) members.value = result;
    } catch (exception) {
      if (!request.signal.aborted && active.value) membersError.value = message(exception);
    } finally {
      if (!request.signal.aborted && active.value) loadingMembers.value = false;
    }
  }

  async function generate(kind: 'INVITE' | 'RECOVERY', id?: string) {
    if (!active.value || controller.signal.aborted || locked.value || (kind === 'RECOVERY' && !id && (!target.value || loadingMembers.value || membersError.value))) return;
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
      generatedRecord.value = result.record;
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
    if (!active.value || controller.signal.aborted || locked.value) return false;
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
        generatedRecord.value = null;
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
    return revoked;
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
    if (locked.value || memberPage && loadingMembers.value) return;
    if (memberPage) {
      memberOffset.value = Math.max(0, memberOffset.value + direction * 100);
      target.value = '';
      void loadMembers();
    } else {
      offset.value = Math.max(0, offset.value + direction * 100);
      void refresh();
    }
  }

  watch(search, () => {
    memberRequest?.abort();
    clearTimeout(searchTimer);
    memberOffset.value = 0;
    target.value = '';
    members.value = [];
    membersError.value = '';
    loadingMembers.value = true;
    searchTimer = setTimeout(() => { void loadMembers(); }, 250);
  }, { flush: 'sync' });

  function visibilityChanged() {
    clearTimeout(timer);
    if (visible()) {
      if (mode === 'recovery' && !generatedUrl.value) void loadMembers();
      else void refresh();
    }
  }
  watch(active, (enabled) => {
    controller.abort();
    memberRequest?.abort();
    clearTimeout(searchTimer);
    clearTimeout(timer);
    clearTimeout(copyTimer);
    busy.value = refreshing.value = copying.value = loadingMembers.value = false;
    if (enabled) {
      controller = new AbortController();
      if (mode === 'recovery') void loadMembers();
      else void refresh();
    }
  }, { immediate: true, flush: 'sync' });
  document.addEventListener('visibilitychange', visibilityChanged);
  onScopeDispose(() => {
    controller.abort();
    memberRequest?.abort();
    clearTimeout(searchTimer);
    clearTimeout(timer);
    clearTimeout(copyTimer);
    document.removeEventListener('visibilitychange', visibilityChanged);
  });

  return { links, members, offset, memberOffset, search, membersError, loadingMembers, note, target, generatedUrl, generatedRecord, inviteError, recoveryError, linkError,
    recordsError, copyStatus, busy, refreshing, copying, locked, currentTime, refresh, loadMembers, generate, revoke, copyLink, page };
}
