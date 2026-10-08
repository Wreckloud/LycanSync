export interface NativeVideoSourceOptionInput {
  sourceId: string;
  kind: 'monitor' | 'window';
  title: string;
  width: number;
  height: number;
  primary: boolean;
}

interface NativeVideoSourceThumbnail {
  sourceId: string;
  thumbnail: string;
}

interface NativeScreenSourceSelection {
  sourceId: string;
  shareAudio: boolean;
}

const THUMBNAIL_RETRY_INTERVAL_MS = 3_000;
const MAX_THUMBNAIL_ATTEMPTS = 3;

export function createNativeVideoSourceSelection(sources: NativeVideoSourceOptionInput[]) {
  let currentSources = sources;
  const thumbnails = new Map<string, { title: string; thumbnail: string }>();
  const thumbnailAttempts = new Map<string, { title: string; count: number; attemptedAt: number }>();
  let settle: (selection: NativeScreenSourceSelection | null) => void = () => {};
  let settled = false;
  const result = new Promise<NativeScreenSourceSelection | null>((resolve) => { settle = resolve; });

  function buildOptions() {
    return currentSources.map((source) => ({
      id: source.sourceId,
      name: source.title,
      thumbnail: thumbnails.get(source.sourceId)?.title === source.title
        ? thumbnails.get(source.sourceId)?.thumbnail : undefined,
      type: source.kind === 'window' ? 'window' as const : 'screen' as const,
    }));
  }

  return {
    result,
    get options() { return buildOptions(); },
    replaceSources(nextSources: NativeVideoSourceOptionInput[]) {
      if (settled) return buildOptions();
      currentSources = nextSources;
      const current = new Map(nextSources.map((source) => [source.sourceId, source.title]));
      for (const [sourceId, thumbnail] of thumbnails) {
        if (current.get(sourceId) !== thumbnail.title) thumbnails.delete(sourceId);
      }
      for (const [sourceId, attempt] of thumbnailAttempts) {
        if (current.get(sourceId) !== attempt.title) thumbnailAttempts.delete(sourceId);
      }
      return buildOptions();
    },
    sourcesNeedingThumbnails(now = Date.now()) {
      if (settled) return [];
      return currentSources.filter((source) => {
        if (thumbnails.get(source.sourceId)?.title === source.title) return false;
        const previous = thumbnailAttempts.get(source.sourceId);
        if (previous && (previous.count >= MAX_THUMBNAIL_ATTEMPTS
            || now - previous.attemptedAt < THUMBNAIL_RETRY_INTERVAL_MS)) return false;
        thumbnailAttempts.set(source.sourceId, {
          title: source.title,
          count: (previous?.count ?? 0) + 1,
          attemptedAt: now,
        });
        return true;
      });
    },
    applyThumbnails(requestedSources: NativeVideoSourceOptionInput[], received: NativeVideoSourceThumbnail[]) {
      if (settled) return buildOptions();
      const current = new Map(currentSources.map((source) => [source.sourceId, source.title]));
      const requested = new Map(requestedSources.map((source) => [source.sourceId, source.title]));
      for (const { sourceId, thumbnail } of received) {
        const title = requested.get(sourceId);
        if (title && current.get(sourceId) === title) thumbnails.set(sourceId, { title, thumbnail });
      }
      return buildOptions();
    },
    finish(selection: NativeScreenSourceSelection | null) {
      if (settled) return;
      settled = true;
      const isCurrent = currentSources.some((source) => source.sourceId === selection?.sourceId);
      settle(selection && isCurrent ? selection : null);
    },
  };
}
