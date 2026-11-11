import { firebaseAuth } from '../auth/FirebaseAuth.js';
import { QRCodeGenerator } from './QRCodeGenerator.js';
import { QRScanner } from './QRScanner.js';
import { MusicSourceManager } from '../music/MusicSourceManager.js';
import { MusicSourceType } from '../music/types.js';
import { LocalLibrary } from '../library/LocalLibrary.js';

const YOUTUBE_SEARCH_DEBOUNCE_MS = 250;
const RECENT_YOUTUBE_SEARCHES_KEY = 'rync_recent_youtube_searches';
const MAX_RECENT_YOUTUBE_SEARCHES = 8;
const AUDIO_ROUTE_LABELS = {
  unknown: 'Mencari jalur audio…',
  p2p: 'P2P',
  relay: 'Server relay',
  direct: 'Sumber langsung',
  youtube: 'YouTube',
  local: 'Audio lokal',
  cache: 'Cache lokal'
};
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
const peerAudioRouteLabel = peer => peer?.audioRoute === 'unknown' && peer?.readiness === 'READY'
  ? 'Belum ada audio'
  : AUDIO_ROUTE_LABELS[peer?.audioRoute] || AUDIO_ROUTE_LABELS.unknown;

export function currentQueueItem(queue, track, fallbackName) {
  if (!Array.isArray(queue)) return null;
  if (!track) return fallbackName ? queue.find(item => item.name === fallbackName) || null : null;
  return track.queueItemId
    ? queue.find(item => (item.queueItemId || item.id) === track.queueItemId) || null
    : queue.find(item => item.id === (typeof track === 'string' ? track : track.id)) || null;
}

export function upcomingQueueItems(queue, currentTrack, currentTrackName) {
  if (!Array.isArray(queue)) return [];
  const activeItem = currentQueueItem(queue, currentTrack, currentTrackName);
  if (activeItem) return queue.filter(item => item !== activeItem);
  const currentId = typeof currentTrack === 'string' ? currentTrack : currentTrack?.id;
  return currentId ? queue : queue.filter(item => !currentTrackName || item.name !== currentTrackName);
}

