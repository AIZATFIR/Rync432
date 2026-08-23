import { ClockSync } from '../audio/ClockSync.js';

export class SocketClient {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.ws = null;
    this.clockSync = new ClockSync((type, payload) => this.send(type, payload));
    this.roomId = null;
    this.peerId = null;
    this.isHost = false;
    this.statusPingInterval = null;
  }

  connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    this.ws = new WebSocket(`${protocol}//${host}`);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.clockSync.startPeriodicSync(2000);
      this.onEvent('CONNECTED', {});

      // Periodically report ping/offset stats to room
      this.statusPingInterval = setInterval(() => {
        if (this.roomId) {
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

    this.ws.onclose = () => {
      this.clockSync.stopPeriodicSync();
      if (this.statusPingInterval) clearInterval(this.statusPingInterval);
      this.onEvent('DISCONNECTED', {});
      setTimeout(() => this.connect(), 2500);
    };
  }

  send(type, payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload }));
    }
  }

  sendBinary(arrayBuffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(arrayBuffer);
    }
  }

  createRoom(deviceName = 'Master Speaker') {
    this.send('CREATE_ROOM', { deviceName });
  }

  joinRoom(roomId, deviceName = 'Satellite Speaker') {
    this.send('JOIN_ROOM', { roomId, deviceName });
  }

  schedulePlay(delayMs = 600, startOffsetSec = 0) {
    this.send('SCHEDULE_PLAY', { delayMs, startOffsetSec });
  }

  pausePlayback(currentOffsetSec = 0) {
    this.send('PAUSE_PLAYBACK', { currentOffsetSec });
  }

  sendTrackMetadata(metadata) {
    this.send('TRACK_METADATA', metadata);
  }

  updateLatencyOffset(offsetMs) {
    this.send('UPDATE_LATENCY_OFFSET', { offsetMs });
  }
}
