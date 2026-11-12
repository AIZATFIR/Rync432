const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const REQUEST_TIMEOUT_MS = 2_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ITEMS = 500;
const policyCache = new Map();
const inFlightLookups = new Map();

function providerFailure(response, payload) {
  const reason = payload?.error?.errors?.[0]?.reason || '';
  if (response.status === 403 && ['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded'].includes(reason)) {
    return { statusCode: 429, body: { error: 'RATE_LIMITED', retryable: true } };
  }
  return { statusCode: 502, body: { error: 'VIDEO_POLICY_UNAVAILABLE', retryable: true } };
}

async function lookupVideoPolicy(videoId, key) {
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.search = new URLSearchParams({ key, part: 'id,status', id: videoId });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return providerFailure(response, payload);
    const video = payload.items?.find(item => item.id === videoId);
    if (!video) return { statusCode: 404, body: { error: 'VIDEO_NOT_FOUND', retryable: false } };
    if (typeof video.status?.madeForKids !== 'boolean' || typeof video.status?.embeddable !== 'boolean') {
      return { statusCode: 502, body: { error: 'VIDEO_POLICY_UNAVAILABLE', retryable: true } };
    }
    const result = {
      statusCode: 200,
      body: { videoId, madeForKids: video.status.madeForKids, embeddable: video.status.embeddable }
    };
    policyCache.delete(videoId);
    policyCache.set(videoId, { result, storedAt: Date.now() });
    while (policyCache.size > CACHE_MAX_ITEMS) policyCache.delete(policyCache.keys().next().value);
    return result;
  } catch (error) {
    return {
      statusCode: error?.name === 'AbortError' ? 504 : 502,
      body: { error: error?.name === 'AbortError' ? 'PROVIDER_TIMEOUT' : 'VIDEO_POLICY_UNAVAILABLE', retryable: true }
    };
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });

  const videoId = typeof req.query?.id === 'string' ? req.query.id : '';
  if (!VIDEO_ID_PATTERN.test(videoId)) return res.status(400).json({ error: 'INVALID_VIDEO_ID' });

  const key = process.env.YOUTUBE_DATA_API_KEY;
  if (!key) return res.status(503).json({ error: 'PROVIDER_NOT_CONFIGURED', provider: 'youtube', retryable: false });

  const cached = policyCache.get(videoId);
  if (cached && Date.now() - cached.storedAt < CACHE_TTL_MS) {
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(cached.result.statusCode).json(cached.result.body);
  }

  let lookup = inFlightLookups.get(videoId);
  if (!lookup) {
    lookup = lookupVideoPolicy(videoId, key);
    inFlightLookups.set(videoId, lookup);
  }
  try {
    const result = await lookup;
    if (result.statusCode === 200) res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(result.statusCode).json(result.body);
  } finally {
    if (inFlightLookups.get(videoId) === lookup) inFlightLookups.delete(videoId);
  }
}
