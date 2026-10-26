<script setup lang="ts">
import '../viewing/callViewing.css';
import { computed, reactive, watch } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { Track } from 'livekit-client';
import type { useRtcRoom } from '../rtc/useRtcRoom';
import { useScreenShareWindows, type ControlWindow } from '../viewing/useScreenShareWindows';
import { useScreenShareLayout } from '../viewing/useScreenShareLayout';
import ScreenShareViewer from './ScreenShareViewer.vue';
import CallViewingPanel from './CallViewingPanel.vue';
import HorizontalScroll from './HorizontalScroll.vue';

const props = defineProps<{
  rtc: UnwrapNestedRefs<ReturnType<typeof useRtcRoom>>;
  inlineTarget: HTMLElement | null;
  groupName: string;
  avatar: (identity: string) => string;
  inputBlocked: boolean;
  mutedShares: string[];
  controlPlaceholder: (identity: string) => string;
}>();
const emit = defineEmits<{ notice: [message: string]; toggleShareAudio: [identity: string]; requestControl: [identity: string] }>();
const view = reactive(useScreenShareLayout({
  room: () => props.rtc.room, participants: () => props.rtc.participants,
  revision: () => props.rtc.revision, status: () => props.rtc.status,
  session: identity => props.rtc.remoteControlShares[identity]?.shareSessionId,
  privateControl: identity => props.controlPlaceholder(identity),
}));
let beforeDetach: { id: string; room: typeof props.rtc.room; mode: typeof view.mode; focused: number | null;
  membersVisible: boolean; height: number | null; expanded: boolean } | undefined;
const windows = useScreenShareWindows({
  room: () => props.rtc.room, participants: () => props.rtc.participants,
  status: () => props.rtc.status, revision: () => props.rtc.revision,
  shareSessionId: identity => props.rtc.remoteControlShares[identity]?.shareSessionId,
  controlSessionId: identity => props.rtc.remoteControlActive?.identity === identity ? props.rtc.remoteControlActive.controlSessionId : undefined,
  notice: message => emit('notice', message),
  closed: entry => {
    if (entry.kind === 'watching') {
      if (!beforeDetach || beforeDetach.id !== entry.id) return;
      const previous = beforeDetach;
      beforeDetach = undefined;
      if (previous.room !== props.rtc.room) return;
      const valid = view.shares.length > 0 && (previous.mode === 'grid'
        || previous.mode === 'focus' && view.shares.some(share => share.key === previous.focused));
      if (!valid) { view.collapse(); return; }
      // 只恢复同一共享实例的布局，目标关闭、换源或撤权后不能接管新画面。
      view.focused = previous.focused;
      view.membersVisible = previous.membersVisible;
      view.height = previous.height;
      view.expanded = previous.expanded;
      view.mode = previous.mode;
      return;
    }
    if (props.rtc.remoteControlActive?.identity === entry.participant.identity
        && props.rtc.remoteControlActive.controlSessionId === entry.controlSessionId) void props.rtc.exitRemoteControl();
  },
});
const entries = windows.entries;
const watching = computed(() => entries.value.find(entry => entry.kind === 'watching'));
const controls = computed(() => entries.value.filter((entry): entry is ControlWindow => entry.kind === 'control'));
const count = computed(() => entries.value.length);
const controlAvailable = (identity: string) => props.rtc.remoteControlAvailable[identity] === true;
let openedControlSession: string | undefined;

function controlVideoReady(identity: string) {
  const active = props.rtc.remoteControlActive;
  if (active?.identity !== identity) return true;
  return props.rtc.participants.find(participant => participant.identity === identity)
    ?.getTrackPublication(Track.Source.ScreenShare)?.trackSid === active.trackSid;
}

function select(identity: string) {
  return watching.value ? windows.openWatching() : view.select(identity);
}

function detachWatching() {
  if (watching.value) { windows.openWatching(); return; }
  const previous = { room: props.rtc.room, mode: view.mode, focused: view.focused,
    membersVisible: view.membersVisible, height: view.height, expanded: view.expanded };
  if (windows.openWatching()) {
    const entry = entries.value.find(entry => entry.kind === 'watching');
    if (!entry) return;
    beforeDetach = { ...previous, id: entry.id };
    view.expanded = false;
  }
}

