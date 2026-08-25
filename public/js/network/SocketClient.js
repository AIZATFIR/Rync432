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

    this.ws = null;
    this.roomId = null;
    this.peerId = null;
    this.isHost = false;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 3;
    this.reconnectDelay = 2000;
    this.pingInterval = null;
    this.cachedDeviceName = 'Speaker';

    // Serverless CloudMesh (WebRTC + BroadcastChannel + Firebase Firestore)
    this.cloudMesh = new CloudMesh((event, payload) => {
      this.handleCloudMeshEvent(event, payload);
    });
  }

  connect(url = null) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = url || `${protocol}//${host}`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.onEvent('CONNECTED');
        this.startPingLoop();
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleMessage(data);
        } catch (err) {
          console.error('Failed to parse WebSocket message:', err);
        }
      };

      this.ws.onclose = () => {
        this.isConnected = false;
        this.stopPingLoop();
        this.onEvent('DISCONNECTED');
        this.attemptReconnect(wsUrl);
      };

      this.ws.onerror = () => {
        this.isConnected = false;
      };
    } catch (err) {
      this.isConnected = false;
    }
  }

  attemptReconnect(wsUrl) {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      setTimeout(() => {
        this.connect(wsUrl);
      }, this.reconnectDelay);
    }
  }

  startPingLoop() {
    this.stopPingLoop();
    this.pingInterval = setInterval(() => {
      if (this.isConnected) {
        this.clockSync.sendPing((t0) => {
          this.send('PING', { clientSendTime: t0 });
        });
      }
    }, 3000);
  }

  stopPingLoop() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  send(type, payload = {}) {
    if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload }));
    }
  }

  // Democratic Room Controls
  createRoom(deviceName = 'Master Speaker') {
    this.cachedDeviceName = deviceName;
    this.peerId = 'peer_' + Math.random().toString(36).substring(2, 9);
    this.roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
    this.isHost = true;

    if (this.isConnected) {
      this.send('CREATE_ROOM', { deviceName });
    }

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

    if (this.isConnected) {
      this.send('JOIN_ROOM', { roomId: this.roomId, deviceName });
    }

    this.cloudMesh.joinRoom(this.roomId, this.peerId, deviceName);
    this.onEvent('ROOM_JOINED', {
      roomId: this.roomId,
      peerId: this.peerId,
      isHost: false
    });
  }

  schedulePlay(delayMs = 250, startOffsetSec = 0) {
    const targetServerTime = this.clockSync.getServerTime() + delayMs;
    this.send('SCHEDULE_PLAY', { targetServerTime, startOffsetSec });
    this.cloudMesh.broadcastPlay(targetServerTime, startOffsetSec);
    // Optimistic local dispatch
    this.onEvent('SCHEDULED_PLAY', { targetServerTime, startOffsetSec });
  }

  pausePlayback(currentOffsetSec = 0) {
    this.send('PAUSE', { currentOffsetSec });
    this.cloudMesh.broadcastPause(currentOffsetSec);
    // Optimistic local dispatch
    this.onEvent('PAUSED', { currentOffsetSec });
  }

  sendTrackMetadata(metadata) {
    this.send('TRACK_METADATA', metadata);
    this.cloudMesh.broadcastTrack(metadata);
  }

  updateLatencyOffset(offsetMs) {
    this.send('UPDATE_LATENCY_OFFSET', { latencyOffset: offsetMs });
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

  handleMessage(data) {
    const { type, payload } = data;
    switch (type) {
      case 'ROOM_CREATED':
        this.roomId = payload.roomId;
        this.peerId = payload.peerId;
        this.isHost = true;
        this.onEvent('ROOM_CREATED', payload);
        break;
      case 'ROOM_JOINED':
        this.roomId = payload.roomId;
        this.peerId = payload.peerId;
        this.isHost = payload.isHost;
        this.onEvent('ROOM_JOINED', payload);
        break;
      case 'PEER_JOINED':
      case 'PEER_LEFT':
        this.onEvent(type, payload);
        break;
      case 'PONG':
        this.clockSync.handlePong(payload.clientSendTime, payload.serverReceiveTime, payload.serverSendTime);
        break;
      case 'SCHEDULED_PLAY':
      case 'PAUSED':
      case 'TRACK_METADATA':
      case 'PEER_LATENCY_UPDATED':
      case 'ERROR':
        this.onEvent(type, payload);
        break;
    }
  }
}
