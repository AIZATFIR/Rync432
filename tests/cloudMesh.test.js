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

function makeAudioChunkFrame(sequence, timestamp, bytes) {
  const frame = new ArrayBuffer(12 + bytes.length);
  const view = new DataView(frame);
  view.setUint32(0, sequence, true);
  view.setFloat64(4, timestamp, true);
  new Uint8Array(frame, 12).set(bytes);
  return frame;
}

describe('CloudMesh audio transfer', () => {
  it('bounds a stalled next-track preview instead of waiting forever', async () => {
    vi.useFakeTimers();
    const mesh = new CloudMesh(() => {});
    mesh.isHost = true;
    vi.stubGlobal('fetch', () => new Promise(() => {}));
    const preview = mesh.previewNextTrack();
    const rejected = expect(preview).rejects.toThrow('QUEUE_MUTATION_TIMEOUT');

    await vi.advanceTimersByTimeAsync(8_000);

    await rejected;
  });

  it('returns the server-picked room candidate without mutating playback', async () => {
    const mesh = new CloudMesh(() => {});
    mesh.isHost = true;
    mesh.roomId = 'ROOM';
    mesh.peerId = 'host';
    mesh.hostToken = 'token';
    const candidate = { id: 'shuffle-pick', sourceType: 'local-file' };
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, nextTrack: candidate }) });
    vi.stubGlobal('fetch', request);

    await expect(mesh.previewNextTrack(true)).resolves.toEqual(candidate);

    expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({ automatic: true, previewOnly: true });
    expect(mesh.lastKnownTrack).toBeNull();
  });

  it('does not broadcast a room advance after the prepared candidate becomes stale', async () => {
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.isHost = true;
    mesh.roomId = 'ROOM';
    mesh.peerId = 'host';
    mesh.hostToken = 'token';
    mesh.applyCanonicalQueue = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 409,
      json: async () => ({ error: 'NEXT_TRACK_CHANGED', queue: [{ id: 'new-next' }] })
    }));

    await expect(mesh.nextTrack(false, 'stale-next')).resolves.toBe(false);

    expect(mesh.applyCanonicalQueue).toHaveBeenCalledWith([{ id: 'new-next' }]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'QUEUE_SYNC_ERROR' }));
    expect(events.some(event => event.type === 'SCHEDULED_PLAY')).toBe(false);
  });

  it('routes YouTube tracks to the embed player without an audio fetch or P2P request', () => {
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.requestTrackBufferFromPeers = vi.fn();
    vi.stubGlobal('fetch', vi.fn());
    const track = { id: 'yt_dQw4w9WgXcQ', sourceType: 'youtube', sourceId: 'dQw4w9WgXcQ', name: 'Song' };

    mesh.loadTrackBuffer(track);

    expect(events).toContainEqual({ type: 'YOUTUBE_TRACK_REQUESTED', payload: track });
    expect(fetch).not.toHaveBeenCalledWith('/api/yt-stream?id=dQw4w9WgXcQ', expect.anything());
    expect(mesh.requestTrackBufferFromPeers).not.toHaveBeenCalled();
  });

  it.each(['', 'blob:local-object-url'])('requests P2P immediately for local room tracks without a relay copy (%s)', async audioUrl => {
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.roomId = 'ROOM';
    mesh.requestTrackBufferFromPeers = vi.fn();
    mesh.fetchRemoteAudioUrl = vi.fn();
    mesh.updateLoadingState = vi.fn();

    await mesh.loadTrackBuffer({ id: 'local-track', name: 'Local track', sourceType: 'local-file', audioUrl });

    expect(mesh.requestTrackBufferFromPeers).toHaveBeenCalledWith('Local track', 'local-track');
    expect(mesh.fetchRemoteAudioUrl).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'AUDIO_TRANSFER_PROGRESS', payload: expect.objectContaining({ status: expect.stringContaining('P2P') })
    }));
  });

  it('releases the local-track single-flight guard after a P2P transfer fails', async () => {
    const mesh = new CloudMesh(() => {});
    mesh.roomId = 'ROOM';
    mesh.updateLoadingState = vi.fn();
    mesh.broadcastReadiness = vi.fn();
    mesh.requestTrackBufferFromPeers = vi.fn();
    const track = { id: 'local-track', name: 'Local track', sourceType: 'local-file', audioUrl: '' };

    await mesh.loadTrackBuffer(track);
    mesh.failIncomingAudioTransfer('peer-2', track.id, 'Transfer gagal', track.name);

    expect(mesh.currentFetchingTrackKey).toBeNull();
    expect(mesh.pendingTrackBufferRequest).toBeNull();
  });

  it('marks a synthetic track ready after local preparation', () => {
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.broadcastReadiness = vi.fn();

    mesh.loadTrackBuffer({ id: 'demo-synth', name: 'Neon Groove Synthwave', isSynthetic: true });

    expect(mesh.broadcastReadiness).toHaveBeenLastCalledWith('READY', 'demo-synth', 'local');
    expect(events).toContainEqual(expect.objectContaining({ type: 'SYNTHETIC_TRACK_REQUESTED' }));
  });

  it('reports local cache instead of the old network route when a track is reused', async () => {
    const mesh = new CloudMesh(() => {});
    mesh.broadcastReadiness = vi.fn();
    mesh.localAudioBufferCache.set('track-1', new ArrayBuffer(4));
    mesh.audioRouteByTrack.set('track-1', 'relay');

    await mesh.loadTrackBuffer({ id: 'track-1', name: 'Track' });

    expect(mesh.broadcastReadiness).toHaveBeenLastCalledWith('READY', 'track-1', 'cache');
  });

  it('creates a fresh room with an empty authoritative queue', async () => {
    const mesh = new CloudMesh(() => {});
    mesh.lastKnownQueue = [{ id: 'old-room-track' }];
    mesh.initBroadcastChannel = vi.fn();
    mesh.initMqttBus = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, hostToken: 'token', room: { queueRevision: 0 } })
    }));

    await mesh.createRoom('NEW', 'peer', 'Speaker');

    expect(JSON.parse(fetch.mock.calls[0][1].body).queue).toEqual([]);
    mesh.stopPolling();
  });

  it('sends readiness changes to the authoritative peer snapshot in order', async () => {
    const mesh = new CloudMesh(() => {});
    mesh.roomId = 'ROOM';
    mesh.peerId = 'peer';
    mesh.localPeersMap.set('peer', { id: 'peer' });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    mesh.broadcastReadiness('PREPARING', 'track', 'relay');
    mesh.broadcastReadiness('READY', 'track', 'p2p');
    await mesh.readinessSync;

    expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body).readiness)).toEqual(['PREPARING', 'READY']);
    expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body).audioRoute)).toEqual(['relay', 'p2p']);
    expect(mesh.localPeersMap.get('peer')).toMatchObject({ readiness: 'READY', isAudioLoading: false, audioRoute: 'p2p' });
  });

  it('keeps YouTube source metadata in the optimistic and server queue mutation', async () => {
    const mesh = new CloudMesh(() => {});
    mesh.roomId = 'ROOM';
    mesh.peerId = 'peer';
    mesh.lastKnownQueue = [];
    mesh.publishMqtt = vi.fn();
    mesh.broadcastDataChannelMessage = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, queue: [] }) }));

    await mesh.addToQueue({
      id: 'yt_dQw4w9WgXcQ', name: 'Song', sourceType: 'youtube', sourceId: 'dQw4w9WgXcQ',
      sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });

    expect(mesh.lastKnownQueue[0]).toMatchObject({ sourceType: 'youtube', sourceId: 'dQw4w9WgXcQ' });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ sourceType: 'youtube', sourceId: 'dQw4w9WgXcQ' });
  });

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

  it('stops request retries while the requested P2P transfer is actively arriving', async () => {
    vi.useFakeTimers();
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.roomId = 'ROOM';
    mesh.peerId = 'peer-1';
    mesh.localPeersMap.set('peer-1', { id: 'peer-1' });
    mesh.dataChannels.set('peer-2', makeChannel());

    mesh.requestTrackBufferFromPeers('Track', 'track-1');
    mesh.incomingAudioChunks.set('peer-2', { id: 'track-1' });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mesh.peerBufferRequestInterval).toBeNull();
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'AUDIO_TRANSFER_PROGRESS', payload: expect.objectContaining({ status: expect.stringContaining('tidak tersedia') }) }));
  });

  it('falls back to P2P when a remote audio response stalls past its deadline', async () => {
    vi.useFakeTimers();
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.roomId = 'ROOM';
    mesh.requestTrackBufferFromPeers = vi.fn();
    mesh.broadcastReadiness = vi.fn();
    mesh.updateLoadingState = vi.fn(isLoading => {
      if (isLoading) mesh.broadcastReadiness('PREPARING', 'slow-track');
    });
    vi.stubGlobal('fetch', vi.fn((_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    })));

    const loading = mesh.fetchRemoteAudioUrl('/api/yt-stream?id=slow', 'Slow track', 'slow-track');
    await vi.advanceTimersByTimeAsync(15_000);
    await loading;

    expect(mesh.requestTrackBufferFromPeers).toHaveBeenCalledWith('Slow track', 'slow-track');
    expect(mesh.broadcastReadiness).toHaveBeenCalledWith('PREPARING', 'slow-track');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'AUDIO_TRANSFER_PROGRESS',
      payload: expect.objectContaining({ status: 'Menunggu audio...' })
    }));
  });

  it('reports the server relay as the route after a room audio download completes', async () => {
    const mesh = new CloudMesh(() => {});
    mesh.broadcastReadiness = vi.fn();
    mesh.updateLoadingState = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]))));

    await mesh.fetchRemoteAudioUrl('/api/room?action=get_audio&audioId=audio-1', 'Track', 'track-1');

    expect(mesh.broadcastReadiness).toHaveBeenLastCalledWith('READY', 'track-1', 'relay');
    expect(mesh.audioRouteByTrack.get('track-1')).toBe('relay');
  });

  it('authenticates host updates to a remote speaker', async () => {
    const mesh = new CloudMesh(() => {});
    mesh.isHost = true;
    mesh.roomId = 'ROOM';
    mesh.peerId = 'host-peer';
    mesh.hostToken = 'private-host-token';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    vi.stubGlobal('fetch', fetchMock);

    await mesh.updateRemotePeerSettings('speaker-2', 'left', 0.5);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      roomId: 'ROOM', peerId: 'host-peer', hostToken: 'private-host-token', targetPeerId: 'speaker-2', role: 'left', volume: 0.5
    });
  });

  it('persists host playback options and broadcasts the canonical settings', async () => {
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.isHost = true;
    mesh.roomId = 'ROOM';
    mesh.peerId = 'host-peer';
    mesh.hostToken = 'private-host-token';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      success: true, repeatMode: 'one', shuffle: true
    }) });
    vi.stubGlobal('fetch', fetchMock);

    const settings = await mesh.updatePlaybackOptions({ repeatMode: 'one', shuffle: true });

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody).toMatchObject({ roomId: 'ROOM', peerId: 'host-peer', hostToken: 'private-host-token', repeatMode: 'one', shuffle: true });
    expect(settings).toEqual({ repeatMode: 'one', shuffle: true });
    expect(events).toContainEqual({ type: 'PLAYBACK_OPTIONS_UPDATED', payload: settings });
  });

  it('restores playback options from a room snapshot', () => {
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));

    mesh.applyRoomSnapshot({ repeatMode: 'all', shuffle: true });

    expect(mesh.repeatMode).toBe('all');
    expect(mesh.shuffle).toBe(true);
    expect(events).toContainEqual({ type: 'PLAYBACK_OPTIONS_UPDATED', payload: { repeatMode: 'all', shuffle: true } });
  });

  it('uses the room queue revision when reordering and accepts a conflict snapshot', async () => {
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.isHost = true;
    mesh.roomId = 'ROOM';
    mesh.peerId = 'host-peer';
    mesh.hostToken = 'private-host-token';
    mesh.queueRevision = 4;
    const canonicalQueue = [{ id: 'a' }, { id: 'new-from-guest' }];
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({
      success: false, error: 'QUEUE_CONFLICT', queue: canonicalQueue, queueRevision: 5
    }) });
    vi.stubGlobal('fetch', fetchMock);

    await mesh.reorderQueue([{ id: 'a' }]);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).expectedQueueRevision).toBe(4);
    expect(mesh.queueRevision).toBe(5);
    expect(mesh.lastKnownQueue).toEqual(canonicalQueue);
  });

  it('rolls back an optimistic room reorder when the server never responds', async () => {
    vi.useFakeTimers();
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.isHost = true;
    mesh.roomId = 'ROOM';
    mesh.peerId = 'host-peer';
    mesh.hostToken = 'token';
    mesh.lastKnownQueue = [{ id: 'a' }, { id: 'b' }];
    vi.stubGlobal('fetch', () => new Promise(() => {}));
    const reorder = mesh.reorderQueue([{ id: 'b' }, { id: 'a' }]);

    expect(mesh.lastKnownQueue.map(item => item.id)).toEqual(['b', 'a']);
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(reorder).resolves.toBe(false);

    expect(mesh.lastKnownQueue.map(item => item.id)).toEqual(['a', 'b']);
    expect(events).toContainEqual(expect.objectContaining({ type: 'QUEUE_SYNC_ERROR' }));
  });

  it('rolls back an optimistic room removal when the server never responds', async () => {
    vi.useFakeTimers();
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.isHost = true;
    mesh.roomId = 'ROOM';
    mesh.peerId = 'host-peer';
    mesh.hostToken = 'token';
    mesh.lastKnownQueue = [{ id: 'current' }, { id: 'next' }];
    vi.stubGlobal('fetch', () => new Promise(() => {}));
    const removal = mesh.removeFromQueue('next');

    expect(mesh.lastKnownQueue.map(item => item.id)).toEqual(['current']);
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(removal).resolves.toBe(false);

    expect(mesh.lastKnownQueue.map(item => item.id)).toEqual(['current', 'next']);
    expect(mesh.deletedQueueIds.has('next')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: 'QUEUE_SYNC_ERROR' }));
  });

  it('ends a stalled room track selection with a retryable result', async () => {
    vi.useFakeTimers();
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.isHost = true;
    mesh.roomId = 'ROOM';
    mesh.peerId = 'host-peer';
    mesh.hostToken = 'token';
    vi.stubGlobal('fetch', () => new Promise(() => {}));
    const selection = mesh.playQueueItem('track-1', true);

    await vi.advanceTimersByTimeAsync(8_000);
    await expect(selection).resolves.toBe(false);

    expect(events).toContainEqual(expect.objectContaining({ type: 'QUEUE_SYNC_ERROR' }));
  });

  it('rebases a queue addition once on a conflict snapshot', async () => {
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.roomId = 'ROOM';
    mesh.peerId = 'guest-peer';
    mesh.queueRevision = 7;
    const canonicalQueue = [{ id: 'from-host' }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({
        success: false, error: 'QUEUE_CONFLICT', queue: canonicalQueue, queueRevision: 8
      }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
        success: true, queue: [...canonicalQueue, { id: 'new-track' }], queueRevision: 9
      }) });
    vi.stubGlobal('fetch', fetchMock);

    mesh.addToQueue({ id: 'new-track', name: 'New track' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).expectedQueueRevision).toBe(7);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).expectedQueueRevision).toBe(8);
    expect(mesh.queueRevision).toBe(9);
    expect(mesh.lastKnownQueue.map(item => item.id)).toEqual(['from-host', 'new-track']);
    expect(events.some(event => event.type === 'QUEUE_SYNC_ERROR')).toBe(false);
  });

  it('clears upcoming tracks optimistically while keeping the active track', async () => {
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.isHost = true;
    mesh.roomId = 'ROOM';
    mesh.peerId = 'peer-1';
    mesh.lastKnownTrack = { id: 'current' };
    mesh.lastKnownQueue = [{ id: 'current' }, { id: 'next' }];
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      success: true, queue: [{ id: 'current' }], removed: [{ item: { id: 'next' }, index: 1 }]
    }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await mesh.clearQueue(['current', 'next']);

    expect(result.removed).toEqual([{ item: { id: 'next' }, index: 1 }]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).expectedQueueRevision).toBe(0);
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
      finishCreate = () => resolve({ ok: true, json: async () => ({ success: true, hostToken: 'host-token-test-000000000000000000000000000000000000' }) });
    }));

    let settled = false;
    const creating = mesh.createRoom('ROOM', 'peer-1', 'Host').then(() => { settled = true; });
    await Promise.resolve();

    expect(settled).toBe(false);
    finishCreate();
    await creating;
    expect(settled).toBe(true);
  });

  it('reclaims the host role on same-browser join using the stored private token', async () => {
    const token = 'stored-host-token-test-000000000000000000000000000000000000';
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => token), setItem: vi.fn() });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      room: { roomId: 'ROOM', isHost: true, queue: [] }
    }) });
    vi.stubGlobal('fetch', fetchMock);
    const mesh = new CloudMesh(() => {});

    const room = await mesh.joinRoom('ROOM', 'new-peer', 'Host');
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);

    expect(requestBody.hostToken).toBe(token);
    expect(mesh.isHost).toBe(true);
    expect(room.isHost).toBe(true);
    mesh.leaveRoom();
  });

  it('times out a stalled room join and clears the pending room identity', async () => {
    vi.useFakeTimers();
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.initBroadcastChannel = vi.fn();
    mesh.initMqttBus = vi.fn();
    mesh.unsubscribe = vi.fn();
    vi.stubGlobal('fetch', () => new Promise(() => {}));

    const joining = mesh.joinRoom('ROOM', 'peer-1', 'Guest');
    const rejected = expect(joining).rejects.toThrow('ROOM_JOIN_TIMEOUT');
    await vi.advanceTimersByTimeAsync(8_000);

    await rejected;
    expect(mesh.roomId).toBeNull();
    expect(mesh.peerId).toBeNull();
    expect(mesh.isHost).toBe(false);
    expect(mesh.unsubscribe).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({ type: 'ROOM_ERROR' }));
  });

  it('times out a room join when the response body stalls after headers', async () => {
    vi.useFakeTimers();
    const mesh = new CloudMesh(() => {});
    mesh.initBroadcastChannel = vi.fn();
    mesh.initMqttBus = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => new Promise(() => {}) }));

    const joining = mesh.joinRoom('ROOM', 'peer-1', 'Guest');
    const rejected = expect(joining).rejects.toThrow('ROOM_JOIN_TIMEOUT');
    await vi.advanceTimersByTimeAsync(8_000);

    await rejected;
    expect(mesh.roomId).toBeNull();
    expect(mesh.peerId).toBeNull();
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

  it('rejects oversized P2P audio headers before allocating transfer state', () => {
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    const channel = makeChannel();
    mesh.setupDataChannel('peer-2', channel);

    channel.onmessage({ data: JSON.stringify({
      type: 'AUDIO_HEADER', name: 'Too large', id: 'huge', totalBytes: 64 * 1024 * 1024 + 1, totalChunks: 2049
    }) });

    expect(mesh.incomingAudioChunks.has('peer-2')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'AUDIO_TRANSFER_PROGRESS',
      payload: expect.objectContaining({ status: expect.stringContaining('terlalu besar') })
    }));
  });

  it('rejects P2P chunks that exceed their declared transfer size', () => {
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    const channel = makeChannel();
    mesh.setupDataChannel('peer-2', channel);
    channel.onopen();
    channel.onmessage({ data: JSON.stringify({
      type: 'AUDIO_HEADER', name: 'Track', id: 'track-1', totalBytes: 1, totalChunks: 1
    }) });

    channel.onmessage({ data: new ArrayBuffer(2) });

    expect(mesh.incomingAudioChunks.has('peer-2')).toBe(false);
    expect(events.some(event => event.type === 'BINARY_AUDIO_RECEIVED')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'AUDIO_TRANSFER_PROGRESS', payload: expect.objectContaining({ status: 'Paket audio P2P tidak valid.' })
    }));
    expect(channel.sent.map(message => JSON.parse(message))).toContainEqual({ type: 'AUDIO_TRANSFER_ACK', id: 'track-1', success: false });
  });

  it('reassembles sequence and timestamp framed P2P audio chunks', () => {
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.updateLoadingState = vi.fn();
    const channel = makeChannel();
    mesh.setupDataChannel('peer-2', channel);
    channel.onmessage({ data: JSON.stringify({
      type: 'AUDIO_HEADER', chunkProtocol: 1, name: 'Track', id: 'track-1', totalBytes: 3, totalChunks: 1
    }) });
    channel.onmessage({ data: makeAudioChunkFrame(0, 42.5, [4, 5, 6]) });

    expect(new Uint8Array(events.find(event => event.type === 'BINARY_AUDIO_RECEIVED').payload.arrayBuffer)).toEqual(new Uint8Array([4, 5, 6]));
    expect(channel.sent.map(message => JSON.parse(message))).toContainEqual({ type: 'AUDIO_TRANSFER_ACK', id: 'track-1', success: true });
  });

  it('rejects an out-of-order framed P2P audio chunk', () => {
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.updateLoadingState = vi.fn();
    const channel = makeChannel();
    mesh.setupDataChannel('peer-2', channel);
    channel.onmessage({ data: JSON.stringify({
      type: 'AUDIO_HEADER', chunkProtocol: 1, name: 'Track', id: 'track-1', totalBytes: 2, totalChunks: 1
    }) });
    channel.onmessage({ data: makeAudioChunkFrame(1, 42.5, [4, 5]) });

    expect(mesh.incomingAudioChunks.has('peer-2')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'AUDIO_TRANSFER_PROGRESS', payload: expect.objectContaining({ status: 'Paket audio P2P tidak valid.' })
    }));
  });

  it('clears a partial audio transfer and reports failure when the peer disconnects', () => {
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.updateLoadingState = vi.fn();
    const channel = makeChannel();
    mesh.setupDataChannel('peer-2', channel);
    channel.onmessage({ data: JSON.stringify({
      type: 'AUDIO_HEADER', name: 'Track', id: 'track-1', totalBytes: 8, totalChunks: 1
    }) });

    channel.onclose();

    expect(mesh.incomingAudioChunks.has('peer-2')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'AUDIO_TRANSFER_PROGRESS',
      payload: expect.objectContaining({ status: 'Koneksi P2P terputus. Coba lagi.' })
    }));
  });

  it('expires an incomplete P2P transfer even while the channel stays open', () => {
    vi.useFakeTimers();
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.updateLoadingState = vi.fn();
    const channel = makeChannel();
    mesh.setupDataChannel('peer-2', channel);
    channel.onmessage({ data: JSON.stringify({
      type: 'AUDIO_HEADER', name: 'Track', id: 'track-1', totalBytes: 8, totalChunks: 1
    }) });

    vi.advanceTimersByTime(30_000);

    expect(mesh.incomingAudioChunks.has('peer-2')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'AUDIO_TRANSFER_PROGRESS', payload: expect.objectContaining({ status: 'Transfer audio P2P timeout. Coba lagi.' })
    }));
  });

  it('fails a P2P send when the data channel backpressure never clears', async () => {
    vi.useFakeTimers();
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    const channel = makeChannel();
    channel.bufferedAmount = 1024 * 1024;
    const transfer = mesh.streamAudioToPeer(channel, new ArrayBuffer(16), 'Track', 'track-1');

    await vi.advanceTimersByTimeAsync(15_000);
    await expect(transfer).resolves.toBe(false);

    expect(events).toContainEqual(expect.objectContaining({
      type: 'AUDIO_TRANSFER_PROGRESS', payload: expect.objectContaining({ status: 'Koneksi P2P lambat atau macet. Coba lagi.' })
    }));
  });

  it('does not send a P2P buffer above the configured size limit', async () => {
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    const channel = makeChannel();

    await mesh.streamAudioToPeer(channel, { byteLength: 64 * 1024 * 1024 + 1 }, 'Huge', 'huge');

    expect(channel.sent).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'AUDIO_TRANSFER_PROGRESS', payload: expect.objectContaining({ status: expect.stringContaining('terlalu besar') })
    }));
  });

  it('sends P2P audio frames with increasing sequence and monotonic timestamps', async () => {
    const mesh = new CloudMesh(() => {});
    const channel = makeChannel();
    mesh.setupDataChannel('peer-2', channel);
    const transfer = mesh.streamAudioToPeer(channel, new ArrayBuffer(32 * 1024 + 1), 'Track', 'track-1');
    let settled = false;
    transfer.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    channel.onmessage({ data: JSON.stringify({ type: 'AUDIO_TRANSFER_ACK', id: 'track-1', success: true }) });
    const sent = await transfer;
    const header = JSON.parse(channel.sent[0]);
    const first = new DataView(channel.sent[1]);
    const second = new DataView(channel.sent[2]);

    expect(sent).toBe(true);
    expect(header.chunkProtocol).toBe(1);
    expect(first.getUint32(0, true)).toBe(0);
    expect(second.getUint32(0, true)).toBe(1);
    expect(Number.isFinite(first.getFloat64(4, true))).toBe(true);
    expect(second.getFloat64(4, true)).toBeGreaterThanOrEqual(first.getFloat64(4, true));
  });

  it('confirms P2P completion only after the receiving mesh reassembles the audio', async () => {
    const received = [];
    const sender = new CloudMesh(() => {});
    const receiver = new CloudMesh((type, payload) => received.push({ type, payload }));
    receiver.updateLoadingState = vi.fn();
    const senderChannel = makeChannel();
    const receiverChannel = makeChannel();
    sender.setupDataChannel('receiver', senderChannel);
    receiver.setupDataChannel('sender', receiverChannel);
    senderChannel.send = value => {
      senderChannel.sent.push(value);
      queueMicrotask(() => receiverChannel.onmessage({ data: value }));
    };
    receiverChannel.send = value => {
      receiverChannel.sent.push(value);
      queueMicrotask(() => senderChannel.onmessage({ data: value }));
    };

    await expect(sender.streamAudioToPeer(senderChannel, new Uint8Array([7, 8, 9]).buffer, 'Track', 'track-1')).resolves.toBe(true);

    expect(new Uint8Array(received.find(event => event.type === 'BINARY_AUDIO_RECEIVED').payload.arrayBuffer)).toEqual(new Uint8Array([7, 8, 9]));
    expect(receiver.audioRouteByTrack.get('track-1')).toBe('p2p');
  });

  it('falls back when the P2P receiver does not acknowledge a completed send', async () => {
    vi.useFakeTimers();
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    const channel = makeChannel();
    const transfer = mesh.streamAudioToPeer(channel, new ArrayBuffer(16), 'Track', 'track-1');

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(transfer).resolves.toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'AUDIO_TRANSFER_PROGRESS',
      payload: expect.objectContaining({ status: expect.stringContaining('Beralih ke relay') })
    }));
  });

  it('does not count transfer time against the receiver acknowledgement deadline', async () => {
    vi.useFakeTimers();
    const mesh = new CloudMesh(() => {});
    const channel = makeChannel();
    channel.bufferedAmount = 1024 * 1024;
    mesh.setupDataChannel('peer-2', channel);
    const transfer = mesh.streamAudioToPeer(channel, new ArrayBuffer(16), 'Track', 'track-1');
    await vi.advanceTimersByTimeAsync(11_000);
    channel.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(20);
    channel.onmessage({ data: JSON.stringify({ type: 'AUDIO_TRANSFER_ACK', id: 'track-1', success: true }) });

    await expect(transfer).resolves.toBe(true);
  });

  it('releases a pending P2P sender immediately when the channel closes', async () => {
    const mesh = new CloudMesh(() => {});
    const channel = makeChannel();
    mesh.setupDataChannel('peer-2', channel);
    const transfer = mesh.streamAudioToPeer(channel, new ArrayBuffer(16), 'Track', 'track-1');

    channel.onclose();

    await expect(transfer).resolves.toBe(false);
    expect(mesh.pendingAudioTransferAcks.has(channel)).toBe(false);
  });

  it('does not start overlapping P2P sends while a track transfer is in flight', async () => {
    vi.useFakeTimers();
    const mesh = new CloudMesh(() => {});
    const channel = makeChannel();
    let finishTransfer;
    const transfer = vi.fn(() => new Promise(resolve => { finishTransfer = resolve; }));
    mesh.streamAudioToPeer = transfer;
    mesh.localAudioBufferCache.set('track-1', new ArrayBuffer(16));
    mesh.localAudioBufferCache.set('track-2', new ArrayBuffer(16));
    mesh.setupDataChannel('peer-2', channel);

    channel.onmessage({ data: JSON.stringify({ type: 'REQUEST_AUDIO_BUFFER', trackId: 'track-1', trackName: 'Track 1' }) });
    await vi.advanceTimersByTimeAsync(1600);
    channel.onmessage({ data: JSON.stringify({ type: 'REQUEST_AUDIO_BUFFER', trackId: 'track-2', trackName: 'Track 2' }) });

    expect(transfer).toHaveBeenCalledOnce();
    expect(transfer).toHaveBeenCalledWith(channel, expect.any(ArrayBuffer), 'Track 1', 'track-1');
    finishTransfer();
    await Promise.resolve();
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
    expect(mesh.waitForQueueItemAcknowledgement('next-track')).toBeInstanceOf(Promise);
    await add;
  });

  it('can wait for the authoritative acknowledgement of a specific queue item', async () => {
    const mesh = new CloudMesh(() => {});
    mesh.roomId = 'ROOM';
    mesh.peerId = 'peer-1';
    mesh.deviceName = 'Host';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, queue: [{ id: 'local-track' }], queueRevision: 4 })
    }));

    await mesh.addToQueue({ id: 'local-track', name: 'Local track' });
    await expect(mesh.waitForQueueItemAcknowledgement('local-track')).resolves.toBe(true);
  });

  it('ends a stalled room queue acknowledgement after a bounded timeout', async () => {
    vi.useFakeTimers();
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.roomId = 'ROOM';
    mesh.peerId = 'peer-1';
    vi.stubGlobal('fetch', vi.fn((_url, options = {}) => new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    })));

    await mesh.addToQueue({ id: 'stalled-track', name: 'Stalled track' });
    const acknowledgement = mesh.waitForQueueItemAcknowledgement('stalled-track');
    let settled = false;
    acknowledgement.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(8_000);
    await Promise.resolve();

    expect(settled).toBe(true);
    await expect(acknowledgement).resolves.toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: 'QUEUE_SYNC_ERROR' }));
  });

  it('keeps local-file queue addition optimistic while exposing a separate server acknowledgement', async () => {
    const mesh = new CloudMesh(() => {});
    mesh.roomId = 'ROOM';
    mesh.peerId = 'peer-1';
    mesh.deviceName = 'Host';
    let resolveFetch;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { resolveFetch = resolve; })));

    await mesh.addToQueue({ id: 'local-track', name: 'Local track', sourceType: 'local-file' });
    expect(mesh.lastKnownQueue.map(track => track.id)).toEqual(['local-track']);

    resolveFetch({ ok: true, json: async () => ({ success: true, queue: [{ id: 'local-track' }], queueRevision: 1 }) });
    await expect(mesh.waitForQueueItemAcknowledgement('local-track')).resolves.toBe(true);
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
    responses[1]({ ok: true, json: async () => ({ success: true, queue: [] }) });
    await removal;

    expect(mesh.lastKnownQueue.map(track => track.id)).toEqual([]);
  });
});