const queueItemKey = item => item?.queueItemId || item?.id;
const createQueueItemId = () => `qi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

export function moveQueueItem(queue, fromIndex, toIndex) {
  if (!Array.isArray(queue) || !Number.isInteger(fromIndex) || !Number.isInteger(toIndex)
    || fromIndex < 0 || toIndex < 0 || fromIndex >= queue.length || toIndex >= queue.length) {
    return Array.isArray(queue) ? [...queue] : [];
  }
  const reordered = [...queue];
  const [item] = reordered.splice(fromIndex, 1);
  reordered.splice(toIndex, 0, item);
  return reordered;
}

export class UIManager {
  constructor(app) {
    this.app = app;
    this.elements = {};
    this.currentUser = null;
    this.cachedPeers = [];
    this.soloQueue = this.loadSoloQueue();
    this.cachedQueue = [...this.soloQueue];
    this.qrScanner = null;
    this.selectedDeviceForEdit = null;
    this.demoTrackIndex = 0;
    this.isPlayingState = false;
    this.currentView = 'home';
    this.currentTrack = null;
    this.repeatMode = 'off';
    this.shuffle = false;
    this.youtubeSearchController = null;
    this.youtubeSearchDebounce = null;
    this.youtubeSearchSequence = 0;
    this.youtubeSearchCache = new Map();
    this.youtubeSearchCacheTtlMs = 60_000;
    this.lastYoutubeSearchCacheState = 'network';
    this.recentYoutubeSearches = this.loadRecentYoutubeSearches();
    this.activeYoutubeSearchHandler = null;
    this.suppressQueueRowClickUntil = 0;
    this.pendingQueueUndo = null;
    this.pendingQueueUndoTimer = null;
    this.musicSourceManager = new MusicSourceManager();
    this.localLibrary = new LocalLibrary();
  }

  init() {
    this.elements = {
      connectionStatus: document.getElementById('connectionStatus'),
      roomFeedback: document.getElementById('roomFeedback'),
      connectionDot: document.getElementById('connectionDot'),
      roomHeroSection: document.getElementById('roomHeroSection'),
      activeRoomSection: document.getElementById('activeRoomSection'),
      librarySection: document.getElementById('librarySection'),
      sourceHubSection: document.getElementById('sourceHubSection'),
      sourceSearchSection: document.getElementById('sourceSearchSection'),
      audioTuningSection: document.getElementById('audioTuningSection'),
      navHomeBtn: document.getElementById('navHomeBtn'),
      navSearchBtn: document.getElementById('navSearchBtn'),
      navLibraryBtn: document.getElementById('navLibraryBtn'),
      navRoomBtn: document.getElementById('navRoomBtn'),
      homeEmptyState: document.getElementById('homeEmptyState'),
      homeFindMusicBtn: document.getElementById('homeFindMusicBtn'),
      miniPlayerBar: document.getElementById('miniPlayerBar'),
      miniPlayerOpenBtn: document.getElementById('miniPlayerOpenBtn'),
      miniPlayerTitle: document.getElementById('miniPlayerTitle'),
      miniPlayerArtist: document.getElementById('miniPlayerArtist'),
      miniPlayerArtwork: document.getElementById('miniPlayerArtwork'),
      miniPlayerTime: document.getElementById('miniPlayerTime'),
      miniPlayerSeek: document.getElementById('miniPlayerSeek'),
      miniPlayerPlayBtn: document.getElementById('miniPlayerPlayBtn'),
      favoriteTrackBtn: document.getElementById('favoriteTrackBtn'),
      createPlaylistBtn: document.getElementById('createPlaylistBtn'),
      playlistList: document.getElementById('playlistList'),
      favoriteList: document.getElementById('favoriteList'),
      localAudioList: document.getElementById('localAudioList'),
      recentList: document.getElementById('recentList'),
      clearHistoryBtn: document.getElementById('clearHistoryBtn'),
      queueCardSection: document.getElementById('queueCardSection'),
      roomCodeDisplay: document.getElementById('roomCodeDisplay'),
      userRoleBadge: document.getElementById('userRoleBadge'),
      
      // Profile & Settings Modal
      userAuthBtn: document.getElementById('userAuthBtn'),
      userNameLabel: document.getElementById('userNameLabel'),
      userAvatarContainer: document.getElementById('userAvatarContainer'),
      authModal: document.getElementById('authModal'),
      modalCloseBtn: document.getElementById('modalCloseBtn'),
      googleSignInActionBtn: document.getElementById('googleSignInActionBtn'),
      authLoggedOutView: document.getElementById('authLoggedOutView'),
      authLoggedInView: document.getElementById('authLoggedInView'),
      userModalAvatar: document.getElementById('userModalAvatar'),
      userModalName: document.getElementById('userModalName'),
      userModalEmail: document.getElementById('userModalEmail'),
      signOutBtn: document.getElementById('signOutBtn'),

      // Hero Room Buttons & Inputs
      createRoomBtn: document.getElementById('createRoomBtn'),
      joinRoomBtn: document.getElementById('joinRoomBtn'),
      roomCodeInput: document.getElementById('roomCodeInput'),
      scanQrBtn: document.getElementById('scanQrBtn'),
      leaveRoomBtn: document.getElementById('leaveRoomBtn'),
      copyRoomLinkBtn: document.getElementById('copyRoomLinkBtn'),
      connectSpeakersBtn: document.getElementById('connectSpeakersBtn'),
      manageDevicesBtn: document.getElementById('manageDevicesBtn'),
      activeSpeakerCount: document.getElementById('activeSpeakerCount'),

      // QR Scanner Modal
      qrScannerModal: document.getElementById('qrScannerModal'),
      qrScannerCloseBtn: document.getElementById('qrScannerCloseBtn'),
      qrVideo: document.getElementById('qrVideo'),

      // Spotify Connect & QR Modal
      devicesModal: document.getElementById('devicesModal'),
      devicesModalCloseBtn: document.getElementById('devicesModalCloseBtn'),
      roomQrCodeContainer: document.getElementById('roomQrCodeContainer'),
      copyRoomLinkModalBtn: document.getElementById('copyRoomLinkModalBtn'),
      devicesMatrixList: document.getElementById('devicesMatrixList'),

      // Host Device Settings Modal
      deviceSettingsModal: document.getElementById('deviceSettingsModal'),
      deviceSettingsCloseBtn: document.getElementById('deviceSettingsCloseBtn'),
      modalTargetDeviceName: document.getElementById('modalTargetDeviceName'),
      modalSpatialStereo: document.getElementById('modalSpatialStereo'),
      modalSpatialLeft: document.getElementById('modalSpatialLeft'),
      modalSpatialRight: document.getElementById('modalSpatialRight'),
      modalSpatialCenter: document.getElementById('modalSpatialCenter'),
      modalDeviceVolume: document.getElementById('modalDeviceVolume'),
      modalVolumeText: document.getElementById('modalVolumeText'),
      saveDeviceSettingsBtn: document.getElementById('saveDeviceSettingsBtn'),
      removeDeviceFromRoomBtn: document.getElementById('removeDeviceFromRoomBtn'),
      
      // Single Play/Pause Toggle & Controls
      trackTitle: document.getElementById('trackTitle'),
      trackSub: document.getElementById('trackSub'),
      albumArtBox: document.getElementById('albumArtBox'),
      redoBtn: document.getElementById('redoBtn'),
      shuffleToggleBtn: document.getElementById('shuffleToggleBtn'),
      repeatToggleBtn: document.getElementById('repeatToggleBtn'),
      playPauseToggleBtn: document.getElementById('playPauseToggleBtn'),
      togglePlayIcon: document.getElementById('togglePlayIcon'),
      togglePauseIcon: document.getElementById('togglePauseIcon'),
      nextBtn: document.getElementById('nextBtn'),
      currentTimeText: document.getElementById('currentTimeText'),
      totalTimeText: document.getElementById('totalTimeText'),
      progressBar: document.getElementById('progressBar'),
      progressFill: document.getElementById('progressFill'),
      volumeSlider: document.getElementById('volumeSlider'),
      miniPlayerPlayBtn: document.getElementById('miniPlayerPlayBtn'),
      miniPlayerSeek: document.getElementById('miniPlayerSeek'),

      // Queue Section
      queueCardSection: document.getElementById('queueCardSection'),
      queueListContainer: document.getElementById('queueListContainer'),
      queueCountBadge: document.getElementById('queueCountBadge'),
      clearUpcomingBtn: document.getElementById('clearUpcomingBtn'),
      queueUndoBar: document.getElementById('queueUndoBar'),
      queueUndoBtn: document.getElementById('queueUndoBtn'),
      // Multi-Source Hub Tabs
      tabBtnDirectUrl: document.getElementById('tabBtnDirectUrl'),
      tabBtnYoutube: document.getElementById('tabBtnYoutube'),
      tabBtnFile: document.getElementById('tabBtnFile'),
      tabBtnDemo: document.getElementById('tabBtnDemo'),
      tabContentDirectUrl: document.getElementById('tabContentDirectUrl'),
      tabContentYoutube: document.getElementById('tabContentYoutube'),
      tabContentFile: document.getElementById('tabContentFile'),
      tabContentDemo: document.getElementById('tabContentDemo'),

      // Direct URL Elements
      directUrlInput: document.getElementById('directUrlInput'),
      fetchDirectUrlBtn: document.getElementById('fetchDirectUrlBtn'),
      directUrlFeedback: document.getElementById('directUrlFeedback'),
      sampleUrlWav: document.getElementById('sampleUrlWav'),
      sampleUrlHelix: document.getElementById('sampleUrlHelix'),
      sampleUrlSynth: document.getElementById('sampleUrlSynth'),

      // Multi-Device Readiness Barrier
      roomReadinessIndicator: document.getElementById('roomReadinessIndicator'),
      roomReadinessText: document.getElementById('roomReadinessText'),
      hostDisconnectedNotice: document.getElementById('hostDisconnectedNotice'),
      youtubePlayerShell: document.getElementById('youtubePlayerShell'),
      youtubePlayerStatus: document.getElementById('youtubePlayerStatus'),
      youtubePlayerRetryBtn: document.getElementById('youtubePlayerRetryBtn'),
      youtubeEnableAudioBtn: document.getElementById('youtubeEnableAudioBtn'),
      sharePlayerRoomBtn: document.getElementById('sharePlayerRoomBtn'),

      // Upload & Demo Elements
      dropzone: document.getElementById('audioDropzone'),
      audioFileInput: document.getElementById('audioFileInput'),
      sampleWavBtn: document.getElementById('sampleWavBtn'),
      demoSynthBtn: document.getElementById('demoSynthBtn'),

      // YouTube Search & Stream Inputs
      ytUrlInput: document.getElementById('ytUrlInput'),
      fetchYtAudioBtn: document.getElementById('fetchYtAudioBtn'),
      ytSearchResults: document.getElementById('ytSearchResults'),
      ytSearchRecents: document.getElementById('ytSearchRecents'),
      ytSampleSynth: document.getElementById('ytSampleSynth'),
      ytSampleLofi: document.getElementById('ytSampleLofi'),
      ytSampleRock: document.getElementById('ytSampleRock'),

      // Spatial Channel Selector (This Device)
      spatialStereo: document.getElementById('spatialStereo'),
      spatialLeft: document.getElementById('spatialLeft'),
      spatialRight: document.getElementById('spatialRight'),
      spatialCenter: document.getElementById('spatialCenter'),

      // Settings: Metronome & Latency Tuner
      metronomeToggle: document.getElementById('metronomeToggle'),
      latencySlider: document.getElementById('latencySlider'),
      latencyDisplay: document.getElementById('latencyDisplay'),
      stepMinus1: document.getElementById('stepMinus1'),
      stepPlus1: document.getElementById('stepPlus1'),
      nudgeMinus10: document.getElementById('nudgeMinus10'),
      nudgeMinus2: document.getElementById('nudgeMinus2'),
      nudgePlus2: document.getElementById('nudgePlus2'),
      nudgePlus10: document.getElementById('nudgePlus10'),
      presetWired: document.getElementById('presetWired'),
      presetInternal: document.getElementById('presetInternal'),
      presetBt: document.getElementById('presetBt'),

      // Equalizer & DSP Presets
      eqStudioBtn: document.getElementById('eqStudioBtn'),
      eqBassBtn: document.getElementById('eqBassBtn'),
      eqVocalBtn: document.getElementById('eqVocalBtn'),
      eqFlatBtn: document.getElementById('eqFlatBtn'),
      activeEqNameTag: document.getElementById('activeEqNameTag'),

      // Loading Notice & Sync Button
      peerLoadingNotice: document.getElementById('peerLoadingNotice'),
      peerLoadingNoticeText: document.getElementById('peerLoadingNoticeText'),
      refetchTrackBtn: document.getElementById('refetchTrackBtn'),

      // Devices List
      devicesList: document.getElementById('devicesList')
    };

    this.initFirebaseAuthListener();
    this.bindEvents();
    this.setPlaybackOptions();
    this.setView('home');
    this.renderQueue(this.soloQueue);
    this.refreshLibrary();
    this.startPlaybackTicker();

    this.app.audioEngine.onPlaybackStarted = () => {
      this.clearTrackLoading();
      this.clearUrlFeedback();
      this.setPlayState(true);
    };
    this.app.audioEngine.onPlaybackBlocked = () => {
      this.setPlayState(false);
      this.showUrlFeedback('Audio menunggu izin browser. Tekan Play untuk melanjutkan.', 'info');
    };
    this.app.audioEngine.onPlaybackEnded = () => this.handleAudioPlaybackEnded();
  }

  handleAudioPlaybackEnded() {
    this.setPlayState(false);
    const room = this.app.socketClient;
    if (!room?.roomId || room.isHost) this.goToNextTrack({ automatic: true });
  }

  initFirebaseAuthListener() {
    firebaseAuth.onAuthStateChanged((user) => {
      this.currentUser = user;
      this.renderUserState();
    });
  }

  bindEvents() {
    const { elements, app } = this;
    this.bindQueueMenuDismissal();

    [
      [elements.navHomeBtn, 'home'],
      [elements.navSearchBtn, 'search'],
      [elements.navLibraryBtn, 'library'],
      [elements.navRoomBtn, 'room']
    ].forEach(([button, view]) => button?.addEventListener('click', () => this.setView(view)));

    elements.homeFindMusicBtn?.addEventListener('click', () => this.setView('search'));
    elements.miniPlayerOpenBtn?.addEventListener('click', () => this.setView('home'));
    elements.clearUpcomingBtn?.addEventListener('click', () => this.clearUpcomingQueue());
    elements.queueUndoBtn?.addEventListener('click', () => this.restoreQueueUndo());
    elements.miniPlayerPlayBtn?.addEventListener('click', () => this.togglePlayback());
    elements.youtubeEnableAudioBtn?.addEventListener('click', () => this.enableYouTubeAudioFromGesture());
    elements.youtubePlayerRetryBtn?.addEventListener('click', () => this.retryYouTubePlayback());
    elements.miniPlayerSeek?.addEventListener('input', () => { this.isMiniSeeking = true; });
    elements.miniPlayerSeek?.addEventListener('change', event => {
      this.isMiniSeeking = false;
      const duration = this.app.audioEngine?.currentTrackDuration || 0;
      const target = (Number(event.target.value) / 1000) * duration;
      if (!duration) return;
      this.seekPlaybackTo(target);
    });

    elements.favoriteTrackBtn?.addEventListener('click', async () => {
      const track = this.currentTrack || this.app.socketClient?.cloudMesh?.lastKnownTrack;
      if (!track?.id) return;
      const isFavorite = await this.localLibrary.isFavorite(track.id);
      if (isFavorite) await this.localLibrary.removeFavorite(track.id);
      else await this.localLibrary.addFavorite(track);
      this.updateFavoriteButton(!isFavorite);
      this.refreshLibrary();
    });

    elements.createPlaylistBtn?.addEventListener('click', async () => {
      const name = window.prompt('Nama playlist');
      if (!name?.trim()) return;
      try {
        await this.localLibrary.createPlaylist(name);
        this.refreshLibrary();
      } catch (error) {
        this.showUrlFeedback(error.message, 'error');
      }
    });

    elements.clearHistoryBtn?.addEventListener('click', async () => {
      if (!window.confirm('Hapus semua riwayat putar di perangkat ini?')) return;
      const cleared = await this.localLibrary.clearRecentHistory();
      if (!cleared) {
        this.showUrlFeedback('Riwayat gagal dihapus.', 'error');
        return;
      }
      this.refreshLibrary();
    });

    // 1. Settings & Auth Modal
    if (elements.userAuthBtn) {
      elements.userAuthBtn.addEventListener('click', () => {
        if (elements.authModal) elements.authModal.classList.add('active');
      });
    }

    if (elements.modalCloseBtn) {
      elements.modalCloseBtn.addEventListener('click', () => {
        if (elements.authModal) elements.authModal.classList.remove('active');
      });
    }

    if (elements.authModal) {
      elements.authModal.addEventListener('click', (e) => {
        if (e.target === elements.authModal) elements.authModal.classList.remove('active');
      });
    }

    if (elements.googleSignInActionBtn) {
      elements.googleSignInActionBtn.addEventListener('click', async () => {
        try {
          const user = await firebaseAuth.signInWithGoogle();
          this.currentUser = user;
          this.renderUserState();
          elements.authModal.classList.remove('active');
        } catch (err) {
          alert(err.message || 'Gagal login Google.');
        }
      });
    }

    if (elements.signOutBtn) {
      elements.signOutBtn.addEventListener('click', async () => {
        await firebaseAuth.signOut();
        this.currentUser = null;
        this.renderUserState();
      });
    }

    // 2. Room Actions
    if (elements.createRoomBtn) {
      elements.createRoomBtn.addEventListener('click', async () => {
        try {
          await app.audioEngine.ensureContext();
          await app.socketClient.createRoom(this.getDeviceName());
          await this.syncLocalQueueToRoom();
          await this.seedCurrentTrackIntoRoom();
        } catch (error) {
          this.showUrlFeedback('Room gagal dibuat. Periksa koneksi lalu coba lagi.', 'error');
        }
      });
    }

    elements.sharePlayerRoomBtn?.addEventListener('click', async () => {
      try {
        if (!app.socketClient.roomId) {
          await app.socketClient.createRoom(this.getDeviceName());
          await this.syncLocalQueueToRoom();
          await this.seedCurrentTrackIntoRoom();
        } else if (app.socketClient.isHost && this.currentTrack?.id) {
          await this.seedCurrentTrackIntoRoom();
        }
        const url = `${window.location.origin}/?room=${app.socketClient.roomId}`;
        try {
          await navigator.clipboard.writeText(url);
          this.showUrlFeedback('Room dibuat dan link undangan disalin.', 'success');
        } catch (error) {
          this.showUrlFeedback(`Room dibuat. Salin link ini: ${url}`, 'info');
        }
        this.setView('room');
      } catch (error) {
        this.showUrlFeedback('Room gagal dibuat atau link tidak bisa disalin.', 'error');
      }
    });

    if (elements.joinRoomBtn) {
      elements.joinRoomBtn.addEventListener('click', async () => {
        const code = elements.roomCodeInput.value.trim().toUpperCase();
        if (/^[A-Z0-9]{4}$/.test(code)) {
          try {
            await app.audioEngine.ensureContext();
            await app.socketClient.joinRoom(code, this.getDeviceName());
          } catch (error) {
            this.showUrlFeedback('Room tidak bisa dimasuki. Periksa kode atau koneksi.', 'error');
          }
        } else {
          this.showUrlFeedback('Kode room terdiri dari 4 huruf atau angka.', 'error');
        }
      });
    }

    if (elements.roomCodeInput) {
      elements.roomCodeInput.addEventListener('keyup', (e) => {
        if (e.key === 'Enter') elements.joinRoomBtn.click();
      });
    }

    if (elements.leaveRoomBtn) {
      elements.leaveRoomBtn.addEventListener('click', () => {
        app.socketClient.leaveRoom();
      });
    }

    // Camera QR Scanner Handler
    if (elements.scanQrBtn) {
      elements.scanQrBtn.addEventListener('click', async () => {
        if (elements.qrScannerModal) elements.qrScannerModal.classList.add('active');
        try {
          this.qrScanner = new QRScanner(elements.qrVideo, async (scannedCode) => {
            if (elements.roomCodeInput) elements.roomCodeInput.value = scannedCode;
            if (elements.qrScannerModal) elements.qrScannerModal.classList.remove('active');
            try {
              await app.audioEngine.ensureContext();
              await app.socketClient.joinRoom(scannedCode, this.getDeviceName());
            } catch (error) {
              this.showUrlFeedback('Room tidak bisa dimasuki. Periksa kode atau koneksi.', 'error');
            }
          });
          await this.qrScanner.start();
        } catch (err) {
          alert(err.message || 'Kamera tidak dapat diakses.');
          if (elements.qrScannerModal) elements.qrScannerModal.classList.remove('active');
        }
      });
    }

    const closeQrScanner = () => {
      if (this.qrScanner) {
        this.qrScanner.stop();
        this.qrScanner = null;
      }
      if (elements.qrScannerModal) elements.qrScannerModal.classList.remove('active');
    };

    if (elements.qrScannerCloseBtn) elements.qrScannerCloseBtn.addEventListener('click', closeQrScanner);
    if (elements.qrScannerModal) {
      elements.qrScannerModal.addEventListener('click', (e) => {
        if (e.target === elements.qrScannerModal) closeQrScanner();
      });
    }

    const copyLinkHandler = async () => {
      const roomId = app.socketClient.roomId;
      if (!roomId) return this.showUrlFeedback('Buat atau gabung room dulu untuk membagikan link.', 'error');
      const url = `${window.location.origin}/?room=${roomId}`;
      try {
        await navigator.clipboard.writeText(url);
        this.showUrlFeedback('Link room disalin. Kirim ke temanmu.', 'success');
      } catch (error) {
        this.showUrlFeedback(`Salin link ini: ${url}`, 'error');
      }
    };

    if (elements.copyRoomLinkBtn) elements.copyRoomLinkBtn.addEventListener('click', copyLinkHandler);
    if (elements.copyRoomLinkModalBtn) elements.copyRoomLinkModalBtn.addEventListener('click', copyLinkHandler);

    // Devices & QR Modal
    const openConnectModal = () => {
      const roomId = app.socketClient.roomId;
      if (!roomId) return this.showUrlFeedback('Buat atau gabung room dulu untuk menghubungkan perangkat.', 'error');
      const roomUrl = `${window.location.origin}/?room=${roomId}`;
      if (elements.roomQrCodeContainer) {
        elements.roomQrCodeContainer.innerHTML = QRCodeGenerator.generateSVG(roomUrl, 160);
      }
      this.renderDevicesMatrix();
      if (elements.devicesModal) elements.devicesModal.classList.add('active');
    };

    if (elements.connectSpeakersBtn) elements.connectSpeakersBtn.addEventListener('click', openConnectModal);
    if (elements.manageDevicesBtn) elements.manageDevicesBtn.addEventListener('click', openConnectModal);

    if (elements.devicesModalCloseBtn) {
      elements.devicesModalCloseBtn.addEventListener('click', () => {
        if (elements.devicesModal) elements.devicesModal.classList.remove('active');
      });
    }

    if (elements.devicesModal) {
      elements.devicesModal.addEventListener('click', (e) => {
        if (e.target === elements.devicesModal) elements.devicesModal.classList.remove('active');
      });
    }

    // 3. Single Alternating Play/Pause Toggle & Redo & Next
    if (elements.playPauseToggleBtn) {
      elements.playPauseToggleBtn.addEventListener('click', () => {
        this.togglePlayback();
      });
    }

    if (elements.redoBtn) {
      elements.redoBtn.addEventListener('click', () => {
        this.goToPreviousTrack();
      });
    }

    if (elements.nextBtn) {
      elements.nextBtn.addEventListener('click', () => {
        if (!app.socketClient.roomId) {
          this.goToNextTrack();
          return;
        }
        if (!app.socketClient.isHost && app.socketClient.roomId) {
          app.socketClient.requestControl('next');
          return;
        }
        app.audioEngine.ensureContext();
        app.audioEngine.stopLocalPlayback();
        this.setPlayState(false);
        this.setTrackLoading('Sync audio...');
        this.goToNextTrack();
      });
    }

    elements.shuffleToggleBtn?.addEventListener('click', () => {
      this.requestPlaybackOptions({ shuffle: !this.shuffle });
    });
    elements.repeatToggleBtn?.addEventListener('click', () => {
      const modes = ['off', 'all', 'one'];
      const nextMode = modes[(modes.indexOf(this.repeatMode) + 1) % modes.length];
      this.requestPlaybackOptions({ repeatMode: nextMode });
    });

    if (elements.refetchTrackBtn) {
      elements.refetchTrackBtn.addEventListener('click', () => {
        app.audioEngine.ensureContext();
        this.setTrackLoading('Sync audio...');
        app.socketClient.refetchCurrentTrack();
      });
    }

    // Progress Bar Scrubbing
    if (elements.progressBar) {
      elements.progressBar.addEventListener('click', (e) => {
        if (!app.audioEngine.audioBuffer && this.currentTrack?.sourceType !== 'youtube') return;
        const rect = elements.progressBar.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const pct = Math.max(0, Math.min(1, clickX / rect.width));
        const targetSec = pct * app.audioEngine.currentTrackDuration;
        this.seekPlaybackTo(targetSec);
      });
    }

    // Volume Slider
    if (elements.volumeSlider) {
      elements.volumeSlider.addEventListener('input', (e) => {
        const vol = parseFloat(e.target.value);
        app.audioEngine.setVolume(vol);
        if (this.currentTrack?.sourceType === 'youtube') app.youtubePlayer?.setVolume(vol);
      });
    }

    // 4. Multi-Source Tabs Switching
    const switchTab = (activeTab) => {
      ['DirectUrl', 'Youtube', 'File', 'Demo'].forEach(tab => {
        const btn = elements[`tabBtn${tab}`];
        const content = elements[`tabContent${tab}`];
        if (btn && content) {
          if (tab.toLowerCase() === activeTab.toLowerCase()) {
            btn.classList.add('active');
            content.style.display = 'flex';
          } else {
            btn.classList.remove('active');
            content.style.display = 'none';
          }
        }
      });
    };

    if (elements.tabBtnDirectUrl) elements.tabBtnDirectUrl.addEventListener('click', () => switchTab('directurl'));
    if (elements.tabBtnYoutube) elements.tabBtnYoutube.addEventListener('click', () => switchTab('youtube'));
    if (elements.tabBtnFile) elements.tabBtnFile.addEventListener('click', () => switchTab('file'));
    if (elements.tabBtnDemo) elements.tabBtnDemo.addEventListener('click', () => switchTab('demo'));

    // Direct Audio URL Ingestion & Stream Resolution
    const handleDirectUrlIngest = async (url) => {
      if (!url || !url.trim()) {
        this.showUrlFeedback('Masukkan link audio yang valid (MP3 / WAV / OGG / FLAC / stream)', 'error');
        return;
      }
      if (/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)/i.test(url.trim())) {
        await this.streamAudioFromUrl(url.trim(), 'YouTube video').catch(() => {
          this.showUrlFeedback('Link YouTube tidak valid atau player gagal dimuat.', 'error');
        });
        return;
      }
      this.showUrlFeedback('Mengecek dan menyiapkan audio stream...', 'loading');
      try {
        const resolved = await this.musicSourceManager.resolve(url.trim());
        const endpoint = await this.musicSourceManager.audioResolver.resolvePlayableEndpoint(resolved);

        const item = {
          id: resolved.trackId,
          name: resolved.title,
          artist: resolved.artist,
          duration: resolved.duration || 0,
          thumbnail: resolved.thumbnailUrl || '',
          audioUrl: endpoint.playableUrl,
          sourceType: resolved.sourceType,
          sourceId: resolved.sourceId,
          sourceUrl: resolved.sourceUrl,
          isSynthetic: !!resolved.isSynthetic
        };

        if (elements.directUrlInput) elements.directUrlInput.value = '';
        if (resolved.sourceType === 'youtube') {
          await this.streamAudioFromUrl(item.sourceUrl || url.trim(), item.name, item.artist, item.duration, item.thumbnail);
        } else {
          await this.playResolvedAudio(item);
        }
        if (!app.socketClient.roomId) {
          this.showUrlFeedback(`Berhasil: ${resolved.title} (${endpoint.usedProxy ? 'via Proxy' : 'Direct CDN'})`, 'success');
          setTimeout(() => {
            if (elements.directUrlFeedback) elements.directUrlFeedback.style.display = 'none';
          }, 4000);
        }
      } catch (err) {
        console.error('Direct URL ingest error:', err);
        this.showUrlFeedback(`Gagal: ${err.message || 'URL audio tidak dapat dijangkau'}`, 'error');
      }
    };

    if (elements.fetchDirectUrlBtn) {
      elements.fetchDirectUrlBtn.addEventListener('click', () => {
        handleDirectUrlIngest(elements.directUrlInput?.value);
      });
    }

    if (elements.directUrlInput) {
      elements.directUrlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          handleDirectUrlIngest(elements.directUrlInput.value);
        }
      });
    }

    if (elements.sampleUrlWav) {
      elements.sampleUrlWav.addEventListener('click', () => {
        handleDirectUrlIngest('/test_music_sample.wav');
      });
    }

    if (elements.sampleUrlHelix) {
      elements.sampleUrlHelix.addEventListener('click', () => {
        handleDirectUrlIngest('https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3');
      });
    }

    if (elements.sampleUrlSynth) {
      elements.sampleUrlSynth.addEventListener('click', () => {
        app.audioEngine.ensureContext();
        if (!app.socketClient.roomId) app.socketClient.createRoom(this.getDeviceName());
        const synthTrack = {
          id: 'demo_cyber_synth',
          name: 'Neon Cyber Synth',
          artist: 'Rync Synth Lab',
          duration: 20,
          isSynthetic: true
        };
        app.audioEngine.generateSyntheticTrack();
        this.updateTrackUI(synthTrack.name, synthTrack.duration);
        app.socketClient.addToQueue(synthTrack);
      });
    }

    // 5. Genuine Live YouTube Search & Stream
    const handleYtSearchOrStream = async (queryOrUrl, refresh = false) => {
      if (!queryOrUrl) {
        this.renderSearchMessage('Ketik judul lagu atau tempel link YouTube.', 'info');
        return;
      }

      if (/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)/i.test(queryOrUrl)) {
        await this.streamAudioFromUrl(queryOrUrl, 'YouTube video').catch(() => this.showUrlFeedback('Link YouTube tidak valid atau player gagal dimuat.', 'error'));
        return;
      }

      this.youtubeSearchController?.abort();
      const controller = new AbortController();
      const requestId = ++this.youtubeSearchSequence;
      this.youtubeSearchController = controller;
      this.renderSearchMessage('Mencari di YouTube…', 'loading');

      try {
        const results = await this.fetchYoutubeSearch(queryOrUrl, controller.signal, { refresh });
        if (requestId !== this.youtubeSearchSequence) return;

        if (results.length === 0) {
          this.recordYoutubeSearch(queryOrUrl);
          this.renderYoutubeSearchRecents();
          this.renderSearchMessage('Lagu tidak ditemukan. Coba kata kunci lain.', 'empty');
          return;
        }

        this.recordYoutubeSearch(queryOrUrl);
        this.renderYoutubeSearchRecents();
        this.renderSearchResults(results, { query: queryOrUrl, cached: this.lastYoutubeSearchCacheState !== 'network' });
      } catch (err) {
        if (err.name === 'AbortError' || requestId !== this.youtubeSearchSequence) return;
        if (err.staleResults) {
          this.lastYoutubeSearchCacheState = 'stale';
          this.renderSearchResults(err.staleResults, { query: queryOrUrl, cached: true, stale: true });
          return;
        }
        const message = err.code === 'PROVIDER_NOT_CONFIGURED'
          ? 'Pencarian YouTube belum diatur di server.'
          : err.code === 'RATE_LIMITED'
            ? 'Kuota pencarian YouTube habis sementara. Coba lagi nanti.'
            : err.code === 'PROVIDER_TIMEOUT'
              ? 'Pencarian YouTube terlalu lama. Coba lagi.'
              : err.code === 'PROVIDER_UNAVAILABLE'
                ? 'YouTube sedang tidak tersedia. Coba lagi nanti.'
            : 'Pencarian gagal. Periksa koneksi lalu coba lagi.';
        this.renderSearchError(message, queryOrUrl, err.retryable !== false,
          ['PROVIDER_NOT_CONFIGURED', 'RATE_LIMITED'].includes(err.code));
      }
    };

    this.activeYoutubeSearchHandler = handleYtSearchOrStream;
    if (elements.fetchYtAudioBtn) {
      elements.fetchYtAudioBtn.addEventListener('click', () => {
        clearTimeout(this.youtubeSearchDebounce);
        const q = elements.ytUrlInput?.value.trim() || '';
        handleYtSearchOrStream(q);
      });
    }

    if (elements.ytUrlInput) {
      elements.ytUrlInput.addEventListener('input', () => {
        const query = elements.ytUrlInput.value.trim();
        this.youtubeSearchController?.abort();
        this.youtubeSearchSequence++;
        clearTimeout(this.youtubeSearchDebounce);
        if (!query) {
          if (elements.ytSearchResults) elements.ytSearchResults.style.display = 'none';
          this.renderYoutubeSearchRecents();
          return;
        }
        if (elements.ytSearchRecents) elements.ytSearchRecents.style.display = 'none';
        if (/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)/i.test(query)) {
          if (elements.ytSearchResults) elements.ytSearchResults.style.display = 'none';
          return;
        }
        if (query.length < 2) {
          this.renderSearchMessage('Ketik minimal 2 karakter.', 'info');
          return;
        }
        this.renderSearchMessage('Menyiapkan pencarian…', 'loading');
        this.scheduleYoutubeSearch(query);
      });
      elements.ytUrlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          clearTimeout(this.youtubeSearchDebounce);
          elements.fetchYtAudioBtn.click();
        } else if (e.key === 'Escape') {
          clearTimeout(this.youtubeSearchDebounce);
          this.youtubeSearchController?.abort();
          this.youtubeSearchSequence++;
          if (elements.ytSearchResults) elements.ytSearchResults.style.display = 'none';
        }
      });
    }
    this.renderYoutubeSearchRecents();

    // Quick Sample Chips
    if (elements.ytSampleSynth) {
      elements.ytSampleSynth.addEventListener('click', () => {
        if (elements.ytUrlInput) elements.ytUrlInput.value = 'Synthwave 80s';
        elements.fetchYtAudioBtn.click();
      });
    }
    if (elements.ytSampleLofi) {
      elements.ytSampleLofi.addEventListener('click', () => {
        if (elements.ytUrlInput) elements.ytUrlInput.value = 'Lofi Hip Hop Chill';
        elements.fetchYtAudioBtn.click();
      });
    }
    if (elements.ytSampleRock) {
      elements.ytSampleRock.addEventListener('click', () => {
        if (elements.ytUrlInput) elements.ytUrlInput.value = 'Acoustic Guitar Fingerstyle';
        elements.fetchYtAudioBtn.click();
      });
    }

    // 6. Spatial Channel Selector (This Device)
    if (elements.spatialStereo) elements.spatialStereo.addEventListener('click', () => this.selectSpatialChannel('stereo'));
    if (elements.spatialLeft) elements.spatialLeft.addEventListener('click', () => this.selectSpatialChannel('left'));
    if (elements.spatialRight) elements.spatialRight.addEventListener('click', () => this.selectSpatialChannel('right'));
    if (elements.spatialCenter) elements.spatialCenter.addEventListener('click', () => this.selectSpatialChannel('center'));

    // 7. Host Device Settings Modal Controls
    let tempRole = 'stereo';
    let tempVolume = 1.0;

    const setTempRole = (role) => {
      tempRole = role;
      [elements.modalSpatialStereo, elements.modalSpatialLeft, elements.modalSpatialRight, elements.modalSpatialCenter].forEach(btn => {
        if (btn) {
          if (btn.id.toLowerCase().includes(role)) btn.classList.add('active');
          else btn.classList.remove('active');
        }
      });
    };

    if (elements.modalSpatialStereo) elements.modalSpatialStereo.addEventListener('click', () => setTempRole('stereo'));
    if (elements.modalSpatialLeft) elements.modalSpatialLeft.addEventListener('click', () => setTempRole('left'));
    if (elements.modalSpatialRight) elements.modalSpatialRight.addEventListener('click', () => setTempRole('right'));
    if (elements.modalSpatialCenter) elements.modalSpatialCenter.addEventListener('click', () => setTempRole('center'));

    if (elements.modalDeviceVolume) {
      elements.modalDeviceVolume.addEventListener('input', (e) => {
        tempVolume = parseFloat(e.target.value);
        if (elements.modalVolumeText) elements.modalVolumeText.innerText = `${Math.round(tempVolume * 100)}%`;
      });
    }

    if (elements.saveDeviceSettingsBtn) {
      elements.saveDeviceSettingsBtn.addEventListener('click', () => {
        if (this.selectedDeviceForEdit) {
          const targetId = this.selectedDeviceForEdit.id;
          app.socketClient.updateRemotePeerSettings(targetId, tempRole, tempVolume);
          if (targetId === app.socketClient.peerId) {
            this.selectSpatialChannel(tempRole, false);
            app.audioEngine.setVolume(tempVolume);
          }
          if (elements.deviceSettingsModal) elements.deviceSettingsModal.classList.remove('active');
        }
      });
    }

    if (elements.removeDeviceFromRoomBtn) {
      elements.removeDeviceFromRoomBtn.addEventListener('click', () => {
        if (this.selectedDeviceForEdit) {
          const targetId = this.selectedDeviceForEdit.id;
          const targetName = this.selectedDeviceForEdit.deviceName || 'Speaker';
          if (confirm(`Hapus ${targetName} dari room?`)) {
            app.socketClient.removeRemotePeer(targetId);
            if (elements.deviceSettingsModal) elements.deviceSettingsModal.classList.remove('active');
          }
        }
      });
    }

    if (elements.deviceSettingsCloseBtn) {
      elements.deviceSettingsCloseBtn.addEventListener('click', () => {
        if (elements.deviceSettingsModal) elements.deviceSettingsModal.classList.remove('active');
      });
    }

    if (elements.deviceSettingsModal) {
      elements.deviceSettingsModal.addEventListener('click', (e) => {
        if (e.target === elements.deviceSettingsModal) elements.deviceSettingsModal.classList.remove('active');
      });
    }

    // 8. File Upload Trigger (Multi-File Support)
    const triggerFileSelect = (e) => {
      if (e) e.stopPropagation();
      app.audioEngine.ensureContext();
      if (elements.audioFileInput) {
        elements.audioFileInput.value = '';
        elements.audioFileInput.click();
      }
    };

    if (elements.dropzone) {
      elements.dropzone.addEventListener('click', triggerFileSelect);
      elements.dropzone.addEventListener('dragover', (e) => {
        e.preventDefault(); e.stopPropagation();
      });
      elements.dropzone.addEventListener('drop', (e) => {
        e.preventDefault(); e.stopPropagation();
        const files = e.dataTransfer ? e.dataTransfer.files : null;
        if (files && files.length > 0) this.handleAudioFiles(files);
      });
    }

    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = e.dataTransfer ? e.dataTransfer.files : null;
      if (files && files.length > 0) {
        const audioFiles = Array.from(files).filter(f => f.type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(f.name));
        if (audioFiles.length > 0) this.handleAudioFiles(audioFiles);
      }
    });

    if (elements.audioFileInput) {
      elements.audioFileInput.addEventListener('change', (e) => {
        const files = e.target.files;
        if (files && files.length > 0) {
          this.handleAudioFiles(files);
        }
      });
    }

    // Preset WAV Track
    if (elements.sampleWavBtn) {
      elements.sampleWavBtn.addEventListener('click', async () => {
        app.audioEngine.ensureContext();
        if (!app.socketClient.roomId) {
          app.socketClient.createRoom(this.getDeviceName());
        }
        const sampleUrl = `${window.location.origin}/test_music_sample.wav`;
        const item = {
          id: 'demo_acoustic_wav',
          name: 'Acoustic WAV',
          artist: 'Acoustic Sample',
          duration: 30,
          audioUrl: sampleUrl
        };

        if (!app.audioEngine.audioBuffer) {
          this.setTrackLoading('Memuat Acoustic WAV...');
          try {
            const buffer = await app.audioEngine.loadAudioFromUrl(sampleUrl, 'Acoustic WAV');
            this.updateTrackUI('Acoustic WAV', buffer.duration, '');
            if (app.socketClient.cloudMesh) {
              app.socketClient.cloudMesh.localAudioBufferCache.set(item.id, buffer);
              app.socketClient.cloudMesh.localAudioBufferCache.set(item.name, buffer);
              app.socketClient.cloudMesh.localAudioBufferCache.set(sampleUrl, buffer);
            }
          } catch (err) {
            console.warn('Sample load notice:', err);
          }
        }

        app.socketClient.addToQueue(item);
      });
    }

    // Preset Synth Demo
    if (elements.demoSynthBtn) {
      elements.demoSynthBtn.addEventListener('click', async () => {
        app.audioEngine.ensureContext();
        if (!app.socketClient.roomId) {
          app.socketClient.createRoom(this.getDeviceName());
        }
        const item = {
          id: 'demo_synthwave',
          name: 'Neon Groove Synthwave',
          artist: 'Rync432 Synth',
          duration: 20,
          isSynthetic: true
        };

        if (!app.audioEngine.audioBuffer) {
          const buffer = app.audioEngine.generateSyntheticTrack('synthwave');
          this.updateTrackUI(app.audioEngine.currentTrackName, buffer.duration, '');
          if (app.socketClient.cloudMesh) {
            app.socketClient.cloudMesh.localAudioBufferCache.set(item.id, buffer);
            app.socketClient.cloudMesh.localAudioBufferCache.set(item.name, buffer);
          }
        }

        app.socketClient.addToQueue(item);
      });
    }

    // Settings: Metronome
    if (elements.metronomeToggle) {
      elements.metronomeToggle.addEventListener('change', (e) => {
        const toggle = e.target;
        this.setMetronomeEnabled(toggle.checked).then(enabled => {
          if (!enabled && toggle.checked) {
            toggle.checked = false;
            this.showUrlFeedback('Metronome tidak tersedia di browser ini.', 'error');
          }
        }).catch(() => {
          toggle.checked = false;
          this.showUrlFeedback('Audio belum bisa diaktifkan. Coba lagi.', 'error');
        });
      });
    }

    // Settings: Latency Tuner
    if (elements.stepMinus1) elements.stepMinus1.addEventListener('click', () => this.nudgeLatency(-1));
    if (elements.stepPlus1) elements.stepPlus1.addEventListener('click', () => this.nudgeLatency(1));

    if (elements.latencySlider) {
      elements.latencySlider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        this.updateLatencyOffset(val);
      });
    }

    if (elements.nudgeMinus10) elements.nudgeMinus10.addEventListener('click', () => this.nudgeLatency(-10));
    if (elements.nudgeMinus2) elements.nudgeMinus2.addEventListener('click', () => this.nudgeLatency(-2));
    if (elements.nudgePlus2) elements.nudgePlus2.addEventListener('click', () => this.nudgeLatency(2));
    if (elements.nudgePlus10) elements.nudgePlus10.addEventListener('click', () => this.nudgeLatency(10));

    if (elements.presetWired) elements.presetWired.addEventListener('click', () => this.applyPreset('wired', 0));
    if (elements.presetInternal) elements.presetInternal.addEventListener('click', () => this.applyPreset('internal', 15));
    if (elements.presetBt) elements.presetBt.addEventListener('click', () => this.applyPreset('bt', 120));

    // 9. Equalizer & DSP Mastering Presets
    const eqButtons = [
      { el: elements.eqStudioBtn, key: 'studio' },
      { el: elements.eqBassBtn, key: 'bassboost' },
      { el: elements.eqVocalBtn, key: 'vocal' },
      { el: elements.eqFlatBtn, key: 'flat' }
    ];

    eqButtons.forEach(({ el, key }) => {
      if (el) {
        el.addEventListener('click', () => {
          app.audioEngine.ensureContext();
          this.applyEqPreset(key);
        });
      }
    });
  }

  applyEqPreset(preset) {
    this.app.audioEngine.setEqPreset(preset);
    const { elements } = this;
    const btns = [elements.eqStudioBtn, elements.eqBassBtn, elements.eqVocalBtn, elements.eqFlatBtn];
    btns.forEach(btn => {
      if (btn) {
        if (btn.dataset.eq === preset) btn.classList.add('active');
        else btn.classList.remove('active');
      }
    });

    const labelMap = {
      studio: 'Studio Master',
      bassboost: 'Bass Boost',
      vocal: 'Vocal / Clear',
      flat: 'Flat (Raw)'
    };
    if (elements.activeEqNameTag) {
      elements.activeEqNameTag.innerText = labelMap[preset] || 'Studio Master';
    }
  }

  loadRecentYoutubeSearches() {
    try {
      const searches = JSON.parse(localStorage.getItem(RECENT_YOUTUBE_SEARCHES_KEY) || '[]');
      return Array.isArray(searches)
        ? searches.filter(query => typeof query === 'string' && query.trim()).slice(0, MAX_RECENT_YOUTUBE_SEARCHES)
        : [];
    } catch (error) {
      return [];
    }
  }

  recordYoutubeSearch(query) {
    const value = typeof query === 'string' ? query.trim() : '';
    if (!value) return;
    const normalized = value.toLocaleLowerCase();
    this.recentYoutubeSearches = [
      value,
      ...this.recentYoutubeSearches.filter(item => item.toLocaleLowerCase() !== normalized)
    ].slice(0, MAX_RECENT_YOUTUBE_SEARCHES);
    try { localStorage.setItem(RECENT_YOUTUBE_SEARCHES_KEY, JSON.stringify(this.recentYoutubeSearches)); } catch (error) {}
  }

  clearYoutubeSearches() {
    this.recentYoutubeSearches = [];
    try { localStorage.removeItem(RECENT_YOUTUBE_SEARCHES_KEY); } catch (error) {}
    this.renderYoutubeSearchRecents();
  }

  renderYoutubeSearchRecents() {
    const container = this.elements.ytSearchRecents;
    if (!container) return;
    container.replaceChildren();
    if (this.elements.ytUrlInput?.value.trim() || !this.recentYoutubeSearches.length) {
      container.style.display = 'none';
      return;
    }

    container.style.display = 'flex';
    const heading = document.createElement('div');
    heading.className = 'yt-search-recents-heading';
    const label = document.createElement('span');
    label.textContent = 'Pencarian terbaru';
    heading.appendChild(label);
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'yt-search-recents-clear';
    clear.textContent = 'Hapus';
    clear.setAttribute('aria-label', 'Hapus riwayat pencarian YouTube');
    clear.addEventListener('click', () => this.clearYoutubeSearches());
    heading.appendChild(clear);
    container.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'yt-search-recents-list';
    this.recentYoutubeSearches.forEach(query => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'yt-search-recent';
      button.textContent = query;
      button.setAttribute('aria-label', `Cari lagi: ${query}`);
      button.addEventListener('click', () => {
        if (this.elements.ytUrlInput) this.elements.ytUrlInput.value = query;
        container.style.display = 'none';
        this.activeYoutubeSearchHandler?.(query);
      });
      list.appendChild(button);
    });
    container.appendChild(list);
  }

  async fetchYoutubeSearch(query, signal, { refresh = false } = {}) {
    const cacheKey = query.trim().toLowerCase();
    const cached = this.youtubeSearchCache.get(cacheKey);
    if (!refresh && cached && Date.now() - cached.storedAt < this.youtubeSearchCacheTtlMs) {
      this.lastYoutubeSearchCacheState = 'fresh';
      return [...cached.results];
    }

    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 8000);

    try {
      const results = await this.musicSourceManager.search(query, MusicSourceType.YOUTUBE, { signal: controller.signal });
      this.youtubeSearchCache.delete(cacheKey);
      this.youtubeSearchCache.set(cacheKey, { results, storedAt: Date.now() });
      while (this.youtubeSearchCache.size > 20) {
        this.youtubeSearchCache.delete(this.youtubeSearchCache.keys().next().value);
      }
      this.lastYoutubeSearchCacheState = 'network';
      return results;
    } catch (error) {
      if (signal?.aborted || (error.name === 'AbortError' && !timedOut)) throw error;
      if (timedOut) {
        error = new Error('Search timeout');
        error.code = 'PROVIDER_TIMEOUT';
        error.retryable = true;
      }
      if (cached?.results?.length) {
        error.staleResults = [...cached.results];
        this.lastYoutubeSearchCacheState = 'stale';
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  scheduleYoutubeSearch(query) {
    clearTimeout(this.youtubeSearchDebounce);
    this.youtubeSearchDebounce = setTimeout(() => {
      this.activeYoutubeSearchHandler?.(query);
    }, YOUTUBE_SEARCH_DEBOUNCE_MS);
  }

  renderSearchMessage(message, state = 'info') {
    const list = this.elements.ytSearchResults;
    if (!list) return;
    list.style.display = 'flex';
    list.replaceChildren();
    const status = document.createElement('p');
    status.className = `search-status ${state}`;
    status.setAttribute('role', 'status');
    status.textContent = message;
    list.appendChild(status);
  }

  renderSearchError(message, query, retryable = true, offerExternalSearch = false) {
    this.renderSearchMessage(message, 'error');
    if (offerExternalSearch && query) {
      const link = document.createElement('a');
      link.className = 'yt-search-refresh';
      link.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Cari di YouTube, lalu tempel link di sini';
      this.elements.ytSearchResults?.appendChild(link);
    }
    if (!retryable) return;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'yt-search-refresh';
    retry.textContent = 'Coba lagi';
    retry.setAttribute('aria-label', 'Coba pencarian YouTube lagi');
    retry.addEventListener('click', () => this.activeYoutubeSearchHandler?.(query, true));
    this.elements.ytSearchResults?.appendChild(retry);
  }

  renderSearchResults(results, { query = '', cached = false, stale = false } = {}) {
    const list = this.elements.ytSearchResults;
    if (!list) return;
    list.innerHTML = '';
    const resultHeader = document.createElement('div');
    resultHeader.className = 'yt-search-result-header';
    const resultStatus = document.createElement('span');
    resultStatus.textContent = stale ? 'Koneksi gagal · hasil tersimpan' : cached ? 'Hasil tersimpan' : 'Hasil YouTube';
    resultHeader.appendChild(resultStatus);
    const refreshButton = document.createElement('button');
    refreshButton.type = 'button';
    refreshButton.className = 'yt-search-refresh';
    refreshButton.textContent = 'Refresh';
    refreshButton.setAttribute('aria-label', 'Segarkan hasil YouTube');
    refreshButton.disabled = !query || !this.activeYoutubeSearchHandler;
    refreshButton.addEventListener('click', () => this.activeYoutubeSearchHandler?.(query, true));
    resultHeader.appendChild(refreshButton);
    list.appendChild(resultHeader);

    results.forEach((item) => {
      const rawThumb = item.thumbnail;
      const videoId = /^[\w-]{11}$/.test(item.sourceId || '')
        ? item.sourceId
        : item.id?.startsWith('yt_')
          ? item.id.slice(3)
          : /^[\w-]{11}$/.test(item.id || '') ? item.id : '';
      const itemTitle = item.name || item.title || 'Untitled';
      const itemArtist = item.artist || item.channel || 'YouTube';
      const itemUrl = item.sourceUrl || item.url || `https://www.youtube.com/watch?v=${videoId}`;
      const thumbSrc = (rawThumb && rawThumb !== 'NA' && /^https:\/\//i.test(rawThumb))
        ? rawThumb
        : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

      const card = document.createElement('div');
      card.className = 'yt-result-item';
      const thumbnail = document.createElement('img');
      thumbnail.className = 'yt-result-thumb';
      thumbnail.alt = 'Thumbnail';
      const title = document.createElement('div');
      title.className = 'yt-result-title';
      title.textContent = itemTitle;
      const meta = document.createElement('div');
      meta.className = 'yt-result-meta';
      const duration = item.durationText || (Number(item.duration) > 0 ? this.formatTime(item.duration) : '');
      meta.textContent = [itemArtist, duration].filter(Boolean).join(' • ');
      const info = document.createElement('div');
      info.className = 'yt-result-info';
      info.appendChild(title);
      info.appendChild(meta);
      thumbnail.src = thumbSrc;
      thumbnail.onerror = () => {
        if (videoId) thumbnail.src = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
      };
      const queueButton = document.createElement('button');
      queueButton.type = 'button';
      queueButton.className = 'btn-spotify btn-spotify-primary add-yt-queue-btn';
      queueButton.textContent = '+ Queue';
      const queueItemId = createQueueItemId();
      const playButton = document.createElement('button');
      playButton.type = 'button';
      playButton.className = 'btn-spotify btn-spotify-dark play-yt-result-btn';
      playButton.textContent = 'Putar';
      playButton.setAttribute('aria-label', `Putar ${itemTitle}`);
      const actions = document.createElement('div');
      actions.className = 'yt-result-actions';
      actions.appendChild(playButton);
      actions.appendChild(queueButton);
      card.appendChild(thumbnail);
      card.appendChild(info);
      card.appendChild(actions);

      const queueBtn = card.querySelector('.add-yt-queue-btn');
      if (queueBtn) {
        queueBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (queueBtn.disabled) return;
          queueBtn.disabled = true;
          queueBtn.textContent = 'Menambahkan…';
          try {
            await this.addYoutubeTrackToQueue(itemUrl, itemTitle, itemArtist, item.duration, thumbSrc, queueItemId);
            queueBtn.textContent = '✓ Ditambah';
            queueBtn.style.backgroundColor = 'var(--spotify-green)';
            queueBtn.style.color = '#000';
          } catch (error) {
            queueBtn.disabled = false;
            queueBtn.textContent = 'Coba lagi';
            this.showUrlFeedback('Lagu gagal ditambahkan ke antrean. Coba lagi.', 'error');
          }
        });
      }

      playButton.addEventListener('click', async event => {
        event.stopPropagation();
        playButton.disabled = true;
        playButton.textContent = 'Memuat…';
        try {
          await this.streamAudioFromUrl(itemUrl, itemTitle, itemArtist, item.duration, thumbSrc);
        } catch (error) {
          this.showUrlFeedback('Video gagal dimuat. Coba lagi atau buka sumber YouTube.', 'error');
        } finally {
          playButton.disabled = false;
          playButton.textContent = 'Putar';
        }
      });

      list.appendChild(card);
    });
  }

  loadSoloQueue() {
    try {
      if (typeof localStorage === 'undefined') return [];
      const queue = JSON.parse(localStorage.getItem('rync_solo_queue') || '[]');
      return Array.isArray(queue) ? queue : [];
    } catch (error) {
      return [];
    }
  }

  addToSoloQueue(track) {
    if (!track?.id) return;
    track.queueItemId ||= `qi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    if (!this.soloQueue.some(item => queueItemKey(item) === queueItemKey(track))) this.soloQueue = [...this.soloQueue, track];
    try { localStorage.setItem('rync_solo_queue', JSON.stringify(this.soloQueue)); } catch (error) {}
    if (!this.app.socketClient?.roomId) this.renderQueue(this.soloQueue);
  }

  async addYoutubeTrackToQueueOnly(url, trackTitle, artist = 'YouTube', duration = 210, thumbnail = '') {
    let thumbUrl = thumbnail;
    if (!thumbUrl || thumbUrl === 'NA' || !thumbUrl.startsWith('http')) {
      const match = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([a-zA-Z0-9_-]{11})/);
      if (match) {
        thumbUrl = `https://i.ytimg.com/vi/${match[1]}/hqdefault.jpg`;
      }
    }

    const match = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([a-zA-Z0-9_-]{11})/);
    const videoId = match?.[1];
    if (!videoId) throw new Error('ID video YouTube tidak valid');
    const item = {
      id: 'q_' + Math.random().toString(36).substring(2, 9),
      name: trackTitle,
      artist,
      duration: duration || 210,
      thumbnail: thumbUrl,
      sourceType: 'youtube',
      sourceId: videoId,
      sourceUrl: `https://www.youtube.com/watch?v=${videoId}`
    };

    await this.app.socketClient.addToQueue(item);
  }

  async streamAudioFromUrl(url, trackTitle, artist = 'YouTube', duration = 210, thumbnail = '') {
    const videoId = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/)?.[1];
    if (!videoId) throw new Error('ID video YouTube tidak valid');
    const item = {
      id: `yt_${videoId}`,
      name: trackTitle,
      artist,
      duration: duration || 0,
      thumbnail: thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      sourceType: 'youtube',
      sourceId: videoId,
      sourceUrl: `https://www.youtube.com/watch?v=${videoId}`
    };
    if (!this.app.socketClient.roomId) {
      this.addToSoloQueue(item);
      this.app.socketClient.cloudMesh.lastKnownTrack = item;
      this.app.socketClient.cloudMesh.loadTrackBuffer(item);
      this.app.youtubePlayer?.setVolume(this.app.audioEngine.volume);
      this.app.youtubePlayer?.playAt(item.sourceId, this.getYouTubeTargetServerTime(), 0)
        .catch(() => this.setYouTubePlayerStatus('Tekan Play di player YouTube untuk mulai.'));
      this.updateTrackUI(item.name, item.duration, item.thumbnail);
      return item;
    }
    const socketClient = this.app.socketClient;
    const existingQueueItem = (socketClient.cloudMesh?.lastKnownQueue || []).find(queued => queued.id === item.id);
    const alreadyQueued = !!existingQueueItem;
    if (existingQueueItem) item.queueItemId = queueItemKey(existingQueueItem);
    const queueSync = alreadyQueued ? Promise.resolve(true) : Promise.resolve(socketClient.addToQueue(item)).then(added => {
      if (added === false) return false;
      const waitForAck = socketClient.cloudMesh?.waitForQueueItemAcknowledgement;
      return waitForAck ? waitForAck.call(socketClient.cloudMesh, queueItemKey(item)) : added;
    });
    this.updateTrackUI(item.name, item.duration, item.thumbnail);
    this.setYouTubePlayerVisible(true);
    if (this.app.socketClient.isHost) this.setYouTubePlayerStatus('Menyiapkan pemutaran room…');
    else this.setYouTubePlayerStatus('Meminta host memutar lagu…');
    queueSync.then(async synced => {
      if (synced === false) {
        this.showUrlFeedback('Antrean room gagal disinkronkan. Coba tambahkan lagu lagi.', 'error');
        return;
      }
      if (socketClient.isHost) {
        socketClient.cloudMesh.lastKnownTrack = item;
        const selected = await socketClient.playQueueItem(queueItemKey(item), true);
        if (!selected) this.showUrlFeedback('Room gagal memilih lagu. Refresh antrean lalu coba lagi.', 'error');
      } else {
        const requested = socketClient.requestControl('play_queue_item', { queueId: queueItemKey(item), name: item.name });
        if (!requested) this.showUrlFeedback('Permintaan putar tidak terkirim. Coba lagi.', 'error');
      }
    }).catch(() => this.showUrlFeedback('Room gagal memulai lagu. Refresh antrean atau coba lagi.', 'error'));
    return item;
  }

  async playResolvedAudio(item) {
    const socketClient = this.app.socketClient;
    if (!item?.audioUrl) throw new Error('URL audio tidak tersedia');
    if (socketClient.roomId) {
      const existingQueueItem = (socketClient.cloudMesh?.lastKnownQueue || []).find(queued => queued.id === item.id);
      const alreadyQueued = !!existingQueueItem;
      if (existingQueueItem) item.queueItemId = queueItemKey(existingQueueItem);
      const queueSync = alreadyQueued ? Promise.resolve(true) : Promise.resolve(socketClient.addToQueue(item)).then(added => {
        if (added === false) return false;
        const waitForAck = socketClient.cloudMesh?.waitForQueueItemAcknowledgement;
        return waitForAck ? waitForAck.call(socketClient.cloudMesh, queueItemKey(item)) : added;
      });
      this.updateTrackUI(item.name, item.duration || 0, item.thumbnail || '');
      this.setTrackLoading(`Menyiapkan ${item.name}…`);
      queueSync.then(async synced => {
        if (synced === false) {
          this.showUrlFeedback('Antrean room gagal disinkronkan. Coba lagi.', 'error');
          return;
        }
        this.showUrlFeedback('Lagu siap di antrean room.', 'success');
        if (socketClient.isHost) {
          socketClient.cloudMesh.lastKnownTrack = item;
          const selected = await socketClient.playQueueItem(queueItemKey(item), true);
          if (!selected) this.showUrlFeedback('Room gagal memilih lagu. Refresh antrean lalu coba lagi.', 'error');
        } else {
          const requested = socketClient.requestControl('play_queue_item', { queueId: queueItemKey(item), name: item.name });
          if (!requested) this.showUrlFeedback('Permintaan putar tidak terkirim. Coba lagi.', 'error');
        }
      }).catch(() => this.showUrlFeedback('Room gagal memulai lagu. Refresh antrean atau coba lagi.', 'error'));
      return item;
    }

    this.addToSoloQueue(item);
    socketClient.cloudMesh.lastKnownTrack = item;
    this.currentTrack = item;
    this.updateTrackUI(item.name, item.duration || 0, item.thumbnail || '');
    this.setTrackLoading(`Memuat ${item.name}…`);
    const buffer = await this.app.audioEngine.loadAudioFromUrl(item.audioUrl, item.name);
    this.updateTrackUI(item.name, buffer.duration || item.duration || 0, item.thumbnail || '');
    this.clearTrackLoading();
    this.app.audioEngine.schedulePlayAtServerTime(
      socketClient.clockSync?.getServerTime?.() + 50 || Date.now() + 50,
      0
    );
    this.setPlayState(true);
    this.setView('home');
    return item;
  }

  async addYoutubeTrackToQueue(url, trackTitle, artist = 'YouTube', duration = 210, thumbnail = '', queueItemId = createQueueItemId()) {
    const match = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([a-zA-Z0-9_-]{11})/);
    const videoId = match?.[1];
    const thumbUrl = thumbnail && thumbnail !== 'NA' && thumbnail.startsWith('http')
      ? thumbnail
      : (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '');
    const item = {
      id: videoId ? `yt_${videoId}` : `yt_${Math.random().toString(36).slice(2, 9)}`,
      name: trackTitle,
      artist,
      duration: duration || 210,
      thumbnail: thumbUrl,
      queueItemId,
      sourceType: 'youtube',
      sourceId: videoId,
      sourceUrl: `https://www.youtube.com/watch?v=${videoId}`
    };
    if (this.app.socketClient.roomId) {
      const socketClient = this.app.socketClient;
      const added = await socketClient.addToQueue(item);
      if (added === false) throw new Error('Queue item rejected');
      const waitForAck = socketClient.cloudMesh?.waitForQueueItemAcknowledgement;
      if (waitForAck && await waitForAck.call(socketClient.cloudMesh, queueItemId) === false) {
        throw new Error('Queue item was not acknowledged');
      }
    }
    else this.addToSoloQueue(item);
    return item;
  }

  async clearUpcomingQueue() {
    const socketClient = this.app.socketClient;
    const inRoom = Boolean(socketClient?.roomId);
    if (inRoom && !socketClient.isHost) return;
    const currentTrack = inRoom ? socketClient.cloudMesh?.lastKnownTrack : this.currentTrack;
    const upcoming = upcomingQueueItems(this.cachedQueue, currentTrack, currentTrack?.name);
    if (!upcoming.length) return;
    let removed;
    if (inRoom) {
      const result = await socketClient.clearQueue(upcoming.map(queueItemKey));
      removed = result?.removed;
    } else {
      const upcomingIds = new Set(upcoming.map(queueItemKey));
      removed = this.cachedQueue
        .map((item, index) => ({ item, index }))
        .filter(entry => upcomingIds.has(queueItemKey(entry.item)));
      this.soloQueue = this.soloQueue.filter(item => !upcomingIds.has(queueItemKey(item)));
      try { localStorage.setItem('rync_solo_queue', JSON.stringify(this.soloQueue)); } catch (error) {}
      this.renderQueue(this.soloQueue);
    }
    if (!removed?.length) return;

    clearTimeout(this.pendingQueueUndoTimer);
    this.pendingQueueUndo = removed;
    if (this.elements.queueUndoBar) this.elements.queueUndoBar.hidden = false;
    this.pendingQueueUndoTimer = setTimeout(() => {
      this.pendingQueueUndo = null;
      if (this.elements.queueUndoBar) this.elements.queueUndoBar.hidden = true;
    }, 8000);
  }

  async restoreQueueUndo() {
    if (!this.pendingQueueUndo) return;
    const removed = this.pendingQueueUndo;
    this.pendingQueueUndo = null;
    clearTimeout(this.pendingQueueUndoTimer);
    if (this.elements.queueUndoBar) this.elements.queueUndoBar.hidden = true;
    if (!this.app.socketClient.roomId) {
      const restoredQueue = [...this.soloQueue];
      [...removed].sort((a, b) => a.index - b.index).forEach(entry => {
        restoredQueue.splice(Math.min(entry.index, restoredQueue.length), 0, entry.item);
      });
      this.soloQueue = restoredQueue;
      try { localStorage.setItem('rync_solo_queue', JSON.stringify(restoredQueue)); } catch (error) {}
      this.renderQueue(restoredQueue);
    } else {
      await this.app.socketClient.restoreQueue(removed);
    }
  }

  commitQueueReorder(queue) {
    this.renderQueue(queue);
    if (this.app.socketClient.roomId) {
      this.app.socketClient.reorderQueue(queue);
      return;
    }
    this.soloQueue = queue;
    try { localStorage.setItem('rync_solo_queue', JSON.stringify(queue)); } catch (error) {}
  }

  moveQueueItemById(trackId, direction) {
    const socketClient = this.app.socketClient;
    if (socketClient?.roomId && !socketClient.isHost) return false;
    if (![-1, 1].includes(direction)) return false;
    const fromIndex = this.cachedQueue.findIndex(item => queueItemKey(item) === trackId);
    const toIndex = fromIndex + direction;
    if (fromIndex < 0 || toIndex < 0 || toIndex >= this.cachedQueue.length) return false;
    this.commitQueueReorder(moveQueueItem(this.cachedQueue, fromIndex, toIndex));
    return true;
  }

  bindQueueMenuDismissal() {
    if (this.queueMenuDismissHandler || typeof document === 'undefined') return;
    this.queueMenuDismissHandler = () => {
      document.querySelectorAll('.queue-dropdown-menu.active').forEach(dropdown => {
        dropdown.classList.remove('active');
        dropdown.previousElementSibling?.setAttribute('aria-expanded', 'false');
      });
    };
    document.addEventListener('click', this.queueMenuDismissHandler);
  }

  renderQueue(queue = []) {
    this.cachedQueue = queue;
    if (!this.app.socketClient?.roomId) this.soloQueue = queue;
    const container = this.elements.queueListContainer;
    if (!container) return;

    if (this.elements.queueCountBadge) {
      this.elements.queueCountBadge.innerText = `${queue.length} lagu`;
    }
    const currentTrack = this.app.socketClient?.cloudMesh?.lastKnownTrack;
    const isInRoom = Boolean(this.app.socketClient?.roomId);
    const activeTrack = isInRoom ? currentTrack : this.currentTrack;
    const currentTrackName = this.app.audioEngine?.currentTrackName || '';
    const activeQueueItem = currentQueueItem(queue, activeTrack, !activeTrack ? currentTrackName : undefined);
    const upcoming = upcomingQueueItems(queue, activeTrack, activeTrack?.name);
    if (this.elements.clearUpcomingBtn) {
      this.elements.clearUpcomingBtn.hidden = (isInRoom && !this.app.socketClient?.isHost) || upcoming.length === 0;
    }

    if (queue.length === 0) {
      container.replaceChildren();
      const emptyState = document.createElement('div');
      emptyState.className = 'queue-empty-state';
      const message = document.createElement('div');
      message.className = 'queue-empty-msg';
      message.textContent = 'Antrean kosong. Cari lagu untuk ditambahkan.';
      const searchButton = document.createElement('button');
      searchButton.type = 'button';
      searchButton.className = 'queue-empty-search';
      searchButton.textContent = 'Cari lagu';
      searchButton.addEventListener('click', () => this.setView('search'));
      emptyState.appendChild(message);
      emptyState.appendChild(searchButton);
      container.appendChild(emptyState);
      return;
    }

    container.innerHTML = '';
    queue.forEach((item, index) => {
      const isCurrent = item === activeQueueItem;
      const div = document.createElement('div');
      div.className = `queue-item ${isCurrent ? 'active-track' : ''}`;
      div.setAttribute('draggable', String(!isInRoom || !!this.app.socketClient?.isHost));
      div.dataset.index = index;
      div.dataset.id = item.id;
      div.dataset.queueItemId = queueItemKey(item);

      div.innerHTML = `
        <div class="drag-handle" title="Tahan & geser utk ubah urutan">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/>
            <circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>
            <circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/>
          </svg>
        </div>
        <div class="queue-item-position" style="font-weight:700; font-size:0.75rem; width:16px;"></div>
        <div class="queue-item-info">
          <div class="queue-item-title"></div>
          <div class="queue-item-meta"></div>
        </div>
        
        <div class="queue-item-actions">
          <button type="button" class="queue-menu-btn" title="Menu Opsi Lagu" aria-label="Opsi ${escapeHtml(item.name || 'lagu')}" aria-haspopup="true" aria-expanded="false">⋮</button>
          <div class="queue-dropdown-menu">
            <button type="button" class="queue-dropdown-item q-action-play">Putar Sekarang</button>
            <button type="button" class="queue-dropdown-item q-action-playnext">Putar Berikutnya</button>
            <button type="button" class="queue-dropdown-item q-action-move-up" aria-label="Pindah ${escapeHtml(item.name || 'lagu')} ke atas">Pindah ke atas</button>
            <button type="button" class="queue-dropdown-item q-action-move-down" aria-label="Pindah ${escapeHtml(item.name || 'lagu')} ke bawah">Pindah ke bawah</button>
            <button type="button" class="queue-dropdown-item q-action-download">Unduh Audio</button>
            <button type="button" class="queue-dropdown-item danger q-action-delete">Hapus</button>
          </div>
        </div>
      `;
      const position = div.querySelector('.queue-item-position');
      position.textContent = isCurrent ? '▶' : String(index + 1);
      position.style.color = isCurrent ? 'var(--spotify-green)' : 'var(--text-silver)';
      const title = div.querySelector('.queue-item-title');
      title.textContent = item.name || 'Untitled';
      title.style.color = isCurrent ? 'var(--spotify-green)' : 'var(--text-base)';
      div.querySelector('.queue-item-meta').textContent = `${item.artist || 'Artist'} • ${this.formatTime(item.duration)} • Oleh ${item.addedBy || 'Member'}`;

      const menuBtn = div.querySelector('.queue-menu-btn');
      const dropdown = div.querySelector('.queue-dropdown-menu');

      if (menuBtn && dropdown) {
        menuBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          document.querySelectorAll('.queue-dropdown-menu.active').forEach(d => {
            if (d !== dropdown) d.classList.remove('active');
          });
          const isOpen = !dropdown.classList.contains('active');
          dropdown.classList.toggle('active', isOpen);
          menuBtn.setAttribute('aria-expanded', String(isOpen));
        });
      }

      const moveUpButton = div.querySelector('.q-action-move-up');
      const moveDownButton = div.querySelector('.q-action-move-down');
      const canReorder = !isInRoom || !!this.app.socketClient?.isHost;
      if (moveUpButton) {
        moveUpButton.disabled = !canReorder || index === 0;
        moveUpButton.addEventListener('click', event => {
          event.stopPropagation();
          dropdown.classList.remove('active');
          menuBtn?.setAttribute('aria-expanded', 'false');
          this.moveQueueItemById(queueItemKey(item), -1);
        });
      }
      if (moveDownButton) {
        moveDownButton.disabled = !canReorder || index === queue.length - 1;
        moveDownButton.addEventListener('click', event => {
          event.stopPropagation();
          dropdown.classList.remove('active');
          menuBtn?.setAttribute('aria-expanded', 'false');
          this.moveQueueItemById(queueItemKey(item), 1);
        });
      }

      // 1. Play Now Action (Load track ready for Play)
      div.querySelector('.q-action-play')?.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.remove('active');
        if (!this.app.socketClient.roomId) {
          this.playLibraryTrack(item);
          return;
        }
        if (!this.app.socketClient.isHost) {
          this.app.socketClient.requestControl('play_queue_item', { queueId: queueItemKey(item), name: item.name });
          return;
        }
        this.app.audioEngine.ensureContext();
        this.app.audioEngine.stopLocalPlayback();
        this.setPlayState(false);
        this.setTrackLoading(`Memuat ${item.name}...`);
        this.app.socketClient.playQueueItem(queueItemKey(item), true);
      });

      // 2. Play Next Action
      div.querySelector('.q-action-playnext')?.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.remove('active');
        if (!this.app.socketClient.roomId) {
          this.addToSoloQueue(item);
          const queue = this.soloQueue.filter(entry => queueItemKey(entry) !== queueItemKey(item));
          const currentIndex = queue.findIndex(entry => queueItemKey(entry) === queueItemKey(this.currentTrack));
          queue.splice(currentIndex < 0 ? 0 : currentIndex + 1, 0, item);
          this.soloQueue = queue;
          this.renderQueue(queue);
          try { localStorage.setItem('rync_solo_queue', JSON.stringify(queue)); } catch (error) {}
          return;
        }
        if (!this.app.socketClient.isHost) {
          this.app.socketClient.requestControl('play_next', { queueId: queueItemKey(item), name: item.name });
          return;
        }
        this.app.socketClient.playNext(queueItemKey(item));
      });

      // 3. Download Audio File Action
      div.querySelector('.q-action-download')?.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.remove('active');
        if (item.audioUrl) {
          const a = document.createElement('a');
          a.href = item.audioUrl;
          a.download = `${item.name || 'track'}.mp3`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        } else if (item.sourceType === 'local-file') {
          this.localLibrary.getLocalAudio(item.id).then(local => {
            if (!local?.audioData) throw new Error('File lokal sudah tidak tersedia.');
            const blob = new Blob([local.audioData], { type: 'audio/mpeg' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = item.name || 'track';
            a.click();
            URL.revokeObjectURL(url);
          }).catch(() => this.showUrlFeedback('File lokal tidak bisa diunduh.', 'error'));
        } else {
          alert('Audio stream tidak memiliki URL unduhan langsung.');
        }
      });

      // 4. Delete Action
      div.querySelector('.q-action-delete')?.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.remove('active');
        if (!this.app.socketClient.roomId) {
          this.soloQueue = this.soloQueue.filter(entry => queueItemKey(entry) !== queueItemKey(item));
          try { localStorage.setItem('rync_solo_queue', JSON.stringify(this.soloQueue)); } catch (error) {}
          this.renderQueue(this.soloQueue);
          return;
        }
        if (!this.app.socketClient.isHost) {
          this.app.socketClient.requestControl('remove_queue', { queueId: queueItemKey(item), name: item.name });
          return;
        }
        this.app.socketClient.removeFromQueue(queueItemKey(item));
      });

      // Click row to select/load track (with autoplay)
      div.addEventListener('click', (e) => {
        if (Date.now() < this.suppressQueueRowClickUntil || e.target.closest('.queue-item-actions') || e.target.closest('.drag-handle')) return;
        if (!this.app.socketClient.roomId) {
          this.playLibraryTrack(item);
          return;
        }
        if (!this.app.socketClient.isHost) {
          this.app.socketClient.requestControl('play_queue_item', { queueId: queueItemKey(item), name: item.name });
          return;
        }
        this.app.audioEngine.ensureContext();
        this.app.audioEngine.stopLocalPlayback();
        this.setPlayState(false);
        this.setTrackLoading(`Memuat ${item.name}...`);
        if (item.isSynthetic) {
          const buffer = this.app.audioEngine.generateSyntheticTrack('synthwave');
          this.updateTrackUI(item.name, buffer.duration);
        }
        this.app.socketClient.playQueueItem(queueItemKey(item), true);
      });

      // Desktop HTML5 Drag and Drop
      div.addEventListener('dragstart', (e) => {
        this.draggedIndex = index;
        div.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });

      div.addEventListener('dragend', () => {
        div.classList.remove('dragging');
        this.draggedIndex = null;
      });

      div.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      });

      div.addEventListener('drop', (e) => {
        e.preventDefault();
        if (this.app.socketClient.roomId && !this.app.socketClient.isHost) return;
        const fromIdx = this.draggedIndex;
        const toIdx = index;
        if (fromIdx !== null && fromIdx !== undefined && fromIdx !== toIdx) {
          this.commitQueueReorder(moveQueueItem(this.cachedQueue, fromIdx, toIdx));
        }
      });

      // Mobile long-press sorting: preview during drag, commit exactly once on drop.
      let touchTimer = null;
      let startY = 0;
      let isDraggingTouch = false;
      let touchTargetIndex = index;

      const clearTouchDrag = () => {
        clearTimeout(touchTimer);
        div.classList.remove('dragging');
        container.querySelectorAll('.queue-item.drop-target').forEach(row => row.classList.remove('drop-target'));
        isDraggingTouch = false;
        touchTargetIndex = index;
      };

      div.addEventListener('touchstart', (e) => {
        if ((this.app.socketClient.roomId && !this.app.socketClient.isHost) || !e.target.closest('.drag-handle')) return;
        startY = e.touches[0].clientY;
        touchTargetIndex = index;
        touchTimer = setTimeout(() => {
          isDraggingTouch = true;
          div.classList.add('dragging');
          if (navigator.vibrate) navigator.vibrate(40);
        }, 250);
      }, { passive: true });

      div.addEventListener('touchmove', (e) => {
        if (!isDraggingTouch) {
          if (Math.abs(e.touches[0].clientY - startY) > 10) clearTimeout(touchTimer);
          return;
        }
        e.preventDefault();
        const targetEl = document.elementFromPoint(e.touches[0].clientX, e.touches[0].clientY)?.closest('.queue-item');
        if (!targetEl || targetEl === div || targetEl.dataset.index === undefined) return;
        const nextIndex = Number.parseInt(targetEl.dataset.index, 10);
        if (!Number.isInteger(nextIndex)) return;
        container.querySelectorAll('.queue-item.drop-target').forEach(row => row.classList.remove('drop-target'));
        targetEl.classList.add('drop-target');
        touchTargetIndex = nextIndex;
      }, { passive: false });

      div.addEventListener('touchend', () => {
        clearTimeout(touchTimer);
        if (!isDraggingTouch) return;
        this.suppressQueueRowClickUntil = Date.now() + 400;
        const fromIndex = index;
        const toIndex = touchTargetIndex;
        clearTouchDrag();
        if (fromIndex === toIndex) return;
        const newQueue = moveQueueItem(this.cachedQueue, fromIndex, toIndex);
        this.commitQueueReorder(newQueue);
      });

      div.addEventListener('touchcancel', clearTouchDrag);

      container.appendChild(div);
    });

  }

  openDeviceSettingsModal(peer) {
    this.selectedDeviceForEdit = peer;
    const { elements } = this;
    if (!elements.deviceSettingsModal) return;

    const isSelf = peer.id === this.app.socketClient.peerId;
    if (elements.modalTargetDeviceName) {
      elements.modalTargetDeviceName.innerText = `${peer.deviceName || 'Speaker'} ${isSelf ? '(You)' : ''}`;
    }

    if (elements.removeDeviceFromRoomBtn) {
      elements.removeDeviceFromRoomBtn.style.display = (this.app.socketClient.isHost && !isSelf) ? 'block' : 'none';
    }

    const currentRole = peer.role || 'stereo';
    [elements.modalSpatialStereo, elements.modalSpatialLeft, elements.modalSpatialRight, elements.modalSpatialCenter].forEach(btn => {
      if (btn) {
        if (btn.id.toLowerCase().includes(currentRole)) btn.classList.add('active');
        else btn.classList.remove('active');
      }
    });

    const currentVol = peer.volume !== undefined ? peer.volume : 1.0;
    if (elements.modalDeviceVolume) elements.modalDeviceVolume.value = currentVol;
    if (elements.modalVolumeText) elements.modalVolumeText.innerText = `${Math.round(currentVol * 100)}%`;

    elements.deviceSettingsModal.classList.add('active');
  }

  renderUserState() {
    const { elements, currentUser } = this;
    if (currentUser) {
      if (elements.userNameLabel) elements.userNameLabel.innerText = currentUser.name ? currentUser.name.split(' ')[0] : 'User';
      if (elements.userAvatarContainer) {
        if (currentUser.avatar) {
          elements.userAvatarContainer.innerHTML = `<img src="${currentUser.avatar}" alt="Avatar" style="width:100%;height:100%;object-fit:cover;">`;
        } else {
          elements.userAvatarContainer.innerHTML = `<span style="font-weight:700;color:var(--spotify-green);font-size:0.75rem;">${currentUser.name ? currentUser.name.charAt(0) : 'U'}</span>`;
        }
      }
      
      if (elements.authLoggedOutView) elements.authLoggedOutView.style.display = 'none';
      if (elements.authLoggedInView) elements.authLoggedInView.style.display = 'flex';
      if (elements.userModalAvatar) elements.userModalAvatar.src = currentUser.avatar || 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><circle cx=%2250%22 cy=%2250%22 r=%2245%22 fill=%22%231ed760%22/></svg>';
      if (elements.userModalName) elements.userModalName.innerText = currentUser.name || 'Google User';
      if (elements.userModalEmail) elements.userModalEmail.innerText = currentUser.email || '';
    } else {
      if (elements.userNameLabel) elements.userNameLabel.innerText = 'Settings';
      if (elements.userAvatarContainer) {
        elements.userAvatarContainer.innerHTML = `
          <svg class="google-g-icon" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
          </svg>`;
      }
      
      if (elements.authLoggedOutView) elements.authLoggedOutView.style.display = 'flex';
      if (elements.authLoggedInView) elements.authLoggedInView.style.display = 'none';
    }
  }

  getDeviceName() {
    if (this.currentUser && this.currentUser.name) {
      return `${this.currentUser.name} Speaker`;
    }
    const ua = navigator.userAgent;
    let name = 'Speaker';
    if (/iPhone|iPad/i.test(ua)) name = 'iOS';
    else if (/Android/i.test(ua)) name = 'Android';
    else if (/Macintosh/i.test(ua)) name = 'Mac';
    else if (/Windows/i.test(ua)) name = 'PC';
    return `${name} (${Math.floor(Math.random() * 899 + 100)})`;
  }

  async handleAudioFiles(files) {
    if (!files || files.length === 0) return;
    const app = this.app;
    await app.audioEngine.ensureContext();
    const inRoom = Boolean(app.socketClient.roomId);

    const fileList = Array.from(files);
    const totalFiles = fileList.length;
    for (let i = 0; i < totalFiles; i++) {
      const file = fileList[i];
      const itemId = `local_${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 12)}`;
      this.setTrackLoading(`Membaca (${i + 1}/${totalFiles}) ${file.name}...`);

      try {
        const arrayBuffer = await file.arrayBuffer();
        let duration = 0;
        try {
          const decoded = await app.audioEngine.decodeAudioDataSafe(arrayBuffer);
          duration = decoded.duration;
        } catch (decErr) {
          console.warn('Audio decode duration notice:', decErr);
        }

        const queueItem = {
          id: itemId,
          name: file.name,
          artist: 'File Audio',
          duration: duration || 0,
          audioUrl: '',
          sourceType: 'local-file',
          addedBy: this.getDeviceName()
        };
        const saved = await this.localLibrary.saveLocalAudio(queueItem, arrayBuffer);
        if (!saved) throw new Error('Penyimpanan lokal tidak tersedia untuk file ini');

        if (app.socketClient.cloudMesh) {
          app.socketClient.cloudMesh.localAudioBufferCache.set(itemId, arrayBuffer);
          app.socketClient.cloudMesh.localAudioBufferCache.set(file.name, arrayBuffer);
        }

        this.addToSoloQueue(queueItem);
        if (inRoom) {
          if (!app.socketClient.isHost) throw new Error('Host room perlu menambahkan file lokal yang ingin dibagikan.');
          await this.uploadLocalTrackToRoom(queueItem, arrayBuffer);
        } else await this.playLibraryTrack(queueItem);
        this.clearTrackLoading();
      } catch (err) {
        console.error('Audio load error for', file.name, err);
        this.clearTrackLoading();
        this.showUrlFeedback(err.message || `File ${file.name} gagal dimuat.`, 'error');
      }
    }

    if (this.elements.audioFileInput) {
      this.elements.audioFileInput.value = '';
    }
    if (app.audioEngine.currentTrackName && app.audioEngine.audioBuffer) {
      this.updateTrackUI(app.audioEngine.currentTrackName, app.audioEngine.currentTrackDuration);
    }
  }

  async uploadLocalTrackToRoom(track, arrayBuffer) {
    const mesh = this.app.socketClient.cloudMesh;
    if (!mesh?.isHost || !mesh.hostToken) throw new Error('Hanya host room yang bisa membagikan file lokal');
    const queuedTrack = { ...track, sourceType: 'local-file', audioUrl: '' };
    mesh.localAudioBufferCache.set(track.id, arrayBuffer);
    const existingQueueItem = mesh.lastKnownQueue?.find(item => queueItemKey(item) === queueItemKey(track))
      || (!track.queueItemId ? mesh.lastKnownQueue?.find(item => item.id === track.id) : null);
    const alreadyQueued = !!existingQueueItem;
    if (existingQueueItem) queuedTrack.queueItemId = queueItemKey(existingQueueItem);
    if (!alreadyQueued) {
      await this.app.socketClient.addToQueue(queuedTrack);
      const added = await mesh.waitForQueueItemAcknowledgement(queueItemKey(queuedTrack));
      if (!added) throw new Error('File lokal tidak masuk ke queue room');
    }
    const selected = queueItemKey(mesh.lastKnownTrack) === queueItemKey(queuedTrack);
    const openPeerCount = [...mesh.dataChannels.values()].filter(channel => channel.readyState === 'open').length;
    if (openPeerCount > 0 && arrayBuffer.byteLength <= 64 * 1024 * 1024) {
      const transfer = await mesh.streamAudioToRoom(arrayBuffer, track.name, track.id);
      if (transfer.sent === transfer.total && transfer.total > 0) {
        return selected ? mesh.lastKnownTrack : queuedTrack;
      }
    }
    if (arrayBuffer.byteLength > 20 * 1024 * 1024) throw new Error('File melebihi batas relay 20 MiB dan belum ada peer P2P yang siap.');
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength)));
    }
    const response = await fetch('/api/room?action=upload_audio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId: mesh.roomId,
        peerId: mesh.peerId,
        hostToken: mesh.hostToken,
        id: track.id,
        queueItemId: queueItemKey(queuedTrack),
        audioBase64: btoa(binary),
        trackName: track.name,
        duration: track.duration,
        expectedQueueRevision: mesh.queueRevision
      })
    });
    const result = await response.json();
    if (!response.ok || !result.success || !result.item?.id) throw new Error('File gagal dibagikan. Coba lagi dengan file lebih kecil.');
    mesh.rememberQueueRevision(result);
    mesh.applyCanonicalQueue(result.queue);
    mesh.localAudioBufferCache.set(result.item.audioUrl, arrayBuffer);
    if (queueItemKey(result.track) === queueItemKey(queuedTrack)) await mesh.sendTrackMetadata(result.track);
    else if (selected) mesh.lastKnownTrack = result.item;
    mesh.loadTrackBuffer(result.item);
    return result.item;
  }

  showUrlFeedback(msg, type = 'info') {
    const feedback = this.currentView === 'room'
      ? (this.elements.roomFeedback || this.elements.directUrlFeedback)
      : (this.elements.directUrlFeedback || this.elements.roomFeedback);
    if (!feedback) return;
    feedback.hidden = false;
    feedback.style.display = 'block';
    feedback.className = `url-feedback-text ${type}`;
    feedback.innerText = msg;
  }

  clearUrlFeedback() {
    const feedbackElements = new Set([this.elements.roomFeedback, this.elements.directUrlFeedback]);
    feedbackElements.forEach(feedback => {
      if (!feedback) return;
      feedback.hidden = true;
      feedback.style.display = 'none';
    });
  }

  setTrackLoading(msg) {
    if (this.elements.trackTitle) {
      this.elements.trackTitle.innerText = msg;
    }
    if (this.elements.trackSub) {
      this.elements.trackSub.innerText = msg.includes('%') ? msg : 'Sync audio...';
    }
  }

  clearTrackLoading() {
    const dur = this.app.audioEngine?.currentTrackDuration || 0;
    if (this.elements.trackSub) {
      this.elements.trackSub.innerText = `${this.formatTime(dur)} • Ready`;
    }
  }

  updateTrackUI(title, duration, thumbnail = '') {
    const sourceTrack = this.app?.socketClient?.cloudMesh?.lastKnownTrack || {};
    const currentTrack = {
      ...sourceTrack,
      id: sourceTrack.id || `track_${encodeURIComponent(title || 'unknown')}`,
      name: title || sourceTrack.name || 'Untitled',
      artist: sourceTrack.artist || '',
      duration: duration || sourceTrack.duration || 0,
      thumbnail: thumbnail || sourceTrack.thumbnail || ''
    };
    this.currentTrack = currentTrack;
    this.syncHomeEmptyState();
    this.updateMiniPlayer();
    if (currentTrack.sourceType === 'youtube') {
      this.app.audioEngine.currentTrackName = currentTrack.name;
      this.app.audioEngine.currentTrackId = currentTrack.id;
      this.app.audioEngine.currentTrackDuration = currentTrack.duration || 0;
      this.app.audioEngine.pauseOffsetSec = this.app.youtubePlayer?.getCurrentTime?.() || 0;
      this.app.audioEngine.stopLocalPlayback();
    }
    if (duration > 0 && this.app?.audioEngine) {
      this.app.audioEngine.currentTrackDuration = duration;
    }
    if (this.elements.trackTitle) this.elements.trackTitle.innerText = title;
    if (this.elements.trackSub) this.elements.trackSub.innerText = `${this.formatTime(duration)} • Ready`;
    if (this.elements.totalTimeText) this.elements.totalTimeText.innerText = this.formatTime(duration);
    this.setYouTubePlayerVisible(currentTrack.sourceType === 'youtube');
    if (currentTrack.sourceType === 'youtube') this.app?.youtubePlayer?.setVolume(this.app.audioEngine?.volume || 1);

    // Save playback to recent history if meaningful track
    if (title && title !== 'Pilih trek lagu' && this.localLibrary) {
      this.localLibrary.addHistory(currentTrack).catch(() => {});
      this.localLibrary.isFavorite(currentTrack.id)
        .then(isFavorite => this.updateFavoriteButton(isFavorite))
        .catch(() => this.updateFavoriteButton(false));
    }

    let thumbUrl = thumbnail;
    if (!thumbUrl || thumbUrl === 'NA' || !thumbUrl.startsWith('http')) {
      thumbUrl = currentTrack?.thumbnail;
    }
    if (!thumbUrl || thumbUrl === 'NA' || !thumbUrl.startsWith('http')) {
      const match = (currentTrack?.audioUrl || currentTrack?.url || currentTrack?.id || '')
        .match(/(?:v=|youtu\.be\/|shorts\/|embed\/|\/vi\/|aud_yt_|yt_)([a-zA-Z0-9_-]{11})/);
      if (match) {
        thumbUrl = `https://i.ytimg.com/vi/${match[1]}/hqdefault.jpg`;
      }
    }

    if (this.elements.albumArtBox) {
      if (thumbUrl && thumbUrl.startsWith('http')) {
        const vidId = thumbUrl.match(/[a-zA-Z0-9_-]{11}/)?.[0] || '';
        this.elements.albumArtBox.innerHTML = `<img src="${thumbUrl}" alt="Artwork" style="width:100%;height:100%;object-fit:cover;border-radius:6px;" onerror="this.src='https://img.youtube.com/vi/${vidId}/mqdefault.jpg'">`;
      } else {
        this.elements.albumArtBox.innerHTML = `
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 18V5l12-2v13"></path>
            <circle cx="6" cy="18" r="3"></circle>
            <circle cx="18" cy="16" r="3"></circle>
          </svg>
        `;
      }
    }
  }

  updateLatencyOffset(offsetMs) {
    this.app.audioEngine.latencyTuner.setManualOffset(offsetMs);
    if (this.elements.latencySlider) this.elements.latencySlider.value = offsetMs;
    const sign = offsetMs > 0 ? '+' : '';
    if (this.elements.latencyDisplay) this.elements.latencyDisplay.innerText = `${sign}${offsetMs} ms`;

    this.app.socketClient.updateLatencyOffset(offsetMs);
  }

  nudgeLatency(delta) {
    const current = parseInt(this.elements.latencySlider?.value || '0', 10);
    this.updateLatencyOffset(current + delta);
  }

  applyPreset(presetKey, offsetMs) {
    document.querySelectorAll('.chip-btn').forEach(btn => btn.classList.remove('active'));
    const btn = document.getElementById(`preset${presetKey.charAt(0).toUpperCase() + presetKey.slice(1)}`);
    if (btn) btn.classList.add('active');
    this.updateLatencyOffset(offsetMs);
  }

  selectSpatialChannel(role, broadcast = true) {
    this.app.audioEngine.setSpatialChannel(role);
    const { elements } = this;
    [elements.spatialStereo, elements.spatialLeft, elements.spatialRight, elements.spatialCenter].forEach(btn => {
      if (btn) {
        if (btn.dataset.role === role) btn.classList.add('active');
        else btn.classList.remove('active');
      }
    });

    if (broadcast && this.app.socketClient.roomId) {
      this.app.socketClient.updateRemotePeerSettings(
        this.app.socketClient.peerId,
        role,
        this.app.audioEngine.volume || 1.0
      );
    }
  }

  setConnected(isConnected) {
    if (isConnected) {
      if (this.elements.connectionStatus) this.elements.connectionStatus.innerText = 'Online';
      if (this.elements.connectionDot) this.elements.connectionDot.classList.add('connected');
    } else {
      if (this.elements.connectionStatus) this.elements.connectionStatus.innerText = 'Offline';
      if (this.elements.connectionDot) this.elements.connectionDot.classList.remove('connected');
    }
  }

  setHostDisconnected(disconnected) {
    if (this.elements.hostDisconnectedNotice) {
      this.elements.hostDisconnectedNotice.hidden = !disconnected;
    }
  }

  setYouTubePlayerVisible(visible) {
    if (this.elements.youtubePlayerShell) this.elements.youtubePlayerShell.hidden = !visible;
    if (!visible) this.setYouTubeAutoplayBlocked(false);
    if (typeof document !== 'undefined') document.body?.classList.toggle('is-youtube-track', visible);
  }

  setYouTubePlayerStatus(message = '', { retryable = false, retrying = false } = {}) {
    if (this.elements.youtubePlayerStatus) this.elements.youtubePlayerStatus.textContent = message;
    if (this.elements.youtubePlayerRetryBtn) {
      this.elements.youtubePlayerRetryBtn.hidden = !message || (!retryable && !retrying);
      this.elements.youtubePlayerRetryBtn.disabled = retrying;
      this.elements.youtubePlayerRetryBtn.textContent = retrying ? 'Memuat…' : 'Coba lagi';
    }
  }

  getYouTubeTargetServerTime(delayMs = 50) {
    const serverTime = this.app?.socketClient?.clockSync?.getServerTime?.();
    return (Number.isFinite(serverTime) ? serverTime : Date.now()) + delayMs;
  }

  async retryYouTubePlayback() {
    const track = this.currentTrack;
    const player = this.app.youtubePlayer;
    if (!track?.sourceId || track.sourceType !== 'youtube' || !player) return false;

    const button = this.elements.youtubePlayerRetryBtn;
    this.setYouTubePlayerStatus('Memuat video YouTube…', { retrying: true });
    this.app.socketClient?.cloudMesh?.broadcastReadiness('PREPARING', track.id, 'youtube');
    const startOffset = player.getCurrentTime?.() || this.app.audioEngine?.pauseOffsetSec || 0;
    try {
      player.destroy();
      await player.playAt(track.sourceId, this.getYouTubeTargetServerTime(), startOffset);
      this.setYouTubePlayerStatus('');
      return true;
    } catch (error) {
      this.setYouTubePlayerStatus('Player YouTube tidak bisa dimuat. Periksa koneksi lalu coba lagi.', { retryable: true });
      return false;
    } finally {
      if (button) {
        button.disabled = false;
        if (!button.hidden) button.textContent = 'Coba lagi';
      }
    }
  }

  setYouTubeAutoplayBlocked(blocked) {
    if (this.elements.youtubeEnableAudioBtn) this.elements.youtubeEnableAudioBtn.hidden = !blocked;
  }

  enableYouTubeAudioFromGesture() {
    const started = this.app.youtubePlayer?.playFromUserGesture() === true;
    if (started) {
      this.setYouTubeAutoplayBlocked(false);
      this.setYouTubePlayerStatus('Mengaktifkan audio…');
    }
    return started;
  }

  async setMetronomeEnabled(enabled) {
    const audioEngine = this.app?.audioEngine;
    if (!audioEngine) return false;
    if (!enabled) {
      audioEngine.metronome?.stop();
      return true;
    }

    await audioEngine.ensureContext();
    if (!audioEngine.metronome) return false;
    audioEngine.metronome.start();
    return true;
  }

  setView(view) {
    if (!['home', 'search', 'library', 'room'].includes(view)) return;
    this.currentView = view;
    this.syncHomeEmptyState();
    const hasRoom = !!this.app.socketClient?.roomId;
    const showRoomSetup = view === 'room' && !hasRoom;
    const showLibrary = view === 'library';
    const showSearch = view === 'search';

    if (this.elements.activeRoomSection) {
      this.elements.activeRoomSection.style.display = showLibrary || showRoomSetup ? 'none' : 'flex';
      this.elements.activeRoomSection.classList.toggle('search-mode', showSearch);
    }
    if (this.elements.miniPlayerBar) {
      const hasTrack = !!this.currentTrack && this.currentTrack.name !== 'Pilih trek lagu';
      this.elements.miniPlayerBar.hidden = !hasTrack || view === 'home';
    }
    if (this.elements.roomHeroSection) {
      this.elements.roomHeroSection.hidden = !showRoomSetup;
      this.elements.roomHeroSection.style.display = showRoomSetup ? 'block' : 'none';
    }
    if (this.elements.librarySection) this.elements.librarySection.hidden = !showLibrary;
    if (this.elements.sourceHubSection) {
      this.elements.sourceHubSection.style.display = showSearch ? 'none' : '';
    }
    if (this.elements.sourceSearchSection) this.elements.sourceSearchSection.style.display = showSearch ? '' : 'none';
    if (this.elements.queueCardSection) this.elements.queueCardSection.style.display = showSearch ? 'none' : '';

    const navButtons = [
      [this.elements.navHomeBtn, 'home'],
      [this.elements.navSearchBtn, 'search'],
      [this.elements.navLibraryBtn, 'library'],
      [this.elements.navRoomBtn, 'room']
    ];
    navButtons.forEach(([button, name]) => {
      if (!button) return;
      button.classList.toggle('active', name === view);
      if (name === view) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });

    if (view === 'search') {
      this.elements.tabBtnYoutube?.click();
      this.elements.ytUrlInput?.focus();
    }
    if (showLibrary) this.refreshLibrary();
  }

  syncHomeEmptyState() {
    const hasTrack = !!this.currentTrack?.name && this.currentTrack.name !== 'Pilih trek lagu';
    if (this.elements.homeEmptyState) this.elements.homeEmptyState.hidden = hasTrack || this.currentView !== 'home';
    this.elements.sourceHubSection?.classList.toggle('has-current-track', hasTrack);
  }

  updateFavoriteButton(isFavorite) {
    const button = this.elements.favoriteTrackBtn;
    if (!button) return;
    button.textContent = isFavorite ? '♥' : '♡';
    button.setAttribute('aria-pressed', String(isFavorite));
    button.setAttribute('aria-label', isFavorite ? 'Hapus dari lagu favorit' : 'Simpan ke lagu favorit');
  }

  async refreshLibrary() {
    try {
      const [playlists, favorites, recent, localFiles] = await Promise.all([
        this.localLibrary.getPlaylists(),
        this.localLibrary.getFavorites(),
        this.localLibrary.getRecentHistory(20),
        this.localLibrary.getLocalAudioTracks()
      ]);
      this.renderPlaylists(playlists);
      this.renderLibraryTracks(this.elements.favoriteList, favorites, 'Belum ada lagu favorit.');
      this.renderLibraryTracks(this.elements.localAudioList, localFiles, 'File audio yang kamu simpan di perangkat ini akan muncul di sini.', null, true);
      this.renderLibraryTracks(this.elements.recentList, recent, 'Lagu yang diputar akan muncul di sini.');
    } catch (error) {
      console.warn('Library unavailable:', error);
    }
  }

  renderPlaylists(playlists = []) {
    const container = this.elements.playlistList;
    if (!container) return;
    container.replaceChildren();
    if (!playlists.length) {
      container.append(this.createLibraryEmpty('Belum ada playlist.'));
      return;
    }

    playlists.forEach(playlist => {
      const row = document.createElement('article');
      row.className = 'playlist-row';
      const title = document.createElement('strong');
      title.textContent = playlist.name;
      const count = document.createElement('span');
      count.className = 'library-row-meta';
      count.textContent = `${playlist.tracks?.length || 0} lagu`;
      const playAll = document.createElement('button');
      playAll.type = 'button';
      playAll.className = 'library-action';
      playAll.textContent = 'Putar semua';
      playAll.disabled = !playlist.tracks?.length;
      playAll.setAttribute('aria-label', `Putar semua dari ${playlist.name}`);
      playAll.addEventListener('click', async () => {
        playAll.disabled = true;
        try { await this.playPlaylist(playlist); }
        finally { playAll.disabled = !playlist.tracks?.length; }
      });
      const shuffleAll = document.createElement('button');
      shuffleAll.type = 'button';
      shuffleAll.className = 'library-action';
      shuffleAll.textContent = 'Acak';
      shuffleAll.disabled = !playlist.tracks?.length;
      shuffleAll.setAttribute('aria-label', `Acak dan putar ${playlist.name}`);
      shuffleAll.addEventListener('click', async () => {
        shuffleAll.disabled = true;
        try { await this.playPlaylist(playlist, { shuffle: true }); }
        finally { shuffleAll.disabled = !playlist.tracks?.length; }
      });
      const addCurrent = document.createElement('button');
      addCurrent.type = 'button';
      addCurrent.className = 'library-action';
      addCurrent.textContent = 'Simpan yang diputar';
      addCurrent.disabled = !this.currentTrack?.id;
      addCurrent.addEventListener('click', async () => {
        if (this.currentTrack) await this.localLibrary.addTrackToPlaylist(playlist.id, this.currentTrack);
        this.refreshLibrary();
      });
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'library-action';
      rename.textContent = 'Ubah nama';
      rename.addEventListener('click', async () => {
        const name = window.prompt('Nama playlist', playlist.name);
        if (name?.trim()) await this.localLibrary.renamePlaylist(playlist.id, name);
        this.refreshLibrary();
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'library-action danger';
      remove.textContent = 'Hapus';
      remove.addEventListener('click', async () => {
        await this.localLibrary.deletePlaylist(playlist.id);
        this.refreshLibrary();
      });
      row.append(title, count, playAll, shuffleAll, addCurrent, rename, remove);
      this.renderLibraryTracks(row, playlist.tracks || [], 'Playlist ini kosong.', playlist.id);
      container.append(row);
    });
  }

  async playPlaylist(playlist, { shuffle = false } = {}) {
    const tracks = Array.isArray(playlist?.tracks)
      ? playlist.tracks.map(track => ({ ...track, queueItemId: createQueueItemId() }))
      : [];
    if (!tracks.length) {
      this.showUrlFeedback('Playlist ini masih kosong.', 'info');
      return;
    }
    if (shuffle) {
      for (let index = tracks.length - 1; index > 0; index--) {
        const target = Math.floor(Math.random() * (index + 1));
        [tracks[index], tracks[target]] = [tracks[target], tracks[index]];
      }
    }

    const socketClient = this.app.socketClient;
    if (!socketClient?.roomId) {
      this.soloQueue = tracks;
      try { localStorage.setItem('rync_solo_queue', JSON.stringify(tracks)); } catch (error) {}
      this.renderQueue(tracks);
      await this.playLibraryTrack(tracks[0]);
      return;
    }

    if (tracks.some(track => track.sourceType === 'local-file') && !socketClient.isHost) {
      this.showUrlFeedback('Playlist dengan file lokal hanya bisa diputar dari perangkat host.', 'error');
      return;
    }
    try {
      for (const track of tracks) {
        const queuedTrack = { ...track, queueItemId: createQueueItemId(), addedBy: this.getDeviceName() };
        const added = await socketClient.addToQueue(queuedTrack);
        track.queueItemId = queuedTrack.queueItemId;
        if (added === false) throw new Error('Playlist gagal dimasukkan ke antrean room.');
        const waitForAck = socketClient.cloudMesh?.waitForQueueItemAcknowledgement;
        if (waitForAck && !await waitForAck.call(socketClient.cloudMesh, queueItemKey(queuedTrack))) {
          throw new Error('Antrean room gagal disinkronkan. Coba lagi.');
        }
      }
      if (socketClient.isHost) {
        const firstTrack = tracks[0];
        if (firstTrack.sourceType === 'local-file') {
          const localTrack = await this.localLibrary.getLocalAudio(firstTrack.id);
          if (!localTrack?.audioData) throw new Error(`File ${firstTrack.name} tidak tersedia di perangkat ini.`);
          await this.uploadLocalTrackToRoom(firstTrack, localTrack.audioData);
        }
        const selected = await socketClient.playQueueItem(queueItemKey(firstTrack), true);
        if (!selected) throw new Error('Room gagal memulai playlist. Refresh antrean lalu coba lagi.');
      } else if (!socketClient.requestControl('play_queue_item', { queueId: queueItemKey(tracks[0]), name: tracks[0].name })) {
        throw new Error('Permintaan putar playlist tidak terkirim. Coba lagi.');
      }
      this.setView('home');
    } catch (error) {
      this.showUrlFeedback(error.message || 'Playlist gagal diputar.', 'error');
    }
  }

  renderLibraryTracks(container, tracks = [], emptyMessage, playlistId = null, allowLocalDelete = false) {
    if (!container) return;
    container.replaceChildren();
    if (!tracks.length) {
      container.append(this.createLibraryEmpty(emptyMessage));
      return;
    }
    tracks.forEach((track, index) => {
      const row = document.createElement('div');
      row.className = 'library-track-row';
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'library-track-play';
      play.textContent = `${track.name || 'Untitled'}${track.artist ? ` · ${track.artist}` : ''}`;
      play.addEventListener('click', () => this.playLibraryTrack(track));
      row.append(play);
      const like = document.createElement('button');
      like.type = 'button';
      like.className = 'library-action';
      like.textContent = '♡';
      like.setAttribute('aria-label', `Simpan ${track.name || 'lagu'} ke favorit`);
      like.setAttribute('aria-pressed', 'false');
      this.localLibrary.isFavorite(track.id).then(liked => {
        like.textContent = liked ? '♥' : '♡';
        like.setAttribute('aria-label', liked ? `Hapus ${track.name || 'lagu'} dari favorit` : `Simpan ${track.name || 'lagu'} ke favorit`);
        like.setAttribute('aria-pressed', String(liked));
      }).catch(() => {});
      like.addEventListener('click', async () => {
        if (await this.localLibrary.isFavorite(track.id)) await this.localLibrary.removeFavorite(track.id);
        else await this.localLibrary.addFavorite(track);
        this.refreshLibrary();
      });
      row.append(like);
      if (allowLocalDelete) {
        const removeLocal = document.createElement('button');
        removeLocal.type = 'button';
        removeLocal.className = 'library-action danger';
        removeLocal.textContent = 'Hapus';
        removeLocal.setAttribute('aria-label', `Hapus file lokal ${track.name || 'audio'}`);
        removeLocal.addEventListener('click', async () => {
          if (!window.confirm(`Hapus ${track.name || 'file audio'} dari perangkat ini?`)) return;
          const removed = await this.localLibrary.deleteLocalAudio(track.id);
          if (!removed) {
            this.showUrlFeedback('File lokal gagal dihapus.', 'error');
            return;
          }
          this.refreshLibrary();
        });
        row.append(removeLocal);
      }
      if (playlistId) {
        const reorder = (direction) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'library-action library-track-order';
          button.textContent = direction < 0 ? '↑' : '↓';
          button.disabled = direction < 0 ? index === 0 : index === tracks.length - 1;
          button.setAttribute('aria-label', `${direction < 0 ? 'Naikkan' : 'Turunkan'} ${track.name || 'lagu'} dalam playlist`);
          button.addEventListener('click', async () => {
            await this.localLibrary.reorderPlaylist(playlistId, index, index + direction);
            this.refreshLibrary();
          });
          return button;
        };
        row.append(reorder(-1), reorder(1));
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'library-action';
        remove.textContent = 'Hapus';
        remove.setAttribute('aria-label', `Hapus ${track.name || 'lagu'} dari playlist`);
        remove.addEventListener('click', async () => {
          await this.localLibrary.removeTrackFromPlaylist(playlistId, track.id);
          this.refreshLibrary();
        });
        row.append(remove);
      }
      container.append(row);
    });
  }

  createLibraryEmpty(message) {
    const empty = document.createElement('p');
    empty.className = 'library-empty';
    empty.textContent = message;
    return empty;
  }

  async playLibraryTrack(track) {
    if (!track?.id || (!track.audioUrl && !(track.sourceType === 'youtube' && track.sourceId) && track.sourceType !== 'local-file')) {
      this.showUrlFeedback('Sumber audio lagu ini sudah tidak tersedia. Cari ulang untuk memutarnya.', 'error');
      return;
    }
    try {
      const socketClient = this.app.socketClient;
      if (track.sourceType === 'youtube' && track.sourceId) {
        if (socketClient.roomId) {
          await this.streamAudioFromUrl(track.sourceUrl || `https://www.youtube.com/watch?v=${track.sourceId}`, track.name, track.artist, track.duration, track.thumbnail);
        } else {
          this.addToSoloQueue(track);
          this.currentTrack = track;
          this.updateTrackUI(track.name, track.duration || 0, track.thumbnail || '');
          socketClient.cloudMesh.lastKnownTrack = track;
          socketClient.cloudMesh.loadTrackBuffer(track);
          this.app.youtubePlayer?.setVolume(this.app.audioEngine.volume);
          this.app.youtubePlayer?.playAt(track.sourceId, this.getYouTubeTargetServerTime(), 0)
            .catch(() => this.setYouTubePlayerStatus('Tekan Play di player YouTube untuk mulai.'));
        }
        this.setView('home');
        return;
      }
      await this.app.audioEngine.ensureContext();
      if (track.sourceType === 'local-file' && !socketClient.roomId) {
        const localTrack = await this.localLibrary.getLocalAudio(track.id);
        if (!localTrack?.audioData) throw new Error('File lokal sudah tidak tersedia');
        this.addToSoloQueue(track);
        await this.app.audioEngine.loadAudioFromArrayBuffer(localTrack.audioData, track.name, track.id);
        socketClient.cloudMesh.lastKnownTrack = track;
        this.currentTrack = track;
        this.updateTrackUI(track.name, track.duration || this.app.audioEngine.currentTrackDuration, track.thumbnail || '');
        this.app.audioEngine.schedulePlayAtServerTime(socketClient.clockSync?.getServerTime?.() + 50 || Date.now() + 50, 0);
        this.setPlayState(true);
        this.setView('home');
        return;
      }
      if (track.sourceType === 'local-file' && socketClient.roomId) {
        if (!socketClient.isHost) {
          this.showUrlFeedback('File lokal hanya bisa dibagikan dari perangkat host.', 'error');
          return;
        }
        const localTrack = await this.localLibrary.getLocalAudio(track.id);
        if (!localTrack?.audioData) throw new Error('File lokal sudah tidak tersedia');
        await this.uploadLocalTrackToRoom(track, localTrack.audioData);
        const selected = await socketClient.playQueueItem(queueItemKey(track), true);
        if (!selected) this.showUrlFeedback('Room gagal memilih file. Refresh antrean lalu coba lagi.', 'error');
        this.setView('home');
        return;
      }
      if (track.audioUrl && !socketClient.roomId) {
        this.addToSoloQueue(track);
        socketClient.cloudMesh.lastKnownTrack = track;
        this.currentTrack = track;
        this.updateTrackUI(track.name, track.duration || 0, track.thumbnail || '');
        this.setTrackLoading(`Memuat ${track.name}…`);
        const buffer = await this.app.audioEngine.loadAudioFromUrl(track.audioUrl, track.name);
        this.app.audioEngine.schedulePlayAtServerTime(
          socketClient.clockSync?.getServerTime?.() + 50 || Date.now() + 50,
          0
        );
        this.updateTrackUI(track.name, buffer.duration || track.duration || 0, track.thumbnail || '');
        this.clearTrackLoading();
        this.setPlayState(true);
        this.setView('home');
        return;
      }
      if (track.audioUrl && socketClient.roomId) {
        await this.playResolvedAudio({ ...track, addedBy: this.getDeviceName() });
        this.setView('home');
        return;
      }
      this.showUrlFeedback('Sumber audio ini belum bisa diputar dari room.', 'error');
    } catch (error) {
      this.showUrlFeedback('Lagu gagal dimuat. Coba cari ulang sumber audio.', 'error');
    }
  }

  async goToPreviousTrack() {
    if (!this.app.socketClient.roomId) {
      const index = this.soloQueue.findIndex(track => queueItemKey(track) === queueItemKey(this.currentTrack));
      if (this.currentTrack?.sourceType === 'youtube' && (index < 0 || this.app.youtubePlayer?.getCurrentTime?.() > 3)) {
        this.app.audioEngine.pauseOffsetSec = 0;
        return this.app.youtubePlayer?.seekTo(0);
      }
      const previous = this.soloQueue[index > 0 ? index - 1 : this.soloQueue.length - 1];
      if (previous) return this.playLibraryTrack(previous);
      if (this.currentTrack?.sourceType === 'youtube') {
        this.app.youtubePlayer?.seekTo(0);
        return;
      }
      return this.showUrlFeedback('Belum ada lagu sebelumnya di antrean.', 'info');
    }
    if (!this.app.socketClient.isHost) return this.app.socketClient.requestControl('previous');
    if (this.cachedQueue.length > 1) return this.app.socketClient.prevTrack();
    const offset = this.currentTrack?.sourceType === 'youtube' ? this.app.youtubePlayer?.getCurrentTime() || 0 : this.app.audioEngine.pauseOffsetSec || 0;
    if (offset > 3) return this.app.socketClient.seekPlayback(0);
    return this.app.socketClient.prevTrack();
  }

  async goToNextTrack(options = {}) {
    if (!this.app.socketClient.roomId) {
      const index = this.soloQueue.findIndex(track => queueItemKey(track) === queueItemKey(this.currentTrack));
      if (this.repeatMode === 'one' && this.currentTrack?.sourceType === 'youtube') {
        this.app.audioEngine.pauseOffsetSec = 0;
        return this.app.youtubePlayer?.playAt(this.currentTrack.sourceId, this.getYouTubeTargetServerTime(), 0);
      }
      let nextIndex = index + 1;
      if (this.shuffle && this.soloQueue.length > 1) {
        nextIndex = Math.floor(Math.random() * this.soloQueue.length);
        if (nextIndex === index) nextIndex = (nextIndex + 1) % this.soloQueue.length;
      } else if (nextIndex >= this.soloQueue.length && this.repeatMode === 'all') nextIndex = 0;
      const next = this.soloQueue[nextIndex];
      if (next) return this.playLibraryTrack(next);
      return this.showUrlFeedback('Antrean kosong. Tambahkan lagu dari Search.', 'info');
    }
    if (!this.app.socketClient.isHost) return this.app.socketClient.requestControl('next');
    return this.advanceRoomTrack(options);
  }

  async advanceRoomTrack({ automatic = false } = {}) {
    const room = this.app.socketClient;
    if (!room?.isHost) return false;
    const mesh = room.cloudMesh;
    let next;
    try {
      next = await mesh.previewNextTrack(automatic);
    } catch (error) {
      this.showUrlFeedback(error.message || 'Lagu berikutnya gagal disiapkan.', 'error');
      return false;
    }
    if (next?.sourceType === 'local-file' && !mesh?.localAudioBufferCache?.has(next.id)) {
      try {
        const localTrack = await this.localLibrary.getLocalAudio(next.id);
        if (!localTrack?.audioData) throw new Error(`File ${next.name} tidak tersedia di perangkat host.`);
        await this.uploadLocalTrackToRoom(next, localTrack.audioData);
      } catch (error) {
        this.showUrlFeedback(error.message || 'File lokal gagal disiapkan untuk room.', 'error');
        return false;
      }
    }
    return room.nextTrack(automatic, queueItemKey(next) || null);
  }

  async syncLocalQueueToRoom() {
    const room = this.app.socketClient;
    const activeTrack = this.currentTrack || room.cloudMesh?.lastKnownTrack;
    if (activeTrack?.sourceType === 'local-file' && room.isHost) {
      const localTrack = await this.localLibrary.getLocalAudio(activeTrack.id);
      if (!localTrack?.audioData) throw new Error('File lokal sudah tidak tersedia di perangkat ini.');
      await this.uploadLocalTrackToRoom(activeTrack, localTrack.audioData);
    }
    const items = [...this.soloQueue];
    const activeQueueItem = activeTrack?.queueItemId
      ? items.find(item => queueItemKey(item) === queueItemKey(activeTrack))
      : items.find(item => item?.id === activeTrack?.id);
    if (activeQueueItem && activeTrack && !activeTrack.queueItemId) activeTrack.queueItemId = queueItemKey(activeQueueItem);
    if (activeTrack?.id && !activeQueueItem) items.unshift(activeTrack);
    const seenIds = new Set();
    let queueBatch = [];
    const flushQueueBatch = async () => {
      if (!queueBatch.length) return;
      const batch = queueBatch;
      queueBatch = [];
      if (room.cloudMesh?.addQueueItems) {
        const synced = await room.cloudMesh.addQueueItems(batch);
        if (!synced) throw new Error('ROOM_QUEUE_SYNC_FAILED');
      } else {
        for (const item of batch) await room.addToQueue(item);
      }
    };
    for (const item of items) {
      if (!item?.id) continue;
      item.queueItemId ||= createQueueItemId();
      if (seenIds.has(queueItemKey(item))) continue;
      seenIds.add(queueItemKey(item));
      if (queueItemKey(item) === queueItemKey(activeTrack) && item.sourceType === 'local-file' && room.cloudMesh?.lastKnownTrack?.audioUrl) {
        continue;
      }
      if (item.sourceType === 'local-file') {
        await flushQueueBatch();
        const localTrack = await this.localLibrary.getLocalAudio(item.id);
        if (!localTrack?.audioData) {
          this.showUrlFeedback(`File ${item.name} tidak tersedia di perangkat ini.`, 'error');
          continue;
        }
        await this.uploadLocalTrackToRoom(item, localTrack.audioData);
      } else {
        queueBatch.push(item);
      }
    }
    await flushQueueBatch();
  }

  async seedCurrentTrackIntoRoom() {
    const track = this.currentTrack || this.app.socketClient.cloudMesh?.lastKnownTrack;
    if (!track) return;
    const wasPlaying = this.isPlayingState;
    const getTrackPosition = () => {
      const position = track.sourceType === 'youtube'
        ? this.app.youtubePlayer?.getCurrentTime?.()
        : this.app.audioEngine?.getCurrentPlaybackPosition?.();
      return Number.isFinite(position) ? position : this.app.audioEngine?.pauseOffsetSec || 0;
    };
    if (track.sourceType === 'youtube' && !track.sourceId) {
      const id = track.id?.startsWith('yt_') ? track.id.slice(3) : '';
      if (/^[A-Za-z0-9_-]{11}$/.test(id)) track.sourceId = id;
    }
    const source = track.sourceType === 'youtube' && track.sourceId
      ? { sourceType: 'youtube', sourceId: track.sourceId, sourceUrl: track.sourceUrl }
      : { audioUrl: track.audioUrl };
    const roomTrack = {
      id: track.id || `q_${Math.random().toString(36).slice(2, 10)}`,
      queueItemId: track.queueItemId,
      name: track.name || 'Untitled',
      artist: track.artist || 'Rync',
      duration: track.duration || 0,
      thumbnail: track.thumbnail || '',
      ...source
    };
    if (track.sourceType === 'local-file' && !this.app.socketClient.roomId) {
      const localTrack = await this.localLibrary.getLocalAudio(track.id);
      if (!localTrack?.audioData) throw new Error('File lokal sudah tidak tersedia di perangkat ini.');
      const sharedTrack = await this.uploadLocalTrackToRoom(roomTrack, localTrack.audioData);
      this.app.socketClient.cloudMesh.lastKnownTrack = sharedTrack;
      if (this.currentTrack && wasPlaying) {
        const offset = getTrackPosition();
        const selectionStartedAt = Date.now();
        const selected = await this.app.socketClient.playQueueItem(queueItemKey(sharedTrack), false);
        if (selected) this.app.socketClient.schedulePlay(800, offset + (Date.now() - selectionStartedAt) / 1000);
      }
      return;
    }
    await this.app.socketClient.addToQueue(roomTrack);
    this.app.socketClient.cloudMesh.lastKnownTrack = roomTrack;
    this.app.socketClient.cloudMesh.lastKnownQueue = this.app.socketClient.cloudMesh.lastKnownQueue || [];
    if (this.app.socketClient.isHost) {
      const offset = getTrackPosition();
      const selectionStartedAt = Date.now();
      const selected = this.currentTrack && wasPlaying
        ? await this.app.socketClient.playQueueItem(queueItemKey(roomTrack), false)
        : true;
      if (selected && this.currentTrack && wasPlaying) {
        this.app.socketClient.schedulePlay(800, offset + (Date.now() - selectionStartedAt) / 1000);
      }
    }
  }

  setRoomState(roomId, isHost) {
    this.renderQueue(this.app.socketClient.cloudMesh?.lastKnownQueue || []);
    document.body?.classList.add('in-room');
    this.setView(this.currentView === 'room' ? 'home' : this.currentView);
    if (this.elements.roomCodeDisplay) this.elements.roomCodeDisplay.innerText = roomId;

    if (isHost) {
      if (this.elements.userRoleBadge) {
        this.elements.userRoleBadge.className = 'role-pill host';
        this.elements.userRoleBadge.innerText = 'HOST';
      }
    } else {
      if (this.elements.userRoleBadge) {
        this.elements.userRoleBadge.className = 'role-pill peer';
        this.elements.userRoleBadge.innerText = 'SATELLITE';
      }
    }
  }

  setSoloState() {
    this.renderQueue(this.soloQueue);
    document.body?.classList.remove('in-room');
    this.setYouTubePlayerVisible(false);
    if (this.elements.roomCodeDisplay) this.elements.roomCodeDisplay.innerText = '----';
    this.setView('home');
  }

  // Single Play/Pause Toggle View State
  setPlayState(isPlaying) {
    const audioEngine = this.app?.audioEngine;
    if (isPlaying && audioEngine?.isPlaying && !audioEngine.isPlaybackActive && this.currentTrack?.sourceType !== 'youtube') return;
    this.isPlayingState = isPlaying;
    if (typeof document !== 'undefined') document.body?.classList.toggle('is-playing', isPlaying);
    if (isPlaying) this.app?.visualizer?.start();
    else this.app?.visualizer?.stop();
    if (this.currentTrack?.sourceType === 'youtube') {
      const player = this.app?.youtubePlayer;
      if (isPlaying && !player?.hasVideo(this.currentTrack.sourceId)) {
        player.playAt(this.currentTrack.sourceId, this.getYouTubeTargetServerTime(), this.app.audioEngine.pauseOffsetSec || 0).catch(() => {});
      } else if (!isPlaying) {
        player?.pause();
      }
    }
    if (this.elements.togglePlayIcon && this.elements.togglePauseIcon) {
      if (isPlaying) {
        this.elements.togglePlayIcon.style.display = 'none';
        this.elements.togglePauseIcon.style.display = 'block';
      } else {
        this.elements.togglePlayIcon.style.display = 'block';
        this.elements.togglePauseIcon.style.display = 'none';
      }
    }
    if (this.elements.miniPlayerPlayBtn) {
      this.elements.miniPlayerPlayBtn.textContent = isPlaying ? 'Ⅱ' : '▶';
      this.elements.miniPlayerPlayBtn.setAttribute('aria-label', isPlaying ? 'Jeda' : 'Putar');
      this.elements.miniPlayerPlayBtn.setAttribute('aria-pressed', String(isPlaying));
    }
  }

  setPlaybackOptions({ repeatMode = this.repeatMode, shuffle = this.shuffle } = {}) {
    if (['off', 'all', 'one'].includes(repeatMode)) this.repeatMode = repeatMode;
    if (typeof shuffle === 'boolean') this.shuffle = shuffle;
    if (this.elements.shuffleToggleBtn) {
      const label = this.shuffle ? 'Matikan acak' : 'Aktifkan acak';
      this.elements.shuffleToggleBtn.setAttribute('aria-pressed', String(this.shuffle));
      this.elements.shuffleToggleBtn.setAttribute('aria-label', label);
      this.elements.shuffleToggleBtn.title = this.shuffle ? 'Acak nyala' : 'Acak mati';
    }
    if (this.elements.repeatToggleBtn) {
      const label = this.repeatMode === 'one' ? 'Ulangi lagu' : this.repeatMode === 'all' ? 'Ulangi antrean' : 'Ulangi mati';
      this.elements.repeatToggleBtn.dataset.repeatMode = this.repeatMode;
      this.elements.repeatToggleBtn.setAttribute('aria-pressed', String(this.repeatMode !== 'off'));
      this.elements.repeatToggleBtn.setAttribute('aria-label', label);
      this.elements.repeatToggleBtn.title = label;
    }
  }

  requestPlaybackOptions(options) {
    if (!this.app.socketClient?.roomId) {
      this.setPlaybackOptions(options);
      return;
    }
    if (!this.app.socketClient?.isHost) {
      this.app.socketClient?.requestControl('playback_options', options);
      return;
    }
    this.app.socketClient.updatePlaybackOptions(options).catch(() => {
      this.showUrlFeedback('Mode pemutaran gagal disinkronkan. Coba lagi.', 'error');
    });
  }

  updateMiniPlayer() {
    const track = this.currentTrack;
    if (!track) return;
    if (this.elements.miniPlayerTitle) this.elements.miniPlayerTitle.textContent = track.name || 'Untitled';
    if (this.elements.miniPlayerArtist) this.elements.miniPlayerArtist.textContent = track.artist || 'Rync';
    if (this.elements.miniPlayerArtwork) {
      let artwork = '';
      try {
        const url = new URL(track.thumbnail, window.location.origin);
        if (url.protocol === 'https:' || url.origin === window.location.origin) {
          artwork = `url("${encodeURI(url.href).replace(/["'()\\\s]/g, encodeURIComponent)}")`;
        }
      } catch (error) { }
      this.elements.miniPlayerArtwork.textContent = artwork ? '' : '♫';
      this.elements.miniPlayerArtwork.style.backgroundImage = artwork;
    }
    if (this.elements.miniPlayerBar && this.currentView !== 'home') this.elements.miniPlayerBar.hidden = false;
  }

  togglePlayback() {
    const { audioEngine, socketClient } = this.app;
    if (!socketClient.roomId && this.currentTrack?.sourceType === 'youtube') {
      if (this.isPlayingState) {
        const position = this.app.youtubePlayer?.getCurrentTime() || 0;
        audioEngine.pauseOffsetSec = position;
        this.app.youtubePlayer?.pause();
        this.setPlayState(false);
      } else {
        const position = audioEngine.pauseOffsetSec || 0;
        this.app.youtubePlayer?.playAt(this.currentTrack.sourceId, this.getYouTubeTargetServerTime(), position)
          .catch(() => this.setYouTubePlayerStatus('Tekan Play di player YouTube untuk mulai.'));
      }
      return;
    }
    if (!socketClient.roomId) {
      audioEngine.ensureContext();
      if (this.isPlayingState) {
        const position = audioEngine.getCurrentPlaybackPosition();
        audioEngine.stopLocalPlayback();
        audioEngine.pauseOffsetSec = position;
        this.setPlayState(false);
        return;
      }
      if (!audioEngine.audioBuffer) {
        if (this.currentTrack?.id) {
          this.playLibraryTrack(this.currentTrack);
          return;
        }
        this.showUrlFeedback('Pilih lagu dari Search untuk mulai memutar.', 'info');
        return;
      }
      const targetTime = (socketClient.clockSync?.getServerTime?.() || Date.now()) + 50;
      audioEngine.schedulePlayAtServerTime(targetTime, audioEngine.pauseOffsetSec || 0);
      this.setPlayState(true);
      return;
    }
    if (!socketClient.isHost) {
      socketClient.requestControl(this.isPlayingState ? 'pause' : 'play');
      return;
    }
    audioEngine.ensureContext();
    if (this.isPlayingState) {
      const position = this.currentTrack?.sourceType === 'youtube'
        ? this.app.youtubePlayer?.getCurrentTime() || 0
        : audioEngine.getCurrentPlaybackPosition();
      audioEngine.stopLocalPlayback();
      audioEngine.pauseOffsetSec = position;
      this.setPlayState(false);
      socketClient.pausePlayback(position);
      return;
    }
    if (!audioEngine.audioBuffer && this.currentTrack?.sourceType !== 'youtube') {
      if (socketClient.roomId) socketClient.schedulePlay(800, 0);
      else if (this.cachedQueue.length) socketClient.nextTrack();
      else this.showUrlFeedback('Pilih lagu dari Search untuk mulai memutar.', 'info');
      return;
    }
    const offset = this.currentTrack?.sourceType === 'youtube'
      ? this.app.youtubePlayer?.getCurrentTime() || audioEngine.pauseOffsetSec || 0
      : audioEngine.pauseOffsetSec || 0;
    socketClient.schedulePlay(800, offset);
  }

  seekPlaybackTo(position) {
    const { audioEngine, socketClient } = this.app;
    const duration = Number(audioEngine.currentTrackDuration) || 0;
    const target = Math.max(0, Math.min(duration || Number(position) || 0, Number(position) || 0));
    if (!socketClient.roomId) {
      if (this.currentTrack?.sourceType === 'youtube') {
        this.app.youtubePlayer?.seekTo(target);
      } else {
        audioEngine.pauseOffsetSec = target;
        if (this.isPlayingState) {
          const targetTime = (socketClient.clockSync?.getServerTime?.() || Date.now()) + 50;
          audioEngine.schedulePlayAtServerTime(targetTime, target);
        }
      }
      return true;
    }
    if (!socketClient.isHost) {
      socketClient.requestControl('seek', { position: target });
      return true;
    }
    if (this.currentTrack?.sourceType === 'youtube') socketClient.seekPlayback(target);
    else socketClient.schedulePlay(800, target);
    return true;
  }

  renderPeerList(peers = []) {
    this.cachedPeers = peers;
    const list = this.elements.devicesList;
    if (list) list.innerHTML = '';
    
    if (this.elements.activeSpeakerCount) {
      this.elements.activeSpeakerCount.innerText = `${peers.length}`;
    }

    // Update Room Readiness Indicator Badge
    if (this.elements.roomReadinessIndicator && this.elements.roomReadinessText) {
      const readyCount = peers.filter(p => p.readiness === 'READY').length;
      const totalCount = peers.length;
      this.elements.roomReadinessText.innerText = `${readyCount}/${totalCount} Siap`;

      if (readyCount === totalCount && totalCount > 0) {
        this.elements.roomReadinessIndicator.className = 'readiness-indicator';
      } else if (peers.some(p => p.readiness === 'FAILED' || p.readiness === 'AUTOPLAY_BLOCKED')) {
        this.elements.roomReadinessIndicator.className = 'readiness-indicator failed';
      } else {
        this.elements.roomReadinessIndicator.className = 'readiness-indicator buffering';
      }
    }

    // Debounced and non-flickering peer loading notice banner for other devices
    const loadingPeer = peers.find(p => p.isAudioLoading && p.id !== this.app.socketClient.peerId);
    if (loadingPeer && this.elements.peerLoadingNotice) {
      if (this.peerLoadingNoticeTimeout) {
        clearTimeout(this.peerLoadingNoticeTimeout);
        this.peerLoadingNoticeTimeout = null;
      }
      this.elements.peerLoadingNotice.style.display = 'flex';
      if (this.elements.peerLoadingNoticeText) {
        this.elements.peerLoadingNoticeText.innerText = `${loadingPeer.deviceName || 'Speaker'} sedang mengunduh audio...`;
      }
    } else if (this.elements.peerLoadingNotice) {
      if (!this.peerLoadingNoticeTimeout) {
        this.peerLoadingNoticeTimeout = setTimeout(() => {
          if (this.elements.peerLoadingNotice) {
            this.elements.peerLoadingNotice.style.display = 'none';
          }
          this.peerLoadingNoticeTimeout = null;
        }, 1200);
      }
    }

    const isUserHost = this.app.socketClient.isHost;

    peers.forEach(peer => {
      const isSelf = peer.id === this.app.socketClient.peerId;
      const div = document.createElement('div');
      div.className = 'device-item';

      const roleStr = escapeHtml(typeof peer.role === 'string' && peer.role ? peer.role.toUpperCase() : 'STEREO');
      const deviceName = escapeHtml(peer.deviceName || 'Speaker');
      const readinessLabels = {
        PREPARING: 'Menyiapkan audio…',
        READY: 'Siap',
        FAILED: 'Audio gagal dimuat',
        AUTOPLAY_BLOCKED: 'Perlu tekan Play'
      };
      const readiness = peer.readiness || 'PREPARING';
      const audioRoute = peerAudioRouteLabel(peer);
      const statusColor = readiness === 'READY' ? 'var(--spotify-green)' : readiness === 'FAILED' || readiness === 'AUTOPLAY_BLOCKED' ? '#ff5c6c' : '#fbbf24';
      const statusText = `<span style="color:${statusColor};font-weight:600;">${readinessLabels[readiness] || 'Menyiapkan audio…'} • ${audioRoute} • ${roleStr} • ${peer.isHost ? 'Host' : 'Satellite'}</span>`;

      div.innerHTML = `
        <div class="device-name-group" style="flex: 1; cursor: pointer;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${statusColor}" stroke-width="2">
            ${peer.isHost ? '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>' : '<rect width="16" height="20" x="4" y="2" rx="2"/><circle cx="12" cy="14" r="4"/>'}
          </svg>
          <div>
            <div class="device-name">${deviceName} ${isSelf ? '<span style="color:var(--spotify-green);font-size:0.7rem;">(You)</span>' : ''}</div>
            <div class="device-latency-tag">${statusText}</div>
          </div>
        </div>
        <div style="display: flex; gap: 6px; align-items: center;">
          <button class="chip-btn atur-peer-btn" style="padding: 2px 8px; font-size: 0.68rem;">Atur</button>
          ${isUserHost && !isSelf ? `
            <button class="chip-btn kick-peer-btn" style="padding: 2px 6px; font-size: 0.68rem; background: rgba(226, 33, 52, 0.15); color: #ff5c6c; border-color: rgba(226, 33, 52, 0.3);" title="Hapus Device">
              ✕
            </button>
          ` : ''}
        </div>
      `;

      div.querySelector('.device-name-group')?.addEventListener('click', () => {
        this.openDeviceSettingsModal(peer);
      });

      div.querySelector('.atur-peer-btn')?.addEventListener('click', () => {
        this.openDeviceSettingsModal(peer);
      });

      div.querySelector('.kick-peer-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Hapus ${peer.deviceName || 'Speaker'} dari room?`)) {
          this.app.socketClient.removeRemotePeer(peer.id);
        }
      });

      if (list) list.appendChild(div);
    });

    this.renderDevicesMatrix();
  }

  renderDevicesMatrix() {
    const list = this.elements.devicesMatrixList;
    if (!list) return;
    list.innerHTML = '';

    const isUserHost = this.app.socketClient.isHost;

    this.cachedPeers.forEach(peer => {
      const isSelf = peer.id === this.app.socketClient.peerId;
      const deviceName = escapeHtml(peer.deviceName || 'Speaker');
      const role = escapeHtml(typeof peer.role === 'string' && peer.role ? peer.role.toUpperCase() : 'STEREO');
      const audioRoute = peerAudioRouteLabel(peer);
      const div = document.createElement('div');
      div.className = 'device-item';
      div.innerHTML = `
        <div class="device-name-group" style="flex: 1; cursor: pointer;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--spotify-green)" stroke-width="2">
            <rect width="16" height="20" x="4" y="2" rx="2"/><circle cx="12" cy="14" r="4"/>
          </svg>
          <div>
            <div class="device-name">${deviceName} ${isSelf ? '<span style="color:var(--spotify-green);font-size:0.7rem;">(You)</span>' : ''}</div>
            <div class="device-latency-tag">Channel: ${role} • ${audioRoute}</div>
          </div>
        </div>
        <div style="display: flex; gap: 6px; align-items: center;">
          <button class="chip-btn atur-peer-matrix-btn" style="padding: 2px 8px; font-size: 0.68rem;">Pilih Channel</button>
          ${isUserHost && !isSelf ? `
            <button class="chip-btn kick-peer-matrix-btn" style="padding: 2px 6px; font-size: 0.68rem; background: rgba(226, 33, 52, 0.15); color: #ff5c6c; border-color: rgba(226, 33, 52, 0.3);" title="Hapus Device">
              ✕
            </button>
          ` : ''}
        </div>
      `;

      div.querySelector('.device-name-group')?.addEventListener('click', () => {
        this.openDeviceSettingsModal(peer);
      });

      div.querySelector('.atur-peer-matrix-btn')?.addEventListener('click', () => {
        this.openDeviceSettingsModal(peer);
      });

      div.querySelector('.kick-peer-matrix-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Hapus ${peer.deviceName || 'Speaker'} dari room?`)) {
          this.app.socketClient.removeRemotePeer(peer.id);
        }
      });

      list.appendChild(div);
    });
  }

  startPlaybackTicker() {
    setInterval(() => {
      const app = this.app;
      if (app.audioEngine) {
        const dur = app.audioEngine.currentTrackDuration || 0;
        const isYoutube = this.currentTrack?.sourceType === 'youtube';
        const cur = isYoutube ? app.youtubePlayer?.getCurrentTime() || 0 : app.audioEngine.getCurrentPlaybackPosition();
        if (this.elements.currentTimeText) this.elements.currentTimeText.innerText = this.formatTime(cur);
        if (this.elements.miniPlayerTime) this.elements.miniPlayerTime.textContent = `${this.formatTime(cur)} / ${this.formatTime(dur)}`;
        if (this.elements.miniPlayerSeek && !this.isMiniSeeking) {
          const progress = dur > 0 ? Math.min(1000, Math.max(0, Math.round((cur / dur) * 1000))) : 0;
          this.elements.miniPlayerSeek.value = String(progress);
          this.elements.miniPlayerSeek.setAttribute('aria-valuetext', `${this.formatTime(cur)} dari ${this.formatTime(dur)}`);
        }

        if (dur > 0 && this.elements.progressFill) {
          const pct = (cur / dur) * 100;
          this.elements.progressFill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
        }
      }
    }, 100);
  }

  formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }
}
