<script lang="ts">
const backgrounds = new Map<HTMLElement, { count: number; inert: boolean }>();
const layers = new Map<HTMLElement, number>();
</script>

<script setup lang="ts">
import { onScopeDispose, watch } from 'vue';

const props = defineProps<{ deferOpen?: boolean; focusFallback?: HTMLElement }>();
const sessions = new Map<HTMLElement, { background: Set<HTMLElement>; focus: HTMLElement | null; zIndex: string }>();
let waiting: Element | null = null;

function enter(element: Element) {
  if (props.deferOpen) waiting = element;
  else isolate(element);
}

// 媒体在后台缓冲时仍允许操作聊天，真正打开查看器时才隔离背景。
watch(() => props.deferOpen, deferred => {
  if (!deferred && waiting) { isolate(waiting); waiting = null; }
}, { flush: 'post' });

function isolate(element: Element) {
  const surface = element as HTMLElement;
  if (sessions.has(surface)) {
    const panel = surface.firstElementChild;
    if (panel instanceof HTMLElement) panel.inert = false;
    return;
  }
  const background = new Set<HTMLElement>();
  const focus = surface.ownerDocument.activeElement;
  // Teleport 的挂载顺序不等于打开顺序；新弹窗必须盖过仍在后台的查看器。
  const zIndex = surface.style.zIndex;
  const layer = Math.max(100, ...layers.values()) + 1;
  layers.set(surface, layer);
  surface.style.zIndex = String(layer);
  for (const sibling of surface.ownerDocument.body.children) {
    if (!(sibling instanceof HTMLElement) || sibling === surface) continue;
    const current = backgrounds.get(sibling);
    if (current) current.count++;
    else backgrounds.set(sibling, { count: 1, inert: sibling.inert });
    background.add(sibling);
    sibling.inert = true;
  }
  sessions.set(surface, { background, focus: focus instanceof HTMLElement ? focus : null, zIndex });
}

function retire(element: Element) {
  if (waiting === element) waiting = null;
  // 遮罩保留到退场结束，面板立即停止接受提交和键盘操作。
  const panel = element.firstElementChild;
  if (panel instanceof HTMLElement) panel.inert = true;
}

function restore(element: Element) {
  const session = sessions.get(element as HTMLElement);
  if (!session) return;
  sessions.delete(element as HTMLElement);
  layers.delete(element as HTMLElement);
  (element as HTMLElement).style.zIndex = session.zIndex;
  for (const sibling of session.background) {
    const current = backgrounds.get(sibling)!;
    current.count--;
    if (current.count === 0) {
      sibling.inert = current.inert;
      backgrounds.delete(sibling);
    }
  }
  if (session.focus?.isConnected) session.focus.focus({ preventScroll: true });
  else if (props.focusFallback?.isConnected) props.focusFallback.focus({ preventScroll: true });
}

onScopeDispose(() => { for (const surface of sessions.keys()) restore(surface); });
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog" appear @before-enter="enter" @before-leave="retire" @after-leave="restore">
      <slot />
    </Transition>
  </Teleport>
</template>
