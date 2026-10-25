import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { RoomEvent, Track, type Participant, type Room } from 'livekit-client';

export interface ViewedShare {
  key: number;
  participant: Participant;
  session?: string;
  trackSid?: string;
  ended: boolean;
}

interface LayoutOptions {
  room(): Room | null;
  participants(): Participant[];
  revision(): number;
  status(): string;
  session(identity: string): string | undefined;
  privateControl(identity: string): string;
}

export function useScreenShareLayout(options: LayoutOptions) {
  const mode = ref<'collapsed' | 'focus' | 'grid'>('collapsed');
  const shares = shallowRef<ViewedShare[]>([]);
  const focused = ref<number | null>(null);
  const single = ref<number | null>(null);
  const membersVisible = ref(true);
  const height = ref<number | null>(null);
  let nextKey = 0;
  let reconnecting = false;
  let gridInitialized = false;
  const focusedShare = computed(() => shares.value.find(share => share.key === (single.value ?? focused.value)));
  const displayed = computed(() => single.value !== null || mode.value === 'focus'
    ? focusedShare.value ? [focusedShare.value] : [] : shares.value);

  function available(participant: Participant) {
    return participant.isScreenShareEnabled && !options.privateControl(participant.identity);
  }

  function include(participant: Participant) {
    const previous = shares.value.find(share => share.participant.identity === participant.identity && !share.ended);
    if (previous) return previous;
    const share: ViewedShare = { key: ++nextKey, participant, session: options.session(participant.identity),
      trackSid: participant.getTrackPublication(Track.Source.ScreenShare)?.trackSid, ended: false };
    shares.value = [...shares.value.filter(share => share.participant.identity !== participant.identity), share];
    return share;
  }

  function select(identity: string) {
    const participant = options.participants().find(participant => participant.identity === identity);
    if (options.status() !== 'connected' || !participant || !available(participant)) return false;
    focused.value = include(participant).key;
    single.value = null;
    mode.value = 'focus';
    return true;
  }

  function grid() {
    if (!gridInitialized) {
      options.participants().filter(available).forEach(include);
      gridInitialized = true;
    }
    single.value = null;
    mode.value = 'grid';
  }

  function remove(key: number) {
    shares.value = shares.value.filter(share => share.key !== key);
    if (single.value === key) single.value = null;
    if (focused.value === key) { focused.value = null; mode.value = shares.value.length ? 'grid' : 'collapsed'; }
    if (!shares.value.length) mode.value = 'collapsed';
  }

  function reset() {
    mode.value = 'collapsed'; shares.value = []; focused.value = null; single.value = null;
    membersVisible.value = true; height.value = null; reconnecting = false; gridInitialized = false;
  }

  function sync() {
    if (reconnecting || options.status() !== 'connected') return;
    for (const share of shares.value) {
      const participant = options.participants().find(participant => participant.identity === share.participant.identity);
      const session = options.session(share.participant.identity);
      const sid = participant?.getTrackPublication(Track.Source.ScreenShare)?.trackSid;
      // 已结束的位置只由用户重新选择，不能跟随同名用户的新共享。
      if (!participant || !available(participant) || share.session && session && share.session !== session
          || !share.session && share.trackSid && sid && share.trackSid !== sid) share.ended = true;
      if (participant) share.participant = participant;
    }
    shares.value = [...shares.value];
  }

  watch(options.room, (room, _, cleanup) => {
    reset();
    if (!room) return;
    const reconnected = () => { reconnecting = false; sync(); };
    room.on(RoomEvent.Reconnected, reconnected);
    cleanup(() => room.off(RoomEvent.Reconnected, reconnected));
  }, { immediate: true, flush: 'sync' });
  watch(options.status, status => { if (status === 'reconnecting') reconnecting = true; }, { flush: 'sync' });
  watch(options.revision, sync, { flush: 'sync' });
  onScopeDispose(reset);
  return { mode, shares, focused, focusedShare, single, displayed, membersVisible, height, select, grid, remove, reset };
}
