import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule } from 'typescript';
import { expect, it, vi } from 'vitest';
import { createNativeVideoSourceSelection } from './components/nativeVideoSourceSelection';
import { canSelectNativeSource, shouldShareAudioInNativeSelection } from './rtc/nativeScreenAudioMode';

const source = readFileSync(new URL('./App.vue', import.meta.url), 'utf8');
const start = source.indexOf('function selectCaptureSource(');
const end = source.indexOf('function requestNativeScreenSource(', start);
const script = transpileModule(source.slice(start, end), {}).outputText;

function selection() {
  const chooser = createNativeVideoSourceSelection([{ sourceId: 'window:1', kind: 'window', title: '游戏',
    width: 1280, height: 720, primary: false }]);
  const saveScreenShareQuality = vi.fn(() => { throw new Error('storage unavailable'); });
  const context = {
    captureRequest: { value: { sources: chooser.options } as { sources: typeof chooser.options } | null },
    nativeSourceChooser: chooser as typeof chooser | undefined,
    nativeSourceError: { value: '' }, captureAudioCapabilityReady: { value: true },
    captureAudioCapabilityFailed: { value: false }, captureSourceType: { value: 'window' },
    captureQuality: { value: 'standard' }, captureAudioMode: { value: 'process' },
    captureShareAudio: { value: true }, currentNativeDiscoveryId: 'discovery', lastCaptureSourceType: 'screen',
    viewerNotice: { value: '' }, lastNativeSelection: undefined,
    canSelectNativeSource, shouldShareAudioInNativeSelection,
    stopNativeSourceRefresh: vi.fn(), saveScreenShareQuality,
    localStorage: { setItem: vi.fn(() => { throw new Error('storage unavailable'); }) },
    selectCaptureSource: undefined as unknown as (id: string | null) => void,
  };
  runInNewContext(script, context);
  return { chooser, context };
}

it('取消来源选择不写偏好，存储失效也能结束等待并清理选择器', async () => {
  const { chooser, context } = selection();
  context.selectCaptureSource(null);
  expect(await chooser.result).toBe(null);
  expect(context.captureRequest.value).toBe(null);
  expect(context.stopNativeSourceRefresh).toHaveBeenCalledOnce();
  expect(context.saveScreenShareQuality).not.toHaveBeenCalled();
  expect(context.localStorage.setItem).not.toHaveBeenCalled();
});

it('确认选择的偏好写入失败不阻断共享，明确提示未保存', async () => {
  const { chooser, context } = selection();
  context.selectCaptureSource('window:1');
  expect(await chooser.result).toEqual({ sourceId: 'window:1', quality: 'standard', shareAudio: true });
  expect(context.captureRequest.value).toBe(null);
  expect(context.captureAudioCapabilityReady.value).toBe(false);
  expect(context.viewerNotice.value).toBe('本次共享设置已生效，但无法保存到本机。');
});
