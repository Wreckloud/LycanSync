import { effectScope, nextTick, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { useIdentityTransition } from './useIdentityTransition';

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const animations: { cancel: ReturnType<typeof vi.fn>; finish(): void }[] = [];
  const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => {
    let finish!: () => void;
    let reject!: (reason: Error) => void;
    const finished = new Promise<void>((resolve, fail) => { finish = resolve; reject = fail; });
    const animation = { finished, finish, cancel: vi.fn(() => reject(new Error('cancelled'))) };
    animations.push(animation);
    return animation;
  });
  class Element {
    style: Record<string, string> = { visibility: '' };
    className = '';
    children: Element[] = [];
    offsetHeight = 48;
    inert = false;
    removeAttribute() {}
    setAttribute() {}
    animate = animate;
    cloneNode() { const clone = new Element(); clone.style = { ...this.style }; return clone; }
    getBoundingClientRect() { return { left: 20, top: 40, width: 48, height: 48 }; }
    append(...elements: Element[]) { this.children.push(...elements); }
    remove() { layers.splice(layers.indexOf(this), 1); }
    querySelector(selector: string) { return this.children[selector.includes('avatar') ? 0 : 1]; }
  }
  const identities = Object.fromEntries(['account', 'loading', 'main', 'profile'].map(phase => {
    const root = new Element();
    root.append(new Element(), new Element());
    return [phase, root];
  }));
  const layers: Element[] = [];
  const frames = new Map<number, () => void>();
  let frameId = 0;
  const preference = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('window', {
    innerWidth: 1280, innerHeight: 820, screenX: 0, screenY: 0,
    matchMedia: () => preference, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    requestAnimationFrame: (callback: () => void) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    getComputedStyle: (element: Element) => ({ ...element.style, font: '16px sans-serif', fontSize: '16px', lineHeight: '20px',
      getPropertyValue: (name: string) => name === '--motion-identity-duration' ? '260ms' : 'ease' }),
  });
  vi.stubGlobal('document', {
    querySelector: (selector: string) => identities[selector.split('"')[1]!],
    createElement: () => new Element(), body: { append: (element: Element) => layers.push(element) },
  });
  const state = ref<{ id: string | null; phase: 'account' | 'loading' | 'main' | 'leaving' | null }>({ id: 'member', phase: 'account' });
  const scope = effectScope();
  scope.run(() => useIdentityTransition(() => ({ ...state.value }), async () => {}));
  async function flush() {
    await nextTick();
    for (let step = 0; step < 5; step++) {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => callback());
      await nextTick();
    }
  }
  return { state, scope, preference, animations, layers, identities, animate, frames, flush };
}

it('加载转主界面会取消旧过渡，完成后只恢复真实目标，不留下隐藏昵称', async () => {
  const f = fixture();
  try {
    f.state.value.phase = 'loading';
    await f.flush();
    expect(f.identities.loading!.children[0]!.style.visibility).toBe('hidden');
    const old = [...f.animations];
    f.state.value.phase = 'main';
    await f.flush();
    old.forEach(animation => expect(animation.cancel).toHaveBeenCalledOnce());
    expect(f.layers).toHaveLength(1);
    f.animations.slice(2).forEach(animation => animation.finish());
    await f.flush();
    expect(f.layers).toHaveLength(0);
    expect(f.identities.main!.children.map(element => element.style.visibility)).toEqual(['', '']);
    expect(f.identities.loading!.children.map(element => element.style.visibility)).toEqual(['', '']);
  } finally { f.scope.stop(); }
});

it('登出收尾只暂留身份，不等待动画，也不提前播放返回账号的过渡', async () => {
  const f = fixture();
  try {
    f.state.value.phase = 'main';
    await f.flush();
    f.state.value.phase = 'leaving';
    await f.flush();
    const count = f.animate.mock.calls.length;
    expect(f.layers).toHaveLength(1);
    expect(f.frames.size).toBe(0);
    f.state.value.phase = 'account';
    await f.flush();
    expect(f.animate.mock.calls.length).toBe(count + 2);
  } finally { f.scope.stop(); }
});

it('账号变化、会话失效不会把旧头像带到另一个身份上', async () => {
  const f = fixture();
  try {
    f.state.value.phase = 'loading';
    await f.flush();
    f.state.value = { id: 'another-member', phase: 'main' };
    await f.flush();
    expect(f.layers).toHaveLength(0);
    expect(f.animate).toHaveBeenCalledTimes(2);
    f.state.value = { id: null, phase: null };
    await f.flush();
    expect(f.layers).toHaveLength(0);
  } finally { f.scope.stop(); }
});

it('减少动态效果跳过移动，销毁时取消等待帧并恢复原元素', async () => {
  const f = fixture();
  try {
    f.preference.matches = true;
    f.state.value.phase = 'loading';
    await f.flush();
    expect(f.animate).not.toHaveBeenCalled();
    f.preference.matches = false;
    f.state.value.phase = 'main';
    await nextTick();
    await nextTick();
    f.scope.stop();
    await f.flush();
    expect(f.frames.size).toBe(0);
    expect(f.layers).toHaveLength(0);
    expect(f.identities.main!.children.map(element => element.style.visibility)).toEqual(['', '']);
    expect(f.preference.removeEventListener).toHaveBeenCalledOnce();
  } finally { f.scope.stop(); }
});

it('桌面窗口收紧后将窗口外的起点收回可见边缘，不从窗口外等待飞入', async () => {
  const f = fixture();
  try {
    f.state.value.phase = 'loading';
    await nextTick();
    Object.assign(window, { innerWidth: 440, screenX: 200 });
    await f.flush();
    expect(f.animate.mock.calls[0]?.[0]).toEqual([
      { transform: 'none', width: '48px' },
      { transform: 'translate(20px, 0px) scale(1, 1)', width: '48px' },
    ]);
  } finally { f.scope.stop(); }
});
