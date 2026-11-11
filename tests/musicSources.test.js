import { afterEach, describe, it, expect, vi } from 'vitest';
import { MusicSourceManager } from '../public/js/music/MusicSourceManager.js';
import { DirectUrlSource } from '../public/js/music/sources/DirectUrlSource.js';
import { YouTubeSource } from '../public/js/music/sources/YouTubeSource.js';
import { PublicAudioSource } from '../public/js/music/sources/PublicAudioSource.js';
import { LocalSource } from '../public/js/music/sources/LocalSource.js';
import { SpotifySource } from '../public/js/music/sources/SpotifySource.js';
import { AudioResolver } from '../public/js/music/AudioResolver.js';
import { MusicSourceType } from '../public/js/music/types.js';

afterEach(() => vi.unstubAllGlobals());

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
      expect(resolved.sourceId).toBe('dQw4w9WgXcQ');
      expect(resolved.sourceUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    });

    it('searches through the adapter with cancellation and normalized UI fields', async () => {
      const signal = new AbortController().signal;
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ results: [{
          id: 'dQw4w9WgXcQ', title: 'Song', channel: 'Artist', duration: 215,
          durationText: '3:35', thumbnail: 'https://img.youtube.com/thumb.jpg',
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
        }] })
      });
      vi.stubGlobal('fetch', fetchMock);

      const results = await ytSource.search('ambient', { signal });

      expect(fetchMock).toHaveBeenCalledWith('/api/yt-search?q=ambient', { signal });
      expect(results).toEqual([expect.objectContaining({
        id: 'yt_dQw4w9WgXcQ', name: 'Song', artist: 'Artist', duration: 215,
        sourceType: MusicSourceType.YOUTUBE, sourceId: 'dQw4w9WgXcQ',
        thumbnail: 'https://img.youtube.com/thumb.jpg',
        sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
      })]);
    });

    it('preserves structured provider errors and retryability', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false, status: 429, json: async () => ({ error: 'RATE_LIMITED', retryable: true })
      }));

      await expect(ytSource.search('ambient')).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true });
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

    it('preserves cancellation instead of returning a proxy endpoint', async () => {
      const controller = new AbortController();
      const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));
      const resolver = new AudioResolver();

      await expect(resolver.resolvePlayableEndpoint({
        trackId: 'direct_test',
        playableUrl: 'https://audio.example/song.mp3',
        sourceType: MusicSourceType.DIRECT_URL
      }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    });
  });
});
