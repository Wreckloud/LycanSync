import type { CustomScreenShareQuality, ScreenShareQualityId } from '../rtc/screenShareQuality';

export interface NativeVideoSourceOptionInput {
  sourceId: string;
  kind: 'monitor' | 'window';
  title: string;
  width: number;
  height: number;
  primary: boolean;
  windowId?: string;
  monitorOrigin?: { x: number; y: number };
}

interface NativeVideoSourceThumbnail {
  sourceId: string;
  thumbnail: string;
}

interface NativeScreenSourceSelection {
  sourceId: string;
  shareAudio: boolean;
  quality?: ScreenShareQualityId;
  customQuality?: CustomScreenShareQuality;
}

const THUMBNAIL_REFRESH_INTERVAL_MS = 1_500;
const SELECTED_THUMBNAIL_REFRESH_INTERVAL_MS = 750;

// 持有本次来源快照与静态预览；只返回选择结果，不启动采集或发布轨道。
export function createNativeVideoSourceSelection(sources: NativeVideoSourceOptionInput[]) {
  let currentSources = sources;
  const thumbnails = new Map<string, { title: string; thumbnail: string }>();
  const thumbnailAttempts = new Map<string, { title: string; attemptedAt: number }>();
  let settle: (selection: NativeScreenSourceSelection | null) => void = () => {};
  let settled = false;
  const result = new Promise<NativeScreenSourceSelection | null>((resolve) => { settle = resolve; });

  function buildOptions() {
    return currentSources.map((source) => ({
      id: source.sourceId,
      name: source.kind === 'monitor'
        ? `屏幕 ${currentSources.filter((item) => item.kind === 'monitor').indexOf(source) + 1}` : source.title,
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
      // 已有来源保持位置；新窗口放在前面便于选择，新增显示器不打乱原排列。
      const remaining = new Map(nextSources.map((source) => [source.sourceId, source]));
      const retained = currentSources.flatMap((source) => {
        const updated = remaining.get(source.sourceId);
        remaining.delete(source.sourceId);
        return updated ? [updated] : [];
      });
      const added = [...remaining.values()];
      currentSources = [...added.filter((source) => source.kind === 'window'), ...retained,
        ...added.filter((source) => source.kind === 'monitor')];
      const current = new Map(nextSources.map((source) => [source.sourceId, source.title]));
      for (const [sourceId, thumbnail] of thumbnails) {
        if (current.get(sourceId) !== thumbnail.title) thumbnails.delete(sourceId);
      }
      for (const [sourceId, attempt] of thumbnailAttempts) {
        if (current.get(sourceId) !== attempt.title) thumbnailAttempts.delete(sourceId);
      }
      return buildOptions();
    },
    sourcesNeedingThumbnails(now = Date.now(), visibleIds?: Set<string>, selectedId?: string) {
      if (settled) return [];
      return currentSources.filter((source) => {
        if (visibleIds && !visibleIds.has(source.sourceId) && source.sourceId !== selectedId) return false;
        const previous = thumbnailAttempts.get(source.sourceId);
        const interval = source.sourceId === selectedId
          ? SELECTED_THUMBNAIL_REFRESH_INTERVAL_MS : THUMBNAIL_REFRESH_INTERVAL_MS;
        if (previous && now - previous.attemptedAt < interval) return false;
        thumbnailAttempts.set(source.sourceId, {
          title: source.title,
          attemptedAt: now,
        });
        return true;
      }).sort((left, right) => Number(right.sourceId === selectedId) - Number(left.sourceId === selectedId));
    },
    applyThumbnails(requestedSources: NativeVideoSourceOptionInput[], received: NativeVideoSourceThumbnail[]) {
      if (settled) return buildOptions();
      const current = new Map(currentSources.map((source) => [source.sourceId, source.title]));
      const requested = new Map(requestedSources.map((source) => [source.sourceId, source.title]));
      for (const { sourceId, thumbnail } of received) {
        const title = requested.get(sourceId);
        // 刷新期间关闭或改名的来源不能套用旧截图；真正采集仍校验原生来源身份。
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
