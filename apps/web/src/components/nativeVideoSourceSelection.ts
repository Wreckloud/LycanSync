interface NativeVideoSource {
  sourceId: string;
  kind: 'monitor' | 'window';
  title: string;
}

interface NativeVideoSourceThumbnail {
  sourceId: string;
  thumbnail: string;
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
  let settle: (sourceId: string | null) => void = () => {};
  let settled = false;
  const result = new Promise<string | null>((resolve) => { settle = resolve; });

  return {
    options,
    result,
    finish(sourceId: string | null) {
      if (settled) return;
      settled = true;
      settle(sourceId && validSourceIds.has(sourceId) ? sourceId : null);
    },
  };
}
