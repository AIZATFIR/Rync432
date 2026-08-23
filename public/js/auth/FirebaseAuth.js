import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { 
  getAuth, 
  signInWithPopup, 
  GoogleAuthProvider, 
  signOut, 
  onAuthStateChanged 
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

// Default Firebase Configuration (Can be customized via Settings or env)
const DEFAULT_FIREBASE_CONFIG = {
  apiKey: "AIzaSyDummyKeyReplaceWithYourProjectKey",
  authDomain: "rync432-audio.firebaseapp.com",
  projectId: "rync432-audio",
  storageBucket: "rync432-audio.appspot.com",
  messagingSenderId: "123456789012",
  appId: "1:123456789012:web:abcdef123456"
};

export class FirebaseAuthService {
  constructor() {
    this.app = null;
    this.auth = null;
    this.googleProvider = null;
    this.isConfigured = false;
    this.init();
  }

  getStoredConfig() {
    try {
      const saved = localStorage.getItem('rync_firebase_config');
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {}
    return window.__FIREBASE_CONFIG__ || DEFAULT_FIREBASE_CONFIG;
  }

  saveConfig(config) {
    try {
      localStorage.setItem('rync_firebase_config', JSON.stringify(config));
      this.init(config);
      return true;
    } catch (e) {
      console.error('Failed to save Firebase config:', e);
      return false;
    }
  }

  init(customConfig = null) {
    const config = customConfig || this.getStoredConfig();
    try {
      this.app = getApps().length === 0 ? initializeApp(config) : getApp();
      this.auth = getAuth(this.app);
      this.googleProvider = new GoogleAuthProvider();
      this.googleProvider.setCustomParameters({
        prompt: 'select_account'
      });
      // Check if real config is present (not placeholder)
      this.isConfigured = config.apiKey && !config.apiKey.includes('DummyKey');
    } catch (err) {
      console.warn('Firebase initialization notice:', err.message);
    }
  }

  async signInWithGoogle() {
    if (!this.auth) {
      throw new Error('Firebase Auth belum diinisialisasi.');
    }

    if (!this.isConfigured) {
      throw new Error('CONFIG_REQUIRED');
    }

    try {
      const result = await signInWithPopup(this.auth, this.googleProvider);
      const user = result.user;
      return {
        uid: user.uid,
        name: user.displayName || 'Google User',
        email: user.email || '',
        avatar: user.photoURL || '',
        provider: 'google.com'
      };
    } catch (error) {
      console.error('Firebase Google Sign-In error:', error);
      if (error.code === 'auth/popup-closed-by-user') {
        throw new Error('Login dibatalkan.');
      } else if (error.code === 'auth/unauthorized-domain') {
        throw new Error('Domain ini belum diotorisasi di Firebase Console (Authentication > Settings > Authorized domains).');
      } else if (error.code === 'auth/api-key-not-valid') {
        throw new Error('Firebase API Key tidak valid. Silakan periksa konfigurasi Firebase Anda.');
      }
      throw error;
    }
  }

  async signOut() {
    if (this.auth) {
      await signOut(this.auth);
    }
    localStorage.removeItem('rync_user');
  }

  onAuthStateChanged(callback) {
    if (!this.auth) return;
    onAuthStateChanged(this.auth, (user) => {
      if (user) {
        const profile = {
          uid: user.uid,
          name: user.displayName || 'Google User',
          email: user.email || '',
          avatar: user.photoURL || '',
          provider: 'google.com'
        };
        localStorage.setItem('rync_user', JSON.stringify(profile));
        callback(profile);
      } else {
        localStorage.removeItem('rync_user');
        callback(null);
      }
    });
  }
}

export const firebaseAuth = new FirebaseAuthService();
