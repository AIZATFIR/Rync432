import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import handler from '../api/yt-stream.js';

describe('YouTube stream API', () => {
  let tempDir;

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('uses yt-dlp Android audio instead of replacing it with Android VR', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'rync-yt-stream-'));
    const executable = path.join(tempDir, 'yt-dlp');
    const argsFile = path.join(tempDir, 'args.txt');
    await writeFile(executable, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.ARGS_FILE, process.argv.slice(2).join('\\n'));\nconsole.log("Test title")\nconsole.log("https://cdn.test/android-audio")\n`);
    await chmod(executable, 0o755);
    vi.stubEnv('PATH', `${tempDir}:${process.env.PATH}`);
    vi.stubEnv('ARGS_FILE', argsFile);

    const requestedUrls = [];
    const audio = Buffer.from([1, 2, 3, 4]);
    vi.stubGlobal('fetch', vi.fn(async url => {
      requestedUrls.push(String(url));
      if (String(url).includes('/youtubei/')) {
        return new Response(JSON.stringify({
          videoDetails: { title: 'Android VR title' },
          streamingData: { adaptiveFormats: [{ mimeType: 'audio/mp4', url: 'https://cdn.test/android-vr-audio' }] }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(audio, { status: 200, headers: { 'content-type': 'audio/mp4' } });
    }));

    const chunks = [];
    const res = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    res.statusCode = 200;
    res.setHeader = () => {};
    res.status = code => { res.statusCode = code; return res; };
    res.json = body => { res.end(JSON.stringify(body)); return res; };
    res.redirect = url => { res.statusCode = 302; res.end(url); return res; };

    const finished = once(res, 'finish');
    await handler({ method: 'GET', query: { id: 'dQw4w9WgXcQ' } }, res);
    await finished;

    const args = await readFile(argsFile, 'utf8');
    expect(args).toContain('--extractor-args');
    expect(args).toContain('youtube:player_client=android');
    expect(requestedUrls).toEqual(['https://cdn.test/android-audio']);
    expect(Buffer.concat(chunks)).toEqual(audio);
  });
});
