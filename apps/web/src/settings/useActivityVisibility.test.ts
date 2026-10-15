import { describe, expect, it, vi } from 'vitest';
import { useActivityVisibility } from './useActivityVisibility';

describe('当前动态显示偏好', () => {
  it('未设置时延续现有显示行为，并按账号保存', () => {
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
    const preference = useActivityVisibility('member-a', storage);
    expect(preference.showActivity.value).toBe(true);
    preference.setShowActivity(false);
    expect(preference.showActivity.value).toBe(false);
    expect(storage.setItem).toHaveBeenCalledWith('lycansync.activity-visible.v1.member-a', 'false');
  });

  it('重新打开时恢复不显示动态', () => {
    const preference = useActivityVisibility('member-a', { getItem: () => 'false', setItem: vi.fn() });
    expect(preference.showActivity.value).toBe(false);
    expect(preference.error.value).toBe('');
  });

  it('无法读取偏好时不分享，并明确显示错误', () => {
    const preference = useActivityVisibility('member-a', { getItem: () => { throw new Error('denied'); }, setItem: vi.fn() });
    expect(preference.showActivity.value).toBe(false);
    expect(preference.error.value).toContain('无法读取');
  });

  it('保存失败仍保留本次隐私选择，说明无法持久化', () => {
    const preference = useActivityVisibility('member-a', { getItem: () => null, setItem: () => { throw new Error('denied'); } });
    preference.setShowActivity(false);
    expect(preference.showActivity.value).toBe(false);
    expect(preference.error.value).toContain('本次修改已生效');
  });

  it('访问存储对象本身被拒绝时默认不分享，后续保存失败明确报告', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('denied'); } });
    try {
      const preference = useActivityVisibility('member');
      expect(preference.showActivity.value).toBe(false);
      expect(preference.error.value).toContain('无法读取');
      preference.setShowActivity(true);
      expect(preference.error.value).toContain('无法保存');
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });
});
