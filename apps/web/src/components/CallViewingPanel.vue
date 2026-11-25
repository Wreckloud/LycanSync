<script setup lang="ts">
import { motionDurationMs } from '../styles/motion';
import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import type { MediaDiagnosticsSnapshot } from '../diagnostics/mediaDiagnostics';
import { ArrowLeft, ChevronDown, ExternalLink, Grid2X2, Focus, Maximize, Minimize, X } from '@lucide/vue';
import { VideoQuality, type Room } from 'livekit-client';
import type { useScreenShareLayout, ViewedShare } from '../viewing/useScreenShareLayout';
import { useViewingSize } from '../viewing/useViewingSize';
import ParticipantCard from './ParticipantCard.vue';
import ConnectionSignal from './ConnectionSignal.vue';
import ViewingConnectionStatus from './ViewingConnectionStatus.vue';
import HorizontalScroll from './HorizontalScroll.vue';
import { observeWindowLayoutRestore } from '../viewing/windowLayoutRestore';

const props = withDefaults(defineProps<{
  view: UnwrapNestedRefs<ReturnType<typeof useScreenShareLayout>>;
  room: Room | null;
  revision: number;
  recordingElapsed?: string;
  snapshot?: MediaDiagnosticsSnapshot | null;
  avatar: (identity: string) => string;
  listening: boolean;
  privateControl: (identity: string) => string;
  active?: boolean;
  videoActive?: boolean;
  detached?: boolean;
  hidden?: boolean;
  folded?: boolean;
  stageHidden?: boolean;
  reconnecting: boolean;
}>(), { active: true, videoActive: true });
const emit = defineEmits<{ detach: []; return: []; 'update:folded': [folded: boolean]; 'update:stageHidden': [hidden: boolean]; notice: [message: string] }>();
const panel = ref<HTMLElement | null>(null);
const ratios = ref<Record<number, number>>({});
const framing = ref(false);
let panelAnimation: Animation | undefined;
let contentAnimations: Animation[] = [];
let panelGeneration = 0;
let motionPreference: MediaQueryList | undefined;
let stopWindowRestore: (() => void) | undefined;
function stopPanelMotion() {
  panelAnimation?.cancel();
  panelAnimation = undefined;
  for (const animation of contentAnimations) animation.cancel();
  contentAnimations = [];
  framing.value = false;
}
function reducePanelMotion() {
  if (motionPreference?.matches) stopPanelMotion();
}
let clock: ReturnType<typeof setInterval> | undefined;
const now = ref(performance.now());
const focus = computed(() => props.view.mode === 'focus');
const singleStage = computed(() => props.view.displayed.length === 1 && (props.detached || props.view.expanded));
const showMembers = computed(() => !props.folded && !props.hidden && (!props.active || focus.value && props.view.membersVisible && !props.view.expanded));
const { width, height, minimumHeight, maximumHeight, changeHeight } = useViewingSize(panel, {
  active: () => props.active,
  detached: () => Boolean(props.detached), expanded: () => props.view.expanded,
  showMembers: () => showMembers.value, preferredHeight: () => props.view.height,
  setHeight: value => { props.view.height = value; },
});
const dragHeight = ref<number | null>(null);
const memberBlend = ref(0);
const stageHeight = computed(() => dragHeight.value ?? height.value);
const foldAction = computed(() => {
  if (props.folded) return { label: '展开成员卡片', direction: 'down' };
  if (props.active) return { label: '收起共享画面', direction: 'up' };
  if (props.stageHidden || props.view.shares.length) return { label: '展开共享画面', direction: 'down' };
  return { label: '向上拖动收起成员卡片', direction: undefined };
});
const resizing = ref(false);
const foldHint = ref<'up' | 'down' | 'flat'>();
let foldIdleTimer: ReturnType<typeof setTimeout> | undefined;
let settleFrame = 0;
defineExpose({ resizing, memberBlend });
// 一次手势始终使用同一个屏幕坐标系，吸附和越界都不重设指针原点。
let drag: { id: number; startY: number; pointerY: number; hintY: number; offset: number; baseY: number | null; membersY: number | null; snap: 'min' | 'max' | null;
  folded: boolean; stageHidden: boolean; upward: boolean } | undefined;
