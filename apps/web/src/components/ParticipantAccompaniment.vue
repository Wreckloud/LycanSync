<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import type { TrackPublication } from 'livekit-client';
import { applicationAudioName, type ApplicationAudioSource } from '../rtc/applicationAudio';
import AccompanimentBadge from './AccompanimentBadge.vue';
import AccompanimentSourceMenu from './AccompanimentSourceMenu.vue';
import AccompanimentSpectrum from './AccompanimentSpectrum.vue';
import qqmusic from '../preview/assets/qq-music.png';
import netease from '../preview/assets/netease.png';
import kugou from '../preview/assets/kugou.png';
import kuwo from '../preview/assets/kuwo.png';
import soda from '../preview/assets/soda.png';
import spotify from '../preview/assets/spotify.png';
import chrome from '../preview/assets/chrome.png';
import edge from '../preview/assets/edge.png';
import firefox from '../preview/assets/firefox.png';
import vlc from '../preview/assets/vlc.png';
import potplayer from '../preview/assets/potplayer.png';
import mediaplayer from '../preview/assets/media-player.png';
import legacyplayer from '../preview/assets/legacy-player.png';
import moviestv from '../preview/assets/movies-tv.png';

const props = defineProps<{
  local: boolean; screen: boolean; visible: boolean; revision: number; publication?: TrackPublication;
  source?: ApplicationAudioSource | null; context?: AudioContext | null; busy?: boolean;
  start: (source: ApplicationAudioSource) => Promise<boolean>; stop: () => Promise<void>;
}>();
const emit = defineEmits<{ notice: [message: string] }>();
const icons: Record<string, string> = { qqmusic, netease, kugou, kuwo, soda, spotify, chrome, edge, firefox, vlc,
  potplayer, mediaplayer, legacyplayer, moviestv };
const common = ['qqmusic', 'netease', 'kugou', 'kuwo', 'soda', 'spotify', 'potplayer', 'mediaplayer', 'chrome', 'edge', 'firefox'];
const bridge = window.lycanDesktop;
const sharing = computed(() => props.local ? props.source?.application : applicationAudioName(props.publication));
const track = computed(() => {
  void props.revision;
  return props.publication?.track?.mediaStreamTrack;
});
const choices = shallowRef<ApplicationAudioSource[]>([]);
const rows = computed(() => choices.value.map(source => ({
  ...source, common: common.includes(source.application), icon: icons[source.application],
})).sort((a, b) => common.indexOf(a.application) - common.indexOf(b.application)));
const anchor = shallowRef<HTMLElement>();
const error = ref('');
const loading = ref(false);
let generation = 0;

function close(restore: boolean) {
  generation++;
  if (restore) anchor.value?.focus({ preventScroll: true });
  anchor.value = undefined;
}
watch(() => [props.screen, props.visible], () => { if (props.screen || !props.visible) close(false); });
onScopeDispose(() => { generation++; });

async function activate(event: MouseEvent) {
  if (!props.local || props.busy) return;
  if (sharing.value) {
    try { await props.stop(); }
    catch { emit('notice', '停止伴奏时发生错误，请重新连接语音。'); }
    return;
  }
  if (anchor.value) { close(true); return; }
  if (!bridge?.listApplicationAudioSources || props.screen) return;
  anchor.value = event.currentTarget as HTMLElement;
  const request = ++generation;
  choices.value = [];
  error.value = '';
  loading.value = true;
  try {
    const sources = await bridge.listApplicationAudioSources();
    if (generation === request) choices.value = sources;
  } catch {
    if (generation === request) error.value = '无法读取伴奏来源，请检查系统是否支持应用声音采集后重试。';
  } finally {
    if (generation === request) loading.value = false;
  }
}
async function choose(id: string) {
  const source = choices.value.find(entry => entry.id === id);
  if (!source || !anchor.value || props.busy || loading.value) return;
  const request = generation;
  loading.value = true;
  try {
    const started = await props.start(source);
    if (request !== generation) return;
    if (started) close(true);
    else error.value = '伴奏未能开始，请重新选择来源。';
  } finally {
    if (request === generation) loading.value = false;
  }
}
</script>

<template>
  <AccompanimentSpectrum v-if="visible && !screen" :track="sharing ? track : undefined" :context="context" />
  <AccompanimentBadge v-if="sharing || (local && !screen && bridge?.listApplicationAudioSources)" :local="local"
    :sharing="sharing" :icon="sharing && icons[sharing]" :busy="local && busy" :open="!!anchor" @activate="activate" />
  <Teleport to="body">
    <Transition name="surface-panel">
      <AccompanimentSourceMenu v-if="anchor" :anchor="anchor" :sources="rows" :error="error" :busy="loading || busy"
        @choose="choose" @close="close" />
    </Transition>
  </Teleport>
</template>
