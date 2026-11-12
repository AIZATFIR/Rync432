import { afterEach, describe, expect, it, vi } from 'vitest';
import handler from '../api/yt-video-policy.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function callPolicy(id) {
  let statusCode = 0;
  let body;
  const headers = {};
  const res = {
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    status(code) { statusCode = code; return this; },
    json(value) { body = value; return this; }
  };
  await handler({ method: 'GET', query: { id } }, res);
  return { statusCode, body, headers };
}

describe('YouTube video policy API', () => {
  it('looks up embeddability and Made for Kids status before playback', async () => {
    vi.stubEnv('YOUTUBE_DATA_API_KEY', 'test-key');
    const fetchMock = vi.fn(async url => {
      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe('https://www.googleapis.com/youtube/v3/videos');
      expect(parsed.searchParams.get('part')).toBe('id,status');
      expect(parsed.searchParams.get('id')).toBe('dQw4w9WgXcQ');
      return new Response(JSON.stringify({ items: [{
        id: 'dQw4w9WgXcQ', status: { madeForKids: true, embeddable: true }
      }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await callPolicy('dQw4w9WgXcQ');

    expect(result).toMatchObject({ statusCode: 200, body: { videoId: 'dQw4w9WgXcQ', madeForKids: true, embeddable: true } });
    expect(result.headers['cache-control']).toBe('private, max-age=300');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when YouTube omits the required policy fields', async () => {
    vi.stubEnv('YOUTUBE_DATA_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      items: [{ id: 'abcdefghijk', status: { embeddable: true } }]
    }), { status: 200 })));

    const result = await callPolicy('abcdefghijk');

    expect(result.statusCode).toBe(502);
    expect(result.body).toMatchObject({ error: 'VIDEO_POLICY_UNAVAILABLE', retryable: true });
  });

  it('rejects malformed IDs before calling YouTube', async () => {
    vi.stubEnv('YOUTUBE_DATA_API_KEY', 'test-key');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await callPolicy('bad');

    expect(result.statusCode).toBe(400);
    expect(result.body.error).toBe('INVALID_VIDEO_ID');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
