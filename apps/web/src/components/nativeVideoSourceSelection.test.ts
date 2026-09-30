import { describe, expect, it } from 'vitest';
import { createNativeVideoSourceSelection } from './nativeVideoSourceSelection';

const sources = [
  { sourceId: 'window:2:0', kind: 'window' as const, title: 'Notepad' },
  { sourceId: 'monitor:2:0', kind: 'monitor' as const, title: 'DISPLAY1' },
];

describe('createNativeVideoSourceSelection', () => {
  it('attaches previews by opaque source id without changing the selected id', () => {
    const selection = createNativeVideoSourceSelection(sources, [
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
    const selection = createNativeVideoSourceSelection(sources, []);
    selection.finish(null);
    selection.finish({ sourceId: 'window:2:0', shareAudio: true });
    await expect(selection.result).resolves.toBeNull();
  });

  it('rejects a source id that was not in the explicit picker snapshot', async () => {
    const selection = createNativeVideoSourceSelection(sources, []);
    selection.finish({ sourceId: 'window:99:0', shareAudio: true });
    await expect(selection.result).resolves.toBeNull();
  });
});
