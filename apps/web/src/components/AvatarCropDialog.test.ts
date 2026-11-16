import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, nextTick, onScopeDispose, ref, shallowRef, watch, type ComputedRef, type Ref } from 'vue';
import { expect, it, vi } from 'vitest';
import { useBackdropDismiss } from './useBackdropDismiss';
import { AvatarImageError, calculateAvatarCrop, zoomAvatarWithWheel, type AvatarCrop } from '../profile/avatarImage';

const script = parse(readFileSync(new URL('./AvatarCropDialog.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const sourceFile = ts.createSourceFile('AvatarCropDialog.ts', script, ts.ScriptTarget.Latest, true);
const callbacks = sourceFile.statements.filter((statement) => !ts.isImportDeclaration(statement)
  && !statement.getText(sourceFile).startsWith('onMounted('))
  .map((statement) => statement.getText(sourceFile)).join('\n');
const compiled = ts.transpile(callbacks, { target: ts.ScriptTarget.ES2022 });

function setup(width: number, height: number, shape: 'circle' | 'square' = 'circle', savedAvatar?: string) {
  const scope = effectScope();
  const source = { bitmap: { width, height }, previewUrl: 'blob:avatar', savedAvatar };
  const encodeAvatarCrop = vi.fn(async () => new Blob(['png']));
  const blobToDataUrl = vi.fn(async () => 'data:image/png;base64,cG5n');
  const emit = vi.fn();
  // 使用正式组件的计算属性和监听器，避免只验证独立公式而遗漏旋转时的状态更新。
  const cropper = scope.run(() => runInNewContext(`${compiled}\n({ zoom, rotation, viewportSize,
    offsetX, offsetY, crop, imageStyle, clampOffset, applyCrop })`, {
    computed, ref, shallowRef, watch, nextTick, onScopeDispose, useBackdropDismiss,
    defineProps: () => ({ source, shape }), defineEmits: () => emit,
    document: { activeElement: null }, HTMLElement: class {},
    AvatarImageError, calculateAvatarCrop, zoomAvatarWithWheel, encodeAvatarCrop,
    blobToDataUrl,
  })) as {
    zoom: Ref<number>; rotation: Ref<number>; viewportSize: Ref<number>;
    offsetX: Ref<number>; offsetY: Ref<number>; crop: ComputedRef<AvatarCrop>;
    imageStyle: ComputedRef<{ width: string; height: string; transform: string }>;
    clampOffset(): void; applyCrop(): Promise<void>;
  };
  return { scope, cropper, source, encodeAvatarCrop, blobToDataUrl, emit };
}

it.each([[1200, 800], [800, 1200], [800, 800]])('放大并拖动后旋转保持原图中心和倍率：%s×%s', async (width, height) => {
  const { scope, cropper, source, encodeAvatarCrop, emit } = setup(width, height);
  try {
    cropper.viewportSize.value = 300;
    cropper.zoom.value = 2;
    await nextTick();
    cropper.offsetX.value = 40;
    cropper.offsetY.value = -30;
    cropper.clampOffset();
    const before = { ...cropper.crop.value };
    const imageWidth = cropper.imageStyle.value.width;
    const imageHeight = cropper.imageStyle.value.height;
    for (const rotation of [71, -71, 90, 0, -180, 45, 0]) {
      cropper.rotation.value = rotation;
      await nextTick();
      expect(cropper.crop.value.x + cropper.crop.value.size / 2).toBeCloseTo(before.x + before.size / 2);
      expect(cropper.crop.value.y + cropper.crop.value.size / 2).toBeCloseTo(before.y + before.size / 2);
      expect(cropper.crop.value.size).toBeCloseTo(before.size);
      expect(cropper.imageStyle.value.width).toBe(imageWidth);
      expect(cropper.imageStyle.value.height).toBe(imageHeight);
      expect(cropper.imageStyle.value.transform).toContain(`rotate(${rotation}deg)`);
    }
    await cropper.applyCrop();
    expect(encodeAvatarCrop).toHaveBeenCalledExactlyOnceWith(source.bitmap, cropper.crop.value);
    expect(emit).toHaveBeenCalledExactlyOnceWith('apply', 'data:image/png;base64,cG5n');
  } finally { scope.stop(); }
});

it('靠近边缘旋转只限制防露白所需的位置，仍保留放大倍率', async () => {
  const { scope, cropper } = setup(1200, 800, 'square');
  try {
    cropper.viewportSize.value = 300;
    cropper.zoom.value = 2;
    await nextTick();
    cropper.offsetX.value = 10000;
    cropper.offsetY.value = -10000;
    cropper.clampOffset();
    cropper.rotation.value = 45;
    await nextTick();
    const rotated = { ...cropper.crop.value };
    const halfCoverage = 400 * Math.SQRT2 / 2;
    expect(rotated.size).toBeCloseTo(400);
    expect(rotated.x + rotated.size / 2).toBeCloseTo(halfCoverage);
    expect(rotated.y + rotated.size / 2).toBeCloseTo(800 - halfCoverage);
    cropper.rotation.value = 0;
    await nextTick();
    expect(cropper.crop.value.x).toBeCloseTo(rotated.x);
    expect(cropper.crop.value.y).toBeCloseTo(rotated.y);
    expect(cropper.crop.value.size).toBeCloseTo(rotated.size);
  } finally { scope.stop(); }
});

it.each([[512, 512, 1], [512, 512, 1.1], [512, 512, 1.25], [1200, 800, 1], [800, 1200, 1]])(
  '圆形头像在初始及轻微放大时旋转不改变大小：%s×%s，倍率%s', async (width, height, zoom) => {
    const { scope, cropper } = setup(width, height);
    try {
      cropper.zoom.value = zoom;
      await nextTick();
      const before = { ...cropper.crop.value };
      const imageWidth = cropper.imageStyle.value.width;
      const imageHeight = cropper.imageStyle.value.height;
      for (const rotation of [5, 30, 45, 71, 90, -45, -180, 0]) {
        cropper.rotation.value = rotation;
        await nextTick();
        expect(cropper.crop.value.size).toBeCloseTo(before.size);
        expect(cropper.imageStyle.value.width).toBe(imageWidth);
        expect(cropper.imageStyle.value.height).toBe(imageHeight);
        expect(cropper.crop.value.x + cropper.crop.value.size / 2).toBeCloseTo(width / 2);
        expect(cropper.crop.value.y + cropper.crop.value.size / 2).toBeCloseTo(height / 2);
      }
    } finally { scope.stop(); }
  },
);

it('已有头像未调整时复用原始内容，实际微调后仍重新生成', async () => {
  const savedAvatar = 'data:image/png;base64,c2F2ZWQ=';
  const { scope, cropper, encodeAvatarCrop, emit } = setup(256, 256, 'circle', savedAvatar);
  try {
    await cropper.applyCrop();
    expect(encodeAvatarCrop).not.toHaveBeenCalled();
    expect(emit).toHaveBeenLastCalledWith('apply', savedAvatar);
    cropper.rotation.value = 1;
    await nextTick();
    await cropper.applyCrop();
    expect(encodeAvatarCrop).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenLastCalledWith('apply', 'data:image/png;base64,cG5n');
  } finally { scope.stop(); }
});

it('裁剪编码期间销毁，不再把迟到图片转换为 Base64 或提交', async () => {
  const f = setup(512, 512);
  let resolve!: (blob: Blob) => void;
  f.encodeAvatarCrop.mockImplementationOnce(() => new Promise<Blob>(done => { resolve = done; }));
  const applying = f.cropper.applyCrop();
  f.scope.stop();
  resolve(new Blob([new Uint8Array(512 * 1024)]));
  await applying;
  expect(f.blobToDataUrl).not.toHaveBeenCalled();
  expect(f.emit).not.toHaveBeenCalled();
});

it('Base64 读取期间销毁，迟到结果不能提交', async () => {
  const f = setup(512, 512);
  let resolve!: (value: string) => void;
  let started!: () => void;
  const reading = new Promise<void>(done => { started = done; });
  f.blobToDataUrl.mockImplementationOnce(() => new Promise<string>(done => { resolve = done; started(); }));
  const applying = f.cropper.applyCrop();
  await reading;
  expect(f.blobToDataUrl).toHaveBeenCalledOnce();
  f.scope.stop();
  resolve('data:image/png;base64,bGF0ZQ==');
  await applying;
  expect(f.emit).not.toHaveBeenCalled();
});

it('销毁后到达的应用回调不再启动编码或提交保存的头像', async () => {
  for (const saved of [undefined, 'data:image/png;base64,c2F2ZWQ=']) {
    const f = setup(256, 256, 'circle', saved);
    f.scope.stop();
    await f.cropper.applyCrop();
    expect(f.encodeAvatarCrop).not.toHaveBeenCalled();
    expect(f.blobToDataUrl).not.toHaveBeenCalled();
    expect(f.emit).not.toHaveBeenCalled();
  }
});
