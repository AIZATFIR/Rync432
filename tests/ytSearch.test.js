import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, chmod, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import handler from '../api/yt-search.js';

describe('YouTube search API', () => {
  let tempDir;

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('returns yt-dlp search results without falling through to HTML scraping', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'rync-yt-search-'));
    const executable = path.join(tempDir, 'yt-dlp');
    await writeFile(executable, '#!/usr/bin/env node\nconsole.log("dQw4w9WgXcQ|||Song title|||Artist|||215|||NA")\n');
    await chmod(executable, 0o755);
    vi.stubEnv('PATH', `${tempDir}:${process.env.PATH}`);
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal('fetch', fetch);

    let body;
    const res = {
      setHeader() {},
      status() { return this; },
      json(value) { body = value; return this; }
    };

    await handler({ method: 'GET', query: { q: 'song' } }, res);

    expect(body.results).toEqual([expect.objectContaining({
      id: 'dQw4w9WgXcQ',
      title: 'Song title',
      channel: 'Artist',
      duration: 215,
      thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
    })]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
