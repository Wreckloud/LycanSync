import { describe, expect, it } from 'vitest';
import { createNativeVideoSourceSelection } from './nativeVideoSourceSelection';

const sources = [
  { sourceId: 'window:2:0', kind: 'window' as const, title: 'Notepad', width: 800, height: 600, primary: false },
  { sourceId: 'monitor:2:0', kind: 'monitor' as const, title: 'DISPLAY1', width: 1920, height: 1080, primary: true },
];

describe('createNativeVideoSourceSelection', () => {
  it('attaches previews by opaque source id without changing the selected id', () => {
    const selection = createNativeVideoSourceSelection(sources);
    selection.applyThumbnails(sources, [
      { sourceId: 'window:2:0', thumbnail: 'data:image/png;base64,window' },
    ]);

    expect(selection.options).toEqual([
      { id: 'window:2:0', name: 'Notepad', thumbnail: 'data:image/png;base64,window', type: 'window' },
      { id: 'monitor:2:0', name: 'DISPLAY1', thumbnail: undefined, type: 'screen' },
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
    expect(updated.map(({ id }) => id)).toEqual([firstId, 'window:3:0']);
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

  it('retries a missing thumbnail at a low frequency with a per-source limit', () => {
    const selection = createNativeVideoSourceSelection([sources[0]]);
    expect(selection.sourcesNeedingThumbnails(10_000)).toHaveLength(1);
    expect(selection.sourcesNeedingThumbnails(12_999)).toHaveLength(0);
    expect(selection.sourcesNeedingThumbnails(13_000)).toHaveLength(1);
    expect(selection.sourcesNeedingThumbnails(16_000)).toHaveLength(1);
    expect(selection.sourcesNeedingThumbnails(19_000)).toHaveLength(0);
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
