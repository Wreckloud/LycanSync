import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import { authRequest } from '../auth/authApi';
import { accessLinkStatus, type AccessLinkRecord } from '../auth/accountAccess';

export type MemberAccessMode = 'invite' | 'recovery' | 'links';
export type AccessLinkFilter = 'PENDING' | 'USED' | 'REVOKED' | 'ALL';
interface GeneratedLink { record: AccessLinkRecord; url: string | null }

export function useMemberAccess(active: Readonly<Ref<boolean>>, mode: MemberAccessMode, notice: (message: string) => void) {
  const links = ref<AccessLinkRecord[]>([]);
  const offset = ref(0);
  const filter = ref<AccessLinkFilter>('PENDING');
  const note = ref('');
  const target = ref('');
  const generatedUrl = ref('');
  const generatedRecord = ref<AccessLinkRecord | null>(null);
  const error = ref('');
  const recordsError = ref('');
  const invitationConfirmation = ref(false);
  const recordsLoaded = ref(false);
  const busy = ref(false);
  const refreshing = ref(false);
  const copying = ref(false);
  const currentTime = ref(Date.now());
  const locked = computed(() => busy.value || copying.value);
  let controller = new AbortController();
  let listRequest: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function current(request: AbortController) { return request === controller && !request.signal.aborted && active.value; }
  function visible() { return current(controller) && document.visibilityState === 'visible'; }
  function requestSignal(request: AbortController) { return AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]); }
  function message(exception: unknown) { return exception instanceof Error ? exception.message : '操作失败，请重试。'; }
  function scheduleRefresh() {
    clearTimeout(timer);
    if (!visible()) return;
    const pending = links.value.some(link => accessLinkStatus(link, Date.now()) === '待使用');
    timer = setTimeout(() => { void refresh(); }, pending && !recordsError.value ? 5_000 : 30_000);
  }
  async function refresh() {
    if (!visible()) return;
    clearTimeout(timer); listRequest?.abort();
    const request = new AbortController(); listRequest = request;
    refreshing.value = true; currentTime.value = Date.now();
    try {
      const records: AccessLinkRecord[] = [];
      let start = mode === 'recovery' ? 0 : offset.value;
      while (true) {
        const query = new URLSearchParams({ offset: String(start), status: mode === 'links' ? filter.value : 'PENDING' });
        if (mode !== 'links') query.set('kind', mode === 'invite' ? 'INVITE' : 'RECOVERY');
        const page = await authRequest<AccessLinkRecord[]>(`access/links?${query}`, 'GET', undefined,
          AbortSignal.any([controller.signal, request.signal, AbortSignal.timeout(15_000)]));
        if (request.signal.aborted || !current(controller)) return false;
        records.push(...page);
        if (mode !== 'recovery' || page.length < 100) break;
        start += page.length;
      }
      links.value = records; recordsError.value = ''; recordsLoaded.value = true; currentTime.value = Date.now();
      return true;
    } catch (exception) {
      if (!request.signal.aborted && current(controller)) recordsError.value = message(exception);
    } finally {
      if (!request.signal.aborted && current(controller)) { refreshing.value = false; scheduleRefresh(); }
    }
  }
  async function copyLink(id = generatedRecord.value?.id) {
    if (!id || !current(controller) || locked.value) return false;
    const request = controller;
    copying.value = true;
    try { return await readAndCopyLink(id, request); }
    finally { if (current(request)) copying.value = false; }
  }
  async function readAndCopyLink(id: string, request: AbortController) {
    error.value = '';
    generatedUrl.value = '';
    let received = false;
    try {
      // 每次读取都核对当前使用状态，不能把缓存中已撤销的链接重新发给朋友。
      const result = await authRequest<GeneratedLink>(`access/links/${id}/url`, 'GET', undefined, requestSignal(request));
      if (!current(request)) return false;
      generatedRecord.value = result.record; generatedUrl.value = result.url ?? '';
      if (!result.url) throw new Error('这个旧链接无法再次复制，请在链接管理中重新生成。');
      received = true;
      if (window.lycanDesktop) await window.lycanDesktop.copyText(result.url);
      else await navigator.clipboard.writeText(result.url);
      if (!current(request)) return false;
      notice(result.record.kind === 'RECOVERY' ? '恢复链接已复制。' : '邀请链接已复制。');
      return true;
    } catch (exception) {
      if (current(request)) error.value = received
        ? '复制失败，请选择链接手动复制。' : message(exception);
      return false;
    }
  }
  async function generate(kind: 'INVITE' | 'RECOVERY', id?: string) {
    if (!current(controller) || locked.value || kind === 'RECOVERY' && !id && !target.value) return false;
    clearTimeout(timer); listRequest?.abort(); refreshing.value = false;
    const request = controller; busy.value = true; error.value = '';
    let created = false;
    try {
      const result = id
        ? await authRequest<GeneratedLink>(`access/links/${id}/renew`, 'POST', undefined, requestSignal(request))
        : await authRequest<GeneratedLink>('access/links', 'POST', { kind, targetId: kind === 'RECOVERY' ? target.value : null, note: kind === 'INVITE' ? '' : note.value }, requestSignal(request));
      if (!current(request)) return false;
      created = true; generatedRecord.value = result.record; generatedUrl.value = result.url ?? '';
      invitationConfirmation.value = false;
      if (mode === 'recovery') links.value = [...links.value.filter(link => link.targetId !== result.record.targetId), result.record];
      offset.value = 0;
      if (mode === 'links') filter.value = 'PENDING';
      if (result.url) await readAndCopyLink(result.record.id, request);
      else error.value = '这个旧链接无法再次复制，请在链接管理中重新生成。';
      await refresh();
    } catch (exception) { if (current(request)) error.value = message(exception); }
    finally { if (current(request)) { busy.value = false; scheduleRefresh(); } }
    return current(request) && created;
  }
  async function revoke(id: string) {
    if (!current(controller) || locked.value) return false;
    clearTimeout(timer); listRequest?.abort(); refreshing.value = false;
    const request = controller; busy.value = true; error.value = '';
    let done = false;
    try {
      await authRequest(`access/links/${id}`, 'DELETE', undefined, requestSignal(request));
      if (!current(request)) return false;
      if (generatedRecord.value?.id === id) { generatedRecord.value = null; generatedUrl.value = ''; }
      done = true;
      await refresh();
    } catch (exception) { if (current(request)) error.value = message(exception); }
    finally { if (current(request)) { busy.value = false; scheduleRefresh(); } }
    return done;
  }
  async function saveNote(id: string, value: string) {
    if (!current(controller) || locked.value) return false;
    clearTimeout(timer); listRequest?.abort(); refreshing.value = false;
    const request = controller; busy.value = true; error.value = '';
    try {
      await authRequest(`access/links/${id}/note`, 'PUT', { note: value }, requestSignal(request));
      if (!current(request)) return false;
      links.value = links.value.map(link => link.id === id ? { ...link, note: value.trim() } : link);
      if (generatedRecord.value?.id === id) generatedRecord.value = { ...generatedRecord.value, note: value.trim() };
      return true;
    } catch (exception) { if (current(request)) error.value = message(exception); return false; }
    finally { if (current(request)) { busy.value = false; scheduleRefresh(); } }
  }
  async function prepareInvitation() {
    if (locked.value || refreshing.value) return;
    error.value = '';
    if (!await refresh()) return;
    invitationConfirmation.value = links.value.some(link => accessLinkStatus(link, Date.now()) === '待使用');
    if (!invitationConfirmation.value) await generate('INVITE');
  }
  function page(direction: number) {
    if (locked.value || refreshing.value) return;
    offset.value = Math.max(0, offset.value + direction * 100); void refresh();
  }
  watch(filter, () => { offset.value = 0; links.value = []; void refresh(); }, { flush: 'sync' });
  function visibilityChanged() { if (visible()) void refresh(); else clearTimeout(timer); }
  watch(active, enabled => {
    controller.abort(); listRequest?.abort(); clearTimeout(timer);
    busy.value = refreshing.value = copying.value = false;
    if (enabled) {
      controller = new AbortController();
      recordsLoaded.value = false;
      if (mode === 'invite') void prepareInvitation();
      else void refresh();
    }
  }, { immediate: true, flush: 'sync' });
  document.addEventListener('visibilitychange', visibilityChanged);
  onScopeDispose(() => {
    controller.abort(); listRequest?.abort(); clearTimeout(timer);
    document.removeEventListener('visibilitychange', visibilityChanged);
  });
  return { links, offset, filter, note, target, generatedUrl, generatedRecord, error, recordsError, invitationConfirmation, recordsLoaded,
    busy, refreshing, copying, locked, currentTime, refresh, prepareInvitation, generate, revoke, copyLink, saveNote, page };
}
