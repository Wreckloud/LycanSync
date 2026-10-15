<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { AppWindow, Fullscreen, GripVertical, HeadphoneOff, Headphones, Maximize2, MicOff, Minimize2, Monitor, X } from '@lucide/vue';
import { Track, VideoQuality, type Participant, type RemoteTrackPublication } from 'livekit-client';
import { AUDIO_VOLUME_MAX, AUDIO_VOLUME_STEP, normalizeAudioVolume } from '../rtc/audioPreferences';
import VoiceLevelMic from './VoiceLevelMic.vue';
import { observeLocalScreenPreview } from '../rtc/localScreenPreview';
import { observeScreenShareView } from '../rtc/screenShareViewing';
import { mapRemotePointerToScreen, RemoteInputPresses, remoteKeyFromCode, type RemoteControlInput } from '../rtc/remoteControl';

const props = withDefaults(defineProps<{
  participant: Participant;
  revision: number;
  isLocal: boolean;
  isListening: boolean | null;
  localMicrophoneEnabled?: boolean;
  avatar?: string;
  variant?: 'card' | 'viewer' | 'thumbnail';
  selected?: boolean;
  focused?: boolean;
  stageDraggable?: boolean;
  playbackVolume?: number;
  inputGain?: number;
  outputVolume?: number;
  remoteControlAvailable?: boolean;
  remoteControlPending?: boolean;
  remoteControlActive?: boolean;
  remoteControlName?: string;
  remoteControlUnavailable?: boolean;
}>(), { variant: 'card', selected: false, playbackVolume: 1, inputGain: 1, outputVolume: 1 });
const emit = defineEmits<{
  select: [];
  focus: [];
  remove: [];
  dragStart: [event: DragEvent];
  dragEnd: [];
  move: [offset: number];
  notice: [message: string];
  toggleAudio: [];
  volumeChange: [volume: number];
  inputGainChange: [volume: number];
  outputVolumeChange: [volume: number];
  toggleMicrophone: [];
  toggleListening: [];
  requestControl: [];
  cancelControl: [];
  stopControl: [];
  remoteInput: [input: RemoteControlInput];
}>();
const videoElement = ref<HTMLVideoElement | null>(null);
const cardElement = ref<HTMLElement | null>(null);
const windowFullscreen = ref(false);
const VOLUME_DRAGGER_WIDTH = 28;
const VOLUME_DRAGGER_HEIGHT = 104;
const VOLUME_DRAGGER_GAP = 6;
type VolumeDragKind = 'input' | 'remote';
type VolumeDragState = {
  kind: VolumeDragKind;
  pointerId: number;
  startY: number;
  startVolume: number;
  currentVolume: number;
  moved: boolean;
  left: number;
  top: number;
};
const volumeDrag = ref<VolumeDragState | null>(null);
let suppressVolumeClick = false;
const heldRemoteInputs = new RemoteInputPresses();

// SDK 实例不作深层代理；事件版本变化时重新读取轨道和展示字段。
const media = computed(() => {
  void props.revision;
  const publication = props.participant.getTrackPublication(Track.Source.ScreenShare);
  const microphone = props.isLocal ? props.localMicrophoneEnabled === true
    : props.isListening !== false && props.participant.isMicrophoneEnabled;
  return {
    publication,
    track: publication?.track,
    muted: publication?.isMuted,
    sharing: props.participant.isScreenShareEnabled,
    speaking: microphone && props.participant.isSpeaking,
    microphone,
    name: props.participant.name || props.participant.identity,
  };
});
const playbackPercent = computed(() => Math.round(props.playbackVolume * 100));
const inputGainPercent = computed(() => Math.round(props.inputGain * 100));
const outputVolumePercent = computed(() => Math.round(props.outputVolume * 100));
const volumeDragPercent = computed(() => Math.round((volumeDrag.value?.currentVolume ?? 0) * 100));
const volumeDragFill = computed(() => {
  const drag = volumeDrag.value;
  return drag ? `${drag.currentVolume / AUDIO_VOLUME_MAX * 100}%` : '0%';
});
const volumeDragStyle = computed(() => ({
  left: `${volumeDrag.value?.left ?? 0}px`,
  top: `${volumeDrag.value?.top ?? 0}px`,
}));
const volumeDragLabel = computed(() => volumeDrag.value?.kind === 'input' ? '麦克风输入音量' : `${media.value.name}接收音量`);
const remoteAudioLabel = computed(() => {
  if (!media.value.microphone) return `${media.value.name}麦克风已关闭`;
  if (props.playbackVolume === 0) return `${media.value.name}已取消收听，点击恢复收听`;
  const microphoneState = media.value.speaking ? '正在说话' : '麦克风已开启';
  return `${media.value.name}${microphoneState}，接收音量${playbackPercent.value}%，滚轮或按住上下拖动，点击取消收听`;
});
const selectable = computed(() => props.variant !== 'viewer' && media.value.sharing);
const fullscreenAvailable = document.fullscreenEnabled;

