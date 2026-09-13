<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Focus, Fullscreen, HeadphoneOff, Headphones, Mic, MicOff, Minimize2, Monitor, PictureInPicture2 } from '@lucide/vue';
import { RemoteTrackPublication, Track, type Participant } from 'livekit-client';

const props = withDefaults(defineProps<{
  participant: Participant;
  revision: number;
  isLocal: boolean;
  isListening: boolean | null;
  avatar?: string;
  variant?: 'card' | 'viewer' | 'thumbnail';
  selected?: boolean;
  focused?: boolean;
}>(), { variant: 'card', selected: false, focused: false });
const emit = defineEmits<{ select: []; focus: []; notice: [message: string] }>();
const videoElement = ref<HTMLVideoElement | null>(null);
const mediaElement = ref<HTMLElement | null>(null);

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
const selectable = computed(() => props.variant !== 'viewer' && media.value.sharing);
const fullscreenAvailable = document.fullscreenEnabled;
const pictureInPictureAvailable = document.pictureInPictureEnabled
  && 'requestPictureInPicture' in HTMLVideoElement.prototype;

function requestRemoteQuality() {
  if (props.variant !== 'viewer' || !mediaElement.value || mediaElement.value.clientWidth < 1) return;
  const publication = props.participant.getTrackPublication(Track.Source.ScreenShare);
  if (!(publication instanceof RemoteTrackPublication)) return;

  // 普通舞台至少请求 720p，聚焦模式请求 1080p；缩略图仍交给自适应流选择低层。
  const density = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const minimum = props.focused ? { width: 1920, height: 1080 } : { width: 960, height: 540 };
  publication.setVideoDimensions({
    width: Math.min(1920, Math.max(minimum.width, Math.ceil(mediaElement.value.clientWidth * density))),
    height: Math.min(1080, Math.max(minimum.height, Math.ceil(mediaElement.value.clientHeight * density))),
  });
}

watch(mediaElement, (element, _, onCleanup) => {
  if (!element || props.variant !== 'viewer' || typeof ResizeObserver === 'undefined') return;
  const observer = new ResizeObserver(requestRemoteQuality);
  observer.observe(element);
  requestRemoteQuality();
  onCleanup(() => observer.disconnect());
}, { flush: 'post' });

watch([videoElement, () => media.value.track], ([element, track], _, onCleanup) => {
  if (!element || !track) return;
  track.attach(element);
  requestRemoteQuality();
  // 只解除当前元素的绑定，其他主画面或缩略图仍可使用同一轨道。
  onCleanup(() => track.detach(element));
}, { flush: 'post' });
watch(() => props.focused, requestRemoteQuality);

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
</script>

<template>
  <article class="participant-card" :class="[`is-${variant}`, { 'is-speaking': media.speaking, 'is-selected-viewer': selected }]"
    :data-testid="variant === 'viewer' && media.sharing ? 'viewer-screen' : variant === 'thumbnail' ? 'member-thumbnail' : 'participant-card'">
    <div ref="mediaElement" class="participant-media" :class="{ 'is-selectable': selectable }"
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
      <span class="participant-state" :class="{ 'is-off': !media.microphone }" :aria-label="media.microphone ? '麦克风已开启' : '麦克风已关闭'">
        <Mic v-if="media.microphone" :size="14" /><MicOff v-else :size="14" />
      </span>
      <span class="participant-state" :class="{ 'is-off': isListening === false }"
        :aria-label="isListening === null ? '收听状态尚未同步' : isListening ? '正在接收声音' : '已停止接收声音'">
        <HeadphoneOff v-if="isListening === false" :size="14" /><Headphones v-else :size="14" />
      </span>
    </div>
  </article>
</template>
