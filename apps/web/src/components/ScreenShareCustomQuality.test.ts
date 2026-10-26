import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import { renderToString } from '@vue/server-renderer';
import ts from 'typescript';
import { computed, createSSRApp, effectScope, nextTick, reactive, ref, watch, type Ref } from 'vue';
import { expect, it, vi } from 'vitest';
import ScreenShareCustomQuality from './ScreenShareCustomQuality.vue';
import { SCREEN_SHARE_BITRATE_MIN_MBPS, SCREEN_SHARE_BITRATE_MAX_MBPS, SCREEN_SHARE_BITRATE_STEP_MBPS,
  screenShareQuality, validateCustomScreenShareQuality, type CustomScreenShareQuality } from '../rtc/screenShareQuality';

const script = parse(readFileSync(new URL('./ScreenShareCustomQuality.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const source = ts.createSourceFile('CustomQuality.ts', script, ts.ScriptTarget.Latest, true);
const compiled = ts.transpile(source.statements.filter(statement => !ts.isImportDeclaration(statement))
  .map(statement => statement.getText(source)).join('\n'), { target: ts.ScriptTarget.ES2022 });

function setup(quality: CustomScreenShareQuality = { resolution: 1080, fps: 60 }) {
  const scope = effectScope();
  const props = reactive({ modelValue: quality, disabled: false });
  const emit = vi.fn();
  // 运行正式组件的回调和监听，不创建浏览器、房间或设备。
  const controls = scope.run(() => runInNewContext(`${compiled}\n({ update, applyBitrate, resetBitrate, bitrateDraft, bitrateError })`, {
    computed, ref, watch, defineProps: () => props, defineEmits: () => emit,
    screenShareQuality, validateCustomScreenShareQuality,
    SCREEN_SHARE_BITRATE_MIN_MBPS, SCREEN_SHARE_BITRATE_MAX_MBPS, SCREEN_SHARE_BITRATE_STEP_MBPS,
  })) as { update(field: 'resolution' | 'fps', event: Event): void; applyBitrate(): void; resetBitrate(): void;
    bitrateDraft: Ref<string>; bitrateError: Ref<string> };
  return { scope, props, emit, controls };
}

it('码率默认折叠，显示推荐与非固定流量说明，移除未实现的自动调整入口', async () => {
  const html = await renderToString(createSSRApp(ScreenShareCustomQuality, { modelValue: { resolution: 1080, fps: 60 } }));
  expect(html.match(/<details[^>]*>/)?.[0]).not.toContain('open');
  expect(html).toContain('主画面码率上限');
  expect(html).toContain('推荐 12 Mbps');
  expect(html).toContain('不是固定流量');
  expect(html).not.toContain('根据网络状况自动调整');
  expect(html).not.toContain('value="360"');
});

it('编辑不提前应用，点击应用才发出手动配置；修改尺寸保留手动上限', async () => {
  const { scope, props, emit, controls } = setup();
  try {
    controls.bitrateDraft.value = '6';
    expect(emit).not.toHaveBeenCalled();
    controls.applyBitrate();
    expect(emit).toHaveBeenLastCalledWith('update:modelValue', { resolution: 1080, fps: 60, bitrateMbps: 6 });
    expect(props.modelValue).not.toHaveProperty('bitrateMbps');
    props.modelValue = { resolution: 1080, fps: 60, bitrateMbps: 6 };
    await nextTick();
    const target = { value: '1440' };
    controls.update('resolution', { target } as unknown as Event);
    expect(target.value).toBe('1080');
    expect(emit).toHaveBeenLastCalledWith('update:modelValue', { resolution: 1440, fps: 60, bitrateMbps: 6 });
    props.modelValue = { resolution: 1440, fps: 120, bitrateMbps: 6 };
    await nextTick();
    expect(controls.bitrateDraft.value).toBe('6');
    controls.resetBitrate();
    expect(emit).toHaveBeenLastCalledWith('update:modelValue', { resolution: 1440, fps: 120 });
    expect(props.modelValue.bitrateMbps).toBe(6);
  } finally { scope.stop(); }
});

it.each(['', '0', '0.75', '51', 'Infinity'])('非法输入 %s 留在局部错误区，不提交或钳成另一个值', (value) => {
  const { scope, controls, emit } = setup();
  try {
    controls.bitrateDraft.value = value;
    controls.applyBitrate();
    expect(controls.bitrateError.value).toContain('0.5–50 Mbps');
    expect(emit).not.toHaveBeenCalled();
  } finally { scope.stop(); }
});

it('忙碌时提交和恢复推荐均不能触发新操作', () => {
  const { scope, props, controls, emit } = setup({ resolution: 1080, fps: 60, bitrateMbps: 6 });
  try {
    props.disabled = true;
    controls.bitrateDraft.value = '10';
    controls.applyBitrate();
    controls.resetBitrate();
    expect(emit).not.toHaveBeenCalled();
  } finally { scope.stop(); }
});
