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
  const props = reactive({ connected: true, choosingSource: false, sharing: true, shareBusy: false, quality: 'standard' as ScreenShareQualityId });
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
    toggleMenu, toggleQuality, chooseQuality, escape, dismiss, dismissAfterFocus })`, {
    ref, watch, nextTick, onScopeDispose, document, window, onMounted: () => {}, defineProps: () => props,
    withDefaults: (value: unknown) => value, defineEmits: () => emit, DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY,
  })) as { root: Ref<unknown>; menu: Ref<string | null>; qualityOpen: Ref<boolean>; qualityPlacement: Ref<string>;
    toggleMenu(kind: string, event: unknown): Promise<void>; toggleQuality(): Promise<void>; chooseQuality(id: string): void;
    escape(event: unknown): void; dismiss(event: unknown): void; dismissAfterFocus(event: unknown): void };
  controls.root.value = root;
  return { scope, props, controls, opener, emit, inputs, focus, root };
}

it.each([[1280, 1000, 'left'], [1280, 350, 'right'], [700, 500, 'compact'], [400, 350, 'compact']])(
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
  for (const placement of ['left', 'compact']) {
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
    expect(html.indexOf('value="highFrameRate"')).toBeLessThan(html.indexOf('value="standard"'));
    expect(html.indexOf('value="standard"')).toBeLessThan(html.indexOf('value="economy"'));
    expect(html.indexOf('value="economy"')).toBeLessThan(html.indexOf('value="custom"'));
    expect(html).not.toContain('180 FPS');
    const actions = html.match(/<section[^>]*call-share-actions[^>]*>/)?.[0];
    expect(actions?.includes('display:none')).toBe(placement === 'compact');
  }
});
