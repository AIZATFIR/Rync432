import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudMesh } from '../public/js/network/CloudMesh.js';

afterEach(() => vi.unstubAllGlobals());

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
