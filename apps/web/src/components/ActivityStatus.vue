<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Gamepad2, Music2 } from '@lucide/vue';

const props = defineProps<{ type: string; text: string; active: boolean }>();
const viewport = ref<HTMLElement | null>(null);
const content = ref<HTMLElement | null>(null);
const distance = ref(0);
const prefix = computed(() => props.type === 'MUSIC' ? '正在听' : '正在玩');
const name = computed(() => props.text.startsWith(prefix.value + ' ') ? props.text.slice(prefix.value.length + 1) : props.text);
const motion = computed(() => ({ '--activity-offset': -distance.value + 'px',
  '--activity-duration': Math.max(12, distance.value / 18 * 2 + 4) + 's' }));

watch([viewport, content, () => props.active, () => props.text], (_, __, cleanup) => {
  distance.value = 0;
  const element = viewport.value;
  const text = content.value;
  if (!props.active || !element || !text) return;
  // 仅悬浮时测量溢出并观察尺寸，不为每个成员持续运行计时器。
  const measure = () => { distance.value = Math.max(0, text.scrollWidth - element.clientWidth); };
  const observer = new element.ownerDocument.defaultView!.ResizeObserver(measure);
  observer.observe(element);
  observer.observe(text);
  measure();
  cleanup(() => observer.disconnect());
}, { flush: 'post' });
</script>

<template>
  <span class="member-activity" :title="text" :style="motion" :class="{ 'is-scrolling': active && distance > 1 }">
    <Music2 v-if="type === 'MUSIC'" :size="12" aria-hidden="true" /><Gamepad2 v-else :size="12" aria-hidden="true" />
    <span class="activity-prefix">{{ prefix }} </span>
    <span ref="viewport" class="activity-viewport"><span ref="content" class="activity-content">{{ name }}</span></span>
  </span>
</template>
