const MAX_THUMBNAIL_BYTES = 64 * 1024;
const MAX_TOTAL_THUMBNAIL_BYTES = 768 * 1024;
const DATA_URL_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,/i;

function matchNativeVideoSourceThumbnails(videoSources, desktopSources) {
  const nativeTitleCounts = countTitles(videoSources, (source) => nativeCaptureType(source.kind), (source) => source.title);
  const desktopTitleCounts = countTitles(desktopSources, (source) => source.type, (source) => source.name);
  const thumbnails = [];
  let totalBytes = 0;

  for (const source of videoSources) {
    const type = nativeCaptureType(source.kind);
    let desktopSource;
    if (source.kind === 'monitor') {
      // Windows 设备名与 Electron 屏幕名称不同，必须按对应显示器 ID 匹配，不能按排列猜测。
      if (!source.displayId) continue;
      const matches = desktopSources.filter((candidate) => candidate.type === 'screen'
        && candidate.displayId === source.displayId);
      if (matches.length !== 1) continue;
      desktopSource = matches[0];
    } else {
      const key = titleKey(type, source.title);
      if (!source.title || nativeTitleCounts.get(key) !== 1 || desktopTitleCounts.get(key) !== 1) continue;
      desktopSource = desktopSources.find((candidate) => candidate.type === type && candidate.name === source.title);
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

function nativeCaptureType(kind) {
  return kind === 'monitor' ? 'screen' : kind;
}

function countTitles(sources, getKind, getTitle) {
  const counts = new Map();
  for (const source of sources) {
    const title = getTitle(source);
    if (typeof title !== 'string' || !title) continue;
    const key = titleKey(getKind(source), title);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function titleKey(kind, title) {
  return `${kind}\0${title}`;
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

module.exports = { matchNativeVideoSourceThumbnails, monitorDisplayId };