let moved = false;
let membersOnlyHeight = 0;
watch(() => props.active, active => {
  if (!active) return;
  // 画面展开前记住纯成员条的自然高度。网格隐藏后手柄会停在这里。
  const members = panel.value?.querySelector<HTMLElement>('.viewing-members-panel');
  if (members?.offsetHeight) membersOnlyHeight = members.offsetHeight;
}, { flush: 'pre' });

function stopMemberSettle() {
  if (settleFrame) cancelAnimationFrame(settleFrame);
  settleFrame = 0;
}
function startPull(event: PointerEvent) {
  if (!event.isPrimary || event.button !== 0 || drag) return;
  stopMemberSettle();
  const handle = event.currentTarget as HTMLElement;
  const offset = event.clientY - handle.getBoundingClientRect().top;
  drag = { id: event.pointerId, startY: event.clientY, pointerY: event.clientY, hintY: event.clientY, offset, baseY: null, membersY: null,
    snap: null, folded: !!props.folded, stageHidden: !!props.stageHidden, upward: false };
  moved = false;
  handle.setPointerCapture(event.pointerId);
}
function movePull(event: PointerEvent) {
  if (!drag || drag.id !== event.pointerId) return;
  drag.pointerY = event.clientY;
  const delta = event.clientY - drag.hintY;
  if (Math.abs(delta) >= 4) {
    drag.hintY = event.clientY;
    drag.upward = delta < 0;
    foldHint.value = delta < 0 ? 'up' : 'down';
    clearTimeout(foldIdleTimer);
    foldIdleTimer = setTimeout(() => { foldHint.value = 'flat'; }, 180);
  }
  if (resizing.value && moved) {
    resizeToPointer(drag.pointerY);
    return;
  }
  const distance = event.clientY - drag.startY;
  if (Math.abs(distance) < 5) return;
  moved = true;
  if (drag.folded || props.view.mode === 'collapsed') return;
  if (drag.stageHidden && distance < 16) return;
  panelGeneration++;
  stopPanelMotion();
  resizing.value = true;
  if (props.stageHidden) {
    if ((!focus.value || !props.view.membersVisible) && membersOnlyHeight) {
      dragHeight.value = membersOnlyHeight;
      memberBlend.value = 1;
    }
    emit('update:stageHidden', false);
  }
  const current = drag;
  const handle = event.currentTarget as HTMLElement;
  // 先取消过渡并展开正在拖动的布局，再按实际顶边校准一次抓点。
  void nextTick(() => {
    if (drag !== current) return;
    const stage = panel.value!.querySelector<HTMLElement>('.viewing-stage')!;
    const conversation = handle.closest('.group-main')?.querySelector('.group-conversation');
    current.baseY = handle.getBoundingClientRect().top + current.offset - stage.getBoundingClientRect().height;
    if (conversation && membersOnlyHeight) {
      current.membersY = conversation.getBoundingClientRect().top + membersOnlyHeight + current.offset;
    }
    resizeToPointer(current.pointerY);
  });
}
function resizeToPointer(y: number) {
  if (!drag || drag.baseY === null) return;
  const desired = y - drag.baseY;
  const min = minimumHeight.value, max = maximumHeight.value;
  const maxBand = Math.min(24, (max - min) / 4);
  const hideAt = drag.membersY === null ? min - 24 : Math.min(max - maxBand - 32, drag.membersY - drag.baseY + 4);
  if (membersOnlyHeight && (!focus.value || !props.view.membersVisible) && desired < hideAt + 48) {
    // 在同一块空间交接舞台与成员条，松手前保留原视频节点。
    memberBlend.value = Math.min(1, (hideAt + 48 - desired) / 48);
    drag.snap = desired <= hideAt ? 'min' : null;
    const memberEdge = drag.membersY === null ? membersOnlyHeight : drag.membersY - drag.baseY;
    dragHeight.value = drag.snap === 'min' ? memberEdge : Math.max(memberEdge, desired);
    return;
  }
  memberBlend.value = 0;
  if (desired <= hideAt || drag.snap === 'min' && desired < hideAt + 16) {
    drag.snap = 'min';
    dragHeight.value = 0;
    if (!props.stageHidden) emit('update:stageHidden', true);
    return;
  }
  if (props.stageHidden) emit('update:stageHidden', false);
  if (desired >= max - maxBand || drag.snap === 'max' && desired >= max - maxBand - 12) {
    drag.snap = 'max';
    dragHeight.value = max;
  } else {
    drag.snap = null;
    dragHeight.value = Math.max(min, Math.min(max, desired));
  }
}
async function finishPull(event: PointerEvent) {
  if (!drag || drag.id !== event.pointerId) return;
  if (moved && !resizing.value && (drag.folded || drag.stageHidden || props.view.mode === 'collapsed')) {
    const distance = event.clientY - drag.startY;
    if (Math.abs(distance) >= 16) {
      if (distance < 0) emit('update:folded', true);
      else expandNext();
    }
  } else if (moved) movePull(event);
  const settledAtMembers = drag.snap === 'min' || moved && drag.upward && memberBlend.value > 0;
  if (drag.snap === 'max') {
    changeHeight(maximumHeight.value);
    props.view.height = 'max';
    if (drag.baseY !== null && event.clientY - drag.baseY >= maximumHeight.value + 96) props.view.expanded = true;
  } else if (moved && !settledAtMembers && dragHeight.value !== null) changeHeight(dragHeight.value);
  const memberEdge = drag.membersY !== null && drag.baseY !== null ? drag.membersY - drag.baseY : membersOnlyHeight;
  drag = undefined;
  clearTimeout(foldIdleTimer);
  foldHint.value = moved ? 'flat' : undefined;
  // 交接区内松手时，从当前透明度和高度继续收拢，避免先闪回完整画面。
  if (settledAtMembers && memberBlend.value > 0 && memberBlend.value < 1 && dragHeight.value !== null) {
    const startHeight = dragHeight.value, startBlend = memberBlend.value;
    const duration = motionDurationMs(getComputedStyle(panel.value!).getPropertyValue('--motion-feedback-duration'));
    if (duration > 0 && !motionPreference?.matches) {
      const start = performance.now();
      const advance = (now: number) => {
        const remaining = Math.max(0, 1 - Math.max(0, now - start) / duration) ** 2;
        dragHeight.value = memberEdge + (startHeight - memberEdge) * remaining;
        memberBlend.value = 1 - (1 - startBlend) * remaining;
        if (remaining > 0) settleFrame = requestAnimationFrame(advance);
        else void endResize(true);
      };
      settleFrame = requestAnimationFrame(advance);
      return;
    }
  }
  await endResize(settledAtMembers);
}
async function endResize(settledAtMembers: boolean) {
  settleFrame = 0;
  if (settledAtMembers) emit('update:stageHidden', true);
  memberBlend.value = 0;
  dragHeight.value = null;
  await nextTick();
  if (!drag) resizing.value = false;
}
function cancelPull(restore = false) {
  stopMemberSettle();
  clearTimeout(foldIdleTimer);
  if (drag) {
    foldHint.value = 'flat';
    moved = true;
    if (restore) {
      emit('update:folded', drag.folded);
      emit('update:stageHidden', drag.stageHidden);
    }
  }
  drag = undefined;
  memberBlend.value = 0;
  dragHeight.value = null;
  resizing.value = false;
}
function expandNext() {
  if (props.folded) emit('update:folded', false);
  else if (props.stageHidden) emit('update:stageHidden', false);
  else if (props.view.shares[0]) props.view.select(props.view.shares[0].participant.identity);
}
function clickHandle(event: MouseEvent) {
  if (!moved || event.detail === 0) {
    if (foldAction.value.direction === 'up') emit('update:stageHidden', true);
    else if (foldAction.value.direction === 'down') {
      if (!props.folded) props.view.height = 'max';
      expandNext();
    }
  }
  moved = false;
}
function nudgeHeight(event: KeyboardEvent, delta: number) {
  event.preventDefault();
  if (props.active && !props.folded) changeHeight(height.value + delta);
  else if (delta > 0) expandNext();
  else if (!props.folded) emit('update:folded', true);
}
watch(() => [props.view.mode, props.view.focused, props.view.expanded, props.hidden, props.room], () => cancelPull());

