<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { Columns2, Grid2X2, Maximize2, Minimize2, MousePointer2, Volume2, VolumeX, X } from '@lucide/vue';
import { Track, VideoQuality, type Room } from 'livekit-client';
import type { useScreenShareLayout, ViewedShare } from '../viewing/useScreenShareLayout';
import ParticipantCard from './ParticipantCard.vue';
import HorizontalScroll from './HorizontalScroll.vue';

const props = defineProps<{
  view: UnwrapNestedRefs<ReturnType<typeof useScreenShareLayout>>;
  room: Room | null;
  revision: number;
  avatar: (identity: string) => string;
  listening: boolean;
  mutedShares: string[];
  controlAvailable: (identity: string) => boolean;
  privateControl: (identity: string) => string;
  detached?: boolean;
  reconnecting: boolean;
}>();
const emit = defineEmits<{ detach: []; notice: [message: string]; toggleShareAudio: [identity: string]; requestControl: [identity: string] }>();
const panel = ref<HTMLElement | null>(null);
const width = ref(600);
const height = ref(300);
const ratios = ref<Record<number, number>>({});
const maximumHeight = ref(420);
let observer: ResizeObserver | undefined;
let stopFullscreen: (() => void) | undefined;
let stopResize: (() => void) | undefined;
let resizeStart: { pointer: number; y: number; height: number } | undefined;
let fullscreenGeneration = 0;
let disposed = false;
const focus = computed(() => props.view.single !== null || props.view.mode === 'focus');
const sizing = computed(() => {
  const maxHeight = Math.max(100, height.value - 38);
  const count = props.view.displayed.length;
  if (focus.value) {
    const share = props.view.displayed[0];
    const track = share?.participant.getTrackPublication(Track.Source.ScreenShare)?.track?.mediaStreamTrack;
    const settings = track?.getSettings();
    const ratio = share && ratios.value[share.key] || (settings?.width && settings.height ? settings.width / settings.height : 16 / 9);
    return { width: Math.min(width.value - 8, maxHeight * ratio), ratio, rows: 1 };
  }
  let fitted: { width: number; ratio: number; rows: number } | undefined;
  for (let rows = 1; rows <= Math.min(count, props.detached ? 3 : 2); rows++) {
    const columns = Math.ceil(count / rows);
    const tileWidth = Math.min((width.value - 8 * (columns - 1)) / columns,
      ((maxHeight - 8 * (rows - 1)) / rows - 38) * 16 / 9);
    if (tileWidth >= 210 && (!fitted || tileWidth > fitted.width)) fitted = { width: tileWidth, ratio: 16 / 9, rows };
  }
  if (fitted) return fitted;
  const rows = count > 2 && maxHeight >= 322 ? 2 : 1;
  return { width: Math.min(Math.max(210, (maxHeight / rows - 38) * 16 / 9), Math.max(180, width.value - 56)), ratio: 16 / 9, rows };
});
const quality = computed(() => focus.value || sizing.value.width >= 480 ? VideoQuality.HIGH : VideoQuality.LOW);

function ratio(share: ViewedShare) { return ratios.value[share.key] ?? 16 / 9; }

function tileStyle(share: ViewedShare) {
  const aspect = ratio(share);
  return { width: focus.value ? sizing.value.width + 'px' : sizing.value.width / (16 / 9) * aspect + 'px', '--tile-ratio': aspect };
}

function videoSize(key: number, size: { width: number; height: number }) {
  const aspect = size.width / size.height;
  if (ratios.value[key] !== aspect) ratios.value = { ...ratios.value, [key]: aspect };
}

function changeHeight(value: number) {
  props.view.height = Math.max(140, Math.min(maximumHeight.value, value));
  height.value = props.view.height;
}

function beginResize(event: PointerEvent) {
  resizeStart = { pointer: event.pointerId, y: event.clientY, height: height.value };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
}

