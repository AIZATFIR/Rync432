import { afterEach, describe, expect, it, vi } from 'vitest';
import { YouTubeEmbedPlayer } from '../public/js/music/YouTubeEmbedPlayer.js';

afterEach(() => {
  delete globalThis.YT;
  delete globalThis.location;
  vi.useRealTimers();
});

function installFakePlayer() {
  const instances = [];
  class FakePlayer {
    constructor(elementId, options) {
      this.elementId = elementId;
      this.options = options;
      this.calls = [];
      instances.push(this);
      queueMicrotask(() => options.events.onReady({ target: this }));
    }
    cueVideoById(value) { this.calls.push(['cueVideoById', value]); }
    seekTo(...args) { this.calls.push(['seekTo', ...args]); }
    playVideo() { this.calls.push(['playVideo']); }
    pauseVideo() { this.calls.push(['pauseVideo']); }
    setVolume(value) { this.calls.push(['setVolume', value]); }
    destroy() { this.calls.push(['destroy']); }
  }
  globalThis.YT = { Player: FakePlayer };
  globalThis.location = { origin: 'https://rync.zafir.my' };
  return instances;
}

describe('YouTube embedded player adapter', () => {
  it('uses the official visible player with API origin, cues tracks, and schedules playback', async () => {
    const instances = installFakePlayer();
    const player = new YouTubeEmbedPlayer('youtubePlayerContainer');

    await player.cueVideo('dQw4w9WgXcQ', 12);
    await player.playAt('dQw4w9WgXcQ', Date.now() - 1, 12);

    expect(instances).toHaveLength(1);
    expect(instances[0].options.playerVars).toMatchObject({ autoplay: 0, controls: 1, enablejsapi: 1, origin: 'https://rync.zafir.my' });
    expect(instances[0].calls).toContainEqual(['cueVideoById', { videoId: 'dQw4w9WgXcQ', startSeconds: 12 }]);
    expect(instances[0].calls).toContainEqual(['playVideo']);
  });

  it('rejects invalid video ids before constructing a player', async () => {
    const instances = installFakePlayer();
    const player = new YouTubeEmbedPlayer('youtubePlayerContainer');

    await expect(player.cueVideo('short')).rejects.toThrow('INVALID_YOUTUBE_VIDEO_ID');
    expect(instances).toHaveLength(0);
  });

  it('aligns iframe volume with this device slider', async () => {
    const instances = installFakePlayer();
    const player = new YouTubeEmbedPlayer('youtubePlayerContainer');
    await player.cueVideo('dQw4w9WgXcQ');
    await player.setVolume(0.35);

    expect(instances[0].calls).toContainEqual(['setVolume', 35]);
  });

  it('seeks after waiting for scheduled start time and cancels pending start on pause', async () => {
    vi.useFakeTimers();
    const instances = installFakePlayer();
    const player = new YouTubeEmbedPlayer('youtubePlayerContainer');
    await player.cueVideo('dQw4w9WgXcQ');
    await player.playAt('dQw4w9WgXcQ', Date.now() + 1000, 24);
    vi.advanceTimersByTime(1000);

    expect(instances[0].calls).toContainEqual(['seekTo', 24, true]);
    expect(instances[0].calls).toContainEqual(['playVideo']);

    await player.playAt('dQw4w9WgXcQ', Date.now() + 1000, 36);
    await player.pause();
    vi.advanceTimersByTime(1000);
    expect(instances[0].calls.filter(call => call[0] === 'playVideo')).toHaveLength(1);
  });
});
