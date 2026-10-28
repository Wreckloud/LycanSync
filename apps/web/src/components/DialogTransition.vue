<script lang="ts">
const backgrounds = new Map<HTMLElement, { count: number; inert: boolean }>();
</script>

<script setup lang="ts">
import { onScopeDispose } from 'vue';

const sessions = new Map<HTMLElement, { background: Set<HTMLElement>; focus: HTMLElement | null }>();

function isolate(element: Element) {
  const surface = element as HTMLElement;
  if (sessions.has(surface)) {
    const panel = surface.firstElementChild;
    if (panel instanceof HTMLElement) panel.inert = false;
    return;
  }
  const background = new Set<HTMLElement>();
  const focus = surface.ownerDocument.activeElement;
  for (const sibling of surface.ownerDocument.body.children) {
    if (!(sibling instanceof HTMLElement) || sibling === surface) continue;
    const current = backgrounds.get(sibling);
    if (current) current.count++;
    else backgrounds.set(sibling, { count: 1, inert: sibling.inert });
    background.add(sibling);
    sibling.inert = true;
  }
  sessions.set(surface, { background, focus: focus instanceof HTMLElement ? focus : null });
}

function retire(element: Element) {
  // 遮罩保留到退场结束，面板立即停止接受提交和键盘操作。
  const panel = element.firstElementChild;
  if (panel instanceof HTMLElement) panel.inert = true;
}

function restore(element: Element) {
  const session = sessions.get(element as HTMLElement);
  if (!session) return;
  sessions.delete(element as HTMLElement);
  for (const sibling of session.background) {
    const current = backgrounds.get(sibling)!;
    current.count--;
    if (current.count === 0) {
      sibling.inert = current.inert;
      backgrounds.delete(sibling);
    }
  }
  if (session.focus?.isConnected) session.focus.focus({ preventScroll: true });
}

onScopeDispose(() => { for (const surface of sessions.keys()) restore(surface); });
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog" appear @before-enter="isolate" @before-leave="retire" @after-leave="restore">
      <slot />
    </Transition>
  </Teleport>
</template>
