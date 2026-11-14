import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import { authRequest } from '../auth/authApi';
import { accessLinkStatus, type AccessLinkRecord } from '../auth/accountAccess';

export type MemberAccessMode = 'invite' | 'recovery' | 'links';
export type AccessLinkFilter = 'PENDING' | 'USED' | 'REVOKED' | 'ALL';
interface GeneratedLink { record: AccessLinkRecord; url: string | null }

export function useMemberAccess(active: Readonly<Ref<boolean>>, mode: MemberAccessMode) {
  const links = ref<AccessLinkRecord[]>([]);
  const offset = ref(0);
  const filter = ref<AccessLinkFilter>('PENDING');
  const note = ref('');
  const target = ref('');
  const generatedUrl = ref('');
  const generatedRecord = ref<AccessLinkRecord | null>(null);
  const error = ref('');
  const recordsError = ref('');
  const copyStatus = ref('');
  const busy = ref(false);
  const refreshing = ref(false);
  const copying = ref(false);
  const currentTime = ref(Date.now());
  const locked = computed(() => busy.value || copying.value);
  let controller = new AbortController();
  let listRequest: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  function current(request: AbortController) { return request === controller && !request.signal.aborted && active.value; }
  function visible() { return current(controller) && document.visibilityState === 'visible'; }
  function requestSignal(request: AbortController) { return AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]); }
  function message(exception: unknown) { return exception instanceof Error ? exception.message : '操作失败，请重试。'; }
  function scheduleRefresh() {
    clearTimeout(timer);
    if (!visible() || mode === 'recovery') return;
    const pending = links.value.some(link => accessLinkStatus(link, Date.now()) === '待使用');
    timer = setTimeout(() => { void refresh(); }, pending && !recordsError.value ? 5_000 : 30_000);
  }
  async function refresh() {
    if (!visible() || mode === 'recovery') return;
    clearTimeout(timer); listRequest?.abort();
    const request = new AbortController(); listRequest = request;
    refreshing.value = true; currentTime.value = Date.now();
    try {
      const query = new URLSearchParams({ offset: String(offset.value), status: mode === 'invite' ? 'PENDING' : filter.value });
      if (mode === 'invite') query.set('kind', 'INVITE');
      const records = await authRequest<AccessLinkRecord[]>(`access/links?${query}`, 'GET', undefined,
        AbortSignal.any([controller.signal, request.signal, AbortSignal.timeout(15_000)]));
      if (!request.signal.aborted && current(controller)) { links.value = records; recordsError.value = ''; currentTime.value = Date.now(); }
    } catch (exception) {
      if (!request.signal.aborted && current(controller)) recordsError.value = message(exception);
    } finally {
      if (!request.signal.aborted && current(controller)) { refreshing.value = false; scheduleRefresh(); }
    }
  }
  async function copyLink(id = generatedRecord.value?.id) {
    if (!id || !current(controller) || locked.value) return false;
    const request = controller;
    copying.value = true; error.value = ''; copyStatus.value = ''; clearTimeout(copyTimer);
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
      copyStatus.value = '已复制链接';
      copyTimer = setTimeout(() => { copyStatus.value = ''; }, 4_000);
      return true;
    } catch (exception) {
      if (current(request)) error.value = received
        ? '复制失败，请选择链接手动复制。' : message(exception);
      return false;
    } finally { if (current(request)) copying.value = false; }
  }
  async function generate(kind: 'INVITE' | 'RECOVERY', id?: string, reuse = false) {
    if (!current(controller) || locked.value || kind === 'RECOVERY' && !id && !target.value) return false;
    clearTimeout(timer); listRequest?.abort(); refreshing.value = false;
    const request = controller; busy.value = true; error.value = ''; copyStatus.value = '';
    let result: GeneratedLink | undefined;
    try {
      result = id
        ? await authRequest<GeneratedLink>(`access/links/${id}/renew`, 'POST', undefined, requestSignal(request))
        : reuse ? await authRequest<GeneratedLink>('access/links/invite', 'POST', undefined, requestSignal(request))
          : await authRequest<GeneratedLink>('access/links', 'POST', { kind, targetId: kind === 'RECOVERY' ? target.value : null, note: kind === 'INVITE' ? '' : note.value }, requestSignal(request));
      if (!current(request)) return false;
      generatedRecord.value = result.record; generatedUrl.value = result.url ?? '';
      offset.value = 0;
      if (mode === 'links') filter.value = 'PENDING';
    } catch (exception) { if (current(request)) error.value = message(exception); }
    finally { if (current(request)) busy.value = false; }
    if (!current(request)) return false;
    if (result) {
      if (result.url) await copyLink(result.record.id);
      else error.value = '这个旧链接无法再次复制，请在链接管理中重新生成。';
      await refresh();
    } else scheduleRefresh();
    return !!result;
  }
  async function revoke(id: string) {
    if (!current(controller) || locked.value) return false;
    clearTimeout(timer); listRequest?.abort(); refreshing.value = false;
    const request = controller; busy.value = true; error.value = '';
    let done = false;
    try {
      await authRequest(`access/links/${id}`, 'DELETE', undefined, requestSignal(request));
      if (!current(request)) return false;
      if (generatedRecord.value?.id === id) { generatedRecord.value = null; generatedUrl.value = ''; copyStatus.value = ''; }
      done = true;
    } catch (exception) { if (current(request)) error.value = message(exception); }
    finally { if (current(request)) busy.value = false; }
    if (done) await refresh();
    else scheduleRefresh();
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
  function page(direction: number) {
    if (locked.value || refreshing.value) return;
    offset.value = Math.max(0, offset.value + direction * 100); void refresh();
  }
  watch(filter, () => { offset.value = 0; links.value = []; void refresh(); }, { flush: 'sync' });
  function visibilityChanged() { if (visible()) void refresh(); else clearTimeout(timer); }
  watch(active, enabled => {
    controller.abort(); listRequest?.abort(); clearTimeout(timer); clearTimeout(copyTimer);
    busy.value = refreshing.value = copying.value = false;
    if (enabled) {
      controller = new AbortController();
      if (mode === 'invite') void generate('INVITE', undefined, true);
      else void refresh();
    }
  }, { immediate: true, flush: 'sync' });
  document.addEventListener('visibilitychange', visibilityChanged);
  onScopeDispose(() => {
    controller.abort(); listRequest?.abort(); clearTimeout(timer); clearTimeout(copyTimer);
    document.removeEventListener('visibilitychange', visibilityChanged);
  });
  return { links, offset, filter, note, target, generatedUrl, generatedRecord, error, recordsError, copyStatus,
    busy, refreshing, copying, locked, currentTime, refresh, generate, revoke, copyLink, saveNote, page };
}
