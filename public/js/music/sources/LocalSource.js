import { MusicSourceType, hashString } from '../types.js';

export class LocalSource {
  constructor() {
    this.type = MusicSourceType.LOCAL;
  }

  canHandle(input) {
    if (typeof File !== 'undefined' && input instanceof File) return true;
    if (typeof Blob !== 'undefined' && input instanceof Blob) return true;
    if (typeof input === 'object' && input !== null && input.isLocal) return true;
    return false;
  }

  async resolve(file, customMetadata = {}) {
    if (!file) throw new Error('INVALID_FILE: File audio tidak ditemukan');

    const filename = file.name || 'Local File';
    const cleanTitle = filename.replace(/\.[a-zA-Z0-9]+$/, '') || 'Local Audio';
    const assetId = `local_${hashString(filename + '_' + (file.size || 0))}`;

    let playableUrl = '';
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      try {
        playableUrl = URL.createObjectURL(file);
      } catch (e) {}
    }

    return {
      trackId: assetId,
      title: customMetadata.title || cleanTitle,
      artist: customMetadata.artist || 'Local Upload',
      duration: customMetadata.duration || 0,
      sourceType: this.type,
      playableUrl,
      streamUrl: playableUrl,
      mimeType: file.type || 'audio/mpeg',
      fileRef: file,
      thumbnailUrl: ''
    };
  }
}
