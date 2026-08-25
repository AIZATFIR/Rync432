import { firebaseAuth } from '../auth/FirebaseAuth.js';
import { 
  getFirestore, 
  doc, 
  setDoc, 
  getDoc, 
  onSnapshot, 
  updateDoc, 
  collection, 
  addDoc,
  deleteDoc
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
    this.unsubscribePeers = null;
    this.unsubscribeSignals = null;
    this.roomId = null;
    this.peerId = null;
    this.isHost = false;
    this.heartbeatInterval = null;
    this.broadcastChannel = null;
    this.localPeersMap = new Map();
    
    // WebRTC P2P Connections
    this.peerConnections = new Map();
    this.dataChannels = new Map();
    this.incomingAudioChunks = new Map();
    this.currentAudioArrayBuffer = null;
  }

  async init() {
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
    await this.init();

    this.initBroadcastChannel(roomId, deviceName);

    const roomData = {
      roomId,
      hostId: peerId,
      state: 'IDLE',
      track: null,
      targetServerTime: 0,
      startOffsetSec: 0,
      updatedAt: Date.now()
    };

    if (this.db) {
      try {
        await setDoc(doc(this.db, 'rooms', roomId), roomData);
        await setDoc(doc(this.db, 'rooms', roomId, 'peers', peerId), {
          id: peerId,
          deviceName,
          isHost: true,
          role: 'stereo',
          volume: 1.0,
          latencyOffset: 0,
          lastSeen: Date.now()
        });
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
    await this.init();

    this.initBroadcastChannel(roomId, deviceName);

    if (this.db) {
      try {
        await setDoc(doc(this.db, 'rooms', roomId, 'peers', peerId), {
          id: peerId,
          deviceName,
          isHost: false,
          role: 'stereo',
          volume: 1.0,
          latencyOffset: 0,
          lastSeen: Date.now()
        });
      } catch (err) {
        console.warn('Firestore peer join notice:', err.message);
      }
    }

    this.subscribe(roomId);
    this.subscribeSignals(roomId);
    this.startHeartbeat(deviceName);
  }

  initBroadcastChannel(roomId, deviceName) {
    if (typeof BroadcastChannel === 'undefined') return;
    if (this.broadcastChannel) {
      try { this.broadcastChannel.close(); } catch (e) {}
    }
    this.broadcastChannel = new BroadcastChannel('rync432_' + roomId);
    this.localPeersMap.clear();
    this.localPeersMap.set(this.peerId, {
      id: this.peerId,
      deviceName,
      isHost: this.isHost,
      role: 'stereo',
      volume: 1.0,
      latencyOffset: 0,
      lastSeen: Date.now()
    });

    this.broadcastChannel.onmessage = (event) => {
      const msg = event.data;
      if (!msg || !msg.type) return;

      switch (msg.type) {
        case 'ANNOUNCE_PEER':
          this.localPeersMap.set(msg.peer.id, msg.peer);
          this.dispatchLocalPeers();
          if (this.broadcastChannel) {
            this.broadcastChannel.postMessage({
              type: 'PEER_PONG',
              peer: this.localPeersMap.get(this.peerId)
            });
          }
          break;

        case 'PEER_PONG':
          this.localPeersMap.set(msg.peer.id, msg.peer);
          this.dispatchLocalPeers();
          break;

        case 'PEER_LEFT':
          this.localPeersMap.delete(msg.peerId);
          this.dispatchLocalPeers();
          break;

        case 'SCHEDULED_PLAY':
          this.onEvent('SCHEDULED_PLAY', msg.payload);
          break;

        case 'PAUSED':
          this.onEvent('PAUSED', msg.payload);
          break;

        case 'TRACK_METADATA':
          this.onEvent('TRACK_METADATA', msg.payload);
          break;

        case 'REMOTE_DEVICE_UPDATED':
          if (msg.targetPeerId === this.peerId) {
            this.onEvent('REMOTE_DEVICE_UPDATED', msg.payload);
          }
          break;
      }
    };

    // Announce presence
    this.broadcastChannel.postMessage({
      type: 'ANNOUNCE_PEER',
      peer: this.localPeersMap.get(this.peerId)
    });
    this.dispatchLocalPeers();
  }

  dispatchLocalPeers() {
    const peers = Array.from(this.localPeersMap.values());
    this.onEvent('PEER_JOINED', { peers, peerCount: peers.length });
  }

  subscribe(roomId) {
    this.unsubscribe();
    if (!this.db) return;

    try {
      // 1. Listen to Room State (Track, Play/Pause)
      this.unsubscribeRoom = onSnapshot(doc(this.db, 'rooms', roomId), (docSnap) => {
        if (!docSnap.exists()) return;
        const data = docSnap.data();

        if (data.track) {
          this.onEvent('TRACK_METADATA', data.track);
          if (!this.isHost && data.track.audioUrl) {
            this.fetchRemoteAudioUrl(data.track.audioUrl, data.track.name);
          }
        }

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
      }, (err) => console.warn('Room onSnapshot notice:', err.message));

      // 2. Listen to Peers Subcollection (Real-time presence & count)
      this.unsubscribePeers = onSnapshot(collection(this.db, 'rooms', roomId, 'peers'), (querySnapshot) => {
        const peersList = [];
        querySnapshot.forEach((docSnap) => {
          const peer = docSnap.data();
          peersList.push(peer);

          // Merge with local map
          this.localPeersMap.set(peer.id, peer);

          if (peer.id === this.peerId) {
            this.onEvent('REMOTE_DEVICE_UPDATED', {
              role: peer.role || 'stereo',
              volume: peer.volume !== undefined ? peer.volume : 1.0
            });
          }
        });

        this.dispatchLocalPeers();

        // If Host, connect WebRTC offer to new peers
        if (this.isHost) {
          peersList.forEach(peer => {
            if (peer.id !== this.peerId && !this.peerConnections.has(peer.id)) {
              this.initiateWebRTCOffer(peer.id);
            }
          });
        }
      }, (err) => console.warn('Peers onSnapshot notice:', err.message));

    } catch (e) {
      console.warn('Firestore subscribe error:', e.message);
    }
  }

  async updateRemotePeerSettings(targetPeerId, role, volume) {
    const peer = this.localPeersMap.get(targetPeerId);
    if (peer) {
      peer.role = role;
      peer.volume = volume;
      this.dispatchLocalPeers();
    }

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'REMOTE_DEVICE_UPDATED',
        targetPeerId,
        payload: { role, volume }
      });
    }

    if (this.db && this.roomId) {
      try {
        await updateDoc(doc(this.db, 'rooms', this.roomId, 'peers', targetPeerId), {
          role,
          volume: volume !== undefined ? volume : 1.0,
          updatedAt: Date.now()
        });
      } catch (e) {}
    }
  }

  async fetchRemoteAudioUrl(url, trackName) {
    this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 10, status: `Mengunduh ${trackName}...` });
    try {
      const response = await fetch(url);
      const arrayBuffer = await response.arrayBuffer();
      this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 100, status: 'Audio siap!' });
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
      this.dataChannels.set(targetPeerId, channel);
      if (this.currentAudioArrayBuffer) {
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

      if (event.data instanceof ArrayBuffer) {
        const stream = this.incomingAudioChunks.get(targetPeerId);
        if (stream) {
          stream.chunks.push(event.data);
          stream.receivedBytes += event.data.byteLength;
          const pct = Math.min(99, Math.round((stream.receivedBytes / stream.totalBytes) * 100));
          this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct, status: `Menerima P2P (${pct}%)...` });

          if (stream.chunks.length >= stream.totalChunks || stream.receivedBytes >= stream.totalBytes) {
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
      }, () => {});
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
      console.warn('Signal error:', e.message);
    }
  }

  streamAudioToAllPeers(arrayBuffer, trackName = 'Uploaded Track') {
    this.currentAudioArrayBuffer = arrayBuffer;
    this.dataChannels.forEach((channel) => {
      if (channel.readyState === 'open') {
        this.streamAudioToPeer(channel, arrayBuffer, trackName);
      }
    });
  }

  streamAudioToPeer(channel, arrayBuffer, trackName = 'Uploaded Track') {
    const chunkSize = 64 * 1024;
    const totalBytes = arrayBuffer.byteLength;
    const totalChunks = Math.ceil(totalBytes / chunkSize);

    channel.send(JSON.stringify({
      type: 'AUDIO_HEADER',
      name: trackName,
      totalBytes,
      totalChunks
    }));

    for (let offset = 0; offset < totalBytes; offset += chunkSize) {
      const chunk = arrayBuffer.slice(offset, offset + chunkSize);
      channel.send(chunk);
    }
  }

  async uploadAudioFileToStorage(file, duration) {
    if (!this.storage || !this.roomId) return;
    
    this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 15, status: `Upload ${file.name}...` });
    try {
      const storageRef = ref(this.storage, `rooms/${this.roomId}/track_${Date.now()}_${file.name}`);
      const uploadTask = uploadBytesResumable(storageRef, file);

      uploadTask.on('state_changed', 
        (snapshot) => {
          const progress = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100);
          this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: progress, status: `Upload Cloud (${progress}%)...` });
        },
        (error) => {
          console.warn('Storage upload error:', error.message);
        },
        async () => {
          const downloadUrl = await getDownloadURL(uploadTask.snapshot.ref);
          await this.broadcastTrack({
            name: file.name,
            duration,
            audioUrl: downloadUrl
          });
          this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 100, status: 'Audio siap di semua speaker!' });
        }
      );
    } catch (e) {
      console.warn('Storage upload exception:', e.message);
    }
  }

  // Democratic Playback broadcast (Any member can call)
  async broadcastPlay(targetServerTime, startOffsetSec) {
    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'SCHEDULED_PLAY',
        payload: { targetServerTime, startOffsetSec }
      });
    }

    if (this.db && this.roomId) {
      try {
        await updateDoc(doc(this.db, 'rooms', this.roomId), {
          state: 'PLAYING',
          targetServerTime,
          startOffsetSec,
          updatedAt: Date.now()
        });
      } catch (e) {}
    }
  }

  async broadcastPause(currentOffsetSec) {
    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'PAUSED',
        payload: { currentOffsetSec }
      });
    }

    if (this.db && this.roomId) {
      try {
        await updateDoc(doc(this.db, 'rooms', this.roomId), {
          state: 'PAUSED',
          startOffsetSec: currentOffsetSec,
          updatedAt: Date.now()
        });
      } catch (e) {}
    }
  }

  async broadcastTrack(metadata) {
    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'TRACK_METADATA',
        payload: metadata
      });
    }

    if (this.db && this.roomId) {
      try {
        await updateDoc(doc(this.db, 'rooms', this.roomId), {
          track: metadata,
          updatedAt: Date.now()
        });
      } catch (e) {}
    }
  }

  async updateLatencyOffset(offsetMs) {
    if (this.db && this.roomId && this.peerId) {
      try {
        await updateDoc(doc(this.db, 'rooms', this.roomId, 'peers', this.peerId), {
          latencyOffset: offsetMs,
          lastSeen: Date.now()
        });
      } catch (e) {}
    }
  }

  startHeartbeat(deviceName) {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(async () => {
      if (this.db && this.roomId && this.peerId) {
        try {
          await updateDoc(doc(this.db, 'rooms', this.roomId, 'peers', this.peerId), {
            lastSeen: Date.now()
          });
        } catch (e) {}
      }
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
    if (this.unsubscribePeers) {
      this.unsubscribePeers();
      this.unsubscribePeers = null;
    }
    if (this.unsubscribeSignals) {
      this.unsubscribeSignals();
      this.unsubscribeSignals = null;
    }
    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.postMessage({
          type: 'PEER_LEFT',
          peerId: this.peerId
        });
        this.broadcastChannel.close();
      } catch (e) {}
      this.broadcastChannel = null;
    }
    this.stopHeartbeat();
  }
}