function moveResize(event: PointerEvent) {
  if (resizeStart?.pointer === event.pointerId) changeHeight(resizeStart.height + event.clientY - resizeStart.y);
}

function endResize(event: PointerEvent) {
  if (resizeStart?.pointer !== event.pointerId) return;
  const element = event.currentTarget as HTMLElement;
  if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
  resizeStart = undefined;
}

async function singleFullscreen(share: ViewedShare) {
  const element = panel.value;
  if (!element) return;
  const generation = ++fullscreenGeneration;
  props.view.single = share.key;
  try {
    if (element.ownerDocument.fullscreenElement !== element) await element.requestFullscreen();
    if (!disposed && generation !== fullscreenGeneration && props.view.single === null
        && element.ownerDocument.fullscreenElement === element) await element.ownerDocument.exitFullscreen();
  } catch {
    if (!disposed && generation === fullscreenGeneration) {
      props.view.single = null; emit('notice', '无法进入单路全屏，请重试。');
    }
  }
}

async function leaveSingle() {
  const generation = ++fullscreenGeneration;
  const element = panel.value;
  props.view.single = null;
  if (!element || element.ownerDocument.fullscreenElement !== element) return;
  try { await element.ownerDocument.exitFullscreen(); }
  catch { if (!disposed && generation === fullscreenGeneration) emit('notice', '无法退出全屏，请使用 Esc 重试。'); }
}

function select(share: ViewedShare) {
  props.view.focused = share.key;
  props.view.single = null;
  props.view.mode = 'focus';
}

function escape(event: KeyboardEvent) {
  if (props.view.single !== null) void leaveSingle();
  else if (!props.detached) props.view.mode = 'collapsed';
  else return;
  event.stopPropagation();
}

watch(() => props.view.shares.map(share => share.key).join(','), () => {
  const keys = new Set(props.view.shares.map(share => String(share.key)));
  ratios.value = Object.fromEntries(Object.entries(ratios.value).filter(([key]) => keys.has(key)));
});

onMounted(() => {
  const element = panel.value!;
  const owner = element.ownerDocument.defaultView!;
  let frame: number | undefined;
  const resize = () => {
    width.value = element.clientWidth;
    const containerHeight = props.detached ? owner.innerHeight : element.closest('.group-main')?.clientHeight ?? owner.innerHeight;
    maximumHeight.value = Math.max(140, containerHeight - (props.view.membersVisible ? 480 : 340));
    height.value = element.ownerDocument.fullscreenElement === element ? owner.innerHeight - 72
      : Math.max(120, props.detached ? containerHeight - (props.view.membersVisible ? 330 : 130)
        : props.view.height !== null ? Math.min(maximumHeight.value, props.view.height)
          : Math.min(420, containerHeight * 0.6 - (props.view.membersVisible ? 200 : 60)));
  };
  observer = new owner.ResizeObserver(() => {
    if (frame !== undefined) return;
    frame = owner.requestAnimationFrame(() => { frame = undefined; resize(); });
  });
  stopResize = () => { if (frame !== undefined) owner.cancelAnimationFrame(frame); };
  observer.observe(element);
  observer.observe(element.ownerDocument.documentElement);
  const fullscreenChanged = () => { if (element.ownerDocument.fullscreenElement !== element) props.view.single = null; };
  element.ownerDocument.addEventListener('fullscreenchange', fullscreenChanged);
  stopFullscreen = () => element.ownerDocument.removeEventListener('fullscreenchange', fullscreenChanged);
});
onScopeDispose(() => { disposed = true; fullscreenGeneration++; observer?.disconnect(); stopFullscreen?.(); stopResize?.(); });
</script>

