<script setup lang="ts">
import { nextTick, onScopeDispose, ref, shallowRef } from 'vue';
import AccompanimentSpectrum from '../components/AccompanimentSpectrum.vue';
import avatar from '../../../../services/api/src/main/resources/account/default.png';

const context = shallowRef<AudioContext>();
const track = shallowRef<MediaStreamTrack>();
const player = ref<HTMLAudioElement>();
const fileInput = ref<HTMLInputElement>();
const fileUrl = ref('');
const sourceName = ref('');
const choosing = ref(false);
const error = ref('');
let stream: MediaStream | undefined;
let generation = 0;

function stop() {
  generation++;
  choosing.value = false;
  track.value = undefined;
  stream?.getTracks().forEach(item => { item.onended = null; item.stop(); });
  stream = undefined;
  player.value?.pause();
  if (fileUrl.value) URL.revokeObjectURL(fileUrl.value);
  fileUrl.value = '';
  if (context.value) void context.value.close();
  context.value = undefined;
  sourceName.value = '';
  error.value = '';
}
onScopeDispose(stop);

function fail(attempt: number, message: string) {
  if (generation !== attempt) return;
  stop();
  error.value = message;
}

async function listenToSystem() {
  stop();
  const attempt = generation;
  choosing.value = true;
  try {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('当前浏览器不支持共享声音，请使用 Chrome、Edge 或选择音频文件。');
    const options = { video: { frameRate: { ideal: 1, max: 1 } }, audio: true, systemAudio: 'include', selfBrowserSurface: 'exclude' };
    const selected = await navigator.mediaDevices.getDisplayMedia(options);
    if (generation !== attempt) { selected.getTracks().forEach(item => item.stop()); return; }
    stream = selected;
    const audio = selected.getAudioTracks()[0];
    if (!audio) throw new Error('所选来源没有音轨。请重新选择并勾选共享音频，或选择音频文件。');
    for (const item of selected.getTracks()) item.onended = stop;
    const audioContext = context.value = new AudioContext();
    await audioContext.resume();
    if (generation !== attempt) return;
    track.value = audio;
    sourceName.value = audio.label || '系统声音';
    choosing.value = false;
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === 'NotAllowedError') {
      fail(attempt, '未获得共享授权。可以重新选择来源，或选择音频文件。');
    } else fail(attempt, reason instanceof Error ? reason.message : '无法读取共享声音。');
  }
}

async function listenToFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  stop();
  const attempt = generation;
  try {
    const audioContext = context.value = new AudioContext();
    fileUrl.value = URL.createObjectURL(file);
    sourceName.value = file.name;
    await nextTick();
    if (generation !== attempt || !player.value) return;
    const source = audioContext.createMediaElementSource(player.value);
    const output = audioContext.createMediaStreamDestination();
    source.connect(output);
    source.connect(audioContext.destination);
    stream = output.stream;
    track.value = stream.getAudioTracks()[0];
    await audioContext.resume();
    if (generation === attempt) await player.value?.play();
  } catch {
    fail(attempt, '无法播放这个音频文件，请尝试 MP3、WAV 或 Ogg。');
  }
}
</script>

<template>
  <section class="listening-preview" aria-label="本地伴奏频谱试听">
    <h2>本地伴奏频谱试听</h2>
    <p>播放一首歌，再选择正在播放的标签页或整个屏幕，勾选「共享音频」。声音只在本页分析。</p>
    <div class="settings-actions">
      <button type="button" :disabled="choosing" @click="listenToSystem">读取正在播放的声音</button>
      <button type="button" @click="fileInput?.click()">选择音频文件</button>
      <input ref="fileInput" type="file" accept="audio/*" hidden @change="listenToFile" />
      <button v-if="choosing || context" type="button" @click="stop">停止试听</button>
    </div>
    <small v-if="sourceName" role="status">{{ sourceName }}</small>
    <small v-if="error" class="settings-error" role="alert">{{ error }}</small>
    <audio v-if="fileUrl" :key="fileUrl" ref="player" :src="fileUrl" controls />
    <div class="listening-cards">
      <article v-for="responsive in [false, true]" :key="Number(responsive)" class="participant-card">
        <div class="participant-media">
          <img class="large-avatar" :src="avatar" alt="" />
          <Transition name="spectrum-reveal">
            <AccompanimentSpectrum v-if="track && context" :track="track" :context="context" :responsive="responsive" />
          </Transition>
        </div>
        <div class="participant-meta"><strong>{{ responsive ? '灵敏版' : '当前版' }}</strong></div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.listening-preview { display: grid; gap: 12px; margin-bottom: 24px; padding-bottom: 20px; border-bottom: 1px solid var(--border-soft); }
.listening-preview h2, .listening-preview p { margin: 0; }
.listening-preview p, .listening-preview small { color: var(--muted); }
.listening-preview audio { width: min(100%, 464px); }
.listening-cards { display: grid; grid-template-columns: repeat(2, minmax(0, 222px)); gap: 12px; }
</style>
