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

// 一次 Electron 抓取包含同类所有窗口。按请求中的窗口校验，未变化的短期预览先显示、后台刷新。
function createNativeThumbnailCache(now = Date.now) {
  let owner;
  const batches = new Map();
  const sameSource = (before, source) => before && before.title === source.title && before.windowId === source.windowId
    && before.displayId === source.displayId && before.width === source.width && before.height === source.height;
  return async (state, kind, sources, capture, requestedIds = new Set(sources.map(source => source.sourceId))) => {
    if (owner !== state) { owner = state; batches.clear(); }
    let batch = batches.get(kind);
    if (!batch) { batch = {}; batches.set(kind, batch); }
    const byId = new Map(sources.map(source => [source.sourceId, source]));
    const requested = [...requestedIds].flatMap(id => byId.has(id) ? [byId.get(id)] : []);
    const current = new Map(requested.map(source => [source.sourceId, source]));
    const matching = snapshot => snapshot.thumbnails.filter(({ sourceId }) => {
      const source = current.get(sourceId);
      return source && sameSource(snapshot.sources.get(sourceId), source);
    });
    const previous = batch.snapshot;
    if (previous && now() - previous.createdAt < 10_000
        && requested.every(source => sameSource(previous.sources.get(source.sourceId), source)
          && (previous.requestedIds.has(source.sourceId)
            || previous.thumbnails.some(thumbnail => thumbnail.sourceId === source.sourceId)))) return matching(previous);
    if (!batch.pending) {
      const snapshotSources = new Map(sources.map(source => [source.sourceId, source]));
      const pending = Promise.resolve().then(capture).then(desktopSources => {
        const snapshot = { sources: snapshotSources, requestedIds: new Set(requestedIds), createdAt: now(),
          // 编码与缓存有总量上限，先保留用户正在查看的来源，避免被后台窗口占满。
          thumbnails: matchNativeVideoSourceThumbnails([...requested,
            ...sources.filter(source => !requestedIds.has(source.sourceId))], desktopSources) };
        if (owner === state && batches.get(kind) === batch) batch.snapshot = snapshot;
        return snapshot;
      }).finally(() => { if (batch.pending === pending) batch.pending = undefined; });
      batch.pending = pending;
      // 返回缓存时仍保留失败处理；缺少预览的调用方会等待并收到原始异常。
      void pending.catch(error => console.warn('共享缩略图刷新失败', error.message));
    }
    const cached = previous && now() - previous.createdAt < 60_000 ? matching(previous) : [];
    // 一个新窗口缺图不应拖住其他窗口；缺图由选择器现有的有界刷新继续补齐。
    if (cached.length) return cached;
    const snapshot = await batch.pending;
    return owner === state ? matching(snapshot) : [];
  };
}

module.exports = { matchNativeVideoSourceThumbnails, monitorDisplayId, createNativeThumbnailCache };
