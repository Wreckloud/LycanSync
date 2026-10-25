<script setup lang="ts">
import '../viewing/callViewing.css';
import { computed, reactive, watch } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { AudioLines, Maximize2, Pin, PinOff } from '@lucide/vue';
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
const windows = useScreenShareWindows({
  room: () => props.rtc.room, participants: () => props.rtc.participants,
  status: () => props.rtc.status, revision: () => props.rtc.revision,
  shareSessionId: identity => props.rtc.remoteControlShares[identity]?.shareSessionId,
  controlSessionId: identity => props.rtc.remoteControlActive?.identity === identity ? props.rtc.remoteControlActive.controlSessionId : undefined,
  notice: message => emit('notice', message),
  closed: entry => {
    if (entry.kind !== 'control') return;
    if (props.rtc.remoteControlActive?.identity === entry.participant.identity
        && props.rtc.remoteControlActive.controlSessionId === entry.controlSessionId) void props.rtc.exitRemoteControl();
  },
});
const entries = windows.entries;
const watching = computed(() => entries.value.find(entry => entry.kind === 'watching'));
const controls = computed(() => entries.value.filter((entry): entry is ControlWindow => entry.kind === 'control'));
const count = computed(() => entries.value.length);
const sharingCount = computed(() => { void props.rtc.revision; return props.rtc.participants.filter(participant => participant.isScreenShareEnabled).length; });
const controlAvailable = (identity: string) => props.rtc.remoteControlAvailable[identity] === true;
const pinned = reactive({ enabled: false, busy: false });
let openedControlSession: string | undefined;

function controlVideoReady(identity: string) {
  const active = props.rtc.remoteControlActive;
  if (active?.identity !== identity) return true;
  return props.rtc.participants.find(participant => participant.identity === identity)
    ?.getTrackPublication(Track.Source.ScreenShare)?.trackSid === active.trackSid;
}

function select(identity: string) {
  if (!view.select(identity)) return false;
  if (watching.value) windows.openWatching();
  return true;
}

function returnWatching() {
  const mode = view.mode;
  windows.closeWatching();
  // 主动返回保留布局；直接关窗才收起观看区。
  view.mode = mode === 'collapsed' ? 'grid' : mode;
}

async function togglePinned() {
  const entry = watching.value;
  if (!entry?.window.lycanViewerWindow || pinned.busy) return;
  pinned.busy = true;
  try {
    const result = await entry.window.lycanViewerWindow.setPinned(!pinned.enabled);
    if (watching.value === entry) pinned.enabled = result.pinned;
  } catch { emit('notice', '未能确认观看窗口置顶，请重试。'); }
  finally { pinned.busy = false; }
}

async function fullscreen() {
  const entry = watching.value;
  if (!entry) return;
  try {
    if (entry.window.lycanViewerWindow) await entry.window.lycanViewerWindow.toggleFullscreen();
    else if (entry.window.document.fullscreenElement) await entry.window.document.exitFullscreen();
    else await entry.target?.requestFullscreen();
  } catch { emit('notice', '无法切换观看窗口全屏，请重试。'); }
}

watch(entries, (current, old, cleanup) => {
  const entry = current.find(entry => entry.kind === 'watching');
  const previous = old.find(entry => entry.kind === 'watching');
  if (entry?.id !== previous?.id) pinned.enabled = false;
  if (!entry) {
    if (previous) { view.single = null; view.mode = 'collapsed'; }
    return;
  }
  if (entry.target) entry.window.document.title = `${props.groupName} · 观看 · LycanSync`;
  const stop = entry.target ? entry.window.lycanViewerWindow?.onState(state => { pinned.enabled = state.pinned; }) : undefined;
  cleanup(() => stop?.());
}, { flush: 'sync' });
watch(() => [props.rtc.remoteControlActive, props.rtc.revision] as const, ([active]) => {
  if (!active) { openedControlSession = undefined; windows.closeControl(); return; }
  if (openedControlSession !== active.controlSessionId && controlVideoReady(active.identity)) {
    openedControlSession = active.controlSessionId;
    if (!windows.openControl(active.identity)) void props.rtc.exitRemoteControl();
  }
}, { flush: 'post' });
defineExpose({ select, closeAll: windows.closeAll, disarmAll: windows.disarmAll, count });
</script>

<template>
  <Teleport v-if="inlineTarget" :to="inlineTarget">
    <CallViewingPanel v-if="view.mode !== 'collapsed' && !watching" :view="view" :room="rtc.room" :revision="rtc.revision"
      :avatar="avatar" :listening="rtc.listening" :muted-shares="mutedShares" :control-available="controlAvailable"
      :private-control="controlPlaceholder" :reconnecting="rtc.status === 'reconnecting'"
      @detach="windows.openWatching()" @notice="emit('notice', $event)" @toggle-share-audio="emit('toggleShareAudio', $event)" @request-control="emit('requestControl', $event)">
      <HorizontalScroll label="语音成员"><div class="viewing-member-strip"><slot :select="select" /></div></HorizontalScroll>
    </CallViewingPanel>
    <template v-else>
      <header class="voice-heading"><span><AudioLines :size="15" />语音中</span>
        <small data-testid="member-count">{{ rtc.participants.length }} 人 · {{ sharingCount }} / 8 路共享</small>
        <button v-if="watching" type="button" @click="windows.openWatching()">唤回观看窗口</button>
        <button v-else-if="sharingCount" type="button" @click="view.grid()">展开网格</button>
      </header>
      <HorizontalScroll label="语音成员"><div class="viewing-member-strip"><slot :select="select" /></div></HorizontalScroll>
    </template>
  </Teleport>
  <Teleport v-if="watching?.target" :to="watching.target">
    <section class="watching-window" aria-label="多人观看窗口">
      <header class="viewer-toolbar">
        <span>{{ groupName }} · 观看</span>
        <button type="button" class="viewer-action" aria-label="返回主界面" @click="returnWatching">返回主界面</button>
        <button type="button" class="viewer-action" aria-label="观看窗口全屏" @click="fullscreen"><Maximize2 :size="16" /></button>
        <button v-if="watching.window.lycanViewerWindow" type="button" class="viewer-action" aria-label="观看窗口置顶" :aria-pressed="pinned.enabled" :disabled="pinned.busy" @click="togglePinned"><PinOff v-if="pinned.enabled" :size="16" /><Pin v-else :size="16" /></button>
      </header>
      <CallViewingPanel :view="view" :room="rtc.room" :revision="rtc.revision" :avatar="avatar" :listening="rtc.listening"
        :muted-shares="mutedShares" :control-available="controlAvailable" :private-control="controlPlaceholder"
        :reconnecting="rtc.status === 'reconnecting'" detached
        @notice="emit('notice', $event)" @toggle-share-audio="emit('toggleShareAudio', $event)" @request-control="emit('requestControl', $event)">
        <HorizontalScroll label="语音成员"><div class="viewing-member-strip"><slot :select="select" /></div></HorizontalScroll>
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
