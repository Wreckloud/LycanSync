<script setup lang="ts">
import { computed } from 'vue';
import { useLoadingHint } from '../useLoadingHint';
import type { useRecording } from '../../recording/useRecording';
import InlineFeedback from '../InlineFeedback.vue';
import RecordingLibrary from './RecordingLibrary.vue';

const props = defineProps<{ recording: ReturnType<typeof useRecording>; desktop: boolean; sharing: boolean; active: boolean }>();
const recordingProgress = computed(() => props.recording.state.value.phase === 'stopping' ? '正在保存…'
  : props.recording.state.value.phase === 'starting' ? '正在准备录制…' : '');
const replayProgress = computed(() => props.recording.state.value.replay?.phase === 'stopping' ? '正在关闭回放，已开始保存的片段会继续保存…'
  : props.recording.state.value.replay?.saving ? '正在保存回放…'
    : props.recording.state.value.replay?.phase === 'starting' ? '正在准备回放…' : '');
const recordingProgressVisible = useLoadingHint(() => recordingProgress.value, 1000);
const replayProgressVisible = useLoadingHint(() => replayProgress.value, 1000);
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
</script>

<template>
  <div class="settings-section">
    <p class="settings-intro">录制当前共享的窗口或屏幕，录像保存在本机。</p>
    <InlineFeedback :message="recording.noticeTarget.value === 'settings' ? recording.notice.value : ''" />
    <section class="settings-block">
      <h2>录制内容</h2>
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
    </section>
    <section v-if="desktop" class="settings-block">
      <h2>文件与画质</h2>
      <p>录像与即时回放共用画质设置，按原比例录制。</p>
      <div v-if="recording.settings.value" class="recording-actions">
        <label class="replay-duration">分辨率上限<select aria-label="本地录制分辨率上限" :value="recording.settings.value.videoHeight"
          :disabled="recording.localActive.value || recording.busy.value" @change="changeVideo('videoHeight', $event)">
          <option :value="720">720p</option><option :value="1080">1080p</option><option :value="1440">1440p</option>
        </select></label>
        <label class="replay-duration">帧率上限<select aria-label="本地录制帧率上限" :value="recording.settings.value.videoFps"
          :disabled="recording.localActive.value || recording.busy.value" @change="changeVideo('videoFps', $event)">
          <option :value="30">30 FPS</option><option :value="60">60 FPS</option><option :value="120">120 FPS</option>
        </select></label>
      </div>
      <p class="recording-directory">{{ recording.settings.value?.directory ?? '—' }}</p>
      <div class="recording-actions">
        <button type="button" class="settings-button" :disabled="recording.localActive.value || recording.busy.value" @click="recording.chooseDirectory">更换目录</button>
        <button type="button" class="settings-button" @click="recording.reveal">打开目录</button>
      </div>
      <small>录制整屏时，可见的观看窗口也会入镜。只想录游戏，请选择游戏或应用窗口。系统若只能提供全部混音，请关闭“应用声音”后再录制。</small>
      <InlineFeedback :message="recording.noticeTarget.value === 'files' ? recording.notice.value : ''" />
    </section>
    <section v-if="desktop" class="settings-block">
      <h2>当前录像</h2>
      <p class="recording-status" role="status">{{ recordingProgress ? (recordingProgressVisible ? recordingProgress : '') : (recording.state.value.phase === 'recording' ? `正在录制 · ${recording.elapsed.value}`
        : recording.state.value.holdingResources ? '录制尚未完全停止，请先结束共享。'
          : recording.state.value.saved ? '录像已保存' : '尚未录制') }}
        <template v-if="recording.state.value.bytes"> · {{ (recording.state.value.bytes / 1024 / 1024).toFixed(1) }} MiB</template>
      </p>
      <button v-if="recording.active.value" type="button" class="settings-button" :disabled="recording.state.value.phase === 'stopping'" @click="recording.stop">停止并保存</button>
      <button v-else type="button" class="confirm-button" :disabled="!sharing || recording.busy.value" @click="recording.start">开始录制</button>
      <InlineFeedback :message="recording.noticeTarget.value === 'recording' ? recording.notice.value : ''" />
    </section>
    <section v-if="desktop" class="settings-block">
      <h2>即时回放</h2>
      <p>开启后积累最近的共享画面，随时保存精彩片段，录制期间也可使用。</p>
      <label class="replay-duration">回溯时长
        <select aria-label="回放目标时长" :value="recording.settings.value?.replaySeconds ?? 60"
          :disabled="recording.localActive.value || recording.busy.value"
          @change="changeReplay">
          <option :value="30">最近 30 秒</option><option :value="60">最近 60 秒</option><option :value="120">最近 120 秒</option>
        </select>
      </label>
      <small>需先共享自己的画面。回放保留原有画质，30／60／120 秒分别最多使用 256／512／1024 MiB 缓存，保存时可能额外占用一份。实际时长取决于已积累内容和内存，可能多约两秒。切换来源或录制规格后，开始积累新画面；关闭后丢弃未保存内容。</small>
      <p class="recording-status" role="status">{{ replayProgress ? (replayProgressVisible ? replayProgress : '') : (recording.replayActive.value
        ? recording.state.value.replay?.warming ? '正在积累回放，还未达到设定时长' : '回放已开启' : '回放未开启') }}</p>
      <div class="recording-actions">
        <button v-if="!recording.replayActive.value" type="button" class="confirm-button" :disabled="!sharing || recording.busy.value" @click="recording.startReplay">开启回放</button>
        <template v-else>
          <button type="button" class="confirm-button" :disabled="recording.busy.value || recording.state.value.replay?.saving || !!recording.state.value.replay?.error" @click="recording.saveReplay">保存回放</button>
          <button type="button" class="settings-button" :disabled="recording.busy.value" @click="recording.stopReplay">关闭回放</button>
        </template>
      </div>
      <InlineFeedback :message="recording.noticeTarget.value === 'replay' ? recording.notice.value : ''" />
    </section>
    <RecordingLibrary v-if="desktop && active" :status="recording.state.value" />
  </div>
</template>

<style scoped>
.recording-directory { overflow-wrap: anywhere; color: var(--muted); }
.recording-status { min-height: 20px; }
.recording-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.replay-duration { display: flex; align-items: center; gap: 12px; font-size: 13px; }
</style>
