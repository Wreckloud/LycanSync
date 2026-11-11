<script setup lang="ts">
import { motionDurationMs } from '../styles/motion';
import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { ArrowLeft, ChevronDown, ChevronUp, Fullscreen, Maximize2, X } from '@lucide/vue';
import { VideoQuality, type Room } from 'livekit-client';
import type { useScreenShareLayout, ViewedShare } from '../viewing/useScreenShareLayout';
import { useViewingSize } from '../viewing/useViewingSize';
import ParticipantCard from './ParticipantCard.vue';
import HorizontalScroll from './HorizontalScroll.vue';
import { observeWindowLayoutRestore } from '../viewing/windowLayoutRestore';

const props = withDefaults(defineProps<{
  view: UnwrapNestedRefs<ReturnType<typeof useScreenShareLayout>>;
  room: Room | null;
  revision: number;
  recordingElapsed?: string;
  avatar: (identity: string) => string;
  listening: boolean;
  privateControl: (identity: string) => string;
  active?: boolean;
  videoActive?: boolean;
  detached?: boolean;
  reconnecting: boolean;
}>(), { active: true, videoActive: true });
const emit = defineEmits<{ detach: []; return: []; notice: [message: string] }>();
const panel = ref<HTMLElement | null>(null);
const ratios = ref<Record<number, number>>({});
const framing = ref(false);
let panelAnimation: Animation | undefined;
let panelGeneration = 0;
let motionPreference: MediaQueryList | undefined;
let stopWindowRestore: (() => void) | undefined;
function stopPanelMotion() {
  panelAnimation?.cancel();
  panelAnimation = undefined;
  framing.value = false;
}
function reducePanelMotion() {
  if (motionPreference?.matches) stopPanelMotion();
}
let clock: ReturnType<typeof setInterval> | undefined;
const now = ref(performance.now());
const focus = computed(() => props.view.mode === 'focus');
const showMembers = computed(() => !props.active || focus.value && props.view.membersVisible && !props.view.expanded);
const { width, height, minimumHeight, maximumHeight, resizing, changeHeight, beginResize, moveResize, endResize } = useViewingSize(panel, {
  detached: () => Boolean(props.detached), expanded: () => props.view.expanded,
  showMembers: () => showMembers.value, preferredHeight: () => props.view.height,
  setHeight: value => { props.view.height = value; },
});
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
  const tileWidth = focus.value ? width.value : sizing.value.width / (16 / 9) * aspect;
  return { width: tileWidth + 'px', height: (focus.value ? height.value : tileWidth / aspect) + 'px' };
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

watch(() => props.active, (active) => {
  if (clock) clearInterval(clock);
  now.value = performance.now();
  if (active) clock = setInterval(() => { now.value = performance.now(); }, 1000);
}, { immediate: true });
watch(() => props.view.expanded, async () => {
  const element = panel.value;
  const before = element?.getBoundingClientRect();
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
  active.finished.then(() => { if (panelAnimation === active) stopPanelMotion(); }, () => {});
}, { flush: 'pre' });
onMounted(() => {
  if (props.detached) stopWindowRestore = observeWindowLayoutRestore(panel.value!.ownerDocument.defaultView!).stop;
  motionPreference = panel.value!.ownerDocument.defaultView!.matchMedia('(prefers-reduced-motion: reduce)');
  motionPreference.addEventListener('change', reducePanelMotion);
});
onScopeDispose(() => {
  stopWindowRestore?.();
  panelGeneration++;
  stopPanelMotion();
  if (clock) clearInterval(clock);
  motionPreference?.removeEventListener('change', reducePanelMotion);
});
</script>

<template>
  <section ref="panel" class="call-viewing-panel" :class="{ 'is-detached': detached, 'is-expanded': active && view.expanded, 'is-resizing': resizing, 'is-collapsed': !active, 'is-framing': framing }"
    :aria-label="active ? '共享观看区' : undefined" @keydown.esc="escape" @keydown.tab="trapFocus">
    <div class="viewing-stage" :class="{ 'is-focus-stage': focus }" :style="{ height: (active ? height : 0) + 'px' }" :inert="!active">
      <span v-if="reconnecting" class="viewing-reconnecting" role="status">正在重连…</span>
      <HorizontalScroll label="共享画面网格">
        <TransitionGroup v-if="active" name="view-tile" tag="div" class="viewing-grid" :class="{ 'is-focus': focus }" :style="{ '--view-rows': sizing.rows }"
          @before-leave="($event as HTMLElement).inert = true">
          <div v-for="share in view.displayed" :key="share.key" class="viewing-tile" :style="tileStyle(share)">
            <div class="viewing-surface" role="button" tabindex="0"
              :aria-label="focus ? '查看全部共享画面' : '聚焦' + share.participant.name"
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
                <time title="本次共享时长（以这台设备收到的状态为准）">{{ elapsed(share) }}</time>
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
        </TransitionGroup>
      </HorizontalScroll>
      <div v-if="active && !detached && !view.expanded" class="viewing-resize" role="separator" aria-label="调整观看区域高度"
        aria-orientation="horizontal" tabindex="0" :aria-valuenow="Math.round(height)" :aria-valuemin="Math.round(minimumHeight)" :aria-valuemax="Math.round(maximumHeight)"
        @pointerdown="beginResize" @pointermove="moveResize" @pointerup="endResize" @pointercancel="endResize"
        @keydown.up.prevent="changeHeight(height - 20)" @keydown.down.prevent="changeHeight(height + 20)" />
    </div>
    <Transition name="layout-reveal" @before-enter="($event as HTMLElement).inert = false" @before-leave="($event as HTMLElement).inert = true">
      <div v-show="showMembers" class="layout-reveal">
        <div class="layout-reveal-inner">
          <div class="viewing-members-panel">
            <div v-if="active" class="viewing-members-toggle">
              <button type="button" aria-label="收起成员" title="收起成员" :aria-expanded="true" @click="view.membersVisible = false"><ChevronUp :size="16" /></button>
            </div>
            <slot />
          </div>
        </div>
      </div>
    </Transition>
  </section>
</template>
