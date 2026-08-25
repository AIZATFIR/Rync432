import { firebaseAuth } from '../auth/FirebaseAuth.js';
import { QRCodeGenerator } from './QRCodeGenerator.js';
import { QRScanner } from './QRScanner.js';

export class UIManager {
  constructor(app) {
    this.app = app;
    this.elements = {};
    this.currentUser = null;
    this.cachedPeers = [];
    this.qrScanner = null;
  }

  init() {
    this.elements = {
      connectionStatus: document.getElementById('connectionStatus'),
      connectionDot: document.getElementById('connectionDot'),
      roomHeroSection: document.getElementById('roomHeroSection'),
      activeRoomSection: document.getElementById('activeRoomSection'),
      roomCodeDisplay: document.getElementById('roomCodeDisplay'),
      userRoleBadge: document.getElementById('userRoleBadge'),
      hostControlsSection: document.getElementById('hostControlsSection'),
      clientNotice: document.getElementById('clientNotice'),
      
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
      
      // Player Controls
      trackTitle: document.getElementById('trackTitle'),
      trackSub: document.getElementById('trackSub'),
      playBtn: document.getElementById('playBtn'),
      playIcon: document.getElementById('playIcon'),
      pauseIcon: document.getElementById('pauseIcon'),
      currentTimeText: document.getElementById('currentTimeText'),
      totalTimeText: document.getElementById('totalTimeText'),
      progressBar: document.getElementById('progressBar'),
      progressFill: document.getElementById('progressFill'),
      volumeSlider: document.getElementById('volumeSlider'),
      
      // Multi-Source Hub Tabs
      tabBtnFile: document.getElementById('tabBtnFile'),
      tabBtnYoutube: document.getElementById('tabBtnYoutube'),
      tabBtnDemo: document.getElementById('tabBtnDemo'),
      tabContentFile: document.getElementById('tabContentFile'),
      tabContentYoutube: document.getElementById('tabContentYoutube'),
      tabContentDemo: document.getElementById('tabContentDemo'),

      // Upload & Demo Elements
      dropzone: document.getElementById('audioDropzone'),
      audioFileInput: document.getElementById('audioFileInput'),
      sampleWavBtn: document.getElementById('sampleWavBtn'),
      demoSynthBtn: document.getElementById('demoSynthBtn'),

      // YouTube Inputs
      ytUrlInput: document.getElementById('ytUrlInput'),
      fetchYtAudioBtn: document.getElementById('fetchYtAudioBtn'),
      ytSampleSynth: document.getElementById('ytSampleSynth'),
      ytSampleLofi: document.getElementById('ytSampleLofi'),
      ytSampleRock: document.getElementById('ytSampleRock'),

      // Spatial Channel Matrix Selector
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

      // Devices List
      devicesList: document.getElementById('devicesList')
    };

    this.initFirebaseAuthListener();
    this.bindEvents();
    this.startPlaybackTicker();

    this.app.audioEngine.onPlaybackEnded = () => {
      this.setPlayState(false);
    };
  }

  initFirebaseAuthListener() {
    firebaseAuth.onAuthStateChanged((user) => {
      this.currentUser = user;
      this.renderUserState();
    });
  }

