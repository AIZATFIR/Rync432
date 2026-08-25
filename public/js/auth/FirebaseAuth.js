import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { 
  getAuth, 
  signInWithPopup, 
  signInAnonymously,
  GoogleAuthProvider, 
  signOut, 
  onAuthStateChanged 
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

// Official Rync432 Firebase App Configuration
export const firebaseConfig = {
  apiKey: "AIzaSyB7F4Hjqs9K3R2qu1AJ8eobgdW_eXHTlDw",
  authDomain: "rync432.firebaseapp.com",
  projectId: "rync432",
  storageBucket: "rync432.firebasestorage.app",
  messagingSenderId: "607666586504",
  appId: "1:607666586504:web:0141bd10c4ca3fde58303d",
  measurementId: "G-QMXEDY6BK5"
};

export class FirebaseAuthService {
  constructor() {
    this.app = null;
    this.auth = null;
    this.googleProvider = null;
    this.init();
  }

  init() {
    try {
      this.app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
      this.auth = getAuth(this.app);
      this.googleProvider = new GoogleAuthProvider();
      this.googleProvider.setCustomParameters({
        prompt: 'select_account'
      });
      this.ensureAuthenticated();
    } catch (err) {
      console.warn('Firebase initialization:', err.message);
    }
  }

  async ensureAuthenticated() {
    if (!this.auth) return;
    if (!this.auth.currentUser) {
      try {
        await signInAnonymously(this.auth);
      } catch (e) {
        console.warn('Anonymous auth init notice:', e.message);
      }
    }
  }

  async signInWithGoogle() {
    if (!this.auth) {
      this.init();
    }

    try {
      const result = await signInWithPopup(this.auth, this.googleProvider);
      const user = result.user;
      const profile = {
        uid: user.uid,
        name: user.displayName || 'Google User',
        email: user.email || '',
        avatar: user.photoURL || '',
        provider: 'google.com'
      };
      localStorage.setItem('rync_user', JSON.stringify(profile));
      return profile;
    } catch (error) {
      console.warn('Google Sign-In popup notice:', error.code, error.message);
      if (error.code === 'auth/popup-closed-by-user') {
        throw new Error('Login dibatalkan.');
      } else if (error.code === 'auth/unauthorized-domain') {
        throw new Error('Domain belum terdaftar di Firebase Authorized Domains.');
      }
      throw error;
    }
  }

  async signOut() {
    if (this.auth) {
      try {
        await signOut(this.auth);
        await signInAnonymously(this.auth);
      } catch (e) {}
    }
    localStorage.removeItem('rync_user');
  }

  onAuthStateChanged(callback) {
    if (!this.auth) {
      const saved = localStorage.getItem('rync_user');
      if (saved) {
        try { callback(JSON.parse(saved)); } catch (e) { callback(null); }
      } else {
        callback(null);
      }
      return;
    }

    onAuthStateChanged(this.auth, (user) => {
      if (user && !user.isAnonymous) {
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
        const saved = localStorage.getItem('rync_user');
        if (saved) {
          try { callback(JSON.parse(saved)); } catch (e) { callback(null); }
        } else {
          callback(null);
        }
      }
    });
  }
}

export const firebaseAuth = new FirebaseAuthService();
