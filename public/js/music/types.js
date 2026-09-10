/**
 * Rync432 Normalized Music Types & Standardized Error States
 */

export const MusicSourceType = {
  DIRECT_URL: 'direct-url',
  YOUTUBE: 'youtube',
  PUBLIC_AUDIO: 'public-audio',
  LOCAL: 'local',
  SPOTIFY: 'spotify',
  PROXY: 'proxy'
};

export const AudioReadinessState = {
  BUFFERING: 'BUFFERING',
  READY: 'READY',
  PLAYABLE: 'PLAYABLE',
  FAILED: 'FAILED'
};

export const MusicErrorCode = {
  SOURCE_UNREACHABLE: 'SOURCE_UNREACHABLE',
  CORS_BLOCKED: 'CORS_BLOCKED',
  INVALID_URL: 'INVALID_URL',
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  PROXY_REQUIRED: 'PROXY_REQUIRED',
  RANGE_UNSUPPORTED: 'RANGE_UNSUPPORTED',
  STREAM_TIMEOUT: 'STREAM_TIMEOUT',
  RATE_LIMITED: 'RATE_LIMITED',
  SOURCE_FORBIDDEN: 'SOURCE_FORBIDDEN',
  DEVICE_NOT_READY: 'DEVICE_NOT_READY'
};

/**
 * Generates a simple deterministic hash for asset IDs.
 * @param {string} str
 * @returns {string}
 */
export function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}
