import { onScopeDispose, shallowRef, watch } from 'vue';
import { RoomEvent, Track, type Participant, type Room, type TrackPublication } from 'livekit-client';

export interface ScreenShareWindow {
  id: string;
  room: Room;
  participant: Participant;
  window: Window;
  target: HTMLElement | null;
  ended: boolean;
  shareSessionId?: string;
  timer?: ReturnType<typeof setTimeout>;
  stopPage?: () => void;
}

interface WindowOptions {
  room(): Room | null;
  participants(): Participant[];
  revision(): number;
  status(): string;
  shareSessionId(identity: string): string | undefined;
  notice(message: string): void;
  closed(identity: string): void;
}

export function useScreenShareWindows(options: WindowOptions, owner: Window = window) {
  const entries = shallowRef<ScreenShareWindow[]>([]);
  let disposed = false;
  let reconnecting = false;
  const refresh = () => { entries.value = [...entries.value]; };

  function close(entry: ScreenShareWindow, failed = false) {
    if (!entries.value.includes(entry)) return;
    entries.value = entries.value.filter((current) => current !== entry);
    clearTimeout(entry.timer);
    entry.stopPage?.();
    if (!entry.window.closed) entry.window.dispatchEvent(new Event('lycan-viewer-disarm'));
    options.closed(entry.participant.identity);
    if (!entry.window.closed) entry.window.close();
    if (failed && !disposed) options.notice('观看窗口未能正常打开或已失效，请重新打开。');
  }

  function closeAll() {
    // 只关闭登记过的旧窗口，不发异步“全部关闭”请求，避免迟到请求误关新房间窗口。
    for (const entry of [...entries.value]) close(entry);
  }

  function disarmAll() {
    for (const entry of entries.value) if (!entry.window.closed) entry.window.dispatchEvent(new Event('lycan-viewer-disarm'));
  }

  function syncSharing() {
    if (options.status() !== 'connected' || reconnecting) return;
    for (const entry of entries.value) {
      const current = options.participants().find((participant) => participant.identity === entry.participant.identity);
      if (!current) continue;
      const session = options.shareSessionId(current.identity);
      if (!current.isScreenShareEnabled || (entry.shareSessionId && session && session !== entry.shareSessionId)) entry.ended = true;
      if (!entry.shareSessionId) entry.shareSessionId = session;
      entry.participant = current;
    }
    refresh();
  }

  function open(identity: string) {
    const room = options.room();
    const participant = options.participants().find((candidate) => candidate.identity === identity);
    if (disposed || !room || !participant?.isScreenShareEnabled || options.status() !== 'connected') return false;
    const previous = entries.value.find((entry) => entry.room === room && entry.participant.identity === identity);
    if (previous && !previous.ended && !previous.window.closed) {
      if (owner.lycanDesktop) {
        void owner.lycanDesktop.focusViewerWindow(previous.id).catch(() => {
          if (entries.value.includes(previous)) close(previous, true);
        });
      } else previous.window.focus();
      return true;
    }
    if (previous) close(previous);
    const id = crypto.randomUUID();
    const child = owner.open(`/viewer.html#${id}`, `lycan-viewer-${id}`, 'popup,width=960,height=600');
    if (!child) { options.notice('观看窗口被阻止，请允许应用打开弹出窗口后重试。'); return false; }
    const entry: ScreenShareWindow = { id, room, participant, window: child, target: null, ended: false,
      shareSessionId: options.shareSessionId(identity) };
    entries.value = [...entries.value, entry];
    entry.timer = setTimeout(() => close(entry, true), 8000);
    return true;
  }

  function ready(event: MessageEvent) {
    if (disposed || event.origin !== owner.location.origin || event.data?.type !== 'lycan-viewer-ready') return;
    const entry = entries.value.find((candidate) => candidate.id === event.data.id && candidate.window === event.source);
    if (!entry || entry.target || entry.window.closed || entry.room !== options.room()) return;
    const target = entry.window.document.getElementById('viewer-root');
    if (!target) { close(entry, true); return; }
    clearTimeout(entry.timer);
    // 初始空白页也有 pagehide，只在固定观看文档就绪后登记销毁。
    const pageClosed = () => close(entry);
    entry.window.addEventListener('pagehide', pageClosed, { once: true });
    entry.stopPage = () => entry.window.removeEventListener('pagehide', pageClosed);
    entry.target = target;
    refresh();
  }

  owner.addEventListener('message', ready);
  const stopNativeClosed = owner.lycanDesktop?.onViewerClosed(({ id, failed }) => {
    const entry = entries.value.find((entry) => entry.id === id);
    if (entry) close(entry, failed);
  });
  watch(options.room, (room, _, onCleanup) => {
    closeAll();
    reconnecting = false;
    if (!room) return;
    const left = (participant: Participant) => {
      if (options.room() !== room) return;
      for (const entry of [...entries.value]) if (entry.participant.identity === participant.identity) close(entry);
    };
    const unpublished = (publication: TrackPublication) => {
      if (options.room() === room && publication.source === Track.Source.ScreenShare) syncSharing();
    };
    const reconnected = () => { if (options.room() === room) { reconnecting = false; syncSharing(); } };
    room.on(RoomEvent.ParticipantDisconnected, left);
    room.on(RoomEvent.TrackUnpublished, unpublished);
    room.on(RoomEvent.LocalTrackUnpublished, unpublished);
    room.on(RoomEvent.Reconnected, reconnected);
    onCleanup(() => {
      room.off(RoomEvent.ParticipantDisconnected, left);
      room.off(RoomEvent.TrackUnpublished, unpublished);
      room.off(RoomEvent.LocalTrackUnpublished, unpublished);
      room.off(RoomEvent.Reconnected, reconnected);
    });
  }, { flush: 'sync', immediate: true });
  watch(options.status, (status) => { if (status === 'reconnecting') reconnecting = true; }, { flush: 'sync' });
  watch(options.revision, syncSharing, { flush: 'sync' });
  onScopeDispose(() => {
    disposed = true;
    owner.removeEventListener('message', ready);
    stopNativeClosed?.();
    closeAll();
  });
  return { entries, open, closeAll, disarmAll };
}
