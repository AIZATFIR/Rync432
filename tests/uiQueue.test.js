import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../public/js/auth/FirebaseAuth.js', () => ({
  firebaseAuth: { onAuthStateChanged() {} }
}));

import { UIManager, moveQueueItem, upcomingQueueItems } from '../public/js/ui/UIManager.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('YouTube search queue UI', () => {
  it('auto-advances a solo queue when audio playback ends', () => {
    const ui = new UIManager({ socketClient: { roomId: null, isHost: false } });
    ui.setPlayState = vi.fn();
    ui.goToNextTrack = vi.fn();

    ui.handleAudioPlaybackEnded();

    expect(ui.setPlayState).toHaveBeenCalledWith(false);
    expect(ui.goToNextTrack).toHaveBeenCalledWith({ automatic: true });
  });

  it('lets only the room host advance after audio playback ends', () => {
    const guest = new UIManager({ socketClient: { roomId: 'ROOM', isHost: false } });
    guest.setPlayState = vi.fn();
    guest.goToNextTrack = vi.fn();
    guest.handleAudioPlaybackEnded();
    expect(guest.goToNextTrack).not.toHaveBeenCalled();

    const host = new UIManager({ socketClient: { roomId: 'ROOM', isHost: true } });
    host.setPlayState = vi.fn();
    host.goToNextTrack = vi.fn();
    host.handleAudioPlaybackEnded();
    expect(host.goToNextTrack).toHaveBeenCalledWith({ automatic: true });
  });

  it('shows a YouTube audio unlock action and starts audio from its tap', () => {
    const button = { hidden: true };
    const status = { textContent: '' };
    const youtubePlayer = { playFromUserGesture: vi.fn().mockReturnValue(true) };
    const ui = new UIManager({ youtubePlayer });
    ui.elements = { youtubeEnableAudioBtn: button, youtubePlayerStatus: status };

    ui.setYouTubeAutoplayBlocked(true);
    expect(button.hidden).toBe(false);
    expect(ui.enableYouTubeAudioFromGesture()).toBe(true);
    expect(youtubePlayer.playFromUserGesture).toHaveBeenCalledOnce();
    expect(button.hidden).toBe(true);
  });

  it('keeps audio UI paused until AudioEngine confirms the scheduled start', () => {
    const audioEngine = { isPlaying: true, isPlaybackActive: false };
    const ui = new UIManager({ audioEngine });
    ui.elements = {};
    ui.currentTrack = { id: 'local-track', sourceType: 'direct-url' };

    ui.setPlayState(true);
    expect(ui.isPlayingState).toBe(false);

    audioEngine.isPlaybackActive = true;
    ui.setPlayState(true);
    expect(ui.isPlayingState).toBe(true);
  });

  it('clears stale playback feedback after audio becomes ready', () => {
    const ui = new UIManager({});
    const feedback = { hidden: false, style: { display: 'block' } };
    ui.elements = { roomFeedback: feedback, directUrlFeedback: feedback };

    ui.clearUrlFeedback();

    expect(feedback.hidden).toBe(true);
    expect(feedback.style.display).toBe('none');
  });

  it('keeps the active track when computing items to clear', () => {
    const queue = [{ id: 'current' }, { id: 'next-a' }, { id: 'next-b' }];

    expect(upcomingQueueItems(queue, 'current').map(item => item.id)).toEqual(['next-a', 'next-b']);
  });

  it('moves one queued track without changing the input order', () => {
    const original = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

    const moved = moveQueueItem(original, 2, 0);

    expect(moved.map(item => item.id)).toEqual(['c', 'a', 'b']);
    expect(original.map(item => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('moves a queue item by its accessible reorder action', () => {
    const ui = new UIManager({ socketClient: { roomId: null, isHost: false } });
    ui.cachedQueue = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    ui.commitQueueReorder = vi.fn();

    expect(ui.moveQueueItemById('b', -1)).toBe(true);

    expect(ui.commitQueueReorder).toHaveBeenCalledWith([{ id: 'b' }, { id: 'a' }, { id: 'c' }]);
  });

  it('does not let a guest reorder the authoritative room queue', () => {
    const ui = new UIManager({ socketClient: { roomId: 'ROOM', isHost: false } });
    ui.cachedQueue = [{ id: 'a' }, { id: 'b' }];
    ui.commitQueueReorder = vi.fn();

    expect(ui.moveQueueItemById('b', -1)).toBe(false);
    expect(ui.commitQueueReorder).not.toHaveBeenCalled();
  });

  it('binds one outside-click handler for queue menus and clears expanded state', () => {
    const expanded = [];
    const dropdown = {
      classList: { remove: vi.fn() },
      previousElementSibling: { setAttribute: (...args) => expanded.push(args) }
    };
    const documentStub = {
      addEventListener: vi.fn((name, handler) => { documentStub.handler = handler; }),
      querySelectorAll: vi.fn(() => [dropdown])
    };
    vi.stubGlobal('document', documentStub);
    const ui = new UIManager({});

    ui.bindQueueMenuDismissal();
    ui.bindQueueMenuDismissal();
    documentStub.handler();

    expect(documentStub.addEventListener).toHaveBeenCalledOnce();
    expect(dropdown.classList.remove).toHaveBeenCalledWith('active');
    expect(expanded).toEqual([['aria-expanded', 'false']]);
  });

  it('leaves queue order intact for an invalid drag destination', () => {
    const original = [{ id: 'a' }, { id: 'b' }];

    expect(moveQueueItem(original, 0, 4)).toEqual(original);
    expect(moveQueueItem(original, -1, 1)).toEqual(original);
  });

  it('plays a playlist in its saved order from the personal queue', async () => {
    const tracks = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
    const ui = new UIManager({ socketClient: { roomId: null } });
    ui.renderQueue = vi.fn();
    ui.playLibraryTrack = vi.fn().mockResolvedValue(undefined);

    await ui.playPlaylist({ id: 'playlist-1', tracks });

    expect(ui.soloQueue.map(track => track.id)).toEqual(['a', 'b']);
    expect(ui.playLibraryTrack).toHaveBeenCalledWith(tracks[0]);
  });

  it('shuffles a playlist before saving and starting its personal queue', async () => {
    const tracks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const ui = new UIManager({ socketClient: { roomId: null } });
    ui.renderQueue = vi.fn();
    ui.playLibraryTrack = vi.fn().mockResolvedValue(undefined);

    await ui.playPlaylist({ id: 'playlist-1', tracks }, { shuffle: true });

    expect(ui.soloQueue.map(track => track.id)).toEqual(['b', 'c', 'a']);
    expect(ui.playLibraryTrack).toHaveBeenCalledWith(ui.soloQueue[0]);
    random.mockRestore();
  });

  it('syncs the full online playlist before a room host starts its first track', async () => {
    const tracks = [{ id: 'yt_first', name: 'First', sourceType: 'youtube' }, { id: 'yt_second', name: 'Second', sourceType: 'youtube' }];
    const socketClient = {
      roomId: 'ROOM', isHost: true,
      cloudMesh: { lastKnownQueue: [], waitForQueueItemAcknowledgement: vi.fn().mockResolvedValue(true) },
      addToQueue: vi.fn().mockResolvedValue(true), playQueueItem: vi.fn().mockResolvedValue(tracks[0])
    };
    const ui = new UIManager({ socketClient });
    ui.getDeviceName = () => 'Host';
    ui.setView = vi.fn();

    await ui.playPlaylist({ id: 'mix', tracks });

    expect(socketClient.addToQueue.mock.calls.map(([track]) => track.id)).toEqual(['yt_first', 'yt_second']);
    expect(socketClient.cloudMesh.waitForQueueItemAcknowledgement.mock.calls.map(([id]) => id)).toEqual(['yt_first', 'yt_second']);
    expect(socketClient.playQueueItem).toHaveBeenCalledWith('yt_first', true);
  });

  it('queues a room playlist with local tracks and shares only its first track before playback', async () => {
    const tracks = [
      { id: 'local-a', name: 'Local A', sourceType: 'local-file' },
      { id: 'yt-b', name: 'Online B', sourceType: 'youtube' },
      { id: 'local-c', name: 'Local C', sourceType: 'local-file' }
    ];
    const mesh = { lastKnownQueue: [], waitForQueueItemAcknowledgement: vi.fn().mockResolvedValue(true) };
    const socketClient = {
      roomId: 'ROOM', isHost: true, cloudMesh: mesh,
      addToQueue: vi.fn().mockResolvedValue(true),
      playQueueItem: vi.fn().mockResolvedValue(tracks[0])
    };
    const ui = new UIManager({ socketClient });
    ui.getDeviceName = () => 'Host';
    ui.setView = vi.fn();
    ui.showUrlFeedback = vi.fn();
    ui.localLibrary.getLocalAudio = vi.fn().mockResolvedValue({ audioData: new ArrayBuffer(8) });
    ui.uploadLocalTrackToRoom = vi.fn().mockImplementation(async track => {
      mesh.lastKnownQueue.push(track);
      return track;
    });

    await ui.playPlaylist({ id: 'mix', tracks });

    expect(socketClient.addToQueue.mock.calls.map(([track]) => track.id)).toEqual(['local-a', 'yt-b', 'local-c']);
    expect(ui.uploadLocalTrackToRoom).toHaveBeenCalledOnce();
    expect(ui.uploadLocalTrackToRoom).toHaveBeenCalledWith(tracks[0], expect.any(ArrayBuffer));
    expect(socketClient.playQueueItem).toHaveBeenCalledWith('local-a', true);
    expect(ui.showUrlFeedback).not.toHaveBeenCalled();
  });

  it('shares the next local room track before asking the server to advance', async () => {
    const current = { id: 'online-current', sourceType: 'youtube' };
    const next = { id: 'local-next', name: 'Local next', sourceType: 'local-file' };
    const order = [];
    const room = {
      roomId: 'ROOM', isHost: true, nextTrack: vi.fn(async (automatic, preparedId) => { order.push(['next', automatic, preparedId]); }),
      cloudMesh: {
        lastKnownTrack: current,
        lastKnownQueue: [current, next],
        localAudioBufferCache: new Map(),
        previewNextTrack: vi.fn().mockResolvedValue(next)
      }
    };
    const ui = new UIManager({ socketClient: room });
    const bytes = new ArrayBuffer(8);
    ui.localLibrary.getLocalAudio = vi.fn().mockResolvedValue({ audioData: bytes });
    ui.uploadLocalTrackToRoom = vi.fn(async (track, buffer) => {
      order.push(['upload', track.id, buffer]);
      room.cloudMesh.localAudioBufferCache.set(track.id, buffer);
    });

    await ui.advanceRoomTrack({ automatic: true });

    expect(order).toEqual([['upload', 'local-next', bytes], ['next', true, 'local-next']]);
  });

  it('uses the server preview for a shuffled local track and does not skip if that file is missing', async () => {
    const picked = { id: 'server-picked-local', name: 'Picked', sourceType: 'local-file' };
    const room = {
      isHost: true,
      nextTrack: vi.fn(),
      cloudMesh: { previewNextTrack: vi.fn().mockResolvedValue(picked), localAudioBufferCache: new Map() }
    };
    const ui = new UIManager({ socketClient: room });
    ui.showUrlFeedback = vi.fn();
    ui.localLibrary.getLocalAudio = vi.fn().mockResolvedValue(null);

    await ui.advanceRoomTrack({ automatic: true });

    expect(room.cloudMesh.previewNextTrack).toHaveBeenCalledWith(true);
    expect(room.nextTrack).not.toHaveBeenCalled();
    expect(ui.showUrlFeedback).toHaveBeenCalledWith(expect.stringContaining('tidak tersedia'), 'error');
  });

  it('keeps solo YouTube selections in the local queue without creating a room', async () => {
    const mesh = { lastKnownTrack: null, loadTrackBuffer: vi.fn() };
    const socketClient = { roomId: null, cloudMesh: mesh };
    const ui = new UIManager({ socketClient, audioEngine: { ensureContext: vi.fn(), stopLocalPlayback: vi.fn() } });
    ui.renderQueue = vi.fn();

    await ui.streamAudioFromUrl('https://youtu.be/dQw4w9WgXcQ', 'Song', 'Artist', 180, 'https://img.test/song.jpg');

    expect(socketClient.roomId).toBeNull();
    expect(mesh.loadTrackBuffer).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'dQw4w9WgXcQ' }));
    expect(ui.soloQueue).toHaveLength(1);
    expect(ui.soloQueue[0]).toMatchObject({ id: 'yt_dQw4w9WgXcQ', sourceType: 'youtube' });
    expect(ui.renderQueue).toHaveBeenCalledWith(ui.soloQueue);
  });

  it('shows saved audio files separately from playback history', async () => {
    const localFile = { id: 'file-1', name: 'On device', sourceType: 'local-file' };
    const recent = { id: 'recent-1', name: 'Recent song' };
    const ui = new UIManager({});
    ui.elements = { favoriteList: {}, localAudioList: {}, recentList: {} };
    ui.localLibrary.getPlaylists = vi.fn().mockResolvedValue([]);
    ui.localLibrary.getFavorites = vi.fn().mockResolvedValue([]);
    ui.localLibrary.getRecentHistory = vi.fn().mockResolvedValue([recent]);
    ui.localLibrary.getLocalAudioTracks = vi.fn().mockResolvedValue([localFile]);
    ui.renderPlaylists = vi.fn();
    ui.renderLibraryTracks = vi.fn();

    await ui.refreshLibrary();

    expect(ui.renderLibraryTracks).toHaveBeenCalledWith(ui.elements.localAudioList, [localFile], expect.any(String), null, true);
    expect(ui.renderLibraryTracks).toHaveBeenCalledWith(ui.elements.recentList, [recent], expect.any(String));
  });

  it('requests host playback without starting a second local player or waiting for room queue sync', async () => {
    let acknowledgeQueue;
    const acknowledgement = new Promise(resolve => { acknowledgeQueue = resolve; });
    const itemPromise = Promise.resolve(true);
    const player = { setVolume: vi.fn(), playAt: vi.fn().mockResolvedValue(undefined) };
    const socketClient = {
      roomId: 'ROOM', isHost: true,
      cloudMesh: { lastKnownTrack: null, loadTrackBuffer: vi.fn(), waitForQueueItemAcknowledgement: vi.fn(() => acknowledgement) },
      addToQueue: vi.fn(() => itemPromise),
      playQueueItem: vi.fn()
    };
    const audioEngine = { ensureContext: vi.fn() };
    const ui = new UIManager({ socketClient, audioEngine, youtubePlayer: player });
    ui.updateTrackUI = vi.fn();
    ui.setPlayState = vi.fn();

    const item = await ui.streamAudioFromUrl('https://youtu.be/dQw4w9WgXcQ', 'Song', 'Artist', 180);

    expect(audioEngine.ensureContext).not.toHaveBeenCalled();
    expect(socketClient.addToQueue).toHaveBeenCalledOnce();
    expect(socketClient.playQueueItem).not.toHaveBeenCalled();
    expect(player.playAt).not.toHaveBeenCalled();
    expect(item.id).toBe('yt_dQw4w9WgXcQ');
    await Promise.resolve();
    expect(socketClient.cloudMesh.waitForQueueItemAcknowledgement).toHaveBeenCalledWith(item.id);
    expect(socketClient.playQueueItem).not.toHaveBeenCalled();
    acknowledgeQueue(true);
    await acknowledgement;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(socketClient.playQueueItem).toHaveBeenCalledWith(item.id, true);
  });

  it('lets guests request YouTube room playback without starting the host-only player locally', async () => {
    const player = { setVolume: vi.fn(), playAt: vi.fn() };
    const socketClient = {
      roomId: 'ROOM', isHost: false,
      cloudMesh: { lastKnownTrack: null, waitForQueueItemAcknowledgement: vi.fn().mockResolvedValue(true) },
      addToQueue: vi.fn().mockResolvedValue(true),
      requestControl: vi.fn()
    };
    const ui = new UIManager({ socketClient, audioEngine: { volume: 0.5 }, youtubePlayer: player });
    ui.updateTrackUI = vi.fn();
    ui.setPlayState = vi.fn();

    await ui.streamAudioFromUrl('https://youtu.be/dQw4w9WgXcQ', 'Song');

    expect(socketClient.requestControl).not.toHaveBeenCalled();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(socketClient.requestControl).toHaveBeenCalledWith('play_queue_item', {
      queueId: 'yt_dQw4w9WgXcQ', name: 'Song'
    });
    expect(player.playAt).not.toHaveBeenCalled();
  });

  it('plays an existing YouTube queue item without inserting it or waiting for a new acknowledgement', async () => {
    const item = { id: 'yt_dQw4w9WgXcQ', name: 'Song', sourceType: 'youtube' };
    const socketClient = {
      roomId: 'ROOM', isHost: true,
      cloudMesh: { lastKnownQueue: [item], lastKnownTrack: null },
      addToQueue: vi.fn(), playQueueItem: vi.fn()
    };
    const ui = new UIManager({ socketClient, audioEngine: {}, youtubePlayer: {} });
    ui.updateTrackUI = vi.fn();
    ui.setYouTubePlayerVisible = vi.fn();
    ui.setYouTubePlayerStatus = vi.fn();
    ui.showUrlFeedback = vi.fn();

    await ui.streamAudioFromUrl('https://youtu.be/dQw4w9WgXcQ', 'Song');
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(socketClient.addToQueue).not.toHaveBeenCalled();
    expect(socketClient.playQueueItem).toHaveBeenCalledWith(item.id, true);
  });

  it('shows a retryable message when the host cannot select the acknowledged YouTube item', async () => {
    const socketClient = {
      roomId: 'ROOM', isHost: true,
      cloudMesh: { lastKnownQueue: [], waitForQueueItemAcknowledgement: vi.fn().mockResolvedValue(true) },
      addToQueue: vi.fn().mockResolvedValue(true),
      playQueueItem: vi.fn().mockResolvedValue(false)
    };
    const ui = new UIManager({ socketClient, audioEngine: {}, youtubePlayer: {} });
    ui.updateTrackUI = vi.fn();
    ui.setYouTubePlayerVisible = vi.fn();
    ui.setYouTubePlayerStatus = vi.fn();
    ui.showUrlFeedback = vi.fn();

    await ui.streamAudioFromUrl('https://youtu.be/dQw4w9WgXcQ', 'Song');
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(ui.showUrlFeedback).toHaveBeenCalledWith('Room gagal memilih lagu. Refresh antrean lalu coba lagi.', 'error');
  });

  it('requests solo YouTube playback without reporting Playing before the player confirms it', async () => {
    const mesh = { lastKnownTrack: null, loadTrackBuffer: vi.fn() };
    const player = { setVolume: vi.fn(), playAt: vi.fn().mockResolvedValue(undefined) };
    const socketClient = { roomId: null, cloudMesh: mesh };
    const audioEngine = { ensureContext: vi.fn().mockResolvedValue(undefined), volume: 0.4, stopLocalPlayback: vi.fn() };
    const ui = new UIManager({ socketClient, audioEngine, youtubePlayer: player });
    ui.updateTrackUI = vi.fn();
    ui.renderQueue = vi.fn();
    ui.setView = vi.fn();

    await ui.playLibraryTrack({ id: 'yt_dQw4w9WgXcQ', sourceType: 'youtube', sourceId: 'dQw4w9WgXcQ', name: 'Song' });

    expect(player.setVolume).toHaveBeenCalledWith(0.4);
    expect(player.playAt).toHaveBeenCalledWith('dQw4w9WgXcQ', expect.any(Number), 0);
    expect(ui.isPlayingState).toBe(false);
  });

  it('routes a YouTube Library selection through room queue sync when already in a room', async () => {
    const track = { id: 'yt_dQw4w9WgXcQ', sourceType: 'youtube', sourceId: 'dQw4w9WgXcQ', sourceUrl: 'https://youtu.be/dQw4w9WgXcQ', name: 'Song' };
    const socketClient = {
      roomId: 'ROOM', isHost: false,
      cloudMesh: { lastKnownQueue: [], waitForQueueItemAcknowledgement: vi.fn().mockResolvedValue(true) },
      addToQueue: vi.fn().mockResolvedValue(true), requestControl: vi.fn()
    };
    const player = { setVolume: vi.fn(), playAt: vi.fn() };
    const audioEngine = { ensureContext: vi.fn(), volume: 0.5 };
    const ui = new UIManager({ socketClient, audioEngine, youtubePlayer: player });
    ui.updateTrackUI = vi.fn();
    ui.setYouTubePlayerVisible = vi.fn();
    ui.setYouTubePlayerStatus = vi.fn();
    ui.setView = vi.fn();

    await ui.playLibraryTrack(track);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(audioEngine.ensureContext).not.toHaveBeenCalled();
    expect(socketClient.addToQueue).toHaveBeenCalledOnce();
    expect(socketClient.requestControl).toHaveBeenCalledWith('play_queue_item', { queueId: track.id, name: track.name });
    expect(player.playAt).not.toHaveBeenCalled();
  });

  it('plays a stored local file solo without creating a room', async () => {
    const track = { id: 'local-1', name: 'Local song', sourceType: 'local-file', duration: 12 };
    const bytes = new ArrayBuffer(16);
    const socketClient = { roomId: null, cloudMesh: { lastKnownTrack: { id: 'stale-room-track', name: 'Old room track' } }, clockSync: { getServerTime: () => 1000 } };
    const audioEngine = {
      ensureContext: vi.fn().mockResolvedValue(undefined),
      loadAudioFromArrayBuffer: vi.fn().mockResolvedValue({ duration: 12 }),
      schedulePlayAtServerTime: vi.fn()
    };
    const ui = new UIManager({ socketClient, audioEngine });
    ui.localLibrary.getLocalAudio = vi.fn().mockResolvedValue({ ...track, audioData: bytes });
    ui.addToSoloQueue = vi.fn();
    ui.updateTrackUI = vi.fn();
    ui.setPlayState = vi.fn();
    ui.setView = vi.fn();

    await ui.playLibraryTrack(track);

    expect(socketClient.roomId).toBeNull();
    expect(socketClient.cloudMesh.lastKnownTrack).toEqual(track);
    expect(ui.localLibrary.getLocalAudio).toHaveBeenCalledWith(track.id);
    expect(audioEngine.loadAudioFromArrayBuffer).toHaveBeenCalledWith(bytes, track.name, track.id);
    expect(audioEngine.schedulePlayAtServerTime).toHaveBeenCalledWith(1050, 0);
    expect(ui.setPlayState).toHaveBeenCalledWith(true);
  });

  it('uploads and selects a local Library file when the room host chooses it', async () => {
    const track = { id: 'local-room-track', name: 'Local room track', sourceType: 'local-file' };
    const bytes = new ArrayBuffer(8);
    const socketClient = { roomId: 'ROOM', isHost: true, playQueueItem: vi.fn().mockResolvedValue(track) };
    const ui = new UIManager({ socketClient, audioEngine: { ensureContext: vi.fn().mockResolvedValue(undefined) } });
    ui.localLibrary.getLocalAudio = vi.fn().mockResolvedValue({ ...track, audioData: bytes });
    ui.uploadLocalTrackToRoom = vi.fn().mockResolvedValue(track);
    ui.setView = vi.fn();

    await ui.playLibraryTrack(track);

    expect(ui.uploadLocalTrackToRoom).toHaveBeenCalledWith(track, bytes);
    expect(socketClient.playQueueItem).toHaveBeenCalledWith(track.id, true);
  });

  it('explains why a guest cannot share a device local Library file to the room', async () => {
    const track = { id: 'local-room-track', name: 'Local room track', sourceType: 'local-file' };
    const socketClient = { roomId: 'ROOM', isHost: false };
    const ui = new UIManager({ socketClient, audioEngine: { ensureContext: vi.fn().mockResolvedValue(undefined) } });
    ui.showUrlFeedback = vi.fn();

    await ui.playLibraryTrack(track);

    expect(ui.showUrlFeedback).toHaveBeenCalledWith('File lokal hanya bisa dibagikan dari perangkat host.', 'error');
  });

  it('plays a direct audio library track solo without creating a room', async () => {
    const track = { id: 'direct-1', name: 'Direct song', sourceType: 'direct-url', audioUrl: '/api/stream?id=direct-1', duration: 15 };
    const socketClient = { roomId: null, cloudMesh: { lastKnownTrack: null }, clockSync: { getServerTime: () => 1000 } };
    const audioEngine = {
      ensureContext: vi.fn().mockResolvedValue(undefined),
      loadAudioFromUrl: vi.fn().mockResolvedValue({ duration: 15 }),
      schedulePlayAtServerTime: vi.fn()
    };
    const ui = new UIManager({ socketClient, audioEngine });
    ui.updateTrackUI = vi.fn();
    ui.setPlayState = vi.fn();
    ui.setView = vi.fn();
    ui.setTrackLoading = vi.fn();
    ui.clearTrackLoading = vi.fn();

    await ui.playLibraryTrack(track);

    expect(socketClient.roomId).toBeNull();
    expect(socketClient.cloudMesh.lastKnownTrack).toEqual(track);
    expect(audioEngine.loadAudioFromUrl).toHaveBeenCalledWith(track.audioUrl, track.name);
    expect(audioEngine.schedulePlayAtServerTime).toHaveBeenCalledWith(1050, 0);
    expect(ui.soloQueue).toContainEqual(track);
    expect(ui.setPlayState).toHaveBeenCalledWith(true);
  });

  it('selects a direct audio Library track through acknowledged room queue insertion', async () => {
    const track = { id: 'direct-room-1', name: 'Room song', sourceType: 'direct-url', audioUrl: '/audio/room.mp3' };
    const socketClient = {
      roomId: 'ROOM', isHost: true,
      cloudMesh: { lastKnownQueue: [], lastKnownTrack: null, waitForQueueItemAcknowledgement: vi.fn().mockResolvedValue(true) },
      addToQueue: vi.fn().mockResolvedValue(true), playQueueItem: vi.fn().mockResolvedValue(track)
    };
    const ui = new UIManager({ socketClient, audioEngine: { ensureContext: vi.fn().mockResolvedValue(undefined) } });
    ui.updateTrackUI = vi.fn();
    ui.setTrackLoading = vi.fn();
    ui.showUrlFeedback = vi.fn();
    ui.setView = vi.fn();
    ui.getDeviceName = () => 'Listener';

    await ui.playLibraryTrack(track);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(socketClient.addToQueue).toHaveBeenCalledOnce();
    expect(socketClient.cloudMesh.waitForQueueItemAcknowledgement).toHaveBeenCalledWith(track.id);
    expect(socketClient.playQueueItem).toHaveBeenCalledWith(track.id, true);
  });

  it('loads a newly selected direct URL in solo mode even when another buffer is already loaded', async () => {
    const track = { id: 'direct-2', name: 'Second URL', sourceType: 'direct-url', audioUrl: '/audio/second.mp3' };
    const socketClient = { roomId: null, cloudMesh: { lastKnownTrack: null }, clockSync: { getServerTime: () => 2000 } };
    const audioEngine = {
      audioBuffer: { duration: 30 },
      loadAudioFromUrl: vi.fn().mockResolvedValue({ duration: 12 }),
      schedulePlayAtServerTime: vi.fn()
    };
    const ui = new UIManager({ socketClient, audioEngine });
    ui.updateTrackUI = vi.fn();
    ui.setTrackLoading = vi.fn();
    ui.clearTrackLoading = vi.fn();
    ui.setPlayState = vi.fn();
    ui.setView = vi.fn();

    await ui.playResolvedAudio(track);

    expect(socketClient.roomId).toBeNull();
    expect(audioEngine.loadAudioFromUrl).toHaveBeenCalledWith(track.audioUrl, track.name);
    expect(audioEngine.schedulePlayAtServerTime).toHaveBeenCalledWith(2050, 0);
    expect(ui.currentTrack).toBe(track);
  });

  it('accepts local-file queue entries without a remote URL for solo playback', async () => {
    const track = { id: 'local-queue-track', name: 'Local queue track', sourceType: 'local-file' };
    const socketClient = { roomId: null, cloudMesh: {}, clockSync: { getServerTime: () => 1000 } };
    const audioEngine = {
      ensureContext: vi.fn().mockResolvedValue(undefined),
      loadAudioFromArrayBuffer: vi.fn().mockResolvedValue({ duration: 8 }),
      schedulePlayAtServerTime: vi.fn()
    };
    const ui = new UIManager({ socketClient, audioEngine });
    ui.localLibrary.getLocalAudio = vi.fn().mockResolvedValue({ audioData: new ArrayBuffer(4) });
    ui.addToSoloQueue = vi.fn();
    ui.updateTrackUI = vi.fn();
    ui.setPlayState = vi.fn();
    ui.setView = vi.fn();

    await ui.playLibraryTrack(track);

    expect(ui.localLibrary.getLocalAudio).toHaveBeenCalledWith(track.id);
    expect(audioEngine.loadAudioFromArrayBuffer).toHaveBeenCalled();
  });

  it('uses one P2P transfer for local room audio when a peer channel is ready', async () => {
    const bytes = new ArrayBuffer(8);
    const mesh = {
      isHost: true,
      hostToken: 'host-token',
      dataChannels: new Map([['peer', { readyState: 'open' }]]),
      localAudioBufferCache: new Map(),
      waitForQueueItemAcknowledgement: vi.fn().mockResolvedValue(true),
      streamAudioToRoom: vi.fn().mockResolvedValue({ sent: 1, total: 1 }),
      lastKnownTrack: null
    };
    const socketClient = { roomId: 'ROOM', peerId: 'host-peer', cloudMesh: mesh, addToQueue: vi.fn().mockResolvedValue(true) };
    const ui = new UIManager({ socketClient });

    await ui.uploadLocalTrackToRoom({ id: 'local-2', name: 'Local song', duration: 3 }, bytes);

    expect(socketClient.addToQueue).toHaveBeenCalledWith(expect.objectContaining({ id: 'local-2', sourceType: 'local-file' }));
    expect(mesh.streamAudioToRoom).toHaveBeenCalledTimes(1);
    expect(mesh.waitForQueueItemAcknowledgement).toHaveBeenCalledWith('local-2');
  });

  it('uses the room relay when no P2P peer is available', async () => {
    const mesh = {
      isHost: true,
      hostToken: 'host-token',
      roomId: 'ROOM',
      peerId: 'host-peer',
      queueRevision: 2,
      dataChannels: new Map(),
      localAudioBufferCache: new Map(),
      waitForQueueItemAcknowledgement: vi.fn().mockResolvedValue(true),
      rememberQueueRevision: vi.fn(),
      applyCanonicalQueue: vi.fn(),
      loadTrackBuffer: vi.fn(),
      lastKnownTrack: null
    };
    const socketClient = { roomId: 'ROOM', cloudMesh: mesh, addToQueue: vi.fn().mockResolvedValue(true) };
    const ui = new UIManager({ socketClient });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, item: { id: 'local-3', audioUrl: '/api/room?action=get_audio' }, queue: [{ id: 'local-3' }], queueRevision: 3 })
    }));

    await ui.uploadLocalTrackToRoom({ id: 'local-3', name: 'Local song', duration: 3 }, new ArrayBuffer(8));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ roomId: 'ROOM', peerId: 'host-peer', hostToken: 'host-token', id: 'local-3' });
    expect(mesh.loadTrackBuffer).toHaveBeenCalled();
  });

  it('reuses an already acknowledged local room queue item without adding it again', async () => {
    const mesh = {
      isHost: true,
      hostToken: 'host-token',
      dataChannels: new Map([['peer', { readyState: 'open' }]]),
      localAudioBufferCache: new Map(),
      lastKnownQueue: [{ id: 'local-4', name: 'Local song', sourceType: 'local-file' }],
      waitForQueueItemAcknowledgement: vi.fn(),
      streamAudioToRoom: vi.fn().mockResolvedValue({ sent: 1, total: 1 }),
      lastKnownTrack: null
    };
    const socketClient = { roomId: 'ROOM', cloudMesh: mesh, addToQueue: vi.fn() };
    const ui = new UIManager({ socketClient });

    await ui.uploadLocalTrackToRoom({ id: 'local-4', name: 'Local song', duration: 3 }, new ArrayBuffer(8));

    expect(socketClient.addToQueue).not.toHaveBeenCalled();
    expect(mesh.waitForQueueItemAcknowledgement).not.toHaveBeenCalled();
    expect(mesh.streamAudioToRoom).toHaveBeenCalledTimes(1);
  });

  it('pauses a solo local track locally instead of sending a room control request', () => {
    const track = { id: 'local-pause', sourceType: 'local-file' };
    const socketClient = { roomId: null, isHost: false, requestControl: vi.fn() };
    const audioEngine = {
      ensureContext: vi.fn(),
      getCurrentPlaybackPosition: vi.fn().mockReturnValue(7.5),
      stopLocalPlayback: vi.fn(),
      pauseOffsetSec: 0
    };
    const ui = new UIManager({ socketClient, audioEngine });
    ui.currentTrack = track;
    ui.isPlayingState = true;
    ui.setPlayState = vi.fn();

    ui.togglePlayback();

    expect(audioEngine.stopLocalPlayback).toHaveBeenCalled();
    expect(audioEngine.pauseOffsetSec).toBe(7.5);
    expect(socketClient.requestControl).not.toHaveBeenCalled();
    expect(ui.setPlayState).toHaveBeenCalledWith(false);
  });

  it('changes solo repeat and shuffle locally without a room request', () => {
    const socketClient = { roomId: null, isHost: false, requestControl: vi.fn() };
    const ui = new UIManager({ socketClient });
    ui.setPlaybackOptions = vi.fn();

    ui.requestPlaybackOptions({ shuffle: true, repeatMode: 'all' });

    expect(ui.setPlaybackOptions).toHaveBeenCalledWith({ shuffle: true, repeatMode: 'all' });
    expect(socketClient.requestControl).not.toHaveBeenCalled();
  });

  it('resumes a paused solo local track at its saved position', () => {
    const socketClient = { roomId: null, isHost: false, clockSync: { getServerTime: () => 2000 }, requestControl: vi.fn() };
    const audioEngine = {
      ensureContext: vi.fn(),
      audioBuffer: {},
      pauseOffsetSec: 7.5,
      schedulePlayAtServerTime: vi.fn()
    };
    const ui = new UIManager({ socketClient, audioEngine });
    ui.currentTrack = { id: 'local-resume', sourceType: 'local-file' };
    ui.setPlayState = vi.fn();

    ui.togglePlayback();

    expect(audioEngine.schedulePlayAtServerTime).toHaveBeenCalledWith(2050, 7.5);
    expect(socketClient.requestControl).not.toHaveBeenCalled();
    expect(ui.setPlayState).toHaveBeenCalledWith(true);
  });

  it('seeks a playing solo local track by rescheduling locally', () => {
    const socketClient = { roomId: null, clockSync: { getServerTime: () => 3000 }, requestControl: vi.fn() };
    const audioEngine = { currentTrackDuration: 120, pauseOffsetSec: 0, schedulePlayAtServerTime: vi.fn() };
    const ui = new UIManager({ socketClient, audioEngine });
    ui.currentTrack = { id: 'local-seek', sourceType: 'local-file' };
    ui.isPlayingState = true;

    ui.seekPlaybackTo(42);

    expect(audioEngine.pauseOffsetSec).toBe(42);
    expect(audioEngine.schedulePlayAtServerTime).toHaveBeenCalledWith(3050, 42);
    expect(socketClient.requestControl).not.toHaveBeenCalled();
  });

  it('reorders a solo queue locally without calling room APIs', () => {
    const storage = { setItem: vi.fn() };
    vi.stubGlobal('localStorage', storage);
    const socketClient = { roomId: null, isHost: false, reorderQueue: vi.fn() };
    const ui = new UIManager({ socketClient });
    ui.renderQueue = vi.fn();
    const reordered = [{ id: 'b' }, { id: 'a' }];

    ui.commitQueueReorder(reordered);

    expect(ui.soloQueue).toEqual(reordered);
    expect(storage.setItem).toHaveBeenCalledWith('rync_solo_queue', JSON.stringify(reordered));
    expect(socketClient.reorderQueue).not.toHaveBeenCalled();
  });

  it('clears and restores upcoming solo tracks in their original order', async () => {
    const values = {};
    vi.stubGlobal('localStorage', { setItem: (key, value) => { values[key] = value; } });
    const current = { id: 'current', name: 'Current' };
    const first = { id: 'first', name: 'First' };
    const last = { id: 'last', name: 'Last' };
    const socketClient = { roomId: null, isHost: false, cloudMesh: {} };
    const ui = new UIManager({ socketClient });
    ui.currentTrack = current;
    ui.soloQueue = [first, current, last];
    ui.cachedQueue = [...ui.soloQueue];
    ui.elements.queueUndoBar = { hidden: true };
    ui.renderQueue = queue => { ui.cachedQueue = queue; };

    await ui.clearUpcomingQueue();

    expect(ui.soloQueue).toEqual([current]);
    expect(ui.pendingQueueUndo).toEqual([{ item: first, index: 0 }, { item: last, index: 2 }]);
    await ui.restoreQueueUndo();
    clearTimeout(ui.pendingQueueUndoTimer);

    expect(ui.soloQueue).toEqual([first, current, last]);
    expect(JSON.parse(values.rync_solo_queue)).toEqual([first, current, last]);
    expect(socketClient.clearQueue).toBeUndefined();
  });

  it('waits for room track selection before scheduling an already playing solo track', async () => {
    const track = { id: 'yt_dQw4w9WgXcQ', name: 'Song', sourceType: 'youtube', sourceId: 'dQw4w9WgXcQ' };
    const selected = vi.fn().mockResolvedValue(track);
    const schedulePlay = vi.fn();
    const room = { roomId: 'ROOM', isHost: true, cloudMesh: { lastKnownTrack: track }, addToQueue: vi.fn().mockResolvedValue(true), playQueueItem: selected, schedulePlay };
    const ui = new UIManager({ socketClient: room, youtubePlayer: { getCurrentTime: () => 12 } });
    ui.currentTrack = track;
    ui.isPlayingState = true;

    await ui.seedCurrentTrackIntoRoom();

    expect(selected).toHaveBeenCalledWith(track.id, false);
    expect(schedulePlay).toHaveBeenCalledWith(800, expect.any(Number));
    expect(schedulePlay.mock.calls[0][1]).toBeGreaterThanOrEqual(12);
  });

  it('preserves active playback when room selection pauses the solo player', async () => {
    const track = { id: 'direct-current', name: 'Direct song', sourceType: 'direct-url', audioUrl: '/audio/current.mp3' };
    const schedulePlay = vi.fn();
    const room = {
      roomId: 'ROOM', isHost: true,
      cloudMesh: { lastKnownTrack: track },
      addToQueue: vi.fn().mockResolvedValue(true),
      playQueueItem: vi.fn().mockImplementation(async () => {
        ui.setPlayState(false);
        return true;
      }),
      schedulePlay
    };
    const ui = new UIManager({ socketClient: room, audioEngine: { getCurrentPlaybackPosition: () => 9 } });
    ui.currentTrack = track;
    ui.isPlayingState = true;

    await ui.seedCurrentTrackIntoRoom();

    expect(room.playQueueItem).toHaveBeenCalledWith(track.id, false);
    expect(schedulePlay).toHaveBeenCalledWith(800, expect.any(Number));
    expect(schedulePlay.mock.calls[0][1]).toBeGreaterThanOrEqual(9);
  });

  it('keeps a true zero start offset instead of reusing a stale pause offset', async () => {
    const track = { id: 'direct-start', name: 'Direct song', sourceType: 'direct-url', audioUrl: '/audio/current.mp3' };
    const schedulePlay = vi.fn();
    const socketClient = {
      roomId: 'ROOM', isHost: true,
      cloudMesh: { lastKnownTrack: track },
      addToQueue: vi.fn().mockResolvedValue(true),
      playQueueItem: vi.fn().mockResolvedValue(true),
      schedulePlay
    };
    const ui = new UIManager({
      socketClient,
      audioEngine: { getCurrentPlaybackPosition: () => 0, pauseOffsetSec: 42 }
    });
    ui.currentTrack = track;
    ui.isPlayingState = true;

    await ui.seedCurrentTrackIntoRoom();

    expect(schedulePlay).toHaveBeenCalledWith(800, expect.any(Number));
    expect(schedulePlay.mock.calls[0][1]).toBeLessThan(1);
  });

  it('copies the full solo queue in order when a room is created', async () => {
    const current = { id: 'current', name: 'Current' };
    const first = { id: 'first', name: 'First' };
    const last = { id: 'last', name: 'Last' };
    const room = { addToQueue: vi.fn().mockResolvedValue(true) };
    const ui = new UIManager({ socketClient: room });
    ui.currentTrack = current;
    ui.soloQueue = [first, current, last];

    await ui.syncLocalQueueToRoom();

    expect(room.addToQueue.mock.calls.map(([track]) => track.id)).toEqual(['first', 'current', 'last']);
  });

  it('batches consecutive non-local tracks around local audio uploads', async () => {
    const first = { id: 'first', name: 'First' };
    const local = { id: 'local', name: 'Local', sourceType: 'local-file' };
    const last = { id: 'last', name: 'Last' };
    const order = [];
    const room = {
      cloudMesh: { lastKnownQueue: [], addQueueItems: vi.fn(async items => { order.push(['batch', items.map(item => item.id)]); return true; }) }
    };
    const ui = new UIManager({ socketClient: room });
    ui.soloQueue = [first, local, last];
    ui.localLibrary.getLocalAudio = vi.fn().mockResolvedValue({ audioData: new ArrayBuffer(8) });
    ui.uploadLocalTrackToRoom = vi.fn(async item => { order.push(['upload', item.id]); });

    await ui.syncLocalQueueToRoom();

    expect(order).toEqual([['batch', ['first']], ['upload', 'local'], ['batch', ['last']]]);
    expect(room.cloudMesh.addQueueItems).toHaveBeenCalledTimes(2);
  });

  it('puts an active track first when it was played outside the saved queue', async () => {
    const current = { id: 'current', name: 'Current' };
    const room = { addToQueue: vi.fn().mockResolvedValue(true) };
    const ui = new UIManager({ socketClient: room });
    ui.currentTrack = current;
    ui.soloQueue = [{ id: 'next', name: 'Next' }];

    await ui.syncLocalQueueToRoom();

    expect(room.addToQueue.mock.calls.map(([track]) => track.id)).toEqual(['current', 'next']);
  });

  it('does not schedule room playback when the server rejects track selection', async () => {
    const track = { id: 'yt_dQw4w9WgXcQ', name: 'Song', sourceType: 'youtube', sourceId: 'dQw4w9WgXcQ' };
    const schedulePlay = vi.fn();
    const room = { roomId: 'ROOM', isHost: true, cloudMesh: { lastKnownTrack: track }, addToQueue: vi.fn().mockResolvedValue(true), playQueueItem: vi.fn().mockResolvedValue(false), schedulePlay };
    const ui = new UIManager({ socketClient: room, youtubePlayer: { getCurrentTime: () => 12 } });
    ui.currentTrack = track;
    ui.isPlayingState = true;

    await ui.seedCurrentTrackIntoRoom();

    expect(schedulePlay).not.toHaveBeenCalled();
  });

  it('adds a solo search result only once when the same song is queued twice', async () => {
    const mesh = { lastKnownTrack: null, loadTrackBuffer: vi.fn() };
    const ui = new UIManager({ socketClient: { roomId: null, cloudMesh: mesh }, audioEngine: { ensureContext: vi.fn(), stopLocalPlayback: vi.fn() } });
    ui.renderQueue = vi.fn();
    const url = 'https://youtu.be/dQw4w9WgXcQ';

    await ui.addYoutubeTrackToQueue(url, 'Song');
    await ui.addYoutubeTrackToQueue(url, 'Song');

    expect(ui.soloQueue).toHaveLength(1);
  });

  it('counts only explicitly ready room peers as ready', () => {
    const makeNode = () => ({ innerText: '', className: '' });
    const makeElement = () => ({ children: [], className: '', style: {}, dataset: {}, innerHTML: '', appendChild(child) { this.children.push(child); }, addEventListener() {}, querySelector() { return { addEventListener() {} }; } });
    vi.stubGlobal('document', { createElement: makeElement });
    const ui = new UIManager({ socketClient: { peerId: 'host', isHost: false } });
    ui.elements = {
      devicesList: null,
      activeSpeakerCount: makeNode(),
      roomReadinessIndicator: makeNode(),
      roomReadinessText: makeNode(),
      peerLoadingNotice: null,
      devicesMatrixList: null
    };

    ui.renderPeerList([
      { id: 'host', readiness: 'READY' },
      { id: 'guest', readiness: 'PREPARING' },
      { id: 'new', readiness: undefined }
    ]);

    expect(ui.elements.roomReadinessText.innerText).toBe('1/3 Siap');
    expect(ui.elements.roomReadinessIndicator.className).toBe('readiness-indicator buffering');
  });

  it('renders untrusted room device names and roles as text in both device views', () => {
    const makeElement = () => ({
      children: [], className: '', style: {}, dataset: '', innerHTML: '',
      appendChild(child) { this.children.push(child); },
      addEventListener() {},
      querySelector() { return { addEventListener() {} }; }
    });
    vi.stubGlobal('document', { createElement: makeElement });
    const ui = new UIManager({ socketClient: { peerId: 'host', isHost: false } });
    const devicesList = makeElement();
    const devicesMatrixList = makeElement();
    ui.elements = {
      devicesList,
      devicesMatrixList,
      activeSpeakerCount: null,
      roomReadinessIndicator: null,
      roomReadinessText: null,
      peerLoadingNotice: null
    };

    ui.renderPeerList([
      { id: 'guest', deviceName: '<img src=x onerror=alert(1)>', role: '<svg onload=alert(2)>' },
      { id: 'malformed', deviceName: {}, role: { toUpperCase: 'not a function' } }
    ]);

    for (const list of [devicesList, devicesMatrixList]) {
      expect(list.children[0].innerHTML).not.toContain('<img src=x');
      expect(list.children[0].innerHTML).not.toContain('<svg onload=');
      expect(list.children[0].innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(list.children[0].innerHTML).toContain('&lt;SVG ONLOAD=ALERT(2)&gt;');
      expect(list.children[1].innerHTML).toContain('[object Object]');
      expect(list.children[1].innerHTML).toContain('STEREO');
    }
  });

  it('shows the observed audio route beside a room peer readiness state', () => {
    const makeElement = () => ({
      children: [], className: '', style: {}, dataset: {}, innerHTML: '',
      appendChild(child) { this.children.push(child); },
      addEventListener() {},
      querySelector() { return { addEventListener() {} }; }
    });
    vi.stubGlobal('document', { createElement: makeElement });
    const ui = new UIManager({ socketClient: { peerId: 'host', isHost: false } });
    const devicesList = makeElement();
    ui.elements = {
      devicesList, devicesMatrixList: null,
      activeSpeakerCount: null, roomReadinessIndicator: null,
      roomReadinessText: null, peerLoadingNotice: null
    };

    ui.renderPeerList([{ id: 'guest', readiness: 'READY', audioRoute: 'p2p' }]);

    expect(devicesList.children[0].innerHTML).toContain('P2P');
  });

  it('does not show an audio route as searching after an idle peer is ready', () => {
    const makeElement = () => ({
      children: [], className: '', style: {}, dataset: {}, innerHTML: '',
      appendChild(child) { this.children.push(child); },
      addEventListener() {},
      querySelector() { return { addEventListener() {} }; }
    });
    vi.stubGlobal('document', { createElement: makeElement });
    const ui = new UIManager({ socketClient: { peerId: 'host', isHost: false } });
    const devicesList = makeElement();
    ui.elements = {
      devicesList, devicesMatrixList: null,
      activeSpeakerCount: null, roomReadinessIndicator: null,
      roomReadinessText: null, peerLoadingNotice: null
    };

    ui.renderPeerList([{ id: 'guest', readiness: 'READY', audioRoute: 'unknown' }]);

    expect(devicesList.children[0].innerHTML).toContain('Belum ada audio');
    expect(devicesList.children[0].innerHTML).not.toContain('Mencari jalur audio');
  });

  it('loads an empty solo queue when browser storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    const ui = new UIManager({});

    expect(ui.soloQueue).toEqual([]);
  });

  it('serves repeated search results from the short local cache and can force refresh', async () => {
    const ui = new UIManager({ socketClient: { createRoom: vi.fn(), joinRoom: vi.fn() } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [{ id: 'dQw4w9WgXcQ' }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [{ id: 'M7lc1UVf-VE' }] }) });
    vi.stubGlobal('fetch', fetchMock);

    expect((await ui.fetchYoutubeSearch('Ambient')).map(item => item.id)).toEqual(['yt_dQw4w9WgXcQ']);
    expect((await ui.fetchYoutubeSearch(' ambient ')).map(item => item.id)).toEqual(['yt_dQw4w9WgXcQ']);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(ui.lastYoutubeSearchCacheState).toBe('fresh');
    expect((await ui.fetchYoutubeSearch('Ambient', undefined, { refresh: true })).map(item => item.id)).toEqual(['yt_M7lc1UVf-VE']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns stale search results when refresh fails', async () => {
    vi.useFakeTimers();
    const ui = new UIManager({});
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [{ id: 'dQw4w9WgXcQ' }] }) })
      .mockRejectedValueOnce(new TypeError('offline')));
    await ui.fetchYoutubeSearch('Ambient');
    vi.advanceTimersByTime(60_001);

    await expect(ui.fetchYoutubeSearch('Ambient', undefined, { refresh: true }))
      .rejects.toMatchObject({ staleResults: [{ id: 'yt_dQw4w9WgXcQ' }] });
    expect(ui.lastYoutubeSearchCacheState).toBe('stale');
  });

  it('aborts a stalled YouTube search and serves the stale cache', async () => {
    vi.useFakeTimers();
    const ui = new UIManager({});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [{ id: 'dQw4w9WgXcQ' }] }) })
      .mockImplementationOnce((_url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      }));
    vi.stubGlobal('fetch', fetchMock);
    await ui.fetchYoutubeSearch('Ambient');
    await vi.advanceTimersByTimeAsync(ui.youtubeSearchCacheTtlMs + 1);

    const refresh = ui.fetchYoutubeSearch('Ambient', undefined, { refresh: true });
    const rejectedRefresh = expect(refresh).rejects.toMatchObject({ staleResults: [{ id: 'yt_dQw4w9WgXcQ' }] });
    await vi.advanceTimersByTimeAsync(8_000);

    await rejectedRefresh;
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
    expect(ui.lastYoutubeSearchCacheState).toBe('stale');
  });

  it('fetches search results without creating or joining an audio room', async () => {
    const ui = new UIManager({ socketClient: { createRoom: vi.fn(), joinRoom: vi.fn() } });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [{ id: 'dQw4w9WgXcQ' }] }) });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const results = await ui.fetchYoutubeSearch('ambient music', controller.signal);

    expect(results).toEqual([expect.objectContaining({
      id: 'yt_dQw4w9WgXcQ', sourceId: 'dQw4w9WgXcQ', sourceType: 'youtube'
    })]);
    expect(fetchMock).toHaveBeenCalledWith('/api/yt-search?q=ambient%20music', { signal: expect.any(AbortSignal) });
    expect(ui.app.socketClient.createRoom).not.toHaveBeenCalled();
  });

  it('debounces YouTube input for 250ms and runs only the latest query', async () => {
    vi.useFakeTimers();
    const ui = new UIManager({});
    ui.activeYoutubeSearchHandler = vi.fn();

    ui.scheduleYoutubeSearch('ambient');
    await vi.advanceTimersByTimeAsync(200);
    ui.scheduleYoutubeSearch('ambient live');
    await vi.advanceTimersByTimeAsync(249);
    expect(ui.activeYoutubeSearchHandler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(ui.activeYoutubeSearchHandler).toHaveBeenCalledOnce();
    expect(ui.activeYoutubeSearchHandler).toHaveBeenCalledWith('ambient live');
  });

  it('renders untrusted search metadata as text, not markup', () => {
    const makeElement = () => ({
      children: [], className: '', style: {}, dataset: {}, textContent: '',
      set innerHTML(value) { this._html = value; this.children = []; },
      get innerHTML() { return this._html || ''; },
      appendChild(child) { this.children.push(child); },
      addEventListener() {}, setAttribute() {},
      querySelector(selector) {
        if (!this._selectors) this._selectors = {};
        return this._selectors[selector] ||= makeElement();
      }
    });
    const list = makeElement();
    const documentStub = { createElement: makeElement };
    vi.stubGlobal('document', documentStub);
    const ui = new UIManager({});
    ui.elements = { ytSearchResults: list };

    ui.renderSearchResults([{
      id: 'yt_abcdefghijk', sourceId: 'abcdefghijk', sourceType: 'youtube',
      sourceUrl: 'https://youtu.be/abcdefghijk',
      name: '<img src=x onerror=alert(1)>', artist: '<svg onload=alert(1)>', duration: 0
    }]);

    expect(list.children[1].children).toHaveLength(3);
    expect(list.children[1].children[2].children).toHaveLength(2);
    expect(list.children[1].children[2].children[0].textContent).toBe('Putar');
    expect(list.children[1].children[2].children[0].className).toContain('play-yt-result-btn');
    expect(list.children[1].children[2].children[1].className).toContain('add-yt-queue-btn');
    expect(list.children[1].children[2].children[1].style.cssText || '').not.toContain('28px');
    expect(list.children[1].children[1].children[0].textContent).toBe('<img src=x onerror=alert(1)>');
    expect(list.children[1].children[1].children[1].textContent).toBe('<svg onload=alert(1)>');
    expect(list.children[1].children[1].children[0]._html).toBeUndefined();
  });

  it('renders an actionable retry that reuses the failed search query', () => {
    const makeElement = () => ({
      children: [], className: '', style: {}, textContent: '', disabled: false,
      setAttribute: vi.fn(), addEventListener: vi.fn(function (name, handler) { this[`on${name}`] = handler; }),
      appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; }
    });
    vi.stubGlobal('document', { createElement: makeElement });
    const ui = new UIManager({});
    const results = makeElement();
    const retry = vi.fn();
    ui.elements = { ytSearchResults: results };
    ui.activeYoutubeSearchHandler = retry;

    ui.renderSearchError('YouTube sedang tidak tersedia.', 'ambient focus');

    expect(results.children[0].textContent).toBe('YouTube sedang tidak tersedia.');
    expect(results.children[1].textContent).toBe('Coba lagi');
    results.children[1].onclick();
    expect(retry).toHaveBeenCalledWith('ambient focus', true);
  });

  it('does not offer retry for a permanent YouTube search error', () => {
    const makeElement = () => ({
      children: [], className: '', style: {}, textContent: '',
      setAttribute() {}, addEventListener() {}, appendChild(child) { this.children.push(child); },
      replaceChildren() { this.children = []; }
    });
    vi.stubGlobal('document', { createElement: makeElement });
    const ui = new UIManager({});
    ui.elements = { ytSearchResults: makeElement() };

    ui.renderSearchError('Pencarian YouTube belum diatur di server.', 'ambient focus', false);

    expect(ui.elements.ytSearchResults.children).toHaveLength(1);
  });

  it('shows YouTube playback retry only for retryable player failures', () => {
    const status = { textContent: '' };
    const retry = { hidden: true, disabled: false, textContent: 'Coba lagi' };
    const ui = new UIManager({});
    ui.elements = { youtubePlayerStatus: status, youtubePlayerRetryBtn: retry };

    ui.setYouTubePlayerStatus('Player YouTube tidak bisa dimuat.', { retryable: true });
    expect(retry.hidden).toBe(false);
    ui.setYouTubePlayerStatus('Memuat video YouTube…', { retrying: true });
    expect(retry).toMatchObject({ hidden: false, disabled: true, textContent: 'Memuat…' });
    ui.setYouTubePlayerStatus('Video ini tidak mengizinkan pemutaran.', { retryable: false });
    expect(retry.hidden).toBe(true);
    ui.setYouTubePlayerStatus('');
    expect(retry.hidden).toBe(true);
  });

  it('retries the current YouTube track from its last known position', async () => {
    const playAt = vi.fn().mockResolvedValue(undefined);
    const youtubePlayer = { destroy: vi.fn(), playAt, getCurrentTime: () => 18 };
    const retry = { hidden: false, disabled: false, textContent: 'Coba lagi' };
    const status = { textContent: '' };
    const ui = new UIManager({ youtubePlayer, audioEngine: { pauseOffsetSec: 4 } });
    ui.currentTrack = { sourceType: 'youtube', sourceId: 'dQw4w9WgXcQ' };
    ui.elements = { youtubePlayerStatus: status, youtubePlayerRetryBtn: retry };

    await ui.retryYouTubePlayback();

    expect(youtubePlayer.destroy).toHaveBeenCalledOnce();
    expect(playAt).toHaveBeenCalledWith('dQw4w9WgXcQ', expect.any(Number), 18);
    expect(status.textContent).toBe('');
    expect(retry.hidden).toBe(true);
    expect(retry.disabled).toBe(false);
  });

  it('uses the synchronized server clock for local YouTube start requests', () => {
    const ui = new UIManager({ socketClient: { clockSync: { getServerTime: () => 10_000 } } });

    expect(ui.getYouTubeTargetServerTime()).toBe(10_050);
  });

  it('restores a retry action if YouTube playback fails again', async () => {
    const youtubePlayer = { destroy: vi.fn(), playAt: vi.fn().mockRejectedValue(new Error('timeout')) };
    const retry = { hidden: false, disabled: false, textContent: 'Coba lagi' };
    const ui = new UIManager({ youtubePlayer, audioEngine: { pauseOffsetSec: 0 } });
    ui.currentTrack = { id: 'yt_dQw4w9WgXcQ', sourceType: 'youtube', sourceId: 'dQw4w9WgXcQ' };
    ui.elements = { youtubePlayerStatus: { textContent: '' }, youtubePlayerRetryBtn: retry };

    await expect(ui.retryYouTubePlayback()).resolves.toBe(false);

    expect(retry).toMatchObject({ hidden: false, disabled: false, textContent: 'Coba lagi' });
  });

  it('persists up to eight unique YouTube searches locally and can clear them', () => {
    const values = new Map();
    vi.stubGlobal('localStorage', {
      getItem: key => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key)
    });
    const ui = new UIManager({});

    for (let index = 0; index < 9; index++) ui.recordYoutubeSearch(`track ${index}`);
    ui.recordYoutubeSearch(' TRACK 8 ');

    expect(ui.recentYoutubeSearches).toHaveLength(8);
    expect(ui.recentYoutubeSearches[0]).toBe('TRACK 8');
    const restored = new UIManager({});
    expect(restored.recentYoutubeSearches).toEqual(ui.recentYoutubeSearches);
    restored.clearYoutubeSearches();
    expect(values.has('rync_recent_youtube_searches')).toBe(false);
    expect(new UIManager({}).recentYoutubeSearches).toEqual([]);
  });

  it('shows selectable recent searches only when the search input is empty', () => {
    const makeElement = () => ({
      children: [], style: {}, textContent: '', value: '',
      setAttribute() {}, addEventListener(name, handler) { this[`on${name}`] = handler; },
      appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; }
    });
    vi.stubGlobal('document', { createElement: makeElement });
    const ui = new UIManager({});
    const input = makeElement();
    const recents = makeElement();
    const search = vi.fn();
    ui.elements = { ytUrlInput: input, ytSearchRecents: recents };
    ui.activeYoutubeSearchHandler = search;
    ui.recentYoutubeSearches = ['ambient'];

    ui.renderYoutubeSearchRecents();
    expect(recents.style.display).toBe('flex');
    const queryButton = recents.children[1].children[0];
    queryButton.onclick();
    expect(input.value).toBe('ambient');
    expect(search).toHaveBeenCalledWith('ambient');

    ui.renderYoutubeSearchRecents();
    expect(recents.style.display).toBe('none');
  });

  it('routes between the player, local library and room setup views', () => {
    const node = () => ({
      hidden: false,
      style: {},
      attributes: {},
      classList: { toggle() {} },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; }
    });
    const ui = new UIManager({ audioEngine: {}, socketClient: {} });
    ui.elements = {
      activeRoomSection: node(),
      roomHeroSection: node(),
      librarySection: node(),
      sourceHubSection: node(),
      navHomeBtn: node(), navSearchBtn: node(), navLibraryBtn: node(), navRoomBtn: node()
    };

    ui.setView('library');
    expect(ui.elements.activeRoomSection.style.display).toBe('none');
    expect(ui.elements.librarySection.hidden).toBe(false);

    ui.setView('room');
    expect(ui.elements.roomHeroSection.hidden).toBe(false);
    expect(ui.elements.activeRoomSection.style.display).toBe('none');

    ui.setView('home');
    expect(ui.elements.activeRoomSection.style.display).toBe('flex');
    expect(ui.elements.librarySection.hidden).toBe(true);
  });

  it('shows the player on Home and reserves Search for source discovery', () => {
    const node = () => ({ hidden: false, style: {}, attributes: {}, classList: { toggle() {} }, setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; } });
    const ui = new UIManager({ audioEngine: {}, socketClient: {} });
    ui.elements = {
      activeRoomSection: node(), roomHeroSection: node(), librarySection: node(),
      homeEmptyState: node(),
      sourceHubSection: node(), sourceSearchSection: node(), queueCardSection: node(), audioTuningSection: node(),
      navHomeBtn: node(), navSearchBtn: node(), navLibraryBtn: node(), navRoomBtn: node()
    };

    ui.setView('home');
    expect(ui.elements.homeEmptyState.hidden).toBe(false);
    expect(ui.elements.sourceHubSection.style.display).toBe('');
    expect(ui.elements.sourceSearchSection.style.display).toBe('none');
    expect(ui.elements.queueCardSection.style.display).toBe('');
    expect(ui.elements.audioTuningSection.style.display).toBe('');

    ui.currentTrack = { name: 'Song' };
    ui.setView('home');
    expect(ui.elements.homeEmptyState.hidden).toBe(true);

    ui.setView('search');
    expect(ui.elements.sourceHubSection.style.display).toBe('none');
    expect(ui.elements.sourceSearchSection.style.display).toBe('');
    expect(ui.elements.queueCardSection.style.display).toBe('none');
    expect(ui.elements.audioTuningSection.style.display).toBe('none');
  });

  it('shows and clears the host-disconnected room notice', () => {
    const notice = { hidden: true };
    const ui = new UIManager({});
    ui.elements = { hostDisconnectedNotice: notice };

    ui.setHostDisconnected(true);
    expect(notice.hidden).toBe(false);
    ui.setHostDisconnected(false);
    expect(notice.hidden).toBe(true);
  });

  it('keeps a compact player available on Library and room setup views', () => {
    const node = () => ({ hidden: false, style: {}, attributes: {}, classList: { toggle() {} }, setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; } });
    const ui = new UIManager({ socketClient: { roomId: null } });
    ui.elements = {
      activeRoomSection: node(), roomHeroSection: node(), librarySection: node(), sourceHubSection: node(), miniPlayerBar: node(),
      navHomeBtn: node(), navSearchBtn: node(), navLibraryBtn: node(), navRoomBtn: node()
    };
    ui.currentTrack = { name: 'Saved song' };

    ui.setView('library');
    expect(ui.elements.activeRoomSection.style.display).toBe('none');
    expect(ui.elements.miniPlayerBar.hidden).toBe(false);
    ui.setView('room');
    expect(ui.elements.miniPlayerBar.hidden).toBe(false);
    ui.setView('home');
    expect(ui.elements.activeRoomSection.style.display).toBe('flex');
    expect(ui.elements.miniPlayerBar.hidden).toBe(true);
  });

  it('mirrors playback state into the mini player control', () => {
    const button = { textContent: '', attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
    const visualizer = { start: vi.fn(), stop: vi.fn() };
    const toggle = vi.fn();
    vi.stubGlobal('document', { body: { classList: { toggle } } });
    const ui = new UIManager({ visualizer });
    ui.elements = { miniPlayerPlayBtn: button };

    ui.setPlayState(true);
    expect(button.textContent).toBe('Ⅱ');
    expect(button.attributes['aria-label']).toBe('Jeda');
    expect(visualizer.start).toHaveBeenCalledOnce();
    expect(toggle).toHaveBeenCalledWith('is-playing', true);
    ui.setPlayState(false);
    expect(button.textContent).toBe('▶');
    expect(button.attributes['aria-pressed']).toBe('false');
    expect(visualizer.stop).toHaveBeenCalledOnce();
    expect(toggle).toHaveBeenLastCalledWith('is-playing', false);
  });

  it('exposes shared repeat and shuffle modes through accessible control state', () => {
    const control = () => ({ attributes: {}, dataset: {}, setAttribute(name, value) { this.attributes[name] = value; } });
    const ui = new UIManager({});
    ui.elements = { repeatToggleBtn: control(), shuffleToggleBtn: control() };

    ui.setPlaybackOptions({ repeatMode: 'one', shuffle: true });

    expect(ui.elements.repeatToggleBtn.dataset.repeatMode).toBe('one');
    expect(ui.elements.repeatToggleBtn.attributes['aria-pressed']).toBe('true');
    expect(ui.elements.repeatToggleBtn.attributes['aria-label']).toBe('Ulangi lagu');
    expect(ui.elements.shuffleToggleBtn.attributes['aria-pressed']).toBe('true');
    expect(ui.elements.shuffleToggleBtn.attributes['aria-label']).toBe('Matikan acak');
  });

  it('sends a playback mode request from a guest to the host', () => {
    const requestControl = vi.fn();
    const ui = new UIManager({ socketClient: { roomId: 'ROOM', isHost: false, requestControl } });

    ui.requestPlaybackOptions({ repeatMode: 'all' });

    expect(requestControl).toHaveBeenCalledWith('playback_options', { repeatMode: 'all' });
  });

  it('keeps the selected screen when room creation finishes asynchronously', () => {
    const node = () => ({ hidden: false, style: {}, classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, removeAttribute() {}, innerText: '' });
    vi.stubGlobal('document', { body: { classList: { add() {}, remove() {} } } });
    const ui = new UIManager({ socketClient: { roomId: 'ABCD', isHost: true } });
    ui.currentView = 'library';
    ui.elements = {
      activeRoomSection: node(), roomHeroSection: node(), librarySection: node(), sourceHubSection: node(), miniPlayerBar: node(),
      navHomeBtn: node(), navSearchBtn: node(), navLibraryBtn: node(), navRoomBtn: node(), roomCodeDisplay: node(), userRoleBadge: node()
    };

    ui.setRoomState('ABCD', true);

    expect(ui.currentView).toBe('library');
    expect(ui.elements.librarySection.hidden).toBe(false);
    expect(ui.elements.activeRoomSection.style.display).toBe('none');
  });

  it('records the active track in history without reading an uninitialized track', async () => {
    const ui = new UIManager({
      audioEngine: { currentTrackName: 'Track A', currentTrackDuration: 180 },
      socketClient: { cloudMesh: { lastKnownTrack: { id: 'track-a', thumbnail: '/cover.jpg' } } }
    });
    const addHistory = vi.fn().mockResolvedValue(true);
    ui.localLibrary = { addHistory, isFavorite: vi.fn().mockResolvedValue(false) };
    ui.elements = {};

    expect(() => ui.updateTrackUI('Track A', 180, '/cover.jpg')).not.toThrow();
    await Promise.resolve();

    expect(addHistory).toHaveBeenCalledWith(expect.objectContaining({
      id: 'track-a', name: 'Track A', duration: 180, thumbnail: '/cover.jpg'
    }));
  });

  it('renders queue updates into the local queue list', () => {
    vi.useFakeTimers();
    const queueList = {
      innerHTML: 'initial', children: [],
      replaceChildren(...children) { this.children = children; },
      appendChild(child) { this.children.push(child); }
    };
    const queueBadge = { innerText: 'initial' };
    const documentStub = {
      createElement: () => ({ children: [], addEventListener() {}, appendChild(child) { this.children.push(child); } }),
      getElementById(id) {
        if (id === 'queueListContainer') return queueList;
        if (id === 'queueCountBadge') return queueBadge;
        return null;
      },
      addEventListener() {}
    };
    vi.stubGlobal('document', documentStub);
    vi.stubGlobal('window', { addEventListener() {} });

    const ui = new UIManager({ audioEngine: { onPlaybackEnded: null } });
    ui.init();

    expect(queueList.children[0].children[0].textContent).toContain('Antrean kosong');
    expect(queueList.children[0].children[1].textContent).toBe('Cari lagu');
    expect(queueBadge.innerText).toBe('0 lagu');
  });

  it('offers a search action when the queue is empty', () => {
    const createElement = () => ({
      children: [], className: '', textContent: '',
      addEventListener(name, handler) { this[`on${name}`] = handler; },
      appendChild(child) { this.children.push(child); },
      replaceChildren(...children) { this.children = children; }
    });
    const queue = createElement();
    vi.stubGlobal('document', { createElement });
    const ui = new UIManager({ socketClient: { roomId: null } });
    ui.elements = { queueListContainer: queue };
    ui.setView = vi.fn();

    ui.renderQueue([]);

    const emptyState = queue.children[0];
    const searchButton = emptyState.children[1];
    expect(emptyState.children[0].textContent).toContain('Antrean kosong');
    expect(searchButton.textContent).toBe('Cari lagu');
    searchButton.onclick();
    expect(ui.setView).toHaveBeenCalledWith('search');
  });
});
