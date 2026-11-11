const RESULT_LIMIT = 8;
const QUERY_MAX_LENGTH = 200;
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_CACHE_MAX_ITEMS = 100;
const searchCache = new Map();

function parseIsoDuration(duration = '') {
  const match = duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return 0;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

function durationText(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function errorReason(payload) {
  return payload?.error?.errors?.[0]?.reason || '';
}

function sendProviderError(res, response, payload) {
  const reason = errorReason(payload);
  if (response.status === 403 && ['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded'].includes(reason)) {
    res.setHeader('Retry-After', '3600');
    return res.status(429).json({ error: 'RATE_LIMITED', provider: 'youtube', retryable: true });
  }
  if (response.status === 400 || response.status === 403) {
    return res.status(503).json({ error: 'PROVIDER_CONFIGURATION_ERROR', provider: 'youtube', retryable: false });
  }
  return res.status(502).json({ error: 'PROVIDER_UNAVAILABLE', provider: 'youtube', retryable: true });
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });

  const query = typeof req.query?.q === 'string' ? req.query.q.trim() : '';
  if (!query) return res.status(400).json({ error: 'MISSING_QUERY' });
  if (query.length > QUERY_MAX_LENGTH) return res.status(400).json({ error: 'QUERY_TOO_LONG', maxLength: QUERY_MAX_LENGTH });

  const key = process.env.YOUTUBE_DATA_API_KEY;
  if (!key) return res.status(503).json({ error: 'PROVIDER_NOT_CONFIGURED', provider: 'youtube', retryable: false });

  const cacheKey = query.toLocaleLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.storedAt < SEARCH_CACHE_TTL_MS) {
    return res.status(200).json({ results: cached.results, cached: true });
  }

  try {
    const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
    searchUrl.search = new URLSearchParams({
      key,
      part: 'snippet',
      q: query,
      type: 'video',
      videoCategoryId: '10',
      maxResults: String(RESULT_LIMIT)
    });
    const searchResponse = await fetchJson(searchUrl);
    const searchData = await searchResponse.json().catch(() => ({}));
    if (!searchResponse.ok) return sendProviderError(res, searchResponse, searchData);

    const videos = (Array.isArray(searchData.items) ? searchData.items : [])
      .filter(item => /^[A-Za-z0-9_-]{11}$/.test(item?.id?.videoId || ''))
      .slice(0, RESULT_LIMIT);
    if (!videos.length) return res.status(200).json({ results: [], cached: false });

    const detailsUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
    detailsUrl.search = new URLSearchParams({ key, part: 'contentDetails', id: videos.map(item => item.id.videoId).join(',') });
    const detailsResponse = await fetchJson(detailsUrl);
    const detailsData = detailsResponse.ok ? await detailsResponse.json().catch(() => ({})) : {};
    const durations = new Map((detailsData.items || []).map(item => [item.id, parseIsoDuration(item.contentDetails?.duration)]));
    const results = videos.map(item => {
      const id = item.id.videoId;
      const duration = durations.get(id) || 0;
      const thumbnails = item.snippet?.thumbnails || {};
      return {
        id,
        title: item.snippet?.title || 'YouTube video',
        channel: item.snippet?.channelTitle || 'YouTube channel',
        duration,
        durationText: duration ? durationText(duration) : '',
        thumbnail: thumbnails.medium?.url || thumbnails.default?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        url: `https://www.youtube.com/watch?v=${id}`
      };
    });

    searchCache.delete(cacheKey);
    searchCache.set(cacheKey, { results, storedAt: Date.now() });
    while (searchCache.size > SEARCH_CACHE_MAX_ITEMS) searchCache.delete(searchCache.keys().next().value);
    return res.status(200).json({ results, cached: false });
  } catch (error) {
    if (cached) return res.status(200).json({ results: cached.results, cached: true, stale: true });
    const timedOut = error?.name === 'AbortError';
    return res.status(timedOut ? 504 : 502).json({
      error: timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE',
      provider: 'youtube',
      retryable: true
    });
  }
}