describe('SocketClient room readiness', () => {
  it('forwards host disconnect state to the app', () => {
    const events = [];
    const client = new SocketClient((type, payload) => events.push({ type, payload }));

    client.handleCloudMeshEvent('HOST_DISCONNECTED', { roomId: 'ROOM' });
    client.handleCloudMeshEvent('HOST_RECONNECTED', { roomId: 'ROOM' });

    expect(events.map(event => event.type)).toEqual(['HOST_DISCONNECTED', 'HOST_RECONNECTED']);
  });

  it('forwards automatic track advance to the room service', () => {
    const client = new SocketClient(() => {});
    client.cloudMesh.nextTrack = vi.fn();

    client.nextTrack(true);

    expect(client.cloudMesh.nextTrack).toHaveBeenCalledWith(true);
  });

  it('forwards a prepared queue item when advancing the room', () => {
    const client = new SocketClient(() => {});
    client.cloudMesh.nextTrack = vi.fn();

    client.nextTrack(true, 'local-next');

    expect(client.cloudMesh.nextTrack).toHaveBeenCalledWith(true, 'local-next');
  });

  it('preserves the autoplay request when playing a queued item', () => {
    const client = new SocketClient(() => {});
    const play = vi.fn();
    client.cloudMesh.playQueueItem = play;

    client.playQueueItem('yt_track', true);

    expect(play).toHaveBeenCalledWith('yt_track', true);
  });

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

  it('reports authenticated host status after rejoining a room', async () => {
    const events = [];
    const client = new SocketClient((type, payload) => events.push({ type, payload }));
    client.cloudMesh.joinRoom = vi.fn().mockResolvedValue({ isHost: true });

    await client.joinRoom('ROOM', 'Host');

    expect(client.isHost).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'ROOM_JOINED', payload: expect.objectContaining({ isHost: true })
    }));
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
