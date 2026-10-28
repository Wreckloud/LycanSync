export function useBackdropDismiss(close: () => void) {
  let pressed = false;
  return {
    pointerdown(event: PointerEvent) {
      pressed = event.button === 0 && event.target === event.currentTarget;
    },
    pointerup(event: PointerEvent) {
      const dismiss = pressed && event.button === 0 && event.target === event.currentTarget;
      pressed = false;
      if (dismiss) close();
    },
    pointercancel() { pressed = false; },
  };
}
