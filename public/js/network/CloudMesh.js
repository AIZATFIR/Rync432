// CloudMesh: High-Precision WebRTC Local Mesh + Serverless Edge Relay
// Connects Laptop & Mobile Phones with Sub-Millisecond Clock Alignment

const P2P_AUDIO_CHUNK_BYTES = 32 * 1024;
const P2P_AUDIO_FRAME_HEADER_BYTES = 12;
const MAX_P2P_AUDIO_BYTES = 64 * 1024 * 1024;
const P2P_AUDIO_TRANSFER_TIMEOUT_MS = 30_000;
const P2P_AUDIO_ACK_TIMEOUT_MS = 10_000;
const P2P_AUDIO_BACKPRESSURE_TIMEOUT_MS = 15_000;
const QUEUE_MUTATION_TIMEOUT_MS = 8_000;
const ROOM_JOIN_TIMEOUT_MS = 8_000;
const AUDIO_ROUTES = new Set(['unknown', 'p2p', 'relay', 'direct', 'youtube', 'local', 'cache']);

async function fetchRoomJoin(url, options) {
  const controller = new AbortController();
  let timeout;
  try {
    const request = (async () => {
      const response = await fetch(url, { ...options, signal: controller.signal });
      return { response, data: await response.json() };
    })();
    return await Promise.race([
      request,
      new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          const error = new Error('ROOM_JOIN_TIMEOUT');
          error.name = 'TimeoutError';
          reject(error);
        }, ROOM_JOIN_TIMEOUT_MS);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchQueueMutation(url, options) {
  const controller = new AbortController();
  let timeout;
  try {
    const request = fetch(url, { ...options, signal: controller.signal });
    return await Promise.race([
      request,
      new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          const error = new Error('QUEUE_MUTATION_TIMEOUT');
          error.name = 'TimeoutError';
          reject(error);
        }, QUEUE_MUTATION_TIMEOUT_MS);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function youtubeVideoId(track) {
  if (!track) return null;
  if (track.sourceType === 'youtube') {
    const sourceId = track.sourceId || track.youtubeVideoId || (track.id?.startsWith('yt_') ? track.id.slice(3) : track.id);
    if (/^[A-Za-z0-9_-]{11}$/.test(sourceId || '')) return sourceId;
  }
  if (track.id?.startsWith('yt_')) {
    const sourceId = track.id.slice(3);
    if (/^[A-Za-z0-9_-]{11}$/.test(sourceId)) return sourceId;
  }
  if (typeof track.audioUrl === 'string' && track.audioUrl.startsWith('/api/yt-stream')) {
    const id = new URL(track.audioUrl, globalThis.location?.origin || 'https://rync.invalid').searchParams.get('id');
    if (/^[A-Za-z0-9_-]{11}$/.test(id || '')) return id;
  }
  return null;
}

export class CloudMesh {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.clockSync = null;
    this.roomId = null;
    this.peerId = null;
    this.deviceName = 'Speaker';
    this.isHost = false;
    this.hostToken = null;
    this.pollInterval = null;
    this.broadcastChannel = null;
    this.localPeersMap = new Map();
    this.lastKnownState = null;
    this.lastKnownOffsetSec = 0;
    this.lastKnownTrack = null;
    this.lastKnownQueue = null;
    this.readinessSync = Promise.resolve();
    this.queueRevision = 0;
    this.isPaused = true;
    this.hostDisconnected = false;
    this.lastPauseTime = 0;
    this.repeatMode = 'off';
    this.shuffle = false;
    this.seenControlRequestIds = new Set();

    // WebRTC P2P Connections
    this.peerConnections = new Map();
    this.dataChannels = new Map();
    this.pendingIceCandidates = new Map();
    this.lastSentBufferPerPeer = new Map();
    this.incomingAudioChunks = new Map();
    this.currentAudioArrayBuffer = null;
    this.localAudioBufferCache = new Map();
    this.audioRouteByTrack = new Map();
    this.queueAdditionAcknowledgements = new Map();
    this.activeBufferTransfers = new WeakSet();
    this.pendingAudioTransferAcks = new Map();
    this.deletedQueueIds = new Set();

    // Real-Time Pub/Sub Cloud Bus (EMQX / MQTT over WebSockets)
    this.mqttClient = null;
    this.isMqttConnected = false;
    this.roomTopic = null;
    this.peerTopic = null;
  }

  hostTokenStorageKey(roomId) {
    return `rync_host_token_${roomId}`;
  }

  serverTimeNow() {
    return this.clockSync?.getServerTime?.() || Date.now();
  }

  loadHostToken(roomId) {
    try { return localStorage.getItem(this.hostTokenStorageKey(roomId)); } catch (error) { return null; }
  }

  saveHostToken(roomId, token) {
    try {
      if (token) localStorage.setItem(this.hostTokenStorageKey(roomId), token);
    } catch (error) { }
  }

  saveLocalQueue(queue) {
    if (!Array.isArray(queue)) return;
    try {
      if (typeof localStorage !== 'undefined') {
        if (this.roomId) localStorage.setItem('rync_queue_' + this.roomId, JSON.stringify(queue));
        localStorage.setItem('rync_last_queue', JSON.stringify(queue));
      }
    } catch (e) {}
  }

  loadLocalQueue(roomId) {
    try {
      if (typeof localStorage !== 'undefined') {
        const saved = (roomId ? localStorage.getItem('rync_queue_' + roomId) : null) || localStorage.getItem('rync_last_queue');
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed;
          }
        }
      }
    } catch (e) {}
    return null;
  }

  async createRoom(roomId, peerId, deviceName) {
    this.roomId = roomId;
    this.peerId = peerId;
    this.deviceName = deviceName;
    this.isHost = true;
    this.hostToken = null;

    // New rooms start with a clean authoritative queue.
    this.initBroadcastChannel(roomId, deviceName);
    this.initMqttBus(roomId, deviceName);

    try {
      const response = await fetch('/api/room?action=create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId,
          peerId,
          deviceName,
          queue: []
        })
      });
      if (!response.ok) throw new Error(`Room creation failed (${response.status})`);
      const result = await response.json();
      if (!result.success || typeof result.hostToken !== 'string') throw new Error(result.error || 'Room creation failed');
      this.hostToken = result.hostToken;
      this.saveHostToken(roomId, this.hostToken);
      this.rememberQueueRevision(result.room);
      this.applyPlaybackOptions(result.room);
      this.broadcastReadiness('READY', '');
      this.startPolling();
      return result.room;
    } catch (error) {
      this.roomId = null;
      this.peerId = null;
      this.isHost = false;
      this.hostToken = null;
      this.onEvent('ROOM_ERROR', { message: 'Room gagal dibuat. Coba lagi.' });
      throw error;
    }
  }

  async joinRoom(roomId, peerId, deviceName) {
    this.roomId = roomId;
    this.peerId = peerId;
    this.deviceName = deviceName;
    this.isHost = false;
    this.hostToken = this.loadHostToken(roomId);

    this.initBroadcastChannel(roomId, deviceName);
    this.initMqttBus(roomId, deviceName);

    try {
      const { response, data } = await fetchRoomJoin('/api/room?action=join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, peerId, deviceName, hostToken: this.hostToken || undefined })
      });
      if (!response.ok || !data.room) throw new Error(data.error || 'Room tidak ditemukan.');
      if (data.room.roomId && data.room.roomId !== roomId) throw new Error('Room response mismatch');
      this.isHost = data.room.isHost === true;
      if (!this.isHost) this.hostToken = null;
      this.applyRoomSnapshot(data.room);
      if (!data.room.track) this.broadcastReadiness('READY', '');
      this.startPolling();
      return data.room;
    } catch (error) {
      this.unsubscribe();
      this.roomId = null;
      this.peerId = null;
      this.isHost = false;
      this.hostToken = null;
      this.onEvent('ROOM_ERROR', { message: 'Room tidak bisa dimasuki. Periksa kode atau koneksi.' });
      throw error;
    }
  }

  applyRoomSnapshot(snapshot) {
    if (!snapshot) return;
    this.rememberQueueRevision(snapshot);
    this.applyPlaybackOptions(snapshot);
    this.setHostDisconnected(snapshot.hostDisconnected === true);
    if (this.isHost) return;
    if (Array.isArray(snapshot.queue)) {
      const queueStr = JSON.stringify(snapshot.queue);
      if (queueStr !== this.lastKnownQueueStr) {
        this.lastKnownQueue = snapshot.queue;
        this.lastKnownQueueStr = queueStr;
        this.saveLocalQueue(snapshot.queue);
        this.onEvent('QUEUE_UPDATED', { queue: snapshot.queue });
      }
    }
    let trackChanged = false;
    if (snapshot.track) {
      if (snapshot.track.sourceType === 'youtube' && !snapshot.track.sourceId) {
        const videoId = youtubeVideoId(snapshot.track);
        if (videoId) snapshot.track.sourceId = videoId;
      }
      trackChanged = !this.lastKnownTrack
        || (snapshot.track.id && this.lastKnownTrack.id
          ? snapshot.track.id !== this.lastKnownTrack.id
          : snapshot.track.name !== this.lastKnownTrack.name);
      if (trackChanged) {
        this.lastKnownTrack = snapshot.track;
        this.onEvent('TRACK_METADATA', snapshot.track);
        this.loadTrackBuffer(snapshot.track);
      }
    }
    const offset = snapshot.startOffsetSec || 0;
    if (snapshot.state === 'PLAYING' && snapshot.targetServerTime) {
      const changed = this.isPaused || this.lastKnownState !== snapshot.targetServerTime || trackChanged;
      this.isPaused = false;
      this.lastKnownState = snapshot.targetServerTime;
      if (changed) {
        this.onEvent('SCHEDULED_PLAY', {
          targetServerTime: snapshot.targetServerTime,
          startOffsetSec: offset,
          track: snapshot.track || this.lastKnownTrack
        });
      }
    } else {
      const changed = !this.isPaused || this.lastKnownState !== 'PAUSED' || this.lastKnownOffsetSec !== offset;
      this.isPaused = true;
      this.lastKnownState = this.serverTimeNow() - (offset * 1000);
      if (changed) this.onEvent('PAUSED', { currentOffsetSec: offset });
    }
    this.lastKnownOffsetSec = offset;
  }

  rememberQueueRevision(snapshot = {}) {
    if (Number.isSafeInteger(snapshot.queueRevision) && snapshot.queueRevision >= 0) {
      this.queueRevision = snapshot.queueRevision;
    }
  }

  setHostDisconnected(disconnected) {
    if (this.hostDisconnected === disconnected) return;
    this.hostDisconnected = disconnected;
    this.onEvent(disconnected ? 'HOST_DISCONNECTED' : 'HOST_RECONNECTED', { roomId: this.roomId });
  }

  applyCanonicalQueue(queue) {
    if (!Array.isArray(queue)) return;
    this.lastKnownQueue = queue;
    this.lastKnownQueueStr = JSON.stringify(queue);
    this.saveLocalQueue(queue);
    this.onEvent('QUEUE_UPDATED', { queue });
  }

  applyPlaybackOptions(snapshot = {}) {
    const repeatMode = ['off', 'all', 'one'].includes(snapshot.repeatMode) ? snapshot.repeatMode : this.repeatMode;
    const shuffle = typeof snapshot.shuffle === 'boolean' ? snapshot.shuffle : this.shuffle;
    if (repeatMode === this.repeatMode && shuffle === this.shuffle) return;
    this.repeatMode = repeatMode;
    this.shuffle = shuffle;
    this.onEvent('PLAYBACK_OPTIONS_UPDATED', { repeatMode, shuffle });
  }

  async updatePlaybackOptions(options = {}) {
    if (!this.isHost) return false;
    const body = { roomId: this.roomId, peerId: this.peerId, hostToken: this.hostToken, ...options };
    const response = await fetch('/api/room?action=playback_options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || 'PLAYBACK_OPTIONS_FAILED');
    this.applyPlaybackOptions(data);
    const payload = { repeatMode: this.repeatMode, shuffle: this.shuffle };
    this.publishMqtt(this.roomTopic, { type: 'PLAYBACK_OPTIONS_UPDATED', ...payload });
    this.broadcastDataChannelMessage({ type: 'PLAYBACK_OPTIONS_UPDATED', ...payload });
    this.broadcastChannel?.postMessage({ type: 'PLAYBACK_OPTIONS_UPDATED', payload });
    return payload;
  }

  initMqttBus(roomId, deviceName) {
    if (typeof mqtt === 'undefined') {
      console.warn('MQTT client script not loaded, running HTTP fallback mesh');
      return;
    }

    try {
      if (this.mqttClient) {
        try { this.mqttClient.end(true); } catch (e) {}
      }

      this.roomTopic = `rync432/v1/room/${roomId}`;
      this.peerTopic = `rync432/v1/peer/${this.peerId}`;

      const brokerUrl = 'wss://broker.emqx.io:8084/mqtt';
      this.mqttClient = mqtt.connect(brokerUrl, {
        clientId: 'rync_' + this.peerId + '_' + Math.random().toString(36).substring(2, 6),
        clean: true,
        connectTimeout: 4000,
        reconnectPeriod: 2000
      });

      this.mqttClient.on('connect', () => {
        this.isMqttConnected = true;

        this.mqttClient.subscribe([this.roomTopic, this.peerTopic], (err) => {
          if (!err) {
            this.publishMqtt(this.roomTopic, {
              type: 'ANNOUNCE_PEER',
              peer: {
                id: this.peerId,
                deviceName: this.deviceName,
                isHost: this.isHost,
                role: 'stereo',
                volume: 1.0,
                latencyOffset: 0,
                isAudioLoading: true,
                readiness: 'PREPARING',
                audioRoute: 'unknown',
                lastSeen: Date.now()
              }
            });
          }
        });
      });

      this.mqttClient.on('message', (topic, message) => {
        try {
          const msg = JSON.parse(message.toString());
          if (!msg || !msg.type) return;
          if (msg.fromPeerId === this.peerId) return; // Skip self

          switch (msg.type) {
            case 'ANNOUNCE_PEER':
              if (msg.peer && msg.peer.id !== this.peerId) {
                this.localPeersMap.set(msg.peer.id, msg.peer);
                this.dispatchLocalPeers();

                if (this.isHost) {
                  this.publishMqtt(`rync432/v1/peer/${msg.peer.id}`, {
                    type: 'ROOM_SNAPSHOT',
                    hostId: this.peerId,
                    track: this.lastKnownTrack,
                    queue: this.lastKnownQueue || [],
      state: this.isPaused ? 'PAUSED' : 'PLAYING',
                    targetServerTime: this.lastKnownState,
                    startOffsetSec: this.lastKnownOffsetSec,
                    repeatMode: this.repeatMode,
                    shuffle: this.shuffle,
                    peers: Array.from(this.localPeersMap.values())
                  });

                  const pc = this.peerConnections.get(msg.peer.id);
                  if (!pc || pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
                    this.initiateWebRTCOffer(msg.peer.id);
                  }
                }
              }
              break;

            case 'ROOM_SNAPSHOT':
              if (!this.isHost) {
                if (Array.isArray(msg.peers)) {
                  msg.peers.forEach(p => {
                    if (p.id !== this.peerId) this.localPeersMap.set(p.id, p);
                  });
                  this.dispatchLocalPeers();
                }
                this.applyRoomSnapshot(msg);
              }
              break;

            case 'SCHEDULED_PLAY':
              this.isPaused = false;
              this.lastKnownState = msg.payload?.targetServerTime || msg.targetServerTime;
              if (msg.payload?.track || msg.track) {
                this.lastKnownTrack = msg.payload?.track || msg.track;
                this.loadTrackBuffer(this.lastKnownTrack);
              }
              this.onEvent('SCHEDULED_PLAY', msg.payload || msg);
              break;

            case 'PAUSED':
              this.isPaused = true;
              this.lastPauseTime = Date.now();
              this.lastKnownOffsetSec = msg.payload?.currentOffsetSec || msg.currentOffsetSec || 0;
              this.lastKnownState = 'PAUSED';
              this.onEvent('PAUSED', msg.payload || msg);
              break;

            case 'TRACK_METADATA':
              this.lastKnownTrack = msg.payload || msg.metadata;
              this.onEvent('TRACK_METADATA', this.lastKnownTrack);
              this.loadTrackBuffer(this.lastKnownTrack);
              break;

            case 'QUEUE_UPDATED':
              if (Array.isArray(msg.queue || msg.payload?.queue)) {
                const q = msg.queue || msg.payload?.queue;
                this.lastKnownQueue = q;
                this.lastKnownQueueStr = JSON.stringify(q);
                this.saveLocalQueue(q);
                this.onEvent('QUEUE_UPDATED', { queue: q });
              }
              break;

            case 'PLAYBACK_OPTIONS_UPDATED':
              this.applyPlaybackOptions(msg.payload || msg);
              break;

            case 'CONTROL_REQUEST':
              this.receiveControlRequest(msg);
              break;

            case 'SIGNAL':
              if (msg.from && msg.data) {
                this.handleIncomingSignal(msg.from, msg.data);
              }
              break;

            case 'REMOTE_DEVICE_UPDATED':
              if (msg.targetPeerId === this.peerId) {
                this.onEvent('REMOTE_DEVICE_UPDATED', msg.payload);
              }
              break;

            case 'PEER_READINESS':
              if (msg.peerId && this.localPeersMap.has(msg.peerId)) {
                const p = this.localPeersMap.get(msg.peerId);
                p.readiness = msg.readiness || 'READY';
                p.isAudioLoading = (msg.readiness === 'PREPARING');
                if (AUDIO_ROUTES.has(msg.audioRoute)) p.audioRoute = msg.audioRoute;
                this.dispatchLocalPeers();
              }
              break;

            case 'PEER_LEFT':
              if (msg.peerId) {
                this.localPeersMap.delete(msg.peerId);
                this.dispatchLocalPeers();
              }
              break;
          }
        } catch (e) {}
      });

      this.mqttClient.on('error', (err) => {
        console.warn('MQTT bus notice, fallback active:', err.message);
        if (!this.isMqttConnected) this.startPolling();
      });

      this.mqttClient.on('close', () => {
        this.isMqttConnected = false;
        this.startPolling();
      });
    } catch (err) {
      console.warn('MQTT bus initialization notice:', err.message);
      this.startPolling();
    }
  }

  publishMqtt(topic, payload) {
    if (this.mqttClient && this.isMqttConnected) {
      try {
        const fullPayload = { ...payload, fromPeerId: this.peerId };
        this.mqttClient.publish(topic, JSON.stringify(fullPayload));
      } catch (e) {}
    }
  }

  initBroadcastChannel(roomId, deviceName) {
    if (typeof BroadcastChannel === 'undefined') return;
    if (this.broadcastChannel) {
      try { this.broadcastChannel.close(); } catch (e) { }
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
      isAudioLoading: true,
      readiness: 'PREPARING',
      audioRoute: 'unknown',
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
            if (this.isHost) {
              this.broadcastChannel.postMessage({
                type: 'ROOM_SNAPSHOT',
                track: this.lastKnownTrack,
                queue: this.lastKnownQueue || [],
                state: this.isPaused ? 'PAUSED' : 'PLAYING',
                targetServerTime: this.isPaused ? null : this.lastKnownState,
                startOffsetSec: this.lastKnownOffsetSec,
                repeatMode: this.repeatMode,
                shuffle: this.shuffle
              });
            }
          }
          break;

        case 'ROOM_SNAPSHOT':
          this.applyRoomSnapshot(msg);
          break;

        case 'PEER_PONG':
          this.localPeersMap.set(msg.peer.id, msg.peer);
          this.dispatchLocalPeers();
          break;

        case 'PEER_READINESS':
          if (msg.peerId && this.localPeersMap.has(msg.peerId)) {
            const p = this.localPeersMap.get(msg.peerId);
            p.readiness = msg.readiness || 'READY';
            p.isAudioLoading = (msg.readiness === 'PREPARING');
            if (AUDIO_ROUTES.has(msg.audioRoute)) p.audioRoute = msg.audioRoute;
            this.dispatchLocalPeers();
          }
          break;

        case 'PEER_LEFT':
          this.localPeersMap.delete(msg.peerId);
          this.dispatchLocalPeers();
          break;

        case 'SCHEDULED_PLAY':
          this.isPaused = false;
          this.lastKnownState = msg.payload?.targetServerTime;
          if (msg.payload?.track) {
            this.lastKnownTrack = msg.payload.track;
            this.loadTrackBuffer(this.lastKnownTrack);
          }
          this.onEvent('SCHEDULED_PLAY', msg.payload);
          break;

        case 'PAUSED':
          this.isPaused = true;
          this.lastPauseTime = Date.now();
          this.lastKnownOffsetSec = msg.payload?.currentOffsetSec || msg.currentOffsetSec || 0;
          this.lastKnownState = 'PAUSED';
          this.onEvent('PAUSED', msg.payload);
          break;

        case 'TRACK_METADATA':
          this.lastKnownTrack = msg.payload;
          this.onEvent('TRACK_METADATA', msg.payload);
          break;

        case 'QUEUE_UPDATED':
          this.onEvent('QUEUE_UPDATED', msg.payload);
          break;

        case 'PLAYBACK_OPTIONS_UPDATED':
          this.applyPlaybackOptions(msg.payload || msg);
          break;

        case 'CONTROL_REQUEST':
          this.receiveControlRequest(msg);
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
    this.isPollingActive = true;
    this.scheduleNextPoll(100);
  }

  stopPolling() {
    this.isPollingActive = false;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
  }

  getOptimalPollInterval() {
    // 1. If tab is in background / minimized, throttle aggressively to save Vercel quota
    if (typeof document !== 'undefined' && document.hidden) {
      return 6000;
    }

    // 2. If WebRTC mesh is established with peers, communication is 100% P2P (0 server cost)
    const hasOpenDataChannels = Array.from(this.dataChannels.values()).some(ch => ch && ch.readyState === 'open');
    if (hasOpenDataChannels) {
      return 5000;
    }

    // 3. During initial peer discovery / signaling phase
    return 1500;
  }

  broadcastDataChannelMessage(msg) {
    if (!this.dataChannels) return;
    const payload = typeof msg === 'string' ? msg : JSON.stringify(msg);
    this.dataChannels.forEach(channel => {
      if (channel && channel.readyState === 'open') {
        try {
          channel.send(payload);
        } catch (e) {}
      }
    });
  }

  scheduleNextPoll(delayMs) {
    if (!this.isPollingActive) return;
    if (this.pollTimeout) clearTimeout(this.pollTimeout);
    this.pollTimeout = setTimeout(async () => {
      if (!this.isPollingActive) return;
      await this.pollLoop();
      const nextDelay = this.getOptimalPollInterval();
      this.scheduleNextPoll(nextDelay);
    }, delayMs !== undefined ? delayMs : this.getOptimalPollInterval());
  }

  async pollLoop() {
    if (!this.roomId || !this.peerId) return true;

    try {
      const res = await fetch('/api/room?action=poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: this.roomId,
          peerId: this.peerId,
          hostToken: this.hostToken || undefined,
          deviceName: this.deviceName,
          isHost: this.isHost,
          hostId: this.isHost ? this.peerId : undefined,
          queue: this.isHost ? (this.lastKnownQueue || []) : undefined,
          queueRevision: this.isHost ? this.queueRevision : undefined,
          deletedQueueIds: this.isHost ? Array.from(this.deletedQueueIds) : [],
          track: this.isHost ? this.lastKnownTrack : undefined,
          state: this.isPaused ? 'PAUSED' : 'PLAYING',
          repeatMode: this.isHost ? this.repeatMode : undefined,
          shuffle: this.isHost ? this.shuffle : undefined
        })
      });
      if (!res.ok) return;

      const data = await res.json();
      this.rememberQueueRevision(data);
      this.setHostDisconnected(data.hostDisconnected === true);
      this.applyPlaybackOptions(data);

      if (data.kicked && !this.isHost) {
        this.unsubscribe();
        this.onEvent('ROOM_LEFT');
        alert('Device Anda telah dikeluarkan dari room oleh Host.');
        window.location.href = '/';
        return;
      }

      // 1. Peer list & WebRTC Mesh Auto-Connect with strict duplicate pruning
      if (Array.isArray(data.peers)) {
        let peersChanged = false;
        const incomingIds = new Set(data.peers.map(p => p.id));

        data.peers.forEach(p => {
          const existing = this.localPeersMap.get(p.id);
          if (p.id === this.peerId) {
            p.isHost = this.isHost;
            if (existing) {
              p.isAudioLoading = existing.isAudioLoading;
              p.readiness = existing.readiness;
              p.loadingStatus = existing.loadingStatus;
              p.audioRoute = existing.audioRoute || p.audioRoute || 'unknown';
            }
          }
          if (!existing || existing.role !== p.role || existing.isAudioLoading !== p.isAudioLoading || existing.readiness !== p.readiness || existing.audioRoute !== p.audioRoute || existing.volume !== p.volume || existing.isHost !== p.isHost || existing.deviceName !== p.deviceName) {
            peersChanged = true;
          }
          this.localPeersMap.set(p.id, p);

          if (this.isHost && p.id !== this.peerId) {
            const pc = this.peerConnections.get(p.id);
            if (!pc || pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
              this.initiateWebRTCOffer(p.id);
            }
          }
        });

        // Strictly prune removed or disconnected peers immediately
        for (const pId of Array.from(this.localPeersMap.keys())) {
          if (!incomingIds.has(pId) && pId !== this.peerId) {
            this.localPeersMap.delete(pId);
            const pc = this.peerConnections.get(pId);
            if (pc) {
              try { pc.close(); } catch (e) { }
              this.peerConnections.delete(pId);
            }
            this.dataChannels.delete(pId);
            peersChanged = true;
          }
        }

        if (peersChanged || this.lastDispatchedPeersCount !== this.localPeersMap.size) {
          this.lastDispatchedPeersCount = this.localPeersMap.size;
          this.dispatchLocalPeers();
        }
      }

      // 2. Queue list with resilient merge - never lose songs across serverless lambdas
      if (this.isHost && data.queueConflict && Array.isArray(data.queue)) {
        this.deletedQueueIds.clear();
        this.applyCanonicalQueue(data.queue);
        this.onEvent('QUEUE_SYNC_ERROR', { queue: data.queue, message: 'Antrean room berubah. Susunan terbaru sudah dimuat.' });
      } else if (Array.isArray(data.queue) && (Date.now() - (this.lastQueueReorderTime || 0) > 2000)) {
        let mergedQueue;
        if (this.isHost) {
          const mergedMap = new Map();
          (this.lastKnownQueue || []).forEach(item => {
            if (item && item.id && !this.deletedQueueIds.has(item.id)) mergedMap.set(item.id, item);
          });
          data.queue.forEach(item => {
            if (item && item.id && !this.deletedQueueIds.has(item.id)) mergedMap.set(item.id, item);
          });
          mergedQueue = Array.from(mergedMap.values());
        } else {
          mergedQueue = data.queue;
        }
        const queueStr = JSON.stringify(mergedQueue);
        if (queueStr !== this.lastKnownQueueStr) {
          this.lastKnownQueueStr = queueStr;
          this.lastKnownQueue = mergedQueue;
          this.onEvent('QUEUE_UPDATED', { queue: mergedQueue });
        }
      }

      // 3. Track update & Auto-fetch with buffer synchronization
      let trackChanged = false;
      if (data.track) {
        if (data.track.sourceType === 'youtube' && !data.track.sourceId) {
          const videoId = youtubeVideoId(data.track);
          if (videoId) data.track.sourceId = videoId;
        }
        const isDifferent = !this.lastKnownTrack 
          || (data.track.id && this.lastKnownTrack.id && data.track.id !== this.lastKnownTrack.id)
          || (data.track.name !== this.lastKnownTrack.name);
        
        if (isDifferent) {
          trackChanged = true;
          this.lastKnownTrack = data.track;
          this.onEvent('TRACK_METADATA', data.track);
          this.loadTrackBuffer(data.track);
        }
      }

      // 4. Playback state with clean Pause protection and exact track synchronization
      if (data.state === 'PLAYING') {
        const isFreshPlay = !this.lastPauseTime || (data.targetServerTime && (data.targetServerTime > (this.lastPauseTime + 300)));
        const shouldPlay = isFreshPlay && (
          (data.targetServerTime && data.targetServerTime !== this.lastKnownState) 
          || (this.isPaused && Date.now() - (this.lastPauseTime || 0) > 2000) 
          || trackChanged
        );

        if (shouldPlay) {
          this.isPaused = false;
          this.lastKnownOffsetSec = data.startOffsetSec || 0;
          if (data.targetServerTime) this.lastKnownState = data.targetServerTime;
          this.onEvent('SCHEDULED_PLAY', {
            targetServerTime: data.targetServerTime || (this.serverTimeNow() + 600),
            startOffsetSec: data.startOffsetSec || 0,
            track: data.track || this.lastKnownTrack
          });
        }
      } else if (data.state === 'PAUSED') {
        if (this.lastKnownState !== 'PAUSED' || !this.isPaused) {
          this.isPaused = true;
          this.lastKnownOffsetSec = data.startOffsetSec || 0;
          this.lastKnownState = 'PAUSED';
          this.lastPauseTime = Date.now();
          this.onEvent('PAUSED', {
            currentOffsetSec: data.startOffsetSec || 0
          });
        }
      }

      // 5. WebRTC Signals
      if (Array.isArray(data.signals) && data.signals.length > 0) {
        for (const sig of data.signals) {
          await this.handleIncomingSignal(sig.from, sig.data);
        }
      }
    } catch (err) { }
  }

  async loadTrackBuffer(track) {
    if (!track) return;
    const trackId = track.id || youtubeVideoId(track) || '';
    const trackKey = trackId || track.audioId || track.name;
    this.broadcastReadiness('PREPARING', trackId, 'unknown');
    if (track.isSynthetic || track.name === 'Neon Groove Synthwave' || (track.name && track.name.toLowerCase().includes('synth'))) {
      this.currentFetchingTrackKey = null;
      this.updateLoadingState(false, 'Siap');
      this.audioRouteByTrack.set(trackKey, 'local');
      this.broadcastReadiness('READY', trackId, 'local');
      this.onEvent('SYNTHETIC_TRACK_REQUESTED', track);
      return;
    }

    const videoId = youtubeVideoId(track);
    if (videoId) {
      track.sourceType = 'youtube';
      track.sourceId = videoId;
      this.currentFetchingTrackKey = null;
      this.pendingTrackBufferRequest = null;
      this.updateLoadingState(false, 'Siap');
      this.audioRouteByTrack.set(trackKey, 'youtube');
      this.onEvent('YOUTUBE_TRACK_REQUESTED', track);
      return;
    }

    const cached = this.localAudioBufferCache.get(track.id)
      || (track.audioId && this.localAudioBufferCache.get(track.audioId))
      || (track.audioUrl && this.localAudioBufferCache.get(track.audioUrl))
      || (!track.id && this.localAudioBufferCache.get(track.name))
      || (!track.id && this.currentAudioArrayBuffer && this.lastKnownTrack?.name === track.name ? this.currentAudioArrayBuffer : null);

    if (cached) {
      this.currentFetchingTrackKey = null;
      this.pendingTrackBufferRequest = null;
      if (track.id) this.localAudioBufferCache.set(track.id, cached);
      if (track.name) this.localAudioBufferCache.set(track.name, cached);
      this.updateLoadingState(false, 'Siap');
      this.audioRouteByTrack.set(trackKey, 'cache');
      this.broadcastReadiness('READY', trackId, 'cache');
      this.onEvent('BINARY_AUDIO_RECEIVED', { arrayBuffer: cached, trackName: track.name, trackId: track.id });
      return;
    }

    // Single-flight guard: prevent blinking loops if fetch is already in flight for this track
    if (this.currentFetchingTrackKey === trackKey && this.pendingTrackBufferRequest) {
      return;
    }

    if (track.sourceType === 'local-file' && (!track.audioUrl || track.audioUrl.startsWith('blob:')) && !track.audioId) {
      this.currentFetchingTrackKey = trackKey;
      this.pendingTrackBufferRequest = track;
      this.updateLoadingState(true, 'Menghubungkan untuk menerima audio P2P…');
      this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 0, status: 'Menunggu audio P2P dari host…' });
      this.requestTrackBufferFromPeers(track.name, track.id);
      return;
    }

    this.currentFetchingTrackKey = trackKey;
    this.pendingTrackBufferRequest = track;

    let fetchUrl = track.audioUrl;
    if (!fetchUrl || fetchUrl.startsWith('blob:')) {
      fetchUrl = `/api/room?action=get_audio&roomId=${encodeURIComponent(this.roomId)}&audioId=${encodeURIComponent(track.audioId || track.id || '')}&trackName=${encodeURIComponent(track.name || '')}`;
    }

    // Only request P2P buffer if there is NO remote fetch URL, or if fetch fails (fallback)
    const hasRemoteUrl = !!(fetchUrl && (fetchUrl.startsWith('http') || fetchUrl.startsWith('/api/')));
    if (!hasRemoteUrl) {
      this.requestTrackBufferFromPeers(track.name, track.id);
    }
    this.fetchRemoteAudioUrl(fetchUrl, track.name, track.id);
  }

  async updateLoadingState(isLoading, status = '') {
    const me = this.localPeersMap.get(this.peerId);
    if (isLoading && me?.readiness !== 'PREPARING') {
      this.broadcastReadiness('PREPARING', this.pendingTrackBufferRequest?.id || this.lastKnownTrack?.id || '');
    }
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
    } catch (e) { }
  }

  async addToQueue(track) {
    // Optimistic immediate queue update
    const currentQ = this.lastKnownQueue || [];
    const item = {
      id: track.id || ('q_' + Math.random().toString(36).substring(2, 9)),
      name: track.name || 'Untitled',
      artist: track.artist || 'Artist',
      duration: track.duration || 0,
      thumbnail: track.thumbnail || '',
      audioUrl: track.audioUrl || '',
      sourceType: track.sourceType,
      sourceId: track.sourceId,
      sourceUrl: track.sourceUrl,
      isSynthetic: !!track.isSynthetic,
      addedBy: track.addedBy || this.deviceName
    };
    this.deletedQueueIds.delete(item.id);

    if (!currentQ.some(q => q.id === item.id)) {
      this.lastKnownQueue = [...currentQ, item];
      this.lastKnownQueueStr = JSON.stringify(this.lastKnownQueue);
      this.saveLocalQueue(this.lastKnownQueue);
      this.onEvent('QUEUE_UPDATED', { queue: this.lastKnownQueue });
      this.publishMqtt(this.roomTopic, { type: 'QUEUE_UPDATED', queue: this.lastKnownQueue });
      this.broadcastDataChannelMessage({ type: 'QUEUE_UPDATED', queue: this.lastKnownQueue });
    }
    else return true;
    if (!this.roomId || !this.peerId) return true;

    const submitAddition = async (expectedQueueRevision, retryConflict) => {
      const res = await fetchQueueMutation('/api/room?action=add_queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: this.roomId,
          peerId: this.peerId,
          deviceName: this.deviceName,
          expectedQueueRevision,
          ...item
        })
      });
      const data = await res.json();
      this.rememberQueueRevision(data);
      if (res.status === 409 && retryConflict && Array.isArray(data.queue)
        && Number.isSafeInteger(data.queueRevision)) {
        this.applyCanonicalQueue(data.queue);
        return submitAddition(data.queueRevision, false);
      }
      if (!res.ok || !data.success) {
        if (res.status === 409) {
          this.applyCanonicalQueue(data.queue);
          this.onEvent('QUEUE_SYNC_ERROR', { queue: this.lastKnownQueue, message: 'Antrean berubah di perangkat lain. Pilih lagi untuk menambahkan lagu.' });
        } else {
          this.onEvent('QUEUE_SYNC_ERROR', { queue: this.lastKnownQueue, message: 'Antrean tersimpan di perangkat ini, sinkronisasi room gagal.' });
        }
        return false;
      }
      if (data.queue) {
        const confirmedTracks = data.queue.filter(track => !this.deletedQueueIds.has(track.id));
        const serverIds = new Set(confirmedTracks.map(track => track.id));
        const pendingLocalTracks = (this.lastKnownQueue || []).filter(track =>
          !serverIds.has(track.id) && !this.deletedQueueIds.has(track.id)
        );
        const mergedQueue = [...confirmedTracks, ...pendingLocalTracks];
        this.lastKnownQueue = mergedQueue;
        this.lastKnownQueueStr = JSON.stringify(mergedQueue);
        this.saveLocalQueue(mergedQueue);
        this.onEvent('QUEUE_UPDATED', { queue: mergedQueue });
        this.publishMqtt(this.roomTopic, { type: 'QUEUE_UPDATED', queue: mergedQueue });
        this.broadcastDataChannelMessage({ type: 'QUEUE_UPDATED', queue: mergedQueue });
        if (this.broadcastChannel) {
          this.broadcastChannel.postMessage({
            type: 'QUEUE_UPDATED',
            payload: { queue: mergedQueue }
          });
        }
      }
      return true;
    };
    const acknowledgement = submitAddition(this.queueRevision, true).catch(() => {
      this.onEvent('QUEUE_SYNC_ERROR', { queue: this.lastKnownQueue, message: 'Antrean tersimpan di perangkat ini, sinkronisasi room gagal.' });
      return false;
    });
    const previousAcknowledgement = this.queueAdditionAcknowledgements.get(item.id);
    if (previousAcknowledgement) {
      acknowledgement.catch(() => {});
      return true;
    }
    this.queueAdditionAcknowledgements.set(item.id, acknowledgement);
    acknowledgement.finally(() => {
      if (this.queueAdditionAcknowledgements.get(item.id) === acknowledgement) {
        this.queueAdditionAcknowledgements.delete(item.id);
      }
    }).catch(() => {});
    acknowledgement.catch(() => {});
    return true;
  }

  waitForQueueItemAcknowledgement(trackId) {
    return this.queueAdditionAcknowledgements?.get(trackId) || Promise.resolve(false);
  }

  requestControl(action, details = {}) {
    if (this.isHost) return false;
    const request = {
      type: 'CONTROL_REQUEST',
      requestId: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      action,
      details,
      peerId: this.peerId,
      requestedBy: this.deviceName
    };

    if (this.mqttClient && this.isMqttConnected) {
      this.publishMqtt(this.roomTopic, request);
    } else {
      this.broadcastDataChannelMessage(request);
      this.broadcastChannel?.postMessage(request);
    }
    return true;
  }

  receiveControlRequest(request) {
    if (!this.isHost || !request?.requestId || this.seenControlRequestIds.has(request.requestId)) return;
    this.seenControlRequestIds.add(request.requestId);
    if (this.seenControlRequestIds.size > 100) {
      this.seenControlRequestIds.delete(this.seenControlRequestIds.values().next().value);
    }
    this.onEvent('CONTROL_REQUEST', request);
  }

  async playQueueItem(queueId, autoplay = false) {
    if (!this.isHost) return false;
    try {
      const res = await fetchQueueMutation('/api/room?action=play_queue_item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: this.roomId, peerId: this.peerId, hostToken: this.hostToken, queueId, expectedQueueRevision: this.queueRevision })
      });
      const data = await res.json();
      this.rememberQueueRevision(data);
      if (res.status === 409) {
        this.applyCanonicalQueue(data.queue);
        this.onEvent('QUEUE_SYNC_ERROR', { queue: this.lastKnownQueue, message: 'Antrean berubah di perangkat lain. Coba lagi.' });
        return false;
      }
      if (!res.ok || data.success === false) {
        this.onEvent('QUEUE_SYNC_ERROR', { message: 'Room gagal memilih lagu. Refresh antrean lalu coba lagi.' });
        return false;
      }
      if (data.track) {
        this.lastKnownTrack = data.track;
        const cachedBuffer = this.localAudioBufferCache.get(data.track.id);
        if (cachedBuffer && data.track.audioUrl) {
          this.localAudioBufferCache.set(data.track.audioUrl, cachedBuffer);
          this.onEvent('BINARY_AUDIO_RECEIVED', { arrayBuffer: cachedBuffer, trackName: data.track.name, trackId: data.track.id });
        }
        this.isPaused = !autoplay;
        this.lastKnownOffsetSec = 0;
        this.lastKnownState = autoplay ? (data.targetServerTime || this.serverTimeNow() + 800) : 'PAUSED';
        this.onEvent('TRACK_METADATA', data.track);
        this.loadTrackBuffer(data.track);
        this.publishMqtt(this.roomTopic, { type: 'TRACK_METADATA', metadata: data.track });
        this.broadcastDataChannelMessage({ type: 'TRACK_METADATA', metadata: data.track });

        if (autoplay) {
          const payload = {
            targetServerTime: this.lastKnownState,
            startOffsetSec: data.startOffsetSec || 0,
            track: data.track
          };
          this.onEvent('SCHEDULED_PLAY', payload);
          this.publishMqtt(this.roomTopic, { type: 'SCHEDULED_PLAY', payload });
          this.broadcastDataChannelMessage({ type: 'SCHEDULED_PLAY', ...payload });
          this.broadcastChannel?.postMessage({ type: 'SCHEDULED_PLAY', payload });
          fetch('/api/room?action=play', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              roomId: this.roomId,
              peerId: this.peerId,
              hostToken: this.hostToken,
              targetServerTime: payload.targetServerTime,
              startOffsetSec: payload.startOffsetSec,
              track: data.track
            })
          }).catch(() => {});
        } else {
          this.onEvent('PAUSED', { currentOffsetSec: 0 });
          this.broadcastChannel?.postMessage({ type: 'PAUSED', payload: { currentOffsetSec: 0 } });
          this.publishMqtt(this.roomTopic, { type: 'PAUSED', payload: { currentOffsetSec: 0 } });
          this.broadcastDataChannelMessage({ type: 'PAUSED', currentOffsetSec: 0 });
        }
      }
      if (data.queue) {
        this.lastKnownQueue = data.queue;
        this.lastKnownQueueStr = JSON.stringify(data.queue);
        this.saveLocalQueue(data.queue);
        this.onEvent('QUEUE_UPDATED', { queue: data.queue });
        this.publishMqtt(this.roomTopic, { type: 'QUEUE_UPDATED', queue: data.queue });
        this.broadcastDataChannelMessage({ type: 'QUEUE_UPDATED', queue: data.queue });
        this.broadcastChannel?.postMessage({ type: 'QUEUE_UPDATED', payload: { queue: data.queue } });
      }
      return data.track || false;
    } catch (error) {
      this.onEvent('QUEUE_SYNC_ERROR', {
        message: error.name === 'TimeoutError'
          ? 'Room lambat merespons. Pemilihan lagu dibatalkan; coba lagi.'
          : 'Room gagal memilih lagu. Refresh antrean lalu coba lagi.'
      });
      return false;
    }
  }

  async playNext(queueId) {
    if (!this.isHost) return;
    try {
      const res = await fetchQueueMutation('/api/room?action=play_next', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: this.roomId, peerId: this.peerId, hostToken: this.hostToken, queueId, expectedQueueRevision: this.queueRevision })
      });
      const data = await res.json();
      this.rememberQueueRevision(data);
      if (res.status === 409) {
        this.applyCanonicalQueue(data.queue);
        this.onEvent('QUEUE_SYNC_ERROR', { queue: this.lastKnownQueue, message: 'Antrean berubah di perangkat lain. Coba lagi.' });
        return false;
      }
      if (!res.ok || !data.success) {
        this.onEvent('QUEUE_SYNC_ERROR', { message: 'Lagu gagal dipindahkan ke urutan berikutnya. Coba lagi.' });
        return false;
      }
      if (data.queue) {
        this.lastKnownQueue = data.queue;
        this.lastKnownQueueStr = JSON.stringify(data.queue);
        this.saveLocalQueue(data.queue);
        this.onEvent('QUEUE_UPDATED', { queue: data.queue });
        this.publishMqtt(this.roomTopic, { type: 'QUEUE_UPDATED', queue: data.queue });
        this.broadcastDataChannelMessage({ type: 'QUEUE_UPDATED', queue: data.queue });
      }
      return true;
    } catch (error) {
      this.onEvent('QUEUE_SYNC_ERROR', {
        message: error.name === 'TimeoutError'
          ? 'Room lambat merespons. Perubahan urutan belum dikonfirmasi.'
          : 'Lagu gagal dipindahkan ke urutan berikutnya. Coba lagi.'
      });
      return false;
    }
  }

  async reorderQueue(newQueue) {
    if (!this.isHost) return;
    const previousQueue = [...(this.lastKnownQueue || [])];
    this.lastQueueReorderTime = Date.now();
    this.lastKnownQueue = newQueue;
    this.lastKnownQueueStr = JSON.stringify(newQueue);
    this.saveLocalQueue(newQueue);
    this.onEvent('QUEUE_UPDATED', { queue: newQueue });
    this.publishMqtt(this.roomTopic, { type: 'QUEUE_UPDATED', queue: newQueue });
    this.broadcastDataChannelMessage({ type: 'QUEUE_UPDATED', queue: newQueue });
    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'QUEUE_UPDATED',
        payload: { queue: newQueue }
      });
    }

    try {
      const res = await fetchQueueMutation('/api/room?action=reorder_queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: this.roomId,
          peerId: this.peerId,
          hostToken: this.hostToken,
          queue: newQueue,
          expectedQueueRevision: this.queueRevision
        })
      });
      const data = await res.json();
      this.rememberQueueRevision(data);
      if (!res.ok || !data.success) {
        if (res.status === 409 && Array.isArray(data.queue)) {
          this.applyCanonicalQueue(data.queue);
          this.onEvent('QUEUE_SYNC_ERROR', { queue: data.queue, message: 'Antrean berubah di perangkat lain. Susunan terbaru sudah dimuat.' });
        } else {
          this.applyCanonicalQueue(previousQueue);
          this.onEvent('QUEUE_SYNC_ERROR', { queue: previousQueue, message: 'Susunan antrean gagal disimpan. Perubahan dipulihkan; coba lagi.' });
        }
        return false;
      }
      if (data.queue) {
        this.applyCanonicalQueue(data.queue);
        this.publishMqtt(this.roomTopic, { type: 'QUEUE_UPDATED', queue: data.queue });
        this.broadcastDataChannelMessage({ type: 'QUEUE_UPDATED', queue: data.queue });
        this.broadcastChannel?.postMessage({ type: 'QUEUE_UPDATED', payload: { queue: data.queue } });
      }
      return true;
    } catch (error) {
      this.applyCanonicalQueue(previousQueue);
      this.onEvent('QUEUE_SYNC_ERROR', {
        queue: previousQueue,
        message: error.name === 'TimeoutError'
          ? 'Room lambat merespons. Susunan antrean dipulihkan; coba lagi.'
          : 'Susunan antrean gagal disimpan. Perubahan dipulihkan; coba lagi.'
      });
      return false;
    }
  }

  async removeFromQueue(queueId) {
    if (!this.isHost) return;
    const previousQueue = [...(this.lastKnownQueue || [])];
    if (queueId) {
      this.deletedQueueIds.add(queueId);
      this.lastKnownQueue = (this.lastKnownQueue || []).filter(q => q.id !== queueId);
      this.lastKnownQueueStr = JSON.stringify(this.lastKnownQueue);
      this.saveLocalQueue(this.lastKnownQueue);
      this.onEvent('QUEUE_UPDATED', { queue: this.lastKnownQueue });
      this.publishMqtt(this.roomTopic, { type: 'QUEUE_UPDATED', queue: this.lastKnownQueue });
      this.broadcastDataChannelMessage({ type: 'QUEUE_UPDATED', queue: this.lastKnownQueue });
    }

    try {
      const res = await fetchQueueMutation('/api/room?action=remove_queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: this.roomId,
          peerId: this.peerId,
          hostToken: this.hostToken,
          queueId,
          expectedQueueRevision: this.queueRevision
        })
      });
      const data = await res.json();
      this.rememberQueueRevision(data);
      if (res.status === 409) {
        if (queueId) this.deletedQueueIds.delete(queueId);
        this.applyCanonicalQueue(data.queue);
        this.onEvent('QUEUE_SYNC_ERROR', { queue: this.lastKnownQueue, message: 'Antrean berubah di perangkat lain. Coba lagi.' });
        return false;
      }
      if (!res.ok || !data.success) throw new Error('QUEUE_REMOVE_FAILED');
      if (data.queue) {
        this.lastKnownQueue = data.queue.filter(q => !this.deletedQueueIds.has(q.id));
        this.lastKnownQueueStr = JSON.stringify(this.lastKnownQueue);
        this.onEvent('QUEUE_UPDATED', { queue: this.lastKnownQueue });
      }
      return true;
    } catch (error) {
      if (queueId) this.deletedQueueIds.delete(queueId);
      this.applyCanonicalQueue(previousQueue);
      this.onEvent('QUEUE_SYNC_ERROR', { queue: previousQueue, message: 'Lagu gagal dihapus dari room. Antrean dipulihkan; coba lagi.' });
      return false;
    }
  }

  async clearQueue(queueIds) {
    if (!this.isHost || !Array.isArray(queueIds) || queueIds.length === 0) return { removed: [], queue: this.lastKnownQueue || [] };
    const currentTrackId = this.lastKnownTrack?.id;
    const ids = new Set(queueIds.filter(id => id && id !== currentTrackId));
    const previousQueue = this.lastKnownQueue || [];
    this.lastKnownQueue = previousQueue.filter(item => !ids.has(item.id));
    ids.forEach(id => this.deletedQueueIds.add(id));
    this.lastKnownQueueStr = JSON.stringify(this.lastKnownQueue);
    this.saveLocalQueue(this.lastKnownQueue);
    this.onEvent('QUEUE_UPDATED', { queue: this.lastKnownQueue });
    this.publishMqtt(this.roomTopic, { type: 'QUEUE_UPDATED', queue: this.lastKnownQueue });
    this.broadcastDataChannelMessage({ type: 'QUEUE_UPDATED', queue: this.lastKnownQueue });

    try {
      const res = await fetchQueueMutation('/api/room?action=clear_queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: this.roomId, peerId: this.peerId, hostToken: this.hostToken, queueIds: [...ids], expectedQueueRevision: this.queueRevision })
      });
      const data = await res.json();
      this.rememberQueueRevision(data);
      if (res.status === 409) {
        ids.forEach(id => this.deletedQueueIds.delete(id));
        this.applyCanonicalQueue(data.queue);
        this.onEvent('QUEUE_SYNC_ERROR', { queue: this.lastKnownQueue, message: 'Antrean berubah di perangkat lain. Coba lagi.' });
        return { removed: [], queue: this.lastKnownQueue || [] };
      }
      if (!res.ok || !data.success) throw new Error(data.error || 'QUEUE_CLEAR_FAILED');
      this.lastKnownQueue = data.queue || [];
      this.lastKnownQueueStr = JSON.stringify(this.lastKnownQueue);
      this.saveLocalQueue(this.lastKnownQueue);
      this.onEvent('QUEUE_UPDATED', { queue: this.lastKnownQueue });
      this.broadcastDataChannelMessage({ type: 'QUEUE_UPDATED', queue: this.lastKnownQueue });
      return { removed: data.removed || [], queue: this.lastKnownQueue };
    } catch (error) {
      ids.forEach(id => this.deletedQueueIds.delete(id));
      this.lastKnownQueue = previousQueue;
      this.lastKnownQueueStr = JSON.stringify(previousQueue);
      this.saveLocalQueue(previousQueue);
      this.onEvent('QUEUE_UPDATED', { queue: previousQueue });
      this.onEvent('QUEUE_SYNC_ERROR', { queue: previousQueue, message: 'Antrean tidak jadi dikosongkan. Coba lagi.' });
      return { removed: [], queue: previousQueue };
    }
  }

  async restoreQueue(removed) {
    if (!this.isHost || !Array.isArray(removed) || removed.length === 0) return false;
    removed.forEach(entry => this.deletedQueueIds.delete(entry.item?.id));
    try {
      const res = await fetchQueueMutation('/api/room?action=restore_queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: this.roomId, peerId: this.peerId, hostToken: this.hostToken, removed, expectedQueueRevision: this.queueRevision })
      });
      const data = await res.json();
      this.rememberQueueRevision(data);
      if (res.status === 409) {
        removed.forEach(entry => this.deletedQueueIds.add(entry.item.id));
        this.applyCanonicalQueue(data.queue);
        this.onEvent('QUEUE_SYNC_ERROR', { queue: this.lastKnownQueue, message: 'Antrean berubah di perangkat lain. Undo tidak diterapkan.' });
        return false;
      }
      if (!res.ok || !data.success) throw new Error(data.error || 'QUEUE_RESTORE_FAILED');
      this.lastKnownQueue = data.queue || [];
      this.lastKnownQueueStr = JSON.stringify(this.lastKnownQueue);
      this.saveLocalQueue(this.lastKnownQueue);
      this.onEvent('QUEUE_UPDATED', { queue: this.lastKnownQueue });
      this.publishMqtt(this.roomTopic, { type: 'QUEUE_UPDATED', queue: this.lastKnownQueue });
      this.broadcastDataChannelMessage({ type: 'QUEUE_UPDATED', queue: this.lastKnownQueue });
      return true;
    } catch (error) {
      removed.forEach(entry => this.deletedQueueIds.add(entry.item.id));
      this.onEvent('QUEUE_SYNC_ERROR', { queue: this.lastKnownQueue, message: 'Undo gagal disinkronkan. Coba lagi.' });
      return false;
    }
  }

  async previewNextTrack(automatic = false) {
    if (!this.isHost) return null;
    const response = await fetchQueueMutation('/api/room?action=next_track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId: this.roomId,
        peerId: this.peerId,
        hostToken: this.hostToken,
        automatic,
        previewOnly: true
      })
    });
    const data = await response.json();
    if (!response.ok || data.success !== true) throw new Error('Kandidat lagu berikutnya gagal dimuat.');
    return data.nextTrack || null;
  }

  async nextTrack(automatic = false, preparedTrackId = null) {
    if (!this.isHost) return;
    try {
      const res = await fetchQueueMutation('/api/room?action=next_track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: this.roomId, peerId: this.peerId, hostToken: this.hostToken, automatic, preparedTrackId: preparedTrackId || undefined })
      });
      const data = await res.json();
      if (res.status === 409) {
        this.applyCanonicalQueue(data.queue);
        this.onEvent('QUEUE_SYNC_ERROR', { queue: this.lastKnownQueue, message: 'Antrean berubah saat menyiapkan lagu. Tekan Next lagi.' });
        return false;
      }
      if (!res.ok || data.success === false) {
        this.onEvent('QUEUE_SYNC_ERROR', { message: 'Lagu berikutnya gagal diputar. Coba lagi.' });
        return false;
      }
      if (data.track) {
        this.lastKnownTrack = data.track;
        this.isPaused = (data.state === 'PAUSED');
        this.lastKnownState = data.targetServerTime;
        this.lastKnownOffsetSec = data.startOffsetSec || 0;
        this.onEvent('TRACK_METADATA', data.track);
        this.loadTrackBuffer(data.track);
        this.broadcastDataChannelMessage({ type: 'TRACK_METADATA', metadata: data.track });
        if (data.state === 'PLAYING') {
          const payload = {
            targetServerTime: data.targetServerTime || this.serverTimeNow() + 800,
            startOffsetSec: data.startOffsetSec || 0,
            track: data.track
          };
          this.onEvent('SCHEDULED_PLAY', payload);
          this.publishMqtt(this.roomTopic, { type: 'SCHEDULED_PLAY', payload });
          this.broadcastDataChannelMessage({ type: 'SCHEDULED_PLAY', ...payload });
        }
      }
      if (data.queue) {
        this.lastKnownQueue = data.queue;
        this.lastKnownQueueStr = JSON.stringify(data.queue);
        this.onEvent('QUEUE_UPDATED', { queue: data.queue });
        this.publishMqtt(this.roomTopic, { type: 'QUEUE_UPDATED', queue: data.queue });
      }
      if (data.state === 'PAUSED') {
        this.isPaused = true;
        this.lastPauseTime = Date.now();
        this.lastKnownState = 'PAUSED';
        this.lastKnownOffsetSec = 0;
        const payload = { currentOffsetSec: 0 };
        this.onEvent('PAUSED', payload);
        this.publishMqtt(this.roomTopic, { type: 'PAUSED', payload });
        this.broadcastDataChannelMessage({ type: 'PAUSED', ...payload });
        this.broadcastChannel?.postMessage({ type: 'PAUSED', payload });
      }
    } catch (error) {
      this.onEvent('QUEUE_SYNC_ERROR', {
        message: error.name === 'TimeoutError'
          ? 'Room lambat merespons. Status antrean sedang diperbarui.'
          : 'Lagu berikutnya gagal diputar. Coba lagi.'
      });
      return false;
    }
  }

  async prevTrack() {
    if (!this.isHost) return;
    try {
      const res = await fetch('/api/room?action=prev_track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: this.roomId, peerId: this.peerId, hostToken: this.hostToken })
      });
      const data = await res.json();
      if (data.track) {
        this.lastKnownTrack = data.track;
        this.isPaused = (data.state === 'PAUSED');
        this.lastKnownState = data.targetServerTime;
        this.lastKnownOffsetSec = data.startOffsetSec || 0;
        this.onEvent('TRACK_METADATA', data.track);
        this.loadTrackBuffer(data.track);
        this.broadcastDataChannelMessage({ type: 'TRACK_METADATA', metadata: data.track });
        if (data.state === 'PLAYING') {
          const payload = {
            targetServerTime: data.targetServerTime || this.serverTimeNow() + 800,
            startOffsetSec: data.startOffsetSec || 0,
            track: data.track
          };
          this.onEvent('SCHEDULED_PLAY', payload);
          this.publishMqtt(this.roomTopic, { type: 'SCHEDULED_PLAY', payload });
          this.broadcastDataChannelMessage({ type: 'SCHEDULED_PLAY', ...payload });
        }
      }
      if (data.queue) {
        this.lastKnownQueue = data.queue;
        this.lastKnownQueueStr = JSON.stringify(data.queue);
        this.onEvent('QUEUE_UPDATED', { queue: data.queue });
        this.publishMqtt(this.roomTopic, { type: 'QUEUE_UPDATED', queue: data.queue });
        this.broadcastDataChannelMessage({ type: 'QUEUE_UPDATED', queue: data.queue });
        this.broadcastChannel?.postMessage({ type: 'QUEUE_UPDATED', payload: { queue: data.queue } });
      }
    } catch (e) { }
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
      } catch (e) { }
    }

    try {
      await fetch('/api/room?action=update_peer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: this.roomId,
          peerId: this.peerId,
          hostToken: this.hostToken,
          targetPeerId,
          role,
          volume
        })
      });
    } catch (e) { }
  }

  requestTrackBufferFromPeers(trackName, trackId) {
    const trackKey = trackId || trackName;
    const sendRequest = () => {
      let sent = false;
      this.dataChannels.forEach(channel => {
        if (channel.readyState === 'open') {
          try {
            channel.send(JSON.stringify({ type: 'REQUEST_AUDIO_BUFFER', trackName, trackId }));
            sent = true;
          } catch (e) { }
        }
      });
      return sent;
    };

    this.lastRequestPeerTime = Date.now();
    let attempts = 0;
    const cached = trackId ? this.localAudioBufferCache.get(trackId) : this.localAudioBufferCache.get(trackName);
    if (cached) return true;

    sendRequest();
    if (this.peerBufferRequestInterval && this.peerBufferRequestTrackKey === trackKey) return true;
    if (this.peerBufferRequestInterval) clearInterval(this.peerBufferRequestInterval);
    this.peerBufferRequestTrackKey = trackKey;
    this.peerBufferRequestInterval = setInterval(() => {
      const cached = trackId ? this.localAudioBufferCache.get(trackId) : this.localAudioBufferCache.get(trackName);
      const transferInProgress = [...this.incomingAudioChunks.values()].some(transfer =>
        trackId ? transfer.id === trackId : transfer.name === trackName
      );
      if (cached || transferInProgress || !this.roomId) {
        clearInterval(this.peerBufferRequestInterval);
        this.peerBufferRequestInterval = null;
        this.peerBufferRequestTrackKey = null;
        return;
      }
      attempts++;
      if (attempts >= 30) {
        clearInterval(this.peerBufferRequestInterval);
        this.peerBufferRequestInterval = null;
        this.peerBufferRequestTrackKey = null;
        if (this.currentFetchingTrackKey === trackKey) {
          this.currentFetchingTrackKey = null;
          this.pendingTrackBufferRequest = null;
        }
        this.updateLoadingState(false, 'Audio P2P tidak tersedia');
        this.broadcastReadiness('FAILED', trackId);
        this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 0, status: 'Audio P2P tidak tersedia. Coba sumber lain.' });
        return;
      }
      sendRequest();
    }, 1000);

    return true;
  }

  async fetchRemoteAudioUrl(url, trackName, trackId) {
    if (this.activeAudioAbortController) {
      try { this.activeAudioAbortController.abort(); } catch (e) { }
    }
    this.activeAudioAbortController = new AbortController();
    const signal = this.activeAudioAbortController.signal;
    const audioRoute = url.startsWith('/api/') ? 'relay' : 'direct';
    this.broadcastReadiness('PREPARING', trackId, audioRoute);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      this.activeAudioAbortController?.abort();
    }, 15_000);

    if (!this.incomingAudioChunks.size) {
      this.updateLoadingState(true, `Mengunduh ${trackName} (0%)...`);
      this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 0, status: `Mengunduh ${trackName} (0%)...` });
    }
    try {
      let response;
      try {
        response = await fetch(url, { signal });
        if (!response.ok && url.startsWith('http') && !url.includes('/api/stream') && !url.includes('/api/room')) {
          throw new Error('DIRECT_FETCH_FAILED');
        }
      } catch (fetchErr) {
        if (signal.aborted && !timedOut) return;
        if (timedOut) throw new Error('AUDIO_FETCH_TIMEOUT');
        if (url.startsWith('http') && !url.includes('/api/stream') && !url.includes('/api/room')) {
          const proxyUrl = `/api/stream?url=${encodeURIComponent(url)}`;
          response = await fetch(proxyUrl, { signal });
        } else {
          throw fetchErr;
        }
      }

      if (signal.aborted && !timedOut) return;
      if (timedOut) throw new Error('AUDIO_FETCH_TIMEOUT');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const contentLength = response.headers.get('content-length');
      const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;

      let arrayBuffer;
      if (response.body) {
        const reader = response.body.getReader();
        const chunks = [];
        let receivedBytes = 0;

        while (true) {
          if (signal.aborted && !timedOut) return;
          if (timedOut) throw new Error('AUDIO_FETCH_TIMEOUT');
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          receivedBytes += value.length;
          if (totalBytes > 0) {
            const pct = Math.min(99, Math.round((receivedBytes / totalBytes) * 100));
            this.updateLoadingState(true, `Mengunduh ${pct}%`);
            this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct, status: `Mengunduh (${pct}%)...` });
          } else {
            const mb = (receivedBytes / (1024 * 1024)).toFixed(1);
            this.updateLoadingState(true, `Mengunduh ${mb} MB...`);
            this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 50, status: `Mengunduh (${mb} MB)...` });
          }
        }

        const complete = new Uint8Array(receivedBytes);
        let offset = 0;
        for (const c of chunks) {
          complete.set(c, offset);
          offset += c.length;
        }
        arrayBuffer = complete.buffer;
      } else {
        arrayBuffer = await response.arrayBuffer();
      }

      this.localAudioBufferCache.set(trackName, arrayBuffer);
      if (this.peerBufferRequestInterval) clearInterval(this.peerBufferRequestInterval);
      this.peerBufferRequestInterval = null;
      this.peerBufferRequestTrackKey = null;
      if (trackId) this.localAudioBufferCache.set(trackId, arrayBuffer);
      this.localAudioBufferCache.set(url, arrayBuffer);
      this.currentAudioArrayBuffer = arrayBuffer;
      this.audioRouteByTrack.set(trackId || trackName, audioRoute);

      this.currentFetchingTrackKey = null;
      this.pendingTrackBufferRequest = null;
      this.updateLoadingState(false, 'Siap');
      this.broadcastReadiness('READY', trackId, audioRoute);
      this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 100, status: 'Audio siap!' });
      this.onEvent('BINARY_AUDIO_RECEIVED', { arrayBuffer, trackName, trackId });
    } catch (err) {
      if (signal.aborted && !timedOut) return;
      this.currentFetchingTrackKey = null;
      this.broadcastReadiness('PREPARING', trackId, 'unknown');
      console.warn('Remote fetch notice, awaiting WebRTC stream:', err.message);
      if (!this.incomingAudioChunks.size) {
        this.updateLoadingState(true, 'Menunggu audio...');
        this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 0, status: 'Menunggu audio...' });
      } else {
        this.broadcastReadiness('PREPARING', trackId);
      }
      this.requestTrackBufferFromPeers(trackName, trackId);
    } finally {
      clearTimeout(timeout);
    }
  }

  broadcastReadiness(readiness = 'READY', trackId = '', audioRoute) {
    const me = this.localPeersMap.get(this.peerId);
    if (me) {
      me.readiness = readiness;
      me.isAudioLoading = readiness === 'PREPARING';
      me.loadingStatus = readiness === 'PREPARING' ? 'Menyiapkan audio…' : readiness.toLowerCase();
      if (AUDIO_ROUTES.has(audioRoute)) me.audioRoute = audioRoute;
      this.dispatchLocalPeers();
    }

    const payload = {
      type: 'PEER_READINESS',
      peerId: this.peerId,
      readiness,
      trackId,
      ...(AUDIO_ROUTES.has(audioRoute) ? { audioRoute } : {})
    };

    this.publishMqtt(this.roomTopic, payload);
    this.broadcastDataChannelMessage(payload);
    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage(payload);
    }
    if (this.roomId && this.peerId) {
      const roomId = this.roomId;
      const peerId = this.peerId;
      this.readinessSync = this.readinessSync.catch(() => {}).then(() => {
        if (this.roomId !== roomId || this.peerId !== peerId) return;
        return fetch('/api/room?action=update_peer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomId, peerId, readiness, trackId, ...(AUDIO_ROUTES.has(audioRoute) ? { audioRoute } : {}) })
        });
      }).catch(() => {});
    }
  }

  async broadcastPlay(targetServerTime, startOffsetSec, track) {
    if (!this.isHost) return;
    this.isPaused = false;
    const trackPayload = track || this.lastKnownTrack;
    this.lastKnownState = youtubeVideoId(trackPayload)
      ? this.serverTimeNow() - ((Number(startOffsetSec) || 0) * 1000)
      : targetServerTime;
    this.lastKnownOffsetSec = startOffsetSec;
    if (trackPayload) {
      const videoId = youtubeVideoId(trackPayload);
      if (videoId) {
        trackPayload.sourceType = 'youtube';
        trackPayload.sourceId = videoId;
      }
      this.lastKnownTrack = trackPayload;
      this.onEvent('TRACK_METADATA', trackPayload);
    }

    this.publishMqtt(this.roomTopic, {
      type: 'SCHEDULED_PLAY',
      payload: { targetServerTime, startOffsetSec, track: trackPayload }
    });

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'SCHEDULED_PLAY',
        payload: { targetServerTime, startOffsetSec, track: trackPayload }
      });
    }

    this.broadcastDataChannelMessage({
      type: 'SCHEDULED_PLAY',
      targetServerTime,
      startOffsetSec,
      track: trackPayload
    });

    fetch('/api/room?action=play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId: this.roomId,
        peerId: this.peerId,
        hostToken: this.hostToken,
        targetServerTime,
        startOffsetSec,
        track: trackPayload
      })
    }).catch(() => {});
  }

  async broadcastPause(currentOffsetSec) {
    if (!this.isHost) return;
    this.isPaused = true;
    this.lastPauseTime = Date.now();
    this.lastKnownState = 'PAUSED';
    this.lastKnownOffsetSec = currentOffsetSec;

    this.publishMqtt(this.roomTopic, {
      type: 'PAUSED',
      payload: { currentOffsetSec }
    });

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'PAUSED',
        payload: { currentOffsetSec }
      });
    }

    this.broadcastDataChannelMessage({
      type: 'PAUSED',
      currentOffsetSec
    });

    fetch('/api/room?action=pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId: this.roomId,
        peerId: this.peerId,
        hostToken: this.hostToken,
        currentOffsetSec
      })
    }).catch(() => {});
  }

  async sendTrackMetadata(metadata) {
    if (!this.isHost) return;
    this.lastKnownTrack = metadata;
    this.publishMqtt(this.roomTopic, {
      type: 'TRACK_METADATA',
      metadata
    });

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'TRACK_METADATA',
        payload: metadata
      });
    }

    this.broadcastDataChannelMessage({
      type: 'TRACK_METADATA',
      metadata
    });

    try {
      fetch('/api/room?action=track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: this.roomId,
          peerId: this.peerId,
          hostToken: this.hostToken,
          track: metadata
        })
      }).catch(() => {});
    } catch (e) { }
  }

  async updateLatencyOffset(offsetMs) { }

  // --- WebRTC P2P DataChannel ---
  createPeerConnection(targetPeerId) {
    const config = {
      iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun.relay.metered.ca:80' }
      ]
    };

    const pc = new RTCPeerConnection(config);
    if (!this.pendingIceCandidates.has(targetPeerId)) {
      this.pendingIceCandidates.set(targetPeerId, []);
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal(targetPeerId, {
          type: 'candidate',
          candidate: event.candidate.toJSON()
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
        try { pc.close(); } catch (e) { }
        this.peerConnections.delete(targetPeerId);
        this.dataChannels.delete(targetPeerId);
        this.pendingIceCandidates.delete(targetPeerId);
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
      if (this.isHost) {
        const targetTrack = this.lastKnownTrack;
        channel.send(JSON.stringify({
          type: 'ROOM_SNAPSHOT',
          track: targetTrack,
          queue: this.lastKnownQueue || [],
          state: this.isPaused ? 'PAUSED' : 'PLAYING',
          targetServerTime: this.isPaused ? null : this.lastKnownState,
          startOffsetSec: this.lastKnownOffsetSec,
          repeatMode: this.repeatMode,
          shuffle: this.shuffle
        }));
        const activeBuffer = targetTrack && (this.localAudioBufferCache.get(targetTrack.id) || (!targetTrack.id && this.localAudioBufferCache.get(targetTrack.name)) || (targetTrack.audioUrl && this.localAudioBufferCache.get(targetTrack.audioUrl)));
        if (activeBuffer && (activeBuffer instanceof ArrayBuffer || activeBuffer.byteLength)) {
          this.sendAudioTransferToPeer(channel, activeBuffer, targetTrack?.name || 'Uploaded Track', targetTrack?.id || '');
        }
      } else {
        const reqTrack = this.pendingTrackBufferRequest || this.lastKnownTrack;
        if (reqTrack) {
          const cached = reqTrack.id ? this.localAudioBufferCache.get(reqTrack.id) : this.localAudioBufferCache.get(reqTrack.name);
          if (!cached) {
            try {
              channel.send(JSON.stringify({
                type: 'REQUEST_AUDIO_BUFFER',
                trackName: reqTrack.name,
                trackId: reqTrack.id
              }));
            } catch (e) { }
          }
        }
      }
    };

    channel.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'ROOM_SNAPSHOT') {
            this.applyRoomSnapshot(msg);
          } else if (msg.type === 'CONTROL_REQUEST') {
            this.receiveControlRequest(msg);
          } else if (msg.type === 'AUDIO_HEADER') {
            const validHeader = Number.isSafeInteger(msg.totalBytes)
              && msg.totalBytes > 0
              && msg.totalBytes <= MAX_P2P_AUDIO_BYTES
              && Number.isSafeInteger(msg.totalChunks)
              && msg.totalChunks === Math.ceil(msg.totalBytes / P2P_AUDIO_CHUNK_BYTES)
              && (msg.chunkProtocol === undefined || msg.chunkProtocol === 1)
              && typeof msg.name === 'string'
              && msg.name.length <= 200
              && (msg.id === undefined || (typeof msg.id === 'string' && msg.id.length <= 160));
            if (!validHeader) {
              this.failIncomingAudioTransfer(targetPeerId, msg.id || '', msg.totalBytes > MAX_P2P_AUDIO_BYTES
                ? 'Audio terlalu besar untuk transfer P2P (maks. 64 MiB).'
                : 'Header transfer P2P tidak valid.', msg.name || '');
              return;
            }
            const previousTransfer = this.incomingAudioChunks.get(targetPeerId);
            if (previousTransfer?.timeout) clearTimeout(previousTransfer.timeout);
            const transfer = {
              name: msg.name,
              id: msg.id,
              totalBytes: msg.totalBytes,
              totalChunks: msg.totalChunks,
              chunkProtocol: msg.chunkProtocol || 0,
              lastChunkTimestamp: -Infinity,
              receivedBytes: 0,
              chunks: []
            };
            transfer.resetTimeout = () => {
              clearTimeout(transfer.timeout);
              transfer.timeout = setTimeout(() => {
                if (this.incomingAudioChunks.get(targetPeerId) === transfer) {
                  this.failIncomingAudioTransfer(targetPeerId, transfer.id || '', 'Transfer audio P2P timeout. Coba lagi.', transfer.name);
                }
              }, P2P_AUDIO_TRANSFER_TIMEOUT_MS);
            };
            transfer.resetTimeout();
            this.incomingAudioChunks.set(targetPeerId, transfer);
            const transferKey = msg.id || msg.name;
            if (this.peerBufferRequestInterval && this.peerBufferRequestTrackKey === transferKey) {
              clearInterval(this.peerBufferRequestInterval);
              this.peerBufferRequestInterval = null;
              this.peerBufferRequestTrackKey = null;
            }
            this.broadcastReadiness('PREPARING', msg.id || '', 'p2p');
            this.updateLoadingState(true, `Menerima ${msg.name}...`);
            this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 0, status: `Menerima ${msg.name} P2P...` });
          } else if (msg.type === 'AUDIO_TRANSFER_ACK') {
            const pending = this.pendingAudioTransferAcks.get(channel);
            if (pending && pending.trackId === (msg.id || '')) {
              clearTimeout(pending.timeout);
              this.pendingAudioTransferAcks.delete(channel);
              pending.resolve(msg.success === true);
            }
          } else if (msg.type === 'SCHEDULED_PLAY') {
            this.isPaused = false;
            this.onEvent('SCHEDULED_PLAY', {
              targetServerTime: msg.targetServerTime,
              startOffsetSec: msg.startOffsetSec || 0,
              track: msg.track || this.lastKnownTrack
            });
          } else if (msg.type === 'PAUSED') {
            this.isPaused = true;
            this.lastPauseTime = Date.now();
            this.onEvent('PAUSED', {
              currentOffsetSec: msg.currentOffsetSec || 0
            });
          } else if (msg.type === 'QUEUE_UPDATED') {
            if (Array.isArray(msg.queue)) {
              this.lastKnownQueue = msg.queue;
              this.lastKnownQueueStr = JSON.stringify(msg.queue);
              this.onEvent('QUEUE_UPDATED', { queue: msg.queue });
            }
          } else if (msg.type === 'PLAYBACK_OPTIONS_UPDATED') {
            this.applyPlaybackOptions(msg.payload || msg);
          } else if (msg.type === 'TRACK_METADATA') {
            this.onEvent('TRACK_METADATA', msg.metadata);
          } else if (msg.type === 'PEER_SETTINGS') {
            this.onEvent('REMOTE_DEVICE_UPDATED', { role: msg.role, volume: msg.volume });
          } else if (msg.type === 'PEER_READINESS') {
            if (msg.peerId && this.localPeersMap.has(msg.peerId)) {
              const p = this.localPeersMap.get(msg.peerId);
              p.readiness = msg.readiness || 'READY';
              p.isAudioLoading = (msg.readiness === 'PREPARING');
              if (AUDIO_ROUTES.has(msg.audioRoute)) p.audioRoute = msg.audioRoute;
              this.dispatchLocalPeers();
            }
          } else if (msg.type === 'REQUEST_AUDIO_BUFFER') {
            const now = Date.now();
            const peerKey = `${targetPeerId}_${msg.trackId || msg.trackName}`;
            const lastSent = this.lastSentBufferPerPeer.get(peerKey) || 0;
            if (now - lastSent < 1500) {
              return;
            }
            const cached = this.localAudioBufferCache.get(msg.trackId)
              || (!msg.trackId && this.localAudioBufferCache.get(msg.trackName))
              || (msg.audioUrl && this.localAudioBufferCache.get(msg.audioUrl));
            if (cached && (cached instanceof ArrayBuffer || cached.byteLength)) {
              this.lastSentBufferPerPeer.set(peerKey, now);
              this.sendAudioTransferToPeer(channel, cached, msg.trackName || this.lastKnownTrack?.name || 'Uploaded Track', msg.trackId || this.lastKnownTrack?.id || '');
            }
          }
        } catch (e) { }
        return;
      }

      if (event.data instanceof ArrayBuffer) {
        const stream = this.incomingAudioChunks.get(targetPeerId);
        if (stream) {
          let chunk = event.data;
          if (stream.chunkProtocol === 1) {
            if (event.data.byteLength <= P2P_AUDIO_FRAME_HEADER_BYTES
              || event.data.byteLength > P2P_AUDIO_CHUNK_BYTES + P2P_AUDIO_FRAME_HEADER_BYTES) {
              this.failIncomingAudioTransfer(targetPeerId, stream.id, 'Paket audio P2P tidak valid.', stream.name);
              return;
            }
            const frame = new DataView(event.data);
            const sequence = frame.getUint32(0, true);
            const timestamp = frame.getFloat64(4, true);
            if (sequence !== stream.chunks.length || !Number.isFinite(timestamp) || timestamp < stream.lastChunkTimestamp) {
              this.failIncomingAudioTransfer(targetPeerId, stream.id, 'Paket audio P2P tidak valid.', stream.name);
              return;
            }
            stream.lastChunkTimestamp = timestamp;
            chunk = event.data.slice(P2P_AUDIO_FRAME_HEADER_BYTES);
          }
          if (chunk.byteLength === 0
            || chunk.byteLength > P2P_AUDIO_CHUNK_BYTES
            || stream.receivedBytes + chunk.byteLength > stream.totalBytes
            || stream.chunks.length >= stream.totalChunks) {
            this.failIncomingAudioTransfer(targetPeerId, stream.id, 'Paket audio P2P tidak valid.', stream.name);
            return;
          }
          stream.chunks.push(chunk);
          stream.receivedBytes += chunk.byteLength;
          stream.resetTimeout?.();
          const pct = Math.min(99, Math.round((stream.receivedBytes / stream.totalBytes) * 100));
          this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct, status: `Menerima P2P (${pct}%)...` });

          if (stream.chunks.length === stream.totalChunks) {
            if (stream.receivedBytes !== stream.totalBytes) {
              this.failIncomingAudioTransfer(targetPeerId, stream.id, 'Transfer audio P2P terpotong.', stream.name);
              return;
            }
            const completeBuffer = new Uint8Array(stream.receivedBytes);
            let offset = 0;
            for (const c of stream.chunks) {
              completeBuffer.set(new Uint8Array(c), offset);
              offset += c.byteLength;
            }
            const trackName = stream.name;
            const trackId = stream.id;
            this.incomingAudioChunks.delete(targetPeerId);
            if (stream.timeout) clearTimeout(stream.timeout);
            if (this.peerBufferRequestInterval) clearInterval(this.peerBufferRequestInterval);
            this.peerBufferRequestInterval = null;
            this.peerBufferRequestTrackKey = null;
            this.localAudioBufferCache.set(trackName, completeBuffer.buffer);
            if (trackId) this.localAudioBufferCache.set(trackId, completeBuffer.buffer);
            this.currentAudioArrayBuffer = completeBuffer.buffer;
            this.audioRouteByTrack.set(trackId || trackName, 'p2p');
            this.currentFetchingTrackKey = null;
            this.pendingTrackBufferRequest = null;

            this.updateLoadingState(false, 'Siap');
            this.broadcastReadiness('READY', trackId, 'p2p');
            this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 100, status: 'Audio P2P Siap!' });
            this.onEvent('BINARY_AUDIO_RECEIVED', {
              arrayBuffer: completeBuffer.buffer,
              trackName,
              trackId
            });
            try {
              channel.send(JSON.stringify({ type: 'AUDIO_TRANSFER_ACK', id: trackId || '', success: true }));
            } catch (error) { }
          }
        }
      }
    };

    channel.onclose = () => {
      this.dataChannels.delete(targetPeerId);
      const pendingAck = this.pendingAudioTransferAcks.get(channel);
      if (pendingAck) {
        clearTimeout(pendingAck.timeout);
        this.pendingAudioTransferAcks.delete(channel);
        pendingAck.resolve(false);
      }
      const pendingTransfer = this.incomingAudioChunks.get(targetPeerId);
      if (pendingTransfer) {
        this.failIncomingAudioTransfer(targetPeerId, pendingTransfer.id, 'Koneksi P2P terputus. Coba lagi.', pendingTransfer.name);
      }
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
    this.publishMqtt(`rync432/v1/peer/${targetPeerId}`, {
      type: 'SIGNAL',
      from: this.peerId,
      data: signalData
    });

    try {
      fetch('/api/room?action=signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: this.roomId,
          peerId: this.peerId,
          to: targetPeerId,
          data: signalData
        })
      }).catch(() => {});
    } catch (e) { }
  }

  async drainPendingIceCandidates(peerId, pc) {
    const pending = this.pendingIceCandidates.get(peerId);
    if (Array.isArray(pending) && pending.length > 0) {
      for (const candidate of pending) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (e) { }
      }
      this.pendingIceCandidates.set(peerId, []);
    }
  }

  async handleIncomingSignal(fromPeerId, signalData) {
    let pc = this.peerConnections.get(fromPeerId);
    if (!pc) {
      pc = this.createPeerConnection(fromPeerId);
    }

    try {
      if (signalData.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signalData.sdp));
        await this.drainPendingIceCandidates(fromPeerId, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this.sendSignal(fromPeerId, {
          type: 'answer',
          sdp: pc.localDescription.toJSON()
        });
      } else if (signalData.type === 'answer') {
        if (pc.signalingState !== 'stable') {
          await pc.setRemoteDescription(new RTCSessionDescription(signalData.sdp));
          await this.drainPendingIceCandidates(fromPeerId, pc);
        }
      } else if (signalData.type === 'candidate') {
        if (signalData.candidate) {
          const candidate = new RTCIceCandidate(signalData.candidate);
          if (pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(candidate);
          } else {
            const pending = this.pendingIceCandidates.get(fromPeerId) || [];
            pending.push(candidate);
            this.pendingIceCandidates.set(fromPeerId, pending);
          }
        }
      }
    } catch (e) {
      console.warn('Signal error:', e.message);
    }
  }

  streamAudioToAllPeers(arrayBuffer, trackName = 'Uploaded Track', trackId = '') {
    this.currentAudioArrayBuffer = arrayBuffer;
    this.dataChannels.forEach((channel) => {
      if (channel.readyState === 'open') {
        this.sendAudioTransferToPeer(channel, arrayBuffer, trackName, trackId);
      }
    });
  }

  async streamAudioToRoom(arrayBuffer, trackName = 'Uploaded Track', trackId = '') {
    const peers = [...this.dataChannels.values()].filter(channel => channel.readyState === 'open');
    if (!peers.length) return { sent: 0, total: 0 };
    const results = await Promise.all(peers.map(channel => this.sendAudioTransferToPeer(channel, arrayBuffer, trackName, trackId)));
    return { sent: results.filter(Boolean).length, total: peers.length };
  }

  sendAudioTransferToPeer(channel, arrayBuffer, trackName = 'Uploaded Track', trackId = '') {
    if (!channel || channel.readyState !== 'open') return Promise.resolve(false);
    if (this.activeBufferTransfers.has(channel)) return Promise.resolve(false);
    this.activeBufferTransfers.add(channel);
    return Promise.resolve(this.streamAudioToPeer(channel, arrayBuffer, trackName, trackId))
      .finally(() => {
        this.activeBufferTransfers.delete(channel);
      });
  }

  async streamAudioToPeer(channel, arrayBuffer, trackName = 'Uploaded Track', trackId = '') {
    if (!channel || channel.readyState !== 'open' || !arrayBuffer) return false;
    const totalBytes = arrayBuffer.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || totalBytes > MAX_P2P_AUDIO_BYTES) {
      this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 0, status: 'Audio terlalu besar untuk transfer P2P (maks. 64 MiB).' });
      this.broadcastReadiness('FAILED', trackId);
      return false;
    }
    const totalChunks = Math.ceil(totalBytes / P2P_AUDIO_CHUNK_BYTES);

    try {
      const acknowledgement = new Promise((resolve, reject) => {
        this.pendingAudioTransferAcks.set(channel, { trackId, resolve, reject, timeout: null });
      });
      acknowledgement.catch(() => {});
      channel.send(JSON.stringify({
        type: 'AUDIO_HEADER',
        chunkProtocol: 1,
        name: trackName,
        id: trackId,
        totalBytes,
        totalChunks
      }));

      for (let offset = 0; offset < totalBytes; offset += P2P_AUDIO_CHUNK_BYTES) {
        if (channel.readyState !== 'open') throw new Error('P2P_CHANNEL_CLOSED');

        const backpressureStartedAt = Date.now();
        while (channel.bufferedAmount > 512 * 1024 && channel.readyState === 'open') {
          if (Date.now() - backpressureStartedAt >= P2P_AUDIO_BACKPRESSURE_TIMEOUT_MS) {
            throw new Error('P2P_BACKPRESSURE_TIMEOUT');
          }
          await new Promise(r => setTimeout(r, 15));
        }
        if (channel.readyState !== 'open') throw new Error('P2P_CHANNEL_CLOSED');

        const chunk = arrayBuffer.slice(offset, offset + P2P_AUDIO_CHUNK_BYTES);
        const frameBuffer = new ArrayBuffer(P2P_AUDIO_FRAME_HEADER_BYTES + chunk.byteLength);
        const frame = new DataView(frameBuffer);
        frame.setUint32(0, Math.floor(offset / P2P_AUDIO_CHUNK_BYTES), true);
        frame.setFloat64(4, globalThis.performance?.now?.() ?? Date.now(), true);
        new Uint8Array(frameBuffer, P2P_AUDIO_FRAME_HEADER_BYTES).set(new Uint8Array(chunk));
        channel.send(frameBuffer);
      }
      const pending = this.pendingAudioTransferAcks.get(channel);
      if (pending?.trackId === trackId) {
        pending.timeout = setTimeout(() => {
          if (this.pendingAudioTransferAcks.get(channel) !== pending) return;
          this.pendingAudioTransferAcks.delete(channel);
          pending.reject(new Error('P2P_ACK_TIMEOUT'));
        }, P2P_AUDIO_ACK_TIMEOUT_MS);
      }
      return await acknowledgement;
    } catch (e) {
      const pending = this.pendingAudioTransferAcks.get(channel);
      if (pending?.trackId === trackId) {
        clearTimeout(pending.timeout);
        this.pendingAudioTransferAcks.delete(channel);
      }
      console.warn('P2P stream notice:', e.message);
      const status = e.message === 'P2P_BACKPRESSURE_TIMEOUT'
        ? 'Koneksi P2P lambat atau macet. Coba lagi.'
        : e.message === 'P2P_ACK_TIMEOUT'
          ? 'Penerima tidak mengonfirmasi file P2P. Beralih ke relay.'
        : 'Koneksi P2P terputus. Coba lagi.';
      this.broadcastReadiness('FAILED', trackId);
      this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 0, status });
      return false;
    }
  }

  failIncomingAudioTransfer(peerId, trackId, status, trackName = '') {
    const transfer = this.incomingAudioChunks.get(peerId);
    if (transfer?.timeout) clearTimeout(transfer.timeout);
    this.incomingAudioChunks.delete(peerId);
    const channel = this.dataChannels.get(peerId);
    if (channel?.readyState === 'open') {
      try { channel.send(JSON.stringify({ type: 'AUDIO_TRANSFER_ACK', id: trackId || '', success: false })); } catch (error) { }
    }
    const trackKey = trackId || trackName;
    if (this.peerBufferRequestInterval && this.peerBufferRequestTrackKey === trackKey) {
      clearInterval(this.peerBufferRequestInterval);
      this.peerBufferRequestInterval = null;
      this.peerBufferRequestTrackKey = null;
    }
    if (this.currentFetchingTrackKey === trackKey) {
      this.currentFetchingTrackKey = null;
      this.pendingTrackBufferRequest = null;
    }
    this.updateLoadingState(false, status);
    this.broadcastReadiness('FAILED', trackId);
    this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 0, status });
  }

  async removeRemotePeer(targetPeerId) {
    this.localPeersMap.delete(targetPeerId);
    this.dispatchLocalPeers();

    const pc = this.peerConnections.get(targetPeerId);
    if (pc) {
      try { pc.close(); } catch (e) { }
      this.peerConnections.delete(targetPeerId);
    }
    this.dataChannels.delete(targetPeerId);

    try {
      fetch('/api/room?action=remove_peer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: this.roomId, peerId: this.peerId, hostToken: this.hostToken, targetPeerId })
      }).catch(() => {});
    } catch (e) { }
  }

  leaveRoom() {
    const roomId = this.roomId;
    const peerId = this.peerId;
    this.unsubscribe();
    if (this.roomTopic) {
      this.publishMqtt(this.roomTopic, {
        type: 'PEER_LEFT',
        peerId
      });
    }
    if (roomId && peerId) {
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon(`/api/room?action=leave_room&roomId=${roomId}&peerId=${peerId}`);
        } else {
          fetch(`/api/room?action=leave_room&roomId=${roomId}&peerId=${peerId}`, { method: 'POST', keepalive: true }).catch(() => {});
        }
      } catch (e) { }
    }
    this.peerConnections.forEach(peer => {
      try { peer.close(); } catch (e) { }
    });
    this.dataChannels.forEach(channel => {
      try { channel.close(); } catch (e) { }
    });
    this.pendingAudioTransferAcks.forEach((pending) => {
      clearTimeout(pending.timeout);
      pending.resolve(false);
    });
    this.pendingAudioTransferAcks.clear();
    this.peerConnections.clear();
    this.dataChannels.clear();
    this.pendingIceCandidates.clear();
    this.lastSentBufferPerPeer.clear();
    if (this.peerBufferRequestInterval) clearInterval(this.peerBufferRequestInterval);
    this.peerBufferRequestInterval = null;
    this.peerBufferRequestTrackKey = null;
    this.incomingAudioChunks.forEach((transfer) => {
      if (transfer.timeout) clearTimeout(transfer.timeout);
    });
    this.incomingAudioChunks.clear();
    this.setHostDisconnected(false);
    this.localPeersMap.clear();
    this.roomId = null;
    this.peerId = null;
    this.roomTopic = null;
    this.peerTopic = null;
    this.isHost = false;
    this.hostToken = null;
  }

  unsubscribe() {
    this.stopPolling();
    if (this.mqttClient) {
      try { this.mqttClient.end(true); } catch (e) {}
      this.mqttClient = null;
      this.isMqttConnected = false;
    }
    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.postMessage({
          type: 'PEER_LEFT',
          peerId: this.peerId
        });
        this.broadcastChannel.close();
      } catch (e) { }
      this.broadcastChannel = null;
    }
  }
}
