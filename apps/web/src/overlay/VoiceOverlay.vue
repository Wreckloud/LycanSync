<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef } from 'vue';
import type { VoiceOverlayView } from './types';

const state = shallowRef<VoiceOverlayView | null>(null);
const portraits = ref(new Map<string, string>());
const failure = ref('');
const bridge = window.lycanOverlayView;
const removeListener = bridge?.onView((next) => {
  if (next.portraits) portraits.value = new Map(next.portraits.map((item) => [item.identity, item.avatar]));
  state.value = next;
});
const members = computed(() => {
  if (state.value?.editing && !state.value.members.length) return [
    { identity: 'example-1', name: '成员示例', microphone: true, listening: true, speaking: true, visible: true },
    { identity: 'example-2', name: '静音示例', microphone: false, listening: true, speaking: false, visible: true },
  ];
  return state.value?.members.filter((member) => state.value?.editing || member.visible) ?? [];
});
const scaleStyle = computed(() => ({ '--scale': (state.value?.settings.scale ?? 100) / 100,
  '--column-width': `${state.value?.settings.width ?? 240}px` }));
if (bridge) void bridge.ready().catch(() => { failure.value = '覆盖状态连接失败'; });
onScopeDispose(() => removeListener?.());
</script>

<template>
  <section v-if="state" class="voice-overlay" :class="{ editing: state.editing, 'align-right': state.settings.x > 0.5 }" :style="scaleStyle" aria-label="语音成员覆盖">
    <header v-if="state.editing" class="drag-handle">拖动调整位置 · {{ state.members.length ? '编辑中' : '示例预览' }}</header>
    <div class="members">
      <div v-for="member in members" :key="member.identity" class="member"
        :class="{ speaking: member.speaking, 'is-muted': !member.microphone || !member.listening }"
        :aria-label="`${member.name}${!member.listening ? '，已停止收听' : !member.microphone ? '，麦克风已关闭' : ''}`">
        <span class="avatar"><img v-if="portraits.get(member.identity)" :src="portraits.get(member.identity)" alt="" /><span v-else>{{ member.name.slice(0, 1) }}</span></span>
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
.voice-overlay { height: 100%; padding: 4px 2px; }
.voice-overlay.editing { border: 1px dashed #6a9fe8; border-radius: 6px; background: #10151a99; }
.drag-handle { height: 32px; padding: 6px; font-size: 12px; text-align: center; color: #c7d8ef; -webkit-app-region: drag; }
.members { height: 100%; display: flex; flex-flow: column wrap; align-content: flex-start; gap: 0; }
.align-right .members { flex-wrap: wrap-reverse; }
.editing .members { height: calc(100% - 32px); }
.member { width: calc(var(--column-width) - 4px); height: calc(48px * var(--scale)); flex: 0 0 auto; display: flex; align-items: center; gap: calc(9px * var(--scale)); padding: 4px 0; }
.align-right .member { flex-direction: row-reverse; }
.align-right .name { text-align: right; }
.avatar { display: grid; place-items: center; flex-shrink: 0; width: calc(32px * var(--scale)); height: calc(32px * var(--scale)); border: 2px solid transparent; border-radius: 50%; background: #3c4854; font-size: calc(15px * var(--scale)); }
.avatar img { width: 100%; height: 100%; object-fit: cover; border-radius: inherit; }
.speaking .avatar { border-color: #5acaa5; }
.speaking .name { color: #8de3c3; }
.name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: calc(14px * var(--scale)); text-shadow: 0 1px 2px #000, 1px 0 2px #000, -1px 0 2px #000; }
.is-muted .name { color: #aab4be; }
.connection { position: absolute; bottom: 2px; right: 6px; font-size: 11px; color: #b5c6d9; text-shadow: 0 1px 2px #000; }
</style>
