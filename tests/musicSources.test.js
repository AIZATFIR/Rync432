import { describe, it, expect } from 'vitest';
import { MusicSourceManager } from '../public/js/music/MusicSourceManager.js';
import { DirectUrlSource } from '../public/js/music/sources/DirectUrlSource.js';
import { YouTubeSource } from '../public/js/music/sources/YouTubeSource.js';
import { PublicAudioSource } from '../public/js/music/sources/PublicAudioSource.js';
import { LocalSource } from '../public/js/music/sources/LocalSource.js';
import { SpotifySource } from '../public/js/music/sources/SpotifySource.js';
import { AudioResolver } from '../public/js/music/AudioResolver.js';
import { MusicSourceType } from '../public/js/music/types.js';

describe('Music Sources & Resolver Layer', () => {
  const manager = new MusicSourceManager();

  describe('DirectUrlSource', () => {
    const directSource = new DirectUrlSource();

    it('identifies direct audio URLs', () => {
      expect(directSource.canHandle('https://example.com/audio/song.mp3')).toBe(true);
      expect(directSource.canHandle('http://cdn.site.com/track.wav')).toBe(true);
      expect(directSource.canHandle('https://youtube.com/watch?v=123')).toBe(false);
      expect(directSource.canHandle('https://open.spotify.com/track/123')).toBe(false);
    });

    it('resolves direct audio URL to normalized ResolvedAudio', async () => {
      const resolved = await directSource.resolve('https://archive.org/audio/space_beat.flac');
      expect(resolved.trackId).toMatch(/^direct_/);
      expect(resolved.title).toBe('space_beat');
      expect(resolved.sourceType).toBe(MusicSourceType.DIRECT_URL);
      expect(resolved.playableUrl).toBe('https://archive.org/audio/space_beat.flac');
      expect(resolved.mimeType).toBe('audio/flac');
      expect(resolved.supportsRange).toBe(true);
    });

    it('rejects non-http/https URLs', async () => {
      await expect(directSource.resolve('javascript:alert(1)')).rejects.toThrow();
    });
  });

  describe('YouTubeSource', () => {
    const ytSource = new YouTubeSource();

    it('extracts YouTube video IDs and generates normalized asset', async () => {
      expect(ytSource.canHandle('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
      expect(ytSource.canHandle('https://youtu.be/dQw4w9WgXcQ')).toBe(true);

      const resolved = await ytSource.resolve('https://youtu.be/dQw4w9WgXcQ');
      expect(resolved.trackId).toBe('yt_dQw4w9WgXcQ');
      expect(resolved.sourceType).toBe(MusicSourceType.YOUTUBE);
      expect(resolved.playableUrl).toContain('dQw4w9WgXcQ');
      expect(resolved.requiresProxy).toBe(true);
    });
  });

  describe('SpotifySource', () => {
    const spotifySource = new SpotifySource();

    it('handles Spotify links with metadata-only boundary', async () => {
      expect(spotifySource.canHandle('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT')).toBe(true);

      const resolved = await spotifySource.resolve('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
      expect(resolved.trackId).toBe('spotify_4cOdK2wGLETKBW3PvgPWqT');
      expect(resolved.isMetadataOnly).toBe(true);
      expect(resolved.sourceType).toBe(MusicSourceType.SPOTIFY);
    });
  });

  describe('PublicAudioSource', () => {
    const publicSource = new PublicAudioSource();

    it('resolves demo presets', async () => {
      expect(publicSource.canHandle('public_acoustic_wav')).toBe(true);
      const resolved = await publicSource.resolve('public_acoustic_wav');
      expect(resolved.title).toBe('Acoustic Master WAV');
      expect(resolved.playableUrl).toBe('/sample.wav');
    });
  });

  describe('MusicSourceManager & AudioResolver', () => {
    it('automatically dispatches to matching source adapter', async () => {
      const resDirect = await manager.resolve('https://my-cdn.com/groove.mp3');
      expect(resDirect.sourceType).toBe(MusicSourceType.DIRECT_URL);

      const resYt = await manager.resolve('https://youtube.com/watch?v=abcdefghijk');
      expect(resYt.sourceType).toBe(MusicSourceType.YOUTUBE);
    });

    it('resolves playable endpoints with proxy fallback when needed', async () => {
      const resolver = new AudioResolver();
      const resolvedMock = {
        trackId: 'direct_test',
        playableUrl: '/sample.wav',
        sourceType: MusicSourceType.PUBLIC_AUDIO
      };

      const endpoint = await resolver.resolvePlayableEndpoint(resolvedMock);
      expect(endpoint.playableUrl).toBe('/sample.wav');
      expect(endpoint.usedProxy).toBe(false);
    });
  });
});
