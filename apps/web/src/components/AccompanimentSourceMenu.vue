<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref } from 'vue';
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom';
import { ChevronLeft, ChevronRight } from '@lucide/vue';

interface Source { id: string; name: string; icon?: string; common?: boolean }
const props = defineProps<{ anchor: HTMLElement; sources: Source[]; error: string; busy?: boolean }>();
const emit = defineEmits<{ choose: [id: string]; close: [restoreFocus: boolean] }>();
const frequent = computed(() => props.sources.filter(source => source.common));
const other = computed(() => props.sources.filter(source => !source.common).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')));
const root = ref<HTMLElement>();
const compact = ref(false);
const expanded = ref(false);
const hasTwoLevels = computed(() => frequent.value.length > 0 && other.value.length > 0);
const pages = computed(() => {
  const main = { key: 'main', label: '伴奏来源', rows: frequent.value.length ? frequent.value : other.value };
  if (!expanded.value || !hasTwoLevels.value) return [main];
  const more = { key: 'other', label: '其他应用', rows: other.value };
  return compact.value ? [more] : [main, more];
});
let stopPositioning: (() => void) | undefined;
let calculation = 0;

function focusPage() {
  const panel = root.value?.querySelector(`[data-page="${pages.value.at(-1)?.key}"]:not([inert])`);
  (panel?.querySelector<HTMLElement>('.source-row') ?? panel?.querySelector<HTMLElement>('button') ?? root.value)?.focus({ preventScroll: true });
}
async function toggleOther() {
  expanded.value = !expanded.value;
  await nextTick();
  if (expanded.value) focusPage();
  else root.value?.querySelector<HTMLElement>('.other-trigger')?.focus();
}
function escape() {
  if (expanded.value) void toggleOther();
  else emit('close', true);
}
function dismissOutside(event: Event) {
  if (event.target instanceof Node && !props.anchor.contains(event.target) && !root.value?.contains(event.target)) emit('close', false);
}

onMounted(() => {
  const element = root.value!;
  const card = props.anchor.closest<HTMLElement>('.participant-card')!;
  let placed = false;
  stopPositioning = autoUpdate(card, element, async () => {
    const request = ++calculation;
    const { x, y } = await computePosition(card, element, {
      strategy: 'fixed', placement: 'bottom-start', middleware: [
        offset(6), flip({ padding: 8 }), shift({ padding: 8 }),
        size({ padding: 8, apply({ rects, availableWidth }) {
          element.style.width = Math.min(rects.reference.width, availableWidth) + 'px';
        } }),
      ],
    });
    if (request !== calculation) return;
    Object.assign(element.style, { left: x + 'px', top: y + 'px', visibility: 'visible' });
    element.style.setProperty('--menu-top', y + 'px');
    const fits = x + element.offsetWidth * 2 + 16 <= window.innerWidth && window.innerHeight - y >= 140;
    const nextCompact = window.innerWidth <= 600 || !fits;
    const needsFocus = !placed || (compact.value !== nextCompact && expanded.value && element.contains(document.activeElement));
    compact.value = nextCompact;
    placed = true;
    if (needsFocus) { await nextTick(); if (request === calculation) focusPage(); }
  });
  document.addEventListener('pointerdown', dismissOutside);
  document.addEventListener('focusin', dismissOutside);
});
onScopeDispose(() => {
  calculation++;
  stopPositioning?.();
  document.removeEventListener('pointerdown', dismissOutside);
  document.removeEventListener('focusin', dismissOutside);
});
</script>

<template>
  <div ref="root" class="source-menu" tabindex="-1" @keydown.esc.stop.prevent="escape">
    <TransitionGroup :name="compact ? 'surface-panel' : 'surface-side'"
      @before-leave="($event as HTMLElement).inert = true" @before-enter="($event as HTMLElement).inert = false">
    <section v-for="page in pages" :key="page.key" class="call-control-menu" :class="{ 'side-page': page.key === 'other' && !compact }"
      :aria-label="page.label" :data-page="page.key">
      <header class="call-submenu-heading">
        <button v-if="page.key === 'other' && compact" type="button" class="call-menu-action call-submenu-back" aria-label="返回伴奏来源" @click="toggleOther"><ChevronLeft :size="14" /></button>
        {{ page.label }}
      </header>
      <div class="source-list">
        <button v-for="source in page.rows" :key="source.id" type="button" class="call-menu-action source-row" :disabled="busy" @click="emit('choose', source.id)">
          <img v-if="source.common && source.icon" :src="source.icon" width="16" height="16" alt="" />
          <span :title="source.name">{{ source.name }}</span>
        </button>
        <p v-if="!page.rows.length && !busy && !error">打开播放器或浏览器后，它会出现在这里。</p>
      </div>
      <button v-if="page.key === 'main' && hasTwoLevels" type="button" class="call-menu-action other-trigger" :aria-expanded="expanded" @click="toggleOther">
        其他应用（{{ other.length }}）<ChevronRight class="call-menu-chevron" :size="14" />
      </button>
      <p v-if="error && page === pages.at(-1)" role="alert">{{ error }}</p>
    </section>
    </TransitionGroup>
  </div>
</template>

<style scoped src="../styles/callMenu.css"></style>
<style scoped>
.source-menu { position: fixed; z-index: 30; width: min(224px, calc(100vw - 16px)); visibility: hidden; --call-menu-max-height: min(420px, calc(100dvh - 16px)); }
.call-control-menu { width: 100%; grid-template-columns: minmax(0, 1fr); gap: 6px; }
.call-control-menu.surface-panel-leave-active { position: absolute; top: 0; left: 0; }
.side-page { position: absolute; left: calc(100% + 8px); top: 0; max-height: min(var(--call-menu-max-height), calc(100dvh - var(--menu-top) - 8px)); }
.call-menu-action { justify-content: flex-start; }
.source-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source-list p { color: var(--muted); font-size: 11px; }
.source-list p, [role="alert"] { margin: 0; }
[role="alert"] { color: var(--danger); }
.other-trigger { border-top: 1px solid var(--border-soft); border-radius: 0; }
</style>
