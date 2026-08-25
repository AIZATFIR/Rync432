import { firebaseAuth } from '../auth/FirebaseAuth.js';
import { 
  getFirestore, 
  doc, 
  setDoc, 
  getDoc, 
  onSnapshot, 
  updateDoc, 
  collection, 
  addDoc 
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { 
  getStorage, 
  ref, 
  uploadBytesResumable, 
  getDownloadURL 
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';

export class CloudMesh {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.db = null;
    this.storage = null;
    this.unsubscribeRoom = null;
    this.roomId = null;
    this.peerId = null;
    this.isHost = false;
    this.heartbeatInterval = null;
    
    // WebRTC P2P Connections
    this.peerConnections = new Map(); // peerId -> RTCPeerConnection
    this.dataChannels = new Map();    // peerId -> RTCDataChannel
    this.incomingAudioChunks = new Map(); // senderId -> { chunks: [], total: 0, received: 0, name: '' }
    this.unsubscribeSignals = null;
    this.currentAudioArrayBuffer = null;
  }

  init() {
    try {
      if (firebaseAuth.app) {
        this.db = getFirestore(firebaseAuth.app);
        this.storage = getStorage(firebaseAuth.app);
      }
    } catch (e) {
      console.warn('Firestore/Storage init notice:', e.message);
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
        console.warn('Firestore room create notice:', err.message);
      }
    }

    this.subscribe(roomId);
    this.subscribeSignals(roomId);
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
        console.warn('Firestore room join notice:', err.message);
      }
    }

    this.subscribe(roomId);
    this.subscribeSignals(roomId);
    this.startHeartbeat(deviceName);
  }

  subscribe(roomId) {
    this.unsubscribe();
    if (!this.db) return;

    try {
      this.unsubscribeRoom = onSnapshot(doc(this.db, 'rooms', roomId), (docSnap) => {
        if (!docSnap.exists()) return;
        const data = docSnap.data();

        // 1. Update Peer List & connect WebRTC to new peers if Host
        if (data.peers) {
          const peersArray = Object.values(data.peers);
          this.onEvent('PEER_JOINED', {
            peers: peersArray,
            peerCount: peersArray.length
          });

          if (this.isHost) {
            peersArray.forEach(peer => {
              if (peer.id !== this.peerId && !this.peerConnections.has(peer.id)) {
                this.initiateWebRTCOffer(peer.id);
              }
            });
          }
        }

        // 2. Track Metadata & Audio URL
        if (data.track) {
          this.onEvent('TRACK_METADATA', data.track);

          // If satellite device does not have the audio yet, fetch from audioUrl
          if (!this.isHost && data.track.audioUrl) {
            this.fetchRemoteAudioUrl(data.track.audioUrl, data.track.name);
          }
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

  async fetchRemoteAudioUrl(url, trackName) {
    this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 10, status: `Mengunduh ${trackName}...` });
    try {
      const response = await fetch(url);
      const arrayBuffer = await response.arrayBuffer();
      this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 100, status: 'Decoding audio...' });
      this.onEvent('BINARY_AUDIO_RECEIVED', arrayBuffer);
    } catch (err) {
      console.warn('Failed to fetch audio from URL:', err.message);
    }
  }

  // --- WebRTC P2P DataChannel Implementation ---
  createPeerConnection(targetPeerId) {
    const config = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };

    const pc = new RTCPeerConnection(config);

    pc.onicecandidate = (event) => {
      if (event.candidate && this.db) {
        this.sendSignal(targetPeerId, {
          type: 'candidate',
          candidate: event.candidate.toJSON()
        });
      }
    };

    pc.ondatachannel = (event) => {
      this.setupDataChannel(targetPeerId, event.channel);
    };

    this.peerConnections.set(targetPeerId, pc);
    return pc;
  }

  setupDataChannel(targetPeerId, channel) {
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      console.log(`WebRTC DataChannel OPEN with peer: ${targetPeerId}`);
      this.dataChannels.set(targetPeerId, channel);

      // If Host has audio ready, stream it directly to the newly connected peer!
      if (this.isHost && this.currentAudioArrayBuffer) {
        this.streamAudioToPeer(channel, this.currentAudioArrayBuffer);
      }
    };

    channel.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'AUDIO_HEADER') {
            this.incomingAudioChunks.set(targetPeerId, {
              name: msg.name,
              totalBytes: msg.totalBytes,
              totalChunks: msg.totalChunks,
              receivedBytes: 0,
              chunks: []
            });
            this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 0, status: `Menerima ${msg.name} P2P...` });
          }
        } catch (e) {}
        return;
      }

      // Binary Chunk
      if (event.data instanceof ArrayBuffer) {
        const stream = this.incomingAudioChunks.get(targetPeerId);
        if (stream) {
          stream.chunks.push(event.data);
          stream.receivedBytes += event.data.byteLength;
          const pct = Math.min(99, Math.round((stream.receivedBytes / stream.totalBytes) * 100));
          this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct, status: `Menerima audio P2P (${pct}%)...` });

          if (stream.chunks.length >= stream.totalChunks || stream.receivedBytes >= stream.totalBytes) {
            // Merge all chunks
            const completeBuffer = new Uint8Array(stream.receivedBytes);
            let offset = 0;
            for (const c of stream.chunks) {
              completeBuffer.set(new Uint8Array(c), offset);
              offset += c.byteLength;
            }
            this.incomingAudioChunks.delete(targetPeerId);
            this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 100, status: 'Audio P2P Siap!' });
            this.onEvent('BINARY_AUDIO_RECEIVED', completeBuffer.buffer);
          }
        }
      }
    };

    channel.onclose = () => {
      this.dataChannels.delete(targetPeerId);
    };
  }

  async initiateWebRTCOffer(targetPeerId) {
    const pc = this.createPeerConnection(targetPeerId);
    const channel = pc.createDataChannel('audioMesh', { ordered: true });
    this.setupDataChannel(targetPeerId, channel);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.sendSignal(targetPeerId, {
        type: 'offer',
        sdp: pc.localDescription.toJSON()
      });
    } catch (e) {
      console.warn('WebRTC offer error:', e.message);
    }
  }

  async sendSignal(targetPeerId, signalData) {
    if (!this.db || !this.roomId) return;
    try {
      await addDoc(collection(this.db, 'rooms', this.roomId, 'signals'), {
        from: this.peerId,
        to: targetPeerId,
        data: signalData,
        createdAt: Date.now()
      });
    } catch (e) {}
  }

  subscribeSignals(roomId) {
    if (!this.db) return;
    try {
      this.unsubscribeSignals = onSnapshot(collection(this.db, 'rooms', roomId, 'signals'), async (snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
          if (change.type === 'added') {
            const signal = change.doc.data();
            if (signal.to === this.peerId) {
              await this.handleIncomingSignal(signal.from, signal.data);
            }
          }
        });
      });
    } catch (e) {}
  }

  async handleIncomingSignal(fromPeerId, signalData) {
    let pc = this.peerConnections.get(fromPeerId);
    if (!pc) {
      pc = this.createPeerConnection(fromPeerId);
    }

    try {
      if (signalData.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signalData.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this.sendSignal(fromPeerId, {
          type: 'answer',
          sdp: pc.localDescription.toJSON()
        });
      } else if (signalData.type === 'answer') {
        if (pc.signalingState !== 'stable') {
          await pc.setRemoteDescription(new RTCSessionDescription(signalData.sdp));
        }
      } else if (signalData.type === 'candidate') {
        if (signalData.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(signalData.candidate));
        }
      }
    } catch (e) {
      console.warn('Signal handling error:', e.message);
    }
  }

  // Stream Binary Audio via WebRTC DataChannels (64KB chunks)
  streamAudioToAllPeers(arrayBuffer, trackName = 'Uploaded Track') {
    this.currentAudioArrayBuffer = arrayBuffer;
    this.dataChannels.forEach((channel) => {
      if (channel.readyState === 'open') {
        this.streamAudioToPeer(channel, arrayBuffer, trackName);
      }
    });
  }

  streamAudioToPeer(channel, arrayBuffer, trackName = 'Uploaded Track') {
    const chunkSize = 64 * 1024; // 64KB chunks
    const totalBytes = arrayBuffer.byteLength;
    const totalChunks = Math.ceil(totalBytes / chunkSize);

    // Send header first
    channel.send(JSON.stringify({
      type: 'AUDIO_HEADER',
      name: trackName,
      totalBytes,
      totalChunks
    }));

    // Stream chunks with small pacing delay
    let chunkIndex = 0;
    for (let offset = 0; offset < totalBytes; offset += chunkSize) {
      const chunk = arrayBuffer.slice(offset, offset + chunkSize);
      channel.send(chunk);
      chunkIndex++;
    }
  }

  // Upload to Firebase Storage as Cloud Download Fallback
  async uploadAudioFileToStorage(file, duration) {
    if (!this.storage || !this.roomId) return;
    
    this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 15, status: `Mengunggah ${file.name} ke Cloud...` });
    try {
      const storageRef = ref(this.storage, `rooms/${this.roomId}/track_${Date.now()}_${file.name}`);
      const uploadTask = uploadBytesResumable(storageRef, file);

      uploadTask.on('state_changed', 
        (snapshot) => {
          const progress = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100);
          this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: progress, status: `Mengunggah ke Cloud (${progress}%)...` });
        },
        (error) => {
          console.warn('Storage upload error:', error.message);
        },
        async () => {
          const downloadUrl = await getDownloadURL(uploadTask.snapshot.ref);
          console.log('Firebase Storage download URL generated:', downloadUrl);
          
          await this.broadcastTrack({
            name: file.name,
            duration,
            audioUrl: downloadUrl
          });
          this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 100, status: 'Audio siap di seluruh perangkat!' });
        }
      );
    } catch (e) {
      console.warn('Storage upload exception:', e.message);
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
    if (this.unsubscribeSignals) {
      this.unsubscribeSignals();
      this.unsubscribeSignals = null;
    }
    this.stopHeartbeat();
  }
}
