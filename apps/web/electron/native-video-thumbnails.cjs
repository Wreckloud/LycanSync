const MAX_THUMBNAIL_BYTES = 32 * 1024;
const MAX_TOTAL_THUMBNAIL_BYTES = 512 * 1024;
const DATA_URL_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,/i;

function matchNativeVideoSourceThumbnails(videoSources, desktopSources) {
  const nativeTitleCounts = countTitles(videoSources, (source) => nativeCaptureType(source.kind), (source) => source.title);
  const desktopTitleCounts = countTitles(desktopSources, (source) => source.type, (source) => source.name);
  const thumbnails = [];
  let totalBytes = 0;

  for (const source of videoSources) {
    const type = nativeCaptureType(source.kind);
    const key = titleKey(type, source.title);
    if (!source.title || nativeTitleCounts.get(key) !== 1 || desktopTitleCounts.get(key) !== 1) continue;
    const desktopSource = desktopSources.find((candidate) => candidate.type === type
      && candidate.name === source.title);
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

module.exports = { matchNativeVideoSourceThumbnails };
