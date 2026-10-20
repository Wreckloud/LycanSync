<script setup lang="ts">
import { computed } from 'vue';
import type { Room } from 'livekit-client';
import { formatTrackTarget } from '../rtc/mediaStats';
import type { MediaDiagnosticsSnapshot } from '../diagnostics/mediaDiagnostics';

const props = defineProps<{ room: Room; statistics: MediaDiagnosticsSnapshot | null }>();
const streams = computed(() => props.statistics?.streams ?? []);
const error = computed(() => props.statistics?.failures.length ? '部分统计暂时无法读取，缺失值不代表零。' : '');
const processMetrics = computed(() => props.statistics?.process ?? null);
function formatFpsInterval(intervalMs: number | null) {
  if (intervalMs === null) return '等待统计';
  const seconds = intervalMs / 1000;
  return seconds > 3 ? `约 ${Math.round(seconds)} 秒区间均值` : `约 ${seconds.toFixed(1)} 秒区间`;
}
</script>

<template>
  <aside class="media-diagnostics" aria-label="媒体诊断">
    <strong>媒体诊断 <small>每 2 秒更新</small></strong>
    <p v-if="error" role="status">{{ error }}</p>
    <p v-if="processMetrics">Electron 进程（不含原生 helper）：CPU {{ processMetrics.cpuPercent }}% · 工作集合计 {{ processMetrics.memoryMb }} MB</p>
    <p v-if="statistics?.native?.state === 'running'">{{ statistics.native.captureBackend === 'obsLibobs' ? 'OBS 计数区间 FPS' : '原生采集计数区间 FPS' }}：
      <template v-if="statistics.nativeInterval">{{ statistics.native?.captureBackend === 'obsLibobs' ? 'OBS 渲染回调' : '收到' }} {{ statistics.nativeInterval.receivedFps }} ·
        {{ statistics.native?.captureBackend === 'obsLibobs' ? '宿主发帧' : '处理' }} {{ statistics.nativeInterval.processedFps }} · {{ formatFpsInterval(statistics.nativeInterval.elapsedMs) }}</template>
      <template v-else>等待统计</template>
    </p>
    <small v-if="statistics?.native?.captureBackend === 'obsLibobs'">本次 OBS 会话槽位累计丢帧 {{ statistics.native.obsBridgeDroppedFrames ?? '—' }}；发帧计数截至宿主事件，不代表 Electron 导入或编码成功。</small>
    <div v-for="stream in streams" :key="stream.identity" class="media-diagnostic-stream">
      <b>{{ stream.name }} · {{ stream.direction }}</b>
      <small v-if="stream.target">共享源 {{ stream.target.displaySurface ?? '未知' }} · 轨道设置（目标） {{ formatTrackTarget(stream.target) }}</small>
      <small v-if="stream.direction === '发送'">采集源累计 {{ stream.sourceFrames ?? '—' }} 帧 ·
        编码前采集 {{ stream.sourceFps ?? '等待统计' }} fps ·
        {{ formatFpsInterval(stream.sourceIntervalMs) }}</small>
      <small v-if="stream.direction === '发送' && !stream.nativeInput">页面收到/提交计数：此采集来源未提供。</small>
      <small v-if="stream.nativeInput">页面累计提交 {{ stream.nativeInput.submittedFrames }} 帧 ·
        写入背压丢弃 {{ stream.nativeInput.backpressureDroppedFrames }} 帧 ·
        最小化提示画面 {{ stream.nativeInput.placeholderFrames }} 帧</small>
      <small v-if="stream.nativeInput && stream.nativeInputInterval">
        页面收到 {{ stream.nativeInputInterval.receivedFps }} fps · 页面提交 {{ stream.nativeInputInterval.submittedFps }} fps ·
        {{ formatFpsInterval(stream.nativeInputInterval.elapsedMs) }}
        <template v-if="stream.nativeInputInterval.backpressureDropRate !== null">
          · 背压丢弃 {{ stream.nativeInputInterval.backpressureDropRate }}%
        </template>
      </small>
      <small v-else-if="stream.nativeInput">页面帧率与背压比例等待下一份可比较样本。</small>
      <small v-if="stream.subscription.subscribed === false">本机尚未订阅此路共享。</small>
      <small v-else-if="stream.subscription.enabled === false">本机已暂停接收此路共享。</small>
      <small v-if="stream.playbackFps !== null">累计显示 {{ stream.playbackFrames ?? '—' }} 帧 ·
        画面显示 {{ stream.playbackFps }} fps ·
        {{ formatFpsInterval(stream.playbackIntervalMs) }} · 累计显示丢帧 {{ stream.playbackDrops }}</small>
      <small v-else-if="stream.direction === '接收' && stream.subscription.subscribed !== false">本机播放 FPS 等待统计。</small>
      <small v-if="stream.layers.length === 0 && stream.subscription.subscribed === false">尚未订阅此路视频，暂无编解码统计。</small>
      <small v-else-if="stream.layers.length === 0">等待编解码统计…</small>
      <small v-for="layer in stream.layers" :key="layer.id">
        {{ layer.size }} · {{ layer.fps ?? '等待统计' }} fps · {{ formatFpsInterval(layer.intervalMs) }} ·
        累计 {{ layer.frameCount ?? '—' }} 帧 · {{ layer.bitrateKbps ?? '—' }} kbps · {{ layer.codec }}
        <template v-if="layer.active === false"> · 编码层已停用</template>
        <template v-else-if="layer.limitation"> · 受限 {{ layer.limitation }}（不能单独作为故障结论）</template>
        <template v-if="layer.lostPackets !== null"> · 累计丢包 {{ layer.lostPackets }}</template>
        <template v-if="layer.droppedFrames !== null"> · 累计解码丢帧 {{ layer.droppedFrames }}</template>
        <template v-if="layer.averageEncodeMs !== null"> · 编码 {{ layer.averageEncodeMs }} ms/帧</template>
        <template v-if="layer.encoder"> · 编码器 {{ layer.encoder }}</template>
      </small>
    </div>
  </aside>
</template>
