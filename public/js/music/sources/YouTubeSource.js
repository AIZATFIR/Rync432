import { MusicSourceType } from '../types.js';

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be']);
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

function parseYouTubeUrl(input) {
  if (typeof input !== 'string') return null;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch (error) {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(hostname)) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  const pathVideoId = hostname.endsWith('youtu.be')
    ? segments[0]
    : ['shorts', 'embed', 'live'].includes(segments[0]) ? segments[1] : '';
  const videoId = url.searchParams.get('v') || pathVideoId;
  return { videoId: VIDEO_ID_PATTERN.test(videoId || '') ? videoId : null };
}

export function isYouTubeUrl(input) {
  return parseYouTubeUrl(input) !== null;
}

export function extractYouTubeVideoId(input) {
  return parseYouTubeUrl(input)?.videoId || null;
}

export class YouTubeSource {
  constructor() {
    this.type = MusicSourceType.YOUTUBE;
  }

  canHandle(input) {
    return isYouTubeUrl(input);
  }

  extractVideoId(url) {
    return extractYouTubeVideoId(url);
  }

  async resolve(input, customMetadata = {}) {
    const trimmed = input.trim();
    let videoId = this.extractVideoId(trimmed);

    if (!videoId) {
      // If it's a search term or raw ID
      if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
        videoId = trimmed;
      } else {
        throw new Error('INVALID_URL: Video ID YouTube tidak ditemukan');
      }
    }

    const assetId = `yt_${videoId}`;

    return {
      trackId: assetId,
      id: assetId,
      title: customMetadata.title || 'YouTube Track',
      artist: customMetadata.artist || 'YouTube',
      duration: customMetadata.duration || 0,
      sourceType: this.type,
      sourceId: videoId,
      sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
      thumbnail: customMetadata.thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      thumbnailUrl: customMetadata.thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
    };
  }

  async search(query, { signal } = {}) {
    const trimmed = typeof query === 'string' ? query.trim() : '';
    if (!trimmed) return [];

    let resp;
    let data;
    try {
      resp = await fetch(`/api/yt-search?q=${encodeURIComponent(trimmed)}`, { signal });
      data = (await resp.json().catch(() => ({}))) || {};
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      const providerError = new Error('YouTube search is unavailable.');
      providerError.code = 'PROVIDER_UNAVAILABLE';
      providerError.retryable = true;
      throw providerError;
    }

    if (!resp.ok) {
      const error = new Error(data.error || `SEARCH_FAILED: Gagal mencari lagu (${resp.status})`);
      error.code = data.error || 'PROVIDER_UNAVAILABLE';
      error.retryable = data.retryable ?? (resp.status === 429 || resp.status >= 500);
      throw error;
    }

    return (Array.isArray(data.results) ? data.results : [])
      .filter(item => /^[A-Za-z0-9_-]{11}$/.test(item?.id || ''))
      .map(item => ({
        id: `yt_${item.id}`,
        name: item.title || 'YouTube video',
        artist: item.channel || 'YouTube channel',
        duration: item.duration,
        thumbnail: item.thumbnail,
        durationText: item.durationText,
        apiDataFetchedAt: item.apiDataFetchedAt,
        sourceType: this.type,
        sourceId: item.id,
        sourceUrl: item.url || `https://www.youtube.com/watch?v=${item.id}`
      }));
  }
}
