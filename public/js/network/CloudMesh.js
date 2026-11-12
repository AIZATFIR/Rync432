// CloudMesh: High-Precision WebRTC Local Mesh + Serverless Edge Relay
// Connects Laptop & Mobile Phones with Sub-Millisecond Clock Alignment
import { recordLocalMetric } from '../metrics/localMetrics.js';
import { roomJoinMessage } from './roomJoinMessage.js';

const P2P_AUDIO_CHUNK_BYTES = 32 * 1024;
const P2P_AUDIO_FRAME_HEADER_BYTES = 12;
const MAX_P2P_AUDIO_BYTES = 64 * 1024 * 1024;
const MAX_REMOTE_AUDIO_BYTES = MAX_P2P_AUDIO_BYTES;
const P2P_AUDIO_TRANSFER_TIMEOUT_MS = 10_000;
const P2P_AUDIO_ACK_TIMEOUT_MS = 5_000;
const P2P_AUDIO_BACKPRESSURE_TIMEOUT_MS = 10_000;
const P2P_SIGNAL_POLL_INTERVAL_MS = 250;
const P2P_FAST_SIGNAL_WINDOW_MS = 10_000;
const P2P_BACKPRESSURE_POLL_INTERVAL_MS = 100;
const P2P_BUFFER_REQUEST_MAX_ATTEMPTS = 10;
const REMOTE_AUDIO_FETCH_TIMEOUT_MS = 5_000;
const QUEUE_MUTATION_TIMEOUT_MS = 8_000;
const QUEUE_ACK_RESULT_CACHE_MAX_ITEMS = 500;
const QUEUE_CONFLICT_RETRY_LIMIT = 5;
const ROOM_POLL_TIMEOUT_MS = 8_000;
const ROOM_JOIN_TIMEOUT_MS = 8_000;
const SIGNAL_DEDUPE_MAX_ITEMS = 512;
const AUDIO_ROUTES = new Set(['unknown', 'p2p', 'relay', 'direct', 'youtube', 'local', 'cache']);
const queueItemKey = item => item?.queueItemId || item?.id;
const resolveQueueItemKey = (queue, id) => {
  const exact = queue.find(item => queueItemKey(item) === id);
  if (exact) return queueItemKey(exact);
  const matches = queue.filter(item => item?.id === id);
  return matches.length === 1 ? queueItemKey(matches[0]) : id;
};
const createQueueItemId = () => `qi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
const createSignalId = () => `sig_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

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
    this.trackPreparationStartedAt = new Map();
    this.queueRevision = 0;
    this.queueRevisionRoomId = null;
    this.isPaused = true;
    this.hostDisconnected = false;
    this.lastPauseTime = 0;
    this.repeatMode = 'off';
    this.shuffle = false;
    this.seenControlRequestIds = new Set();
    this.seenSignalIds = new Set();

    // WebRTC P2P Connections
    this.peerConnections = new Map();
    this.peerConnectionStartedAt = new Map();
    this.peerDisconnectTimers = new Map();
    this.dataChannels = new Map();
    this.pendingIceCandidates = new Map();
    this.lastSentBufferPerPeer = new Map();
    this.incomingAudioChunks = new Map();
    this.currentAudioArrayBuffer = null;
    this.localAudioBufferCache = new Map();
    this.audioRouteByTrack = new Map();
    this.queueAdditionAcknowledgements = new Map();
    this.queueAdditionResults = new Map();
    this.confirmedQueueItemIds = new Set();
    this.activeBufferTransfers = new WeakMap();
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
    const key = this.hostTokenStorageKey(roomId);
    try {
      const tabToken = sessionStorage.getItem(key);
      if (tabToken) return tabToken;
      const legacyToken = localStorage.getItem(key);
      if (!legacyToken) return null;
      sessionStorage.setItem(key, legacyToken);
      localStorage.removeItem(key);
      return legacyToken;
    } catch (error) { return null; }
  }

  saveHostToken(roomId, token) {
    if (!token) return;
    const key = this.hostTokenStorageKey(roomId);
    try {
      sessionStorage.setItem(key, token);
      localStorage.removeItem(key);
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
    this.queueRevision = 0;
    this.queueRevisionRoomId = roomId;
    this.resetQueueMutationState();
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
      if (this.roomId !== roomId) return result.room;
      this.hostToken = result.hostToken;
      this.saveHostToken(roomId, this.hostToken);
      this.rememberQueueRevision(result.room, roomId);
      this.applyPlaybackOptions(result.room);
      this.broadcastReadiness('READY', '');
      this.startPolling();
      return result.room;
    } catch (error) {
      if (this.roomId === roomId && this.peerId === peerId) {
        this.roomId = null;
        this.peerId = null;
        this.isHost = false;
        this.hostToken = null;
        this.onEvent('ROOM_ERROR', { message: 'Room gagal dibuat. Coba lagi.' });
      }
      throw error;
    }
  }

  async joinRoom(roomId, peerId, deviceName) {
    const joinStartedAt = globalThis.performance?.now?.() ?? Date.now();
    this.roomId = roomId;
    this.queueRevision = 0;
    this.queueRevisionRoomId = null;
    this.resetQueueMutationState();
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
      if (!response.ok || !data.room) {
        const error = new Error(data.error || 'ROOM_NOT_FOUND');
        error.code = data.error || 'ROOM_NOT_FOUND';
        throw error;
      }
      if (data.room.roomId && data.room.roomId !== roomId) throw new Error('Room response mismatch');
      if (this.roomId !== roomId) return data.room;
      this.isHost = data.room.isHost === true;
      if (!this.isHost) this.hostToken = null;
      this.applyRoomSnapshot(data.room, roomId);
      if (!data.room.track) this.broadcastReadiness('READY', '');
      this.startPolling();
      recordLocalMetric('room_join_ms', (globalThis.performance?.now?.() ?? Date.now()) - joinStartedAt);
      return data.room;
    } catch (error) {
      recordLocalMetric('room_join_ms', (globalThis.performance?.now?.() ?? Date.now()) - joinStartedAt, { outcome: 'failure' });
      if (this.roomId === roomId && this.peerId === peerId) {
        this.unsubscribe();
        this.roomId = null;
        this.peerId = null;
        this.isHost = false;
        this.hostToken = null;
        this.onEvent('ROOM_ERROR', { code: error.code, message: roomJoinMessage(error.code) });
      }
      throw error;
    }
  }

  applyRoomSnapshot(snapshot, responseRoomId = this.roomId) {
    if (!snapshot) return;
    if (this.isHost) {
      if (!this.rememberQueueRevision(snapshot, responseRoomId)) return;
      this.applyPlaybackOptions(snapshot);
      this.setHostDisconnected(snapshot.hostDisconnected === true);
      return;
    }
    const queueSnapshotCurrent = Array.isArray(snapshot.queue)
      ? this.applyRealtimeQueue(snapshot.queue, snapshot.queueRevision, responseRoomId)
      : this.rememberQueueRevision(snapshot, responseRoomId);
    if (!queueSnapshotCurrent) return;
    this.applyPlaybackOptions(snapshot);
    this.setHostDisconnected(snapshot.hostDisconnected === true);
    const trackChanged = this.updateTrackFromSnapshot(snapshot.track);
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

  updateTrackFromSnapshot(track) {
    if (!track) return false;
    if (track.sourceType === 'youtube' && !track.sourceId) {
      const videoId = youtubeVideoId(track);
      if (videoId) track.sourceId = videoId;
    }

    const previous = this.lastKnownTrack;
    const trackChanged = !previous || (track.queueItemId || previous.queueItemId
      ? track.queueItemId !== previous.queueItemId
      : (track.id && previous.id ? track.id !== previous.id : track.name !== previous.name));
    const metadataKeys = ['name', 'artist', 'duration', 'thumbnail', 'sourceType', 'sourceId', 'sourceUrl', 'audioId', 'audioUrl', 'queueItemId'];
    const metadataChanged = trackChanged || metadataKeys.some(key => track[key] !== previous?.[key]);
    const sourceChanged = trackChanged || ['sourceType', 'sourceId', 'audioId', 'audioUrl'].some(key => track[key] !== previous?.[key]);

    if (metadataChanged) {
      this.lastKnownTrack = track;
      this.onEvent('TRACK_METADATA', track);
    }

    if (sourceChanged) {
      const cachedBuffer = [track.id, track.audioId, track.audioUrl, !track.id && track.name]
        .some(key => key && this.localAudioBufferCache.has(key));
      if (trackChanged || !cachedBuffer) this.loadTrackBuffer(track);
    }
    return trackChanged;
  }

  rememberQueueRevision(snapshot = {}, responseRoomId = this.roomId) {
    if (responseRoomId !== this.roomId) return false;
    const hasRevision = Number.isSafeInteger(snapshot.queueRevision) && snapshot.queueRevision >= 0;
    const staleRevision = hasRevision && this.queueRevisionRoomId === responseRoomId && snapshot.queueRevision < this.queueRevision;
    if (staleRevision || (Array.isArray(snapshot.queue) && this.queueRevisionRoomId === responseRoomId && !hasRevision)) return false;
    if (Array.isArray(snapshot.queue)) this.confirmedQueueItemIds = new Set(snapshot.queue.map(queueItemKey).filter(Boolean));
    if (hasRevision) {
      if (this.queueRevisionRoomId !== responseRoomId) {
        this.queueRevisionRoomId = responseRoomId;
        this.queueRevision = snapshot.queueRevision;
      } else {
        this.queueRevision = Math.max(this.queueRevision, snapshot.queueRevision);
      }
    }
    return true;
  }

  applyRealtimeQueue(queue, queueRevision, responseRoomId = this.roomId) {
    if (!Array.isArray(queue) || responseRoomId !== this.roomId) return false;
    const hasRevision = Number.isSafeInteger(queueRevision) && queueRevision >= 0;
    const revisionKnown = responseRoomId != null && this.queueRevisionRoomId === responseRoomId;
    const currentRevision = this.queueRevision;
    if (!hasRevision) return false;
    const sameRevision = revisionKnown && queueRevision === currentRevision;
    if (sameRevision && JSON.stringify(queue) !== this.lastKnownQueueStr) return false;
    if (!this.rememberQueueRevision({ queueRevision, queue }, responseRoomId)) return false;
    const queueStr = JSON.stringify(queue);
    if (queueStr === this.lastKnownQueueStr) return true;
    this.lastKnownQueue = queue;
    this.lastKnownQueueStr = queueStr;
    this.saveLocalQueue(queue);
    this.onEvent('QUEUE_UPDATED', { queue });
    return true;
  }

  broadcastRoomQueue(queue) {
    const message = { type: 'QUEUE_UPDATED', queue, queueRevision: this.queueRevision };
    this.publishMqtt(this.roomTopic, message);
    this.broadcastDataChannelMessage(message);
    this.broadcastChannel?.postMessage({
      type: 'QUEUE_UPDATED',
      payload: { queue, queueRevision: this.queueRevision }
    });
  }

  resetQueueMutationState() {
    this.deletedQueueIds.clear();
    this.queueAdditionAcknowledgements.clear();
    this.queueAdditionResults.clear();
    this.confirmedQueueItemIds.clear();
  }

  isQueueItemConfirmed(queueItemId) {
    const key = resolveQueueItemKey(this.lastKnownQueue || [], queueItemId);
    return this.confirmedQueueItemIds.has(key);
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
                    queueRevision: this.queueRevision,
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
                this.applyRealtimeQueue(q, msg.queueRevision ?? msg.payload?.queueRevision);
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
        return true;
      } catch (e) { return false; }
    }
    return false;
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
                queueRevision: this.queueRevision,
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
          this.applyRealtimeQueue(msg.queue || msg.payload?.queue, msg.queueRevision ?? msg.payload?.queueRevision);
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

    if (!this.isMqttConnected) {
      const now = globalThis.performance?.now?.() ?? Date.now();
      const negotiating = Array.from(this.peerConnections.entries()).some(([peerId, pc]) => {
        if (!['new', 'connecting'].includes(pc?.connectionState)) return false;
        const startedAt = this.peerConnectionStartedAt.get(peerId);
        return startedAt === undefined || now - startedAt < P2P_FAST_SIGNAL_WINDOW_MS;
      });
      if (negotiating) return P2P_SIGNAL_POLL_INTERVAL_MS;
    }

    // 2. Keep host heartbeats modest, but check for an absent host promptly on guests.
    const hasOpenDataChannels = Array.from(this.dataChannels.values()).some(ch => ch && ch.readyState === 'open');
    if (hasOpenDataChannels) {
      return this.isHost ? 5000 : 1500;
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
    const requestRoomId = this.roomId;
    const supportsWebRTC = typeof RTCPeerConnection === 'function';

    try {
      const controller = new AbortController();
      let pollTimeout;
      const pollRequest = fetch('/api/room?action=poll', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: requestRoomId,
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
      }).then(async res => ({ res, data: res.ok ? await res.json() : null }));
      const { res, data } = await Promise.race([
        pollRequest,
        new Promise((_, reject) => {
          pollTimeout = setTimeout(() => {
            controller.abort();
            const error = new Error('ROOM_POLL_TIMEOUT');
            error.name = 'TimeoutError';
            reject(error);
          }, ROOM_POLL_TIMEOUT_MS);
        })
      ]).finally(() => clearTimeout(pollTimeout));
      if (this.roomId !== requestRoomId) return;
      if (!res.ok) return;
      const queueSnapshotCurrent = this.rememberQueueRevision(data, requestRoomId);
      this.setHostDisconnected(data.hostDisconnected === true);
      this.applyPlaybackOptions(data);

      if (Array.isArray(data.signals)) {
        for (const signal of data.signals) {
          if (signal.from && signal.data) await this.handleIncomingSignal(signal.from, signal.data);
        }
      }

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

          if (supportsWebRTC && this.isHost && p.id !== this.peerId) {
            const pc = this.peerConnections.get(p.id);
            if (!pc) {
              this.initiateWebRTCOffer(p.id);
            }
          }
        });

        // Strictly prune removed or disconnected peers immediately
        for (const pId of Array.from(this.localPeersMap.keys())) {
          if (!incomingIds.has(pId) && pId !== this.peerId) {
            this.localPeersMap.delete(pId);
            this.cleanupPeerConnection(pId);
            peersChanged = true;
          }
        }

        if (peersChanged || this.lastDispatchedPeersCount !== this.localPeersMap.size) {
          this.lastDispatchedPeersCount = this.localPeersMap.size;
          this.dispatchLocalPeers();
        }
      }

      // 2. Queue list with resilient merge - never lose songs across serverless lambdas
      if (queueSnapshotCurrent && this.isHost && data.queueConflict && Array.isArray(data.queue)) {
        this.deletedQueueIds.clear();
        this.applyCanonicalQueue(data.queue);
        this.onEvent('QUEUE_SYNC_ERROR', { queue: data.queue, message: 'Antrean room berubah. Susunan terbaru sudah dimuat.' });
      } else if (queueSnapshotCurrent && Array.isArray(data.queue) && (Date.now() - (this.lastQueueReorderTime || 0) > 2000)) {
        let mergedQueue;
        if (this.isHost) {
          const mergedMap = new Map();
          (this.lastKnownQueue || []).forEach(item => {
            if (item && item.id && !this.deletedQueueIds.has(queueItemKey(item))) mergedMap.set(queueItemKey(item), item);
          });
          data.queue.forEach(item => {
            if (item && item.id && !this.deletedQueueIds.has(queueItemKey(item))) mergedMap.set(queueItemKey(item), item);
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
      const trackChanged = this.updateTrackFromSnapshot(data.track);

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
    if (trackId && !this.trackPreparationStartedAt.has(trackId)) {
      if (this.trackPreparationStartedAt.size >= 50) this.trackPreparationStartedAt.delete(this.trackPreparationStartedAt.keys().next().value);
      this.trackPreparationStartedAt.set(trackId, globalThis.performance?.now?.() ?? Date.now());
    }
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

  async addQueueItems(tracks) {
    if (!Array.isArray(tracks) || tracks.length === 0) return true;
    const requestRoomId = this.roomId;
    const currentQueue = this.lastKnownQueue || [];
    const knownIds = new Set(currentQueue.map(queueItemKey).filter(Boolean));
    const additions = [];
    for (const track of tracks) {
      if (!track || typeof track !== 'object') continue;
      const item = {
        id: track.id || ('q_' + Math.random().toString(36).substring(2, 9)),
        queueItemId: track.queueItemId || createQueueItemId(),
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
      track.queueItemId = item.queueItemId;
      if (knownIds.has(queueItemKey(item))) continue;
      knownIds.add(queueItemKey(item));
      additions.push(item);
    }
    if (!additions.length) return true;

    this.lastKnownQueue = [...currentQueue, ...additions];
    this.lastKnownQueueStr = JSON.stringify(this.lastKnownQueue);
    this.saveLocalQueue(this.lastKnownQueue);
    this.onEvent('QUEUE_UPDATED', { queue: this.lastKnownQueue });
    this.broadcastRoomQueue(this.lastKnownQueue);
    if (!this.roomId || !this.peerId) return true;

    const submit = async (expectedQueueRevision, conflictRetries = 0) => {
      const res = await fetchQueueMutation('/api/room?action=add_queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: requestRoomId,
          peerId: this.peerId,
          deviceName: this.deviceName,
          expectedQueueRevision,
          items: additions
        })
      });
      const data = await res.json();
      if (this.roomId !== requestRoomId) return false;
      const queueSnapshotCurrent = this.rememberQueueRevision(data, requestRoomId);
      if (res.status === 409 && conflictRetries < QUEUE_CONFLICT_RETRY_LIMIT && Array.isArray(data.queue)
        && Number.isSafeInteger(data.queueRevision)) {
        if (queueSnapshotCurrent) this.applyCanonicalQueue(data.queue);
        return submit(queueSnapshotCurrent ? data.queueRevision : this.queueRevision, conflictRetries + 1);
      }
      if (!res.ok || !data.success) {
        if (queueSnapshotCurrent && Array.isArray(data.queue)) this.applyCanonicalQueue(data.queue);
        this.onEvent('QUEUE_SYNC_ERROR', {
          queue: this.lastKnownQueue,
          message: 'Antrean belum tersinkron ke room. Coba lagi.'
        });
        return false;
      }
      if (queueSnapshotCurrent && Array.isArray(data.queue)) {
        const serverIds = new Set(data.queue.map(queueItemKey).filter(Boolean));
        const pendingItems = this.lastKnownQueue.filter(item => item?.id && !serverIds.has(queueItemKey(item)) && !this.deletedQueueIds.has(queueItemKey(item)));
        this.lastKnownQueue = [...data.queue, ...pendingItems];
        this.lastKnownQueueStr = JSON.stringify(this.lastKnownQueue);
        this.saveLocalQueue(this.lastKnownQueue);
        this.onEvent('QUEUE_UPDATED', { queue: this.lastKnownQueue });
        this.broadcastRoomQueue(this.lastKnownQueue);
      }
      return true;
    };

    try {
      return await submit(this.queueRevision);
    } catch (error) {
      if (this.roomId !== requestRoomId) return false;
      this.onEvent('QUEUE_SYNC_ERROR', {
        queue: this.lastKnownQueue,
        message: 'Antrean tersimpan di perangkat ini, sinkronisasi room gagal.'
      });
      return false;
    }
  }

  async addToQueue(track) {
    const requestRoomId = this.roomId;
    // Optimistic immediate queue update
    const currentQ = this.lastKnownQueue || [];
    const item = {
      id: track.id || ('q_' + Math.random().toString(36).substring(2, 9)),
      queueItemId: track.queueItemId || createQueueItemId(),
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
    track.queueItemId = item.queueItemId;
    const itemKey = queueItemKey(item);
    const queueMutationStartedAt = globalThis.performance?.now?.() ?? Date.now();
    this.deletedQueueIds.delete(itemKey);
    this.deletedQueueIds.delete(item.id);

    if (this.confirmedQueueItemIds.has(itemKey)) return true;
    if (this.queueAdditionAcknowledgements.has(itemKey)) return true;
    if (this.queueAdditionResults.has(itemKey) && currentQ.some(q => queueItemKey(q) === itemKey)) return true;
    this.queueAdditionResults.delete(itemKey);

    if (!currentQ.some(q => queueItemKey(q) === itemKey)) {
      this.lastKnownQueue = [...currentQ, item];
      this.lastKnownQueueStr = JSON.stringify(this.lastKnownQueue);
      this.saveLocalQueue(this.lastKnownQueue);
      this.onEvent('QUEUE_UPDATED', { queue: this.lastKnownQueue });
      this.broadcastRoomQueue(this.lastKnownQueue);
    }
    if (!this.roomId || !this.peerId) return true;

    const submitAddition = async (expectedQueueRevision, conflictRetries = 0) => {
      const res = await fetchQueueMutation('/api/room?action=add_queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: requestRoomId,
          peerId: this.peerId,
          deviceName: this.deviceName,
          expectedQueueRevision,
          ...item
        })
      });
      const data = await res.json();
      if (this.roomId !== requestRoomId) return false;
      const queueSnapshotCurrent = this.rememberQueueRevision(data, requestRoomId);
      if (res.status === 409 && conflictRetries < QUEUE_CONFLICT_RETRY_LIMIT && Array.isArray(data.queue)
        && Number.isSafeInteger(data.queueRevision)) {
        if (queueSnapshotCurrent) this.applyCanonicalQueue(data.queue);
        return submitAddition(queueSnapshotCurrent ? data.queueRevision : this.queueRevision, conflictRetries + 1);
      }
      if (!res.ok || !data.success) {
        recordLocalMetric('queue_ack_ms', (globalThis.performance?.now?.() ?? Date.now()) - queueMutationStartedAt, { outcome: 'failure' });
        if (res.status === 409 && queueSnapshotCurrent) {
          this.applyCanonicalQueue(data.queue);
          this.onEvent('QUEUE_SYNC_ERROR', { queue: this.lastKnownQueue, message: 'Antrean berubah di perangkat lain. Pilih lagi untuk menambahkan lagu.' });
        } else {
          this.onEvent('QUEUE_SYNC_ERROR', { queue: this.lastKnownQueue, message: 'Antrean tersimpan di perangkat ini, sinkronisasi room gagal.' });
        }
        return false;
      }
      if (queueSnapshotCurrent && data.queue) {
        const confirmedTracks = data.queue.filter(track => !this.deletedQueueIds.has(queueItemKey(track)));
        const serverIds = new Set(confirmedTracks.map(queueItemKey));
        const pendingLocalTracks = (this.lastKnownQueue || []).filter(track =>
          !serverIds.has(queueItemKey(track)) && !this.deletedQueueIds.has(queueItemKey(track))
        );
        const mergedQueue = [...confirmedTracks, ...pendingLocalTracks];
        this.lastKnownQueue = mergedQueue;
        this.lastKnownQueueStr = JSON.stringify(mergedQueue);
        this.saveLocalQueue(mergedQueue);
        this.onEvent('QUEUE_UPDATED', { queue: mergedQueue });
        this.broadcastRoomQueue(data.queue);
      }
      recordLocalMetric('queue_ack_ms', (globalThis.performance?.now?.() ?? Date.now()) - queueMutationStartedAt);
      return true;
    };
    const acknowledgement = submitAddition(this.queueRevision).catch(() => {
      if (this.roomId !== requestRoomId) return false;
      recordLocalMetric('queue_ack_ms', (globalThis.performance?.now?.() ?? Date.now()) - queueMutationStartedAt, { outcome: 'failure' });
      this.onEvent('QUEUE_SYNC_ERROR', { queue: this.lastKnownQueue, message: 'Antrean tersimpan di perangkat ini, sinkronisasi room gagal.' });
      return false;
    });
    this.queueAdditionAcknowledgements.set(itemKey, acknowledgement);
    acknowledgement.then(result => {
      if (this.queueAdditionAcknowledgements.get(itemKey) === acknowledgement) {
        if (result) {
          this.queueAdditionResults.delete(itemKey);
          this.queueAdditionResults.set(itemKey, true);
          while (this.queueAdditionResults.size > QUEUE_ACK_RESULT_CACHE_MAX_ITEMS) {
            this.queueAdditionResults.delete(this.queueAdditionResults.keys().next().value);
          }
        }
        this.queueAdditionAcknowledgements.delete(itemKey);
      }
    }).catch(() => {});
    acknowledgement.catch(() => {});
    return true;
  }

  waitForQueueItemAcknowledgement(queueItemId) {
    const exact = this.queueAdditionAcknowledgements?.get(queueItemId);
    if (exact) return exact;
    const key = resolveQueueItemKey(this.lastKnownQueue || [], queueItemId);
    const pending = this.queueAdditionAcknowledgements?.get(key);
    if (pending) return pending;
    if (this.queueAdditionResults?.has(key)) {
      const stillQueued = (this.lastKnownQueue || []).some(item => queueItemKey(item) === key);
      return Promise.resolve(stillQueued && this.queueAdditionResults.get(key));
    }
    return Promise.resolve(false);
  }

  requestControl(action, details = {}) {
    if (this.isHost || this.hostDisconnected) return false;
    const requestRoomId = this.roomId;
    const host = Array.from(this.localPeersMap.values()).find(peer => peer.isHost && peer.id !== this.peerId);
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
      if (!host) return false;
      const hostChannel = this.dataChannels.get(host.id);
      this.sendSignal(host.id, { ...request, signalId: request.requestId }).then(delivered => {
        if (!delivered && hostChannel?.readyState !== 'open' && this.roomId === requestRoomId) {
          this.onEvent('CONTROL_REQUEST_FAILED', { requestId: request.requestId });
        }
      });
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
    const requestRoomId = this.roomId;
    try {
      const res = await fetchQueueMutation('/api/room?action=play_queue_item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: requestRoomId, peerId: this.peerId, hostToken: this.hostToken, queueId, expectedQueueRevision: this.queueRevision })
      });
      const data = await res.json();
      if (this.roomId !== requestRoomId) return false;
      const queueSnapshotCurrent = this.rememberQueueRevision(data, requestRoomId);
      if (res.status === 409) {
        if (queueSnapshotCurrent) this.applyCanonicalQueue(data.queue);
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
      if (queueSnapshotCurrent && data.queue) {
        this.lastKnownQueue = data.queue;
        this.lastKnownQueueStr = JSON.stringify(data.queue);
        this.saveLocalQueue(data.queue);
        this.onEvent('QUEUE_UPDATED', { queue: data.queue });
        this.broadcastRoomQueue(data.queue);
      }
      return data.track || false;
    } catch (error) {
      if (this.roomId !== requestRoomId) return false;
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
      const queueSnapshotCurrent = this.rememberQueueRevision(data);
      if (res.status === 409) {
        if (queueSnapshotCurrent) this.applyCanonicalQueue(data.queue);
        this.onEvent('QUEUE_SYNC_ERROR', { queue: this.lastKnownQueue, message: 'Antrean berubah di perangkat lain. Coba lagi.' });
        return false;
      }
      if (!res.ok || !data.success) {
        this.onEvent('QUEUE_SYNC_ERROR', { message: 'Lagu gagal dipindahkan ke urutan berikutnya. Coba lagi.' });
        return false;
      }
      if (queueSnapshotCurrent && data.queue) {
        this.lastKnownQueue = data.queue;
        this.lastKnownQueueStr = JSON.stringify(data.queue);
        this.saveLocalQueue(data.queue);
        this.onEvent('QUEUE_UPDATED', { queue: data.queue });
        this.broadcastRoomQueue(data.queue);
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
    const requestRoomId = this.roomId;
    const expectedQueueRevision = this.queueRevision;
    const previousQueue = [...(this.lastKnownQueue || [])];
    this.lastQueueReorderTime = Date.now();
    this.lastKnownQueue = newQueue;
    this.lastKnownQueueStr = JSON.stringify(newQueue);
    this.saveLocalQueue(newQueue);
    this.onEvent('QUEUE_UPDATED', { queue: newQueue });
    this.broadcastRoomQueue(newQueue);

    try {
      const res = await fetchQueueMutation('/api/room?action=reorder_queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: requestRoomId,
          peerId: this.peerId,
          hostToken: this.hostToken,
          queue: newQueue,
          expectedQueueRevision
        })
      });
      const data = await res.json();
      if (this.roomId !== requestRoomId) return false;
      const queueSnapshotCurrent = this.rememberQueueRevision(data, requestRoomId);
      if (!res.ok || !data.success) {
        if (res.status === 409 && queueSnapshotCurrent && Array.isArray(data.queue)) {
          this.applyCanonicalQueue(data.queue);
          this.onEvent('QUEUE_SYNC_ERROR', { queue: data.queue, message: 'Antrean berubah di perangkat lain. Susunan terbaru sudah dimuat.' });
        } else {
          const canRollback = queueSnapshotCurrent
            && (this.queueRevisionRoomId !== requestRoomId || this.queueRevision === expectedQueueRevision);
          if (canRollback) this.applyCanonicalQueue(previousQueue);
          this.onEvent('QUEUE_SYNC_ERROR', {
            queue: this.lastKnownQueue,
            message: canRollback
              ? 'Susunan antrean gagal disimpan. Perubahan dipulihkan; coba lagi.'
              : 'Antrean sudah berubah di perangkat lain. Susunan terbaru tetap dipakai.'
          });
        }
        return false;
      }
      if (queueSnapshotCurrent && data.queue) {
        this.applyCanonicalQueue(data.queue, data.queueRevision);
        this.broadcastRoomQueue(data.queue);
      }
      return true;
    } catch (error) {
      if (this.roomId !== requestRoomId) return false;
      if (this.queueRevisionRoomId !== requestRoomId || this.queueRevision === expectedQueueRevision) {
        this.applyCanonicalQueue(previousQueue);
      }
      this.onEvent('QUEUE_SYNC_ERROR', {
        queue: this.lastKnownQueue,
        message: error.name === 'TimeoutError'
          ? 'Room lambat merespons. Susunan antrean dipulihkan; coba lagi.'
          : 'Susunan antrean gagal disimpan. Perubahan dipulihkan; coba lagi.'
      });
      return false;
    }
  }

  async removeFromQueue(queueId) {
    if (!this.isHost) return;
    const requestRoomId = this.roomId;
    const expectedQueueRevision = this.queueRevision;
    let queueSnapshotCurrent = true;
    queueId = resolveQueueItemKey(this.lastKnownQueue || [], queueId);
    const previousQueue = [...(this.lastKnownQueue || [])];
    if (queueId) {
      this.deletedQueueIds.add(queueId);
      this.lastKnownQueue = (this.lastKnownQueue || []).filter(q => queueItemKey(q) !== queueId);
      this.lastKnownQueueStr = JSON.stringify(this.lastKnownQueue);
      this.saveLocalQueue(this.lastKnownQueue);
      this.onEvent('QUEUE_UPDATED', { queue: this.lastKnownQueue });
      this.broadcastRoomQueue(this.lastKnownQueue);
    }

    try {
      const res = await fetchQueueMutation('/api/room?action=remove_queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: requestRoomId,
          peerId: this.peerId,
          hostToken: this.hostToken,
          queueId,
          expectedQueueRevision
        })
      });
      const data = await res.json();
      if (this.roomId !== requestRoomId) return false;
      queueSnapshotCurrent = this.rememberQueueRevision(data, requestRoomId);
      if (res.status === 409) {
        if (queueId) this.deletedQueueIds.delete(queueId);
        if (queueSnapshotCurrent) this.applyCanonicalQueue(data.queue);
        this.onEvent('QUEUE_SYNC_ERROR', { queue: this.lastKnownQueue, message: 'Antrean berubah di perangkat lain. Coba lagi.' });
        return false;
      }
      if (!res.ok || !data.success) throw new Error('QUEUE_REMOVE_FAILED');
      if (queueSnapshotCurrent && data.queue) {
        this.lastKnownQueue = data.queue.filter(q => !this.deletedQueueIds.has(queueItemKey(q)));
        this.lastKnownQueueStr = JSON.stringify(this.lastKnownQueue);
        this.onEvent('QUEUE_UPDATED', { queue: this.lastKnownQueue });
      }
      return true;
    } catch (error) {
      if (this.roomId !== requestRoomId) return false;
      if (queueId) this.deletedQueueIds.delete(queueId);
      if (queueSnapshotCurrent && (this.queueRevisionRoomId !== requestRoomId || this.queueRevision === expectedQueueRevision)) {
        this.applyCanonicalQueue(previousQueue);
      }
      this.onEvent('QUEUE_SYNC_ERROR', { queue: this.lastKnownQueue, message: 'Lagu gagal dihapus dari room. Antrean dipulihkan; coba lagi.' });
      return false;
    }
  }

  async clearQueue(queueIds) {
    if (!this.isHost || !Array.isArray(queueIds) || queueIds.length === 0) return { removed: [], queue: this.lastKnownQueue || [] };
    const requestRoomId = this.roomId;
    const expectedQueueRevision = this.queueRevision;
    let queueSnapshotCurrent = true;
    queueIds = queueIds.map(id => resolveQueueItemKey(this.lastKnownQueue || [], id));
    const currentTrackId = queueItemKey(this.lastKnownTrack);
    const ids = new Set(queueIds.filter(id => id && id !== currentTrackId));
    const previousQueue = this.lastKnownQueue || [];
    this.lastKnownQueue = previousQueue.filter(item => !ids.has(queueItemKey(item)));
    ids.forEach(id => this.deletedQueueIds.add(id));
    this.lastKnownQueueStr = JSON.stringify(this.lastKnownQueue);
    this.saveLocalQueue(this.lastKnownQueue);
    this.onEvent('QUEUE_UPDATED', { queue: this.lastKnownQueue });
    this.broadcastRoomQueue(this.lastKnownQueue);

    try {
      const res = await fetchQueueMutation('/api/room?action=clear_queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: requestRoomId, peerId: this.peerId, hostToken: this.hostToken, queueIds: [...ids], expectedQueueRevision })
      });
      const data = await res.json();
      if (this.roomId !== requestRoomId) return { removed: [], queue: this.lastKnownQueue || [] };
      queueSnapshotCurrent = this.rememberQueueRevision(data, requestRoomId);
      if (res.status === 409) {
        ids.forEach(id => this.deletedQueueIds.delete(id));
        if (queueSnapshotCurrent) this.applyCanonicalQueue(data.queue);
        this.onEvent('QUEUE_SYNC_ERROR', { queue: this.lastKnownQueue, message: 'Antrean berubah di perangkat lain. Coba lagi.' });
        return { removed: [], queue: this.lastKnownQueue || [] };
      }
      if (!res.ok || !data.success) throw new Error(data.error || 'QUEUE_CLEAR_FAILED');
      if (queueSnapshotCurrent) {
        this.lastKnownQueue = data.queue || [];
        this.lastKnownQueueStr = JSON.stringify(this.lastKnownQueue);
        this.saveLocalQueue(this.lastKnownQueue);
        this.onEvent('QUEUE_UPDATED', { queue: this.lastKnownQueue });
        this.broadcastRoomQueue(this.lastKnownQueue);
      }
      return { removed: data.removed || [], queue: this.lastKnownQueue };
    } catch (error) {
      if (this.roomId !== requestRoomId) return { removed: [], queue: this.lastKnownQueue || [] };
      if (queueSnapshotCurrent && (this.queueRevisionRoomId !== requestRoomId || this.queueRevision === expectedQueueRevision)) {
        ids.forEach(id => this.deletedQueueIds.delete(id));
        this.lastKnownQueue = previousQueue;
        this.lastKnownQueueStr = JSON.stringify(previousQueue);
        this.saveLocalQueue(previousQueue);
        this.onEvent('QUEUE_UPDATED', { queue: previousQueue });
      }
      this.onEvent('QUEUE_SYNC_ERROR', { queue: this.lastKnownQueue, message: 'Antrean tidak jadi dikosongkan. Coba lagi.' });
      return { removed: [], queue: this.lastKnownQueue || [] };
    }
  }

  async restoreQueue(removed) {
    if (!this.isHost || !Array.isArray(removed) || removed.length === 0) return false;
    const requestRoomId = this.roomId;
    removed.forEach(entry => this.deletedQueueIds.delete(queueItemKey(entry.item)));
    try {
      const res = await fetchQueueMutation('/api/room?action=restore_queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: requestRoomId, peerId: this.peerId, hostToken: this.hostToken, removed, expectedQueueRevision: this.queueRevision })
      });
      const data = await res.json();
      if (this.roomId !== requestRoomId) return false;
      const queueSnapshotCurrent = this.rememberQueueRevision(data, requestRoomId);
      if (res.status === 409) {
        removed.forEach(entry => this.deletedQueueIds.add(queueItemKey(entry.item)));
        if (queueSnapshotCurrent) this.applyCanonicalQueue(data.queue);
        this.onEvent('QUEUE_SYNC_ERROR', { queue: this.lastKnownQueue, message: 'Antrean berubah di perangkat lain. Undo tidak diterapkan.' });
        return false;
      }
      if (!res.ok || !data.success) throw new Error(data.error || 'QUEUE_RESTORE_FAILED');
      if (queueSnapshotCurrent) {
        this.lastKnownQueue = data.queue || [];
        this.lastKnownQueueStr = JSON.stringify(this.lastKnownQueue);
        this.saveLocalQueue(this.lastKnownQueue);
        this.onEvent('QUEUE_UPDATED', { queue: this.lastKnownQueue });
        this.broadcastRoomQueue(this.lastKnownQueue);
      }
      return true;
    } catch (error) {
      if (this.roomId !== requestRoomId) return false;
      removed.forEach(entry => this.deletedQueueIds.add(queueItemKey(entry.item)));
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
      const queueSnapshotCurrent = this.rememberQueueRevision(data, this.roomId);
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
      if (queueSnapshotCurrent && data.queue) {
        this.lastKnownQueue = data.queue;
        this.lastKnownQueueStr = JSON.stringify(data.queue);
        this.saveLocalQueue(data.queue);
        this.onEvent('QUEUE_UPDATED', { queue: data.queue });
        this.broadcastRoomQueue(data.queue);
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
      const queueSnapshotCurrent = this.rememberQueueRevision(data, this.roomId);
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
      if (queueSnapshotCurrent && data.queue) {
        this.lastKnownQueue = data.queue;
        this.lastKnownQueueStr = JSON.stringify(data.queue);
        this.saveLocalQueue(data.queue);
        this.onEvent('QUEUE_UPDATED', { queue: data.queue });
        this.broadcastRoomQueue(data.queue);
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
      if (attempts >= P2P_BUFFER_REQUEST_MAX_ATTEMPTS) {
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
    const controller = new AbortController();
    this.activeAudioAbortController = controller;
    const signal = controller.signal;
    const audioRoute = url.startsWith('/api/') ? 'relay' : 'direct';
    this.broadcastReadiness('PREPARING', trackId, audioRoute);
    let timedOut = false;
    let timeout;
    let reader = null;
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, REMOTE_AUDIO_FETCH_TIMEOUT_MS);
    };
    resetTimeout();

    if (!this.incomingAudioChunks.size) {
      this.updateLoadingState(true, `Mengunduh ${trackName} (0%)...`);
      this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 0, status: `Mengunduh ${trackName} (0%)...` });
    }
    try {
      let response;
      try {
        response = await fetch(url, { signal });
        resetTimeout();
        if (!response.ok && url.startsWith('http') && !url.includes('/api/stream') && !url.includes('/api/room')) {
          throw new Error('DIRECT_FETCH_FAILED');
        }
      } catch (fetchErr) {
        if (signal.aborted && !timedOut) return;
        if (timedOut) throw new Error('AUDIO_FETCH_TIMEOUT');
        if (url.startsWith('http') && !url.includes('/api/stream') && !url.includes('/api/room')) {
          const proxyUrl = `/api/stream?url=${encodeURIComponent(url)}`;
          resetTimeout();
          response = await fetch(proxyUrl, { signal });
          resetTimeout();
        } else {
          throw fetchErr;
        }
      }

      if (signal.aborted && !timedOut) return;
      if (timedOut) throw new Error('AUDIO_FETCH_TIMEOUT');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const contentLength = response.headers?.get('content-length');
      const declaredBytes = contentLength ? Number.parseInt(contentLength, 10) : 0;
      const hasDeclaredLength = Number.isSafeInteger(declaredBytes) && declaredBytes > 0;
      if (hasDeclaredLength && declaredBytes > MAX_REMOTE_AUDIO_BYTES) {
        try { await response.body?.cancel?.(); } catch (error) { }
        throw new Error('AUDIO_TOO_LARGE');
      }

      let arrayBuffer;
      if (response.body) {
        reader = response.body.getReader();
        const chunks = [];
        let receivedBytes = 0;

        while (true) {
          if (signal.aborted && !timedOut) return;
          if (timedOut) throw new Error('AUDIO_FETCH_TIMEOUT');
          const { done, value } = await reader.read();
          if (done) break;
          resetTimeout();
          const chunkBytes = value?.byteLength ?? value?.length;
          if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || receivedBytes + chunkBytes > MAX_REMOTE_AUDIO_BYTES) {
            throw new Error('AUDIO_TOO_LARGE');
          }
          chunks.push(value);
          receivedBytes += chunkBytes;
          if (hasDeclaredLength) {
            const pct = Math.min(99, Math.round((receivedBytes / declaredBytes) * 100));
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
        if (!hasDeclaredLength) throw new Error('AUDIO_SIZE_UNKNOWN');
        arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > MAX_REMOTE_AUDIO_BYTES) throw new Error('AUDIO_TOO_LARGE');
      }

      this.localAudioBufferCache.set(trackName, arrayBuffer);
      if (this.peerBufferRequestInterval) clearInterval(this.peerBufferRequestInterval);
      this.peerBufferRequestInterval = null;
      this.peerBufferRequestTrackKey = null;
      if (trackId) this.localAudioBufferCache.set(trackId, arrayBuffer);
      this.localAudioBufferCache.set(url, arrayBuffer);
      this.currentAudioArrayBuffer = arrayBuffer;
      this.audioRouteByTrack.set(trackId || trackName, audioRoute);
      this.cancelP2PTransfersForTrack(trackId);

      this.currentFetchingTrackKey = null;
      this.pendingTrackBufferRequest = null;
      this.updateLoadingState(false, 'Siap');
      this.broadcastReadiness('READY', trackId, audioRoute);
      this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 100, status: 'Audio siap!' });
      this.onEvent('BINARY_AUDIO_RECEIVED', { arrayBuffer, trackName, trackId });
    } catch (err) {
      if (signal.aborted && !timedOut) return;
      try { reader?.cancel?.().catch(() => {}); } catch (error) { }
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
    const preparationStartedAt = trackId && this.trackPreparationStartedAt.get(trackId);
    if (preparationStartedAt !== undefined && (readiness === 'READY' || readiness === 'FAILED')) {
      recordLocalMetric('audio_ready_ms', (globalThis.performance?.now?.() ?? Date.now()) - preparationStartedAt, {
        outcome: readiness === 'READY' ? 'success' : 'failure'
      });
      this.trackPreparationStartedAt.delete(trackId);
    }
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
      const state = pc.connectionState;
      const connectionStartedAt = this.peerConnectionStartedAt.get(targetPeerId);
      if (state === 'connected' && connectionStartedAt !== undefined) {
        recordLocalMetric('webrtc_connect_ms', (globalThis.performance?.now?.() ?? Date.now()) - connectionStartedAt);
        this.peerConnectionStartedAt.delete(targetPeerId);
      }
      const disconnectTimer = this.peerDisconnectTimers.get(targetPeerId);
      if (state === 'connected' || state === 'connecting') {
        if (disconnectTimer) clearTimeout(disconnectTimer);
        this.peerDisconnectTimers.delete(targetPeerId);
        return;
      }
      if (state === 'disconnected') {
        if (!disconnectTimer) {
          const timer = setTimeout(() => {
            this.peerDisconnectTimers.delete(targetPeerId);
            if (pc.connectionState === 'disconnected' && this.peerConnections.get(targetPeerId) === pc) {
              this.cleanupPeerConnection(targetPeerId, pc);
            }
          }, 8_000);
          this.peerDisconnectTimers.set(targetPeerId, timer);
        }
        return;
      }
      if (state === 'failed' || state === 'closed') {
        if (state === 'failed' && connectionStartedAt !== undefined) {
          recordLocalMetric('webrtc_connect_ms', (globalThis.performance?.now?.() ?? Date.now()) - connectionStartedAt, { outcome: 'failure' });
        }
        this.cleanupPeerConnection(targetPeerId, pc);
      }
    };

    pc.ondatachannel = (event) => {
      this.setupDataChannel(targetPeerId, event.channel);
    };

    this.peerConnections.set(targetPeerId, pc);
    this.peerConnectionStartedAt.set(targetPeerId, globalThis.performance?.now?.() ?? Date.now());
    return pc;
  }

  cleanupPeerConnection(targetPeerId, expectedPeer = null) {
    const pc = this.peerConnections.get(targetPeerId);
    if (expectedPeer && pc !== expectedPeer) return;
    const timer = this.peerDisconnectTimers.get(targetPeerId);
    if (timer) clearTimeout(timer);
    this.peerDisconnectTimers.delete(targetPeerId);
    this.peerConnectionStartedAt.delete(targetPeerId);
    if (pc) {
      try { pc.close(); } catch (e) { }
      this.peerConnections.delete(targetPeerId);
    }
    this.dataChannels.delete(targetPeerId);
    this.pendingIceCandidates.delete(targetPeerId);
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
          queueRevision: this.queueRevision,
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
              lastProgressPct: 0,
              receivedBytes: 0,
              nextChunkIndex: 0,
              buffer: null
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
            if (this.isCurrentAudioTrack(msg.id, msg.name)) {
              this.broadcastReadiness('PREPARING', msg.id || '', 'p2p');
              this.updateLoadingState(true, `Menerima ${msg.name}...`);
              this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 0, status: `Menerima ${msg.name} P2P...` });
            }
          } else if (msg.type === 'AUDIO_TRANSFER_FAILED') {
            const allowedStatuses = [
              'Koneksi P2P lambat atau macet. Coba lagi.',
              'Penerima tidak mengonfirmasi P2P. Coba lagi atau pilih sumber lain.',
              'Koneksi P2P terputus. Coba lagi.',
              'Audio terlalu besar untuk transfer P2P (maks. 64 MiB).'
            ];
            const status = allowedStatuses.includes(msg.status) ? msg.status : 'Transfer audio P2P gagal. Coba lagi.';
            this.failIncomingAudioTransfer(targetPeerId, msg.id || '', status, msg.name || '');
          } else if (msg.type === 'AUDIO_TRANSFER_CANCEL') {
            this.cancelIncomingAudioTransfer(targetPeerId, msg.id || '');
            const activeTransfer = this.activeBufferTransfers.get(channel);
            if (activeTransfer?.trackId === (msg.id || '')) {
              activeTransfer.cancelled = true;
              if (activeTransfer.pending?.trackId === activeTransfer.trackId) activeTransfer.pending = null;
            }
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
              this.applyRealtimeQueue(msg.queue, msg.queueRevision);
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
          let chunkOffset = 0;
          let chunkLength = event.data.byteLength;
          if (stream.chunkProtocol === 1) {
            if (event.data.byteLength <= P2P_AUDIO_FRAME_HEADER_BYTES
              || event.data.byteLength > P2P_AUDIO_CHUNK_BYTES + P2P_AUDIO_FRAME_HEADER_BYTES) {
              this.failIncomingAudioTransfer(targetPeerId, stream.id, 'Paket audio P2P tidak valid.', stream.name);
              return;
            }
            const frame = new DataView(event.data);
            const sequence = frame.getUint32(0, true);
            const timestamp = frame.getFloat64(4, true);
            if (sequence !== stream.nextChunkIndex || !Number.isFinite(timestamp) || timestamp < stream.lastChunkTimestamp) {
              this.failIncomingAudioTransfer(targetPeerId, stream.id, 'Paket audio P2P tidak valid.', stream.name);
              return;
            }
            stream.lastChunkTimestamp = timestamp;
            chunkOffset = P2P_AUDIO_FRAME_HEADER_BYTES;
            chunkLength -= P2P_AUDIO_FRAME_HEADER_BYTES;
          }
          if (chunkLength === 0
            || chunkLength > P2P_AUDIO_CHUNK_BYTES
            || stream.receivedBytes + chunkLength > stream.totalBytes
            || stream.nextChunkIndex >= stream.totalChunks) {
            this.failIncomingAudioTransfer(targetPeerId, stream.id, 'Paket audio P2P tidak valid.', stream.name);
            return;
          }
          if (!stream.buffer) stream.buffer = new Uint8Array(stream.totalBytes);
          stream.buffer.set(new Uint8Array(event.data, chunkOffset, chunkLength), stream.receivedBytes);
          stream.receivedBytes += chunkLength;
          stream.nextChunkIndex += 1;
          stream.resetTimeout?.();
          const pct = Math.min(99, Math.round((stream.receivedBytes / stream.totalBytes) * 100));
          if (this.isCurrentAudioTrack(stream.id, stream.name) && pct > stream.lastProgressPct) {
            stream.lastProgressPct = pct;
            this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct, status: `Menerima P2P (${pct}%)...` });
          }

          if (stream.nextChunkIndex === stream.totalChunks) {
            if (stream.receivedBytes !== stream.totalBytes) {
              this.failIncomingAudioTransfer(targetPeerId, stream.id, 'Transfer audio P2P terpotong.', stream.name);
              return;
            }
            const completeBuffer = stream.buffer;
            const trackName = stream.name;
            const trackId = stream.id;
            const trackKey = trackId || trackName;
            const wasCached = this.localAudioBufferCache.has(trackKey);
            this.incomingAudioChunks.delete(targetPeerId);
            if (stream.timeout) clearTimeout(stream.timeout);
            if (this.peerBufferRequestInterval && this.peerBufferRequestTrackKey === trackKey) {
              clearInterval(this.peerBufferRequestInterval);
              this.peerBufferRequestInterval = null;
              this.peerBufferRequestTrackKey = null;
            }
            this.localAudioBufferCache.set(trackName, completeBuffer.buffer);
            if (trackId) this.localAudioBufferCache.set(trackId, completeBuffer.buffer);
            if (wasCached) {
              try {
                channel.send(JSON.stringify({ type: 'AUDIO_TRANSFER_ACK', id: trackId || '', success: true }));
              } catch (error) { }
              if (this.isCurrentAudioTrack(trackId, trackName)) {
                this.currentAudioArrayBuffer = completeBuffer.buffer;
                this.currentFetchingTrackKey = null;
                this.pendingTrackBufferRequest = null;
                this.updateLoadingState(false, 'Siap');
                this.broadcastReadiness('READY', trackId, this.audioRouteByTrack.get(trackKey) || 'cache');
                this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 100, status: 'Audio siap!' });
              }
              return;
            }
            this.audioRouteByTrack.set(trackKey, 'p2p');
            if (this.isCurrentAudioTrack(trackId, trackName)) {
              this.currentAudioArrayBuffer = completeBuffer.buffer;
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
            }
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
    let pc;
    try {
      pc = this.createPeerConnection(targetPeerId);
      const channel = pc.createDataChannel('audioMesh', { ordered: true });
      this.setupDataChannel(targetPeerId, channel);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sent = await this.sendSignal(targetPeerId, {
        type: 'offer',
        sdp: pc.localDescription.toJSON()
      });
      if (!sent) throw new Error('WEBRTC_OFFER_SIGNAL_FAILED');
      return true;
    } catch (e) {
      if (pc) this.cleanupPeerConnection(targetPeerId, pc);
      console.warn('WebRTC offer error:', e.message);
      return false;
    }
  }

  async sendSignal(targetPeerId, signalData) {
    const signal = { ...signalData, signalId: signalData.signalId || createSignalId() };
    const mqttSent = this.publishMqtt(`rync432/v1/peer/${targetPeerId}`, {
      type: 'SIGNAL',
      from: this.peerId,
      data: signal
    });

    try {
      const response = await fetch('/api/room?action=signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: this.roomId,
          peerId: this.peerId,
          to: targetPeerId,
          data: signal
        })
      });
      return response.ok === true || mqttSent;
    } catch (error) {
      return mqttSent;
    }
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
    if (!signalData || typeof signalData !== 'object') return;
    if (typeof signalData.signalId === 'string' && signalData.signalId.length <= 100) {
      const signalKey = `${fromPeerId}:${signalData.signalId}`;
      if (this.seenSignalIds.has(signalKey)) return;
      this.seenSignalIds.add(signalKey);
      if (this.seenSignalIds.size > SIGNAL_DEDUPE_MAX_ITEMS) {
        this.seenSignalIds.delete(this.seenSignalIds.values().next().value);
      }
    }
    if (signalData.type === 'CONTROL_REQUEST') {
      if (this.isHost && signalData.peerId === fromPeerId) this.receiveControlRequest(signalData);
      return;
    }
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
    const active = this.activeBufferTransfers.get(channel);
    if (active) {
      if (active.trackId === trackId && !active.cancelled) return active.promise;
      active.pending = { arrayBuffer, trackName, trackId };
      if (!active.cancelled) {
        active.cancelled = true;
        try { channel.send(JSON.stringify({ type: 'AUDIO_TRANSFER_CANCEL', id: active.trackId })); } catch (error) { }
      }
      return active.promise.then(() => false, () => false);
    }
    const transfer = { trackId, cancelled: false, pending: null, promise: null };
    this.activeBufferTransfers.set(channel, transfer);
    transfer.promise = Promise.resolve(this.streamAudioToPeer(channel, arrayBuffer, trackName, trackId, transfer))
      .finally(() => {
        if (this.activeBufferTransfers.get(channel) !== transfer) return;
        this.activeBufferTransfers.delete(channel);
        if (transfer.pending && channel.readyState === 'open') {
          this.sendAudioTransferToPeer(channel, transfer.pending.arrayBuffer, transfer.pending.trackName, transfer.pending.trackId);
        }
      });
    return transfer.promise;
  }

  async streamAudioToPeer(channel, arrayBuffer, trackName = 'Uploaded Track', trackId = '', transferControl = null) {
    if (!channel || channel.readyState !== 'open' || !arrayBuffer) return false;
    const totalBytes = arrayBuffer.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || totalBytes > MAX_P2P_AUDIO_BYTES) {
      this.reportPeerAudioTransferFailure(channel, trackId, trackName, 'Audio terlalu besar untuk transfer P2P (maks. 64 MiB).');
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
        if (transferControl?.cancelled) throw new Error('P2P_TRANSFER_SUPERSEDED');
        if (channel.readyState !== 'open') throw new Error('P2P_CHANNEL_CLOSED');

        const backpressureStartedAt = Date.now();
        while (channel.bufferedAmount > 512 * 1024 && channel.readyState === 'open') {
          if (transferControl?.cancelled) throw new Error('P2P_TRANSFER_SUPERSEDED');
          if (Date.now() - backpressureStartedAt >= P2P_AUDIO_BACKPRESSURE_TIMEOUT_MS) {
            throw new Error('P2P_BACKPRESSURE_TIMEOUT');
          }
          await new Promise(r => setTimeout(r, P2P_BACKPRESSURE_POLL_INTERVAL_MS));
        }
        if (channel.readyState !== 'open') throw new Error('P2P_CHANNEL_CLOSED');

        const chunk = new Uint8Array(arrayBuffer, offset, Math.min(P2P_AUDIO_CHUNK_BYTES, totalBytes - offset));
        const frameBuffer = new ArrayBuffer(P2P_AUDIO_FRAME_HEADER_BYTES + chunk.byteLength);
        const frame = new DataView(frameBuffer);
        frame.setUint32(0, Math.floor(offset / P2P_AUDIO_CHUNK_BYTES), true);
        frame.setFloat64(4, globalThis.performance?.now?.() ?? Date.now(), true);
        new Uint8Array(frameBuffer, P2P_AUDIO_FRAME_HEADER_BYTES).set(chunk);
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
        pending.resolve(false);
      }
      if (e.message === 'P2P_TRANSFER_SUPERSEDED') return false;
      console.warn('P2P stream notice:', e.message);
      const status = e.message === 'P2P_BACKPRESSURE_TIMEOUT'
        ? 'Koneksi P2P lambat atau macet. Coba lagi.'
        : e.message === 'P2P_ACK_TIMEOUT'
          ? 'Penerima tidak mengonfirmasi P2P. Coba lagi atau pilih sumber lain.'
        : 'Koneksi P2P terputus. Coba lagi.';
      this.reportPeerAudioTransferFailure(channel, trackId, trackName, status);
      return false;
    }
  }

  reportPeerAudioTransferFailure(channel, trackId, trackName, status) {
    const peerId = [...this.dataChannels.entries()].find(([, candidate]) => candidate === channel)?.[0];
    const peer = peerId && this.localPeersMap.get(peerId);
    if (peer) {
      peer.readiness = 'FAILED';
      peer.isAudioLoading = false;
      peer.loadingStatus = status;
      this.dispatchLocalPeers();
    }
    if (channel?.readyState === 'open') {
      const id = typeof trackId === 'string' ? trackId.slice(0, 160) : '';
      const name = typeof trackName === 'string' ? trackName.slice(0, 200) : '';
      try { channel.send(JSON.stringify({ type: 'AUDIO_TRANSFER_FAILED', id, name, status })); } catch (error) { }
    }
    this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 0, status, peerId });
  }

  cancelIncomingAudioTransfer(peerId, trackId) {
    const transfer = this.incomingAudioChunks.get(peerId);
    if (!transfer || transfer.id !== trackId) return;
    if (transfer.timeout) clearTimeout(transfer.timeout);
    this.incomingAudioChunks.delete(peerId);
    const trackKey = transfer.id || transfer.name;
    if (this.peerBufferRequestInterval && this.peerBufferRequestTrackKey === trackKey) {
      clearInterval(this.peerBufferRequestInterval);
      this.peerBufferRequestInterval = null;
      this.peerBufferRequestTrackKey = null;
    }
    const channel = this.dataChannels.get(peerId);
    if (channel?.readyState === 'open') {
      try { channel.send(JSON.stringify({ type: 'AUDIO_TRANSFER_ACK', id: trackId || '', success: false })); } catch (error) { }
    }
  }

  cancelP2PTransfersForTrack(trackId) {
    if (!trackId) return;
    for (const [peerId, transfer] of this.incomingAudioChunks) {
      if (transfer.id !== trackId) continue;
      const channel = this.dataChannels.get(peerId);
      if (channel?.readyState === 'open') {
        try { channel.send(JSON.stringify({ type: 'AUDIO_TRANSFER_CANCEL', id: trackId })); } catch (error) { }
      }
      this.cancelIncomingAudioTransfer(peerId, trackId);
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
    if (this.isCurrentAudioTrack(trackId, trackName)) {
      this.updateLoadingState(false, status);
      this.broadcastReadiness('FAILED', trackId);
      this.onEvent('AUDIO_TRANSFER_PROGRESS', { pct: 0, status });
    }
  }

  isCurrentAudioTrack(trackId, trackName = '') {
    const track = this.pendingTrackBufferRequest || this.lastKnownTrack;
    if (!track) return true;
    return trackId ? track.id === trackId : track.name === trackName;
  }

  async removeRemotePeer(targetPeerId) {
    this.localPeersMap.delete(targetPeerId);
    this.dispatchLocalPeers();

    const pc = this.peerConnections.get(targetPeerId);
    this.cleanupPeerConnection(targetPeerId, pc);

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
        const url = '/api/room?action=leave_room';
        const body = JSON.stringify({ roomId, peerId, hostToken: this.hostToken || undefined });
        const queued = typeof navigator.sendBeacon === 'function'
          && navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
        if (!queued) fetch(url, {
          method: 'POST', keepalive: true,
          headers: { 'Content-Type': 'application/json' }, body
        }).catch(() => {});
      } catch (e) { }
    }
    this.peerConnections.forEach(peer => {
      try { peer.close(); } catch (e) { }
    });
    this.peerDisconnectTimers.forEach(timer => clearTimeout(timer));
    this.peerDisconnectTimers.clear();
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
    this.seenSignalIds.clear();
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
