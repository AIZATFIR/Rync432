import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordLocalMetric, readLocalMetrics } from '../public/js/metrics/localMetrics.js';

afterEach(() => vi.unstubAllGlobals());

describe('local performance metrics', () => {
  it('stores bounded duration samples without event identifiers', () => {
    const store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: key => store.get(key) || null,
      setItem: (key, value) => store.set(key, value)
    });

    recordLocalMetric('queue_ack_ms', 42, { outcome: 'success', roomId: 'SECRET', track: 'Song' });
    const metrics = readLocalMetrics();

    expect(metrics.queue_ack_ms).toEqual([{ durationMs: 42, outcome: 'success' }]);
    expect(JSON.stringify(metrics)).not.toContain('SECRET');
    expect(JSON.stringify(metrics)).not.toContain('Song');
  });

  it('ignores invalid values and survives unavailable storage', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });

    expect(() => recordLocalMetric('queue_ack_ms', -1)).not.toThrow();
    expect(() => recordLocalMetric('bad metric', 1)).not.toThrow();
    expect(readLocalMetrics()).toEqual({});
  });
});
