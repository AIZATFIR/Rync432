import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../public/js/auth/FirebaseAuth.js', () => ({
  firebaseAuth: { onAuthStateChanged() {} }
}));

import { UIManager } from '../public/js/ui/UIManager.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('YouTube search queue UI', () => {
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
