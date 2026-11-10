import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudMesh } from '../public/js/network/CloudMesh.js';
import { SocketClient } from '../public/js/network/SocketClient.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function makeChannel() {
  const sent = [];
  return {
    readyState: 'open',
    bufferedAmount: 0,
    send(value) { sent.push(value); },
    sent
  };
}

describe('CloudMesh audio transfer', () => {
  it('retries P2P buffer requests while an open peer channel has no cached audio yet', () => {
    vi.useFakeTimers();
    const mesh = new CloudMesh(() => {});
    mesh.roomId = 'ROOM';
    const channel = makeChannel();
    mesh.dataChannels.set('peer-2', channel);

    mesh.requestTrackBufferFromPeers('Track', 'track-1');
    expect(channel.sent).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(channel.sent).toHaveLength(2);
    expect(JSON.parse(channel.sent[1])).toMatchObject({ type: 'REQUEST_AUDIO_BUFFER', trackId: 'track-1' });

    mesh.localAudioBufferCache.set('track-1', new ArrayBuffer(4));
    vi.advanceTimersByTime(1000);
    expect(channel.sent).toHaveLength(2);
    vi.useRealTimers();
  });
  it('ends a missing P2P audio wait with a visible failure after 30 seconds', () => {
    vi.useFakeTimers();
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.roomId = 'ROOM';
    mesh.peerId = 'peer-1';
    mesh.localPeersMap.set('peer-1', { id: 'peer-1' });
    mesh.dataChannels.set('peer-2', makeChannel());

    mesh.requestTrackBufferFromPeers('Track', 'track-1');
    vi.advanceTimersByTime(30_000);

    expect(events).toContainEqual(expect.objectContaining({
      type: 'AUDIO_TRANSFER_PROGRESS',
      payload: expect.objectContaining({ status: expect.stringContaining('tidak tersedia') })
    }));
    expect(mesh.peerBufferRequestInterval).toBeNull();
  });

  it('clears upcoming tracks optimistically while keeping the active track', async () => {
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.isHost = true;
    mesh.roomId = 'ROOM';
    mesh.peerId = 'peer-1';
    mesh.lastKnownTrack = { id: 'current' };
    mesh.lastKnownQueue = [{ id: 'current' }, { id: 'next' }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      success: true, queue: [{ id: 'current' }], removed: [{ item: { id: 'next' }, index: 1 }]
    }) }));

    const result = await mesh.clearQueue(['current', 'next']);

    expect(result.removed).toEqual([{ item: { id: 'next' }, index: 1 }]);
    expect(mesh.lastKnownQueue.map(item => item.id)).toEqual(['current']);
    expect(mesh.deletedQueueIds.has('next')).toBe(true);
    expect(events.some(event => event.type === 'QUEUE_UPDATED')).toBe(true);
  });

  it('restores a cleared queue snapshot and releases its deletion tombstones', async () => {
    const mesh = new CloudMesh(() => {});
    mesh.isHost = true;
    mesh.roomId = 'ROOM';
    mesh.peerId = 'peer-1';
    mesh.deletedQueueIds.add('next');
    mesh.lastKnownQueue = [{ id: 'current' }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      success: true, queue: [{ id: 'current' }, { id: 'next' }]
    }) }));

    const restored = await mesh.restoreQueue([{ item: { id: 'next' }, index: 1 }]);

    expect(restored).toBe(true);
    expect(mesh.deletedQueueIds.has('next')).toBe(false);
    expect(mesh.lastKnownQueue.map(item => item.id)).toEqual(['current', 'next']);
  });

  it('clears room peer transports and identity when leaving', () => {
    const mesh = new CloudMesh(() => {});
    mesh.roomId = 'ROOM';
    mesh.peerId = 'peer-1';
    mesh.roomTopic = 'room-topic';
    mesh.peerTopic = 'peer-topic';
    const peer = { close: vi.fn() };
    const channel = { close: vi.fn() };
    mesh.peerConnections.set('peer-2', peer);
    mesh.dataChannels.set('peer-2', channel);
    mesh.pendingIceCandidates.set('peer-2', [{ candidate: true }]);

    mesh.leaveRoom();

    expect(peer.close).toHaveBeenCalledOnce();
    expect(channel.close).toHaveBeenCalledOnce();
    expect(mesh.peerConnections.size).toBe(0);
    expect(mesh.dataChannels.size).toBe(0);
    expect(mesh.pendingIceCandidates.size).toBe(0);
    expect(mesh.roomId).toBeNull();
    expect(mesh.peerId).toBeNull();
  });

  it('waits for server room creation before reporting the room ready', async () => {
    const mesh = new CloudMesh(() => {});
    let finishCreate;
    vi.stubGlobal('fetch', () => new Promise(resolve => {
      finishCreate = () => resolve({ ok: true, json: async () => ({ success: true }) });
    }));

    let settled = false;
    const creating = mesh.createRoom('ROOM', 'peer-1', 'Host').then(() => { settled = true; });
    await Promise.resolve();

    expect(settled).toBe(false);
    finishCreate();
    await creating;
    expect(settled).toBe(true);
  });

  it('reports join failure and releases the room state', async () => {
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    await expect(mesh.joinRoom('MISS', 'peer-1', 'Guest')).rejects.toThrow();

    expect(mesh.roomId).toBeNull();
    expect(mesh.peerId).toBeNull();
    expect(events).toContainEqual(expect.objectContaining({ type: 'ROOM_ERROR' }));
  });

  it('does not send a stale buffer when a peer requests a track that is not cached', () => {
    const mesh = new CloudMesh(() => {});
    mesh.currentAudioArrayBuffer = new ArrayBuffer(16);
    mesh.lastKnownTrack = { id: 'new-track', name: 'New track' };
    const channel = makeChannel();
    mesh.setupDataChannel('peer-2', channel);

    channel.onmessage({ data: JSON.stringify({
      type: 'REQUEST_AUDIO_BUFFER',
      trackId: 'new-track',
      trackName: 'New track'
    }) });

    expect(channel.sent).toEqual([]);
  });

  it('does not announce stale current audio to a newly connected peer', () => {
    const mesh = new CloudMesh(() => {});
    mesh.isHost = true;
    mesh.currentAudioArrayBuffer = new ArrayBuffer(16);
    mesh.lastKnownTrack = { id: 'new-track', name: 'New track' };
    const channel = makeChannel();
    mesh.setupDataChannel('peer-2', channel);

    channel.onopen();

    expect(channel.sent.map(message => JSON.parse(message))).toContainEqual(expect.objectContaining({
      type: 'ROOM_SNAPSHOT',
      track: { id: 'new-track', name: 'New track' }
    }));
    expect(channel.sent.some(message => JSON.parse(message).type === 'AUDIO_HEADER')).toBe(false);
  });

  it('does not serve a same-title buffer for a different requested track id', () => {
    const mesh = new CloudMesh(() => {});
    mesh.isHost = true;
    mesh.localAudioBufferCache.set('Diet Mountain Dew', new ArrayBuffer(16));
    const channel = makeChannel();
    mesh.setupDataChannel('peer-2', channel);

    channel.onmessage({ data: JSON.stringify({
      type: 'REQUEST_AUDIO_BUFFER',
      trackId: 'youtube-track-id',
      trackName: 'Diet Mountain Dew'
    }) });

    expect(channel.sent).toEqual([]);
  });

  it('applies a room snapshot once for a late joiner', () => {
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.loadTrackBuffer = vi.fn();
    const snapshot = {
      track: { id: 'track-new', name: 'New track' },
      queue: [{ id: 'track-new', name: 'New track' }],
      state: 'PLAYING',
      targetServerTime: Date.now() - 5000,
      startOffsetSec: 12
    };

    mesh.applyRoomSnapshot(snapshot);
    mesh.applyRoomSnapshot(snapshot);

    expect(events.filter(event => event.type === 'TRACK_METADATA')).toHaveLength(1);
    expect(events.filter(event => event.type === 'QUEUE_UPDATED')).toHaveLength(1);
    expect(events.filter(event => event.type === 'SCHEDULED_PLAY')).toHaveLength(1);
    expect(events.find(event => event.type === 'SCHEDULED_PLAY').payload.startOffsetSec).toBe(12);
  });

  it('does not wait for server acknowledgement after optimistic queue addition', async () => {
    const mesh = new CloudMesh(() => {});
    mesh.roomId = 'ROOM';
    mesh.peerId = 'peer-1';
    mesh.deviceName = 'Host';
    mesh.lastKnownTrack = { id: 'current-track', name: 'Current track' };
    vi.stubGlobal('fetch', () => new Promise(() => {}));

    let settled = false;
    const add = mesh.addToQueue({ id: 'next-track', name: 'Next track' }).then(() => { settled = true; });
    await Promise.resolve();

    expect(settled).toBe(true);
    expect(mesh.lastKnownQueue.map(track => track.id)).toEqual(['next-track']);
    await add;
  });

  it('deduplicates repeated adds of the same stable queue id', async () => {
    const mesh = new CloudMesh(() => {});
    mesh.roomId = 'ROOM';
    mesh.peerId = 'peer-1';
    mesh.deviceName = 'Host';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, queue: [{ id: 'demo_synthwave', name: 'Demo' }] }) }));

    await mesh.addToQueue({ id: 'demo_synthwave', name: 'Demo', isSynthetic: true });
    await mesh.addToQueue({ id: 'demo_synthwave', name: 'Demo', isSynthetic: true });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mesh.lastKnownQueue.map(track => track.id)).toEqual(['demo_synthwave']);
  });

  it('keeps a queued item visible and reports a server rejection', async () => {
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.roomId = 'ROOM';
    mesh.peerId = 'peer-1';
    mesh.deviceName = 'Host';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));

    await mesh.addToQueue({ id: 'track-offline', name: 'Offline track' });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mesh.lastKnownQueue.map(track => track.id)).toContain('track-offline');
    expect(events).toContainEqual(expect.objectContaining({ type: 'QUEUE_SYNC_ERROR' }));
  });

  it('adding a queued item never changes the active track', async () => {
    const mesh = new CloudMesh(() => {});
    mesh.roomId = 'ROOM';
    mesh.peerId = 'peer-1';
    mesh.deviceName = 'Host';
    mesh.lastKnownTrack = { id: 'active-track', name: 'Active track' };
    vi.stubGlobal('fetch', () => new Promise(() => {}));

    await mesh.addToQueue({ id: 'queued-track', name: 'Queued track' });

    expect(mesh.lastKnownTrack).toEqual({ id: 'active-track', name: 'Active track' });
  });

  it('keeps concurrent optimistic additions when an older server response arrives last', async () => {
    const mesh = new CloudMesh(() => {});
    mesh.roomId = 'ROOM';
    mesh.peerId = 'peer-1';
    mesh.deviceName = 'Host';
    mesh.lastKnownTrack = { id: 'current-track', name: 'Current track' };
    const responses = [];
    vi.stubGlobal('fetch', () => new Promise(resolve => responses.push(resolve)));

    await mesh.addToQueue({ id: 'track-a', name: 'Track A' });
    await mesh.addToQueue({ id: 'track-b', name: 'Track B' });
    const response = queue => ({ json: async () => ({ queue }) });
    responses[1](response([{ id: 'track-a' }, { id: 'track-b' }]));
    await Promise.resolve();
    responses[0](response([{ id: 'track-a' }]));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mesh.lastKnownQueue.map(track => track.id)).toEqual(['track-a', 'track-b']);
  });

  it('clears a deletion tombstone when the same track is added again', async () => {
    const mesh = new CloudMesh(() => {});
    mesh.roomId = 'ROOM';
    mesh.peerId = 'peer-1';
    mesh.deletedQueueIds.add('track-x');
    vi.stubGlobal('fetch', () => new Promise(() => {}));

    await mesh.addToQueue({ id: 'track-x', name: 'Track X' });

    expect(mesh.deletedQueueIds.has('track-x')).toBe(false);
    expect(mesh.lastKnownQueue.map(track => track.id)).toEqual(['track-x']);
  });

  it('does not restore a track removed before its add acknowledgement arrives', async () => {
    const mesh = new CloudMesh(() => {});
    mesh.roomId = 'ROOM';
    mesh.peerId = 'peer-1';
    mesh.deviceName = 'Host';
    mesh.isHost = true;
    const responses = [];
    vi.stubGlobal('fetch', () => new Promise(resolve => responses.push(resolve)));

    await mesh.addToQueue({ id: 'track-x', name: 'Track X' });
    const removal = mesh.removeFromQueue('track-x');
    responses[0]({ json: async () => ({ queue: [{ id: 'track-x', name: 'Track X' }] }) });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mesh.lastKnownQueue.map(track => track.id)).toEqual([]);
    responses[1]({ json: async () => ({ queue: [] }) });
    await removal;

    expect(mesh.lastKnownQueue.map(track => track.id)).toEqual([]);
  });
});

