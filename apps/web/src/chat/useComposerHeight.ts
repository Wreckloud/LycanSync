import { onMounted, onScopeDispose, type Ref } from 'vue';

export function useComposerHeight(input: Ref<HTMLTextAreaElement | null>, viewport: Ref<HTMLElement | null>,
  content: Ref<HTMLElement | null>) {
  let observer: ResizeObserver | undefined;
  let width = 0;

  function resizeInput() {
    const element = input.value;
    if (!element) return;
    element.style.height = '42px';
    element.style.height = `${Math.min(element.scrollHeight, 122)}px`;
  }

  function measure() {
    const body = content.value;
    const frame = viewport.value;
    if (!body || !frame) return;
    if (width !== body.clientWidth) {
      width = body.clientWidth;
      resizeInput();
    }
    // 文字、附件及错误共用外层高度动画，内层只提供最终尺寸。
    frame.style.height = `${body.offsetHeight}px`;
  }

  onMounted(() => {
    measure();
    observer = new ResizeObserver(measure);
    if (content.value) observer.observe(content.value);
  });
  onScopeDispose(() => observer?.disconnect());
  return resizeInput;
}
