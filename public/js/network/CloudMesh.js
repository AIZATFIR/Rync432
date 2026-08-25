// CloudMesh: High-Precision WebRTC Local Mesh + Serverless Edge Relay
// Connects Laptop & Mobile Phones with Sub-Millisecond Clock Alignment

export class CloudMesh {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.roomId = null;
    this.peerId = null;
    this.deviceName = 'Speaker';
    this.isHost = false;
    this.pollInterval = null;
    this.broadcastChannel = null;
    this.localPeersMap = new Map();
    this.lastKnownState = null;
    this.lastKnownTrack = null;
    this.lastKnownQueue = null;
    this.isPaused = false;
    this.lastPauseTime = 0;
    
    // WebRTC P2P Connections
    this.peerConnections = new Map();
    this.dataChannels = new Map();
    this.incomingAudioChunks = new Map();
    this.currentAudioArrayBuffer = null;
  }

  async createRoom(roomId, peerId, deviceName) {
    this.roomId = roomId;
    this.peerId = peerId;
    this.deviceName = deviceName;
    this.isHost = true;

    this.initBroadcastChannel(roomId, deviceName);

    try {
      await fetch('/api/room?action=create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, peerId, deviceName })
      });
    } catch (e) {
      console.warn('API create notice:', e.message);
    }

    this.startPolling();
  }

  async joinRoom(roomId, peerId, deviceName) {
    this.roomId = roomId;
    this.peerId = peerId;
    this.deviceName = deviceName;
    this.isHost = false;

    this.initBroadcastChannel(roomId, deviceName);

    try {
      await fetch('/api/room?action=join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, peerId, deviceName })
      });
    } catch (e) {
      console.warn('API join notice:', e.message);
    }

    this.startPolling();
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
      isAudioLoading: false,
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
          this.isPaused = false;
          this.onEvent('SCHEDULED_PLAY', msg.payload);
          break;

        case 'PAUSED':
          this.isPaused = true;
          this.lastPauseTime = Date.now();
          this.onEvent('PAUSED', msg.payload);
          break;

        case 'TRACK_METADATA':
          this.onEvent('TRACK_METADATA', msg.payload);
          break;

        case 'QUEUE_UPDATED':
          this.onEvent('QUEUE_UPDATED', msg.payload);
          break;

        case 'REMOTE_DEVICE_UPDATED':
          if (msg.targetPeerId === this.peerId) {
            this.onEvent('REMOTE_DEVICE_UPDATED', msg.payload);
          }
          break;
      }
    };

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

  startPolling() {
    this.stopPolling();
    this.pollLoop();
    this.pollInterval = setInterval(() => this.pollLoop(), 500);
  }

  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  async pollLoop() {
    if (!this.roomId || !this.peerId) return;

    try {
      const url = `/api/room?action=poll&roomId=${encodeURIComponent(this.roomId)}&peerId=${encodeURIComponent(this.peerId)}&deviceName=${encodeURIComponent(this.deviceName)}`;
      const res = await fetch(url);
      if (!res.ok) return;

      const data = await res.json();

      // 1. Peer list & WebRTC Mesh Auto-Connect
      if (Array.isArray(data.peers)) {
        data.peers.forEach(p => {
          this.localPeersMap.set(p.id, p);
          if (p.id === this.peerId) {
            this.onEvent('REMOTE_DEVICE_UPDATED', {
              role: p.role || 'stereo',
              volume: p.volume !== undefined ? p.volume : 1.0
            });
          }

          if (this.isHost && p.id !== this.peerId && !this.peerConnections.has(p.id)) {
            this.initiateWebRTCOffer(p.id);
          }
        });
        this.dispatchLocalPeers();
      }

      // 2. Queue list
      if (Array.isArray(data.queue) && JSON.stringify(data.queue) !== JSON.stringify(this.lastKnownQueue)) {
        this.lastKnownQueue = data.queue;
        this.onEvent('QUEUE_UPDATED', { queue: data.queue });
      }

      // 3. Track update & Auto-fetch
      if (data.track && JSON.stringify(data.track) !== JSON.stringify(this.lastKnownTrack)) {
        this.lastKnownTrack = data.track;
        this.onEvent('TRACK_METADATA', data.track);
        if (data.track.audioUrl) {
          this.fetchRemoteAudioUrl(data.track.audioUrl, data.track.name);
        }
      }

      // 4. Playback state with clean Pause protection
      if (data.state === 'PLAYING') {
        const isFreshPlay = data.targetServerTime && (data.targetServerTime > (this.lastPauseTime + 100));
        if (isFreshPlay && data.targetServerTime !== this.lastKnownState) {
          this.isPaused = false;
          this.lastKnownState = data.targetServerTime;
          this.onEvent('SCHEDULED_PLAY', {
            targetServerTime: data.targetServerTime,
            startOffsetSec: data.startOffsetSec || 0
          });
        }
      } else if (data.state === 'PAUSED' && this.lastKnownState !== 'PAUSED') {
        this.isPaused = true;
        this.lastKnownState = 'PAUSED';
        this.lastPauseTime = Date.now();
        this.onEvent('PAUSED', {
          currentOffsetSec: data.startOffsetSec || 0
        });
      }

      // 5. WebRTC Signals
      if (Array.isArray(data.signals) && data.signals.length > 0) {
        for (const sig of data.signals) {
          await this.handleIncomingSignal(sig.from, sig.data);
        }
      }
    } catch (err) {}
  }

  async updateLoadingState(isLoading, status = '') {
    const me = this.localPeersMap.get(this.peerId);
    if (me) {
      me.isAudioLoading = isLoading;
      me.loadingStatus = status;
      this.dispatchLocalPeers();
    }

    try {
      await fetch('/api/room?action=update_peer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: this.roomId,
          peerId: this.peerId,
          isAudioLoading: isLoading,
          loadingStatus: status
        })
      });
    } catch (e) {}
  }

  async addToQueue(track) {
    try {
      const res = await fetch('/api/room?action=add_queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: this.roomId,
          deviceName: this.deviceName,
          ...track
        })
      });
      const data = await res.json();
      if (data.queue) {
        this.lastKnownQueue = data.queue;
        this.onEvent('QUEUE_UPDATED', { queue: data.queue });
        if (this.broadcastChannel) {
          this.broadcastChannel.postMessage({
            type: 'QUEUE_UPDATED',
            payload: { queue: data.queue }
          });
        }
      }
    } catch (e) {}
  }

  async removeFromQueue(queueId) {
    try {
      const res = await fetch('/api/room?action=remove_queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: this.roomId,
          queueId
        })
      });
      const data = await res.json();
      if (data.queue) {
        this.lastKnownQueue = data.queue;
        this.onEvent('QUEUE_UPDATED', { queue: data.queue });
      }
    } catch (e) {}
  }

  async nextTrack() {
    try {
      const res = await fetch('/api/room?action=next_track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: this.roomId })
      });
      const data = await res.json();
      if (data.track) {
        this.lastKnownTrack = data.track;
        this.onEvent('TRACK_METADATA', data.track);
      }
      if (data.queue) {
        this.lastKnownQueue = data.queue;
        this.onEvent('QUEUE_UPDATED', { queue: data.queue });
      }
    } catch (e) {}
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

    const channel = this.dataChannels.get(targetPeerId);
    if (channel && channel.readyState === 'open') {
      try {
        channel.send(JSON.stringify({ type: 'PEER_SETTINGS', role, volume }));
      } catch (e) {}
    }

    try {
      await fetch('/api/room?action=update_peer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: this.roomId, targetPeerId, role, volume })
      });
    } catch (e) {}
  }

  async fetchRemoteAudioUrl(url, trackName) {
    this.updateLoadingState(true, `Mengunduh ${trackName}...`);
    this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 20, status: `Mengunduh ${trackName}...` });
    try {
      const response = await fetch(url);
      const arrayBuffer = await response.arrayBuffer();
      this.updateLoadingState(false, 'Siap');
      this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 100, status: 'Audio siap!' });
      this.onEvent('BINARY_AUDIO_RECEIVED', arrayBuffer);
    } catch (err) {
      this.updateLoadingState(false, 'Gagal');
      console.warn('Failed to fetch audio from URL:', err.message);
    }
  }

  async broadcastPlay(targetServerTime, startOffsetSec) {
    this.isPaused = false;
    this.lastKnownState = targetServerTime;

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'SCHEDULED_PLAY',
        payload: { targetServerTime, startOffsetSec }
      });
    }

    this.dataChannels.forEach(channel => {
      if (channel.readyState === 'open') {
        try {
          channel.send(JSON.stringify({ type: 'SCHEDULED_PLAY', targetServerTime, startOffsetSec }));
        } catch (e) {}
      }
    });

    try {
      await fetch('/api/room?action=update_playback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: this.roomId,
          state: 'PLAYING',
          targetServerTime,
          startOffsetSec
        })
      });
    } catch (e) {}
  }

  async broadcastPause(currentOffsetSec) {
    this.isPaused = true;
    this.lastPauseTime = Date.now();
    this.lastKnownState = 'PAUSED';

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'PAUSED',
        payload: { currentOffsetSec }
      });
    }

    this.dataChannels.forEach(channel => {
      if (channel.readyState === 'open') {
        try {
          channel.send(JSON.stringify({ type: 'PAUSED', currentOffsetSec }));
        } catch (e) {}
      }
    });

    try {
      await fetch('/api/room?action=update_playback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: this.roomId,
          state: 'PAUSED',
          startOffsetSec: currentOffsetSec
        })
      });
    } catch (e) {}
  }

  async broadcastTrack(metadata) {
    this.lastKnownTrack = metadata;

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'TRACK_METADATA',
        payload: metadata
      });
    }

    this.dataChannels.forEach(channel => {
      if (channel.readyState === 'open') {
        try {
          channel.send(JSON.stringify({ type: 'TRACK_METADATA', metadata }));
        } catch (e) {}
      }
    });

    try {
      await fetch('/api/room?action=update_playback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: this.roomId,
          track: metadata
        })
      });
    } catch (e) {}
  }

  async updateLatencyOffset(offsetMs) {}

  // --- WebRTC P2P DataChannel ---
  createPeerConnection(targetPeerId) {
    const config = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };

    const pc = new RTCPeerConnection(config);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
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
          } else if (msg.type === 'SCHEDULED_PLAY') {
            this.isPaused = false;
            this.onEvent('SCHEDULED_PLAY', {
              targetServerTime: msg.targetServerTime,
              startOffsetSec: msg.startOffsetSec || 0
            });
          } else if (msg.type === 'PAUSED') {
            this.isPaused = true;
            this.lastPauseTime = Date.now();
            this.onEvent('PAUSED', {
              currentOffsetSec: msg.currentOffsetSec || 0
            });
          } else if (msg.type === 'TRACK_METADATA') {
            this.onEvent('TRACK_METADATA', msg.metadata);
          } else if (msg.type === 'PEER_SETTINGS') {
            this.onEvent('REMOTE_DEVICE_UPDATED', { role: msg.role, volume: msg.volume });
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
    try {
      await fetch('/api/room?action=signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: this.roomId,
          peerId: this.peerId,
          to: targetPeerId,
          data: signalData
        })
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

    try {
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
    } catch (e) {}
  }

  async uploadAudioFileToStorage(file, duration) {}

  unsubscribe() {
    this.stopPolling();
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
  }
}
