import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScreenStatusFrame } from './screenStatusFrame';

afterEach(() => vi.unstubAllGlobals());

describe('screen status frame', () => {
  it('creates a status-only frame with the requested dimensions and timestamp', () => {
    const context = { fillRect: vi.fn(), fillText: vi.fn() };
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => context) };
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
    const frameConstructor = vi.fn(function () {});
    vi.stubGlobal('VideoFrame', frameConstructor);

    createScreenStatusFrame(1280, 720, 123456, {
      title: '正在被控制', description: '朋友正在控制此电脑',
    });

    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(720);
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 1280, 720);
    expect(context.fillText.mock.calls.map((call) => call[0])).toEqual([
      '正在被控制', '朋友正在控制此电脑',
    ]);
    expect(frameConstructor).toHaveBeenCalledWith(canvas, { timestamp: 123456 });
  });

  it('fails explicitly when the drawing context is unavailable', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) });
    const frameConstructor = vi.fn();
    vi.stubGlobal('VideoFrame', frameConstructor);
    expect(() => createScreenStatusFrame(1280, 720, 1, {
      title: '正在被控制', description: '朋友正在控制此电脑',
    })).toThrow('screenStatusCanvasUnavailable');
    expect(frameConstructor).not.toHaveBeenCalled();
  });
});
