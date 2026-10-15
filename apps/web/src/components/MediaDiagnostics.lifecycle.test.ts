import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, onScopeDispose, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { isStaleVideoSourceError, resetVideoSourceSelection } from './mediaDiagnosticsSources';

const script = parse(readFileSync(new URL('./MediaDiagnostics.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const sourceFile = ts.createSourceFile('MediaDiagnostics.ts', script, ts.ScriptTarget.Latest, true);
const callbacks = sourceFile.statements.filter((statement) => !ts.isImportDeclaration(statement)
  && !statement.getText(sourceFile).startsWith('onMounted('))
  .map((statement) => statement.getText(sourceFile)).join('\n');
const compiled = ts.transpile(callbacks, { target: ts.ScriptTarget.ES2022 });
const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => { scopes.splice(0).forEach((scope) => scope.stop()); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

function setup() {
  const scope = effectScope();
  scopes.push(scope);
  const diagnostics = { state: 'running', sessionId: 'probe', lastCaptureError: null };
  const bridge = {
    startNativeCaptureProbe: vi.fn(async () => ({ sessionId: 'probe' })),
    stopNativeCaptureProbe: vi.fn(async (_id: string) => {}),
    getNativeMediaDiagnostics: vi.fn(async () => diagnostics),
    listNativeVideoSources: vi.fn(async () => ({ sources: [] })),
  };
  const warn = vi.fn();
  // 执行正式面板回调、Vue 销毁清理；只替代采集 IPC，不启动 helper 或统计真实设备。
  const panel = scope.run(() => runInNewContext(`${compiled}\n({ startCaptureProbe, stopCaptureProbe,
    refreshCaptureProbeDiagnostics, captureProbeAvailable, selectedVideoSourceId, captureProbeSessionId,
    captureProbeState, captureProbeBusy, captureProbeError })`, {
    computed, ref, onScopeDispose, Error, isStaleVideoSourceError, resetVideoSourceSelection,
    defineProps: () => ({ room: { localParticipant: { getTrackPublication: () => undefined } }, participants: [] }),
    window: { lycanDesktop: bridge }, document: { removeEventListener: vi.fn() },
    console: { warn }, clearInterval, Track: { Source: { ScreenShare: 'screen' } },
  })) as {
    startCaptureProbe(): Promise<void>; stopCaptureProbe(): Promise<void>; refreshCaptureProbeDiagnostics(): Promise<void>;
    captureProbeAvailable: { value: boolean }; selectedVideoSourceId: { value: string };
    captureProbeSessionId: { value: string | null }; captureProbeState: { value: string };
    captureProbeBusy: { value: boolean }; captureProbeError: { value: string };
  };
  panel.captureProbeAvailable.value = true;
  panel.selectedVideoSourceId.value = 'window';
  return { panel, bridge, scope, warn };
}

it('启动已确认但首轮诊断仍在等待，关闭面板后仍停止探针', async () => {
  const { panel, bridge, scope } = setup();
  const pending = deferred<Awaited<ReturnType<typeof bridge.getNativeMediaDiagnostics>>>();
  const reading = deferred<void>();
  bridge.getNativeMediaDiagnostics.mockImplementationOnce(() => { reading.resolve(); return pending.promise; });
  const starting = panel.startCaptureProbe();
  await reading.promise;
  scope.stop();
  expect(bridge.stopNativeCaptureProbe).not.toHaveBeenCalled();
  pending.resolve({ state: 'running', sessionId: 'probe', lastCaptureError: null });
  await starting;
  expect(bridge.stopNativeCaptureProbe).toHaveBeenCalledExactlyOnceWith('probe');
  expect(panel.captureProbeSessionId.value).toBeNull();
  expect(bridge.getNativeMediaDiagnostics).toHaveBeenCalledOnce();
});

it('启动结果在销毁后返回，也清理取得的会话且不读取新诊断', async () => {
  const { panel, bridge, scope } = setup();
  const pending = deferred<{ sessionId: string }>();
  bridge.startNativeCaptureProbe.mockReturnValueOnce(pending.promise);
  const starting = panel.startCaptureProbe();
  scope.stop();
  pending.resolve({ sessionId: 'probe' });
  await starting;
  expect(bridge.stopNativeCaptureProbe).toHaveBeenCalledExactlyOnceWith('probe');
  expect(bridge.getNativeMediaDiagnostics).not.toHaveBeenCalled();
});

it('诊断失败保留采集会话，禁止重复启动且仍能停止', async () => {
  const { panel, bridge } = setup();
  bridge.getNativeMediaDiagnostics.mockRejectedValueOnce(new Error('diagnostics timeout'));
  await panel.startCaptureProbe();
  expect(panel.captureProbeSessionId.value).toBe('probe');
  expect(panel.captureProbeError.value).toContain('采集状态尚未确认');
  await panel.startCaptureProbe();
  expect(bridge.startNativeCaptureProbe).toHaveBeenCalledOnce();
  await panel.stopCaptureProbe();
  expect(bridge.stopNativeCaptureProbe).toHaveBeenCalledWith('probe');
  expect(panel.captureProbeSessionId.value).toBeNull();
});

it('停止拒绝保留会话供重试，不伪造释放成功', async () => {
  const { panel, bridge } = setup();
  await panel.startCaptureProbe();
  bridge.stopNativeCaptureProbe.mockRejectedValueOnce(new Error('stop timeout'));
  await panel.stopCaptureProbe();
  expect(panel.captureProbeSessionId.value).toBe('probe');
  expect(panel.captureProbeState.value).toBe('failed');
  expect(panel.captureProbeError.value).toContain('停止未确认');
  await panel.startCaptureProbe();
  expect(bridge.startNativeCaptureProbe).toHaveBeenCalledOnce();
  await panel.stopCaptureProbe();
  expect(panel.captureProbeSessionId.value).toBeNull();
});

it('停止已确认后，诊断读取失败不再报告为停止失败', async () => {
  const { panel, bridge } = setup();
  await panel.startCaptureProbe();
  bridge.getNativeMediaDiagnostics.mockRejectedValueOnce(new Error('diagnostics unavailable'));
  await panel.stopCaptureProbe();
  expect(panel.captureProbeSessionId.value).toBeNull();
  expect(panel.captureProbeState.value).toBe('idle');
  expect(panel.captureProbeError.value).toContain('探针已停止');
  expect(panel.captureProbeError.value).not.toContain('停止未确认');
});

it.each(['resolve', 'reject'] as const)('旧诊断%s不能清除新会话或覆盖其状态', async (result) => {
  const { panel, bridge } = setup();
  panel.captureProbeSessionId.value = 'old-probe';
  const pending = deferred<Awaited<ReturnType<typeof bridge.getNativeMediaDiagnostics>>>();
  bridge.getNativeMediaDiagnostics.mockReturnValueOnce(pending.promise);
  const reading = panel.refreshCaptureProbeDiagnostics();
  panel.captureProbeSessionId.value = 'new-probe';
  panel.captureProbeState.value = 'running';
  panel.captureProbeError.value = '新会话提示';
  if (result === 'resolve') pending.resolve({ state: 'idle', sessionId: '', lastCaptureError: null });
  else pending.reject(new Error('old diagnostics failed'));
  await reading;
  expect(panel.captureProbeSessionId.value).toBe('new-probe');
  expect(panel.captureProbeState.value).toBe('running');
  expect(panel.captureProbeError.value).toBe('新会话提示');
});

it('面板关闭后停止失败有固定诊断，并保留未确认状态', async () => {
  const { panel, bridge, scope, warn } = setup();
  const pending = deferred<{ sessionId: string }>();
  bridge.startNativeCaptureProbe.mockReturnValueOnce(pending.promise);
  bridge.stopNativeCaptureProbe.mockRejectedValueOnce(new Error('stop timeout'));
  const starting = panel.startCaptureProbe();
  scope.stop();
  pending.resolve({ sessionId: 'probe' });
  await starting;
  expect(panel.captureProbeSessionId.value).toBe('probe');
  expect(panel.captureProbeState.value).toBe('failed');
  expect(warn).toHaveBeenCalledExactlyOnceWith('诊断面板关闭后，视频探针停止未确认。');
});
