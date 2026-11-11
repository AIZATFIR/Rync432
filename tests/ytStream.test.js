import { describe, expect, it, vi } from 'vitest';
import handler from '../api/yt-stream.js';

async function callStream(query) {
  let statusCode = 0;
  let body;
  let redirectUrl;
  const res = {
    setHeader() {},
    status(code) { statusCode = code; return this; },
    json(value) { body = value; return this; },
    redirect(url) { redirectUrl = url; statusCode = 302; return this; },
    end() { return this; }
  };
  await handler({ method: 'GET', query }, res);
  return { statusCode, body, redirectUrl };
}

describe('YouTube stream API', () => {
  it('routes supported direct audio URLs through the SSRF-protected range proxy', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await callStream({ url: 'https://audio.example.test/song.mp3' });

    expect(result.redirectUrl).toBe('/api/stream?url=https%3A%2F%2Faudio.example.test%2Fsong.mp3');
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('requires the official YouTube embedded player for YouTube video ids', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await callStream({ id: 'dQw4w9WgXcQ' });

    expect(result.statusCode).toBe(410);
    expect(result.body).toMatchObject({ error: 'EMBED_PLAYER_REQUIRED', videoId: 'dQw4w9WgXcQ' });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it.each([
    ['YouTube Live', 'https://www.youtube.com/live/dQw4w9WgXcQ'],
    ['YouTube Music', 'https://music.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['short links', 'https://youtu.be/dQw4w9WgXcQ']
  ])('routes %s URLs to the official embed player', async (_label, url) => {
    const result = await callStream({ url });

    expect(result.statusCode).toBe(410);
    expect(result.body).toMatchObject({ error: 'EMBED_PLAYER_REQUIRED', videoId: 'dQw4w9WgXcQ' });
  });

  it('does not treat a YouTube lookalike domain as a YouTube video URL', async () => {
    const result = await callStream({ url: 'https://youtube.com.attacker.test/live/dQw4w9WgXcQ' });

    expect(result.statusCode).toBe(302);
    expect(result.redirectUrl).toContain('/api/stream?url=');
  });
});
