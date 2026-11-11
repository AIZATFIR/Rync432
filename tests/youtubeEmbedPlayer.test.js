import { afterEach, describe, expect, it, vi } from 'vitest';
import { YouTubeEmbedPlayer } from '../public/js/music/YouTubeEmbedPlayer.js';

afterEach(() => {
  delete globalThis.YT;
  delete globalThis.location;
  delete globalThis.document;
  delete globalThis.onYouTubeIframeAPIReady;
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
  it('preloads the official iframe API without creating a player', async () => {
    vi.resetModules();
    const { YouTubeEmbedPlayer: IsolatedPlayer } = await import('../public/js/music/YouTubeEmbedPlayer.js');
    let scriptCount = 0;
    globalThis.YT = undefined;
    globalThis.document = {
      querySelector: () => null,
      createElement: () => ({ set src(value) { this._src = value; }, async: false }),
      head: { appendChild() { scriptCount++; } }
    };
    const player = new IsolatedPlayer('youtubePlayerContainer');
    const preload = player.preload();

    expect(scriptCount).toBe(1);
    expect(player.player).toBeNull();
    globalThis.YT = { Player: class {} };
    globalThis.onYouTubeIframeAPIReady();
    await expect(preload).resolves.toBe(true);
    expect(scriptCount).toBe(1);
    expect(player.player).toBeNull();
  });

  it('creates one iframe player when concurrent requests arrive before the API loads', async () => {
    const instances = [];
    globalThis.YT = undefined;
    globalThis.document = {
      querySelector: () => null,
      createElement: () => ({ set src(value) { this._src = value; }, async: false }),
      head: { appendChild() {} }
    };
    const player = new YouTubeEmbedPlayer('youtubePlayerContainer');
    const first = player.ensurePlayer();
    const second = player.ensurePlayer();
    class FakePlayer {
      constructor(elementId, options) {
        instances.push(this);
        queueMicrotask(() => options.events.onReady({ target: this }));
      }
    }

    globalThis.YT = { Player: FakePlayer };
    globalThis.onYouTubeIframeAPIReady();
    await Promise.all([first, second]);

    expect(instances).toHaveLength(1);
  });

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

  it('times out and resets when the iframe player never becomes ready', async () => {
    vi.useFakeTimers();
    const instances = [];
    globalThis.YT = { Player: class {
      constructor(elementId) { this.elementId = elementId; instances.push(this); }
      destroy() { this.destroyed = true; }
    } };
    const player = new YouTubeEmbedPlayer('youtubePlayerContainer');

    const readiness = player.ensurePlayer();
    const rejected = expect(readiness).rejects.toThrow('YOUTUBE_PLAYER_READY_TIMEOUT');
    await vi.advanceTimersByTimeAsync(12_000);
    await rejected;

    expect(instances[0].destroyed).toBe(true);
    expect(player.player).toBeNull();
    expect(player.readyPromise).toBeNull();
  });

  it('bounds total startup time when the iframe API loads but never calls ready', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { YouTubeEmbedPlayer: IsolatedYouTubeEmbedPlayer } = await import('../public/js/music/YouTubeEmbedPlayer.js');
    delete globalThis.YT;
    globalThis.document = {
      querySelector: () => null,
      createElement: () => ({ set src(value) { this._src = value; }, async: false }),
      head: { appendChild() {} }
    };
    const player = new IsolatedYouTubeEmbedPlayer('youtubePlayerContainer');
    const readiness = player.ensurePlayer();
    const result = readiness.then(() => null, error => error.message);
    await vi.advanceTimersByTimeAsync(11_900);

    globalThis.YT = { Player: class { constructor() {} } };
    globalThis.onYouTubeIframeAPIReady();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toBe('YOUTUBE_PLAYER_READY_TIMEOUT');
  });

  it('aligns iframe volume with this device slider', async () => {
    const instances = installFakePlayer();
    const player = new YouTubeEmbedPlayer('youtubePlayerContainer');
    await player.cueVideo('dQw4w9WgXcQ');
    await player.setVolume(0.35);

    expect(instances[0].calls).toContainEqual(['setVolume', 35]);
  });

  it('starts the loaded YouTube player synchronously from a user gesture', async () => {
    const instances = installFakePlayer();
    const player = new YouTubeEmbedPlayer('youtubePlayerContainer');
    await player.cueVideo('dQw4w9WgXcQ');

    expect(player.playFromUserGesture()).toBe(true);
    expect(instances[0].calls.filter(call => call[0] === 'playVideo')).toHaveLength(1);
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

  it('converts the shared server start time to this device clock before scheduling', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const instances = installFakePlayer();
    const clockSync = { toClientLocalTime: vi.fn(serverTime => serverTime - 1000) };
    const player = new YouTubeEmbedPlayer('youtubePlayerContainer', { clockSync });

    await player.playAt('dQw4w9WgXcQ', 11_500, 0);

    expect(clockSync.toClientLocalTime).toHaveBeenCalledWith(11_500);
    expect(instances[0].calls).not.toContainEqual(['playVideo']);
    vi.advanceTimersByTime(499);
    expect(instances[0].calls).not.toContainEqual(['playVideo']);
    vi.advanceTimersByTime(1);
    expect(instances[0].calls).toContainEqual(['playVideo']);
  });

  it('cancels an old scheduled start when a new track must play immediately', async () => {
    vi.useFakeTimers();
    const instances = installFakePlayer();
    const player = new YouTubeEmbedPlayer('youtubePlayerContainer');
    await player.cueVideo('dQw4w9WgXcQ');
    await player.playAt('dQw4w9WgXcQ', Date.now() + 1000, 0);
    await player.playAt('abcdefghijk', Date.now() - 1, 0);

    vi.advanceTimersByTime(1000);

    expect(instances[0].calls.filter(call => call[0] === 'playVideo')).toHaveLength(1);
    expect(instances[0].calls).toContainEqual(['cueVideoById', { videoId: 'abcdefghijk', startSeconds: 0 }]);
  });

  it('ignores stale play requests when a newer track is selected during iframe startup', async () => {
    const instances = installFakePlayer();
    const player = new YouTubeEmbedPlayer('youtubePlayerContainer');
    const oldRequest = player.playAt('dQw4w9WgXcQ', Date.now() - 1, 0);
    const newRequest = player.playAt('abcdefghijk', Date.now() - 1, 0);

    await Promise.all([oldRequest, newRequest]);

    expect(instances[0].calls.filter(call => call[0] === 'cueVideoById')).toEqual([
      ['cueVideoById', { videoId: 'abcdefghijk', startSeconds: 0 }]
    ]);
    expect(instances[0].calls.filter(call => call[0] === 'playVideo')).toHaveLength(1);
  });
});
