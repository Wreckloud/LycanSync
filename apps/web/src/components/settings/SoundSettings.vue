<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { Play, Trash2, Upload } from '@lucide/vue';
import InlineFeedback from '../InlineFeedback.vue';
import CallSoundSettings from './CallSoundSettings.vue';
import type { useCallSoundPreferences } from '../../settings/useCallSoundPreferences';
import type { useCallSounds } from '../../rtc/useCallSounds';
import type { AudioOutputBinding, AudioOutputRouting } from '../../rtc/useAudioOutput';
import { createEntranceSound, ENTRANCE_SOUND_MAX_BYTES, ENTRANCE_SOUND_MAX_DURATION_SECONDS,
  loadEntranceSound, saveEntranceSound } from '../../rtc/entranceSound';

const props = defineProps<{ userId: string; active: boolean;
  preferences: ReturnType<typeof useCallSoundPreferences>; sounds: ReturnType<typeof useCallSounds>; output?: AudioOutputRouting }>();
const sound = ref(loadEntranceSound(props.userId));
const busy = ref(false);
const error = ref('');
const input = ref<HTMLInputElement | null>(null);
let preview: HTMLAudioElement | null = null;
let outputBinding: AudioOutputBinding | undefined;
let upload: AbortController | undefined;
let disposed = false;
const soundSize = computed(() => {
  if (!sound.value) return 0;
  const encoded = sound.value.dataUrl.slice(sound.value.dataUrl.indexOf(',') + 1);
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return Math.floor(encoded.length * 3 / 4) - padding;
});

function stopPreview() {
  outputBinding?.release();
  outputBinding = undefined;
  if (preview) { preview.onended = null; preview.pause(); }
  preview = null;
}

watch(() => props.active, (active) => {
  if (!active) { stopPreview(); upload?.abort(); upload = undefined; busy.value = false; }
});
onScopeDispose(() => { disposed = true; upload?.abort(); stopPreview(); });

async function chooseSound(event: Event) {
  const fileInput = event.target as HTMLInputElement;
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  upload?.abort();
  const controller = new AbortController();
  upload = controller;
  stopPreview();
  busy.value = true;
  error.value = '';
  try {
    const next = await createEntranceSound(file, controller.signal);
    if (disposed || controller.signal.aborted || upload !== controller) return;
    if (!saveEntranceSound(props.userId, next)) throw new Error('入场音效无法保存到本机');
    sound.value = next;
  } catch (exception) {
    if (!disposed && !controller.signal.aborted && upload === controller) error.value = exception instanceof Error ? exception.message : '无法保存入场音效';
  } finally {
    if (upload === controller) { upload = undefined; busy.value = false; }
  }
}

async function playPreview() {
  if (!props.active || !sound.value) return;
  stopPreview();
  const player = new Audio(sound.value.dataUrl);
  preview = player;
  player.onended = () => { if (preview === player) stopPreview(); };
  player.volume = 0.5;
  error.value = '';
  if (props.output) {
    if (!props.output.available.value) { error.value = '请先选择可用的声音输出设备。'; stopPreview(); return; }
    outputBinding = props.output.bindElement(player);
    try { await outputBinding.ready; }
    catch {
      if (preview === player) { error.value = '所选声音输出不可用。'; stopPreview(); }
      return;
    }
    if (preview !== player || !props.active || disposed) return;
  }
  // 被新试听或栏目退出停止的旧播放器，不再改写当前反馈。
  void player.play().catch(() => {
    if (preview === player) error.value = '当前系统未允许播放声音';
  });
}

function removeSound() {
  stopPreview();
  if (!saveEntranceSound(props.userId, null)) {
    error.value = '无法删除本机保存的入场音效';
    return;
  }
  sound.value = null;
  error.value = '';
}
watch(() => props.output?.available.value ?? true, (available) => { if (!available) stopPreview(); }, { flush: 'sync' });
</script>

<template>
  <div class="settings-section sound-settings">
    <CallSoundSettings :active="active" :preferences="preferences" :sounds="sounds" />
    <p class="settings-intro">入场音效先上传至当前服务器统一处理，返回后仅保存在这台设备；加入语音时播放给其他成员。服务器不长期保存原文件。</p>
    <section class="settings-block">
      <h2>入场音效</h2>
      <p>{{ sound ? sound.name : '尚未选择入场音效' }}</p>
      <small v-if="sound">格式：{{ sound.mimeType }} · 文件大小：{{ soundSize }} 字节</small>
      <small>支持 MP3、OGG、WAV、WebM；最长 {{ ENTRANCE_SOUND_MAX_DURATION_SECONDS }} 秒，最大 {{ Math.round(ENTRANCE_SOUND_MAX_BYTES / 1024) }} KB。</small>
      <small>统一为单声道 WAV，限制音量增益及峰值；旧版音效请重新选择后使用。播放时仍受接收方提示音开关与音量控制。</small>
      <div class="settings-actions sound-actions">
        <input ref="input" type="file" hidden aria-label="选择入场音效"
          accept="audio/mpeg,audio/ogg,audio/wav,audio/webm,.mp3,.ogg,.wav,.webm" @change="chooseSound" />
        <button type="button" :disabled="busy" @click="input?.click()"><Upload :size="15" />选择音效</button>
        <button v-if="sound" type="button" :disabled="busy" @click="playPreview"><Play :size="15" />试听</button>
        <button v-if="sound" type="button" :disabled="busy" @click="removeSound"><Trash2 :size="15" />移除</button>
      </div>
      <InlineFeedback :message="error" :status="busy ? '正在上传并处理音效…' : ''" />
    </section>
  </div>
</template>

<style scoped>
.sound-settings { max-width: 760px; }
.sound-actions { justify-content: flex-start; }
</style>
