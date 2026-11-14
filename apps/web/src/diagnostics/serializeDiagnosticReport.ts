type DiagnosticReport = { samples: readonly unknown[]; [key: string]: unknown };

// 记录有容量上限，但一次序列化整段多人记录仍会阻塞界面；分批让出事件循环，不增加常驻缓存或工作线程。
export async function serializeDiagnosticReport(report: DiagnosticReport,
  yieldControl?: () => Promise<void>) {
  const { samples, ...metadata } = report;
  const chunks: string[] = [];
  let channel: MessageChannel | undefined;
  // 消息任务不受后台定时器节流影响，退出时的补存也不必逐批等待定时器。
  const pause = yieldControl ?? (() => new Promise<void>(resolve => {
    channel ??= new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  }));
  try {
    for (let offset = 0; offset < samples.length; offset += 64) {
      if (offset) await pause();
      chunks.push(JSON.stringify(samples.slice(offset, offset + 64)).slice(1, -1));
    }
    const fields = JSON.stringify(metadata).slice(1, -1);
    return `{${fields ? fields + ',' : ''}"samples":[${chunks.join(',')}]}`;
  } finally {
    channel?.port1.close();
    channel?.port2.close();
  }
}
