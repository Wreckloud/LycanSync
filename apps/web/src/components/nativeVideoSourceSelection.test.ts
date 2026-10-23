import { describe, expect, it } from 'vitest';
import { createNativeVideoSourceSelection } from './nativeVideoSourceSelection';

const sources = [
  { sourceId: 'window:2:0', kind: 'window' as const, title: 'Notepad', width: 800, height: 600, primary: false },
  { sourceId: 'monitor:2:0', kind: 'monitor' as const, title: 'DISPLAY1', width: 1920, height: 1080, primary: true },
];

describe('createNativeVideoSourceSelection', () => {
  it('缩略图缓存最多24项，优先保留可见或选中项，淘汰不改变来源身份且可重新获取', () => {
    const windows = Array.from({ length: 30 }, (_, index) => ({ ...sources[0], sourceId: `window:${index + 10}:0` }));
    const selection = createNativeVideoSourceSelection(windows);
    const selected = windows[0].sourceId;
    selection.sourcesNeedingThumbnails(10_000, new Set([windows[1].sourceId]), selected);
    selection.applyThumbnails(windows, windows.map((source) => ({ sourceId: source.sourceId, thumbnail: source.sourceId })));
    expect(selection.options.filter((source) => source.thumbnail)).toHaveLength(24);
    expect(selection.options[0].thumbnail).toBe(selected);
    expect(selection.options[1].thumbnail).toBe(windows[1].sourceId);
    expect(selection.options[2].thumbnail).toBeUndefined();
    expect(selection.options.map((source) => source.id)).toEqual(windows.map((source) => source.sourceId));
    const requested = selection.sourcesNeedingThumbnails(12_000, new Set([windows[2].sourceId]));
    expect(requested).toHaveLength(1);
    selection.applyThumbnails(requested, [{ sourceId: windows[2].sourceId, thumbnail: 'refetched' }]);
    expect(selection.options[2].thumbnail).toBe('refetched');
    selection.finish({ sourceId: selected, shareAudio: false });
    expect(selection.options.every((source) => !source.thumbnail)).toBe(true);
    return expect(selection.result).resolves.toEqual({ sourceId: selected, shareAudio: false });
  });

  it('较大缩略图受总字符串容量限制，超大单项不进入缓存，结束后迟到响应不能重新保留', () => {
    const selection = createNativeVideoSourceSelection(sources);
    selection.applyThumbnails(sources, sources.map((source) => ({ sourceId: source.sourceId, thumbnail: 'x'.repeat(1_100_000) })));
    expect(selection.options.filter((source) => source.thumbnail)).toHaveLength(1);
    selection.applyThumbnails(sources, [{ sourceId: sources[1].sourceId, thumbnail: 'x'.repeat(2 * 1024 * 1024 + 1) }]);
    expect(selection.options.every((source) => !source.thumbnail)).toBe(true);
    selection.finish(null);
    selection.applyThumbnails(sources, [{ sourceId: sources[0].sourceId, thumbnail: 'late' }]);
    expect(selection.options.every((source) => !source.thumbnail)).toBe(true);
  });

  it('显示器按当前列表编号，不将 Windows 的 DISPLAY25 当作屏幕数量', () => {
    const monitor = { ...sources[1], title: '\\\\.\\DISPLAY25' };
    const selection = createNativeVideoSourceSelection([monitor]);
    expect(selection.options[0].name).toBe('屏幕 1');
    const second = { ...monitor, sourceId: 'monitor:3:0', title: '\\\\.\\DISPLAY40' };
    expect(selection.replaceSources([second, monitor]).map(source => source.name)).toEqual(['屏幕 1', '屏幕 2']);
    expect(selection.options[0].id).toBe(monitor.sourceId);
  });
  it('attaches previews by opaque source id without changing the selected id', () => {
    const selection = createNativeVideoSourceSelection(sources);
    selection.applyThumbnails(sources, [
      { sourceId: 'window:2:0', thumbnail: 'data:image/png;base64,window' },
    ]);

    expect(selection.options).toEqual([
      { id: 'window:2:0', name: 'Notepad', thumbnail: 'data:image/png;base64,window', type: 'window' },
      { id: 'monitor:2:0', name: '屏幕 1', thumbnail: undefined, type: 'screen' },
    ]);
    selection.finish({ sourceId: 'window:2:0', shareAudio: true });
    return expect(selection.result).resolves.toEqual({ sourceId: 'window:2:0', shareAudio: true });
  });

  it('resolves cancellation to null and ignores any later selection', async () => {
    const selection = createNativeVideoSourceSelection(sources);
    selection.finish(null);
    selection.finish({ sourceId: 'window:2:0', shareAudio: true });
    await expect(selection.result).resolves.toBeNull();
  });

  it('rejects a source id that was not in the explicit picker snapshot', async () => {
    const selection = createNativeVideoSourceSelection(sources);
    selection.finish({ sourceId: 'window:99:0', shareAudio: true });
    await expect(selection.result).resolves.toBeNull();
  });

  it('adds newly discovered windows and retains source ids across chooser refreshes', () => {
    const selection = createNativeVideoSourceSelection([sources[0]]);
    const firstId = selection.options[0].id;
    const updated = selection.replaceSources([
      sources[0],
      { sourceId: 'window:3:0', kind: 'window', title: 'New window', width: 640, height: 480, primary: false },
    ]);
    expect(updated.map(({ id }) => id)).toEqual(['window:3:0', firstId]);
  });

  it('ignores a thumbnail response that arrives after cancellation or source replacement', () => {
    const selection = createNativeVideoSourceSelection([sources[0]]);
    const requested = selection.sourcesNeedingThumbnails();
    selection.replaceSources([{ ...sources[0], title: 'Renamed window' }]);
    expect(selection.applyThumbnails(requested, [
      { sourceId: sources[0].sourceId, thumbnail: 'data:image/png;base64,stale' },
    ])[0].thumbnail).toBeUndefined();
    const nextRequest = selection.sourcesNeedingThumbnails();
    selection.finish(null);
    expect(selection.applyThumbnails(nextRequest, [
      { sourceId: sources[0].sourceId, thumbnail: 'data:image/png;base64,late' },
    ])[0].thumbnail).toBeUndefined();
  });

  it('does not accept a source-list response after chooser cancellation', async () => {
    const selection = createNativeVideoSourceSelection([]);
    selection.finish(null);
    selection.replaceSources([sources[0]]);
    expect(selection.options).toEqual([]);
    expect(selection.sourcesNeedingThumbnails()).toEqual([]);
    await expect(selection.result).resolves.toBeNull();
  });

  it('按间隔刷新缩略图，缺失预览仍可继续重试', () => {
    const selection = createNativeVideoSourceSelection([sources[0]]);
    expect(selection.sourcesNeedingThumbnails(10_000)).toHaveLength(1);
    expect(selection.sourcesNeedingThumbnails(11_499)).toHaveLength(0);
    expect(selection.sourcesNeedingThumbnails(11_500)).toHaveLength(1);
    selection.applyThumbnails(sources, [{ sourceId: sources[0].sourceId, thumbnail: 'old' }]);
    expect(selection.sourcesNeedingThumbnails(14_000)).toHaveLength(1);
    expect(selection.options[0].thumbnail).toBe('old');
    selection.applyThumbnails(sources, [{ sourceId: sources[0].sourceId, thumbnail: 'new' }]);
    expect(selection.options[0].thumbnail).toBe('new');
    expect(selection.sourcesNeedingThumbnails(16_000)).toHaveLength(1);
  });

  it('只请求可见或选中的来源，选中来源按 750 毫秒间隔优先更新', () => {
    const selection = createNativeVideoSourceSelection(sources);
    const visible = new Set([sources[0].sourceId]);
    expect(selection.sourcesNeedingThumbnails(10_000, visible).map((source) => source.sourceId))
      .toEqual([sources[0].sourceId]);
    expect(selection.sourcesNeedingThumbnails(10_001, visible, sources[1].sourceId)
      .map((source) => source.sourceId)).toEqual([sources[1].sourceId]);
    expect(selection.sourcesNeedingThumbnails(10_750, visible, sources[1].sourceId)).toHaveLength(0);
    expect(selection.sourcesNeedingThumbnails(10_751, visible, sources[1].sourceId)
      .map((source) => source.sourceId)).toEqual([sources[1].sourceId]);
  });

  it('新窗口放在前面，保留已有排列并移除关闭窗口', () => {
    const selection = createNativeVideoSourceSelection(sources);
    const added = { ...sources[0], sourceId: 'window:3:0', title: 'New' };
    expect(selection.replaceSources([added, sources[1], sources[0]]).map((source) => source.id))
      .toEqual([added.sourceId, sources[0].sourceId, sources[1].sourceId]);
    expect(selection.replaceSources([added, sources[1]]).map((source) => source.id))
      .toEqual([added.sourceId, sources[1].sourceId]);
  });

  it('keeps black thumbnails as display previews instead of filtering the source', () => {
    const selection = createNativeVideoSourceSelection([sources[0]]);
    selection.applyThumbnails(sources.slice(0, 1), [
      { sourceId: sources[0].sourceId, thumbnail: 'data:image/png;base64,AAAAAA==' },
    ]);
    expect(selection.options).toHaveLength(1);
    expect(selection.options[0].thumbnail).toContain('AAAAAA');
  });
});
