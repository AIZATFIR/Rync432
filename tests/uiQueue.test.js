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

  it('leaves queue order intact for an invalid drag destination', () => {
    const original = [{ id: 'a' }, { id: 'b' }];

    expect(moveQueueItem(original, 0, 4)).toEqual(original);
    expect(moveQueueItem(original, -1, 1)).toEqual(original);
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

  it('starts a selected solo YouTube track in the official player', async () => {
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
    expect(ui.isPlayingState).toBe(true);
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
    expect(schedulePlay).toHaveBeenCalledWith(800, 12);
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

  it('loads an empty solo queue when browser storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    const ui = new UIManager({});

    expect(ui.soloQueue).toEqual([]);
  });

  it('serves repeated search results from the short local cache and can force refresh', async () => {
    const ui = new UIManager({ socketClient: { createRoom: vi.fn(), joinRoom: vi.fn() } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [{ id: 'first' }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [{ id: 'fresh' }] }) });
    vi.stubGlobal('fetch', fetchMock);

    expect((await ui.fetchYoutubeSearch('Ambient')).map(item => item.id)).toEqual(['first']);
    expect((await ui.fetchYoutubeSearch(' ambient ')).map(item => item.id)).toEqual(['first']);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(ui.lastYoutubeSearchCacheState).toBe('fresh');
    expect((await ui.fetchYoutubeSearch('Ambient', undefined, { refresh: true })).map(item => item.id)).toEqual(['fresh']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns stale search results when refresh fails', async () => {
    vi.useFakeTimers();
    const ui = new UIManager({});
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [{ id: 'cached' }] }) })
      .mockRejectedValueOnce(new TypeError('offline')));
    await ui.fetchYoutubeSearch('Ambient');
    vi.advanceTimersByTime(60_001);

    await expect(ui.fetchYoutubeSearch('Ambient', undefined, { refresh: true }))
      .rejects.toMatchObject({ staleResults: [{ id: 'cached' }] });
    expect(ui.lastYoutubeSearchCacheState).toBe('stale');
  });

  it('aborts a stalled YouTube search and serves the stale cache', async () => {
    vi.useFakeTimers();
    const ui = new UIManager({});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [{ id: 'cached' }] }) })
      .mockImplementationOnce((_url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      }));
    vi.stubGlobal('fetch', fetchMock);
    await ui.fetchYoutubeSearch('Ambient');
    await vi.advanceTimersByTimeAsync(ui.youtubeSearchCacheTtlMs + 1);

    const refresh = ui.fetchYoutubeSearch('Ambient', undefined, { refresh: true });
    const rejectedRefresh = expect(refresh).rejects.toMatchObject({ staleResults: [{ id: 'cached' }] });
    await vi.advanceTimersByTimeAsync(8_000);

    await rejectedRefresh;
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
    expect(ui.lastYoutubeSearchCacheState).toBe('stale');
  });

  it('fetches search results without creating or joining an audio room', async () => {
    const ui = new UIManager({ socketClient: { createRoom: vi.fn(), joinRoom: vi.fn() } });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [{ id: 'video-1' }] }) });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const results = await ui.fetchYoutubeSearch('ambient music', controller.signal);

    expect(results).toEqual([{ id: 'video-1' }]);
    expect(fetchMock).toHaveBeenCalledWith('/api/yt-search?q=ambient%20music', { signal: expect.any(AbortSignal) });
    expect(ui.app.socketClient.createRoom).not.toHaveBeenCalled();
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
      id: 'abcdefghijk', url: 'https://youtu.be/abcdefghijk',
      title: '<img src=x onerror=alert(1)>', channel: '<svg onload=alert(1)>', duration: 60
    }]);

    expect(list.children[1].children).toHaveLength(3);
    expect(list.children[1].children[2].children).toHaveLength(2);
    expect(list.children[1].children[2].children[0].textContent).toBe('Putar');
    expect(list.children[1].children[1].children[0].textContent).toBe('<img src=x onerror=alert(1)>');
    expect(list.children[1].children[1].children[0]._html).toBeUndefined();
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
    const ui = new UIManager({});
    ui.elements = { miniPlayerPlayBtn: button };

    ui.setPlayState(true);
    expect(button.textContent).toBe('Ⅱ');
    expect(button.attributes['aria-label']).toBe('Jeda');
    ui.setPlayState(false);
    expect(button.textContent).toBe('▶');
    expect(button.attributes['aria-pressed']).toBe('false');
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
    const ui = new UIManager({ socketClient: { isHost: false, requestControl } });

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
    const queueList = { innerHTML: 'initial' };
    const queueBadge = { innerText: 'initial' };
    const documentStub = {
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
    ui.renderQueue([]);

    expect(queueList.innerHTML).toContain('Antrean kosong');
    expect(queueBadge.innerText).toBe('0 lagu');
  });
});
