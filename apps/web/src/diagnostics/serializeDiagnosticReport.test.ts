import { expect, it, vi } from 'vitest';
import { serializeDiagnosticReport } from './serializeDiagnosticReport';

it('分批序列化完整保留报告字段、样本顺序、转义和空记录，不改变导出内容', async () => {
  const samples = Array.from({ length: 900 }, (_, index) => ({ index, text: '中文\n"\\', value: index % 2 ? null : 0 }));
  const report = { kind: 'lycansync-diagnostics', notes: '说明', samples, summary: { median: 60 } };
  const yieldControl = vi.fn(async () => {});
  expect(JSON.parse(await serializeDiagnosticReport(report, yieldControl))).toEqual(report);
  expect(yieldControl).toHaveBeenCalledTimes(14);
  expect(JSON.parse(await serializeDiagnosticReport({ ...report, samples: [] }))).toEqual({ ...report, samples: [] });
});

it('大报告处理中可执行其他任务，异常不会生成部分成功报告', async () => {
  const samples = Array.from({ length: 130 }, (_, index) => ({ index }));
  const order: string[] = [];
  const pending = serializeDiagnosticReport({ samples }).then(text => { order.push('saved'); return text; });
  await Promise.resolve();
  order.push('other-task');
  expect(JSON.parse(await pending).samples).toEqual(samples);
  expect(order).toEqual(['other-task', 'saved']);
  await expect(serializeDiagnosticReport({ samples }, async () => { throw new Error('interrupted'); })).rejects.toThrow('interrupted');
});

it('分批完成或样本序列化失败都会关闭消息端口', async () => {
  const Original = MessageChannel;
  const closed: ReturnType<typeof vi.fn>[] = [];
  vi.stubGlobal('MessageChannel', class extends Original {
    constructor() {
      super();
      closed.push(vi.spyOn(this.port1, 'close'), vi.spyOn(this.port2, 'close'));
    }
  });
  try {
    const samples = Array.from({ length: 65 }, (_, index) => ({ index }));
    await serializeDiagnosticReport({ samples });
    await expect(serializeDiagnosticReport({ samples: [...samples, {
      toJSON() { throw new Error('invalid sample'); },
    }] })).rejects.toThrow('invalid sample');
    expect(closed).toHaveLength(4);
    closed.forEach(close => expect(close).toHaveBeenCalledOnce());
  } finally { vi.unstubAllGlobals(); }
});
