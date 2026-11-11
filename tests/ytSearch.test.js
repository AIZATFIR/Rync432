import { afterEach, describe, expect, it, vi } from 'vitest';
import handler from '../api/yt-search.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function callSearch(query) {
  let statusCode = 0;
  let body;
  const res = {
    setHeader() {},
    status(code) { statusCode = code; return this; },
    json(value) { body = value; return this; },
    end() { return this; }
  };
  await handler({ method: 'GET', query: { q: query } }, res);
  return { statusCode, body };
}

describe('YouTube search API', () => {
  it('reports missing provider configuration without making external requests', async () => {
    vi.stubEnv('YOUTUBE_DATA_API_KEY', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await callSearch('ambient music');

    expect(result.statusCode).toBe(503);
    expect(result.body.error).toBe('PROVIDER_NOT_CONFIGURED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses YouTube Data API metadata and official video ids', async () => {
    vi.stubEnv('YOUTUBE_DATA_API_KEY', 'test-key');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{
        id: { videoId: 'dQw4w9WgXcQ' },
        snippet: {
          title: 'Song title',
          channelTitle: 'Artist',
          thumbnails: { medium: { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg' } }
        }
      }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{
        id: 'dQw4w9WgXcQ', contentDetails: { duration: 'PT3M35S' }
      }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callSearch(`official api ${Date.now()}`);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const searchUrl = new URL(fetchMock.mock.calls[0][0]);
    expect(searchUrl.origin + searchUrl.pathname).toBe('https://www.googleapis.com/youtube/v3/search');
    expect(searchUrl.searchParams.get('key')).toBe('test-key');
    expect(result.statusCode).toBe(200);
    expect(result.body.results).toEqual([expect.objectContaining({
      id: 'dQw4w9WgXcQ',
      title: 'Song title',
      channel: 'Artist',
      duration: 215,
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    })]);
  });

  it('maps exhausted YouTube quota to a retryable rate limit response', async () => {
    vi.stubEnv('YOUTUBE_DATA_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { errors: [{ reason: 'quotaExceeded' }] }
    }), { status: 403 })));

    const result = await callSearch(`quota test ${Date.now()}`);

    expect(result.statusCode).toBe(429);
    expect(result.body.error).toBe('RATE_LIMITED');
  });

  it('keeps valid search results when duration enrichment times out', async () => {
    vi.useFakeTimers();
    vi.stubEnv('YOUTUBE_DATA_API_KEY', 'test-key');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{
        id: { videoId: 'dQw4w9WgXcQ' },
        snippet: { title: 'Song title', channelTitle: 'Artist', thumbnails: {} }
      }] }), { status: 200 }))
      .mockImplementationOnce((_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      }));
    vi.stubGlobal('fetch', fetchMock);

    const search = callSearch(`metadata timeout ${Date.now()}`);
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await search;

    expect(result.statusCode).toBe(200);
    expect(result.body.results).toEqual([expect.objectContaining({
      id: 'dQw4w9WgXcQ', title: 'Song title', duration: 0
    })]);
  });

  it('returns a structured timeout when the provider search itself stalls', async () => {
    vi.useFakeTimers();
    vi.stubEnv('YOUTUBE_DATA_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    })));

    const search = callSearch(`slow provider ${Date.now()}`);
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await search;

    expect(result.statusCode).toBe(504);
    expect(result.body).toMatchObject({ error: 'PROVIDER_TIMEOUT', provider: 'youtube', retryable: true });
  });
});
