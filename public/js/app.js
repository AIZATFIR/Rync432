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
    this.socketClient = new SocketClient((type, payload) => this.handleNetworkEvent(type, payload));
    this.audioEngine = new AudioEngine(this.socketClient.clockSync);
    this.uiManager = new UIManager(this);
    this.uiManager.init();

    const canvas = document.getElementById('visualizerCanvas');
    if (canvas) {
      this.visualizer = new Visualizer(canvas, this.audioEngine);
      this.visualizer.start();
    }

    this.socketClient.connect();

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
        
        if (payload.currentTrack) {
          if (payload.currentTrack.isSynthetic) {
            audioEngine.generateSyntheticTrack();
          }
          uiManager.updateTrackUI(payload.currentTrack.name, payload.currentTrack.duration);
        }

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

      case 'QUEUE_UPDATED':
        if (payload.queue) {
          uiManager.renderQueue(payload.queue);
        }
        break;

      case 'TRACK_METADATA':
      case 'TRACK_LOADED':
        if (payload.isSynthetic) {
          audioEngine.generateSyntheticTrack();
        }
        uiManager.updateTrackUI(payload.name, payload.duration);
        break;

      case 'AUDIO_TRANSFER_PROGRESS':
        if (payload.status) {
          uiManager.setTrackLoading(payload.status);
        }
        break;

      case 'BINARY_AUDIO_RECEIVED':
        uiManager.setTrackLoading('Memproses buffer audio...');
        try {
          const buffer = await audioEngine.loadAudioFromArrayBuffer(payload, audioEngine.currentTrackName || 'Shared Track');
          uiManager.updateTrackUI(audioEngine.currentTrackName || 'Shared Track', buffer.duration);
        } catch (err) {
          console.error('Failed to decode received audio stream:', err);
          uiManager.setTrackLoading('Gagal decode audio.');
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

window.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
  window.__ryncApp = app;
});
