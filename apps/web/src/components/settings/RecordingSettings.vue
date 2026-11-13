<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useLoadingHint } from '../useLoadingHint';
import type { useRecording } from '../../recording/useRecording';
import InlineFeedback from '../InlineFeedback.vue';
import DialogTransition from '../DialogTransition.vue';
import RecordingLibrary from './RecordingLibrary.vue';

const props = defineProps<{ recording: ReturnType<typeof useRecording>; desktop: boolean; sharing: boolean; active: boolean }>();
const libraryOpen = ref(false);
const replayProgress = computed(() => props.recording.state.value.replay?.phase === 'stopping' ? '正在关闭回放，已开始保存的片段会继续保存…'
  : props.recording.state.value.replay?.saving ? '正在保存回放…'
    : props.recording.state.value.replay?.phase === 'starting' ? '正在准备回放…' : '');
const replayProgressVisible = useLoadingHint(() => replayProgress.value, 1000);
watch(() => props.active, active => { if (!active) libraryOpen.value = false; });
async function toggle(key: 'applicationAudio' | 'microphone' | 'friends', event: Event) {
  const input = event.target as HTMLInputElement;
  await props.recording.configure({ [key]: input.checked });
  input.checked = props.recording.settings.value?.[key] ?? false;
}
async function changeVideo(key: 'videoHeight' | 'videoFps', event: Event) {
  const input = event.target as HTMLSelectElement;
  await props.recording.configure({ [key]: Number(input.value) });
  input.value = String(props.recording.settings.value?.[key] ?? '');
}
async function changeReplay(event: Event) {
  const input = event.target as HTMLSelectElement;
  await props.recording.configureReplay(Number(input.value));
  input.value = String(props.recording.settings.value?.replaySeconds ?? 60);
}
async function toggleReplay(event: Event) {
  const input = event.target as HTMLInputElement;
  await props.recording.setReplayEnabled(input.checked);
  input.checked = props.recording.settings.value?.replayEnabled ?? false;
}
</script>

