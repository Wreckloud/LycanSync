interface NativeVideoSource {
  sourceId: string;
  kind: 'monitor' | 'window';
  title: string;
}

interface NativeVideoSourceThumbnail {
  sourceId: string;
  thumbnail: string;
}

interface NativeScreenSourceSelection {
  sourceId: string;
  shareAudio: boolean;
}

export function createNativeVideoSourceSelection(
  sources: NativeVideoSource[],
  thumbnails: NativeVideoSourceThumbnail[],
) {
  const thumbnailBySourceId = new Map(thumbnails.map(({ sourceId, thumbnail }) => [sourceId, thumbnail]));
  const options = sources.map((source) => ({
    id: source.sourceId,
    name: source.title,
    thumbnail: thumbnailBySourceId.get(source.sourceId),
    type: source.kind === 'window' ? 'window' as const : 'screen' as const,
  }));
  const validSourceIds = new Set(options.map(({ id }) => id));
  let settle: (selection: NativeScreenSourceSelection | null) => void = () => {};
  let settled = false;
  const result = new Promise<NativeScreenSourceSelection | null>((resolve) => { settle = resolve; });

  return {
    options,
    result,
    finish(selection: NativeScreenSourceSelection | null) {
      if (settled) return;
      settled = true;
      settle(selection && validSourceIds.has(selection.sourceId) ? selection : null);
    },
  };
}
