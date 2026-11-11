import { AudioEngine } from './audio/AudioEngine.js';
import { SocketClient } from './network/SocketClient.js';
import { UIManager } from './ui/UIManager.js';
import { Visualizer } from './ui/Visualizer.js';
import { YouTubeEmbedPlayer } from './music/YouTubeEmbedPlayer.js';

function youtubeVideoId(track) {
  if (!track || track.sourceType !== 'youtube') return null;
  const sourceId = track.sourceId || track.youtubeVideoId || (track.id?.startsWith('yt_') ? track.id.slice(3) : track.id);
  return /^[A-Za-z0-9_-]{11}$/.test(sourceId || '') ? sourceId : null;
}

export async function joinRoomFromInvite(socketClient, roomId, deviceName) {
  try {
    return await socketClient.joinRoom(roomId, deviceName);
  } catch {
    return undefined;
  }
}

class App {
  constructor() {
    this.socketClient = null;
    this.audioEngine = null;
    this.uiManager = null;
    this.visualizer = null;
    this.youtubePlayer = null;
    this.wakeLock = null;
  }

  init() {
    this.socketClient = new SocketClient((type, payload) => this.handleNetworkEvent(type, payload));
    this.audioEngine = new AudioEngine(this.socketClient.clockSync);
    this.uiManager = new UIManager(this);
    this.uiManager.init();
    this.youtubePlayer = new YouTubeEmbedPlayer('youtubePlayerContainer', {
      clockSync: this.socketClient.clockSync,
      onStateChange: (state, player) => this.handleYouTubePlayerState(state, player),
      onError: code => this.handleYouTubePlayerError(code),
      onAutoplayBlocked: () => {
        this.uiManager.setYouTubePlayerStatus('Autoplay diblokir browser. Ketuk Aktifkan audio untuk melanjutkan.');
        this.uiManager.setYouTubeAutoplayBlocked(true);
        this.socketClient.cloudMesh.broadcastReadiness('AUTOPLAY_BLOCKED', this.uiManager.currentTrack?.id || '', 'youtube');
      }
    });

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
        this.audioEngine.ensureContext().catch(() => {});
      }
    };
    ['touchstart', 'touchend', 'click', 'keydown'].forEach(evt => {
      window.addEventListener(evt, unlockAudio, { passive: true });
    });

    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room')?.trim().toUpperCase();
    if (/^[A-Z0-9]{4}$/.test(roomParam || '')) {
      setTimeout(() => {
        this.audioEngine.ensureContext().catch(() => {});
        joinRoomFromInvite(this.socketClient, roomParam, this.uiManager.getDeviceName());
      }, 0);
    }
  }

  async requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (e) {}
  }

  handleYouTubePlayerState(state, player) {
    const YT = globalThis.YT;
    if (state === YT?.PlayerState?.PLAYING || state === 1) {
      const duration = player?.getDuration?.() || 0;
      if (duration) {
        this.audioEngine.currentTrackDuration = duration;
        if (this.uiManager.elements.totalTimeText) {
          this.uiManager.elements.totalTimeText.textContent = this.uiManager.formatTime(duration);
        }
        if (this.uiManager.currentTrack) this.uiManager.currentTrack.duration = duration;
      }
      if (this.uiManager.currentTrack?.sourceType === 'youtube') {
        this.uiManager.currentTrack.duration = duration || this.uiManager.currentTrack.duration || 0;
        this.audioEngine.currentTrackDuration = this.uiManager.currentTrack.duration;
      }
      this.audioEngine.pauseOffsetSec = player?.getCurrentTime?.() || 0;
      this.uiManager.setYouTubePlayerStatus('');
      this.uiManager.setYouTubeAutoplayBlocked(false);
      this.socketClient.cloudMesh.broadcastReadiness('READY', this.uiManager.currentTrack?.id || '', 'youtube');
      this.uiManager.setPlayState(true);
    } else if (state === YT?.PlayerState?.CUED || state === 5) {
      this.socketClient.cloudMesh.broadcastReadiness('READY', this.uiManager.currentTrack?.id || '', 'youtube');
    } else if (state === YT?.PlayerState?.PAUSED || state === 2) {
      this.audioEngine.pauseOffsetSec = player?.getCurrentTime?.() || this.audioEngine.pauseOffsetSec;
      if (this.uiManager.isPlayingState) this.uiManager.setPlayState(false);
    } else if (state === YT?.PlayerState?.BUFFERING || state === 3) {
      this.uiManager.setYouTubePlayerStatus('Memuat video YouTube…');
    } else if (state === YT?.PlayerState?.ENDED || state === 0) {
      this.uiManager.setPlayState(false);
      if (this.socketClient?.roomId && this.socketClient.isHost) this.uiManager.goToNextTrack({ automatic: true });
      else if (!this.socketClient?.roomId && this.uiManager.repeatMode === 'one' && this.uiManager.currentTrack?.sourceId) {
        this.audioEngine.pauseOffsetSec = 0;
        this.youtubePlayer.playAt(this.uiManager.currentTrack.sourceId, this.socketClient.clockSync.getServerTime() + 50, 0)
          .catch(() => this.uiManager.setYouTubePlayerStatus('Tekan Play di player YouTube untuk mulai.'));
      } else if (!this.socketClient?.roomId) this.uiManager.goToNextTrack();
    }
  }

  handleYouTubePlayerError(code) {
    const messages = {
      100: 'Video YouTube tidak tersedia. Pilih video lain.',
      101: 'Pemilik video tidak mengizinkan pemutaran sematan. Pilih video lain.',
      150: 'Pemilik video tidak mengizinkan pemutaran sematan. Pilih video lain.',
      153: 'Player YouTube tidak menerima identitas situs. Muat ulang halaman.'
    };
    this.uiManager.setPlayState(false);
    this.uiManager.setYouTubeAutoplayBlocked(false);
    this.socketClient?.cloudMesh?.broadcastReadiness('FAILED', this.uiManager.currentTrack?.id || '', 'youtube');
    this.uiManager.setYouTubePlayerStatus(messages[code] || 'Video YouTube gagal diputar. Coba video lain.', {
      retryable: ![2, 100, 101, 150, 153].includes(code)
    });
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

      case 'HOST_DISCONNECTED':
        uiManager.setHostDisconnected(true);
        break;

      case 'HOST_RECONNECTED':
        uiManager.setHostDisconnected(false);
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
          if (youtubeVideoId(payload.currentTrack)) {
            this.socketClient.cloudMesh.loadTrackBuffer(payload.currentTrack);
          } else if (payload.currentTrack.isSynthetic) {
            audioEngine.generateSyntheticTrack();
          } else if (this.socketClient?.cloudMesh) {
            this.socketClient.cloudMesh.loadTrackBuffer(payload.currentTrack);
          }
        }

        if (payload.playbackState && payload.playbackState.isPlaying) {
          if (youtubeVideoId(payload.currentTrack)) {
            this.youtubePlayer.playAt(
              youtubeVideoId(payload.currentTrack),
              payload.playbackState.startServerTime,
              payload.playbackState.startOffsetSec || 0
            ).catch(() => {
              uiManager.setYouTubePlayerStatus('Player YouTube tidak bisa dimuat. Periksa koneksi lalu coba lagi.', { retryable: true });
              socketClient.cloudMesh.broadcastReadiness('FAILED', payload.currentTrack?.id || '', 'youtube');
            });
          } else {
            audioEngine.schedulePlayAtServerTime(
              payload.playbackState.startServerTime,
              payload.playbackState.startOffsetSec || 0
            );
            uiManager.setPlayState(true);
          }
        }
        break;

      case 'ROOM_ERROR':
        uiManager.setView('room');
        uiManager.showUrlFeedback(payload.message || 'Room gagal diakses. Periksa kode atau koneksi.', 'error');
        break;

      case 'ROOM_LEFT':
        uiManager.setSoloState();
        break;

      case 'YOUTUBE_TRACK_REQUESTED': {
        const videoId = youtubeVideoId(payload);
        if (!videoId) {
          uiManager.setYouTubePlayerStatus('ID video YouTube tidak valid.');
          break;
        }
        uiManager.setYouTubePlayerVisible(true);
        uiManager.setYouTubeAutoplayBlocked(false);
        uiManager.setYouTubePlayerStatus('Memuat player YouTube…');
        const schedule = socketClient.cloudMesh?.lastKnownState;
        if (typeof schedule === 'number' && schedule > Date.now()) {
          this.youtubePlayer.playAt(videoId, schedule, payload.startOffsetSec || 0)
            .then(() => uiManager.setYouTubePlayerStatus(''))
            .catch(() => {
              uiManager.setYouTubePlayerStatus('Player YouTube tidak bisa dimuat. Periksa koneksi lalu coba lagi.', { retryable: true });
              socketClient.cloudMesh.broadcastReadiness('FAILED', payload.id || '', 'youtube');
            });
          break;
        }
        this.youtubePlayer.cueVideo(videoId, payload.startOffsetSec || 0)
          .then(() => uiManager.setYouTubePlayerStatus(''))
          .catch(() => {
            uiManager.setYouTubePlayerStatus('Player YouTube tidak bisa dimuat. Periksa koneksi lalu coba lagi.', { retryable: true });
            socketClient.cloudMesh.broadcastReadiness('FAILED', payload.id || '', 'youtube');
          });
        break;
      }

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

      case 'PLAYBACK_OPTIONS_UPDATED':
        uiManager.setPlaybackOptions(payload);
        break;

      case 'QUEUE_SYNC_ERROR':
        uiManager.showUrlFeedback(payload.message || 'Antrean belum tersinkron ke room.', 'error');
        break;

      case 'CONTROL_REQUEST': {
        if (!socketClient?.isHost) break;
        const labels = {
          play: 'playback',
          pause: 'pause playback',
          next: 'skip to next track',
          previous: 'play previous track',
          play_queue_item: `play “${payload.details?.name || 'queued track'}”`,
          play_next: 'move a track to next',
          remove_queue: 'remove a track from queue',
          seek: 'seek playback',
          playback_options: 'change repeat or shuffle'
        };
        const actionLabel = labels[payload.action];
        if (!actionLabel || !window.confirm(`${payload.requestedBy || 'A member'} requests to ${actionLabel}. Approve?`)) break;

        switch (payload.action) {
          case 'play':
            socketClient.schedulePlay(800, audioEngine.pauseOffsetSec || 0);
            break;
          case 'pause': {
            const offset = youtubeVideoId(socketClient.cloudMesh?.lastKnownTrack)
              ? this.youtubePlayer?.getCurrentTime() || 0
              : audioEngine.getCurrentPlaybackPosition();
            audioEngine.stopLocalPlayback();
            audioEngine.pauseOffsetSec = offset;
            uiManager.setPlayState(false);
            socketClient.pausePlayback(offset);
            break;
          }
          case 'next': uiManager.goToNextTrack(); break;
          case 'previous': socketClient.prevTrack(); break;
          case 'play_queue_item': socketClient.playQueueItem(payload.details?.queueId, true); break;
          case 'play_next': socketClient.playNext(payload.details?.queueId); break;
          case 'remove_queue': socketClient.removeFromQueue(payload.details?.queueId); break;
          case 'seek':
            if (youtubeVideoId(socketClient.cloudMesh?.lastKnownTrack)) socketClient.seekPlayback(payload.details?.position || 0);
            else socketClient.schedulePlay(800, payload.details?.position || 0);
            break;
          case 'playback_options':
            socketClient.updatePlaybackOptions(payload.details || {}).catch(() => {
              uiManager.showUrlFeedback('Mode pemutaran gagal disinkronkan. Coba lagi.', 'error');
            });
            break;
        }
        break;
      }

      case 'TRACK_METADATA':
      case 'TRACK_LOADED':
        if (payload?.sourceType === 'youtube' && !payload.sourceId) {
          const embeddedId = payload.id?.startsWith('yt_') ? payload.id.slice(3) : '';
          if (/^[A-Za-z0-9_-]{11}$/.test(embeddedId)) payload.sourceId = embeddedId;
        }
        uiManager.setYouTubePlayerVisible(!!youtubeVideoId(payload));
        if (payload.isSynthetic) {
          audioEngine.generateSyntheticTrack();
          uiManager.updateTrackUI(payload.name || 'Neon Groove Synthwave', 20, payload.thumbnail || '');
        } else {
          if (youtubeVideoId(payload)) this.socketClient?.cloudMesh?.loadTrackBuffer(payload);
          uiManager.updateTrackUI(payload.name || 'Pilih trek lagu', payload.duration || 0, payload.thumbnail || '');
          if (payload.name && audioEngine.currentTrackName && audioEngine.currentTrackName !== payload.name) {
            audioEngine.stopLocalPlayback();
            audioEngine.audioBuffer = null;
            audioEngine.currentTrackName = payload.name;
          }
        }
        uiManager.renderQueue(uiManager.cachedQueue);
        break;

      case 'SYNTHETIC_TRACK_REQUESTED':
        uiManager.setYouTubePlayerVisible(false);
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
          const hasTrackIds = currentTrack?.id && payload?.trackId;
          const isCurrent = !!currentTrack && (hasTrackIds
            ? currentTrack.id === payload.trackId
            : currentTrack.name === trackTitle);

          if (isCurrent) {
            const buffer = await audioEngine.loadAudioFromArrayBuffer(rawBuffer, trackTitle, payload?.trackId || null);
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
        {
          const track = payload.track || socketClient?.cloudMesh?.lastKnownTrack;
          if (track && youtubeVideoId(track)) {
            socketClient.cloudMesh.lastKnownTrack = track;
            uiManager.setYouTubePlayerVisible(true);
            uiManager.updateTrackUI(track.name || 'YouTube video', track.duration || 0, track.thumbnail || '');
            uiManager.renderQueue(uiManager.cachedQueue);
            this.youtubePlayer.playAt(
              youtubeVideoId(track),
              payload.targetServerTime || payload.scheduledServerTime,
              payload.startOffsetSec || 0
            ).catch(() => {
              uiManager.setYouTubePlayerStatus('Player YouTube tidak bisa dimuat. Periksa koneksi lalu coba lagi.', { retryable: true });
              socketClient.cloudMesh.broadcastReadiness('FAILED', track.id || '', 'youtube');
            });
            break;
          }
        }
        if (payload.track) {
          if (this.socketClient?.cloudMesh) {
            this.socketClient.cloudMesh.lastKnownTrack = payload.track;
          }
          uiManager.updateTrackUI(payload.track.name || 'Shared Track', payload.track.duration || 0, payload.track.thumbnail || '');
          if (payload.track.duration) {
            audioEngine.currentTrackDuration = payload.track.duration;
          }
          uiManager.renderQueue(uiManager.cachedQueue);
          
          const hasActiveTrackIds = audioEngine.currentTrackId && payload.track.id;
          const isTrackDifferent = !audioEngine.audioBuffer || (hasActiveTrackIds
            ? audioEngine.currentTrackId !== payload.track.id
            : (payload.track.name && audioEngine.currentTrackName !== payload.track.name));
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
        if (youtubeVideoId(socketClient?.cloudMesh?.lastKnownTrack)) {
          const offset = payload.currentOffsetSec ?? this.youtubePlayer.getCurrentTime();
          this.youtubePlayer.pause();
          audioEngine.pauseOffsetSec = offset;
          this.youtubePlayer.seekTo(offset);
          uiManager.setPlayState(false);
          break;
        }
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

  // Register Service Worker for PWA Android installation & offline cache
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('ServiceWorker registration error:', err);
      });
    });
  }
});
