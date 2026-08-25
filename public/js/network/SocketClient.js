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
    this.cachedDeviceName = 'Speaker';

    // Serverless CloudMesh (WebRTC + BroadcastChannel + /api/room relay)
    this.cloudMesh = new CloudMesh((event, payload) => {
      this.handleCloudMeshEvent(event, payload);
    });
  }

  connect() {
    // Verify serverless connectivity via /api/health
    fetch('/api/health')
      .then((res) => res.json())
      .then((data) => {
        this.isConnected = true;
        this.onEvent('CONNECTED');
        if (data.t1 && data.t2) {
          this.clockSync.handlePong(data.t0 || Date.now(), data.t1, data.t2);
        }
      })
      .catch(() => {
        // Fallback online if browser has network
        if (navigator.onLine) {
          this.isConnected = true;
          this.onEvent('CONNECTED');
        } else {
          this.isConnected = false;
          this.onEvent('DISCONNECTED');
        }
      });

    // Health / Clock sync interval
    setInterval(() => {
      const t0 = Date.now();
      fetch(`/api/health?t0=${t0}`)
        .then((res) => res.json())
        .then((data) => {
          if (!this.isConnected) {
            this.isConnected = true;
            this.onEvent('CONNECTED');
          }
          if (data.t1 && data.t2) {
            this.clockSync.handlePong(t0, data.t1, data.t2);
          }
        })
        .catch(() => {
          if (!navigator.onLine && this.isConnected) {
            this.isConnected = false;
            this.onEvent('DISCONNECTED');
          }
        });
    }, 4000);
  }

  // Democratic Room Controls
  createRoom(deviceName = 'Master Speaker') {
    this.cachedDeviceName = deviceName;
    this.peerId = 'peer_' + Math.random().toString(36).substring(2, 9);
    this.roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
    this.isHost = true;

    this.cloudMesh.createRoom(this.roomId, this.peerId, deviceName);
    this.onEvent('ROOM_CREATED', {
      roomId: this.roomId,
      peerId: this.peerId,
      isHost: true
    });
  }

  joinRoom(roomId, deviceName = 'Satellite Speaker') {
    this.cachedDeviceName = deviceName;
    this.roomId = roomId.toUpperCase();
    this.peerId = 'peer_' + Math.random().toString(36).substring(2, 9);
    this.isHost = false;

    this.cloudMesh.joinRoom(this.roomId, this.peerId, deviceName);
    this.onEvent('ROOM_JOINED', {
      roomId: this.roomId,
      peerId: this.peerId,
      isHost: false
    });
  }

  schedulePlay(delayMs = 250, startOffsetSec = 0) {
    const targetServerTime = this.clockSync.getServerTime() + delayMs;
    this.cloudMesh.broadcastPlay(targetServerTime, startOffsetSec);
    this.onEvent('SCHEDULED_PLAY', { targetServerTime, startOffsetSec });
  }

  pausePlayback(currentOffsetSec = 0) {
    this.cloudMesh.broadcastPause(currentOffsetSec);
    this.onEvent('PAUSED', { currentOffsetSec });
  }

  sendTrackMetadata(metadata) {
    this.cloudMesh.broadcastTrack(metadata);
  }

  updateLatencyOffset(offsetMs) {
    this.cloudMesh.updateLatencyOffset(offsetMs);
  }

  updateRemotePeerSettings(targetPeerId, role, volume) {
    this.cloudMesh.updateRemotePeerSettings(targetPeerId, role, volume);
  }

  sendBinary(arrayBuffer, trackName) {
    this.cloudMesh.streamAudioToAllPeers(arrayBuffer, trackName);
  }

  uploadAudioFile(file, duration) {
    this.cloudMesh.uploadAudioFileToStorage(file, duration);
  }

  handleCloudMeshEvent(event, payload) {
    if (event === 'PEER_JOINED') {
      this.onEvent('PEER_JOINED', payload);
    } else if (event === 'TRACK_METADATA') {
      this.onEvent('TRACK_METADATA', payload);
    } else if (event === 'SCHEDULED_PLAY') {
      this.onEvent('SCHEDULED_PLAY', payload);
    } else if (event === 'PAUSED') {
      this.onEvent('PAUSED', payload);
    } else if (event === 'BINARY_AUDIO_RECEIVED') {
      this.onEvent('BINARY_AUDIO_RECEIVED', payload);
    } else if (event === 'AUDIO_TRANSFER_PROGRESS') {
      this.onEvent('AUDIO_TRANSFER_PROGRESS', payload);
    } else if (event === 'REMOTE_DEVICE_UPDATED') {
      this.onEvent('REMOTE_DEVICE_UPDATED', payload);
    }
  }
}
