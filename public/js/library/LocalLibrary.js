/**
 * Rync LocalLibrary - IndexedDB storage for Favorites, Playlists, and Recent Tracks.
 * Ensures solo listening and personal collections persist across sessions on this device.
 */
export class LocalLibrary {
  constructor(dbName = 'rync_library_db', version = 1) {
    this.dbName = dbName;
    this.version = version;
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;
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
        const tx = db.transaction('favorites', 'readonly');
        const store = tx.objectStore('favorites');
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    }
    try {
      return JSON.parse(localStorage.getItem('rync_favs') || '[]');
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
        store.add({ ...track, timestamp: Date.now() });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    }
    try {
      const hist = JSON.parse(localStorage.getItem('rync_history') || '[]');
      hist.unshift({ ...track, timestamp: Date.now() });
      localStorage.setItem('rync_history', JSON.stringify(hist.slice(0, 100)));
    } catch (e) {}
  }

  async getRecentHistory(limit = 30) {
    const db = await this.open();
    if (db) {
      return new Promise((resolve) => {
        const tx = db.transaction('history', 'readonly');
        const store = tx.objectStore('history');
        const req = store.getAll();
        req.onsuccess = () => {
          const list = req.result || [];
          list.sort((a, b) => b.timestamp - a.timestamp);
          resolve(list.slice(0, limit));
        };
        req.onerror = () => resolve([]);
      });
    }
    try {
      const hist = JSON.parse(localStorage.getItem('rync_history') || '[]');
      return hist.slice(0, limit);
    } catch (e) {
      return [];
    }
  }
}
