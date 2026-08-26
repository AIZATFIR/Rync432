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

    // Prevent accidental page reload / navigate away while in active room
    window.addEventListener('beforeunload', (e) => {
      if (this.socketClient && this.socketClient.roomId) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    // Global User Gesture Unlock for iOS Safari and Android Chrome
    const unlockAudio = () => {
      if (this.audioEngine) {
        this.audioEngine.ensureContext();
      }
    };
    ['touchstart', 'touchend', 'click', 'keydown'].forEach(evt => {
      window.addEventListener(evt, unlockAudio, { passive: true });
    });

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
          if (this.socketClient?.cloudMesh) {
            this.socketClient.cloudMesh.lastKnownTrack = payload.currentTrack;
          }
          uiManager.updateTrackUI(payload.currentTrack.name || 'Shared Track', payload.currentTrack.duration || 0, payload.currentTrack.thumbnail || '');
          if (payload.currentTrack.isSynthetic) {
            audioEngine.generateSyntheticTrack();
          } else if (this.socketClient?.cloudMesh) {
            this.socketClient.cloudMesh.loadTrackBuffer(payload.currentTrack);
          }
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
          uiManager.updateTrackUI(payload.name || 'Neon Groove Synthwave', 20, payload.thumbnail || '');
        } else {
          uiManager.updateTrackUI(payload.name || 'Pilih trek lagu', payload.duration || 0, payload.thumbnail || '');
        }
        uiManager.renderQueue(uiManager.cachedQueue);
        break;

      case 'SYNTHETIC_TRACK_REQUESTED':
        audioEngine.generateSyntheticTrack();
        uiManager.updateTrackUI(payload.name || 'Neon Groove Synthwave', 20, payload.thumbnail || '');
        uiManager.renderQueue(uiManager.cachedQueue);
        break;

      case 'AUDIO_TRANSFER_PROGRESS':
        if (payload.status) {
          uiManager.setTrackLoading(payload.status);
        }
        break;

      case 'BINARY_AUDIO_RECEIVED':
        try {
          const rawBuffer = payload?.arrayBuffer || payload;
          const trackTitle = payload?.trackName || payload?.name || 'Shared Track';
          
          if (this.socketClient && this.socketClient.cloudMesh) {
            this.socketClient.cloudMesh.localAudioBufferCache.set(trackTitle, rawBuffer);
            if (payload?.trackId) {
              this.socketClient.cloudMesh.localAudioBufferCache.set(payload.trackId, rawBuffer);
            }
          }

          const currentTrack = this.socketClient?.cloudMesh?.lastKnownTrack;
          const isCurrent = !currentTrack || currentTrack.name === trackTitle || currentTrack.id === payload?.trackId || (trackTitle && currentTrack.name && (currentTrack.name.includes(trackTitle) || trackTitle.includes(currentTrack.name)));

          if (isCurrent) {
            const buffer = await audioEngine.loadAudioFromArrayBuffer(rawBuffer, trackTitle);
            uiManager.updateTrackUI(trackTitle, buffer.duration, currentTrack?.thumbnail || '');
            uiManager.renderQueue(uiManager.cachedQueue);
            uiManager.clearTrackLoading();

            if (audioEngine.pendingScheduledPlay) {
              const { serverTargetTime, startOffsetSec } = audioEngine.pendingScheduledPlay;
              audioEngine.pendingScheduledPlay = null;
              audioEngine.schedulePlayAtServerTime(serverTargetTime, startOffsetSec);
              uiManager.setPlayState(true);
            } else if (this.socketClient?.cloudMesh && !this.socketClient.cloudMesh.isPaused && this.socketClient.cloudMesh.lastKnownState !== 'PAUSED') {
              const serverTargetTime = typeof this.socketClient.cloudMesh.lastKnownState === 'number' ? this.socketClient.cloudMesh.lastKnownState : (Date.now() + 200);
              audioEngine.schedulePlayAtServerTime(serverTargetTime, 0);
              uiManager.setPlayState(true);
            }
          }
        } catch (err) {
          console.error('Failed to decode received audio stream:', err);
        }
        break;

      case 'SCHEDULED_PLAY':
      case 'PLAYBACK_SCHEDULED':
        if (payload.track) {
          if (this.socketClient?.cloudMesh) {
            this.socketClient.cloudMesh.lastKnownTrack = payload.track;
          }
          uiManager.updateTrackUI(payload.track.name || 'Shared Track', payload.track.duration || 0, payload.track.thumbnail || '');
          uiManager.renderQueue(uiManager.cachedQueue);
          
          const isTrackDifferent = !audioEngine.audioBuffer || (payload.track.name && audioEngine.currentTrackName !== payload.track.name);
          if (isTrackDifferent) {
            // STOP previous song immediately so old track doesn't keep playing!
            audioEngine.stopLocalPlayback();
            audioEngine.audioBuffer = null;
            audioEngine.currentTrackName = payload.track.name;
            audioEngine.currentServerTargetTime = null;
            audioEngine.pendingScheduledPlay = {
              serverTargetTime: payload.targetServerTime || payload.scheduledServerTime,
              startOffsetSec: payload.startOffsetSec || 0
            };

            if (payload.track.isSynthetic) {
              audioEngine.generateSyntheticTrack();
              audioEngine.schedulePlayAtServerTime(payload.targetServerTime || payload.scheduledServerTime, payload.startOffsetSec || 0);
              uiManager.setPlayState(true);
            } else if (this.socketClient?.cloudMesh) {
              await this.socketClient.cloudMesh.loadTrackBuffer(payload.track);
            }
            return;
          }
        }
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

      case 'REMOTE_DEVICE_UPDATED':
        if (payload.role) {
          uiManager.selectSpatialChannel(payload.role, false);
        }
        if (payload.volume !== undefined) {
          audioEngine.setVolume(payload.volume);
          if (uiManager.elements.volumeSlider) {
            uiManager.elements.volumeSlider.value = payload.volume;
          }
        }
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
