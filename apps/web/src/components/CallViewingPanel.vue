<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { ArrowLeft, ChevronDown, ChevronUp, Fullscreen, Maximize2, X } from '@lucide/vue';
import { VideoQuality, type Room } from 'livekit-client';
import type { useScreenShareLayout, ViewedShare } from '../viewing/useScreenShareLayout';
import ParticipantCard from './ParticipantCard.vue';
import HorizontalScroll from './HorizontalScroll.vue';

const props = defineProps<{
  view: UnwrapNestedRefs<ReturnType<typeof useScreenShareLayout>>;
  room: Room | null;
  revision: number;
  avatar: (identity: string) => string;
  listening: boolean;
  privateControl: (identity: string) => string;
  detached?: boolean;
  reconnecting: boolean;
}>();
const emit = defineEmits<{ detach: []; return: []; notice: [message: string] }>();
const panel = ref<HTMLElement | null>(null);
const width = ref(600);
const height = ref(300);
const ratios = ref<Record<number, number>>({});
const maximumHeight = ref(420);
let observer: ResizeObserver | undefined;
let stopResize: (() => void) | undefined;
let clock: ReturnType<typeof setInterval> | undefined;
let resizeStart: { pointer: number; y: number; height: number } | undefined;
const now = ref(performance.now());
const focus = computed(() => props.view.mode === 'focus');
const showMembers = computed(() => focus.value && props.view.membersVisible && !props.view.expanded);
const sizing = computed(() => {
  const maxHeight = Math.max(100, height.value);
  const count = props.view.displayed.length;
  if (focus.value) return { width: width.value, ratio: 16 / 9, rows: 1 };
  let fitted: { width: number; ratio: number; rows: number } | undefined;
  for (let rows = 1; rows <= Math.min(count, props.detached ? 3 : 2); rows++) {
    const columns = Math.ceil(count / rows);
    const tileWidth = Math.min((width.value - 8 * (columns - 1)) / columns,
      (maxHeight - 8 * (rows - 1)) / rows * 16 / 9);
    if (tileWidth >= 210 && (!fitted || tileWidth > fitted.width)) fitted = { width: tileWidth, ratio: 16 / 9, rows };
  }
  if (fitted) return fitted;
  const rows = count > 2 && maxHeight >= 322 ? 2 : 1;
  return { width: Math.min(Math.max(210, maxHeight / rows * 16 / 9), Math.max(180, width.value - 56)), ratio: 16 / 9, rows };
});
const quality = computed(() => focus.value || sizing.value.width >= 480 ? VideoQuality.HIGH : VideoQuality.LOW);

function ratio(share: ViewedShare) { return ratios.value[share.key] ?? 16 / 9; }

function tileStyle(share: ViewedShare) {
  const aspect = ratio(share);
  return focus.value ? {} : { width: sizing.value.width / (16 / 9) * aspect + 'px', '--tile-ratio': aspect };
}

