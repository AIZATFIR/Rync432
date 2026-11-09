import { describe, it, expect, beforeEach } from 'vitest';
import { LocalLibrary } from '../public/js/library/LocalLibrary.js';

describe('LocalLibrary Local Storage Fallback', () => {
  let lib;

  beforeEach(() => {
    // Reset simulated storage
    const storage = {};
    global.localStorage = {
      getItem: (key) => storage[key] || null,
      setItem: (key, val) => { storage[key] = String(val); },
      removeItem: (key) => { delete storage[key]; },
      clear: () => { for (const k in storage) delete storage[k]; }
    };
    lib = new LocalLibrary();
    // Force fallback to localStorage in node test environment
    lib.open = async () => null;
  });

  it('adds and retrieves favorite tracks', async () => {
    const track = { id: 'yt_123', name: 'Ambient Focus', artist: 'Rync Synth' };
    await lib.addFavorite(track);

    const isFav = await lib.isFavorite('yt_123');
    expect(isFav).toBe(true);

    const list = await lib.getFavorites();
    expect(list.length).toBe(1);
    expect(list[0].name).toBe('Ambient Focus');
  });

  it('removes favorite track properly', async () => {
    const track = { id: 'yt_123', name: 'Ambient Focus', artist: 'Rync Synth' };
    await lib.addFavorite(track);
    await lib.removeFavorite('yt_123');

    const isFav = await lib.isFavorite('yt_123');
    expect(isFav).toBe(false);

    const list = await lib.getFavorites();
    expect(list.length).toBe(0);
  });

  it('records recent history and returns sorted order', async () => {
    await lib.addHistory({ id: 'track_1', name: 'Song 1' });
    await lib.addHistory({ id: 'track_2', name: 'Song 2' });

    const history = await lib.getRecentHistory(10);
    expect(history.length).toBe(2);
    expect(history[0].name).toBe('Song 2');
  });

  it('creates, renames, populates and deletes playlists', async () => {
    const playlist = await lib.createPlaylist('Late night');
    expect(playlist.name).toBe('Late night');

    const track = { id: 'track-1', name: 'Track one' };
    await lib.addTrackToPlaylist(playlist.id, track);
    await lib.addTrackToPlaylist(playlist.id, track);
    await lib.renamePlaylist(playlist.id, 'Night drive');

    expect(await lib.getPlaylists()).toEqual([expect.objectContaining({
      id: playlist.id, name: 'Night drive', tracks: [track]
    })]);

    await lib.removeTrackFromPlaylist(playlist.id, track.id);
    expect((await lib.getPlaylists())[0].tracks).toEqual([]);
    await lib.deletePlaylist(playlist.id);
    expect(await lib.getPlaylists()).toEqual([]);
  });

  it('rejects blank playlist names', async () => {
    await expect(lib.createPlaylist('   ')).rejects.toThrow('Playlist name is required');
  });

  it('falls back to localStorage when IndexedDB is unavailable', async () => {
    delete global.indexedDB;
    const fallbackLibrary = new LocalLibrary();
    await fallbackLibrary.addFavorite({ id: 'fallback-track', name: 'Offline favorite' });

    expect(await fallbackLibrary.isFavorite('fallback-track')).toBe(true);
  });
});
