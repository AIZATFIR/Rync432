import { ClockSync } from '../audio/ClockSync.js';
import { CloudMesh } from './CloudMesh.js';

export class SocketClient {
  constructor(clockSyncOrOnEvent, onEvent) {
    if (typeof clockSyncOrOnEvent === 'function') {
      this.clockSync = new ClockSync();
      this.onEvent = clockSyncOrOnEvent;
    } else {
      this.clockSync = clockSyncOrOnEvent || new ClockSync();
      this.onEvent = typeof onEvent === 'function' ? onEvent : (() => {});
    }

    this.roomId = null;
    this.peerId = null;
    this.isHost = false;
    this.isConnected = false;
    this.connectionState = 'UNKNOWN';
    this.healthFailureCount = 0;
    this.healthCheckInterval = null;
    this.cachedDeviceName = 'Speaker';
    this.roomReady = Promise.resolve();

    // Serverless CloudMesh
    this.cloudMesh = new CloudMesh((event, payload) => {
      this.handleCloudMeshEvent(event, payload);
    });
    this.cloudMesh.clockSync = this.clockSync;
  }

  connect() {
    this.setConnectionState('RECONNECTING');
    this.checkHealth();
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    this.healthCheckInterval = setInterval(() => this.checkHealth(), 4000);
  }

  setConnectionState(state) {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.isConnected = state === 'CONNECTED';
    this.onEvent(state);
  }

