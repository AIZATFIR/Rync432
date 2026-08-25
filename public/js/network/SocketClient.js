import { ClockSync } from '../audio/ClockSync.js';
import { CloudMesh } from './CloudMesh.js';

export class SocketClient {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.ws = null;
    this.clockSync = new ClockSync((type, payload) => this.send(type, payload));
    this.cloudMesh = new CloudMesh((type, payload) => this.onEvent(type, payload));
    this.roomId = null;
    this.peerId = null;
    this.isHost = false;
    this.statusPingInterval = null;
    this.isServerlessMode = false;
  }

  connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;

    try {
      this.ws = new WebSocket(`${protocol}//${host}`);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this.isServerlessMode = false;
        this.clockSync.useHttpFallback = false;
        this.clockSync.startPeriodicSync(2000);
        this.onEvent('CONNECTED', { mode: 'websocket' });

        this.statusPingInterval = setInterval(() => {
          if (this.roomId && this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.send('PING_STATUS', {
              rtt: Math.round(this.clockSync.rtt),
              offset: Math.round(this.clockSync.getBestOffset())
            });
          }
        }, 3000);
      };

      this.ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          this.onEvent('BINARY_AUDIO_RECEIVED', event.data);
          return;
        }

        try {
          const { type, payload } = JSON.parse(event.data);
          if (type === 'SYNC_PONG') {
            this.clockSync.handlePong(payload);
            this.onEvent('SYNC_UPDATED', {
              rtt: Math.round(this.clockSync.rtt),
              offset: Math.round(this.clockSync.getBestOffset())
            });
            return;
          }

          if (type === 'ROOM_CREATED' || type === 'ROOM_JOINED') {
            this.roomId = payload.roomId;
            this.peerId = payload.peerId;
            this.isHost = payload.isHost;
          }

          this.onEvent(type, payload);
        } catch (e) {
          console.error('WebSocket message parse error:', e);
        }
      };

      this.ws.onerror = () => {
        this.enableServerlessFallback();
      };

      this.ws.onclose = () => {
        this.enableServerlessFallback();
      };
    } catch (err) {
      this.enableServerlessFallback();
    }
  }

  enableServerlessFallback() {
    if (!this.isServerlessMode) {
      this.isServerlessMode = true;
      this.clockSync.useHttpFallback = true;
      this.clockSync.startPeriodicSync(3000);
      this.cloudMesh.init();
      this.onEvent('CONNECTED', { mode: 'cloud_mesh' });
    }
  }

  generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  generatePeerId() {
    return 'peer_' + Math.random().toString(36).substr(2, 9);
  }

  send(type, payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload }));
    }
  }

  sendBinary(arrayBuffer, trackName = 'Uploaded Track') {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(arrayBuffer);
    } else if (this.isServerlessMode) {
      this.cloudMesh.streamAudioToAllPeers(arrayBuffer, trackName);
    }
  }

  uploadAudioFile(file, duration) {
    if (this.isServerlessMode) {
      this.cloudMesh.uploadAudioFileToStorage(file, duration);
    }
  }

  createRoom(deviceName = 'Master Speaker') {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send('CREATE_ROOM', { deviceName });
      return;
    }

    // Serverless / Firebase Cloud Mode
    this.enableServerlessFallback();
    const roomId = this.generateRoomCode();
    const peerId = this.generatePeerId();

    this.roomId = roomId;
    this.peerId = peerId;
    this.isHost = true;

    this.cloudMesh.createRoom(roomId, peerId, deviceName);

    this.onEvent('ROOM_CREATED', {
      roomId,
      peerId,
      isHost: true,
      peers: [{ id: peerId, deviceName, isHost: true, latencyOffset: 0 }]
    });
  }

  joinRoom(roomId, deviceName = 'Satellite Speaker') {
    const cleanRoomId = roomId.trim().toUpperCase();

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send('JOIN_ROOM', { roomId: cleanRoomId, deviceName });
      return;
    }

    // Serverless / Firebase Cloud Mode
    this.enableServerlessFallback();
    const peerId = this.generatePeerId();

    this.roomId = cleanRoomId;
    this.peerId = peerId;
    this.isHost = false;

    this.cloudMesh.joinRoom(cleanRoomId, peerId, deviceName);

    this.onEvent('ROOM_JOINED', {
      roomId: cleanRoomId,
      peerId,
      isHost: false,
      peers: [{ id: peerId, deviceName, isHost: false, latencyOffset: 0 }]
    });
  }

  schedulePlay(delayMs = 600, startOffsetSec = 0) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send('SCHEDULE_PLAY', { delayMs, startOffsetSec });
      return;
    }

    const targetServerTime = this.clockSync.getServerTime() + delayMs;
    this.cloudMesh.broadcastPlay(targetServerTime, startOffsetSec);
    this.onEvent('SCHEDULED_PLAY', {
      targetServerTime,
      startOffsetSec
    });
  }

  pausePlayback(currentOffsetSec = 0) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send('PAUSE_PLAYBACK', { currentOffsetSec });
      return;
    }

    this.cloudMesh.broadcastPause(currentOffsetSec);
    this.onEvent('PAUSED', { currentOffsetSec });
  }

  sendTrackMetadata(metadata) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send('TRACK_METADATA', metadata);
      return;
    }

    this.cloudMesh.broadcastTrack(metadata);
  }

  updateLatencyOffset(offsetMs) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send('UPDATE_LATENCY_OFFSET', { offsetMs });
      return;
    }

    this.cloudMesh.updateLatencyOffset(offsetMs);
  }
}
