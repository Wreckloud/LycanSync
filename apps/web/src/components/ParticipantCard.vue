<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Focus, Fullscreen, HeadphoneOff, Headphones, MicOff, Minimize2, Monitor, PictureInPicture2 } from '@lucide/vue';
import { Track, type Participant } from 'livekit-client';
import { AUDIO_VOLUME_MAX, AUDIO_VOLUME_STEP, normalizeAudioVolume } from '../rtc/audioPreferences';
import VoiceLevelMic from './VoiceLevelMic.vue';

const props = withDefaults(defineProps<{
  participant: Participant;
  revision: number;
  isLocal: boolean;
  isListening: boolean | null;
  avatar?: string;
  variant?: 'card' | 'viewer' | 'thumbnail';
  selected?: boolean;
  focused?: boolean;
  playbackVolume?: number;
  inputGain?: number;
  outputVolume?: number;
}>(), { variant: 'card', selected: false, focused: false, playbackVolume: 1, inputGain: 1, outputVolume: 1 });
const emit = defineEmits<{
  select: [];
  focus: [];
  notice: [message: string];
  toggleAudio: [];
  volumeChange: [volume: number];
  inputGainChange: [volume: number];
  outputVolumeChange: [volume: number];
  toggleMicrophone: [];
  toggleListening: [];
}>();
const videoElement = ref<HTMLVideoElement | null>(null);
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

// SDK 实例不作深层代理；事件版本变化时重新读取轨道和展示字段。
const media = computed(() => {
  void props.revision;
  const publication = props.participant.getTrackPublication(Track.Source.ScreenShare);
  return {
    track: publication?.track,
    muted: publication?.isMuted,
    sharing: props.participant.isScreenShareEnabled,
    speaking: props.participant.isSpeaking,
    microphone: props.participant.isMicrophoneEnabled,
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
const pictureInPictureAvailable = document.pictureInPictureEnabled
  && 'requestPictureInPicture' in HTMLVideoElement.prototype;

watch([videoElement, () => media.value.track], ([element, track], _, onCleanup) => {
  if (!element || !track) return;
  // 由 SDK 观察已绑定视频元素的尺寸和可见性，切换卡片／舞台／全屏时自动请求对应层。
  track.attach(element);
  // 只解除当前元素的绑定，其他主画面或缩略图仍可使用同一轨道。
  onCleanup(() => track.detach(element));
}, { flush: 'post' });

async function openFullscreen() {
  const video = videoElement.value;
  if (!video?.requestFullscreen) {
    emit('notice', '当前浏览器不支持单路全屏观看。');
    return;
  }
  try {
    await video.requestFullscreen();
  } catch {
    emit('notice', '无法进入全屏，请再次点击或检查浏览器权限。');
  }
}

async function openPictureInPicture() {
  const video = videoElement.value;
  if (!video?.requestPictureInPicture || !document.pictureInPictureEnabled) {
    emit('notice', '当前浏览器不支持画中画。');
    return;
  }
  try {
    await video.requestPictureInPicture();
  } catch {
    emit('notice', '画中画暂时无法打开，请等待共享画面开始播放后重试。');
  }
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
</script>

<template>
  <article class="participant-card" :class="[`is-${variant}`, { 'is-speaking': media.speaking, 'is-selected-viewer': selected }]"
    :data-testid="variant === 'viewer' && media.sharing ? 'viewer-screen' : variant === 'thumbnail' ? 'member-thumbnail' : 'participant-card'">
    <div class="participant-media" :class="{ 'is-selectable': selectable }"
      :role="selectable ? 'button' : undefined" :tabindex="selectable ? 0 : undefined"
      :aria-label="selectable ? (selected ? '从主观看区移除' : '放大') + media.name + '的共享画面' : undefined"
      :data-select-hint="selectable ? selected ? '从主观看区移除' : '点击放大观看' : undefined"
      @click="selectable && emit('select')" @dblclick="variant === 'viewer' && media.sharing && emit('focus')" @keydown="selectFromKeyboard">
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
      <strong :title="media.name">{{ media.name }}{{ isLocal ? '（你）' : '' }}</strong>
      <span v-if="variant === 'viewer' && media.sharing" class="viewer-actions">
        <button type="button" class="viewer-action" :class="{ 'is-active': focused }"
          :aria-label="(focused ? '退出专注观看' : '专注观看') + media.name + '的共享画面'"
          :data-tooltip="focused ? '退出专注' : '专注观看'" @click="emit('focus')">
          <Minimize2 v-if="focused" :size="16" aria-hidden="true" /><Focus v-else :size="16" aria-hidden="true" />
        </button>
        <button type="button" class="viewer-action" :aria-label="'全屏观看' + media.name + '的共享画面'"
          data-tooltip="全屏观看" :disabled="!media.track || media.muted || !fullscreenAvailable" @click="openFullscreen"><Fullscreen :size="16" aria-hidden="true" /></button>
        <button type="button" class="viewer-action" :aria-label="'画中画观看' + media.name + '的共享画面'"
          data-tooltip="画中画" :disabled="!media.track || media.muted || !pictureInPictureAvailable" @click="openPictureInPicture"><PictureInPicture2 :size="16" aria-hidden="true" /></button>
      </span>
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
