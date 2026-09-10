import { MusicSourceType, hashString } from '../types.js';

export class DirectUrlSource {
  constructor() {
    this.type = MusicSourceType.DIRECT_URL;
  }

  /**
   * Checks if an input string is a valid direct audio URL.
   * @param {string} input
   * @returns {boolean}
   */
  canHandle(input) {
    if (typeof input !== 'string') return false;
    const trimmed = input.trim();
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
      return false;
    }
    // Exclude YouTube and Spotify domains
    if (
      trimmed.includes('youtube.com') ||
      trimmed.includes('youtu.be') ||
      trimmed.includes('spotify.com')
    ) {
      return false;
    }
    return true;
  }

  /**
   * Resolves direct URL into a normalized ResolvedAudio.
   * @param {string} url
   * @param {object} [customMetadata={}]
   * @returns {Promise<import('../types.js').ResolvedAudio>}
   */
  async resolve(url, customMetadata = {}) {
    const trimmed = url.trim();

    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch (e) {
      throw new Error('INVALID_URL: Format URL tidak valid');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('INVALID_URL: Protokol harus http atau https');
    }

    // Extract filename from pathname
    const pathname = parsed.pathname;
    const filename = pathname.split('/').pop() || 'Remote Audio';
    const cleanTitle = decodeURIComponent(filename.replace(/\.[a-zA-Z0-9]+$/, '')) || 'Direct Stream';

    // Detect MIME type
    let mimeType = 'audio/mpeg';
    const ext = pathname.split('.').pop()?.toLowerCase();
    if (ext === 'wav') mimeType = 'audio/wav';
    else if (ext === 'ogg') mimeType = 'audio/ogg';
    else if (ext === 'm4a' || ext === 'aac') mimeType = 'audio/mp4';
    else if (ext === 'flac') mimeType = 'audio/flac';

    const assetId = `direct_${hashString(trimmed)}`;

    return {
      trackId: assetId,
      title: customMetadata.title || cleanTitle,
      artist: customMetadata.artist || parsed.hostname,
      duration: customMetadata.duration || 0,
      sourceType: this.type,
      playableUrl: trimmed,
      streamUrl: trimmed,
      mimeType,
      supportsRange: true,
      requiresProxy: false,
      thumbnailUrl: customMetadata.thumbnailUrl || ''
    };
  }
}