<template>
  <section ref="panel" class="call-viewing-panel" :class="{ 'is-detached': detached }" aria-label="共享观看区" @keydown.esc="escape">
    <header class="viewing-heading">
      <strong>{{ reconnecting ? '正在重连…' : '共享画面' }}</strong>
      <template v-if="view.single !== null">
        <button type="button" @click="leaveSingle"><Minimize2 :size="15" />返回原布局</button>
      </template>
      <template v-else>
        <button type="button" :aria-pressed="view.mode === 'focus'" :disabled="!view.focusedShare" @click="view.mode = 'focus'"><Columns2 :size="15" />聚焦</button>
        <button type="button" :aria-pressed="view.mode === 'grid'" @click="view.grid()"><Grid2X2 :size="15" />网格</button>
        <button v-if="!detached" type="button" @click="emit('detach')"><Maximize2 :size="15" />弹出观看区</button>
        <button v-if="!detached" type="button" @click="view.mode = 'collapsed'">收起</button>
      </template>
    </header>
    <p v-if="!view.displayed.length" class="viewing-empty">从成员预览选择要看的共享画面。</p>
    <HorizontalScroll v-else label="共享画面网格">
      <div class="viewing-grid" :class="{ 'is-focus': focus }" :style="{
        '--view-rows': sizing.rows,
      }">
        <div v-for="share in view.displayed" :key="share.key" class="viewing-tile" :style="tileStyle(share)">
          <div v-if="share.ended || privateControl(share.participant.identity)" class="viewing-ended" role="status">
            {{ privateControl(share.participant.identity) || '共享已结束' }}
          </div>
          <ParticipantCard v-else :participant="share.participant" :revision="revision" variant="viewer"
            :avatar="avatar(share.participant.identity)" :is-local="share.participant === room?.localParticipant"
            :is-listening="listening" :input-blocked="true" :show-fullscreen="false"
            :view-quality="quality" @video-size="videoSize(share.key, $event)"
            @notice="emit('notice', $event)" />
          <div class="viewing-actions">
            <span>{{ share.participant.name || share.participant.identity }}</span>
            <button v-if="!focus" type="button" :aria-label="'聚焦' + share.participant.name" @click="select(share)"><Maximize2 :size="14" /></button>
            <button v-if="focus && view.single === null" type="button" aria-label="单路全屏" @click="singleFullscreen(share)"><Maximize2 :size="14" /></button>
            <button v-if="!share.ended && share.participant !== room?.localParticipant && share.participant.getTrackPublication(Track.Source.ScreenShareAudio)?.track"
              type="button" :disabled="!listening" :aria-label="mutedShares.includes(share.participant.identity) ? '恢复这路共享声音' : '静音这路共享声音'"
              @click="emit('toggleShareAudio', share.participant.identity)">
              <VolumeX v-if="!listening || mutedShares.includes(share.participant.identity)" :size="14" /><Volume2 v-else :size="14" />
            </button>
            <button v-if="!share.ended && controlAvailable(share.participant.identity)" type="button" aria-label="申请远程控制"
              @click="emit('requestControl', share.participant.identity)"><MousePointer2 :size="14" /></button>
            <button type="button" aria-label="移出观看网格" @click="view.remove(share.key)"><X :size="14" /></button>
          </div>
        </div>
      </div>
    </HorizontalScroll>
    <div v-if="view.single === null" class="viewing-members-toggle"><button type="button" @click="view.membersVisible = !view.membersVisible">{{ view.membersVisible ? '收起成员' : '展开成员' }}</button></div>
    <slot v-if="view.membersVisible && view.single === null" />
    <div v-if="!detached && view.single === null" class="viewing-resize" role="separator" aria-label="调整观看区域高度"
      aria-orientation="horizontal" tabindex="0" :aria-valuenow="Math.round(height)" :aria-valuemin="140" :aria-valuemax="Math.round(maximumHeight)"
      @pointerdown="beginResize" @pointermove="moveResize" @pointerup="endResize" @pointercancel="endResize"
      @keydown.up.prevent="changeHeight(height - 20)" @keydown.down.prevent="changeHeight(height + 20)" />
  </section>
</template>
