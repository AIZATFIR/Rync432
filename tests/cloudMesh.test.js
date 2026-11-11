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
  it('applies a signaling message only once when MQTT and HTTP deliver the same signal', async () => {
    class FakePeerConnection {
      signalingState = 'stable';
      setRemoteDescription = vi.fn(async () => {});
      createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'answer' }));
      async setLocalDescription(description) {
        this.localDescription = { ...description, toJSON: () => description };
      }
      addIceCandidate = vi.fn(async () => {});
    }
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    vi.stubGlobal('RTCSessionDescription', class { constructor(value) { Object.assign(this, value); } });
    const mesh = new CloudMesh(() => {});
    mesh.sendSignal = vi.fn().mockResolvedValue(undefined);
    const signal = { type: 'offer', sdp: { type: 'offer', sdp: 'offer' }, signalId: 'signal-1' };

    await mesh.handleIncomingSignal('peer-1', signal);
    await mesh.handleIncomingSignal('peer-1', signal);

    const peer = mesh.peerConnections.get('peer-1');
    expect(peer.setRemoteDescription).toHaveBeenCalledOnce();
    expect(peer.createAnswer).toHaveBeenCalledOnce();
    expect(mesh.sendSignal).toHaveBeenCalledOnce();
  });

  it('uses the same generated signal id on the MQTT and HTTP transports', async () => {
    const mesh = new CloudMesh(() => {});
    mesh.roomId = 'ROOM';
    mesh.peerId = 'peer-1';
    mesh.publishMqtt = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({});
    vi.stubGlobal('fetch', fetchMock);
    const payload = { type: 'candidate', candidate: { candidate: 'candidate:1' } };

    await mesh.sendSignal('peer-2', payload);

    const mqttSignal = mesh.publishMqtt.mock.calls[0][1].data;
    const httpSignal = JSON.parse(fetchMock.mock.calls[0][1].body).data;
    expect(mqttSignal.signalId).toMatch(/^sig_/);
    expect(httpSignal).toEqual(mqttSignal);
    expect(payload.signalId).toBeUndefined();
  });

  it('keeps a peer during a transient disconnect and cancels cleanup after recovery', () => {
    vi.useFakeTimers();
    class FakePeerConnection {
      connectionState = 'connected';
      close = vi.fn(() => { this.connectionState = 'closed'; });
    }
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    const mesh = new CloudMesh(() => {});
    const peer = mesh.createPeerConnection('peer-2');
    const channel = makeChannel();
    mesh.dataChannels.set('peer-2', channel);

    peer.connectionState = 'disconnected';
    peer.onconnectionstatechange();
    expect(peer.close).not.toHaveBeenCalled();
    expect(mesh.peerConnections.get('peer-2')).toBe(peer);
    expect(mesh.dataChannels.get('peer-2')).toBe(channel);

    peer.connectionState = 'connected';
    peer.onconnectionstatechange();
    vi.advanceTimersByTime(10_000);
    expect(peer.close).not.toHaveBeenCalled();
    expect(mesh.peerConnections.get('peer-2')).toBe(peer);
  });

  it('cleans up a peer that remains disconnected past the grace period', () => {
    vi.useFakeTimers();
    class FakePeerConnection {
      connectionState = 'connected';
      close = vi.fn(() => { this.connectionState = 'closed'; });
    }
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    const mesh = new CloudMesh(() => {});
    const peer = mesh.createPeerConnection('peer-2');
    const channel = makeChannel();
    mesh.dataChannels.set('peer-2', channel);
    mesh.pendingIceCandidates.set('peer-2', []);

    peer.connectionState = 'disconnected';
    peer.onconnectionstatechange();
    vi.advanceTimersByTime(10_000);

    expect(peer.close).toHaveBeenCalledOnce();
    expect(mesh.peerConnections.has('peer-2')).toBe(false);
    expect(mesh.dataChannels.has('peer-2')).toBe(false);
    expect(mesh.pendingIceCandidates.has('peer-2')).toBe(false);
  });

  it('does not replace a disconnected peer while its recovery grace period is active', async () => {
    vi.useFakeTimers();
    class FakePeerConnection {
      connectionState = 'connected';
      close = vi.fn(() => { this.connectionState = 'closed'; });
    }
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    const mesh = new CloudMesh(() => {});
    mesh.isHost = true;
    mesh.peerId = 'host';
    const peer = mesh.createPeerConnection('guest');
    peer.connectionState = 'disconnected';
    peer.onconnectionstatechange();
    mesh.initiateWebRTCOffer = vi.fn();
    mesh.roomId = 'ROOM';
    mesh.peerId = 'host';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ peers: [{ id: 'host', role: 'host' }, { id: 'guest', role: 'speaker' }] })
    }));

    mesh.localPeersMap.set('guest', { id: 'guest', role: 'speaker' });
    await mesh.pollLoop();

    expect(mesh.initiateWebRTCOffer).not.toHaveBeenCalled();
    expect(mesh.peerConnections.get('guest')).toBe(peer);
  });

  it('processes WebRTC signals returned by HTTP room polling', async () => {
    const mesh = new CloudMesh(() => {});
    mesh.roomId = 'ROOM';
    mesh.peerId = 'host';
    mesh.isHost = true;
    mesh.localPeersMap.set('guest', { id: 'guest', role: 'speaker' });
    mesh.initiateWebRTCOffer = vi.fn();
    mesh.handleIncomingSignal = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ peers: [{ id: 'host' }, { id: 'guest', role: 'speaker' }], signals: [{ from: 'guest', data: { type: 'answer' } }] })
    }));

    await mesh.pollLoop();

    expect(mesh.handleIncomingSignal).toHaveBeenCalledWith('guest', { type: 'answer' });
  });

  it('returns from a stalled room poll so the poll scheduler can recover', async () => {
    vi.useFakeTimers();
    const mesh = new CloudMesh(() => {});
    mesh.roomId = 'ROOM';
    mesh.peerId = 'guest';
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));

    const poll = mesh.pollLoop();
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(poll).resolves.toBeUndefined();
  });

  it('bounds a room poll whose response body stalls after headers', async () => {
    vi.useFakeTimers();
    const mesh = new CloudMesh(() => {});
    mesh.roomId = 'ROOM';
    mesh.peerId = 'guest';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => new Promise(() => {}) }));

    const poll = mesh.pollLoop();
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(poll).resolves.toBeUndefined();
  });

  it('does not start WebRTC offers when the browser has no WebRTC support', async () => {
    vi.stubGlobal('RTCPeerConnection', undefined);
    const mesh = new CloudMesh(() => {});
    mesh.roomId = 'ROOM';
    mesh.peerId = 'host';
    mesh.isHost = true;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ peers: [{ id: 'host' }, { id: 'guest', role: 'speaker' }] })
    }));

    await mesh.pollLoop();

    expect(mesh.peerConnections.size).toBe(0);
  });

  it('negotiates a peer channel and transfers a requested audio buffer end to end', async () => {
    const hostEvents = [];
    const guestEvents = [];
    class FakeDataChannel {
      readyState = 'connecting';
      bufferedAmount = 0;
      sent = [];
      pair = null;
      send(value) {
        this.sent.push(value);
        this.pair?.onmessage?.({ data: value });
      }
      open() {
        this.readyState = 'open';
        this.onopen?.();
      }
      close() {
        this.readyState = 'closed';
        this.onclose?.();
      }
    }
    class FakePeerConnection {
      static offeredChannel;
      signalingState = 'stable';
      connectionState = 'new';
      createDataChannel() {
        this.channel = new FakeDataChannel();
        FakePeerConnection.offeredChannel = this.channel;
        return this.channel;
      }
      async createOffer() { return { type: 'offer', sdp: 'fake-offer' }; }
      async createAnswer() { return { type: 'answer', sdp: 'fake-answer' }; }
      async setLocalDescription(description) {
        this.localDescription = { ...description, toJSON: () => ({ type: description.type, sdp: description.sdp }) };
        this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
      }
      async setRemoteDescription(description) {
        this.remoteDescription = description;
        if (description.type === 'offer') {
          this.signalingState = 'have-remote-offer';
          const remoteChannel = new FakeDataChannel();
          const offeredChannel = FakePeerConnection.offeredChannel;
          offeredChannel.pair = remoteChannel;
          remoteChannel.pair = offeredChannel;
          this.ondatachannel({ channel: remoteChannel });
          offeredChannel.open();
          remoteChannel.open();
        } else {
          this.signalingState = 'stable';
        }
      }
      async addIceCandidate() {}
      close() { this.connectionState = 'closed'; this.channel?.close(); }
    }
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    vi.stubGlobal('RTCSessionDescription', class { constructor(value) { Object.assign(this, value); } });
    const host = new CloudMesh((type, payload) => hostEvents.push({ type, payload }));
    const guest = new CloudMesh((type, payload) => guestEvents.push({ type, payload }));
    host.roomId = guest.roomId = 'ROOM';
    host.peerId = 'host';
    guest.peerId = 'guest';
    host.isHost = true;
    host.lastKnownTrack = { id: 'track-1', name: 'Song' };
    guest.lastKnownTrack = host.lastKnownTrack;
    host.localAudioBufferCache.set('track-1', new Uint8Array([4, 8, 15, 16, 23, 42]).buffer);
    host.updateLoadingState = vi.fn();
    guest.updateLoadingState = vi.fn();
    host.broadcastReadiness = vi.fn();
    guest.broadcastReadiness = vi.fn();
    host.sendSignal = async (_target, signal) => guest.handleIncomingSignal('host', signal);
    guest.sendSignal = async (_target, signal) => host.handleIncomingSignal('guest', signal);

    await host.initiateWebRTCOffer('guest');
    guest.requestTrackBufferFromPeers('Song', 'track-1');

    const received = guestEvents.find(event => event.type === 'BINARY_AUDIO_RECEIVED')?.payload?.arrayBuffer;
    expect(host.peerConnections.get('guest').channel.readyState).toBe('open');
    expect(guest.dataChannels.get('host').readyState).toBe('open');
    expect(Array.from(new Uint8Array(received))).toEqual([4, 8, 15, 16, 23, 42]);
    expect(host.pendingAudioTransferAcks.size).toBe(0);
    expect(guest.incomingAudioChunks.size).toBe(0);
  });

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
    mesh.broadcastReadiness = vi.fn();
    mesh.requestTrackBufferFromPeers = vi.fn();
    vi.stubGlobal('fetch', vi.fn());
    const track = { id: 'yt_dQw4w9WgXcQ', sourceType: 'youtube', sourceId: 'dQw4w9WgXcQ', name: 'Song' };

    mesh.loadTrackBuffer(track);

    expect(events).toContainEqual({ type: 'YOUTUBE_TRACK_REQUESTED', payload: track });
    expect(mesh.broadcastReadiness).toHaveBeenLastCalledWith('PREPARING', track.id, 'unknown');
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

  it('syncs multiple tracks with one optimistic room queue request', async () => {
    const mesh = new CloudMesh(() => {});
    mesh.roomId = 'ROOM';
    mesh.peerId = 'host';
    mesh.lastKnownQueue = [];
    mesh.publishMqtt = vi.fn();
    mesh.broadcastDataChannelMessage = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      success: true,
      queueRevision: 1,
      queue: [{ id: 'a', queueItemId: 'a-1', name: 'A' }, { id: 'b', queueItemId: 'b-1', name: 'B' }, { id: 'a', queueItemId: 'a-2', name: 'A' }]
    }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await mesh.addQueueItems([
      { id: 'a', queueItemId: 'a-1', name: 'A' }, { id: 'b', queueItemId: 'b-1', name: 'B' }, { id: 'a', queueItemId: 'a-2', name: 'A' }
    ]);

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).items.map(item => item.queueItemId)).toEqual(['a-1', 'b-1', 'a-2']);
    expect(mesh.lastKnownQueue.map(item => item.id)).toEqual(['a', 'b', 'a']);
  });

  it('rebases a batched room queue addition once on a revision conflict', async () => {
    const mesh = new CloudMesh(() => {});
    mesh.roomId = 'ROOM';
    mesh.peerId = 'host';
    mesh.queueRevision = 2;
    mesh.lastKnownQueue = [];
    mesh.publishMqtt = vi.fn();
    mesh.broadcastDataChannelMessage = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ queueRevision: 3, queue: [{ id: 'other', name: 'Other' }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, queueRevision: 4, queue: [{ id: 'other', name: 'Other' }, { id: 'mine', name: 'Mine' }] }) });
    vi.stubGlobal('fetch', fetchMock);

    await expect(mesh.addQueueItems([{ id: 'mine', name: 'Mine' }])).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).expectedQueueRevision).toBe(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).expectedQueueRevision).toBe(3);
    expect(mesh.lastKnownQueue.map(item => item.id)).toEqual(['other', 'mine']);
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
  it('ends a missing P2P audio wait with a visible failure after 10 seconds', () => {
    vi.useFakeTimers();
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.roomId = 'ROOM';
    mesh.peerId = 'peer-1';
    mesh.localPeersMap.set('peer-1', { id: 'peer-1' });
    mesh.dataChannels.set('peer-2', makeChannel());

    mesh.requestTrackBufferFromPeers('Track', 'track-1');
    vi.advanceTimersByTime(10_000);

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
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mesh.requestTrackBufferFromPeers).toHaveBeenCalledWith('Slow track', 'slow-track');
    await loading;

    expect(mesh.requestTrackBufferFromPeers).toHaveBeenCalledWith('Slow track', 'slow-track');
    expect(mesh.broadcastReadiness).toHaveBeenCalledWith('PREPARING', 'slow-track');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'AUDIO_TRANSFER_PROGRESS',
      payload: expect.objectContaining({ status: 'Menunggu audio...' })
    }));
  });

  it('does not let an expired old fetch abort the newly selected track', async () => {
    vi.useFakeTimers();
    const mesh = new CloudMesh(() => {});
    mesh.roomId = 'ROOM';
    mesh.broadcastReadiness = vi.fn();
    mesh.updateLoadingState = vi.fn();
    const signals = [];
    vi.stubGlobal('fetch', vi.fn((_url, { signal }) => {
      signals.push(signal);
      if (signals.length === 1) return new Promise(() => {});
      return Promise.resolve({
        ok: true,
        headers: { get: () => null },
        body: null,
        arrayBuffer: async () => new ArrayBuffer(8)
      });
    }));

    const oldFetch = mesh.fetchRemoteAudioUrl('/old.mp3', 'Old', 'old-track');
    await vi.advanceTimersByTimeAsync(5_000);
    await mesh.fetchRemoteAudioUrl('/new.mp3', 'New', 'new-track');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    void oldFetch;
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

  it('rebases concurrent queue additions until each accepted revision is reached', async () => {
    const mesh = new CloudMesh(() => {});
    mesh.roomId = 'ROOM';
    mesh.peerId = 'guest-peer';
    let revision = 0;
    const queue = [];
    const fetchMock = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.expectedQueueRevision !== revision) {
        return { ok: false, status: 409, json: async () => ({ queue: [...queue], queueRevision: revision }) };
      }
      queue.push(body);
      revision += 1;
      return { ok: true, status: 200, json: async () => ({ success: true, queue: [...queue], queueRevision: revision }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    await Promise.all(['a', 'b', 'c', 'd'].map(id => mesh.addToQueue({ id, name: id })));
    await vi.waitFor(() => expect(revision).toBe(4));

    expect(queue.map(item => item.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(mesh.lastKnownQueue.map(item => item.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(mesh.queueRevision).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(10);
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
    vi.stubGlobal('sessionStorage', { getItem: vi.fn(() => token), setItem: vi.fn(), removeItem: vi.fn() });
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

  it('stores host tokens in tab-scoped storage', () => {
    const mesh = new CloudMesh(() => {});
    const sessionStore = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
    const localStore = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal('sessionStorage', sessionStore);
    vi.stubGlobal('localStorage', localStore);

    mesh.saveHostToken('ROOM', 'private-token');

    expect(sessionStore.setItem).toHaveBeenCalledWith('rync_host_token_ROOM', 'private-token');
    expect(localStore.setItem).not.toHaveBeenCalled();
  });

  it('migrates an existing host token into tab-scoped storage and removes the shared copy', () => {
    const mesh = new CloudMesh(() => {});
    const sessionStore = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
    const localStore = { getItem: vi.fn(() => 'legacy-token'), setItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal('sessionStorage', sessionStore);
    vi.stubGlobal('localStorage', localStore);

    expect(mesh.loadHostToken('ROOM')).toBe('legacy-token');
    expect(sessionStore.setItem).toHaveBeenCalledWith('rync_host_token_ROOM', 'legacy-token');
    expect(localStore.removeItem).toHaveBeenCalledWith('rync_host_token_ROOM');
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

  it('records local room join duration and failure without room identifiers', async () => {
    const store = new Map();
    vi.stubGlobal('localStorage', { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value) });
    const mesh = new CloudMesh(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    await expect(mesh.joinRoom('PRIVATE', 'peer', 'Guest')).rejects.toThrow();

    const metrics = JSON.parse(store.get('rync_metrics_v1'));
    expect(metrics.room_join_ms).toHaveLength(1);
    expect(metrics.room_join_ms[0]).toMatchObject({ outcome: 'failure' });
    expect(JSON.stringify(metrics)).not.toContain('PRIVATE');
  });

  it('records a successful queue server acknowledgement locally', async () => {
    const store = new Map();
    vi.stubGlobal('localStorage', { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value) });
    const mesh = new CloudMesh(() => {});
    mesh.roomId = 'ROOM';
    mesh.peerId = 'peer';
    mesh.lastKnownQueue = [];
    mesh.publishMqtt = vi.fn();
    mesh.broadcastDataChannelMessage = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, queue: [{ id: 'track' }] }) }));

    await mesh.addToQueue({ id: 'track', name: 'Private title' });
    await mesh.waitForQueueItemAcknowledgement(mesh.lastKnownQueue[0].queueItemId);

    const metrics = JSON.parse(store.get('rync_metrics_v1'));
    expect(metrics.queue_ack_ms).toHaveLength(1);
    expect(metrics.queue_ack_ms[0].outcome).toBe('success');
    expect(JSON.stringify(metrics)).not.toContain('Private title');
  });

  it('measures source preparation until a room peer reports audio ready', async () => {
    vi.useFakeTimers();
    const store = new Map();
    vi.stubGlobal('localStorage', { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value) });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const mesh = new CloudMesh(() => {});
    mesh.roomId = 'ROOM';
    mesh.peerId = 'peer';
    mesh.requestTrackBufferFromPeers = vi.fn();
    mesh.updateLoadingState = vi.fn();
    mesh.publishMqtt = vi.fn();
    mesh.broadcastDataChannelMessage = vi.fn();

    await mesh.loadTrackBuffer({ id: 'private-track', name: 'Private title', sourceType: 'local-file' });
    await vi.advanceTimersByTimeAsync(125);
    mesh.broadcastReadiness('READY', 'private-track', 'p2p');

    const metrics = JSON.parse(store.get('rync_metrics_v1'));
    expect(metrics.audio_ready_ms).toEqual([{ durationMs: 125, outcome: 'success' }]);
    expect(JSON.stringify(metrics)).not.toContain('Private title');
  });

  it.each([
    ['connected', 'success'],
    ['failed', 'failure']
  ])('measures WebRTC establishment until %s', (state, outcome) => {
    vi.useFakeTimers();
    const store = new Map();
    vi.stubGlobal('localStorage', { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value) });
    class FakePeerConnection {
      connectionState = 'new';
      close = vi.fn();
    }
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    const mesh = new CloudMesh(() => {});
    const peer = mesh.createPeerConnection('private-peer');

    vi.advanceTimersByTime(240);
    peer.connectionState = state;
    peer.onconnectionstatechange();

    const metrics = JSON.parse(store.get('rync_metrics_v1'));
    expect(metrics.webrtc_connect_ms).toEqual([{ durationMs: 240, outcome }]);
    expect(JSON.stringify(metrics)).not.toContain('private-peer');
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

  it('loads a requested track only once when multiple peers finish duplicate P2P transfers', () => {
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.lastKnownTrack = { id: 'track-1', name: 'Track' };
    const firstPeer = makeChannel();
    const secondPeer = makeChannel();
    mesh.setupDataChannel('peer-1', firstPeer);
    mesh.setupDataChannel('peer-2', secondPeer);

    for (const channel of [firstPeer, secondPeer]) {
      channel.onmessage({ data: JSON.stringify({
        type: 'AUDIO_HEADER', id: 'track-1', name: 'Track', totalBytes: 3,
        totalChunks: 1, chunkProtocol: 1
      }) });
    }
    firstPeer.onmessage({ data: makeAudioChunkFrame(0, 1, [1, 2, 3]) });
    secondPeer.onmessage({ data: makeAudioChunkFrame(0, 1, [1, 2, 3]) });

    expect(events.filter(event => event.type === 'BINARY_AUDIO_RECEIVED')).toHaveLength(1);
    expect(firstPeer.sent.map(message => JSON.parse(message))).toContainEqual(expect.objectContaining({ type: 'AUDIO_TRANSFER_ACK', success: true }));
    expect(secondPeer.sent.map(message => JSON.parse(message))).toContainEqual(expect.objectContaining({ type: 'AUDIO_TRANSFER_ACK', success: true }));
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

  it('blocks guest playback controls while the room host is disconnected', () => {
    const mesh = new CloudMesh(() => {});
    mesh.isHost = false;
    mesh.hostDisconnected = true;
    mesh.publishMqtt = vi.fn();
    mesh.broadcastDataChannelMessage = vi.fn();

    expect(mesh.requestControl('next')).toBe(false);
    expect(mesh.publishMqtt).not.toHaveBeenCalled();
    expect(mesh.broadcastDataChannelMessage).not.toHaveBeenCalled();
  });

  it('polls an established guest room frequently enough to detect a host loss', () => {
    vi.stubGlobal('document', { hidden: false });
    const guest = new CloudMesh(() => {});
    guest.isHost = false;
    guest.dataChannels.set('host-peer', { readyState: 'open' });
    const host = new CloudMesh(() => {});
    host.isHost = true;
    host.dataChannels.set('guest-peer', { readyState: 'open' });

    expect(guest.getOptimalPollInterval()).toBe(1500);
    expect(host.getOptimalPollInterval()).toBe(5000);
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
    channel.onopen();
    channel.onmessage({ data: JSON.stringify({
      type: 'AUDIO_HEADER', chunkProtocol: 1, name: 'Track', id: 'track-1', totalBytes: 3, totalChunks: 1
    }) });
    channel.onmessage({ data: makeAudioChunkFrame(0, 42.5, [4, 5, 6]) });

    expect(new Uint8Array(events.find(event => event.type === 'BINARY_AUDIO_RECEIVED').payload.arrayBuffer)).toEqual(new Uint8Array([4, 5, 6]));
    expect(channel.sent.map(message => JSON.parse(message))).toContainEqual({ type: 'AUDIO_TRANSFER_ACK', id: 'track-1', success: true });
  });

  it('writes incoming framed chunks into one pre-sized buffer without retaining chunk arrays', () => {
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.updateLoadingState = vi.fn();
    const channel = makeChannel();
    mesh.setupDataChannel('peer-2', channel);
    channel.onopen();
    channel.onmessage({ data: JSON.stringify({
      type: 'AUDIO_HEADER', chunkProtocol: 1, name: 'Track', id: 'track-1', totalBytes: 32 * 1024 + 2, totalChunks: 2
    }) });

    const transfer = mesh.incomingAudioChunks.get('peer-2');
    expect(transfer.buffer).toBeNull();
    const firstChunk = new Uint8Array(32 * 1024).fill(4);
    channel.onmessage({ data: makeAudioChunkFrame(0, 1, firstChunk) });
    expect(transfer.buffer).toBeInstanceOf(Uint8Array);
    expect(transfer.buffer.byteLength).toBe(32 * 1024 + 2);
    expect(transfer.chunks).toBeUndefined();

    channel.onmessage({ data: makeAudioChunkFrame(1, 2, [6, 7]) });

    const received = new Uint8Array(events.find(event => event.type === 'BINARY_AUDIO_RECEIVED').payload.arrayBuffer);
    expect(received.byteLength).toBe(32 * 1024 + 2);
    expect(received.slice(0, 2)).toEqual(new Uint8Array([4, 4]));
    expect(received.slice(-2)).toEqual(new Uint8Array([6, 7]));
  });

  it('emits P2P progress only when the displayed integer percentage changes', () => {
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.updateLoadingState = vi.fn();
    const channel = makeChannel();
    mesh.setupDataChannel('peer-2', channel);
    channel.onopen();
    channel.onmessage({ data: JSON.stringify({
      type: 'AUDIO_HEADER', chunkProtocol: 1, name: 'Track', id: 'track-1', totalBytes: 32 * 1024 * 1000, totalChunks: 1000
    }) });

    for (let sequence = 0; sequence < 10; sequence += 1) {
      channel.onmessage({ data: makeAudioChunkFrame(sequence, sequence, new Uint8Array(32 * 1024)) });
    }

    const progress = events.filter(event => event.type === 'AUDIO_TRANSFER_PROGRESS' && event.payload.pct > 0 && event.payload.pct < 100);
    expect(progress.length).toBeLessThan(10);
    expect(progress.map(event => event.payload.pct)).toEqual([...new Set(progress.map(event => event.payload.pct))]);
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

    vi.advanceTimersByTime(10_000);

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

    await vi.advanceTimersByTimeAsync(10_000);
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

  it('caches a queued P2P track without changing readiness for the currently playing track', () => {
    vi.useFakeTimers();
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.lastKnownTrack = { id: 'playing-track', name: 'Playing track' };
    mesh.pendingTrackBufferRequest = mesh.lastKnownTrack;
    mesh.updateLoadingState = vi.fn();
    mesh.broadcastReadiness = vi.fn();
    mesh.peerBufferRequestTrackKey = 'playing-track';
    mesh.peerBufferRequestInterval = setInterval(() => {}, 1000);
    const channel = makeChannel();
    mesh.setupDataChannel('peer-2', channel);
    channel.onmessage({ data: JSON.stringify({
      type: 'AUDIO_HEADER', chunkProtocol: 1, name: 'Queued track', id: 'queued-track', totalBytes: 3, totalChunks: 1
    }) });
    channel.onmessage({ data: makeAudioChunkFrame(0, 1, [4, 5, 6]) });

    expect(new Uint8Array(mesh.localAudioBufferCache.get('queued-track'))).toEqual(new Uint8Array([4, 5, 6]));
    expect(events.some(event => event.type === 'BINARY_AUDIO_RECEIVED')).toBe(false);
    expect(events.some(event => event.type === 'AUDIO_TRANSFER_PROGRESS' && event.payload.status === 'Audio P2P Siap!')).toBe(false);
    expect(mesh.broadcastReadiness).not.toHaveBeenCalledWith('READY', 'queued-track', 'p2p');
    expect(mesh.peerBufferRequestInterval).not.toBeNull();
    expect(channel.sent.map(message => JSON.parse(message))).toContainEqual({ type: 'AUDIO_TRANSFER_ACK', id: 'queued-track', success: true });
    clearInterval(mesh.peerBufferRequestInterval);
  });

  it('does not let a stale partial P2P transfer failure replace the new track status', async () => {
    vi.useFakeTimers();
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.lastKnownTrack = { id: 'old-track', name: 'Old track' };
    mesh.pendingTrackBufferRequest = mesh.lastKnownTrack;
    mesh.currentFetchingTrackKey = 'old-track';
    mesh.updateLoadingState = vi.fn();
    mesh.broadcastReadiness = vi.fn();
    const channel = makeChannel();
    mesh.setupDataChannel('peer-2', channel);
    channel.onmessage({ data: JSON.stringify({
      type: 'AUDIO_HEADER', chunkProtocol: 1, name: 'Old track', id: 'old-track', totalBytes: 32 * 1024 + 1, totalChunks: 2
    }) });
    channel.onmessage({ data: makeAudioChunkFrame(0, 1, new Uint8Array(32 * 1024).fill(4)) });
    expect(mesh.incomingAudioChunks.get('peer-2')?.receivedBytes).toBe(32 * 1024);

    mesh.lastKnownTrack = { id: 'new-track', name: 'New track' };
    mesh.pendingTrackBufferRequest = mesh.lastKnownTrack;
    mesh.currentFetchingTrackKey = 'new-track';
    events.length = 0;
    mesh.updateLoadingState.mockClear();
    mesh.broadcastReadiness.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mesh.incomingAudioChunks.has('peer-2')).toBe(false);
    expect(mesh.currentFetchingTrackKey).toBe('new-track');
    expect(mesh.updateLoadingState).not.toHaveBeenCalled();
    expect(mesh.broadcastReadiness).not.toHaveBeenCalledWith('FAILED', 'old-track');
    expect(events.some(event => event.type === 'AUDIO_TRANSFER_PROGRESS' && event.payload.status.includes('timeout'))).toBe(false);
  });

  it('reports a missing P2P acknowledgement after a bounded wait', async () => {
    vi.useFakeTimers();
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    const channel = makeChannel();
    let settled = false;
    const transfer = mesh.streamAudioToPeer(channel, new ArrayBuffer(16), 'Track', 'track-1').then(result => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(settled).toBe(true);
    await expect(transfer).resolves.toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'AUDIO_TRANSFER_PROGRESS',
      payload: expect.objectContaining({ status: expect.stringContaining('Penerima tidak mengonfirmasi P2P') })
    }));
  });

  it('does not count transfer time against the receiver acknowledgement deadline', async () => {
    vi.useFakeTimers();
    const mesh = new CloudMesh(() => {});
    const channel = makeChannel();
    channel.bufferedAmount = 1024 * 1024;
    mesh.setupDataChannel('peer-2', channel);
    const transfer = mesh.streamAudioToPeer(channel, new ArrayBuffer(16), 'Track', 'track-1');
    await vi.advanceTimersByTimeAsync(9_000);
    channel.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(1_500);
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

  it('retries an uncached room track when the server adds its relay source', () => {
    const mesh = new CloudMesh(() => {});
    mesh.loadTrackBuffer = vi.fn();
    const localTrack = { id: 'local-a', name: 'Local A', sourceType: 'local-file', audioUrl: '' };

    mesh.applyRoomSnapshot({ track: localTrack, state: 'PAUSED' });
    mesh.applyRoomSnapshot({ track: {
      ...localTrack,
      audioId: 'aud_123',
      audioUrl: '/api/room?action=get_audio&audioId=aud_123'
    }, state: 'PAUSED' });

    expect(mesh.lastKnownTrack.audioUrl).toContain('audioId=aud_123');
    expect(mesh.loadTrackBuffer).toHaveBeenCalledTimes(2);
  });

  it('keeps a ready P2P buffer when the room later publishes a relay URL', () => {
    const mesh = new CloudMesh(() => {});
    mesh.loadTrackBuffer = vi.fn();
    const localTrack = { id: 'local-a', name: 'Local A', sourceType: 'local-file', audioUrl: '' };

    mesh.applyRoomSnapshot({ track: localTrack, state: 'PAUSED' });
    mesh.localAudioBufferCache.set(localTrack.id, new ArrayBuffer(8));
    mesh.applyRoomSnapshot({ track: {
      ...localTrack,
      audioId: 'aud_123',
      audioUrl: '/api/room?action=get_audio&audioId=aud_123'
    }, state: 'PAUSED' });

    expect(mesh.loadTrackBuffer).toHaveBeenCalledOnce();
    expect(mesh.lastKnownTrack.audioId).toBe('aud_123');
  });

  it('does not schedule autoplay for an empty next-track response', async () => {
    const events = [];
    const mesh = new CloudMesh((type, payload) => events.push({ type, payload }));
    mesh.isHost = true;
    mesh.roomId = 'ROOM';
    mesh.peerId = 'host-peer';
    mesh.hostToken = 'token';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, state: 'PLAYING', targetServerTime: Date.now() + 500, track: null, queue: [] })
    }));

    await mesh.nextTrack(true);

    expect(events.some(event => event.type === 'SCHEDULED_PLAY')).toBe(false);
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
    const track = { id: 'local-track', name: 'Local track' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, queue: [{ ...track }], queueRevision: 4 })
    }));

    await mesh.addToQueue(track);
    await expect(mesh.waitForQueueItemAcknowledgement(track.queueItemId)).resolves.toBe(true);
  });

  it('preserves a successful queue acknowledgement for a waiter that arrives afterward', async () => {
    const mesh = new CloudMesh(() => {});
    mesh.roomId = 'ROOM';
    mesh.peerId = 'peer-1';
    mesh.deviceName = 'Host';
    const track = { id: 'quick-track', name: 'Quick track' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, queue: [{ ...track, queueItemId: track.queueItemId }], queueRevision: 1 })
    }));

    await mesh.addToQueue(track);
    await vi.waitFor(() => expect(mesh.queueAdditionAcknowledgements.has(track.queueItemId)).toBe(false));

    await expect(mesh.waitForQueueItemAcknowledgement(track.queueItemId)).resolves.toBe(true);
    mesh.lastKnownQueue = [];
    await expect(mesh.waitForQueueItemAcknowledgement(track.queueItemId)).resolves.toBe(false);
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

    const track = { id: 'stalled-track', name: 'Stalled track' };
    await mesh.addToQueue(track);
    const acknowledgement = mesh.waitForQueueItemAcknowledgement(track.queueItemId);
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

    const track = { id: 'local-track', name: 'Local track', sourceType: 'local-file' };
    await mesh.addToQueue(track);
    expect(mesh.lastKnownQueue.map(track => track.id)).toEqual(['local-track']);

    resolveFetch({ ok: true, json: async () => ({ success: true, queue: [{ ...track }], queueRevision: 1 }) });
    await expect(mesh.waitForQueueItemAcknowledgement(track.queueItemId)).resolves.toBe(true);
  });

  it('adds repeated tracks as separate queue items with stable retry ids', async () => {
    const mesh = new CloudMesh(() => {});
    mesh.roomId = 'ROOM';
    mesh.peerId = 'peer-1';
    mesh.deviceName = 'Host';
    const serverQueue = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, options) => {
      const body = JSON.parse(options.body);
      const item = body.items?.[0] || body;
      if (!serverQueue.some(queued => queued.queueItemId === item.queueItemId)) serverQueue.push(item);
      return { ok: true, json: async () => ({ success: true, queue: [...serverQueue] }) };
    }));

    await mesh.addToQueue({ id: 'demo_synthwave', name: 'Demo', isSynthetic: true });
    await mesh.addToQueue({ id: 'demo_synthwave', name: 'Demo', isSynthetic: true });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mesh.lastKnownQueue.map(track => track.id)).toEqual(['demo_synthwave', 'demo_synthwave']);
    expect(new Set(mesh.lastKnownQueue.map(track => track.queueItemId)).size).toBe(2);
  });

  it('retries a failed queue addition with the same stable id', async () => {
    const mesh = new CloudMesh(() => {});
    mesh.roomId = 'ROOM';
    mesh.peerId = 'peer-1';
    const track = { id: 'retry-track', name: 'Retry track' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
        success: true, queue: [{ ...track }], queueRevision: 1
      }) });
    vi.stubGlobal('fetch', fetchMock);

    await mesh.addToQueue(track);
    await expect(mesh.waitForQueueItemAcknowledgement(track.queueItemId)).resolves.toBe(false);
    await mesh.addToQueue(track);

    await expect(mesh.waitForQueueItemAcknowledgement(track.queueItemId)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mesh.lastKnownQueue.map(track => track.id)).toEqual(['retry-track']);
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

    const track = { id: 'track-x', name: 'Track X' };
    await mesh.addToQueue(track);
    const removal = mesh.removeFromQueue(track.queueItemId);
    responses[0]({ json: async () => ({ queue: [{ ...track }] }) });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mesh.lastKnownQueue.map(track => track.id)).toEqual([]);
    responses[1]({ ok: true, json: async () => ({ success: true, queue: [] }) });
    await removal;

    expect(mesh.lastKnownQueue.map(track => track.id)).toEqual([]);
  });
});

describe('SocketClient room readiness', () => {
  it('shows reconnecting after one failed health check and offline after repeated failures', async () => {
    const events = [];
    const client = new SocketClient((type, payload) => events.push({ type, payload }));
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('server unavailable')));

    await client.checkHealth();
    expect(events.map(event => event.type)).toEqual(['RECONNECTING']);
    expect(client.isConnected).toBe(false);

    await client.checkHealth();
    expect(events.map(event => event.type)).toEqual(['RECONNECTING', 'DISCONNECTED']);
    expect(client.isConnected).toBe(false);
  });

  it('recovers the connection state only after the health endpoint responds successfully', async () => {
    const events = [];
    const client = new SocketClient((type, payload) => events.push({ type, payload }));
    client.setConnectionState('DISCONNECTED');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ t0: 1, t1: 2, t2: 3 })
    }));

    await client.checkHealth();

    expect(events.map(event => event.type)).toEqual(['DISCONNECTED', 'CONNECTED']);
    expect(client.isConnected).toBe(true);
    expect(client.clockSync.offset).toBeDefined();
  });

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
