import { DirectUrlSource } from './sources/DirectUrlSource.js';
import { YouTubeSource } from './sources/YouTubeSource.js';
import { PublicAudioSource } from './sources/PublicAudioSource.js';
import { LocalSource } from './sources/LocalSource.js';
import { SpotifySource } from './sources/SpotifySource.js';
import { AudioResolver } from './AudioResolver.js';
import { MusicSourceType, MusicErrorCode } from './types.js';

export class MusicSourceManager {
  constructor(options = {}) {
    this.sources = new Map();
    this.audioResolver = new AudioResolver(options);

    // Register built-in default sources
    this.registerSource(new DirectUrlSource());
    this.registerSource(new YouTubeSource());
    this.registerSource(new PublicAudioSource());
    this.registerSource(new LocalSource());
    this.registerSource(new SpotifySource());
  }

  /**
   * Registers a source adapter.
   * @param {object} sourceInstance
   */
  registerSource(sourceInstance) {
    if (sourceInstance && sourceInstance.type) {
      this.sources.set(sourceInstance.type, sourceInstance);
    }
  }

  /**
   * Retrieves a source adapter by type.
   * @param {string} type
   */
  getSource(type) {
    return this.sources.get(type);
  }

  /**
   * Automatically detects the appropriate source adapter for an input.
   * @param {any} input
   * @returns {object|null}
   */
  detectSource(input) {
    for (const source of this.sources.values()) {
      if (typeof source.canHandle === 'function' && source.canHandle(input)) {
        return source;
      }
    }
    return null;
  }

  /**
   * Resolves any input (URL, query, file) into a normalized ResolvedAudio.
   * @param {any} input
   * @param {object} [customMetadata={}]
   * @returns {Promise<import('./types.js').ResolvedAudio>}
   */
  async resolve(input, customMetadata = {}) {
    const source = this.detectSource(input);
    if (!source) {
      throw new Error(`${MusicErrorCode.INVALID_URL}: Format atau sumber musik tidak didukung`);
    }

    const resolved = await source.resolve(input, customMetadata);
    return resolved;
  }

  /**
   * Searches for music tracks across compatible sources.
   * @param {string} query
   * @param {string} [sourceType=MusicSourceType.YOUTUBE]
   * @returns {Promise<Array<import('./types.js').MusicTrack>>}
   */
  async search(query, sourceType = MusicSourceType.YOUTUBE) {
    const source = this.getSource(sourceType);
    if (source && typeof source.search === 'function') {
      return source.search(query);
    }
    return [];
  }
}
