import { AudioEngine } from './audio/AudioEngine.js';
import { SocketClient } from './network/SocketClient.js';
import { UIManager } from './ui/UIManager.js';
import { Visualizer } from './ui/Visualizer.js';

class App {
  constructor() {
    this.socketClient = null;
    this.audioEngine = null;
    this.uiManager = null;
    this.visualizer = null;
    this.wakeLock = null;
  }

  init() {
    // 1. Initialize Network Client with Event Dispatcher
    this.socketClient = new SocketClient((type, payload) => this.handleNetworkEvent(type, payload));

    // 2. Initialize Audio Engine with ClockSync reference
    this.audioEngine = new AudioEngine(this.socketClient.clockSync);

    // 3. Initialize UI Manager
    this.uiManager = new UIManager(this);
    this.uiManager.init();

    // 4. Initialize Visualizer
    const canvas = document.getElementById('visualizerCanvas');
    if (canvas) {
      this.visualizer = new Visualizer(canvas, this.audioEngine);
      this.visualizer.start();
    }

    // 5. Connect WebSocket / Cloud Mesh
    this.socketClient.connect();

    // 6. Check URL query params for auto-join
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    if (roomParam && roomParam.length === 4) {
      setTimeout(() => {
        this.audioEngine.ensureContext();
        this.socketClient.joinRoom(roomParam.toUpperCase(), this.uiManager.getDeviceName());
      }, 500);
    }
  }

  async requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (e) {}
  }

  async handleNetworkEvent(type, payload) {
    const { uiManager, audioEngine, socketClient } = this;

    switch (type) {
      case 'CONNECTED':
        uiManager.setConnected(true);
        break;

      case 'DISCONNECTED':
        uiManager.setConnected(false);
        break;

      case 'ROOM_CREATED':
        uiManager.setRoomState(payload.roomId, true);
        uiManager.renderPeerList(payload.peers || [{ id: payload.peerId, isHost: true, deviceName: 'Master Speaker' }]);
        this.requestWakeLock();
        break;

      case 'ROOM_JOINED':
        uiManager.setRoomState(payload.roomId, payload.isHost);
        uiManager.renderPeerList(payload.peers || []);
        this.requestWakeLock();
        
        // If track is already loaded in room, update UI
        if (payload.currentTrack) {
          if (payload.currentTrack.isSynthetic) {
            audioEngine.generateSyntheticTrack();
          }
          uiManager.updateTrackUI(payload.currentTrack.name, payload.currentTrack.duration);
        }

        // If room is already playing, sync immediately
        if (payload.playbackState && payload.playbackState.isPlaying) {
          audioEngine.schedulePlayAtServerTime(
            payload.playbackState.startServerTime,
            payload.playbackState.startOffsetSec || 0
          );
          uiManager.setPlayState(true);
        }
        break;

      case 'ROOM_ERROR':
        alert(payload.message || 'Room error');
        break;

      case 'PEER_JOINED':
      case 'PEER_LEFT':
      case 'PEER_UPDATED':
      case 'PEER_STATUS_SYNC':
        if (payload.peers) {
          uiManager.renderPeerList(payload.peers);
        }
        break;

      case 'TRACK_METADATA':
      case 'TRACK_LOADED':
        if (payload.isSynthetic) {
          audioEngine.generateSyntheticTrack();
        }
        uiManager.updateTrackUI(payload.name, payload.duration);
        break;

      case 'BINARY_AUDIO_RECEIVED':
        uiManager.setTrackLoading('Received binary audio stream from Host. Decoding buffer...');
        try {
          const buffer = await audioEngine.loadAudioFromArrayBuffer(payload, 'Host Shared Track');
          uiManager.updateTrackUI(audioEngine.currentTrackName, buffer.duration);
        } catch (err) {
          console.error('Failed to decode received audio stream:', err);
          uiManager.setTrackLoading('Decode failed. Please check audio format.');
        }
        break;

      case 'SCHEDULED_PLAY':
      case 'PLAYBACK_SCHEDULED':
        audioEngine.schedulePlayAtServerTime(
          payload.targetServerTime || payload.scheduledServerTime,
          payload.startOffsetSec || 0
        );
        uiManager.setPlayState(true);
        this.requestWakeLock();
        break;

      case 'PAUSED':
      case 'PLAYBACK_PAUSED':
        audioEngine.stopLocalPlayback();
        audioEngine.pauseOffsetSec = payload.currentOffsetSec || 0;
        uiManager.setPlayState(false);
        break;

      default:
        break;
    }
  }
}

// Bootstrap app on DOM Ready
window.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
  window.__ryncApp = app;
});