const sizing = computed(() => {
  const maxHeight = Math.max(100, stageHeight.value);
  const count = props.view.displayed.length;
  if (focus.value) return { width: width.value, ratio: 16 / 9, rows: 1 };
  let fitted: { width: number; ratio: number; rows: number } | undefined;
  for (let rows = 1; rows <= Math.min(count, props.detached || props.view.expanded ? 3 : 2); rows++) {
    const columns = Math.ceil(count / rows);
    // CSS 按列排列，同列宽度由最宽画面决定；按真实比例计算，避免超宽画面溢出或窄画面留下多余空隙。
    const columnRatios = Array.from({ length: columns }, (_, column) => Math.max(...props.view.displayed
      .slice(column * rows, (column + 1) * rows).map(ratio)));
    const tileWidth = Math.min((width.value - 8 * (columns - 1)) / columnRatios.reduce((sum, aspect) => sum + aspect, 0),
      (maxHeight - 8 * (rows - 1)) / rows) * 16 / 9;
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
  const fillStage = focus.value || singleStage.value;
  const tileWidth = fillStage ? width.value : sizing.value.width / (16 / 9) * aspect;
  return { width: tileWidth + 'px', height: (fillStage ? stageHeight.value : tileWidth / aspect) + 'px' };
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

function toggleExpanded() {
  props.view.expanded = !props.view.expanded;
}

function toggleMembers() {
  props.view.membersVisible = props.view.expanded || !props.view.membersVisible;
  props.view.expanded = false;
}

function select(share: ViewedShare) {
  if (props.view.mode !== 'focus' && !props.view.select(share.participant.identity)) return;
  props.view.membersVisible = false;
  props.view.height = 'max';
}

let lastLayoutWheelAt = -Infinity;
function layoutWheel(event: WheelEvent) {
  if (event.ctrlKey || event.metaKey || event.deltaY <= 0 || Math.abs(event.deltaX) >= event.deltaY) return;
  const now = performance.now();
  if (now - lastLayoutWheelAt >= 160) {
    if (!focus.value || props.view.shares.length < 2) return;
    props.view.grid();
  }
  lastLayoutWheelAt = now;
  event.preventDefault();
  event.stopPropagation();
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

watch(() => props.active, (active) => {
  if (clock) clearInterval(clock);
  now.value = performance.now();
  if (active) clock = setInterval(() => { now.value = performance.now(); }, 1000);
}, { immediate: true });
watch(() => props.view.expanded, async () => {
  const element = panel.value;
  const before = element?.getBoundingClientRect();
  const surfaces = element ? [...element.querySelectorAll<HTMLElement>('.viewing-stage, .viewing-tile')]
    .map(surface => ({ surface, height: surface.getBoundingClientRect().height })) : [];
  stopPanelMotion();
  const generation = ++panelGeneration;
  if (!element || !before || !props.active) return;
  framing.value = true;
  await nextTick();
  if (generation !== panelGeneration || !element.isConnected) return;
  const owner = element.ownerDocument.defaultView!;
  const after = element.getBoundingClientRect();
  const style = owner.getComputedStyle(element);
  if (motionPreference?.matches || element.ownerDocument.documentElement.classList.contains('is-restoring-layout')
    || typeof element.animate !== 'function' || Math.abs(before.top - after.top) < 1 && Math.abs(before.height - after.height) < 1) {
    framing.value = false;
    return;
  }
  const top = Number.parseFloat(style.top) || 0;
  // 横向直接采用目标边界，主动展开只衔接顶边和高度，不从左上角斜向缩放。
  const active = element.animate([
    { top: `${top + before.top - after.top}px`, height: `${before.height}px` },
    { top: `${top}px`, height: `${after.height}px` },
  ], { duration: motionDurationMs(style.getPropertyValue('--motion-layout-duration')),
    easing: style.getPropertyValue('--motion-ease').trim() });
  panelAnimation = active;
  // 内部画面与外框一起纵向恢复，不能先跳到目标高度，只留下空壳动画。
  contentAnimations = surfaces.filter(item => item.surface.isConnected).map(item => item.surface.animate([
    { height: `${item.height}px` }, { height: `${item.surface.getBoundingClientRect().height}px` },
  ], { duration: motionDurationMs(style.getPropertyValue('--motion-layout-duration')),
    easing: style.getPropertyValue('--motion-ease').trim() }));
  active.finished.then(() => { if (panelAnimation === active) stopPanelMotion(); }, () => {});
}, { flush: 'pre' });
onMounted(() => {
  if (props.detached) stopWindowRestore = observeWindowLayoutRestore(panel.value!.ownerDocument.defaultView!).stop;
  motionPreference = panel.value!.ownerDocument.defaultView!.matchMedia('(prefers-reduced-motion: reduce)');
  motionPreference.addEventListener('change', reducePanelMotion);
});
onScopeDispose(() => {
  stopMemberSettle();
  clearTimeout(foldIdleTimer);
  stopWindowRestore?.();
  panelGeneration++;
  stopPanelMotion();
  if (clock) clearInterval(clock);
  motionPreference?.removeEventListener('change', reducePanelMotion);
});
</script>

<template>
  <section ref="panel" :id="detached ? undefined : 'inline-call-view'" class="call-viewing-panel" :class="{ 'is-detached': detached, 'is-expanded': active && view.expanded, 'is-resizing': resizing, 'is-collapsed': !active, 'is-framing': framing }"
    :aria-label="active ? '共享观看区' : undefined" @keydown.esc="escape" @keydown.tab="trapFocus">
    <div class="viewing-stage" @wheel.capture="layoutWheel" :class="{ 'is-focus-stage': focus, 'is-single-stage': singleStage }" :style="{ height: (active && !folded ? stageHeight : 0) + 'px', opacity: memberBlend ? 1 - memberBlend : undefined }" :inert="!active || folded">
      <span v-if="reconnecting" class="viewing-reconnecting" role="status">正在重连…</span>
      <HorizontalScroll label="共享画面网格">
        <TransitionGroup v-if="active" name="view-tile" tag="div" class="viewing-grid" :class="{ 'is-focus': focus, 'is-single': singleStage }" :style="{ '--view-rows': sizing.rows }"
          @before-leave="($event as HTMLElement).inert = true">
          <div v-for="share in view.displayed" :key="share.key" class="viewing-tile" :style="tileStyle(share)">
            <div class="viewing-surface" role="button" tabindex="0"
              :aria-label="focus ? '放大聚焦画面' : '聚焦' + share.participant.name"
              :title="focus ? '隐藏成员并放大画面' : '点击聚焦共享画面'"
              @click="select(share)" @keydown.enter.self.prevent="select(share)" @keydown.space.self.prevent="select(share)">
              <ParticipantCard :participant="share.participant" :revision="revision" variant="viewer"
                :view-active="videoActive"
                :avatar="avatar(share.participant.identity)" :is-local="share.participant === room?.localParticipant"
                :recording-elapsed="recordingElapsed"
                :is-listening="listening" :input-blocked="true" :show-fullscreen="false"
                :private-control="privateControl(share.participant.identity)" :view-quality="quality"
                @video-size="videoSize(share.key, $event)" @notice="emit('notice', $event)" />
            </div>
            <div class="viewing-actions">
              <span class="viewing-caption" :title="share.participant.name"><span>{{ share.participant.name || share.participant.identity }}</span>
                <time aria-label="本次共享时长">{{ elapsed(share) }}</time>
                <ViewingConnectionStatus v-if="detached" :participant="share.participant" :local="share.participant === room?.localParticipant"
                  :revision="revision" :snapshot="snapshot" :active="videoActive && !folded && !reconnecting" />
                <span v-else-if="share.participant !== room?.localParticipant" class="viewing-connection"><ConnectionSignal :quality="share.participant.connectionQuality" /></span>
              </span>
              <button v-if="focus && !view.expanded" type="button" class="viewing-expand-members"
                :aria-label="view.membersVisible ? '收起成员' : '展开成员'" :aria-expanded="view.membersVisible"
                @click="toggleMembers"><ChevronDown :size="16" /></button>
              <div class="viewing-action-buttons">
                <slot v-if="focus" name="control" :identity="share.participant.identity" />
                <button type="button" :aria-label="focus ? '查看全部共享画面' : '返回聚焦画面'"
                  :title="focus ? '点击查看全部共享画面' : '返回聚焦画面'" :disabled="!focus && !view.focusedShare"
                  @click="focus ? view.grid() : view.focusedShare && view.select(view.focusedShare.participant.identity)">
                  <Grid2X2 v-if="focus" :size="15" /><Focus v-else :size="15" />
                </button>
                <button type="button" :aria-label="view.expanded ? '恢复观看布局' : '占满窗口'"
                  :title="view.expanded ? '恢复观看布局' : '占满窗口'" :aria-pressed="view.expanded" @click="toggleExpanded"><Minimize v-if="view.expanded" :size="15" /><Maximize v-else :size="15" /></button>
                <button type="button" :aria-label="detached ? '返回主界面' : '弹出观看区'" :title="detached ? '返回主界面' : '弹出观看区'"
                  @click="detached ? emit('return') : emit('detach')"><ArrowLeft v-if="detached" :size="15" /><ExternalLink v-else :size="15" /></button>
                <button type="button" aria-label="退出观看" title="退出观看" @click="view.collapse()"><X :size="15" /></button>
              </div>
            </div>
          </div>
        </TransitionGroup>
      </HorizontalScroll>
    </div>
    <Transition name="layout-reveal" :css="!resizing" @before-enter="($event as HTMLElement).inert = false" @before-leave="($event as HTMLElement).inert = true">
      <div v-show="showMembers || memberBlend > 0" class="layout-reveal" :class="{ 'is-blending-members': memberBlend > 0 }"
        :style="memberBlend ? { opacity: memberBlend } : undefined" :inert="memberBlend > 0">
        <div class="layout-reveal-inner">
          <div class="viewing-members-panel">
            <slot :previews-mounted="showMembers" />
          </div>
        </div>
      </div>
    </Transition>
  </section>
  <template v-if="!hidden && !detached && !view.expanded">
    <button type="button" class="viewing-fold" aria-controls="inline-call-view"
      :aria-label="foldAction.label" :aria-expanded="!folded" :data-click-direction="foldAction.direction" :data-direction="foldHint"
      @pointerenter="!drag && (foldHint = undefined)" @focus="!drag && (foldHint = undefined)"
      @pointerdown="startPull" @pointermove="movePull" @pointerup="finishPull" @pointercancel="cancelPull(true)" @lostpointercapture="drag && cancelPull(true)"
      @click="clickHandle" @keydown.up="nudgeHeight($event, -20)" @keydown.down="nudgeHeight($event, 20)">
      <svg width="22" height="10" viewBox="0 0 22 10" aria-hidden="true"><path d="M2 5 L11 5 L20 5" /></svg>
    </button>
    <span class="viewing-fold-strip" aria-hidden="true" :class="{ 'is-under-focus': active && focus && !showMembers && !folded }"
      :style="memberBlend ? { '--member-blend': memberBlend * 100 + '%' } : undefined" />
  </template>
</template>
