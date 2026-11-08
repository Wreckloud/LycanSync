<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef } from 'vue';
import { UserRound } from '@lucide/vue';
import type { VoiceOverlayView } from './types';

const state = shallowRef<VoiceOverlayView | null>(null);
const portraits = ref(new Map<string, string>());
const failure = ref('');
const bridge = window.lycanOverlayView;
const removeListener = bridge?.onView((next) => {
  if (next.portraits) portraits.value = new Map(next.portraits.map((item) => [item.identity, item.avatar]));
  state.value = next;
});
const members = computed(() => state.value?.members.filter((member) => state.value?.editing || member.visible) ?? []);
const scaleStyle = computed(() => ({ '--scale': (state.value?.settings.scale ?? 100) / 100,
  '--column-width': `${state.value?.columnWidth ?? 100}px`,
  '--row-height': `${Math.ceil(34 * (state.value?.settings.scale ?? 100) / 100)}px` }));
if (bridge) void bridge.ready().catch(() => { failure.value = '无法取得屏幕覆盖的当前状态。'; });
onScopeDispose(() => removeListener?.());
</script>

<template>
  <section v-if="state" class="voice-overlay" :class="{ editing: state.editing, 'align-right': state.settings.x > 0.5 }" :style="scaleStyle" aria-label="语音成员覆盖">
    <span v-if="state.editing && !members.length" class="empty-edit">拖动调整位置</span>
    <div class="members">
      <div v-for="member in members" :key="member.identity" class="member"
        :class="{ speaking: member.speaking, 'is-muted': !member.microphone || !member.listening }"
        :aria-label="`${member.name}${!member.listening ? '，已停止收听' : !member.microphone ? '，麦克风已关闭' : ''}`">
        <span class="avatar"><img v-if="portraits.get(member.identity)" :src="portraits.get(member.identity)" alt="" /><UserRound v-else :size="20" aria-hidden="true" /></span>
        <span class="name">{{ member.name }}</span>
      </div>
    </div>
  </section>
  <span v-else-if="failure" class="connection">{{ failure }}</span>
</template>

<style>
* { box-sizing: border-box; }
html, body, #root { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
body { color: #e7ebef; font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif; user-select: none; }
.voice-overlay { height: 100%; padding: 2px; }
.voice-overlay.editing { -webkit-app-region: drag; cursor: move; }
.empty-edit { display: block; font-size: calc(12px * var(--scale)); line-height: calc(32px * var(--scale)); text-align: center; text-shadow: 0 1px 2px #000; }
.members { height: 100%; display: flex; flex-flow: column wrap; align-content: flex-start; gap: 0; }
.align-right .members { flex-wrap: wrap-reverse; }
.member { width: var(--column-width); height: var(--row-height); flex: 0 0 auto; display: flex; align-items: center; gap: calc(6px * var(--scale)); padding: calc(3px * var(--scale)) 0; }
.align-right .member { flex-direction: row-reverse; }
.align-right .name { text-align: right; }
.avatar { display: grid; place-items: center; flex-shrink: 0; width: calc(28px * var(--scale)); height: calc(28px * var(--scale)); border-radius: 50%; background: #3c4854; }
.avatar svg { width: calc(18px * var(--scale)); height: calc(18px * var(--scale)); }
.avatar img { width: 100%; height: 100%; object-fit: cover; border-radius: inherit; }
.speaking .name { color: #8de3c3; }
.name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: calc(15px * var(--scale)); line-height: calc(28px * var(--scale)); text-shadow: 0 1px 2px #000, 1px 0 2px #000, -1px 0 2px #000; }
.is-muted .name { color: #aab4be; }
.voice-overlay, .voice-overlay * { animation: none; transition: none; }
.connection { position: absolute; bottom: 2px; right: 6px; font-size: 11px; color: #b5c6d9; text-shadow: 0 1px 2px #000; }
</style>
