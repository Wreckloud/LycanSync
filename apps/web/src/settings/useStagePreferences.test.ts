import { expect, it } from 'vitest';
import { useStagePreferences } from './useStagePreferences';

it('默认启用，按账号保存；另一个账号和重建状态互不污染', () => {
  const saved = new Map<string, string>();
  const storage = { getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { saved.set(key, value); } };
  const first = useStagePreferences('first', storage);
  expect(first.autoFill.value).toBe(true);
  first.setAutoFill(false);
  expect(useStagePreferences('first', storage).autoFill.value).toBe(false);
  expect(useStagePreferences('other', storage).autoFill.value).toBe(true);
});

it('读取失败明确提示；保存失败仍保持本次选择', () => {
  const preference = useStagePreferences('user', { getItem: () => 'invalid',
    setItem: () => { throw new Error('storage unavailable'); } });
  expect(preference.autoFill.value).toBe(true);
  expect(preference.error.value).toContain('无法读取');
  preference.setAutoFill(false);
  expect(preference.autoFill.value).toBe(false);
  expect(preference.error.value).toContain('无法保存');
});

it('存储对象本身被系统拒绝时不阻断页面，本次舞台设置仍可修改', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('storage access denied'); },
  });
  try {
    const preference = useStagePreferences('user');
    expect(preference.autoFill.value).toBe(true);
    expect(preference.error.value).toContain('无法读取');
    preference.setAutoFill(false);
    expect(preference.autoFill.value).toBe(false);
    expect(preference.error.value).toContain('本次修改已生效');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
