<script setup lang="ts">
import { computed } from 'vue';
import type { Room } from 'livekit-client';
import { formatTrackTarget } from '../rtc/mediaStats';
import type { MediaDiagnosticsSnapshot } from '../diagnostics/mediaDiagnostics';

const props = defineProps<{ room: Room; statistics: MediaDiagnosticsSnapshot | null }>();
const streams = computed(() => props.statistics?.streams ?? []);
const error = computed(() => props.statistics?.failures.length ? '部分统计暂时无法读取，缺失值不代表零。' : '');
const processMetrics = computed(() => props.statistics?.process ?? null);
const processLabels = { 'electron-Browser': 'Electron 主进程', 'electron-Tab': '界面进程', 'electron-GPU': 'GPU 进程',
  'electron-Utility': '工具进程', 'electron-other': '其他 Electron 进程', obs: 'OBS 宿主', media: '媒体辅助进程', activity: '动态检测进程' };
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
    <template v-if="processMetrics">
      <p>Electron CPU {{ processMetrics.cpuPercent }}% · 工作集合计 {{ processMetrics.memoryMb }} MiB（不含下列原生进程）</p>
      <p v-for="(entry, index) in processMetrics.entries" :key="index">
        {{ processLabels[entry.role] }}：
        <template v-if="entry.state === 'running'">工作集 {{ entry.workingSetMiB ?? '—' }} MiB · 私有提交 {{ entry.privateCommitMiB ?? '—' }} MiB</template>
        <template v-else>{{ entry.state === 'stopped' ? '未运行' : '统计不可用' }}</template>
      </p>
      <small>工作集含共享页，不能简单相加当作物理内存；私有提交不等于驻留 RAM。不包含显存，未运行与读取失败不计作零。</small>
    </template>
    <p v-if="statistics?.native?.state === 'running'">{{ statistics.native.captureBackend === 'obsLibobs' ? 'OBS 计数区间 FPS' : '原生采集计数区间 FPS' }}：
      <template v-if="statistics.nativeInterval">{{ statistics.native?.captureBackend === 'obsLibobs' ? 'OBS 渲染回调' : '收到' }} {{ statistics.nativeInterval.receivedFps }} ·
        {{ statistics.native?.captureBackend === 'obsLibobs' ? '宿主发帧' : '处理' }} {{ statistics.nativeInterval.processedFps }} · {{ formatFpsInterval(statistics.nativeInterval.elapsedMs) }}</template>
      <template v-else>等待统计</template>
    </p>
    <small v-if="statistics?.native?.captureBackend === 'obsLibobs'">本次 OBS 会话槽位累计丢帧 {{ statistics.native.obsBridgeDroppedFrames ?? '—' }}；发帧计数截至宿主事件，不代表 Electron 导入或编码成功。</small>
    <template v-if="statistics?.native?.state === 'running' && statistics.native.captureBackend === 'obsLibobs'">
      <p>OBS 渲染循环：
        <template v-if="statistics.obsRenderInterval">{{ statistics.obsRenderInterval.renderedFps }} FPS · 区间延误 {{ statistics.obsRenderInterval.laggedFrames }} / {{ statistics.obsRenderInterval.totalFrames }} 个时隙 · {{ formatFpsInterval(statistics.obsRenderInterval.elapsedMs) }}</template>
        <template v-else>等待统计</template>
      </p>
      <small>OBS 最近约一秒均值：{{ statistics.native.obsRender?.activeFps?.toFixed(1) ?? '—' }} FPS · 渲染 {{ statistics.native.obsRender?.averageRenderMs?.toFixed(2) ?? '—' }} ms。仅反映渲染循环，不代表不同来源帧、编码或端到端延迟。</small>
    </template>
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
        {{ layer.size }} · {{ stream.direction === '发送' ? '编码' : '解码' }} {{ layer.fps ?? '等待统计' }} fps · {{ formatFpsInterval(layer.intervalMs) }} ·
        累计 {{ layer.frameCount ?? '—' }} 帧 · {{ layer.bitrateKbps ?? '—' }} kbps · {{ layer.codec }}
        <template v-if="layer.active === false"> · 编码层已停用</template>
        <template v-else-if="layer.limitation"> · 受限 {{ layer.limitation }}（不能单独作为故障结论）</template>
        <template v-if="layer.lostPackets !== null"> · 累计丢包 {{ layer.lostPackets }}</template>
        <template v-if="layer.droppedFrames !== null"> · 累计接收丢帧 {{ layer.droppedFrames }}</template>
        <template v-if="layer.averageEncodeMs !== null"> · 编码 {{ layer.averageEncodeMs }} ms/帧</template>
        <template v-if="layer.encoder"> · 编码器 {{ layer.encoder }}</template>
        <template v-if="stream.direction === '发送'"> · 节能编码标志 {{ layer.powerEfficientEncoder === null ? '未知' : layer.powerEfficientEncoder ? '是' : '否' }}（非硬件编码结论）</template>
        <template v-if="layer.roundTripMs !== null"> · 到 SFU RTT {{ layer.roundTripMs }} ms</template>
        <template v-if="layer.receiverReportedLossPercent !== null"> · SFU 报告丢包 {{ layer.receiverReportedLossPercent }}%</template>
        <template v-if="layer.feedbackAgeMs !== null"> · 接收报告距今 {{ layer.feedbackAgeMs }} ms</template>
        <template v-if="layer.receiveLossPercent !== null"> · 接收区间丢包 {{ layer.receiveLossPercent }}%</template>
        <template v-if="layer.jitterBufferMs !== null"> · 接收缓冲 {{ layer.jitterBufferMs }} ms/帧</template>
      </small>
      <small v-if="stream.direction === '发送' && stream.layers.length && stream.layers.every(layer => layer.roundTripMs === null && layer.receiverReportedLossPercent === null)">本次采样没有新的接收报告，不代表网络正常或异常。</small>
    </div>
    <small>网络数据仅描述本机与 SFU 之间的一段；RTT 和接收缓冲等待都不是端到端画面延迟。</small>
  </aside>
</template>
