/**
 * Rync LocalLibrary - IndexedDB storage for Favorites, Playlists, and Recent Tracks.
 * Ensures solo listening and personal collections persist across sessions on this device.
 */
import { isExpiredYouTubeApiData } from '../privacy/youtubeDataRetention.js';

const HISTORY_LIMIT = 100;

export class LocalLibrary {
  constructor(dbName = 'rync_library_db', version = 2) {
    this.dbName = dbName;
    this.version = version;
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;
    if (typeof indexedDB === 'undefined') return null;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('favorites')) {
          db.createObjectStore('favorites', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('history')) {
          const historyStore = db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
          historyStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
        if (!db.objectStoreNames.contains('playlists')) {
          db.createObjectStore('playlists', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('localAudio')) {
          db.createObjectStore('localAudio', { keyPath: 'id' });
        }
      };

      request.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };

      request.onerror = (e) => {
        console.warn('LocalLibrary: IndexedDB unavailable, falling back to localStorage', e);
        resolve(null);
      };
    });
  }

  async clearAllLocalData() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    if (typeof indexedDB !== 'undefined') {
      const deleted = await new Promise(resolve => {
        const request = indexedDB.deleteDatabase(this.dbName);
        request.onsuccess = () => resolve(true);
        request.onerror = () => resolve(false);
        request.onblocked = () => resolve(false);
      });
      if (!deleted) return false;
    }
    try {
      const keys = [];
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (key?.startsWith('rync_')) keys.push(key);
      }
      keys.forEach(key => localStorage.removeItem(key));
    } catch {
      return false;
    }
    return true;
  }

  async addFavorite(track) {
    if (!track || !track.id) return;
    const db = await this.open();
    if (db) {
      return new Promise((resolve) => {
        const tx = db.transaction('favorites', 'readwrite');
        const store = tx.objectStore('favorites');
        store.put({ ...track, favoritedAt: Date.now() });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    }
    try {
      const favs = JSON.parse(localStorage.getItem('rync_favs') || '[]');
      if (!favs.some(f => f.id === track.id)) {
        favs.unshift(track);
        localStorage.setItem('rync_favs', JSON.stringify(favs.slice(0, 500)));
      }
    } catch (e) {}
  }

  async removeFavorite(trackId) {
    const db = await this.open();
    if (db) {
      return new Promise((resolve) => {
        const tx = db.transaction('favorites', 'readwrite');
        const store = tx.objectStore('favorites');
        store.delete(trackId);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    }
    try {
      let favs = JSON.parse(localStorage.getItem('rync_favs') || '[]');
      favs = favs.filter(f => f.id !== trackId);
      localStorage.setItem('rync_favs', JSON.stringify(favs));
    } catch (e) {}
  }

  async getFavorites() {
    const db = await this.open();
    if (db) {
      return new Promise((resolve) => {
        const tx = db.transaction('favorites', 'readwrite');
        const store = tx.objectStore('favorites');
        const req = store.getAll();
        req.onsuccess = () => {
          const favorites = req.result || [];
          const retained = favorites.filter(item => !isExpiredYouTubeApiData(item));
          favorites.filter(item => isExpiredYouTubeApiData(item)).forEach(item => store.delete(item.id));
          resolve(retained);
        };
        req.onerror = () => resolve([]);
      });
    }
    try {
      const favorites = JSON.parse(localStorage.getItem('rync_favs') || '[]');
      const retained = Array.isArray(favorites) ? favorites.filter(item => !isExpiredYouTubeApiData(item)) : [];
      if (retained.length !== favorites.length) localStorage.setItem('rync_favs', JSON.stringify(retained));
      return retained;
    } catch (e) {
      return [];
    }
  }

  async isFavorite(trackId) {
    if (!trackId) return false;
    const db = await this.open();
    if (db) {
      return new Promise((resolve) => {
        const tx = db.transaction('favorites', 'readonly');
        const store = tx.objectStore('favorites');
        const req = store.get(trackId);
        req.onsuccess = () => resolve(!!req.result);
        req.onerror = () => resolve(false);
      });
    }
    try {
      const favs = JSON.parse(localStorage.getItem('rync_favs') || '[]');
      return favs.some(f => f.id === trackId);
    } catch (e) {
      return false;
    }
  }

  async addHistory(track) {
    if (!track || !track.id) return;
    const db = await this.open();
    if (db) {
      return new Promise((resolve) => {
        const tx = db.transaction('history', 'readwrite');
        const store = tx.objectStore('history');
        const request = store.getAll();
        request.onsuccess = () => {
          const history = (request.result || []).sort((a, b) => b.timestamp - a.timestamp);
          const retained = history.filter(item => (item.trackId || item.id) !== track.id).slice(0, HISTORY_LIMIT - 1);
          const keepIds = new Set(retained.map(item => item.id));
          history.forEach(item => {
            if ((item.trackId || item.id) === track.id || !keepIds.has(item.id)) store.delete(item.id);
          });
          const { id: trackId, ...trackData } = track;
          store.add({ ...trackData, trackId, timestamp: Date.now() });
        };
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    }
    try {
      const hist = JSON.parse(localStorage.getItem('rync_history') || '[]');
      const recent = hist.filter(item => item.id !== track.id);
      recent.unshift({ ...track, timestamp: Date.now() });
      localStorage.setItem('rync_history', JSON.stringify(recent.slice(0, HISTORY_LIMIT)));
    } catch (e) {}
  }

  async saveLocalAudio(track, arrayBuffer) {
    if (!track?.id || !(arrayBuffer instanceof ArrayBuffer)) return false;
    const db = await this.open();
    if (!db) return false;
    return new Promise(resolve => {
      const tx = db.transaction('localAudio', 'readwrite');
      tx.objectStore('localAudio').put({ ...track, audioData: arrayBuffer, savedAt: Date.now() });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
  }

  async getLocalAudio(trackId) {
    const db = await this.open();
    if (!db) return null;
    return new Promise(resolve => {
      const request = db.transaction('localAudio', 'readonly').objectStore('localAudio').get(trackId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  }

  async deleteLocalAudio(trackId) {
    if (!trackId) return false;
    let db;
    try { db = await this.open(); } catch (error) { return false; }
    if (!db) return false;
    return new Promise(resolve => {
      const tx = db.transaction('localAudio', 'readwrite');
      tx.objectStore('localAudio').delete(trackId);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
  }

  async getLocalAudioTracks() {
    const db = await this.open();
    if (!db) return [];
    return new Promise(resolve => {
      const request = db.transaction('localAudio', 'readonly').objectStore('localAudio').getAll();
      request.onsuccess = () => resolve((request.result || []).map(({ audioData, ...track }) => track)
        .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)));
      request.onerror = () => resolve([]);
    });
  }

  async getRecentHistory(limit = 30) {
    const db = await this.open();
    if (db) {
      return new Promise((resolve) => {
        const tx = db.transaction('history', 'readwrite');
        const store = tx.objectStore('history');
        const req = store.getAll();
        req.onsuccess = () => {
          const all = req.result || [];
          const list = all.filter(item => !isExpiredYouTubeApiData(item));
          all.filter(item => isExpiredYouTubeApiData(item)).forEach(item => store.delete(item.id));
          list.sort((a, b) => b.timestamp - a.timestamp);
          resolve(list.slice(0, limit).map(item => ({ ...item, id: item.trackId || item.id })));
        };
        req.onerror = () => resolve([]);
      });
    }
    try {
      const hist = JSON.parse(localStorage.getItem('rync_history') || '[]');
      const retained = Array.isArray(hist) ? hist.filter(item => !isExpiredYouTubeApiData(item)) : [];
      if (retained.length !== hist.length) localStorage.setItem('rync_history', JSON.stringify(retained));
      return retained.slice(0, limit);
    } catch (e) {
      return [];
    }
  }

  async clearRecentHistory() {
    let db;
    try { db = await this.open(); } catch (error) { return false; }
    if (db) {
      return new Promise(resolve => {
        const tx = db.transaction('history', 'readwrite');
        tx.objectStore('history').clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      });
    }
    try {
      localStorage.removeItem('rync_history');
      return true;
    } catch (error) {
      return false;
    }
  }

  async getPlaylists() {
    const db = await this.open();
    if (db) {
      return new Promise((resolve) => {
        const tx = db.transaction('playlists', 'readwrite');
        const store = tx.objectStore('playlists');
        const request = store.getAll();
        request.onsuccess = () => {
          const playlists = request.result || [];
          const retained = playlists.map(playlist => {
            const tracks = (playlist.tracks || []).filter(track => !isExpiredYouTubeApiData(track));
            if (tracks.length !== (playlist.tracks || []).length) store.put({ ...playlist, tracks });
            return { ...playlist, tracks };
          });
          resolve(retained);
        };
        request.onerror = () => resolve([]);
      });
    }
    try {
      const playlists = JSON.parse(localStorage.getItem('rync_playlists') || '[]');
      const retained = Array.isArray(playlists) ? playlists.map(playlist => ({
        ...playlist,
        tracks: (playlist.tracks || []).filter(track => !isExpiredYouTubeApiData(track))
      })) : [];
      if (JSON.stringify(retained) !== JSON.stringify(playlists)) localStorage.setItem('rync_playlists', JSON.stringify(retained));
      return retained;
    } catch (e) {
      return [];
    }
  }

  async savePlaylist(playlist) {
    const db = await this.open();
    if (db) {
      return new Promise((resolve) => {
        const tx = db.transaction('playlists', 'readwrite');
        tx.objectStore('playlists').put(playlist);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    }
    try {
      const playlists = await this.getPlaylists();
      const index = playlists.findIndex(item => item.id === playlist.id);
      if (index < 0) playlists.unshift(playlist);
      else playlists[index] = playlist;
      localStorage.setItem('rync_playlists', JSON.stringify(playlists));
      return true;
    } catch (e) {
      return false;
    }
  }

  async createPlaylist(name) {
    const title = String(name || '').trim();
    if (!title) throw new Error('Playlist name is required');
    const now = Date.now();
    const playlist = {
      id: `playlist_${globalThis.crypto?.randomUUID?.() || `${now}_${Math.random().toString(36).slice(2, 8)}`}`,
      name: title,
      tracks: [],
      createdAt: now,
      updatedAt: now
    };
    if (!await this.savePlaylist(playlist)) throw new Error('Playlist could not be saved');
    return playlist;
  }

  async updatePlaylist(playlistId, update) {
    const playlists = await this.getPlaylists();
    const playlist = playlists.find(item => item.id === playlistId);
    if (!playlist) return false;
    const next = { ...playlist, ...update, id: playlist.id, updatedAt: Date.now() };
    return this.savePlaylist(next);
  }

  async renamePlaylist(playlistId, name) {
    const title = String(name || '').trim();
    if (!title) throw new Error('Playlist name is required');
    return this.updatePlaylist(playlistId, { name: title });
  }

  async addTrackToPlaylist(playlistId, track) {
    if (!track?.id) return false;
    const playlists = await this.getPlaylists();
    const playlist = playlists.find(item => item.id === playlistId);
    if (!playlist) return false;
    const tracks = playlist.tracks || [];
    if (tracks.some(item => item.id === track.id)) return true;
    return this.updatePlaylist(playlistId, { tracks: [...tracks, track] });
  }

  async removeTrackFromPlaylist(playlistId, trackId) {
    const playlists = await this.getPlaylists();
    const playlist = playlists.find(item => item.id === playlistId);
    if (!playlist) return false;
    return this.updatePlaylist(playlistId, {
      tracks: (playlist.tracks || []).filter(item => item.id !== trackId)
    });
  }

  async reorderPlaylist(playlistId, fromIndex, toIndex) {
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return false;
    const playlists = await this.getPlaylists();
    const playlist = playlists.find(item => item.id === playlistId);
    const tracks = [...(playlist?.tracks || [])];
    if (!playlist || fromIndex < 0 || toIndex < 0 || fromIndex >= tracks.length || toIndex >= tracks.length) return false;
    if (fromIndex === toIndex) return true;
    const [track] = tracks.splice(fromIndex, 1);
    tracks.splice(toIndex, 0, track);
    return this.updatePlaylist(playlistId, { tracks });
  }

  async deletePlaylist(playlistId) {
    const db = await this.open();
    if (db) {
      return new Promise((resolve) => {
        const tx = db.transaction('playlists', 'readwrite');
        tx.objectStore('playlists').delete(playlistId);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    }
    try {
      const playlists = (await this.getPlaylists()).filter(item => item.id !== playlistId);
      localStorage.setItem('rync_playlists', JSON.stringify(playlists));
      return true;
    } catch (e) {
      return false;
    }
  }
}