watch([videoElement, () => media.value.track, () => media.value.publication, () => props.isLocal], ([element, track, publication, isLocal], _, onCleanup) => {
  if (!element || !track) return;
  // 本地仅绑定采集轨道，远端由观看需求统一选择层；不创建第二份订阅。
  track.attach(element);
  const stopPreviewObservation = isLocal
    ? observeLocalScreenPreview(element, () => emit('notice', '本地共享预览无法播放，请重新打开观看画面。'))
    : undefined;
  const viewing = !isLocal && publication
    ? observeScreenShareView(publication as RemoteTrackPublication, element,
      props.variant === 'viewer' ? VideoQuality.HIGH : VideoQuality.LOW)
    : undefined;
  const stopQualityWatch = watch(() => props.variant, (variant) => {
    viewing?.setQuality(variant === 'viewer' ? VideoQuality.HIGH : VideoQuality.LOW);
  });
  // 只解除当前元素的绑定，其他主画面或缩略图仍可使用同一轨道。
  onCleanup(() => {
    stopPreviewObservation?.();
    stopQualityWatch();
    viewing?.stop();
    track.detach(element);
  });
}, { flush: 'post' });

async function openFullscreen() {
  const card = cardElement.value;
  if (!card?.requestFullscreen) {
    emit('notice', '当前浏览器不支持单路全屏观看。');
    return;
  }
  try {
    await card.requestFullscreen();
    if (!props.focused) emit('focus');
  } catch {
    emit('notice', '无法进入全屏，请再次点击或检查浏览器权限。');
  }
}

function toggleWindowFullscreen() {
  windowFullscreen.value = !windowFullscreen.value;
  if (windowFullscreen.value && !props.focused) emit('focus');
}

async function toggleFocusedView() {
  if (props.focused) {
    windowFullscreen.value = false;
    if (document.fullscreenElement === cardElement.value) {
      try { await document.exitFullscreen(); }
      catch { emit('notice', '无法退出全屏，请使用 Esc 后重试。'); return; }
    }
  }
  emit('focus');
}

function moveStageFromKeyboard(event: KeyboardEvent) {
  if (!props.stageDraggable || !event.altKey) return;
  const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -2, ArrowDown: 2 }[event.key];
  if (offset === undefined) return;
  event.preventDefault();
  event.stopPropagation();
  emit('move', offset);
}

function exitWindowFullscreen(event: KeyboardEvent) {
  if (!windowFullscreen.value || document.fullscreenElement || props.remoteControlActive) return;
  event.preventDefault();
  event.stopPropagation();
  windowFullscreen.value = false;
}

watch([() => props.variant, () => media.value.sharing, () => props.focused], ([variant, sharing, focused]) => {
  if (variant !== 'viewer' || !sharing || !focused) windowFullscreen.value = false;
});