  bindEvents() {
    const { elements, app } = this;

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

    // Google Sign-In
    if (elements.googleSignInActionBtn) {
      elements.googleSignInActionBtn.addEventListener('click', async () => {
        try {
          const user = await firebaseAuth.signInWithGoogle();
          this.currentUser = user;
          this.renderUserState();
          elements.authModal.classList.remove('active');
        } catch (err) {
          console.warn('Google Sign-In:', err.message);
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

    // 2. Room Actions (Host & Join)
    if (elements.createRoomBtn) {
      elements.createRoomBtn.addEventListener('click', () => {
        app.audioEngine.ensureContext();
        app.socketClient.createRoom(this.getDeviceName());
      });
    }

    if (elements.joinRoomBtn) {
      elements.joinRoomBtn.addEventListener('click', () => {
        const code = elements.roomCodeInput.value.trim().toUpperCase();
        if (code.length === 4) {
          app.audioEngine.ensureContext();
          app.socketClient.joinRoom(code, this.getDeviceName());
        } else {
          alert('Masukkan 4 digit kode room.');
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
        window.location.reload();
      });
    }

    // Camera QR Scanner Handler
    if (elements.scanQrBtn) {
      elements.scanQrBtn.addEventListener('click', async () => {
        if (elements.qrScannerModal) elements.qrScannerModal.classList.add('active');
        try {
          this.qrScanner = new QRScanner(elements.qrVideo, (scannedCode) => {
            if (elements.roomCodeInput) elements.roomCodeInput.value = scannedCode;
            if (elements.qrScannerModal) elements.qrScannerModal.classList.remove('active');
            app.audioEngine.ensureContext();
            app.socketClient.joinRoom(scannedCode, this.getDeviceName());
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

    // Copy Link Buttons
    const copyLinkHandler = () => {
      const roomId = app.socketClient.roomId || 'DEMO';
      const url = `${window.location.origin}/?room=${roomId}`;
      navigator.clipboard.writeText(url).then(() => {
        alert(`Link Room disalin: ${url}`);
      });
    };

    if (elements.copyRoomLinkBtn) elements.copyRoomLinkBtn.addEventListener('click', copyLinkHandler);
    if (elements.copyRoomLinkModalBtn) elements.copyRoomLinkModalBtn.addEventListener('click', copyLinkHandler);

    // Spotify Connect Modal Open / Close
    const openConnectModal = () => {
      const roomId = app.socketClient.roomId || 'DEMO';
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

    // 3. Playback Controls
    if (elements.playBtn) {
      elements.playBtn.addEventListener('click', () => {
        app.audioEngine.ensureContext();
        if (!app.socketClient.isHost) return;
        
        if (app.audioEngine.isPlaying) {
          const currentPos = app.audioEngine.getCurrentPlaybackPosition();
          app.socketClient.pausePlayback(currentPos);
        } else {
          const currentPos = app.audioEngine.pauseOffsetSec || 0;
          app.socketClient.schedulePlay(500, currentPos);
        }
      });
    }

    // Progress Bar Scrubbing
    if (elements.progressBar) {
      elements.progressBar.addEventListener('click', (e) => {
        if (!app.socketClient.isHost || !app.audioEngine.audioBuffer) return;
        const rect = elements.progressBar.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const pct = Math.max(0, Math.min(1, clickX / rect.width));
        const targetSec = pct * app.audioEngine.currentTrackDuration;
        app.socketClient.schedulePlay(400, targetSec);
      });
    }

    // Volume Slider
    if (elements.volumeSlider) {
      elements.volumeSlider.addEventListener('input', (e) => {
        const vol = parseFloat(e.target.value);
        app.audioEngine.setVolume(vol);
      });
    }

    // 4. Multi-Source Tabs Switching
    const switchTab = (activeTab) => {
      ['File', 'Youtube', 'Demo'].forEach(tab => {
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

    if (elements.tabBtnFile) elements.tabBtnFile.addEventListener('click', () => switchTab('file'));
    if (elements.tabBtnYoutube) elements.tabBtnYoutube.addEventListener('click', () => switchTab('youtube'));
    if (elements.tabBtnDemo) elements.tabBtnDemo.addEventListener('click', () => switchTab('demo'));

    // 5. YouTube Stream Extractor
    const handleYtFetch = async (url) => {
      if (!url) {
        alert('Masukkan link YouTube / YT Music');
        return;
      }
      app.audioEngine.ensureContext();
      if (!app.socketClient.roomId) {
        app.socketClient.createRoom(this.getDeviceName());
      }

      this.setTrackLoading('Mengekstrak YouTube...');
      try {
        const streamEndpoint = `/api/yt-stream?url=${encodeURIComponent(url)}`;
        const buffer = await app.audioEngine.loadAudioFromUrl(streamEndpoint, 'YouTube Audio');
        this.updateTrackUI(app.audioEngine.currentTrackName, buffer.duration);

        if (app.socketClient.isHost) {
          app.socketClient.sendTrackMetadata({
            name: app.audioEngine.currentTrackName,
            duration: buffer.duration,
            audioUrl: streamEndpoint
          });
        }
      } catch (err) {
        console.error('YouTube extraction error:', err);
        alert('Gagal mengekstrak YouTube: ' + err.message + '\nSilakan gunakan tab Upload File MP3.');
        this.setTrackLoading('Pilih trek lagu');
      }
    };

    if (elements.fetchYtAudioBtn) {
      elements.fetchYtAudioBtn.addEventListener('click', () => {
        const url = elements.ytUrlInput?.value.trim() || '';
        handleYtFetch(url);
      });
    }

    if (elements.ytUrlInput) {
      elements.ytUrlInput.addEventListener('keyup', (e) => {
        if (e.key === 'Enter') elements.fetchYtAudioBtn.click();
      });
    }

    if (elements.ytSampleSynth) {
      elements.ytSampleSynth.addEventListener('click', () => {
        if (elements.ytUrlInput) elements.ytUrlInput.value = 'https://www.youtube.com/watch?v=4xDzrJKXOOY';
        elements.fetchYtAudioBtn.click();
      });
    }
    if (elements.ytSampleLofi) {
      elements.ytSampleLofi.addEventListener('click', () => {
        if (elements.ytUrlInput) elements.ytUrlInput.value = 'https://www.youtube.com/watch?v=jfKfPfyJRdk';
        elements.fetchYtAudioBtn.click();
      });
    }
    if (elements.ytSampleRock) {
      elements.ytSampleRock.addEventListener('click', () => {
        if (elements.ytUrlInput) elements.ytUrlInput.value = 'https://www.youtube.com/watch?v=kXYiU_JCYtU';
        elements.fetchYtAudioBtn.click();
      });
    }

    // 6. Spatial Channel Matrix Selector
    const selectSpatialChannel = (role) => {
      app.audioEngine.setSpatialChannel(role);
      [elements.spatialStereo, elements.spatialLeft, elements.spatialRight, elements.spatialCenter].forEach(btn => {
        if (btn) {
          if (btn.dataset.role === role) btn.classList.add('active');
          else btn.classList.remove('active');
        }
      });
    };

    if (elements.spatialStereo) elements.spatialStereo.addEventListener('click', () => selectSpatialChannel('stereo'));
    if (elements.spatialLeft) elements.spatialLeft.addEventListener('click', () => selectSpatialChannel('left'));
    if (elements.spatialRight) elements.spatialRight.addEventListener('click', () => selectSpatialChannel('right'));
    if (elements.spatialCenter) elements.spatialCenter.addEventListener('click', () => selectSpatialChannel('center'));

    // 7. Single File Upload Trigger
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
        if (files && files.length > 0) this.handleAudioFile(files[0]);
      });
    }

    // Global Drop
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = e.dataTransfer ? e.dataTransfer.files : null;
      if (files && files.length > 0 && (files[0].type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(files[0].name))) {
        this.handleAudioFile(files[0]);
      }
    });

    if (elements.audioFileInput) {
      elements.audioFileInput.addEventListener('change', (e) => {
        const files = e.target.files;
        if (files && files.length > 0) {
          this.handleAudioFile(files[0]);
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
        this.setTrackLoading('Memuat Acoustic WAV...');
        try {
          const buffer = await app.audioEngine.loadAudioFromUrl('/test_music_sample.wav', 'Acoustic WAV');
          this.updateTrackUI('Acoustic WAV', buffer.duration);

          if (app.socketClient.isHost) {
            app.socketClient.sendTrackMetadata({
              name: 'Acoustic WAV',
              duration: buffer.duration,
              audioUrl: '/test_music_sample.wav'
            });
          }
        } catch (err) {
          console.error(err);
          alert('Gagal memuat sample: ' + err.message);
        }
      });
    }

    // Preset Synth Demo
    if (elements.demoSynthBtn) {
      elements.demoSynthBtn.addEventListener('click', async () => {
        app.audioEngine.ensureContext();
        if (!app.socketClient.roomId) {
          app.socketClient.createRoom(this.getDeviceName());
        }
        this.setTrackLoading('Neon Synth Demo...');
        try {
          const buffer = app.audioEngine.generateSyntheticTrack('synthwave');
          this.updateTrackUI(app.audioEngine.currentTrackName, buffer.duration);

          if (app.socketClient.isHost) {
            app.socketClient.sendTrackMetadata({
              name: app.audioEngine.currentTrackName,
              duration: buffer.duration,
              isSynthetic: true
            });
          }
        } catch (err) {
          alert('Error: ' + err.message);
        }
      });
    }

    // Settings: Metronome
    if (elements.metronomeToggle) {
      elements.metronomeToggle.addEventListener('change', (e) => {
        app.audioEngine.ensureContext();
        if (e.target.checked) {
          app.audioEngine.metronome.start();
        } else {
          app.audioEngine.metronome.stop();
        }
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

  async handleAudioFile(file) {
    if (!file) return;
    const app = this.app;
    await app.audioEngine.ensureContext();

    if (!app.socketClient.roomId) {
      app.socketClient.createRoom(this.getDeviceName());
    }

    const fileSizeMb = (file.size / (1024 * 1024)).toFixed(1);
    this.setTrackLoading(`Membaca (${fileSizeMb} MB)...`);

    try {
      const arrayBuffer = await file.arrayBuffer();
      this.setTrackLoading(`Decode audio...`);
      const audioBuffer = await app.audioEngine.loadAudioFromArrayBuffer(arrayBuffer, file.name);
      this.updateTrackUI(file.name, audioBuffer.duration);

      if (app.socketClient.isHost) {
        app.socketClient.sendTrackMetadata({
          name: file.name,
          duration: audioBuffer.duration
        });
        app.socketClient.sendBinary(arrayBuffer, file.name);
        app.socketClient.uploadAudioFile(file, audioBuffer.duration);
      }
    } catch (err) {
      console.error('Audio load error:', err);
      alert('Gagal mendecode audio: ' + (err.message || 'Format tidak didukung'));
      this.setTrackLoading('Pilih trek lagu');
    } finally {
      if (this.elements.audioFileInput) {
        this.elements.audioFileInput.value = '';
      }
    }
  }

  setTrackLoading(msg) {
    if (this.elements.trackTitle) this.elements.trackTitle.innerText = msg;
    if (this.elements.trackSub) this.elements.trackSub.innerText = 'Sync audio...';
  }

  updateTrackUI(title, duration) {
    if (this.elements.trackTitle) this.elements.trackTitle.innerText = title;
    if (this.elements.trackSub) this.elements.trackSub.innerText = `${this.formatTime(duration)} • Ready`;
    if (this.elements.totalTimeText) this.elements.totalTimeText.innerText = this.formatTime(duration);
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

  setConnected(isConnected) {
    if (isConnected) {
      if (this.elements.connectionStatus) this.elements.connectionStatus.innerText = 'Online';
      if (this.elements.connectionDot) this.elements.connectionDot.classList.add('connected');
    } else {
      if (this.elements.connectionStatus) this.elements.connectionStatus.innerText = 'Offline';
      if (this.elements.connectionDot) this.elements.connectionDot.classList.remove('connected');
    }
  }

  setRoomState(roomId, isHost) {
    if (this.elements.roomHeroSection) this.elements.roomHeroSection.style.display = 'none';
    if (this.elements.activeRoomSection) this.elements.activeRoomSection.style.display = 'flex';
    if (this.elements.roomCodeDisplay) this.elements.roomCodeDisplay.innerText = roomId;

    if (isHost) {
      if (this.elements.userRoleBadge) {
        this.elements.userRoleBadge.className = 'role-pill host';
        this.elements.userRoleBadge.innerText = 'HOST';
      }
      if (this.elements.hostControlsSection) this.elements.hostControlsSection.style.display = 'flex';
      if (this.elements.clientNotice) this.elements.clientNotice.style.display = 'none';
    } else {
      if (this.elements.userRoleBadge) {
        this.elements.userRoleBadge.className = 'role-pill peer';
        this.elements.userRoleBadge.innerText = 'SATELLITE';
      }
      if (this.elements.hostControlsSection) this.elements.hostControlsSection.style.display = 'none';
      if (this.elements.clientNotice) this.elements.clientNotice.style.display = 'block';
    }
  }

  setPlayState(isPlaying) {
    if (isPlaying) {
      if (this.elements.playIcon) this.elements.playIcon.style.display = 'none';
      if (this.elements.pauseIcon) this.elements.pauseIcon.style.display = 'block';
    } else {
      if (this.elements.playIcon) this.elements.playIcon.style.display = 'block';
      if (this.elements.pauseIcon) this.elements.pauseIcon.style.display = 'none';
    }
  }

  renderPeerList(peers = []) {
    this.cachedPeers = peers;
    const list = this.elements.devicesList;
    if (list) list.innerHTML = '';
    
    if (this.elements.activeSpeakerCount) {
      this.elements.activeSpeakerCount.innerText = `${peers.length}`;
    }

    peers.forEach(peer => {
      const isSelf = peer.id === this.app.socketClient.peerId;
      const div = document.createElement('div');
      div.className = 'device-item';

      const offsetStr = peer.latencyOffset !== undefined ? `${peer.latencyOffset > 0 ? '+' : ''}${peer.latencyOffset}ms` : '0ms';
      const rttStr = peer.rtt ? `${peer.rtt}ms` : '<5ms';

      div.innerHTML = `
        <div class="device-name-group">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--spotify-green)" stroke-width="2">
            ${peer.isHost ? '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>' : '<rect width="16" height="20" x="4" y="2" rx="2"/><circle cx="12" cy="14" r="4"/>'}
          </svg>
          <div>
            <div class="device-name">${peer.deviceName || 'Speaker'} ${isSelf ? '<span style="color:var(--spotify-green);font-size:0.7rem;">(You)</span>' : ''}</div>
            <div class="device-latency-tag">Delay: ${offsetStr} • ${peer.isHost ? 'Host' : 'Satellite'}</div>
          </div>
        </div>
        <span class="ping-badge">${rttStr}</span>
      `;
      if (list) list.appendChild(div);
    });

    this.renderDevicesMatrix();
  }

  renderDevicesMatrix() {
    const list = this.elements.devicesMatrixList;
    if (!list) return;
    list.innerHTML = '';

    this.cachedPeers.forEach(peer => {
      const isSelf = peer.id === this.app.socketClient.peerId;
      const div = document.createElement('div');
      div.className = 'device-item';
      div.style.flexDirection = 'column';
      div.style.alignItems = 'flex-start';
      div.style.gap = '6px';

      div.innerHTML = `
        <div style="display:flex;justify-content:space-between;width:100%;align-items:center;">
          <div class="device-name-group">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--spotify-green)" stroke-width="2">
              <rect width="16" height="20" x="4" y="2" rx="2"/><circle cx="12" cy="14" r="4"/>
            </svg>
            <div class="device-name">${peer.deviceName || 'Speaker'} ${isSelf ? '<span style="color:var(--spotify-green);font-size:0.7rem;">(You)</span>' : ''}</div>
          </div>
          <span class="ping-badge">${peer.isHost ? 'Host' : 'Satellite'}</span>
        </div>
        <div style="display:flex;gap:4px;width:100%;">
          <button class="chip-btn ${this.app.audioEngine.spatialRole === 'stereo' ? 'active' : ''}" style="flex:1;padding:3px 4px;font-size:0.68rem;" onclick="window.__ryncApp.uiManager.setSpatialRole('stereo')">Stereo</button>
          <button class="chip-btn ${this.app.audioEngine.spatialRole === 'left' ? 'active' : ''}" style="flex:1;padding:3px 4px;font-size:0.68rem;" onclick="window.__ryncApp.uiManager.setSpatialRole('left')">Left</button>
          <button class="chip-btn ${this.app.audioEngine.spatialRole === 'right' ? 'active' : ''}" style="flex:1;padding:3px 4px;font-size:0.68rem;" onclick="window.__ryncApp.uiManager.setSpatialRole('right')">Right</button>
          <button class="chip-btn ${this.app.audioEngine.spatialRole === 'center' ? 'active' : ''}" style="flex:1;padding:3px 4px;font-size:0.68rem;" onclick="window.__ryncApp.uiManager.setSpatialRole('center')">Center</button>
        </div>
      `;
      list.appendChild(div);
    });
  }

  setSpatialRole(role) {
    this.app.audioEngine.setSpatialChannel(role);
    [this.elements.spatialStereo, this.elements.spatialLeft, this.elements.spatialRight, this.elements.spatialCenter].forEach(btn => {
      if (btn) {
        if (btn.dataset.role === role) btn.classList.add('active');
        else btn.classList.remove('active');
      }
    });
    this.renderDevicesMatrix();
  }

  startPlaybackTicker() {
    setInterval(() => {
      const app = this.app;
      if (app.audioEngine && app.audioEngine.audioBuffer) {
        const cur = app.audioEngine.getCurrentPlaybackPosition();
        const dur = app.audioEngine.currentTrackDuration;
        if (this.elements.currentTimeText) this.elements.currentTimeText.innerText = this.formatTime(cur);

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
