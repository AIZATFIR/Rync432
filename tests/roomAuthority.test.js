import { describe, expect, it } from 'vitest';
import roomHandler from '../api/room.js';

async function callRoom(action, body) {
  let statusCode = 0;
  let result;
  const response = {
    setHeader() {},
    status(code) { statusCode = code; return this; },
    json(value) { result = value; return this; },
    end() { return this; }
  };
  await roomHandler({ method: 'POST', query: { action }, body }, response);
  return { statusCode, body: result };
}

describe('room authority', () => {
  it('ignores participant poll data as authoritative room state', async () => {
    const roomId = `A${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    await callRoom('join', { roomId, peerId: 'guest-peer', deviceName: 'Guest' });

    const result = await callRoom('poll', {
      roomId,
      peerId: 'guest-peer',
      isHost: true,
      track: { id: 'stale-track', name: 'Stale track' },
      queue: [{ id: 'stale-track', name: 'Stale track' }],
      state: 'PLAYING'
    });

    expect(result.body.track).toBeNull();
    expect(result.body.queue).toEqual([]);
  });

  it('keeps the host queue order when a poll carries a reorder', async () => {
    const roomId = `R${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    await callRoom('add_queue', { roomId, peerId: 'guest-peer', items: [
      { id: 'track-a', name: 'A' },
      { id: 'track-b', name: 'B' },
      { id: 'track-c', name: 'C' }
    ] });

    const result = await callRoom('poll', {
      roomId,
      peerId: 'host-peer',
      isHost: true,
      queue: [
        { id: 'track-c', name: 'C' },
        { id: 'track-a', name: 'A' },
        { id: 'track-b', name: 'B' }
      ]
    });

    expect(result.body.queue.map(item => item.id)).toEqual(['track-c', 'track-a', 'track-b']);
  });

  it('keeps tracks added by members while preserving the host reordered list', async () => {
    const roomId = `S${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    await callRoom('add_queue', { roomId, peerId: 'guest-peer', items: [
      { id: 'track-a', name: 'A' },
      { id: 'track-b', name: 'B' },
      { id: 'track-c', name: 'C' }
    ] });
    await callRoom('add_queue', { roomId, peerId: 'guest-peer', id: 'track-d', name: 'D' });

    const result = await callRoom('poll', {
      roomId,
      peerId: 'host-peer',
      isHost: true,
      queue: [
        { id: 'track-c', name: 'C' },
        { id: 'track-a', name: 'A' },
        { id: 'track-b', name: 'B' }
      ]
    });

    expect(result.body.queue.map(item => item.id)).toEqual(['track-c', 'track-a', 'track-b', 'track-d']);
  });

  it('rejects participant requests to advance the room track', async () => {
    const roomId = `A${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    await callRoom('join', { roomId, peerId: 'guest-peer', deviceName: 'Guest' });

    const result = await callRoom('next_track', { roomId, peerId: 'guest-peer' });

    expect(result.statusCode).toBe(403);
  });

  it('adding a queue item does not select it as the current track', async () => {
    const roomId = `A${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });

    const result = await callRoom('add_queue', {
      roomId,
      peerId: 'guest-peer',
      id: 'youtube-track',
      name: 'Diet Mountain Dew',
      audioUrl: '/api/yt-stream?id=video-id'
    });

    expect(result.body.queue).toHaveLength(1);
    expect(result.body.track).toBeNull();
  });
});