function elapsed(share: ViewedShare) {
  const seconds = Math.max(0, Math.floor((now.value - share.observedAt) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = String(Math.floor(seconds / 60) % 60).padStart(2, '0');
  return (hours ? hours + ':' : '') + minutes + ':' + String(seconds % 60).padStart(2, '0');
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

function toggleExpanded() {
  props.view.expanded = !props.view.expanded;
}

function expandMembers() {
  props.view.expanded = false;
  props.view.membersVisible = true;
}

function select(share: ViewedShare) {
  if (props.view.mode === 'focus') props.view.grid();
  else props.view.select(share.participant.identity);
}

function escape(event: KeyboardEvent) {
  if (props.view.expanded) props.view.expanded = false;
  else props.view.collapse();
  event.preventDefault();
  event.stopPropagation();
}

function trapFocus(event: KeyboardEvent) {
  if (!props.view.expanded || !panel.value) return;
  const elements = [...panel.value.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')]
    .filter(element => element.getClientRects().length > 0);
  const next = event.shiftKey ? elements.at(-1) : elements[0];
  const edge = event.shiftKey ? elements[0] : elements.at(-1);
  if (next && panel.value.ownerDocument.activeElement === edge) { next.focus(); event.preventDefault(); }
}

watch(() => props.view.shares.map(share => share.key).join(','), () => {
  const keys = new Set(props.view.shares.map(share => String(share.key)));
  ratios.value = Object.fromEntries(Object.entries(ratios.value).filter(([key]) => keys.has(key)));
});

onMounted(() => {
  const element = panel.value!;
  const viewport = element.querySelector<HTMLElement>('.viewing-stage .horizontal-viewport')!;
  const owner = element.ownerDocument.defaultView!;
  let frame: number | undefined;
  const resize = () => {
    // 滚动箭头也占宽度，按实际视口计算，避免单路仍溢出并保留箭头。
    width.value = viewport.clientWidth;
    const containerHeight = props.detached ? owner.innerHeight : element.closest('.group-main')?.clientHeight ?? owner.innerHeight;
    maximumHeight.value = Math.max(140, containerHeight - (showMembers.value ? 480 : 300));
    height.value = Math.max(120, props.view.expanded ? element.clientHeight
      : props.detached ? containerHeight - (showMembers.value ? 210 : 0)
        : props.view.height !== null ? Math.min(maximumHeight.value, props.view.height)
          : Math.min(480, containerHeight * 0.6 - (showMembers.value ? 160 : 0)));
  };
  observer = new owner.ResizeObserver(() => {
    if (frame !== undefined) return;
    frame = owner.requestAnimationFrame(() => { frame = undefined; resize(); });
  });
  // 网格与聚焦的外框可能等高，成员显隐仍需重新分配画面高度。
  const stopMembers = watch(() => [showMembers.value, props.view.expanded], resize, { flush: 'post' });
  stopResize = () => { stopMembers(); if (frame !== undefined) owner.cancelAnimationFrame(frame); };
  observer.observe(element);
  observer.observe(viewport);
  observer.observe(element.ownerDocument.documentElement);
  resize();
  clock = setInterval(() => { now.value = performance.now(); }, 1000);
});
onScopeDispose(() => { observer?.disconnect(); stopResize?.(); if (clock) clearInterval(clock); });
</script>

<template>
  <section ref="panel" class="call-viewing-panel" :class="{ 'is-detached': detached, 'is-expanded': view.expanded }"
    aria-label="共享观看区" @keydown.esc="escape" @keydown.tab="trapFocus">
    <div class="viewing-stage" :class="{ 'is-focus-stage': focus }" :style="{ height: height + 'px' }">
      <span v-if="reconnecting" class="viewing-reconnecting" role="status">正在重连…</span>
      <HorizontalScroll label="共享画面网格">
        <div class="viewing-grid" :class="{ 'is-focus': focus }" :style="{ '--view-rows': sizing.rows }">
          <div v-for="share in view.displayed" :key="share.key" class="viewing-tile" :style="tileStyle(share)">
            <div class="viewing-surface" role="button" tabindex="0"
              :aria-label="focus ? '查看全部共享画面' : '聚焦' + share.participant.name"
              @click="select(share)" @keydown.enter.self.prevent="select(share)" @keydown.space.self.prevent="select(share)">
              <ParticipantCard :participant="share.participant" :revision="revision" variant="viewer"
                :avatar="avatar(share.participant.identity)" :is-local="share.participant === room?.localParticipant"
                :is-listening="listening" :input-blocked="true" :show-fullscreen="false"
                :private-control="privateControl(share.participant.identity)" :view-quality="quality"
                @video-size="videoSize(share.key, $event)" @notice="emit('notice', $event)" />
            </div>
            <div class="viewing-actions">
              <span class="viewing-caption" :title="share.participant.name"><span>{{ share.participant.name || share.participant.identity }}</span>
                <time title="本客户端观察到的本次共享时长">{{ elapsed(share) }}</time>
              </span>
              <button v-if="focus && (!view.membersVisible || view.expanded)" type="button" class="viewing-expand-members"
                aria-label="展开成员" title="展开成员" @click="expandMembers"><ChevronDown :size="16" /></button>
              <div class="viewing-action-buttons">
                <button type="button" :aria-label="view.expanded ? '恢复观看布局' : '占满窗口'"
                  :title="view.expanded ? '恢复观看布局' : '占满窗口'" :aria-pressed="view.expanded" @click="toggleExpanded"><Fullscreen :size="15" /></button>
                <button type="button" :aria-label="detached ? '返回主界面' : '弹出观看区'" :title="detached ? '返回主界面' : '弹出观看区'"
                  @click="detached ? emit('return') : emit('detach')"><ArrowLeft v-if="detached" :size="15" /><Maximize2 v-else :size="15" /></button>
                <button type="button" aria-label="退出观看" title="退出观看" @click="view.collapse()"><X :size="15" /></button>
              </div>
            </div>
          </div>
        </div>
      </HorizontalScroll>
      <div v-if="!detached && !view.expanded" class="viewing-resize" role="separator" aria-label="调整观看区域高度"
        aria-orientation="horizontal" tabindex="0" :aria-valuenow="Math.round(height)" :aria-valuemin="140" :aria-valuemax="Math.round(maximumHeight)"
        @pointerdown="beginResize" @pointermove="moveResize" @pointerup="endResize" @pointercancel="endResize"
        @keydown.up.prevent="changeHeight(height - 20)" @keydown.down.prevent="changeHeight(height + 20)" />
    </div>
    <div v-if="showMembers" class="viewing-members-panel">
      <div class="viewing-members-toggle">
        <button type="button" aria-label="收起成员" title="收起成员" :aria-expanded="true" @click="view.membersVisible = false"><ChevronUp :size="16" /></button>
      </div>
      <slot />
    </div>
  </section>
</template>
