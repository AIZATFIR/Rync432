import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRoomPersistence } from '../api/roomPersistence.js';

describe('room persistence', () => {
  let directory;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = null;
  });

  it('restores authoritative room state after restart without restoring stale peers or signals', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'rync-room-store-'));
    const filePath = path.join(directory, 'rooms.json');
    const persistence = createRoomPersistence(filePath);
    const room = {
      roomId: 'ABCD', hostId: 'host-peer', hostTokenHash: 'secret-hash',
      state: 'PLAYING', track: { id: 'track-a' }, queue: [{ id: 'track-a' }],
      targetServerTime: 123, startOffsetSec: 5, updatedAt: Date.now(),
      peers: { 'host-peer': { id: 'host-peer', isHost: true } },
      signals: [{ to: 'host-peer', data: { type: 'offer' } }]
    };

    persistence.save(new Map([['ABCD', room]]));
    const restored = createRoomPersistence(filePath).load().get('ABCD');
    const fileStats = await stat(filePath);

    expect(restored).toMatchObject({
      roomId: 'ABCD', hostTokenHash: 'secret-hash', state: 'PLAYING',
      track: { id: 'track-a' }, queue: [{ id: 'track-a' }], targetServerTime: 123
    });
    expect(restored.peers).toEqual({});
    expect(restored.signals).toEqual([]);
    expect(fileStats.mode & 0o777).toBe(0o600);
  });

  it('drops rooms older than the room TTL when loading persisted state', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'rync-room-store-'));
    const filePath = path.join(directory, 'rooms.json');
    const now = Date.now();
    const persistence = createRoomPersistence(filePath, { now: () => now });
    persistence.save(new Map([['OLD1', { roomId: 'OLD1', updatedAt: now - 3 * 60 * 60 * 1000 - 1 }]]));

    expect(createRoomPersistence(filePath, { now: () => now }).load().has('OLD1')).toBe(false);
  });

  it('restores a room and queue through the API in a fresh server process', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'rync-room-restart-'));
    const filePath = path.join(directory, 'rooms.json');
    const moduleUrl = pathToFileURL(fileURLToPath(new URL('../api/room.js', import.meta.url))).href;
    const environment = { ...process.env, NODE_ENV: 'development', RYNC_ROOM_STORE_PATH: filePath };
    const setupScript = `
      import handler from ${JSON.stringify(moduleUrl)};
      async function call(action, body) {
        let statusCode = 0; let payload;
        const res = { setHeader() {}, status(code) { statusCode = code; return this; }, json(value) { payload = value; return this; } };
        await handler({ method: 'POST', query: { action }, body }, res);
        if (statusCode >= 400) throw new Error(payload?.error || String(statusCode));
        return payload;
      }
      const created = await call('create', { roomId: 'AB12', peerId: 'host', deviceName: 'Host' });
      await call('add_queue', {
        roomId: 'AB12', peerId: 'host', deviceName: 'Host', id: 'song-1', queueItemId: 'queue-song-1', name: 'Song One',
        clientMutationId: 'mutation-restart-001', expectedQueueRevision: 0
      });
      await call('track', { roomId: 'AB12', peerId: 'host', hostToken: created.hostToken, track: { id: 'song-1', name: 'Song One' } });
      console.log(JSON.stringify({ hostToken: created.hostToken }));
    `;
    const readScript = `
      import handler from ${JSON.stringify(moduleUrl)};
      async function call(action, body) {
        let statusCode = 0; let payload;
        const res = { setHeader() {}, status(code) { statusCode = code; return this; }, json(value) { payload = value; return this; } };
        await handler({ method: 'POST', query: { action }, body }, res);
        return { statusCode, payload };
      }
      const joined = await call('join', {
        roomId: 'AB12', peerId: 'new-host', deviceName: 'Host', hostToken: process.env.RYNC_TEST_HOST_TOKEN
      });
      const retried = await call('add_queue', {
        roomId: 'AB12', peerId: 'new-host', deviceName: 'Host', queueItemId: 'queue-song-1',
        id: 'song-1', name: 'Song One', clientMutationId: 'mutation-restart-001', expectedQueueRevision: 0
      });
      console.log(JSON.stringify({
        queue: joined.payload.room.queue,
        track: joined.payload.room.track,
        retry: { statusCode: retried.statusCode, error: retried.payload.error, duplicate: retried.payload.duplicate, queueRevision: retried.payload.queueRevision }
      }));
    `;

    const setup = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', setupScript], { env: environment, encoding: 'utf8' }));
    const restored = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', readScript], {
      env: { ...environment, RYNC_TEST_HOST_TOKEN: setup.hostToken }, encoding: 'utf8'
    }));
    expect(restored.queue).toEqual([expect.objectContaining({ id: 'song-1', name: 'Song One' })]);
    expect(restored.track).toEqual({ id: 'song-1', name: 'Song One' });
    expect(restored.retry).toEqual({ statusCode: 200, duplicate: true, queueRevision: 1 });
  });
});
