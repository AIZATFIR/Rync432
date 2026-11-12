export const YOUTUBE_API_DATA_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function isExpiredYouTubeApiData(item, now = Date.now()) {
  const isYouTubeItem = item?.sourceType === 'youtube' || String(item?.id || '').startsWith('yt_');
  if (!isYouTubeItem) return false;
  const fetchedAt = Number(item?.apiDataFetchedAt);
  return Number.isFinite(fetchedAt) && fetchedAt > 0 && now - fetchedAt >= YOUTUBE_API_DATA_TTL_MS;
}
