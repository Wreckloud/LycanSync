export function keepDialogFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab' || event.defaultPrevented) return;
  const dialog = event.currentTarget as HTMLElement | null;
  if (!dialog || dialog.closest('[inert]')) return;
  const controls = [...dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')]
    .filter(control => control.tabIndex >= 0 && !control.matches(':disabled')
      && !control.closest('[inert], [hidden]') && control.getClientRects().length > 0
      && dialog.ownerDocument.defaultView?.getComputedStyle(control).visibility === 'visible');
  const first = controls[0];
  const last = controls.at(-1);
  const active = dialog.ownerDocument.activeElement;
  // 提交期间可能禁用全部按钮，或让当前字段退场；焦点仍留在当前弹窗。
  if (!first) {
    event.preventDefault();
    dialog.focus({ preventScroll: true });
  } else if (!controls.some(control => control === active)
      || (event.shiftKey ? active === first : active === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first)?.focus({ preventScroll: true });
  }
}
