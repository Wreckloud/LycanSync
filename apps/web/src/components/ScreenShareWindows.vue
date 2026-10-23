<script setup lang="ts">
import { computed } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { Track } from 'livekit-client';
import type { useRtcRoom } from '../rtc/useRtcRoom';
import { useScreenShareWindows } from '../viewing/useScreenShareWindows';
import ScreenShareViewer from './ScreenShareViewer.vue';

const props = defineProps<{
  rtc: UnwrapNestedRefs<ReturnType<typeof useRtcRoom>>;
  groupName: string;
  avatar: (identity: string) => string;
  inputBlocked: boolean;
  mutedShares: string[];
}>();
const emit = defineEmits<{ notice: [message: string]; toggleShareAudio: [identity: string] }>();
const windows = useScreenShareWindows({
  room: () => props.rtc.room, participants: () => props.rtc.participants,
  status: () => props.rtc.status, revision: () => props.rtc.revision,
  shareSessionId: (identity) => props.rtc.remoteControlShares[identity]?.shareSessionId,
  notice: (message) => emit('notice', message),
  closed: (identity) => {
    if (props.rtc.remoteControlPending?.identity === identity) void props.rtc.cancelPendingRemoteControl(identity);
    if (props.rtc.remoteControlActive?.identity === identity) void props.rtc.exitRemoteControl();
  },
});
const entries = windows.entries;
const count = computed(() => entries.value.length);
defineExpose({ open: windows.open, closeAll: windows.closeAll, disarmAll: windows.disarmAll, count });
</script>

<template>
  <template v-for="entry in entries" :key="entry.id">
    <Teleport v-if="entry.target" :to="entry.target">
      <ScreenShareViewer :entry="entry" :revision="rtc.revision" :group-name="groupName"
        :avatar="avatar(entry.participant.identity)" :is-local="entry.participant === rtc.room?.localParticipant"
        :ended="entry.ended" :reconnecting="rtc.status === 'reconnecting'"
        :input-blocked="inputBlocked || rtc.status !== 'connected'"
        :control-available="rtc.remoteControlShares[entry.participant.identity]?.kind === 'monitor'"
        :control-unavailable="rtc.remoteControlShares[entry.participant.identity]?.kind === 'window'"
        :control-pending="rtc.remoteControlPending?.identity === entry.participant.identity"
        :control-active="rtc.remoteControlActive?.identity === entry.participant.identity"
        :share-audio="Boolean(entry.participant.getTrackPublication(Track.Source.ScreenShareAudio)?.track)"
        :listening="rtc.listening" :share-muted="mutedShares.includes(entry.participant.identity)"
        @toggle-share-audio="emit('toggleShareAudio', entry.participant.identity)"
        @request-control="rtc.requestRemoteControl(entry.participant.identity)"
        @cancel-control="rtc.cancelPendingRemoteControl(entry.participant.identity)" @stop-control="rtc.exitRemoteControl"
        @remote-input="rtc.sendRemoteControlInput" />
    </Teleport>
  </template>
</template>
