import { MusicSourceType, hashString } from '../types.js';

export class YouTubeSource {
  constructor() {
    this.type = MusicSourceType.YOUTUBE;
  }

  canHandle(input) {
    if (typeof input !== 'string') return false;
    const trimmed = input.trim();
    return trimmed.includes('youtube.com') || trimmed.includes('youtu.be');
  }

  extractVideoId(url) {
    const match = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
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

    const streamEndpoint = `/api/yt-stream?id=${videoId}`;
    const assetId = `yt_${videoId}`;

    return {
      trackId: assetId,
      title: customMetadata.title || 'YouTube Track',
      artist: customMetadata.artist || 'YouTube',
      duration: customMetadata.duration || 0,
      sourceType: this.type,
      playableUrl: streamEndpoint,
      streamUrl: streamEndpoint,
      mimeType: 'audio/mp4',
      supportsRange: true,
      requiresProxy: true,
      thumbnailUrl: customMetadata.thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
    };
  }

  async search(query) {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const resp = await fetch(`/api/yt-search?q=${encodeURIComponent(trimmed)}`);
    if (!resp.ok) {
      throw new Error(`SEARCH_FAILED: Gagal mencari lagu (${resp.status})`);
    }
    const data = await resp.json();
    return (data.results || []).map(item => ({
      id: `yt_${item.id}`,
      title: item.title,
      artist: item.channel,
      duration: item.duration,
      thumbnailUrl: item.thumbnail,
      sourceType: this.type,
      sourceUrl: item.url,
      streamUrl: `/api/yt-stream?url=${encodeURIComponent(item.url)}`
    }));
  }
}
