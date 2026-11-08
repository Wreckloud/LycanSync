import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import { renderToString } from '@vue/server-renderer';
import ts from 'typescript';
import { createSSRApp, effectScope, nextTick, onScopeDispose, reactive, ref, watch, type Ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import CallControls from './CallControls.vue';
import { DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY, type ScreenShareQualityId } from '../rtc/screenShareQuality';

const script = parse(readFileSync(new URL('./CallControls.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const source = ts.createSourceFile('CallControls.ts', script, ts.ScriptTarget.Latest, true);
const compiled = ts.transpile(source.statements.filter(statement => !ts.isImportDeclaration(statement))
  .map(statement => statement.getText(source)).join('\n'), { target: ts.ScriptTarget.ES2022 });

afterEach(() => vi.unstubAllGlobals());

function setup(width = 1280, right = 1000) {
  const props = reactive({ desktop: true, connected: true, choosingSource: false, sharing: true, shareBusy: false, shareLimitReached: false, quality: 'standard' as ScreenShareQualityId,
    shortcutsReady: true, shortcutsBusy: false, shortcutsSupported: true, pushToTalkBinding: '' });
  const focus = vi.fn();
  const inputs = [{ value: 'standard', checked: false }, { value: 'custom', checked: true }];
  const root = { contains: (target: unknown) => target === 'inside', closest: () => ({ getBoundingClientRect: () => ({ top: 700 }) }),
    querySelector: vi.fn(() => ({ focus })), querySelectorAll: () => inputs };
  const opener = { focus: vi.fn(), closest: () => ({ getBoundingClientRect: () => ({ top: 700, right }) }) };
  const emit = vi.fn();
  vi.stubGlobal('document', { querySelector: () => ({ getBoundingClientRect: () => ({ bottom: 43 }) }), removeEventListener: vi.fn() });
  vi.stubGlobal('window', { innerWidth: width, matchMedia: () => ({ matches: width <= 600 }), removeEventListener: vi.fn() });
  const scope = effectScope();
  // 执行正式菜单回调，仅替换 DOM 边界；不连接房间、采集或启动客户端。
  const controls = scope.run(() => runInNewContext(`${compiled}\n({ root, menu, qualityOpen, qualityPlacement,
    recordingOpen, toggleRecordingMenu, changeVoiceMode, toggleMenu, toggleQuality, chooseQuality, escape, dismiss, dismissAfterFocus, prepareShare, scheduleShareIntent, cancelShareIntent })`, {
    setTimeout, clearTimeout,
    ref, watch, nextTick, onScopeDispose, document, window, onMounted: () => {}, defineProps: () => props,
    withDefaults: (value: unknown) => value, defineEmits: () => emit, DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY,
  })) as { root: Ref<unknown>; menu: Ref<string | null>; qualityOpen: Ref<boolean>; qualityPlacement: Ref<string>;
    recordingOpen: Ref<boolean>; toggleRecordingMenu(): Promise<void>; changeVoiceMode(mode: string): void;
    toggleMenu(kind: string, event: unknown): Promise<void>; toggleQuality(): Promise<void>; chooseQuality(id: string): void;
    escape(event: unknown): void; dismiss(event: unknown): void; dismissAfterFocus(event: unknown): void;
    prepareShare(): void; scheduleShareIntent(): void; cancelShareIntent(): void };
  controls.root.value = root;
  return { scope, props, controls, opener, emit, inputs, focus, root };
}

it('共享意图停留 300ms 才预取，移出或销毁取消，键盘聚焦可立即准备', async () => {
  vi.useFakeTimers();
  const f = setup();
  f.props.sharing = false;
  try {
    f.controls.scheduleShareIntent();
    await vi.advanceTimersByTimeAsync(299);
    expect(f.emit).not.toHaveBeenCalled();
    f.controls.cancelShareIntent();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.emit).not.toHaveBeenCalled();
    f.controls.scheduleShareIntent();
    await vi.advanceTimersByTimeAsync(300);
    expect(f.emit).toHaveBeenCalledWith('prepareShare');
    f.emit.mockClear();
    f.props.shareBusy = true;
    f.controls.prepareShare();
    expect(f.emit).not.toHaveBeenCalled();
    f.props.shareBusy = false;
    f.controls.prepareShare();
    expect(f.emit).toHaveBeenCalledWith('prepareShare');
    f.emit.mockClear();
    f.controls.scheduleShareIntent();
    f.scope.stop();
    await vi.advanceTimersByTimeAsync(300);
    expect(f.emit).not.toHaveBeenCalled();
  } finally { f.scope.stop(); vi.useRealTimers(); }
});

it.each([[1280, 1000, 'compact'], [1280, 350, 'right'], [700, 500, 'compact'], [400, 350, 'compact']])(
  '宽 %s、锚点 %s 时二级菜单使用 %s，Esc 逐层返回并恢复焦点', async (width, right, placement) => {
    const f = setup(Number(width), Number(right));
    try {
      await f.controls.toggleMenu('share', { currentTarget: f.opener });
      expect(f.controls.qualityPlacement.value).toBe(placement);
      await f.controls.toggleQuality();
      expect(f.controls.qualityOpen.value).toBe(true);
      expect(f.root.querySelector).toHaveBeenLastCalledWith('.call-quality-options input:checked');
      const stopPropagation = vi.fn();
      f.controls.escape({ stopPropagation });
      await nextTick();
      expect(f.controls.qualityOpen.value).toBe(false);
      expect(f.controls.menu.value).toBe('share');
      await vi.waitFor(() => expect(f.root.querySelector).toHaveBeenLastCalledWith('.call-quality-trigger'));
      f.controls.escape({ stopPropagation });
      expect(f.controls.menu.value).toBeNull();
      expect(f.opener.focus).toHaveBeenCalled();
      expect(stopPropagation).toHaveBeenCalledTimes(2);
      expect(f.emit).not.toHaveBeenCalled();
    } finally { f.scope.stop(); }
  });

it('选择和同档重试只发出画质请求，确认前不伪造勾选；忙碌时不重复提交', async () => {
  const f = setup();
  try {
    f.controls.chooseQuality('custom');
    expect(f.emit).toHaveBeenLastCalledWith('quality', 'custom');
    expect(f.inputs.map(input => input.checked)).toEqual([true, false]);
    f.controls.chooseQuality('standard');
    expect(f.emit).toHaveBeenLastCalledWith('quality', 'standard');
    f.props.shareBusy = true;
    f.controls.chooseQuality('highFrameRate');
    expect(f.emit).toHaveBeenCalledTimes(2);
  } finally { f.scope.stop(); }
});

it('外部点击、切换菜单、选择来源及断线均清除二级菜单状态', async () => {
  const f = setup();
  try {
    for (const close of [() => f.controls.dismiss({ target: 'outside' }),
      () => f.controls.dismissAfterFocus({ relatedTarget: 'outside' }),
      () => f.controls.toggleMenu('microphone', { currentTarget: f.opener }),
      () => { f.props.choosingSource = true; }, () => { f.props.connected = false; }]) {
      f.props.choosingSource = false;
      f.props.connected = true;
      await nextTick();
      await f.controls.toggleMenu('share', { currentTarget: f.opener });
      await f.controls.toggleQuality();
      await close();
      await nextTick();
      expect(f.controls.qualityOpen.value).toBe(false);
      expect(f.emit).not.toHaveBeenCalled();
    }
  } finally { f.scope.stop(); }
});

it('实际模板把共享动作和画质分成两块，自定义最后；窄窗只显示二级面板', async () => {
  for (const placement of ['right', 'compact']) {
    const app = createSSRApp(CallControls, {
      connected: true, desktop: true, microphoneEnabled: false, microphoneIntent: false, microphoneBusy: false,
      microphoneLevel: 0, inputLevelPercent: 0, listening: true, inputGain: 1, outputVolume: 1,
      sharing: true, shareBusy: false, choosingSource: false, shareLimitReached: false,
      quality: 'custom', customQuality: { resolution: 1440, fps: 120 }, shareAudio: false, audioMode: 'process',
    });
    app.mixin({ created() {
      Object.assign(this.$.setupState, { menu: 'share', qualityOpen: true, qualityPlacement: placement });
    } });
    const html = await renderToString(app);
    expect(html).toContain('call-share-actions');
    expect(html).toContain('call-quality-menu');
    expect(html.includes('aria-label="返回共享选项"')).toBe(placement === 'compact');
    expect(html.indexOf('value="highFrameRate"')).toBeLessThan(html.indexOf('value="standard"'));
    expect(html.indexOf('value="standard"')).toBeLessThan(html.indexOf('value="economy"'));
    expect(html.indexOf('value="economy"')).toBeLessThan(html.indexOf('value="custom"'));
    expect(html).not.toContain('180 FPS');
    const actions = html.match(/<section[^>]*call-share-actions[^>]*>/)?.[0];
    expect(actions?.includes('display:none')).toBe(placement === 'compact');
  }
});

it('共享菜单仅在回放已开启时提供保存，正在录像不限制保存，写入中禁止重复提交', async () => {
  for (const [replayActive, recordingActive, replaySaving] of [[false, true, false], [true, false, false], [true, true, false], [true, true, true]]) {
    const app = createSSRApp(CallControls, {
      connected: true, desktop: true, microphoneEnabled: false, microphoneIntent: false, microphoneBusy: false,
      microphoneLevel: 0, inputLevelPercent: 0, listening: true, inputGain: 1, outputVolume: 1,
      sharing: true, shareBusy: false, choosingSource: false, shareLimitReached: false,
      quality: 'standard', shareAudio: false, audioMode: 'process', replayActive, recordingActive, replaySaving,
    });
    app.mixin({ created() { Object.assign(this.$.setupState, { menu: 'share', recordingOpen: true }); } });
    const html = await renderToString(app);
    if (!replayActive) expect(html).not.toContain('保存回放');
    else {
      const button = html.match(/<button[^>]*>[^<]*保存回放[^<]*<\/button>/)?.[0];
      expect(button).toBeDefined();
      expect(button?.includes('disabled')).toBe(replaySaving);
    }
  }
});

it('未绑定按键时收起菜单再交给设置入口，已绑定时留在菜单，忙碌或不支持时不切换', async () => {
  const f = setup();
  try {
    await f.controls.toggleMenu('microphone', { currentTarget: f.opener });
    f.controls.changeVoiceMode('pushToTalk');
    expect(f.controls.menu.value).toBeNull();
    expect(f.emit).toHaveBeenLastCalledWith('voiceMode', 'pushToTalk', f.opener);
    f.props.pushToTalkBinding = 'F2';
    await f.controls.toggleMenu('microphone', { currentTarget: f.opener });
    f.controls.changeVoiceMode('pushToTalk');
    expect(f.controls.menu.value).toBe('microphone');
    f.emit.mockClear();
    f.props.shortcutsBusy = true;
    f.controls.changeVoiceMode('voice');
    f.props.shortcutsBusy = false;
    f.props.shortcutsSupported = false;
    f.controls.changeVoiceMode('pushToTalk');
    expect(f.emit).not.toHaveBeenCalled();
  } finally { f.scope.stop(); }
});

it('录制子菜单与画质互斥，Esc 返回入口并恢复焦点', async () => {
  const f = setup();
  try {
    await f.controls.toggleMenu('share', { currentTarget: f.opener });
    await f.controls.toggleQuality();
    await f.controls.toggleRecordingMenu();
    expect(f.controls.qualityOpen.value).toBe(false);
    expect(f.controls.recordingOpen.value).toBe(true);
    f.controls.escape({ stopPropagation: vi.fn() });
    await nextTick();
    expect(f.controls.recordingOpen.value).toBe(false);
    expect(f.controls.menu.value).toBe('share');
    await vi.waitFor(() => expect(f.root.querySelector).toHaveBeenLastCalledWith('.call-recording-trigger'));
  } finally { f.scope.stop(); }
});
