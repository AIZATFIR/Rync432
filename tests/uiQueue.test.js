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
