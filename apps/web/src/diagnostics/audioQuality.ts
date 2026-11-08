type AudioCounters = { id: string; timestamp: number; packetsReceived?: number; packetsLost?: number;
  totalSamplesReceived?: number; concealedSamples?: number; silentConcealedSamples?: number;
  concealmentEvents?: number; jitterBufferDelay?: number; jitterBufferEmittedCount?: number };

export function readAudioQuality(current: AudioCounters, previous: AudioCounters | undefined) {
  const elapsed = previous && current.id === previous.id ? current.timestamp - previous.timestamp : 0;
  const delta = (key: keyof Omit<AudioCounters, 'id' | 'timestamp'>) => {
    const now = current[key]; const before = previous?.[key];
    return elapsed > 0 && typeof now === 'number' && Number.isFinite(now)
      && typeof before === 'number' && Number.isFinite(before) && now >= before ? now - before : null;
  };
  const received = delta('packetsReceived'); const lost = delta('packetsLost');
  const samples = delta('totalSamplesReceived'); const concealed = delta('concealedSamples');
  const delay = delta('jitterBufferDelay'); const emitted = delta('jitterBufferEmittedCount');
  return {
    intervalMs: elapsed > 0 ? elapsed : null,
    receivedPackets: received, lostPackets: lost,
    lossPercent: received !== null && lost !== null && received + lost > 0 ? lost * 100 / (received + lost) : null,
    concealedSamples: concealed, silentConcealedSamples: delta('silentConcealedSamples'),
    concealmentEvents: delta('concealmentEvents'),
    concealmentPercent: samples !== null && samples > 0 && concealed !== null && concealed <= samples
      ? concealed * 100 / samples : null,
    jitterBufferMs: delay !== null && emitted !== null && emitted > 0 ? delay * 1000 / emitted : null,
  };
}

// 仅保留已知计数；轨道替换、统计重建和计数回退均重新建立区间。
export function audioCounters(stat: RTCStats): AudioCounters {
  const source = stat as RTCStats & Record<string, unknown>;
  const counters: AudioCounters = { id: stat.id, timestamp: stat.timestamp };
  for (const key of ['packetsReceived', 'packetsLost', 'totalSamplesReceived', 'concealedSamples',
    'silentConcealedSamples', 'concealmentEvents', 'jitterBufferDelay', 'jitterBufferEmittedCount'] as const) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) counters[key] = value;
  }
  return counters;
}