function returnWatching() {
  // 主动返回沿用观看窗当前布局，直接关窗恢复弹出前的主界面布局。
  beforeDetach = undefined;
  windows.closeWatching();
}

function closeAll() {
  beforeDetach = undefined;
  windows.closeAll();
}

watch(entries, (current) => {
  const entry = current.find(entry => entry.kind === 'watching');
  if (entry?.target) entry.window.document.title = `${props.groupName} · 观看 · LycanSync`;
}, { flush: 'sync' });
watch(() => view.mode, mode => { if (mode === 'collapsed') windows.closeWatching(); }, { flush: 'sync' });
watch(() => [props.rtc.remoteControlActive, props.rtc.revision] as const, ([active]) => {
  if (!active) { openedControlSession = undefined; windows.closeControl(); return; }
  if (openedControlSession !== active.controlSessionId && controlVideoReady(active.identity)) {
    openedControlSession = active.controlSessionId;
    if (!windows.openControl(active.identity)) void props.rtc.exitRemoteControl();
  }
}, { flush: 'post' });
defineExpose({ closeAll, disarmAll: windows.disarmAll, count });
</script>

<template>
  <Teleport v-if="inlineTarget" :to="inlineTarget">
    <CallViewingPanel v-if="view.mode !== 'collapsed' && !watching" :view="view" :room="rtc.room" :revision="rtc.revision"
      :avatar="avatar" :listening="rtc.listening"
      :private-control="controlPlaceholder" :reconnecting="rtc.status === 'reconnecting'"
      @detach="detachWatching" @notice="emit('notice', $event)">
      <HorizontalScroll label="语音成员"><div class="viewing-member-strip"><slot :select="select" /></div></HorizontalScroll>
    </CallViewingPanel>
    <template v-else>
      <HorizontalScroll label="语音成员"><div class="viewing-member-strip"><slot :select="select" /></div></HorizontalScroll>
    </template>
  </Teleport>
  <Teleport v-if="watching?.target" :to="watching.target">
    <section class="watching-window" aria-label="多人观看窗口">
      <CallViewingPanel :view="view" :room="rtc.room" :revision="rtc.revision" :avatar="avatar" :listening="rtc.listening"
        :private-control="controlPlaceholder"
        :reconnecting="rtc.status === 'reconnecting'" detached
        @return="returnWatching" @notice="emit('notice', $event)">
        <HorizontalScroll label="语音成员"><div class="viewing-member-strip"><slot :select="view.select" /></div></HorizontalScroll>
      </CallViewingPanel>
    </section>
  </Teleport>
  <template v-for="entry in controls" :key="entry.id">
    <Teleport v-if="entry.target" :to="entry.target">
      <ScreenShareViewer :entry="entry" :revision="rtc.revision" :group-name="groupName"
        :avatar="avatar(entry.participant.identity)" :is-local="entry.participant === rtc.room?.localParticipant"
        :ended="entry.ended" :reconnecting="rtc.status === 'reconnecting'"
        :input-blocked="inputBlocked || rtc.status !== 'connected' || !controlVideoReady(entry.participant.identity)"
        :control-available="controlAvailable(entry.participant.identity)" :private-control="controlPlaceholder(entry.participant.identity)"
        :control-pending="rtc.remoteControlPending?.identity === entry.participant.identity"
        :control-active="rtc.remoteControlActive?.identity === entry.participant.identity"
        :share-audio="Boolean(entry.participant.getTrackPublication(Track.Source.ScreenShareAudio)?.track)"
        :listening="rtc.listening" :share-muted="mutedShares.includes(entry.participant.identity)"
        @toggle-share-audio="emit('toggleShareAudio', entry.participant.identity)"
        @request-control="emit('requestControl', entry.participant.identity)"
        @cancel-control="rtc.cancelPendingRemoteControl(entry.participant.identity)" @stop-control="rtc.exitRemoteControl"
        @remote-input="rtc.sendRemoteControlInput" />
    </Teleport>
  </template>
</template>
