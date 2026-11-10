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

  it('fetches search results without creating or joining an audio room', async () => {
    const ui = new UIManager({ socketClient: { createRoom: vi.fn(), joinRoom: vi.fn() } });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [{ id: 'video-1' }] }) });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const results = await ui.fetchYoutubeSearch('ambient music', controller.signal);

    expect(results).toEqual([{ id: 'video-1' }]);
    expect(fetchMock).toHaveBeenCalledWith('/api/yt-search?q=ambient%20music', { signal: controller.signal });
    expect(ui.app.socketClient.createRoom).not.toHaveBeenCalled();
  });

  it('renders untrusted search metadata as text, not markup', () => {
    const makeElement = () => ({
      children: [], className: '', style: {}, dataset: {}, textContent: '',
      set innerHTML(value) { this._html = value; this.children = []; },
      get innerHTML() { return this._html || ''; },
      appendChild(child) { this.children.push(child); },
      addEventListener() {},
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

    expect(list.children[0].children).toHaveLength(3);
    expect(list.children[0].children[1].children[0].textContent).toBe('<img src=x onerror=alert(1)>');
    expect(list.children[0].children[1].children[0]._html).toBeUndefined();
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