describe('SocketClient room readiness', () => {
  it('clears pending room identity before forwarding a join error', () => {
    const events = [];
    const client = new SocketClient((type, payload) => events.push({ type, payload }));
    client.roomId = 'MISS';
    client.peerId = 'peer-1';
    client.isHost = false;

    client.handleCloudMeshEvent('ROOM_ERROR', { message: 'Room tidak bisa dimasuki.' });

    expect(client.roomId).toBeNull();
    expect(client.peerId).toBeNull();
    expect(events).toContainEqual({ type: 'ROOM_ERROR', payload: { message: 'Room tidak bisa dimasuki.' } });
  });

  it('announces a room only after the server confirms creation', async () => {
    const events = [];
    const client = new SocketClient((type, payload) => events.push({ type, payload }));
    let resolveRoom;
    client.cloudMesh.createRoom = vi.fn(() => new Promise(resolve => { resolveRoom = resolve; }));

    client.createRoom('Host');
    expect(events.some(event => event.type === 'ROOM_CREATED')).toBe(false);
    resolveRoom({ id: client.roomId });
    await client.roomReady;

    expect(events.some(event => event.type === 'ROOM_CREATED')).toBe(true);
  });

  it('does not submit a queue item before room creation completes', async () => {
    const client = new SocketClient(() => {});
    let finishRoom;
    const roomReady = new Promise(resolve => { finishRoom = resolve; });
    client.cloudMesh.createRoom = vi.fn(() => roomReady);
    client.cloudMesh.addToQueue = vi.fn().mockResolvedValue({ id: 'track-1' });

    expect(client.createRoom('Host')).toBe(roomReady);
    const add = client.addToQueue({ id: 'track-1', name: 'Track' });
    await Promise.resolve();
    expect(client.cloudMesh.addToQueue).not.toHaveBeenCalled();

    finishRoom();
    await add;
    expect(client.cloudMesh.addToQueue).toHaveBeenCalledWith({ id: 'track-1', name: 'Track' });
  });
});
