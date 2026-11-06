<script setup lang="ts">
import type { useRecording } from '../../recording/useRecording';
import InlineFeedback from '../InlineFeedback.vue';
import RecordingLibrary from './RecordingLibrary.vue';

const props = defineProps<{ recording: ReturnType<typeof useRecording>; desktop: boolean; sharing: boolean }>();
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
    <p class="settings-intro">保存自己正在共享的画面。录制在本机完成，不录入其他人的共享轨道，也不会自动上传。</p>
    <InlineFeedback :message="recording.noticeTarget.value === 'settings' ? recording.notice.value : ''" />
    <section class="settings-block">
      <h2>录制内容</h2>
      <template v-if="desktop && recording.settings.value">
        <label v-for="item in ([{ key: 'applicationAudio', title: '应用声音', detail: '窗口录入所选应用；整屏录入本机其他应用，排除本软件播放的声音。与共享声音开关分开。' },
          { key: 'microphone', title: '自己的麦克风', detail: '使用当前麦克风声音，不会自动解除静音。' },
          { key: 'friends', title: '朋友的语音', detail: '只录入当前收听的语音，不包括对方的共享声音。' }] as const)"
          :key="item.key" class="settings-toggle">
          <span><strong>{{ item.title }}</strong><small>{{ item.detail }}</small></span>
          <input type="checkbox" :checked="recording.settings.value[item.key]" :disabled="recording.localActive.value || recording.busy.value"
            @change="toggle(item.key, $event)" />
        </label>
      </template>
      <p v-else>{{ desktop ? '正在读取录制设置…' : '录制需要使用 Windows 桌面客户端。' }}</p>
      <InlineFeedback :message="recording.noticeTarget.value === 'content' ? recording.notice.value : ''" />
    </section>
    <section v-if="desktop" class="settings-block">
      <h2>文件与画质</h2>
      <p>录像与回放共用以下画质、声音选项和保存目录，与共享画质分开。按来源比例缩放，不放大较小的来源；共享降低帧率不会降低这里的目标。硬件 H.264 编码，保存为 MKV。</p>
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
      <small>选择整屏时，屏幕上可见的观看窗口也会入镜；只想录游戏时，请选择游戏或应用窗口。系统若只支持完整混音，需关闭应用声音选项后录制。</small>
      <InlineFeedback :message="recording.noticeTarget.value === 'files' ? recording.notice.value : ''" />
    </section>
    <section v-if="desktop" class="settings-block">
      <h2>当前录像</h2>
      <p>{{ recording.state.value.phase === 'recording' ? `正在录制 · ${recording.elapsed.value}`
        : recording.state.value.phase === 'stopping' ? '正在保存…'
          : recording.state.value.phase === 'starting' ? '正在准备录制…'
            : recording.state.value.holdingResources ? '正在等待录制资源释放，请先结束共享。'
              : recording.state.value.saved ? '录像已保存' : '尚未录制' }}
        <template v-if="recording.state.value.bytes"> · {{ (recording.state.value.bytes / 1024 / 1024).toFixed(1) }} MiB</template>
      </p>
      <button v-if="recording.active.value" type="button" class="settings-button" :disabled="recording.state.value.phase === 'stopping'" @click="recording.stop">停止并保存</button>
      <button v-else type="button" class="confirm-button" :disabled="!sharing || recording.busy.value" @click="recording.start">开始录制</button>
      <InlineFeedback :message="recording.noticeTarget.value === 'recording' ? recording.notice.value : ''" />
    </section>
    <section v-if="desktop" class="settings-block">
      <h2>即时回放</h2>
      <p>共享时提前开启，即使忘记开始录制，也能保存最近一段画面。正在录制时同样可用，两者共用编码；保存回放不会中断录像，也不会自动上传。</p>
      <label class="replay-duration">回溯时长
        <select aria-label="回放目标时长" :value="recording.settings.value?.replaySeconds ?? 60"
          :disabled="recording.localActive.value || recording.busy.value"
          @change="changeReplay">
          <option :value="30">最近 30 秒</option><option :value="60">最近 60 秒</option><option :value="120">最近 120 秒</option>
        </select>
      </label>
      <small>保留现有画质，30／60／120 秒分别使用 256／512／1024 MiB 缓存预算，保存时可能额外持有一份片段。缓存攒满后尽量保留目标时长，关键帧对齐可能多约两秒；刚开启、换源或内存预算不足时只能保存已有部分。切换来源／规格后重新缓存，关闭后丢弃未保存内容。当前需先共享自己的画面，不会自动选择来源或开启。</small>
      <p role="status">{{ recording.state.value.replay?.phase === 'stopping' ? '正在关闭回放，已提交的保存仍会收尾…'
        : recording.state.value.replay?.saving ? '正在保存回放…'
          : recording.state.value.replay?.phase === 'starting' ? '正在准备回放…'
            : recording.replayActive.value ? recording.state.value.replay?.warming ? '正在积累回放，尚未达到目标时长' : '回放缓存已开启' : '回放缓存未开启' }}</p>
      <div class="recording-actions">
        <button v-if="!recording.replayActive.value" type="button" class="confirm-button" :disabled="!sharing || recording.busy.value" @click="recording.startReplay">开启回放</button>
        <template v-else>
          <button type="button" class="confirm-button" :disabled="recording.busy.value || recording.state.value.replay?.saving || !!recording.state.value.replay?.error" @click="recording.saveReplay">保存回放</button>
          <button type="button" class="settings-button" :disabled="recording.busy.value" @click="recording.stopReplay">关闭回放</button>
        </template>
      </div>
      <InlineFeedback :message="recording.noticeTarget.value === 'replay' ? recording.notice.value : ''" />
    </section>
    <RecordingLibrary v-if="desktop" :status="recording.state.value" />
  </div>
</template>

<style scoped>
.recording-directory { overflow-wrap: anywhere; color: var(--muted); }
.recording-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.replay-duration { display: flex; align-items: center; gap: 12px; font-size: 13px; }
</style>
