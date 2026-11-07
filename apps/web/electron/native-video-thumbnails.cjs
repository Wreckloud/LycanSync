const MAX_THUMBNAIL_BYTES = 64 * 1024;
const MAX_TOTAL_THUMBNAIL_BYTES = 768 * 1024;
const DATA_URL_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,/i;

function matchNativeVideoSourceThumbnails(videoSources, desktopSources) {
  const thumbnails = [];
  let totalBytes = 0;

  for (const source of videoSources) {
    let desktopSource;
    if (source.kind === 'monitor') {
      // Windows 设备名与 Electron 屏幕名称不同，必须按对应显示器 ID 匹配，不能按排列猜测。
      if (!source.displayId) continue;
      const matches = desktopSources.filter((candidate) => candidate.type === 'screen'
        && candidate.displayId === source.displayId);
      if (matches.length !== 1) continue;
      desktopSource = matches[0];
    } else {
      if (!source.windowId) continue;
      // 浏览器分离窗口可能同名；按窗口句柄匹配，不用标题或排列猜测画面。
      const matches = desktopSources.filter((candidate) => candidate.type === 'window'
        && /^window:([1-9]\d*):[01]$/.exec(candidate.id ?? '')?.[1] === source.windowId);
      if (matches.length !== 1) continue;
      desktopSource = matches[0];
    }
    if (!desktopSource?.thumbnail || desktopSource.thumbnail.isEmpty()) continue;

    const thumbnail = desktopSource.thumbnail.toDataURL();
    const byteLength = Buffer.byteLength(thumbnail, 'utf8');
    if (!DATA_URL_PATTERN.test(thumbnail) || byteLength > MAX_THUMBNAIL_BYTES
        || totalBytes + byteLength > MAX_TOTAL_THUMBNAIL_BYTES) continue;
    thumbnails.push({ sourceId: source.sourceId, thumbnail });
    totalBytes += byteLength;
  }
  return thumbnails;
}

function monitorDisplayId(source, screen) {
  if (source.kind !== 'monitor' || !source.monitorOrigin) return undefined;
  const origin = source.monitorOrigin;
  const point = screen.screenToDipPoint({ x: Math.round(origin.x + source.width / 2),
    y: Math.round(origin.y + source.height / 2) });
  const display = screen.getDisplayNearestPoint(point);
  const bounds = display.bounds;
  if (point.x < bounds.x || point.y < bounds.y || point.x >= bounds.x + bounds.width
      || point.y >= bounds.y + bounds.height) return undefined;
  return String(display.id);
}

// 一次 Electron 抓取已包含同类所有窗口；短暂复用，避免滚动或重开重复整批等待。
function createNativeThumbnailCache(now = Date.now) {
  let owner;
  const batches = new Map();
  return async (state, kind, sources, capture) => {
    if (owner !== state) { owner = state; batches.clear(); }
    let batch = batches.get(kind);
    if (!batch || now() - batch.createdAt >= 10_000 || sources.some(source => {
      const previous = batch.sources.get(source.sourceId);
      return !previous || previous.title !== source.title || previous.windowId !== source.windowId
        || previous.displayId !== source.displayId || previous.width !== source.width || previous.height !== source.height;
    })) {
      batch = { createdAt: now(), sources: new Map(sources.map(source => [source.sourceId, source])) };
      batch.promise = Promise.resolve().then(capture).then(desktopSources => {
        batch.createdAt = now();
        return matchNativeVideoSourceThumbnails([...batch.sources.values()], desktopSources);
      });
      batches.set(kind, batch);
      batch.promise.catch(() => { if (batches.get(kind) === batch) batches.delete(kind); });
    }
    const thumbnails = await batch.promise;
    if (owner !== state) return [];
    const current = new Map(sources.map(source => [source.sourceId, source]));
    return thumbnails.filter(({ sourceId }) => {
      const previous = batch.sources.get(sourceId), source = current.get(sourceId);
      return source && previous.title === source.title && previous.windowId === source.windowId
        && previous.displayId === source.displayId && previous.width === source.width && previous.height === source.height;
    });
  };
}

module.exports = { matchNativeVideoSourceThumbnails, monitorDisplayId, createNativeThumbnailCache };
