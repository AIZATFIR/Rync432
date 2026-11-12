import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../public/js/audio/AudioEngine.js';

afterEach(() => vi.useRealTimers());

function makeContext(state = 'running') {
  const started = [];
  const listeners = new Map();
  const baseTime = Date.now();
  const context = {
    state,
    get currentTime() { return (Date.now() - baseTime) / 1000; },
    createBufferSource: () => {
      const source = {
        connect() {},
        start: (...args) => started.push(args),
        stop() {},
        disconnect() {}
      };
      return source;
    },
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: type => listeners.delete(type),
    dispatchStateChange: () => listeners.get('statechange')?.()
  };
  return { context, started };
}

describe('AudioEngine scheduled playback state', () => {
  it('reports playback only after the scheduled audio clock reaches its start', async () => {
    vi.useFakeTimers();
    const { context, started } = makeContext();
    const engine = new AudioEngine(null);
    engine.ctx = context;
    engine.audioBuffer = { duration: 30 };
    engine.bassFilter = {};
    engine.latencyTuner.calculateEffectiveStartTime = () => Date.now() + 1_000;
    const onPlaybackStarted = vi.fn();
    engine.onPlaybackStarted = onPlaybackStarted;

    engine.schedulePlayAtServerTime(Date.now() + 1_000, 0);
    await Promise.resolve();

    expect(started).toHaveLength(1);
    expect(engine.isPlaying).toBe(true);
    expect(engine.isPlaybackActive).toBe(false);
    expect(onPlaybackStarted).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(engine.isPlaybackActive).toBe(true);
    expect(onPlaybackStarted).toHaveBeenCalledOnce();
  });

  it('waits for AudioContext unlock before reporting playback started', async () => {
    vi.useFakeTimers();
    const { context } = makeContext('suspended');
    const engine = new AudioEngine(null);
    engine.ctx = context;
    engine.audioBuffer = { duration: 30 };
    engine.bassFilter = {};
    engine.latencyTuner.calculateEffectiveStartTime = () => Date.now();
    engine.ctx.resume = vi.fn().mockResolvedValue(undefined);
    const onPlaybackBlocked = vi.fn();
    const onPlaybackStarted = vi.fn();
    engine.onPlaybackBlocked = onPlaybackBlocked;
    engine.onPlaybackStarted = onPlaybackStarted;

    engine.schedulePlayAtServerTime(Date.now(), 0);
    await vi.advanceTimersByTimeAsync(0);

    expect(onPlaybackBlocked).toHaveBeenCalledOnce();
    expect(engine.isPlaybackActive).toBe(false);
    expect(onPlaybackStarted).not.toHaveBeenCalled();

    context.state = 'running';
    context.dispatchStateChange();
    await vi.advanceTimersByTimeAsync(0);

    expect(engine.isPlaybackActive).toBe(true);
    expect(onPlaybackStarted).toHaveBeenCalledOnce();
  });

  it('does not report a scheduled start after playback is cancelled', async () => {
    vi.useFakeTimers();
    const { context } = makeContext();
    const engine = new AudioEngine(null);
    engine.ctx = context;
    engine.audioBuffer = { duration: 30 };
    engine.bassFilter = {};
    engine.latencyTuner.calculateEffectiveStartTime = () => Date.now() + 1_000;
    const onPlaybackStarted = vi.fn();
    engine.onPlaybackStarted = onPlaybackStarted;

    engine.schedulePlayAtServerTime(Date.now() + 1_000, 0);
    engine.stopLocalPlayback();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(engine.isPlaybackActive).toBe(false);
    expect(onPlaybackStarted).not.toHaveBeenCalled();
  });
});
