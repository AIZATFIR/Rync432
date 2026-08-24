import { firebaseAuth } from '../auth/FirebaseAuth.js';
import { 
  getFirestore, 
  doc, 
  setDoc, 
  getDoc, 
  onSnapshot, 
  updateDoc, 
  deleteDoc 
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

export class CloudMesh {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.db = null;
    this.unsubscribeRoom = null;
    this.roomId = null;
    this.peerId = null;
    this.isHost = false;
    this.heartbeatInterval = null;
  }

  init() {
    try {
      if (firebaseAuth.app) {
        this.db = getFirestore(firebaseAuth.app);
      }
    } catch (e) {
      console.warn('Firestore mesh init notice:', e.message);
    }
  }

  async createRoom(roomId, peerId, deviceName) {
    this.roomId = roomId;
    this.peerId = peerId;
    this.isHost = true;
    this.init();

    const roomData = {
      roomId,
      hostId: peerId,
      state: 'IDLE',
      track: null,
      targetServerTime: 0,
      startOffsetSec: 0,
      updatedAt: Date.now(),
      peers: {
        [peerId]: {
          id: peerId,
          deviceName,
          isHost: true,
          latencyOffset: 0,
          lastSeen: Date.now()
        }
      }
    };

    if (this.db) {
      try {
        await setDoc(doc(this.db, 'rooms', roomId), roomData);
      } catch (err) {
        console.warn('Firestore room create error, using memory mesh:', err.message);
      }
    }

    this.subscribe(roomId);
    this.startHeartbeat(deviceName);
    return roomData;
  }

  async joinRoom(roomId, peerId, deviceName) {
    this.roomId = roomId;
    this.peerId = peerId;
    this.isHost = false;
    this.init();

    if (this.db) {
      try {
        const roomRef = doc(this.db, 'rooms', roomId);
        const snapshot = await getDoc(roomRef);
        if (snapshot.exists()) {
          const data = snapshot.data();
          const peers = data.peers || {};
          peers[peerId] = {
            id: peerId,
            deviceName,
            isHost: false,
            latencyOffset: 0,
            lastSeen: Date.now()
          };
          await updateDoc(roomRef, { peers, updatedAt: Date.now() });
        }
      } catch (err) {
        console.warn('Firestore room join error:', err.message);
      }
    }

    this.subscribe(roomId);
    this.startHeartbeat(deviceName);
  }

  subscribe(roomId) {
    this.unsubscribe();
    if (!this.db) return;

    try {
      this.unsubscribeRoom = onSnapshot(doc(this.db, 'rooms', roomId), (docSnap) => {
        if (!docSnap.exists()) return;
        const data = docSnap.data();

        // 1. Update Peer List
        if (data.peers) {
          const peersArray = Object.values(data.peers);
          this.onEvent('PEER_JOINED', {
            peers: peersArray,
            peerCount: peersArray.length
          });
        }

        // 2. Track Metadata
        if (data.track) {
          this.onEvent('TRACK_METADATA', data.track);
        }

        // 3. Playback State Broadcast
        if (data.state === 'PLAYING' && data.targetServerTime) {
          this.onEvent('SCHEDULED_PLAY', {
            targetServerTime: data.targetServerTime,
            startOffsetSec: data.startOffsetSec || 0
          });
        } else if (data.state === 'PAUSED') {
          this.onEvent('PAUSED', {
            currentOffsetSec: data.startOffsetSec || 0
          });
        }
      }, (err) => {
        console.warn('Firestore snapshot listener notice:', err.message);
      });
    } catch (e) {
      console.warn('Firestore subscribe error:', e.message);
    }
  }

  async broadcastPlay(targetServerTime, startOffsetSec) {
    if (!this.db || !this.roomId) return;
    try {
      await updateDoc(doc(this.db, 'rooms', this.roomId), {
        state: 'PLAYING',
        targetServerTime,
        startOffsetSec,
        updatedAt: Date.now()
      });
    } catch (e) {
      console.warn('Firestore broadcastPlay notice:', e.message);
    }
  }

  async broadcastPause(currentOffsetSec) {
    if (!this.db || !this.roomId) return;
    try {
      await updateDoc(doc(this.db, 'rooms', this.roomId), {
        state: 'PAUSED',
        startOffsetSec: currentOffsetSec,
        updatedAt: Date.now()
      });
    } catch (e) {
      console.warn('Firestore broadcastPause notice:', e.message);
    }
  }

  async broadcastTrack(metadata) {
    if (!this.db || !this.roomId) return;
    try {
      await updateDoc(doc(this.db, 'rooms', this.roomId), {
        track: metadata,
        updatedAt: Date.now()
      });
    } catch (e) {
      console.warn('Firestore broadcastTrack notice:', e.message);
    }
  }

  async updateLatencyOffset(offsetMs) {
    if (!this.db || !this.roomId || !this.peerId) return;
    try {
      const roomRef = doc(this.db, 'rooms', this.roomId);
      const snap = await getDoc(roomRef);
      if (snap.exists()) {
        const peers = snap.data().peers || {};
        if (peers[this.peerId]) {
          peers[this.peerId].latencyOffset = offsetMs;
          await updateDoc(roomRef, { peers });
        }
      }
    } catch (e) {}
  }

  startHeartbeat(deviceName) {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(async () => {
      if (!this.db || !this.roomId || !this.peerId) return;
      try {
        const roomRef = doc(this.db, 'rooms', this.roomId);
        const snap = await getDoc(roomRef);
        if (snap.exists()) {
          const peers = snap.data().peers || {};
          if (peers[this.peerId]) {
            peers[this.peerId].lastSeen = Date.now();
            await updateDoc(roomRef, { peers });
          }
        }
      } catch (e) {}
    }, 10000);
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  unsubscribe() {
    if (this.unsubscribeRoom) {
      this.unsubscribeRoom();
      this.unsubscribeRoom = null;
    }
    this.stopHeartbeat();
  }
}
