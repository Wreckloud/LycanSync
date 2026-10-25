import { createSSRApp, ref } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import DiagnosticReportSettings from './DiagnosticReportSettings.vue';
import type { useDiagnosticReport } from '../../diagnostics/useDiagnosticReport';

afterEach(() => vi.unstubAllGlobals());

it.each([true, false])('自动记录为 %s 时开关、导出和手动操作保持一致', async (automatic) => {
  vi.stubGlobal('window', { lycanDesktop: {} });
  const report = { recording: ref(true), automaticEnabled: ref(automatic), discardedSamples: ref(2),
    sampleCount: ref(10), reason: ref(''), error: ref(''), saving: ref(false), notes: ref(''),
    setAutomatic: vi.fn(), start: vi.fn(), stop: vi.fn(), save: vi.fn() } as unknown as ReturnType<typeof useDiagnosticReport>;
  const html = await renderToString(createSSRApp(DiagnosticReportSettings, { report, canStart: false }));
  expect(html).toContain('aria-label="自动记录诊断"');
  expect(html).toMatch(automatic ? /aria-label="自动记录诊断" checked/ : /aria-label="自动记录诊断"(?! checked)/);
  const exportButton = html.match(/<button[^>]*>导出报告<\/button>/)?.[0];
  expect(exportButton).toBeDefined();
  expect(exportButton!.includes('disabled')).toBe(!automatic);
  expect(html.includes('结束记录</button>')).toBe(!automatic);
  expect(html).toContain('不录制音视频，不自动上传');
});
