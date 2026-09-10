import { MusicSourceType, hashString } from '../types.js';

export class SpotifySource {
  constructor() {
    this.type = MusicSourceType.SPOTIFY;
  }

  canHandle(input) {
    if (typeof input !== 'string') return false;
    return input.includes('spotify.com') || input.startsWith('spotify:');
  }

  extractSpotifyId(urlOrUri) {
    const match = urlOrUri.match(/track[/:]([a-zA-Z0-9]+)/);
    return match ? match[1] : null;
  }

  async resolve(input, customMetadata = {}) {
    const spotifyId = this.extractSpotifyId(input) || 'unknown';
    const assetId = `spotify_${spotifyId}`;

    return {
      trackId: assetId,
      title: customMetadata.title || 'Spotify Track',
      artist: customMetadata.artist || 'Spotify Artist',
      duration: customMetadata.duration || 0,
      sourceType: this.type,
      playableUrl: '',
      streamUrl: '',
      isMetadataOnly: true,
      providerNote: 'Spotify playback requires official Web Playback SDK or linked streaming source.'
    };
  }
}
