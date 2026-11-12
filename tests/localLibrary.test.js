import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LocalLibrary } from '../public/js/library/LocalLibrary.js';
import { YOUTUBE_API_DATA_TTL_MS } from '../public/js/privacy/youtubeDataRetention.js';

describe('LocalLibrary Local Storage Fallback', () => {
  let lib;

  beforeEach(() => {
    // Reset simulated storage
    const storage = {};
    global.localStorage = {
      get length() { return Object.keys(storage).length; },
      key: (index) => Object.keys(storage)[index] || null,
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
    const track = { id: 'yt_123', sourceType: 'youtube', apiDataFetchedAt: Date.now(), name: 'Ambient Focus', artist: 'Rync Synth' };
    await lib.addFavorite(track);

    const isFav = await lib.isFavorite('yt_123');
    expect(isFav).toBe(true);

    const list = await lib.getFavorites();
    expect(list.length).toBe(1);
    expect(list[0].name).toBe('Ambient Focus');
  });

  it('removes favorite track properly', async () => {
    const track = { id: 'yt_123', sourceType: 'youtube', apiDataFetchedAt: Date.now(), name: 'Ambient Focus', artist: 'Rync Synth' };
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

  it('keeps only the latest entry for a track in fallback history', async () => {
    await lib.addHistory({ id: 'track-1', name: 'Old title' });
    await lib.addHistory({ id: 'track-2', name: 'Other song' });
    await lib.addHistory({ id: 'track-1', name: 'Updated title' });

    expect(await lib.getRecentHistory(10)).toEqual([
      expect.objectContaining({ id: 'track-1', name: 'Updated title' }),
      expect.objectContaining({ id: 'track-2', name: 'Other song' })
    ]);
  });

  it('caps IndexedDB history at the 100 most recent unique tracks', async () => {
    const records = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1, trackId: `track-${index}`, name: `Track ${index}`, timestamp: index + 1
    }));
    lib.open = async () => ({
      transaction: () => {
        const tx = {
          objectStore: () => ({
            getAll: () => {
              const request = {};
              queueMicrotask(() => {
                request.result = [...records];
                request.onsuccess();
                tx.oncomplete?.();
              });
              return request;
            },
            delete: id => { const index = records.findIndex(item => item.id === id); if (index >= 0) records.splice(index, 1); },
            add: item => records.push({ ...item, id: Math.max(0, ...records.map(record => record.id)) + 1 })
          }),
          oncomplete: null,
          set onerror(_) {}
        };
        return tx;
      }
    });

    await lib.addHistory({ id: 'track-new', name: 'Newest track' });
    await lib.addHistory({ id: 'track-new', name: 'Newest track updated' });

    expect(records).toHaveLength(100);
    expect(records.some(item => item.trackId === 'track-0')).toBe(false);
    expect(records.filter(item => item.trackId === 'track-new')).toEqual([
      expect.objectContaining({ name: 'Newest track updated' })
    ]);
    await expect(lib.getRecentHistory(1)).resolves.toEqual([
      expect.objectContaining({ id: 'track-new', name: 'Newest track updated' })
    ]);
  });

  it('clears recent history from the device fallback store', async () => {
    await lib.addHistory({ id: 'track-1', name: 'Old track' });

    expect(await lib.clearRecentHistory()).toBe(true);
    expect(await lib.getRecentHistory()).toEqual([]);
  });

  it('deletes one saved local audio file from IndexedDB', async () => {
    const remove = vi.fn();
    lib.open = async () => ({ transaction: () => ({ objectStore: () => ({ delete: remove }), set oncomplete(callback) { queueMicrotask(callback); }, set onerror(_) {} }) });

    expect(await lib.deleteLocalAudio('file-1')).toBe(true);
    expect(remove).toHaveBeenCalledWith('file-1');
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

  it('reorders playlist tracks and leaves the stored order intact for invalid moves', async () => {
    const playlist = await lib.createPlaylist('Road trip');
    for (const id of ['a', 'b', 'c']) await lib.addTrackToPlaylist(playlist.id, { id, name: id });

    expect(await lib.reorderPlaylist(playlist.id, 2, 0)).toBe(true);
    expect((await lib.getPlaylists())[0].tracks.map(track => track.id)).toEqual(['c', 'a', 'b']);
    expect(await lib.reorderPlaylist(playlist.id, 8, 0)).toBe(false);
    expect((await lib.getPlaylists())[0].tracks.map(track => track.id)).toEqual(['c', 'a', 'b']);
  });

  it('removes expired YouTube API metadata from favorites, history, and playlists', async () => {
    const expired = { id: 'yt_old', sourceType: 'youtube', apiDataFetchedAt: Date.now() - YOUTUBE_API_DATA_TTL_MS - 1 };
    const fresh = { id: 'yt_new', sourceType: 'youtube', apiDataFetchedAt: Date.now() };
    localStorage.setItem('rync_favs', JSON.stringify([expired, fresh]));
    localStorage.setItem('rync_history', JSON.stringify([
      { ...expired, timestamp: 2 }, { ...fresh, timestamp: 1 }
    ]));
    localStorage.setItem('rync_playlists', JSON.stringify([{
      id: 'playlist_1', name: 'Saved', tracks: [expired, fresh]
    }]));

    await expect(lib.getFavorites()).resolves.toEqual([fresh]);
    await expect(lib.getRecentHistory()).resolves.toEqual([expect.objectContaining({ id: 'yt_new' })]);
    await expect(lib.getPlaylists()).resolves.toEqual([expect.objectContaining({ tracks: [fresh] })]);
    expect(JSON.parse(localStorage.getItem('rync_favs'))).toEqual([fresh]);
    expect(JSON.parse(localStorage.getItem('rync_history'))).toEqual([expect.objectContaining({ id: 'yt_new' })]);
    expect(JSON.parse(localStorage.getItem('rync_playlists'))[0].tracks).toEqual([fresh]);
  });

  it('falls back to localStorage when IndexedDB is unavailable', async () => {
    delete global.indexedDB;
    const fallbackLibrary = new LocalLibrary();
    await fallbackLibrary.addFavorite({ id: 'fallback-track', name: 'Offline favorite' });

    expect(await fallbackLibrary.isFavorite('fallback-track')).toBe(true);
  });

  it('stores local audio only in IndexedDB and retrieves its bytes by track id', async () => {
    const bytes = new ArrayBuffer(8);
    const stored = new Map();
    lib.open = async () => ({
      transaction: () => ({
        objectStore: () => ({
          put: vi.fn(record => stored.set(record.id, record)),
          get: () => {
            const request = {};
            queueMicrotask(() => {
              request.result = stored.get('file-1');
              request.onsuccess();
            });
            return request;
          },
          getAll: () => {
            const request = {};
            queueMicrotask(() => {
              request.result = [...stored.values()];
              request.onsuccess();
            });
            return request;
          }
        }),
        set oncomplete(callback) { queueMicrotask(callback); },
        set onerror(_) {},
        set onabort(_) {}
      })
    });

    expect(await lib.saveLocalAudio({ id: 'file-1' }, bytes)).toBe(true);
    expect(await lib.getLocalAudio('file-1')).toMatchObject({ id: 'file-1', audioData: bytes });
    expect(await lib.getLocalAudioTracks()).toEqual([expect.objectContaining({ id: 'file-1' })]);
    expect(await lib.saveLocalAudio({ id: 'bad' }, new Uint8Array(8))).toBe(false);
  });

  it('clears Rync localStorage and its IndexedDB library when asked', async () => {
    localStorage.setItem('rync_theme', 'light');
    localStorage.setItem('rync_favs', '[]');
    localStorage.setItem('other_app_setting', 'keep');

    expect(await lib.clearAllLocalData()).toBe(true);
    expect(localStorage.getItem('rync_theme')).toBe(null);
    expect(localStorage.getItem('rync_favs')).toBe(null);
    expect(localStorage.getItem('other_app_setting')).toBe('keep');
  });
});
