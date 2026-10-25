<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue';
import { Pin, PinOff, Volume2, VolumeX } from '@lucide/vue';
import type { ControlWindow } from '../viewing/useScreenShareWindows';
import type { RemoteControlInput } from '../rtc/remoteControl';
import ParticipantCard from './ParticipantCard.vue';

const props = defineProps<{
  entry: ControlWindow;
  revision: number;
  groupName: string;
  avatar: string;
  isLocal: boolean;
  ended: boolean;
  reconnecting: boolean;
  inputBlocked: boolean;
  controlAvailable: boolean;
  privateControl: string;
  controlPending: boolean;
  controlActive: boolean;
  shareAudio: boolean;
  listening: boolean;
  shareMuted: boolean;
}>();
const emit = defineEmits<{ requestControl: []; cancelControl: []; stopControl: [];
  remoteInput: [input: RemoteControlInput]; toggleShareAudio: [] }>();
const pinned = ref(false);
const pinBusy = ref(false);
const error = ref('');
const bridge = props.entry.window.lycanViewerWindow;
const name = computed(() => { void props.revision; return props.entry.participant.name || props.entry.participant.identity; });
let disposed = false;
let stopState: (() => void) | undefined;

async function togglePinned() {
  if (!bridge || pinBusy.value) return;
  pinBusy.value = true;
  error.value = '';
  try {
    const state = await bridge.setPinned(!pinned.value);
    if (!disposed) pinned.value = state.pinned;
  } catch { if (!disposed) error.value = '未能确认窗口置顶，请检查窗口状态后重试。'; }
  finally { if (!disposed) pinBusy.value = false; }
}

function escape() {
  if (props.controlActive) emit('stopControl');
  else void bridge?.exitFullscreen().catch(() => { if (!disposed) error.value = '无法退出全屏，请使用窗口控制重试。'; });
}

watch([name, () => props.groupName], () => {
  props.entry.window.document.title = `远程控制 · ${name.value} · LycanSync`;
}, { immediate: true });
onMounted(() => { stopState = bridge?.onState((state) => { pinned.value = state.pinned; }); });
onScopeDispose(() => { disposed = true; stopState?.(); });
</script>

<template>
  <section class="screen-share-viewer" :aria-label="name + '的远程控制窗口'" @keydown.esc.stop="escape">
    <header class="viewer-toolbar">
      <span>{{ groupName }}<small v-if="reconnecting">正在重连…</small></span>
      <button v-if="!isLocal && shareAudio && !ended" type="button" class="viewer-action"
        :disabled="!listening" :aria-label="shareMuted ? '恢复这路共享声音' : '静音这路共享声音'"
        :aria-pressed="shareMuted" @click="emit('toggleShareAudio')">
        <VolumeX v-if="shareMuted || !listening" :size="16" /><Volume2 v-else :size="16" />
      </button>
      <button v-if="bridge" type="button" class="viewer-action" :class="{ 'is-active': pinned }"
        :disabled="pinBusy" :aria-label="pinned ? '取消窗口置顶' : '窗口置顶'" :aria-pressed="pinned" @click="togglePinned">
        <PinOff v-if="pinned" :size="16" /><Pin v-else :size="16" />
      </button>
    </header>
    <p v-if="privateControl" class="viewer-ended" role="status">{{ privateControl }} · 画面未公开</p>
    <p v-else-if="ended" class="viewer-ended" role="status">共享已结束</p>
    <ParticipantCard v-else :participant="entry.participant" :revision="revision" :avatar="avatar"
      :is-local="isLocal" :is-listening="listening" variant="viewer" :input-blocked="inputBlocked"
      :remote-control-available="controlAvailable"
      :remote-control-active="controlActive" :remote-control-pending="controlPending"
      @request-control="emit('requestControl')" @cancel-control="emit('cancelControl')"
      @stop-control="emit('stopControl')" @remote-input="emit('remoteInput', $event)" @notice="error = $event" />
    <p class="viewer-feedback" role="status">{{ error }}</p>
  </section>
</template>
