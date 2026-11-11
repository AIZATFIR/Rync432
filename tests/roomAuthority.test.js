import { describe, expect, it, vi } from 'vitest';
import roomHandler from '../api/room.js';

async function callRoom(action, body) {
  let statusCode = 0;
  let result;
  const response = {
    setHeader() {},
    status(code) { statusCode = code; return this; },
    json(value) { result = value; return this; },
    send(value) { result = value; return this; },
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
    const created = await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    await callRoom('join', { roomId, peerId: 'guest-peer', deviceName: 'Guest' });
    await callRoom('add_queue', { roomId, peerId: 'guest-peer', items: [
      { id: 'track-a', name: 'A' },
      { id: 'track-b', name: 'B' },
      { id: 'track-c', name: 'C' }
    ] });

    const result = await callRoom('poll', {
      roomId,
      peerId: 'host-peer',
      hostToken: created.body.hostToken,
      isHost: true,
      queue: [
        { id: 'track-c', name: 'C' },
        { id: 'track-a', name: 'A' },
        { id: 'track-b', name: 'B' }
      ]
    });

    expect(result.body.queue.map(item => item.id)).toEqual(['track-c', 'track-a', 'track-b']);
    expect(result.body.queueRevision).toBe(2);
  });

  it('increments queue revisions and returns the canonical snapshot for a stale reorder', async () => {
    const roomId = `J${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const created = await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    await callRoom('add_queue', { roomId, peerId: 'host-peer', items: [
      { id: 'track-a', name: 'A' }, { id: 'track-b', name: 'B' }
    ] });
    const current = await callRoom('poll', { roomId, peerId: 'host-peer', hostToken: created.body.hostToken });
    const staleReorder = await callRoom('reorder_queue', {
      roomId, peerId: 'host-peer', hostToken: created.body.hostToken,
      expectedQueueRevision: 0,
      queue: [{ id: 'track-b' }, { id: 'track-a' }]
    });

    expect(created.body.room.queueRevision).toBe(0);
    expect(current.body.queueRevision).toBe(1);
    expect(staleReorder.statusCode).toBe(409);
    expect(staleReorder.body.queueRevision).toBe(1);
    expect(staleReorder.body.queue.map(item => item.id)).toEqual(['track-a', 'track-b']);
  });

  it('rejects stale revisions for every queue mutation with the canonical queue', async () => {
    const roomId = `Q${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const created = await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    await callRoom('add_queue', { roomId, peerId: 'host-peer', items: [
      { id: 'track-a', name: 'A' }, { id: 'track-b', name: 'B' }
    ] });
    const staleMutations = [
      ['add_queue', { id: 'track-c', name: 'C' }],
      ['reorder_queue', { queue: [{ id: 'track-b' }, { id: 'track-a' }] }],
      ['play_queue_item', { queueId: 'track-a' }],
      ['play_next', { queueId: 'track-b' }],
      ['remove_queue', { queueId: 'track-a' }],
      ['clear_queue', { queueIds: ['track-a'] }],
      ['restore_queue', { removed: [{ item: { id: 'track-c', name: 'C' }, index: 1 }] }]
    ];

    for (const [action, payload] of staleMutations) {
      const result = await callRoom(action, {
        roomId,
        peerId: 'host-peer',
        hostToken: created.body.hostToken,
        expectedQueueRevision: 0,
        ...payload
      });
      expect(result.statusCode, action).toBe(409);
      expect(result.body.error, action).toBe('QUEUE_CONFLICT');
      expect(result.body.queueRevision, action).toBe(1);
      expect(result.body.queue.map(item => item.id), action).toEqual(['track-a', 'track-b']);
    }
  });

  it('keeps tracks added by members while preserving the host reordered list', async () => {
    const roomId = `S${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const created = await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    await callRoom('join', { roomId, peerId: 'guest-peer', deviceName: 'Guest' });
    await callRoom('add_queue', { roomId, peerId: 'guest-peer', items: [
      { id: 'track-a', name: 'A' },
      { id: 'track-b', name: 'B' },
      { id: 'track-c', name: 'C' }
    ] });
    await callRoom('add_queue', { roomId, peerId: 'guest-peer', id: 'track-d', name: 'D' });

    const result = await callRoom('poll', {
      roomId,
      peerId: 'host-peer',
      hostToken: created.body.hostToken,
      isHost: true,
      queue: [
        { id: 'track-c', name: 'C' },
        { id: 'track-a', name: 'A' },
        { id: 'track-b', name: 'B' }
      ]
    });

    expect(result.body.queue.map(item => item.id)).toEqual(['track-c', 'track-a', 'track-b', 'track-d']);
  });

  it('ignores a stale host poll queue snapshot and returns the current room queue', async () => {
    const roomId = `P${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const created = await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    await callRoom('join', { roomId, peerId: 'guest-peer', deviceName: 'Guest' });
    await callRoom('add_queue', { roomId, peerId: 'guest-peer', items: [{ id: 'guest-track', name: 'Guest track' }] });

    const result = await callRoom('poll', {
      roomId,
      peerId: 'host-peer',
      hostToken: created.body.hostToken,
      isHost: true,
      queueRevision: 0,
      queue: [{ id: 'stale-track', name: 'Stale track' }],
      deletedQueueIds: ['guest-track']
    });

    expect(result.body.queueConflict).toBe(true);
    expect(result.body.queueRevision).toBe(1);
    expect(result.body.queue.map(item => item.id)).toEqual(['guest-track']);
  });

  it('preserves a member addition that races with a host reorder', async () => {
    const roomId = `N${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const created = await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    await callRoom('join', { roomId, peerId: 'guest-peer', deviceName: 'Guest' });
    await callRoom('add_queue', { roomId, peerId: 'guest-peer', items: [
      { id: 'track-a', name: 'A' }, { id: 'track-b', name: 'B' }
    ] });
    await callRoom('add_queue', { roomId, peerId: 'guest-peer', id: 'track-c', name: 'C' });

    const result = await callRoom('reorder_queue', {
      roomId, peerId: 'host-peer', hostToken: created.body.hostToken,
      queue: [{ id: 'track-b' }, { id: 'track-a' }]
    });

    expect(result.body.queue.map(item => item.id)).toEqual(['track-b', 'track-a', 'track-c']);
  });

  it('does not resurrect a removed item from a stale host reorder snapshot', async () => {
    const roomId = `P${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const created = await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    await callRoom('add_queue', { roomId, peerId: 'host-peer', items: [
      { id: 'track-a', name: 'A' }, { id: 'track-b', name: 'B' }
    ] });
    await callRoom('remove_queue', { roomId, peerId: 'host-peer', hostToken: created.body.hostToken, queueId: 'track-b' });

    const result = await callRoom('reorder_queue', {
      roomId, peerId: 'host-peer', hostToken: created.body.hostToken,
      queue: [{ id: 'track-b' }, { id: 'track-a' }]
    });

    expect(result.body.queue.map(item => item.id)).toEqual(['track-a']);
  });

  it('clears only requested upcoming tracks and returns their original positions for undo', async () => {
    const roomId = `T${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const created = await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    await callRoom('add_queue', { roomId, peerId: 'host-peer', items: [
      { id: 'current', name: 'Current' },
      { id: 'next-a', name: 'Next A' },
      { id: 'next-b', name: 'Next B' }
    ] });
    await callRoom('track', { roomId, peerId: 'host-peer', hostToken: created.body.hostToken, track: { id: 'current', name: 'Current' } });

    const result = await callRoom('clear_queue', {
      roomId, peerId: 'host-peer', hostToken: created.body.hostToken, queueIds: ['next-a', 'next-b']
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.queue.map(item => item.id)).toEqual(['current']);
    expect(result.body.removed.map(entry => [entry.item.id, entry.index])).toEqual([['next-a', 1], ['next-b', 2]]);
  });

  it('rejects a guest clear request', async () => {
    const roomId = `U${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });

    const result = await callRoom('clear_queue', { roomId, peerId: 'guest-peer', queueIds: ['track-a'] });

    expect(result.statusCode).toBe(403);
  });

  it('restores cleared tracks into the current queue without dropping new additions', async () => {
    const roomId = `V${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const created = await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    await callRoom('add_queue', { roomId, peerId: 'host-peer', items: [
      { id: 'current', name: 'Current' },
      { id: 'next-a', name: 'Next A' }
    ] });
    await callRoom('track', { roomId, peerId: 'host-peer', hostToken: created.body.hostToken, track: { id: 'current', name: 'Current' } });
    const cleared = await callRoom('clear_queue', { roomId, peerId: 'host-peer', hostToken: created.body.hostToken, queueIds: ['next-a'] });
    await callRoom('join', { roomId, peerId: 'guest-peer', deviceName: 'Guest' });
    await callRoom('add_queue', { roomId, peerId: 'guest-peer', id: 'new-track', name: 'New' });

    const restored = await callRoom('restore_queue', {
      roomId, peerId: 'host-peer', hostToken: created.body.hostToken, removed: cleared.body.removed
    });

    expect(restored.body.queue.map(item => item.id)).toEqual(['current', 'next-a', 'new-track']);
  });

  it('does not let a spoofed host peer poll overwrite the host membership or register unknown peers', async () => {
    const roomId = `Z${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const created = await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });

    const spoof = await callRoom('poll', {
      roomId, peerId: 'host-peer', isHost: true, state: 'PLAYING'
    });
    const guestView = await callRoom('poll', { roomId, peerId: 'guest-peer' });

    expect(spoof.statusCode).toBe(409);
    expect(guestView.statusCode).toBe(403);
    const hostView = await callRoom('poll', { roomId, peerId: 'host-peer', hostToken: created.body.hostToken });
    expect(hostView.body.peers.find(peer => peer.id === 'host-peer').isHost).toBe(true);
    expect(hostView.body.state).toBe('IDLE');
  });

  it('caps rooms at five active devices and rejects extra joins', async () => {
    const roomId = `M${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    for (let index = 1; index <= 4; index++) {
      await callRoom('join', { roomId, peerId: `guest-${index}`, deviceName: `Guest ${index}` });
    }

    const sixthDevice = await callRoom('join', { roomId, peerId: 'guest-5', deviceName: 'Guest 5' });

    expect(sixthDevice.statusCode).toBe(409);
    expect(sixthDevice.body.error).toBe('ROOM_FULL');
  });

  it('lets a returning member refresh its stale presence without rejoining', async () => {
    const roomId = `D${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    await callRoom('join', { roomId, peerId: 'guest-peer', deviceName: 'Guest' });
    globalThis.__rync_rooms.get(roomId).peers['guest-peer'].lastSeen = Date.now() - 15000;

    const resumed = await callRoom('poll', { roomId, peerId: 'guest-peer', deviceName: 'Guest' });

    expect(resumed.statusCode).toBe(200);
    expect(resumed.body.peers.some(peer => peer.id === 'guest-peer')).toBe(true);
  });

  it('accepts only bounded signaling from one room member to another', async () => {
    const roomId = `G${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    await callRoom('join', { roomId, peerId: 'guest-peer', deviceName: 'Guest' });

    const outsider = await callRoom('signal', { roomId, peerId: 'outsider', to: 'guest-peer', data: { candidate: 'x' } });
    const oversized = await callRoom('signal', { roomId, peerId: 'host-peer', to: 'guest-peer', data: 'x'.repeat(65537) });
    const valid = await callRoom('signal', { roomId, peerId: 'host-peer', to: 'guest-peer', data: { candidate: 'candidate' } });

    expect(outsider.statusCode).toBe(403);
    expect(oversized.statusCode).toBe(413);
    expect(valid.statusCode).toBe(200);
  });

  it('rejects queue additions atomically when they exceed the room limit', async () => {
    const roomId = `K${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    const fullQueue = Array.from({ length: 500 }, (_, index) => ({ id: `track-${index}`, name: `Track ${index}` }));
    await callRoom('add_queue', { roomId, peerId: 'host-peer', items: fullQueue });

    const overflow = await callRoom('add_queue', {
      roomId, peerId: 'host-peer', items: [{ id: 'new-a', name: 'New A' }, { id: 'new-b', name: 'New B' }]
    });
    const duplicate = await callRoom('add_queue', { roomId, peerId: 'host-peer', id: 'track-0', name: 'Track 0' });

    expect(overflow.statusCode).toBe(413);
    expect(overflow.body.error).toBe('QUEUE_LIMIT_REACHED');
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.body.queue).toHaveLength(500);
  });

  it('rejects oversized host snapshots before changing room state', async () => {
    const roomId = `B${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const created = await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    const oversizedQueue = Array.from({ length: 501 }, (_, index) => ({ id: `track-${index}`, name: `Track ${index}` }));

    const rejected = await callRoom('poll', {
      roomId, peerId: 'host-peer', hostToken: created.body.hostToken, queue: oversizedQueue
    });
    const snapshot = await callRoom('poll', { roomId, peerId: 'host-peer', hostToken: created.body.hostToken });

    expect(rejected.statusCode).toBe(413);
    expect(snapshot.body.queue).toEqual([]);
  });

  it('does not let queue undo exceed the room limit', async () => {
    const roomId = `E${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const created = await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    const fullQueue = Array.from({ length: 500 }, (_, index) => ({ id: `track-${index}`, name: `Track ${index}` }));
    await callRoom('add_queue', { roomId, peerId: 'host-peer', items: fullQueue });

    const restored = await callRoom('restore_queue', {
      roomId, peerId: 'host-peer', hostToken: created.body.hostToken,
      removed: [{ item: { id: 'removed-track', name: 'Removed' }, index: 0 }]
    });

    expect(restored.statusCode).toBe(413);
    expect(restored.body.error).toBe('QUEUE_LIMIT_REACHED');
  });

  it('does not let uploaded audio bypass the queue limit', async () => {
    const roomId = `C${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const created = await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    const fullQueue = Array.from({ length: 500 }, (_, index) => ({ id: `track-${index}`, name: `Track ${index}` }));
    await callRoom('add_queue', { roomId, peerId: 'host-peer', items: fullQueue });

    const upload = await callRoom('upload_audio', {
      roomId, peerId: 'host-peer', hostToken: created.body.hostToken,
      audioBase64: 'YQ==', trackName: 'New file', duration: 1
    });

    expect(upload.statusCode).toBe(413);
    expect(upload.body.error).toBe('QUEUE_LIMIT_REACHED');
  });

  it('does not return another uploaded file when an audio id is missing or unknown', async () => {
    const roomId = `F${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const created = await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    await callRoom('upload_audio', {
      roomId, peerId: 'host-peer', hostToken: created.body.hostToken,
      audioBase64: 'YQ==', trackName: 'Uploaded file', duration: 1
    });

    const unknown = await callRoom('get_audio', { roomId, audioId: 'missing-audio-id' });

    expect(unknown.statusCode).toBe(404);
    expect(unknown.body.error).toContain('Audio not found');
  });

  it('does not create an empty room from an unauthenticated poll', async () => {
    const roomId = `0${Math.random().toString(36).slice(2, 5).toUpperCase()}`;

    const result = await callRoom('poll', { roomId, peerId: 'guest-peer', isHost: true });

    expect(result.statusCode).toBe(404);
    expect(result.body.error).toBe('ROOM_NOT_FOUND');
  });

  it('returns the host token only at creation and restores host role on authenticated rejoin', async () => {
    const roomId = `Y${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const created = await callRoom('create', { roomId, peerId: 'old-host', deviceName: 'Host' });
    await callRoom('join', { roomId, peerId: 'guest-peer', deviceName: 'Guest' });

    const rejoined = await callRoom('join', {
      roomId, peerId: 'new-host', deviceName: 'Host', hostToken: created.body.hostToken
    });
    const poll = await callRoom('poll', {
      roomId, peerId: 'new-host', hostToken: created.body.hostToken
    });

    expect(created.body.hostToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(created.body.room.hostTokenHash).toBeUndefined();
    expect(rejoined.body.room.isHost).toBe(true);
    expect(poll.body.peers.find(peer => peer.id === 'new-host').isHost).toBe(true);
  });

  it('rejects host controls when a guest spoofs the host peer id', async () => {
    const roomId = `W${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    await callRoom('join', { roomId, peerId: 'guest-peer', deviceName: 'Guest' });

    const result = await callRoom('play', {
      roomId, peerId: 'host-peer', state: 'PLAYING', targetServerTime: Date.now() + 800
    });

    expect(result.statusCode).toBe(403);
    expect(result.body.error).toBe('HOST_ONLY');
  });

  it('authorizes host controls with the private token returned at room creation', async () => {
    const roomId = `X${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const created = await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    await callRoom('join', { roomId, peerId: 'guest-peer', deviceName: 'Guest' });

    const result = await callRoom('play', {
      roomId, peerId: 'host-peer', hostToken: created.body.hostToken,
      state: 'PLAYING', targetServerTime: Date.now() + 800
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.state).toBe('PLAYING');
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

    await callRoom('join', { roomId, peerId: 'guest-peer', deviceName: 'Guest' });
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

  it('prevents a room member from changing another peer device state', async () => {
    const roomId = `M${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    await callRoom('join', { roomId, peerId: 'guest-peer', deviceName: 'Guest' });

    const result = await callRoom('update_peer', {
      roomId, peerId: 'guest-peer', targetPeerId: 'host-peer', volume: 0, role: 'muted'
    });
    const snapshot = await callRoom('poll', { roomId, peerId: 'guest-peer' });

    expect(result.statusCode).toBe(403);
    expect(snapshot.body.peers.find(peer => peer.id === 'host-peer')).toMatchObject({ volume: 1, role: 'stereo' });
  });

  it('supports shared repeat-one for automatic track advance', async () => {
    const roomId = `Q${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const created = await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    await callRoom('add_queue', { roomId, peerId: 'host-peer', items: [
      { id: 'current', name: 'Current' }, { id: 'next', name: 'Next' }
    ] });
    await callRoom('track', { roomId, peerId: 'host-peer', hostToken: created.body.hostToken, track: { id: 'current', name: 'Current' } });
    await callRoom('playback_options', { roomId, peerId: 'host-peer', hostToken: created.body.hostToken, repeatMode: 'one', shuffle: false });

    const result = await callRoom('next_track', { roomId, peerId: 'host-peer', hostToken: created.body.hostToken, automatic: true });

    expect(result.body.track.id).toBe('current');
    expect(result.body.state).toBe('PLAYING');
  });

  it('stops at queue end when repeat is off', async () => {
    const roomId = `R${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const created = await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    await callRoom('add_queue', { roomId, peerId: 'host-peer', items: [
      { id: 'first', name: 'First' }, { id: 'last', name: 'Last' }
    ] });
    await callRoom('track', { roomId, peerId: 'host-peer', hostToken: created.body.hostToken, track: { id: 'last', name: 'Last' } });

    const result = await callRoom('next_track', { roomId, peerId: 'host-peer', hostToken: created.body.hostToken, automatic: true });

    expect(result.body.track.id).toBe('last');
    expect(result.body.state).toBe('PAUSED');
  });

  it('wraps or shuffles at queue end according to shared playback options', async () => {
    const roomId = `S${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const created = await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    await callRoom('add_queue', { roomId, peerId: 'host-peer', items: [
      { id: 'current', name: 'Current' }, { id: 'next-a', name: 'Next A' }, { id: 'next-b', name: 'Next B' }
    ] });
    await callRoom('track', { roomId, peerId: 'host-peer', hostToken: created.body.hostToken, track: { id: 'next-b', name: 'Next B' } });
    await callRoom('playback_options', { roomId, peerId: 'host-peer', hostToken: created.body.hostToken, repeatMode: 'all', shuffle: false });
    const wrapped = await callRoom('next_track', { roomId, peerId: 'host-peer', hostToken: created.body.hostToken });
    expect(wrapped.body.track.id).toBe('current');

    await callRoom('track', { roomId, peerId: 'host-peer', hostToken: created.body.hostToken, track: { id: 'current', name: 'Current' } });
    await callRoom('playback_options', { roomId, peerId: 'host-peer', hostToken: created.body.hostToken, repeatMode: 'off', shuffle: true });
    const shuffled = await callRoom('next_track', { roomId, peerId: 'host-peer', hostToken: created.body.hostToken });
    expect(['next-a', 'next-b']).toContain(shuffled.body.track.id);
    expect(shuffled.body.track.id).not.toBe('current');
  });

  it('plays each queued track once before stopping when shuffle is on and repeat is off', async () => {
    const roomId = `H${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const created = await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    await callRoom('add_queue', { roomId, peerId: 'host-peer', items: [
      { id: 'first', name: 'First' }, { id: 'second', name: 'Second' }, { id: 'third', name: 'Third' }
    ] });
    await callRoom('track', { roomId, peerId: 'host-peer', hostToken: created.body.hostToken, track: { id: 'first', name: 'First' } });
    await callRoom('playback_options', { roomId, peerId: 'host-peer', hostToken: created.body.hostToken, repeatMode: 'off', shuffle: true });
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const second = await callRoom('next_track', { roomId, peerId: 'host-peer', hostToken: created.body.hostToken });
      const third = await callRoom('next_track', { roomId, peerId: 'host-peer', hostToken: created.body.hostToken });
      const ended = await callRoom('next_track', { roomId, peerId: 'host-peer', hostToken: created.body.hostToken });

      expect([second.body.track.id, third.body.track.id]).toEqual(['second', 'third']);
      expect(ended.body.state).toBe('PAUSED');
      expect(ended.body.track.id).toBe('third');
    } finally {
      random.mockRestore();
    }
  });

  it('repeats a single item in shuffle mode when repeat-all is enabled', async () => {
    const roomId = `U${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const created = await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    await callRoom('add_queue', { roomId, peerId: 'host-peer', items: [{ id: 'only', name: 'Only' }] });
    await callRoom('track', { roomId, peerId: 'host-peer', hostToken: created.body.hostToken, track: { id: 'only', name: 'Only' } });
    await callRoom('playback_options', { roomId, peerId: 'host-peer', hostToken: created.body.hostToken, repeatMode: 'all', shuffle: true });

    const result = await callRoom('next_track', { roomId, peerId: 'host-peer', hostToken: created.body.hostToken });

    expect(result.body.track.id).toBe('only');
    expect(result.body.state).toBe('PLAYING');
  });

  it('restricts shared playback options to the authenticated host', async () => {
    const roomId = `T${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    await callRoom('create', { roomId, peerId: 'host-peer', deviceName: 'Host' });
    await callRoom('join', { roomId, peerId: 'guest-peer', deviceName: 'Guest' });

    const result = await callRoom('playback_options', {
      roomId, peerId: 'guest-peer', repeatMode: 'all', shuffle: true
    });

    expect(result.statusCode).toBe(403);
  });
});
