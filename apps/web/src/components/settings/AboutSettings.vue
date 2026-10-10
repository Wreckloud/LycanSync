<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Activity } from '@lucide/vue';
import type { UnwrapNestedRefs } from 'vue';
import type { Participant } from 'livekit-client';
import type { useRtcRoom } from '../../rtc/useRtcRoom';
import MediaDiagnostics from '../MediaDiagnostics.vue';
import packageInfo from '../../../package.json';

const props = defineProps<{ rtc: UnwrapNestedRefs<ReturnType<typeof useRtcRoom>>; active: boolean }>();
const diagnosticsOpen = ref(false);
const participants = computed(() => {
  void props.rtc.revision;
  return props.rtc.participants as Participant[];
});
const room = computed(() => props.rtc.room);
const hasActiveMedia = computed(() => {
  void props.rtc.revision;
  const currentRoom = room.value;
  if (!currentRoom) return false;
  const hasLocalMedia = currentRoom.localParticipant.isMicrophoneEnabled
    || currentRoom.localParticipant.isScreenShareEnabled;
  return hasLocalMedia || [...currentRoom.remoteParticipants.values()].some((participant) =>
    participant.isMicrophoneEnabled || participant.isScreenShareEnabled);
});

watch(room, (current) => { if (!current) diagnosticsOpen.value = false; });
watch(() => props.active, (active) => { if (!active) diagnosticsOpen.value = false; });
</script>

<template>
  <div class="settings-section about-settings">
    <section class="settings-block">
      <h2>LycanSync</h2>
      <dl><div><dt>版本</dt><dd>{{ packageInfo.version }} · 开发版</dd></div>
        <div><dt>媒体状态</dt><dd>{{ room ? rtc.status === 'connected' ? '已加入语音' : rtc.status : '未加入语音' }}</dd></div>
        <div><dt>活动媒体</dt><dd>{{ hasActiveMedia ? '存在' : '无' }}</dd></div></dl>
    </section>
    <section class="settings-block">
      <h2>媒体诊断</h2>
      <p>诊断默认关闭。查看时才读取媒体统计；视频探针需在面板内手动启动。</p>
      <p v-if="!room">当前未加入语音，没有活动房间可供诊断。</p>
      <button v-else type="button" class="settings-button" @click="diagnosticsOpen = !diagnosticsOpen">
        <Activity :size="15" />{{ diagnosticsOpen ? '关闭媒体诊断' : '查看媒体诊断' }}
      </button>
      <MediaDiagnostics v-if="diagnosticsOpen && room" :room="room" :participants="participants" />
    </section>
  </div>
</template>

<style scoped>
.about-settings { max-width: 860px; }
.about-settings dl { display: grid; gap: 0; margin: 0; }
.about-settings dl > div { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 12px; padding: 11px 0; border-top: 1px solid var(--border-soft); }
.about-settings dt { color: var(--muted); }
.about-settings dd { margin: 0; }
.about-settings :deep(.media-diagnostics) { position: static; width: 100%; max-height: none; padding: 0; overflow: visible; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
.settings-button { display: inline-flex; align-items: center; gap: 7px; min-height: 34px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 5px; background: var(--panel-raised); color: var(--text); cursor: pointer; }
</style>
