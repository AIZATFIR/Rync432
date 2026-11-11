const RESULT_LIMIT = 8;
const QUERY_MAX_LENGTH = 200;
const PROVIDER_REQUEST_TIMEOUT_MS = 3_000;
const DURATION_ENRICHMENT_TIMEOUT_MS = 500;
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_CACHE_MAX_ITEMS = 100;
const searchCache = new Map();
const inFlightSearches = new Map();

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

function providerErrorResponse(response, payload) {
  const reason = errorReason(payload);
  if (response.status === 403 && ['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded'].includes(reason)) {
    return { statusCode: 429, retryAfter: '3600', body: { error: 'RATE_LIMITED', provider: 'youtube', retryable: true } };
  }
  if (response.status === 400 || response.status === 403) {
    return { statusCode: 503, body: { error: 'PROVIDER_CONFIGURATION_ERROR', provider: 'youtube', retryable: false } };
  }
  return { statusCode: 502, body: { error: 'PROVIDER_UNAVAILABLE', provider: 'youtube', retryable: true } };
}

async function fetchJson(url, timeoutMs = PROVIDER_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  let timeout;
  try {
    const request = (async () => {
      const response = await fetch(url, { signal: controller.signal });
      return { response, data: (await response.json().catch(() => ({}))) || {} };
    })();
    return await Promise.race([
      request,
      new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error('PROVIDER_TIMEOUT'), { name: 'TimeoutError' }));
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function cacheResults(cacheKey, results) {
  searchCache.delete(cacheKey);
  searchCache.set(cacheKey, { results, storedAt: Date.now() });
  while (searchCache.size > SEARCH_CACHE_MAX_ITEMS) searchCache.delete(searchCache.keys().next().value);
}

async function resolveSearch(query, cacheKey, key, staleCache) {
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
    const { response: searchResponse, data: searchData } = await fetchJson(searchUrl);
    if (!searchResponse.ok) return providerErrorResponse(searchResponse, searchData);

    const videos = (Array.isArray(searchData.items) ? searchData.items : [])
      .filter(item => /^[A-Za-z0-9_-]{11}$/.test(item?.id?.videoId || ''))
      .slice(0, RESULT_LIMIT);
    if (!videos.length) {
      cacheResults(cacheKey, []);
      return { statusCode: 200, body: { results: [], cached: false } };
    }

    const detailsUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
    detailsUrl.search = new URLSearchParams({ key, part: 'contentDetails', id: videos.map(item => item.id.videoId).join(',') });
    let detailsData = {};
    try {
      const { response: detailsResponse, data } = await fetchJson(detailsUrl, DURATION_ENRICHMENT_TIMEOUT_MS);
      if (detailsResponse.ok) detailsData = data;
    } catch (error) {
      // Duration is supplemental; valid video results remain usable if enrichment is slow.
    }
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

    cacheResults(cacheKey, results);
    return { statusCode: 200, body: { results, cached: false } };
  } catch (error) {
    if (staleCache) return { statusCode: 200, body: { results: staleCache.results, cached: true, stale: true } };
    const timedOut = error?.name === 'AbortError' || error?.name === 'TimeoutError';
    return {
      statusCode: timedOut ? 504 : 502,
      body: { error: timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE', provider: 'youtube', retryable: true }
    };
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

  let search = inFlightSearches.get(cacheKey);
  if (!search) {
    search = resolveSearch(query, cacheKey, key, cached);
    inFlightSearches.set(cacheKey, search);
  }
  try {
    const result = await search;
    if (result.retryAfter) res.setHeader('Retry-After', result.retryAfter);
    return res.status(result.statusCode).json(result.body);
  } finally {
    if (inFlightSearches.get(cacheKey) === search) inFlightSearches.delete(cacheKey);
  }
}
