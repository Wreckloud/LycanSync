<script setup lang="ts">
import { nextTick, onMounted, onScopeDispose, ref } from 'vue';
import { AudioLines, HeadphoneOff, Headphones, MicOff, Music2, Square } from '@lucide/vue';
import VoiceLevelMic from '../components/VoiceLevelMic.vue';

const sources = ['QQ 音乐', '网易云音乐'];
const playing = ref('');
const choosing = ref(false);
const mic = ref(true);
const listening = ref(true);
const trigger = ref<HTMLButtonElement>();
const picker = ref<HTMLElement>();

function closePicker(restoreFocus = false) {
  choosing.value = false;
  if (restoreFocus) trigger.value?.focus();
}

async function toggleAccompaniment() {
  if (playing.value) { playing.value = ''; return; }
  if (choosing.value) { closePicker(true); return; }
  choosing.value = true;
  await nextTick();
  picker.value?.querySelector('button')?.focus();
}

function start(source: string) {
  playing.value = source;
  closePicker(true);
}

function dismissOutside(event: Event) {
  if (choosing.value && event.target instanceof Node &&
    !picker.value?.contains(event.target) && !trigger.value?.contains(event.target)) closePicker();
}

onMounted(() => {
  document.addEventListener('pointerdown', dismissOutside);
  document.addEventListener('focusin', dismissOutside);
});
onScopeDispose(() => {
  document.removeEventListener('pointerdown', dismissOutside);
  document.removeEventListener('focusin', dismissOutside);
});
</script>

<template>
  <section class="accompaniment-preview preview-content" aria-labelledby="accompaniment-title">
    <header class="preview-section-heading">
      <h2 id="accompaniment-title">分享伴奏</h2>
      <p>点自己卡片上的「伴奏」，选一个播放器。这里使用模拟音源，只演示操作。</p>
    </header>
    <div class="sample-card" @keydown.esc.stop="closePicker(true)">
      <article class="participant-card">
        <div class="participant-media">
          <div class="large-avatar" aria-hidden="true">维</div>
          <span v-if="playing" class="playing-source" role="status"><AudioLines :size="13" />{{ playing }}</span>
        </div>
        <div class="participant-meta">
          <span class="participant-name"><strong>维克罗德（你）</strong></span>
          <button ref="trigger" type="button" class="participant-state participant-state-button accompaniment-button"
            :class="{ 'is-active': playing || choosing }" :aria-expanded="playing ? undefined : choosing"
            :aria-label="playing ? '停止分享伴奏' : '选择伴奏音源'" @click="toggleAccompaniment">
            <Square v-if="playing" :size="12" /><Music2 v-else :size="14" />{{ playing ? '停止' : '伴奏' }}
          </button>
          <button type="button" class="participant-state participant-state-button" :class="{ 'is-off': !mic }"
            :aria-label="mic ? '关闭自己的麦克风' : '开启自己的麦克风'" @click="mic = !mic">
            <VoiceLevelMic v-if="mic" :size="14" :level="0" /><MicOff v-else :size="14" />
          </button>
          <button type="button" class="participant-state participant-state-button" :class="{ 'is-off': !listening }"
            :aria-label="listening ? '停止收听' : '恢复收听'" @click="listening = !listening">
            <Headphones v-if="listening" :size="14" /><HeadphoneOff v-else :size="14" />
          </button>
        </div>
      </article>
      <Transition name="surface-panel">
        <section v-if="choosing" ref="picker" aria-label="选择伴奏音源" class="source-picker">
          <header>选择要分享声音的应用</header>
          <button v-for="source in sources" :key="source" type="button" @click="start(source)">
            <Music2 :size="15" />{{ source }}
          </button>
        </section>
      </Transition>
    </div>
  </section>
</template>

<style scoped>
.accompaniment-preview { padding-bottom: 140px; }
.sample-card { position: relative; width: min(222px, 100%); }
.accompaniment-button { display: inline-flex; align-items: center; justify-content: center; gap: 3px; width: 44px; font-size: 12px; }
.accompaniment-button:hover, .accompaniment-button.is-active { color: var(--accent); }
.playing-source { position: absolute; left: 7px; bottom: 6px; display: inline-flex; align-items: center; gap: 4px; padding: 2px 5px; border-radius: 4px; background: var(--panel-raised); color: var(--text); font-size: 11px; }
.playing-source svg { color: var(--accent); }
.source-picker { position: absolute; z-index: 1; top: calc(100% + 6px); right: 0; width: min(200px, 100%); padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-raised); }
.source-picker header { padding: 3px 6px 6px; color: var(--muted); font-size: 12px; }
.source-picker button { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 32px; padding: 6px; border: 0; background: transparent; color: var(--text); font-size: 13px; }
.source-picker button:hover, .source-picker button:focus-visible { background: var(--panel-soft); }
</style>