  async checkHealth() {
    const t0 = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(`/api/health?t0=${t0}`, {
        cache: 'no-store',
        signal: controller.signal
      });
      if (!response.ok) throw new Error('HEALTH_CHECK_FAILED');
      const data = await response.json();
      this.healthFailureCount = 0;
      this.setConnectionState('CONNECTED');
      if (data.t1 && data.t2) this.clockSync.handlePong(t0, data.t1, data.t2);
    } catch (error) {
      this.healthFailureCount += 1;
      this.setConnectionState(globalThis.navigator?.onLine === false || this.healthFailureCount >= 2
        ? 'DISCONNECTED' : 'RECONNECTING');
    } finally {
      clearTimeout(timeout);
    }
  }

  createRoom(deviceName = 'Master Speaker') {
    this.cachedDeviceName = deviceName;
    this.peerId = 'peer_' + Math.random().toString(36).substring(2, 9);
    this.roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
    this.isHost = true;
    this.roomReady = this.cloudMesh.createRoom(this.roomId, this.peerId, deviceName);
    this.roomReady.catch(() => {});
    this.roomReady.then(() => {
      this.onEvent('ROOM_CREATED', {
        roomId: this.roomId,
        peerId: this.peerId,
        isHost: true
      });
    }).catch(() => {
      this.roomId = null;
      this.peerId = null;
      this.isHost = false;
    });
    return this.roomReady;
  }

  joinRoom(roomId, deviceName = 'Satellite Speaker') {
    this.cachedDeviceName = deviceName;
    this.roomId = roomId.toUpperCase();
    this.peerId = 'peer_' + Math.random().toString(36).substring(2, 9);
    this.isHost = false;

    this.roomReady = this.cloudMesh.joinRoom(this.roomId, this.peerId, deviceName);
    this.roomReady.then(room => {
      this.isHost = room?.isHost === true;
      this.onEvent('ROOM_JOINED', {
        roomId: this.roomId,
        peerId: this.peerId,
        isHost: this.isHost
      });
    }).catch(() => {
      this.roomId = null;
      this.peerId = null;
      this.isHost = false;
    });
    return this.roomReady;
  }

  async schedulePlay(delayMs = 800, startOffsetSec = 0) {
    if (!this.isHost) return false;
    const targetServerTime = this.clockSync.getServerTime() + delayMs;
    const applied = await this.broadcastPlay(targetServerTime, startOffsetSec);
    return applied ? targetServerTime : false;
  }

  async pausePlayback(currentOffsetSec = 0) {
    if (!this.isHost) return false;
    const applied = await this.cloudMesh.broadcastPause(currentOffsetSec);
    if (!applied) return false;
    this.onEvent('PAUSED', { currentOffsetSec });
    return true;
  }

  seekPlayback(positionSec) {
    if (!this.isHost || !Number.isFinite(positionSec) || positionSec < 0) return false;
    return this.schedulePlay(250, positionSec);
  }

  async broadcastPlay(targetServerTime, startOffsetSec, track) {
    if (!this.isHost) return false;
    const applied = await this.cloudMesh.broadcastPlay(targetServerTime, startOffsetSec, track);
    if (!applied) return false;
    return true;
  }

  requestControl(action, details = {}) {
    return this.cloudMesh.requestControl(action, details);
  }

  sendTrackMetadata(metadata) {
    this.cloudMesh.broadcastTrack(metadata);
  }

  addToQueue(track) {
    return this.roomReady.then(() => this.cloudMesh.addToQueue(track));
  }

  addQueueItems(tracks) {
    return this.roomReady.then(() => this.cloudMesh.addQueueItems(tracks));
  }

  playQueueItem(queueId, autoplay = false) {
    return this.cloudMesh.playQueueItem(queueId, autoplay);
  }

  playNext(queueId) {
    return this.cloudMesh.playNext(queueId);
  }

  refetchCurrentTrack() {
    this.cloudMesh.refetchCurrentTrack();
  }

  reorderQueue(newQueue) {
    return this.cloudMesh.reorderQueue(newQueue);
  }

  removeFromQueue(queueId) {
    return this.cloudMesh.removeFromQueue(queueId);
  }

  clearQueue(queueIds) {
    return this.cloudMesh.clearQueue(queueIds);
  }

  restoreQueue(removed) {
    return this.cloudMesh.restoreQueue(removed);
  }

  nextTrack(automatic = false, preparedTrackId = null) {
    if (preparedTrackId) return this.cloudMesh.nextTrack(automatic, preparedTrackId);
    return this.cloudMesh.nextTrack(automatic);
  }

  updatePlaybackOptions(options) {
    return this.cloudMesh.updatePlaybackOptions(options);
  }

  prevTrack() {
    this.cloudMesh.prevTrack();
  }

  refetchCurrentTrack() {
    if (this.cloudMesh && this.cloudMesh.lastKnownTrack) {
      this.cloudMesh.loadTrackBuffer(this.cloudMesh.lastKnownTrack);
    }
  }

  updateLatencyOffset(offsetMs) {
    this.cloudMesh.updateLatencyOffset(offsetMs);
  }

  updateRemotePeerSettings(targetPeerId, role, volume) {
    this.cloudMesh.updateRemotePeerSettings(targetPeerId, role, volume);
  }

  removeRemotePeer(targetPeerId) {
    this.cloudMesh.removeRemotePeer(targetPeerId);
  }

  leaveRoom() {
    this.cloudMesh.leaveRoom();
    this.roomId = null;
    this.peerId = null;
    this.isHost = false;
    this.roomReady = Promise.resolve();
    this.onEvent('ROOM_LEFT');
  }

  sendBinary(arrayBuffer, trackName, trackId = '') {
    this.cloudMesh.streamAudioToAllPeers(arrayBuffer, trackName, trackId);
  }

  uploadAudioFile(file, duration) {
    this.cloudMesh.uploadAudioFileToStorage(file, duration);
  }

  handleCloudMeshEvent(event, payload) {
    if (event === 'PEER_JOINED') {
      this.onEvent('PEER_JOINED', payload);
    } else if (event === 'TRACK_METADATA') {
      this.onEvent('TRACK_METADATA', payload);
    } else if (event === 'YOUTUBE_TRACK_REQUESTED') {
      this.onEvent('YOUTUBE_TRACK_REQUESTED', payload);
    } else if (event === 'QUEUE_UPDATED') {
      this.onEvent('QUEUE_UPDATED', payload);
    } else if (event === 'PLAYBACK_OPTIONS_UPDATED') {
      this.onEvent('PLAYBACK_OPTIONS_UPDATED', payload);
    } else if (event === 'HOST_DISCONNECTED' || event === 'HOST_RECONNECTED') {
      this.onEvent(event, payload);
    } else if (event === 'SCHEDULED_PLAY') {
      this.onEvent('SCHEDULED_PLAY', payload);
    } else if (event === 'PAUSED') {
      this.onEvent('PAUSED', payload);
    } else if (event === 'CONTROL_REQUEST') {
      this.onEvent('CONTROL_REQUEST', payload);
    } else if (event === 'CONTROL_REQUEST_FAILED') {
      this.onEvent('CONTROL_REQUEST_FAILED', payload);
    } else if (event === 'BINARY_AUDIO_RECEIVED') {
      this.onEvent('BINARY_AUDIO_RECEIVED', payload);
    } else if (event === 'AUDIO_TRANSFER_PROGRESS') {
      this.onEvent('AUDIO_TRANSFER_PROGRESS', payload);
    } else if (event === 'REMOTE_DEVICE_UPDATED') {
      this.onEvent('REMOTE_DEVICE_UPDATED', payload);
    } else if (event === 'ROOM_ERROR') {
      this.roomId = null;
      this.peerId = null;
      this.isHost = false;
      this.roomReady = Promise.resolve();
      this.onEvent('ROOM_ERROR', payload);
    } else if (event === 'ROOM_LEFT') {
      this.roomId = null;
      this.peerId = null;
      this.isHost = false;
      this.roomReady = Promise.resolve();
      this.onEvent('ROOM_LEFT', payload);
    }
  }
}
