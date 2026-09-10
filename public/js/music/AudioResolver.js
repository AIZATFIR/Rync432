import { MusicErrorCode, MusicSourceType } from './types.js';

export class AudioResolver {
  constructor(options = {}) {
    this.streamProxyEndpoint = options.streamProxyEndpoint || '/api/stream';
  }

  /**
   * Resolves a ResolvedAudio into a browser-fetchable URL.
   * If direct fetch is CORS-blocked, transparently provides the streaming proxy URL.
   * @param {import('./types.js').ResolvedAudio} resolvedAudio
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ playableUrl: string, usedProxy: boolean, mimeType?: string }>}
   */
  async resolvePlayableEndpoint(resolvedAudio, signal) {
    if (!resolvedAudio) {
      throw new Error(`${MusicErrorCode.INVALID_URL}: ResolvedAudio kosong`);
    }

    if (resolvedAudio.isMetadataOnly) {
      throw new Error(`${MusicErrorCode.PROVIDER_UNAVAILABLE}: Sumber ini hanya berupa metadata`);
    }

    const initialUrl = resolvedAudio.playableUrl || resolvedAudio.streamUrl;
    if (!initialUrl) {
      throw new Error(`${MusicErrorCode.INVALID_URL}: URL stream tidak tersedia`);
    }

    // 1. If it's already an internal or blob or relative URL, return directly
    if (
      initialUrl.startsWith('/') ||
      initialUrl.startsWith('blob:') ||
      initialUrl.startsWith('data:') ||
      resolvedAudio.sourceType === MusicSourceType.LOCAL ||
      resolvedAudio.sourceType === MusicSourceType.PUBLIC_AUDIO ||
      resolvedAudio.requiresProxy
    ) {
      return {
        playableUrl: initialUrl,
        usedProxy: !!resolvedAudio.requiresProxy,
        mimeType: resolvedAudio.mimeType
      };
    }

    // 2. Direct URL: Test CORS fetchability with lightweight HEAD / range probe
    try {
      const probe = await fetch(initialUrl, {
        method: 'HEAD',
        signal: signal || (AbortSignal.timeout ? AbortSignal.timeout(3500) : undefined)
      });

      if (probe.ok) {
        return {
          playableUrl: initialUrl,
          usedProxy: false,
          mimeType: probe.headers.get('content-type') || resolvedAudio.mimeType
        };
      }
    } catch (e) {
      // CORS blocked or network error -> fallback to proxy
    }

    // 3. Fallback: Wrap in Rync432 Streaming Proxy
    const proxyUrl = `${this.streamProxyEndpoint}?url=${encodeURIComponent(initialUrl)}`;
    return {
      playableUrl: proxyUrl,
      usedProxy: true,
      mimeType: resolvedAudio.mimeType
    };
  }
}
