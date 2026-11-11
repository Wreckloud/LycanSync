import { expect, it, vi } from 'vitest';
import { keepDialogFocus } from './dialogFocus';

function fixture() {
  const owner = { activeElement: null as unknown, defaultView: { getComputedStyle: (control: { visibility: string }) => control } };
  const control = () => ({ tabIndex: 0, visibility: 'visible', matches: vi.fn(() => false), closest: vi.fn((): object | null => null),
    getClientRects: vi.fn(() => [{}]), focus: vi.fn() });
  const first = control(), middle = control(), last = control();
  const root = { ownerDocument: owner, closest: vi.fn((): object | null => null), querySelectorAll: () => [first, middle, last], focus: vi.fn() };
  const press = (active: unknown, shiftKey = false, key = 'Tab', defaultPrevented = false) => {
    owner.activeElement = active;
    const event = { key, shiftKey, defaultPrevented, currentTarget: root, preventDefault: vi.fn() };
    keepDialogFocus(event as unknown as KeyboardEvent);
    return event;
  };
  return { first, middle, last, root, press };
}

it('弹窗和首末控件之间循环，中间控件仍使用原生 Tab 顺序', () => {
  const f = fixture();
  expect(f.press(f.last).preventDefault).toHaveBeenCalled();
  expect(f.first.focus).toHaveBeenCalledWith({ preventScroll: true });
  f.press(f.first, true);
  expect(f.last.focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(f.press(f.middle).preventDefault).not.toHaveBeenCalled();
  f.press(f.root, true);
  expect(f.last.focus).toHaveBeenCalledTimes(2);
});

it.each(['disabled', 'inert', 'hidden', 'untabbable', 'invisible'])('跳过 %s 的控件', reason => {
  const f = fixture();
  if (reason === 'disabled') f.last.matches.mockReturnValue(true);
  if (reason === 'inert') f.last.closest.mockReturnValue({});
  if (reason === 'hidden') f.last.getClientRects.mockReturnValue([]);
  if (reason === 'untabbable') f.last.tabIndex = -1;
  if (reason === 'invisible') f.last.visibility = 'hidden';
  f.press(f.first, true);
  expect(f.middle.focus).toHaveBeenCalled();
  expect(f.last.focus).not.toHaveBeenCalled();
});

it('当前字段被移除或所有按钮禁用时，焦点仍留在弹窗', () => {
  const f = fixture();
  f.press({});
  expect(f.first.focus).toHaveBeenCalled();
  for (const control of [f.first, f.middle, f.last]) control.matches.mockReturnValue(true);
  expect(f.press(f.root).preventDefault).toHaveBeenCalled();
  expect(f.root.focus).toHaveBeenCalledWith({ preventScroll: true });
});

it('不处理其他键、已消费的事件或退场中不可交互的弹窗', () => {
  const f = fixture();
  expect(f.press(f.last, false, 'Enter').preventDefault).not.toHaveBeenCalled();
  expect(f.press(f.last, false, 'Tab', true).preventDefault).not.toHaveBeenCalled();
  f.root.closest.mockReturnValue({});
  expect(f.press(f.last).preventDefault).not.toHaveBeenCalled();
});
