<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Fullscreen, HeadphoneOff, Headphones, Maximize2, MicOff, MousePointer2 } from '@lucide/vue';
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
  variant?: 'card' | 'viewer';
  inputBlocked?: boolean;
  shareAudio?: boolean;
  shareMuted?: boolean;
  shareAudioListening?: boolean;
  playbackVolume?: number;
  inputGain?: number;
  outputVolume?: number;
  remoteControlAvailable?: boolean;
  remoteControlPending?: boolean;
  remoteControlActive?: boolean;
  remoteControlName?: string;
  remoteControlUnavailable?: boolean;
}>(), { variant: 'card', playbackVolume: 1, inputGain: 1, outputVolume: 1 });
const emit = defineEmits<{
  select: [];
  toggleShareAudio: [];
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
const inputArmed = ref(false);
const ownerDocument = computed(() => cardElement.value?.ownerDocument);
const remoteInputAllowed = computed(() => props.variant === 'viewer' && props.remoteControlActive && !props.inputBlocked);
let ownerWindow: Window | null = null;
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
const fullscreenAvailable = computed(() => Boolean(ownerDocument.value?.fullscreenEnabled || ownerDocument.value?.defaultView?.lycanViewerWindow));

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
  try {
    releaseHeldRemoteInputs();
    const bridge = card?.ownerDocument.defaultView?.lycanViewerWindow;
    if (bridge) await bridge.toggleFullscreen();
    else if (card?.ownerDocument.fullscreenElement) await card.ownerDocument.exitFullscreen();
    else if (card?.requestFullscreen) await card.requestFullscreen();
    else emit('notice', '当前浏览器不支持单路全屏观看。');
  } catch { emit('notice', '无法切换全屏，请再次点击或检查浏览器权限。'); }
}

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
  const view = (event.currentTarget as HTMLElement).ownerDocument.defaultView;
  if (!view) return;
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  volumeDrag.value = {
    kind,
    pointerId: event.pointerId,
    startY: event.clientY,
    startVolume: volume,
    currentVolume: volume,
    moved: false,
    left: Math.min(view.innerWidth - VOLUME_DRAGGER_WIDTH - 8,
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
  if (remoteInputAllowed.value) { event.preventDefault(); event.stopPropagation(); return; }
  if (selectable.value) emit('select');
}

function sendRemotePointer(event: PointerEvent, activate = false) {
  if (!remoteInputAllowed.value || (!inputArmed.value && !activate) || !videoElement.value) return null;
  const bounds = videoElement.value.getBoundingClientRect();
  const mapped = mapRemotePointerToScreen(event.clientX, event.clientY, bounds,
    { width: videoElement.value.videoWidth, height: videoElement.value.videoHeight });
  if (mapped) {
    if (activate) inputArmed.value = true;
    emit('remoteInput', { kind: 'move', ...mapped });
  }
  return mapped;
}

function remotePointerDown(event: PointerEvent) {
  if (!remoteInputAllowed.value || (event.button !== 0 && event.button !== 2)) return;
  event.preventDefault();
  event.stopPropagation();
  const mapped = sendRemotePointer(event, true);
  if (!mapped) { releaseHeldRemoteInputs(); return; }
  (event.currentTarget as HTMLElement).focus();
  const button: 'left' | 'right' = event.button === 0 ? 'left' : 'right';
  heldRemoteInputs.pressButton(button, mapped.x, mapped.y).forEach((input) => emit('remoteInput', input));
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function remotePointerMove(event: PointerEvent) {
  if (!remoteInputAllowed.value || !inputArmed.value) return;
  event.preventDefault();
  event.stopPropagation();
  const mapped = sendRemotePointer(event);
  if (mapped) heldRemoteInputs.moveButtons(mapped);
}

function remotePointerUp(event: PointerEvent) {
  if (!remoteInputAllowed.value || !inputArmed.value) return;
  event.preventDefault();
  event.stopPropagation();
  const button = event.button === 0 ? 'left' : event.button === 2 ? 'right' : null;
  if (!button) return;
  const mapped = sendRemotePointer(event) ?? undefined;
  heldRemoteInputs.releaseButton(button, mapped).forEach((input) => emit('remoteInput', input));
}

function remoteWheel(event: WheelEvent) {
  if (!remoteInputAllowed.value || !inputArmed.value) return;
  event.preventDefault();
  event.stopPropagation();
  emit('remoteInput', { kind: 'wheel', delta: Math.max(-1200, Math.min(1200, Math.round(-event.deltaY))) });
}

function remoteKey(event: KeyboardEvent, pressed: boolean) {
  if (props.variant === 'viewer' && props.remoteControlActive && event.code === 'Escape' && pressed) {
    event.preventDefault(); event.stopPropagation(); emit('stopControl'); return;
  }
  if (!remoteInputAllowed.value || !inputArmed.value) {
    if (pressed && props.variant === 'card') selectFromKeyboard(event);
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const key = remoteKeyFromCode(event.code);
  if (!key) return;
  const inputs = pressed ? heldRemoteInputs.pressKey(event.code, key) : heldRemoteInputs.releaseKey(event.code);
  inputs.forEach((input) => emit('remoteInput', input));
}

function releaseHeldRemoteInputs() {
  inputArmed.value = false;
  heldRemoteInputs.releaseAll().forEach((input) => emit('remoteInput', input));
}

watch(remoteInputAllowed, (allowed) => { if (!allowed) releaseHeldRemoteInputs(); }, { flush: 'sync' });
onMounted(() => {
  ownerWindow = cardElement.value?.ownerDocument.defaultView ?? null;
  ownerWindow?.addEventListener('blur', releaseHeldRemoteInputs);
  ownerWindow?.addEventListener('lycan-viewer-disarm', releaseHeldRemoteInputs);
});
onBeforeUnmount(() => {
  ownerWindow?.removeEventListener('blur', releaseHeldRemoteInputs);
  ownerWindow?.removeEventListener('lycan-viewer-disarm', releaseHeldRemoteInputs);
  releaseHeldRemoteInputs();
});
</script>

<template>
  <article ref="cardElement" class="participant-card" :class="[`is-${variant}`, { 'is-speaking': variant === 'card' && media.speaking }]"
    :data-testid="variant === 'viewer' ? 'viewer-screen' : 'participant-card'">
    <div class="participant-media" :class="{ 'is-selectable': selectable, 'is-remote-control': remoteInputAllowed }"
      :role="selectable ? 'button' : undefined" :tabindex="remoteInputAllowed || selectable ? 0 : undefined"
      :aria-label="selectable ? '独立观看' + media.name + '的共享画面' : undefined"
      :data-select-hint="selectable ? '打开独立观看窗口' : undefined"
      @click="handleRemoteClick"
      @keydown="remoteKey($event, true)" @keyup="remoteKey($event, false)"
      @blur="releaseHeldRemoteInputs"
      @pointerdown="remotePointerDown" @pointermove="remotePointerMove" @pointerup="remotePointerUp"
      @pointercancel="releaseHeldRemoteInputs" @wheel="remoteWheel"
      @contextmenu="remoteControlActive && $event.preventDefault()">
      <template v-if="media.sharing">
        <video ref="videoElement" autoplay muted playsinline :aria-label="media.name + '的共享画面'" />
        <span v-if="!media.track || media.muted" class="video-placeholder">等待共享画面…</span>
      </template>
      <div v-else class="large-avatar" aria-hidden="true">
        <img v-if="avatar" :src="avatar" alt="" />
        <template v-else>{{ media.name.slice(0, 1) }}</template>
      </div>
    </div>
    <div class="participant-meta">
      <strong :title="media.name">{{ media.name }}{{ isLocal ? '（你）' : '' }}</strong>
      <button v-if="variant === 'viewer'" type="button" class="viewer-action"
        :aria-label="'切换全屏观看' + media.name + '的共享画面'" :disabled="!media.track || media.muted || !fullscreenAvailable"
        @click="openFullscreen"><Fullscreen :size="16" /></button>
      <button v-else-if="media.sharing" type="button" class="viewer-action"
        :aria-label="'打开' + media.name + '的独立观看窗口'" @click="emit('select')"><Maximize2 :size="16" /></button>
      <button v-if="variant === 'card' && media.sharing && !isLocal && shareAudio" type="button" class="viewer-action"
        :disabled="!shareAudioListening" :aria-label="shareMuted ? '恢复这路共享声音' : '静音这路共享声音'"
        :aria-pressed="shareMuted" @click="emit('toggleShareAudio')"><HeadphoneOff v-if="shareMuted || !shareAudioListening" :size="14" /><Headphones v-else :size="14" /></button>
      <button v-if="media.sharing && !isLocal && remoteControlAvailable" type="button" class="viewer-action remote-control-action"
        :class="{ 'is-control-shortcut': variant === 'card' }"
        :aria-label="remoteControlActive ? '退出远程控制' : remoteControlPending ? '取消远程控制申请' : '申请远程控制'"
        @click="remoteControlActive ? emit('stopControl') : remoteControlPending ? emit('cancelControl') : emit('requestControl')">
        <MousePointer2 v-if="variant === 'card'" :size="14" />
        <span v-else>{{ remoteControlActive ? '退出控制' : remoteControlPending ? '取消申请' : '申请控制' }}</span>
      </button>
      <small v-if="variant === 'viewer' && media.sharing && !isLocal && remoteControlUnavailable" class="remote-control-status">窗口共享暂不支持远程控制</small>
      <small v-if="variant === 'viewer' && remoteControlActive" class="remote-control-status">正在控制 {{ remoteControlName || media.name }} · {{ inputArmed ? 'Esc 退出' : '点击画面开始操作' }}</small>
      <span v-if="variant === 'card' && isLocal" class="participant-volume-control" @wheel.stop.prevent="adjustInputGain">
        <button type="button" class="participant-state participant-state-button"
          :class="{ 'is-off': !media.microphone }"
          :aria-label="media.microphone ? `关闭自己的麦克风，输入音量${inputGainPercent}%，滚轮或按住上下拖动` : '开启自己的麦克风'"
          @pointerdown="beginVolumeDrag($event, 'input', inputGain)" @pointermove="moveVolumeDrag"
          @pointerup="endVolumeDrag" @pointercancel="endVolumeDrag" @click="toggleInputFromCard">
          <VoiceLevelMic v-if="media.microphone" :size="14" :level="media.speaking ? 1 : 0" :steps="1" /><MicOff v-else :size="14" />
        </button>
        <span v-if="media.microphone && volumeDrag?.kind !== 'input'" class="participant-volume-popover" aria-hidden="true">输入 {{ inputGainPercent }}%</span>
      </span>
      <span v-else-if="variant === 'card'" class="participant-volume-control" @wheel.stop.prevent="adjustRemoteVolume">
        <button type="button" class="participant-state participant-state-button"
          :class="{ 'is-off': !media.microphone || playbackVolume === 0 }" :aria-label="remoteAudioLabel"
          :disabled="!media.microphone" @pointerdown="beginVolumeDrag($event, 'remote', playbackVolume)"
          @pointermove="moveVolumeDrag" @pointerup="endVolumeDrag" @pointercancel="endVolumeDrag" @click="toggleRemoteAudioFromCard">
          <VoiceLevelMic v-if="media.microphone && playbackVolume > 0" :size="14" :level="media.speaking ? 1 : 0" :steps="1" />
          <MicOff v-else :size="14" />
        </button>
        <span v-if="media.microphone && playbackVolume > 0 && volumeDrag?.kind !== 'remote'" class="participant-volume-popover" aria-hidden="true">接收 {{ playbackPercent }}%</span>
      </span>
      <span v-if="variant === 'card' && isLocal" class="participant-volume-control" @wheel.stop.prevent="adjustOutputVolume">
        <button type="button" class="participant-state participant-state-button"
          :class="{ 'is-off': isListening === false }"
          :aria-label="isListening ? `停止接收所有成员声音，LycanSync 总输出${outputVolumePercent}%，滚轮调整` : '恢复接收所有成员声音'"
          @click="emit('toggleListening')">
          <HeadphoneOff v-if="isListening === false" :size="14" /><Headphones v-else :size="14" />
        </button>
        <span v-if="isListening" class="participant-volume-popover" aria-hidden="true">输出 {{ outputVolumePercent }}%</span>
      </span>
      <span v-else-if="variant === 'card'" class="participant-state" :class="{ 'is-off': isListening === false }"
        :aria-label="isListening === null ? '收听状态尚未同步' : isListening ? '正在接收声音' : '已停止接收声音'">
        <HeadphoneOff v-if="isListening === false" :size="14" /><Headphones v-else :size="14" />
      </span>
    </div>
  </article>
  <Teleport v-if="ownerDocument" :to="ownerDocument.body">
    <Transition name="volume-dragger">
      <span v-if="volumeDrag" class="participant-volume-dragger" role="slider" :style="volumeDragStyle"
        :aria-label="volumeDragLabel" aria-orientation="vertical" aria-valuemin="0"
        :aria-valuemax="AUDIO_VOLUME_MAX * 100" :aria-valuenow="volumeDragPercent">
        <i class="participant-volume-track"><i :style="{ height: volumeDragFill }" /><em :style="{ bottom: volumeDragFill }" /></i>
      </span>
    </Transition>
  </Teleport>
</template>