function selectFromKeyboard(event: KeyboardEvent) {
  if (!selectable.value || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  emit('select');
}

function wheelVolume(event: WheelEvent, current: number) {
  if (event.deltaY === 0) return current;
  return current + (event.deltaY < 0 ? AUDIO_VOLUME_STEP : -AUDIO_VOLUME_STEP);
}

function adjustRemoteVolume(event: WheelEvent) {
  if (!media.value.microphone) return;
  emit('volumeChange', wheelVolume(event, props.playbackVolume));
}

function adjustInputGain(event: WheelEvent) {
  if (!media.value.microphone) return;
  emit('inputGainChange', wheelVolume(event, props.inputGain));
}

function adjustOutputVolume(event: WheelEvent) {
  if (props.isListening !== true) return;
  emit('outputVolumeChange', wheelVolume(event, props.outputVolume));
}

function beginVolumeDrag(event: PointerEvent, kind: VolumeDragKind, volume: number) {
  if (event.button !== 0 || !media.value.microphone) return;
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  volumeDrag.value = {
    kind,
    pointerId: event.pointerId,
    startY: event.clientY,
    startVolume: volume,
    currentVolume: volume,
    moved: false,
    left: Math.min(window.innerWidth - VOLUME_DRAGGER_WIDTH - 8,
      Math.max(8, bounds.left + bounds.width / 2 - VOLUME_DRAGGER_WIDTH / 2)),
    top: Math.max(8, bounds.top - VOLUME_DRAGGER_HEIGHT - VOLUME_DRAGGER_GAP),
  };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function moveVolumeDrag(event: PointerEvent) {
  const drag = volumeDrag.value;
  if (!drag || drag.pointerId !== event.pointerId) return;
  const distance = drag.startY - event.clientY;
  if (Math.abs(distance) >= 3) drag.moved = true;
  if (!drag.moved) return;
  const rawVolume = drag.startVolume + distance / 88 * AUDIO_VOLUME_MAX;
  const nextVolume = normalizeAudioVolume(rawVolume);
  if (nextVolume === drag.currentVolume) return;
  drag.currentVolume = nextVolume;
  if (drag.kind === 'input') emit('inputGainChange', nextVolume);
  else emit('volumeChange', nextVolume);
}

function endVolumeDrag(event: PointerEvent) {
  const drag = volumeDrag.value;
  if (!drag || drag.pointerId !== event.pointerId) return;
  if ((event.currentTarget as HTMLElement).hasPointerCapture(event.pointerId)) {
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  }
  volumeDrag.value = null;
  if (!drag.moved) return;
  suppressVolumeClick = true;
  setTimeout(() => { suppressVolumeClick = false; });
}

function toggleInputFromCard() {
  if (suppressVolumeClick) return;
  emit('toggleMicrophone');
}

function toggleRemoteAudioFromCard() {
  if (suppressVolumeClick) return;
  emit('toggleAudio');
}

function handleRemoteClick(event: MouseEvent) {
  if (props.remoteControlActive) { event.preventDefault(); event.stopPropagation(); return; }
  if (selectable.value) emit('select');
}

function sendRemotePointer(event: PointerEvent) {
  if (!props.remoteControlActive || !videoElement.value) return null;
  const bounds = videoElement.value.getBoundingClientRect();
  const mapped = mapRemotePointerToScreen(event.clientX, event.clientY, bounds,
    { width: videoElement.value.videoWidth, height: videoElement.value.videoHeight });
  if (mapped) emit('remoteInput', { kind: 'move', ...mapped });
  return mapped;
}

function remotePointerDown(event: PointerEvent) {
  if (!props.remoteControlActive) return;
  event.preventDefault();
  event.stopPropagation();
  (event.currentTarget as HTMLElement).focus();
  const mapped = sendRemotePointer(event);
  if (!mapped || (event.button !== 0 && event.button !== 2)) return;
  const button: 'left' | 'right' = event.button === 0 ? 'left' : 'right';
  heldRemoteInputs.pressButton(button, mapped.x, mapped.y).forEach((input) => emit('remoteInput', input));
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function remotePointerMove(event: PointerEvent) {
  if (!props.remoteControlActive) return;
  event.preventDefault();
  event.stopPropagation();
  const mapped = sendRemotePointer(event);
  if (mapped) heldRemoteInputs.moveButtons(mapped);
}

function remotePointerUp(event: PointerEvent) {
  if (!props.remoteControlActive) return;
  event.preventDefault();
  event.stopPropagation();
  const button = event.button === 0 ? 'left' : event.button === 2 ? 'right' : null;
  if (!button) return;
  const mapped = sendRemotePointer(event) ?? undefined;
  heldRemoteInputs.releaseButton(button, mapped).forEach((input) => emit('remoteInput', input));
}

function remoteWheel(event: WheelEvent) {
  if (!props.remoteControlActive) return;
  event.preventDefault();
  event.stopPropagation();
  emit('remoteInput', { kind: 'wheel', delta: Math.max(-1200, Math.min(1200, Math.round(-event.deltaY))) });
}

function remoteKey(event: KeyboardEvent, pressed: boolean) {
  if (!props.remoteControlActive) {
    if (pressed) selectFromKeyboard(event);
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (event.code === 'Escape' && pressed) { emit('stopControl'); return; }
  const key = remoteKeyFromCode(event.code);
  if (!key) return;
  const inputs = pressed ? heldRemoteInputs.pressKey(event.code, key) : heldRemoteInputs.releaseKey(event.code);
  inputs.forEach((input) => emit('remoteInput', input));
}

function releaseHeldRemoteInputs() {
  heldRemoteInputs.releaseAll().forEach((input) => emit('remoteInput', input));
}

watch(() => props.remoteControlActive, (active) => { if (!active) releaseHeldRemoteInputs(); });
onMounted(() => window.addEventListener('blur', releaseHeldRemoteInputs));
onBeforeUnmount(() => {
  window.removeEventListener('blur', releaseHeldRemoteInputs);
  releaseHeldRemoteInputs();
});
</script>

<template>
  <article ref="cardElement" class="participant-card" :class="[`is-${variant}`, { 'is-speaking': media.speaking, 'is-selected-viewer': selected, 'is-window-fullscreen': windowFullscreen }]"
    @keydown.esc="exitWindowFullscreen"
    :data-testid="variant === 'viewer' && media.sharing ? 'viewer-screen' : variant === 'thumbnail' ? 'member-thumbnail' : 'participant-card'">
    <div class="participant-media" :class="{ 'is-selectable': selectable, 'is-remote-control': remoteControlActive }"
      :role="selectable ? 'button' : undefined" :tabindex="remoteControlActive ? 0 : selectable ? 0 : undefined"
      :aria-label="selectable ? (selected ? '从主观看区移除' : '放大') + media.name + '的共享画面' : undefined"
      :data-select-hint="selectable ? selected ? '从主观看区移除' : '点击放大观看' : undefined"
      @click="handleRemoteClick" @dblclick="variant === 'viewer' && media.sharing && !remoteControlActive && toggleFocusedView()"
      @keydown="remoteKey($event, true)" @keyup="remoteKey($event, false)"
      @blur="releaseHeldRemoteInputs"
      @pointerdown="remotePointerDown" @pointermove="remotePointerMove" @pointerup="remotePointerUp"
      @pointercancel="releaseHeldRemoteInputs" @wheel="remoteWheel"
      @contextmenu="remoteControlActive && $event.preventDefault()">
      <template v-if="media.sharing">
        <div v-if="variant === 'thumbnail' && selected" class="selected-screen-preview" aria-hidden="true">
          <img v-if="avatar" :src="avatar" alt="" /><Monitor v-else :size="20" />
        </div>
        <template v-else>
          <video ref="videoElement" autoplay muted playsinline :aria-label="media.name + '的共享画面'" />
          <span v-if="!media.track || media.muted" class="video-placeholder">等待共享画面…</span>
        </template>
      </template>
      <div v-else class="large-avatar" aria-hidden="true">
        <img v-if="avatar" :src="avatar" alt="" />
        <template v-else>{{ media.name.slice(0, 1) }}</template>
      </div>
    </div>
    <div class="participant-meta">
      <strong>{{ media.name }}{{ isLocal ? '（你）' : '' }}</strong>
      <span v-if="variant === 'viewer' && media.sharing" class="viewer-actions">
        <button v-if="stageDraggable" type="button" class="viewer-action stage-drag-handle" draggable="true"
          :aria-label="'拖动排列' + media.name + '的共享画面'"
          aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
          @dragstart="emit('dragStart', $event)" @dragend="emit('dragEnd')" @keydown="moveStageFromKeyboard">
          <GripVertical :size="16" aria-hidden="true" />
        </button>
        <button type="button" class="viewer-action" :disabled="remoteControlActive"
          :aria-label="(focused ? '返回多人舞台' : '单路观看') + media.name + '的共享画面'" @click="toggleFocusedView">
          <Minimize2 v-if="focused" :size="16" aria-hidden="true" /><Maximize2 v-else :size="16" aria-hidden="true" />
        </button>
        <button type="button" class="viewer-action" :aria-label="'全屏观看' + media.name + '的共享画面'"
          data-viewer-tooltip="系统全屏"
          :disabled="!media.track || media.muted || !fullscreenAvailable" @click="openFullscreen"><Fullscreen :size="16" aria-hidden="true" /></button>
        <button type="button" class="viewer-action" :class="{ 'is-active': windowFullscreen }"
          :aria-label="(windowFullscreen ? '退出窗口全屏观看' : '窗口全屏观看') + media.name + '的共享画面'"
          :data-viewer-tooltip="windowFullscreen ? '退出窗口全屏' : '窗口全屏'"
          :disabled="!windowFullscreen && (!media.track || media.muted)" @click="toggleWindowFullscreen">
          <Minimize2 v-if="windowFullscreen" :size="16" aria-hidden="true" /><AppWindow v-else :size="16" aria-hidden="true" />
        </button>
        <button type="button" class="viewer-action" :disabled="remoteControlActive"
          :aria-label="'从舞台移出' + media.name + '的共享画面'" @click="emit('remove')"><X :size="16" aria-hidden="true" /></button>
      </span>
      <button v-if="media.sharing && !isLocal && remoteControlAvailable" type="button" class="viewer-action remote-control-action"
        :aria-label="remoteControlActive ? '退出远程控制' : remoteControlPending ? '取消远程控制申请' : '申请远程控制'"
        @click="remoteControlActive ? emit('stopControl') : remoteControlPending ? emit('cancelControl') : emit('requestControl')">
        {{ remoteControlActive ? '退出控制' : remoteControlPending ? '取消申请' : '申请控制' }}
      </button>
      <small v-if="media.sharing && !isLocal && remoteControlUnavailable" class="remote-control-status">窗口共享暂不支持远程控制</small>
      <small v-if="remoteControlActive" class="remote-control-status">正在控制 {{ remoteControlName || media.name }} · Esc 退出</small>
      <span v-if="isLocal" class="participant-volume-control" @wheel.stop.prevent="adjustInputGain">
        <button type="button" class="participant-state participant-state-button"
          :class="{ 'is-off': !media.microphone }"
          :aria-label="media.microphone ? `关闭自己的麦克风，输入音量${inputGainPercent}%，滚轮或按住上下拖动` : '开启自己的麦克风'"
          @pointerdown="beginVolumeDrag($event, 'input', inputGain)" @pointermove="moveVolumeDrag"
          @pointerup="endVolumeDrag" @pointercancel="endVolumeDrag" @click="toggleInputFromCard">
          <VoiceLevelMic v-if="media.microphone" :size="14" :level="media.speaking ? 1 : 0" :steps="1" /><MicOff v-else :size="14" />
        </button>
        <span v-if="media.microphone && volumeDrag?.kind !== 'input'" class="participant-volume-popover" aria-hidden="true">输入 {{ inputGainPercent }}%</span>
      </span>
      <span v-else class="participant-volume-control" @wheel.stop.prevent="adjustRemoteVolume">
        <button type="button" class="participant-state participant-state-button"
          :class="{ 'is-off': !media.microphone || playbackVolume === 0 }" :aria-label="remoteAudioLabel"
          :disabled="!media.microphone" @pointerdown="beginVolumeDrag($event, 'remote', playbackVolume)"
          @pointermove="moveVolumeDrag" @pointerup="endVolumeDrag" @pointercancel="endVolumeDrag" @click="toggleRemoteAudioFromCard">
          <VoiceLevelMic v-if="media.microphone && playbackVolume > 0" :size="14" :level="media.speaking ? 1 : 0" :steps="1" />
          <MicOff v-else :size="14" />
        </button>
        <span v-if="media.microphone && playbackVolume > 0 && volumeDrag?.kind !== 'remote'" class="participant-volume-popover" aria-hidden="true">接收 {{ playbackPercent }}%</span>
      </span>
      <span v-if="isLocal" class="participant-volume-control" @wheel.stop.prevent="adjustOutputVolume">
        <button type="button" class="participant-state participant-state-button"
          :class="{ 'is-off': isListening === false }"
          :aria-label="isListening ? `停止接收所有成员声音，LycanSync 总输出${outputVolumePercent}%，滚轮调整` : '恢复接收所有成员声音'"
          @click="emit('toggleListening')">
          <HeadphoneOff v-if="isListening === false" :size="14" /><Headphones v-else :size="14" />
        </button>
        <span v-if="isListening" class="participant-volume-popover" aria-hidden="true">输出 {{ outputVolumePercent }}%</span>
      </span>
      <span v-else class="participant-state" :class="{ 'is-off': isListening === false }"
        :aria-label="isListening === null ? '收听状态尚未同步' : isListening ? '正在接收声音' : '已停止接收声音'">
        <HeadphoneOff v-if="isListening === false" :size="14" /><Headphones v-else :size="14" />
      </span>
    </div>
  </article>
  <Teleport to="body">
    <Transition name="volume-dragger">
      <span v-if="volumeDrag" class="participant-volume-dragger" role="slider" :style="volumeDragStyle"
        :aria-label="volumeDragLabel" aria-orientation="vertical" aria-valuemin="0"
        :aria-valuemax="AUDIO_VOLUME_MAX * 100" :aria-valuenow="volumeDragPercent">
        <i class="participant-volume-track"><i :style="{ height: volumeDragFill }" /><em :style="{ bottom: volumeDragFill }" /></i>
      </span>
    </Transition>
  </Teleport>
</template>