<template>
  <div class="settings-section">
    <InlineFeedback :message="recording.noticeTarget.value === 'settings' ? recording.notice.value : ''" />
    <section class="settings-block">
      <h2>共享录制</h2>
      <p>录制当前共享的窗口或屏幕，录像保存在本机。</p>
      <h3>录制内容</h3>
      <div v-if="desktop && recording.settings.value" class="settings-toggle-group">
        <label v-for="item in ([{ key: 'applicationAudio', title: '应用声音', detail: '窗口共享时录入所选应用，整屏共享时录入其他应用的声音。' },
          { key: 'microphone', title: '自己的麦克风', detail: '录入当前开启的麦克风声音。' },
          { key: 'friends', title: '朋友的语音', detail: '录入当前正在收听的朋友语音。' }] as const)"
          :key="item.key" class="settings-toggle">
          <span><strong>{{ item.title }}</strong><small>{{ item.detail }}</small></span>
          <input type="checkbox" :checked="recording.settings.value[item.key]" :disabled="recording.localActive.value || recording.busy.value"
            @change="toggle(item.key, $event)" />
        </label>
      </div>
      <p v-else-if="!desktop">录制需要使用 Windows 桌面客户端。</p>
      <InlineFeedback :pending="desktop && !recording.settings.value && !recording.notice.value ? '正在读取录制设置…' : ''" />
      <InlineFeedback :message="recording.noticeTarget.value === 'content' ? recording.notice.value : ''" />
      <small v-if="desktop">录制整屏时，可见的观看窗口也会入镜。只想录游戏，请选择游戏或应用窗口。系统若只能提供全部混音，请关闭“应用声音”后再录制。</small>
      <InlineFeedback :message="recording.noticeTarget.value === 'recording' ? recording.notice.value : ''" />
    </section>
    <section v-if="desktop" class="settings-block recording-file-settings">
      <h2>文件与画质</h2>
      <p>录像与即时回放共用以下画质和保存目录，不影响朋友观看共享画面的画质。</p>
      <div v-if="recording.settings.value" class="recording-file-controls">
        <label>分辨率上限<select aria-label="本地录制分辨率上限" :value="recording.settings.value.videoHeight"
          :disabled="recording.localActive.value || recording.busy.value" @change="changeVideo('videoHeight', $event)">
          <option :value="720">720p</option><option :value="1080">1080p</option><option :value="1440">1440p</option>
        </select></label>
        <label>帧率上限<select aria-label="本地录制帧率上限" :value="recording.settings.value.videoFps"
          :disabled="recording.localActive.value || recording.busy.value" @change="changeVideo('videoFps', $event)">
          <option :value="30">30 FPS</option><option :value="60">60 FPS</option><option :value="120">120 FPS</option>
        </select></label>
      </div>
      <p class="recording-directory">{{ recording.settings.value?.directory ?? '—' }}</p>
      <div class="recording-file-controls">
        <button type="button" class="settings-button" :disabled="recording.localActive.value || recording.busy.value" @click="recording.chooseDirectory">更换目录</button>
        <button type="button" class="settings-button" @click="recording.reveal">打开目录</button>
      </div>
      <InlineFeedback :message="recording.noticeTarget.value === 'files' ? recording.notice.value : ''" />
    </section>
    <section v-if="desktop" class="settings-block">
      <h2>即时回放</h2>
      <label class="settings-toggle">
        <span><strong>开启即时回放</strong><small>共享画面时自动积累最近的片段，可随时保存精彩时刻。</small></span>
        <input type="checkbox" :checked="recording.settings.value?.replayEnabled ?? false"
          :disabled="recording.busy.value" @change="toggleReplay" />
      </label>
      <label class="settings-range-row"><span>回溯时长</span>
        <select aria-label="回放目标时长" :value="recording.settings.value?.replaySeconds ?? 60"
          :disabled="recording.localActive.value || recording.busy.value"
          @change="changeReplay">
          <option :value="30">最近 30 秒</option><option :value="60">最近 60 秒</option><option :value="120">最近 120 秒</option>
        </select>
      </label>
      <small>停止共享后结束缓存，下次共享时自动开启。30／60／120 秒分别最多使用 256／512／1024 MiB 缓存，保存时可能额外占用一份。实际时长取决于已积累内容和内存，可能多约两秒。切换来源后重新积累；关闭回放会丢弃未保存内容。</small>
      <p class="recording-status" role="status">{{ replayProgress ? (replayProgressVisible ? replayProgress : '') : (recording.replayActive.value
        ? recording.state.value.replay?.warming ? '正在积累回放，还未达到设定时长' : '回放已开启'
        : recording.settings.value?.replayEnabled ? (sharing ? '回放尚未启动' : '已开启，等待共享画面') : '回放未开启') }}</p>
      <div v-if="recording.replayActive.value" class="recording-actions">
        <button type="button" class="confirm-button" :disabled="recording.busy.value || recording.state.value.replay?.saving || !!recording.state.value.replay?.error" @click="recording.saveReplay">保存回放</button>
      </div>
      <InlineFeedback :message="recording.noticeTarget.value === 'replay' ? recording.notice.value : ''" />
    </section>
    <section v-if="desktop" class="settings-block">
      <h2>录像管理</h2>
      <p>查看保存在本机的录像和回放，打开文件或整理记录。</p>
      <button type="button" class="settings-button" @click="libraryOpen = true">打开本地录像管理器</button>
    </section>
  </div>
  <DialogTransition>
    <RecordingLibrary v-if="desktop && active && libraryOpen" :status="recording.state.value" @close="libraryOpen = false" />
  </DialogTransition>
</template>

<style scoped>
h3 { margin: 8px 0 0; font-size: 14px; font-weight: 600; }
.recording-file-controls { display: flex; flex-wrap: wrap; gap: 8px 12px; }
.recording-file-controls > label, .recording-file-controls > button { flex: 1; min-width: 100px; }
.recording-file-controls > label { display: grid; gap: 4px; font-size: 12px; color: var(--muted); }
.recording-file-controls select { width: 100%; }
.recording-directory { overflow-wrap: anywhere; color: var(--muted); }
.recording-status { min-height: 20px; }
.recording-actions { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
