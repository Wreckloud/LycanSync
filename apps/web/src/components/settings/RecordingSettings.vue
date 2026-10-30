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
</script>

<template>
  <div class="settings-section">
    <p class="settings-intro">保存自己正在共享的画面。录制在本机完成，不录入其他人的共享轨道，也不会自动上传。</p>
    <section class="settings-block">
      <h2>录制内容</h2>
      <template v-if="desktop && recording.settings.value">
        <label v-for="item in ([{ key: 'applicationAudio', title: '应用声音', detail: '窗口录入所选应用；整屏录入本机其他应用，排除本软件播放的声音。与共享声音开关分开。' },
          { key: 'microphone', title: '自己的麦克风', detail: '使用当前麦克风声音，不会自动解除静音。' },
          { key: 'friends', title: '朋友的语音', detail: '只录入当前收听的语音，不包括对方的共享声音。' }] as const)"
          :key="item.key" class="settings-toggle">
          <span><strong>{{ item.title }}</strong><small>{{ item.detail }}</small></span>
          <input type="checkbox" :checked="recording.settings.value[item.key]" :disabled="recording.active.value || recording.busy.value"
            @change="toggle(item.key, $event)" />
        </label>
      </template>
      <p v-else>{{ desktop ? '正在读取录制设置…' : '录制需要使用 Windows 桌面客户端。' }}</p>
    </section>
    <section v-if="desktop" class="settings-block">
      <h2>文件与画质</h2>
      <p>按来源比例确定尺寸，不超过共享分辨率上限，沿用所选帧率。硬件 H.264 编码、推荐质量，保存为 MKV。网络码率不会直接限制录像质量。</p>
      <p class="recording-directory">{{ recording.settings.value?.directory ?? '—' }}</p>
      <div class="recording-actions">
        <button type="button" class="settings-button" :disabled="recording.active.value || recording.busy.value" @click="recording.chooseDirectory">更换目录</button>
        <button type="button" class="settings-button" @click="recording.reveal">打开目录</button>
      </div>
      <small>选择整屏时，屏幕上可见的观看窗口也会入镜；只想录游戏时，请选择游戏或应用窗口。系统若只支持完整混音，需关闭应用声音选项后录制。</small>
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
      <InlineFeedback :message="recording.notice.value" />
    </section>
    <RecordingLibrary v-if="desktop" :status="recording.state.value" />
  </div>
</template>

<style scoped>
.recording-directory { overflow-wrap: anywhere; color: var(--muted); }
.recording-actions { display: flex; gap: 8px; }
</style>
