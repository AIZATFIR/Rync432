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

  it('marks a synthetic track ready after local preparation', () => {
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.broadcastReadiness = vi.fn();

    mesh.loadTrackBuffer({ id: 'demo-synth', name: 'Neon Groove Synthwave', isSynthetic: true });

    expect(mesh.broadcastReadiness).toHaveBeenLastCalledWith('READY', 'demo-synth');
    expect(events).toContainEqual(expect.objectContaining({ type: 'SYNTHETIC_TRACK_REQUESTED' }));
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

    mesh.broadcastReadiness('PREPARING', 'track');
    mesh.broadcastReadiness('READY', 'track');
    await mesh.readinessSync;

    expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body).readiness)).toEqual(['PREPARING', 'READY']);
    expect(mesh.localPeersMap.get('peer')).toMatchObject({ readiness: 'READY', isAudioLoading: false });
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
    channel.onmessage({ data: JSON.stringify({
      type: 'AUDIO_HEADER', name: 'Track', id: 'track-1', totalBytes: 1, totalChunks: 1
    }) });

    channel.onmessage({ data: new ArrayBuffer(2) });

    expect(mesh.incomingAudioChunks.has('peer-2')).toBe(false);
    expect(events.some(event => event.type === 'BINARY_AUDIO_RECEIVED')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'AUDIO_TRANSFER_PROGRESS', payload: expect.objectContaining({ status: 'Paket audio P2P tidak valid.' })
    }));
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
    const sent = await mesh.streamAudioToPeer(channel, new ArrayBuffer(32 * 1024 + 1), 'Track', 'track-1');
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

  it('keeps optimistic queue additions immediate while emitting local-file transfer after server acceptance', async () => {
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.roomId = 'ROOM';
    mesh.peerId = 'peer-1';
    mesh.deviceName = 'Host';
    let resolveFetch;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { resolveFetch = resolve; })));

    await mesh.addToQueue({ id: 'local-track', name: 'Local track', sourceType: 'local-file' });
    expect(mesh.lastKnownQueue.map(track => track.id)).toEqual(['local-track']);
    expect(events.some(event => event.type === 'LOCAL_FILE_QUEUE_ACCEPTED')).toBe(false);

    resolveFetch({ ok: true, json: async () => ({ success: true, queue: [{ id: 'local-track' }], queueRevision: 1 }) });
    await expect(mesh.waitForQueueItemAcknowledgement('local-track')).resolves.toBe(true);
    await Promise.resolve();
    expect(events).toContainEqual(expect.objectContaining({ type: 'LOCAL_FILE_QUEUE_ACCEPTED', payload: expect.objectContaining({ id: 'local-track' }) }));
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
