import { firebaseAuth } from '../auth/FirebaseAuth.js';

export class UIManager {
  constructor(app) {
    this.app = app;
    this.elements = {};
    this.currentUser = null;
  }

  init() {
    // Cache DOM Elements
    this.elements = {
      connectionStatus: document.getElementById('connectionStatus'),
      connectionDot: document.getElementById('connectionDot'),
      roomHeroSection: document.getElementById('roomHeroSection'),
      activeRoomSection: document.getElementById('activeRoomSection'),
      roomCodeDisplay: document.getElementById('roomCodeDisplay'),
      userRoleBadge: document.getElementById('userRoleBadge'),
      hostControlsSection: document.getElementById('hostControlsSection'),
      clientNotice: document.getElementById('clientNotice'),
      
      // Auth & Profile
      userAuthBtn: document.getElementById('userAuthBtn'),
      userNameLabel: document.getElementById('userNameLabel'),
      userAvatarContainer: document.getElementById('userAvatarContainer'),
      authModal: document.getElementById('authModal'),
      modalCloseBtn: document.getElementById('modalCloseBtn'),
      googleSignInActionBtn: document.getElementById('googleSignInActionBtn'),
      guestModeBtn: document.getElementById('guestModeBtn'),
      toggleFirebaseConfigBtn: document.getElementById('toggleFirebaseConfigBtn'),
      firebaseConfigForm: document.getElementById('firebaseConfigForm'),
      fbApiKeyInput: document.getElementById('fbApiKeyInput'),
      fbAuthDomainInput: document.getElementById('fbAuthDomainInput'),
      fbProjectIdInput: document.getElementById('fbProjectIdInput'),
      saveFirebaseConfigBtn: document.getElementById('saveFirebaseConfigBtn'),
      authLoggedOutView: document.getElementById('authLoggedOutView'),
      authLoggedInView: document.getElementById('authLoggedInView'),
      userModalAvatar: document.getElementById('userModalAvatar'),
      userModalName: document.getElementById('userModalName'),
      userModalEmail: document.getElementById('userModalEmail'),
      signOutBtn: document.getElementById('signOutBtn'),

      // Inputs & Buttons
      createRoomBtn: document.getElementById('createRoomBtn'),
      joinRoomBtn: document.getElementById('joinRoomBtn'),
      roomCodeInput: document.getElementById('roomCodeInput'),
      leaveRoomBtn: document.getElementById('leaveRoomBtn'),
      copyRoomLinkBtn: document.getElementById('copyRoomLinkBtn'),
      
      // Player
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
      
      // Upload & Demo
      dropzone: document.getElementById('audioDropzone'),
      audioFileInput: document.getElementById('audioFileInput'),
      demoSynthBtn: document.getElementById('demoSynthBtn'),

      // Feature 1: Metronome
      metronomeToggle: document.getElementById('metronomeToggle'),

      // Feature 2: Latency Tuner
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
      presetAirplay: document.getElementById('presetAirplay'),

      // Mesh Device List
      devicesList: document.getElementById('devicesList'),
      deviceCountBadge: document.getElementById('deviceCountBadge')
    };

    this.initFirebaseAuthListener();
    this.bindEvents();
    this.startPlaybackTicker();
  }

  initFirebaseAuthListener() {
    // Listen to real Firebase Auth State
    firebaseAuth.onAuthStateChanged((user) => {
      this.currentUser = user;
      this.renderUserState();
    });

    // Populate saved config if exists
    const config = firebaseAuth.getStoredConfig();
    if (config && this.elements.fbApiKeyInput) {
      this.elements.fbApiKeyInput.value = config.apiKey || '';
      this.elements.fbAuthDomainInput.value = config.authDomain || '';
      this.elements.fbProjectIdInput.value = config.projectId || '';
    }
  }

  bindEvents() {
    const { elements, app } = this;

    // 1. Firebase Auth Modal
    elements.userAuthBtn.addEventListener('click', () => {
      elements.authModal.classList.add('active');
    });

    elements.modalCloseBtn.addEventListener('click', () => {
      elements.authModal.classList.remove('active');
    });

    elements.authModal.addEventListener('click', (e) => {
      if (e.target === elements.authModal) {
        elements.authModal.classList.remove('active');
      }
    });

    // Toggle Firebase Project Setup Inputs
    if (elements.toggleFirebaseConfigBtn) {
      elements.toggleFirebaseConfigBtn.addEventListener('click', () => {
        const isHidden = elements.firebaseConfigForm.style.display === 'none';
        elements.firebaseConfigForm.style.display = isHidden ? 'flex' : 'none';
      });
    }

    if (elements.saveFirebaseConfigBtn) {
      elements.saveFirebaseConfigBtn.addEventListener('click', () => {
        const apiKey = elements.fbApiKeyInput.value.trim();
        const authDomain = elements.fbAuthDomainInput.value.trim();
        const projectId = elements.fbProjectIdInput.value.trim();
        
        if (!apiKey || !authDomain || !projectId) {
          alert('Mohon isi apiKey, authDomain, dan projectId Firebase.');
          return;
        }

        firebaseAuth.saveConfig({
          apiKey,
          authDomain,
          projectId,
          storageBucket: `${projectId}.appspot.com`,
          appId: `1:custom:web:${projectId}`
        });

        alert('Konfigurasi Firebase berhasil disimpan! Anda sekarang dapat Sign in dengan Google.');
        elements.firebaseConfigForm.style.display = 'none';
      });
    }

    // Real Firebase Google Sign-In Action
    elements.googleSignInActionBtn.addEventListener('click', async () => {
      try {
        const user = await firebaseAuth.signInWithGoogle();
        this.currentUser = user;
        this.renderUserState();
        elements.authModal.classList.remove('active');
      } catch (err) {
        if (err.message === 'CONFIG_REQUIRED') {
          alert('Silakan masukkan Firebase Web App Config proyek Anda terlebih dahulu melalui menu "Atur Firebase Project Key".');
          elements.firebaseConfigForm.style.display = 'flex';
        } else {
          alert('Google Auth Notice: ' + err.message);
        }
      }
    });

    elements.guestModeBtn.addEventListener('click', () => {
      elements.authModal.classList.remove('active');
    });

    elements.signOutBtn.addEventListener('click', async () => {
      await firebaseAuth.signOut();
      this.currentUser = null;
      this.renderUserState();
      elements.authModal.classList.remove('active');
    });

    // 2. Room Actions
    elements.createRoomBtn.addEventListener('click', () => {
      app.audioEngine.ensureContext();
      app.socketClient.createRoom(this.getDeviceName());
    });

    elements.joinRoomBtn.addEventListener('click', () => {
      const code = elements.roomCodeInput.value.trim().toUpperCase();
      if (code.length === 4) {
        app.audioEngine.ensureContext();
        app.socketClient.joinRoom(code, this.getDeviceName());
      } else {
        alert('Masukkan 4 digit Room Code yang valid');
      }
    });

    elements.roomCodeInput.addEventListener('keyup', (e) => {
      if (e.key === 'Enter') elements.joinRoomBtn.click();
    });

    elements.leaveRoomBtn.addEventListener('click', () => {
      window.location.reload();
    });

    elements.copyRoomLinkBtn.addEventListener('click', () => {
      const url = `${window.location.origin}/?room=${app.socketClient.roomId}`;
      navigator.clipboard.writeText(url).then(() => {
        const originalText = elements.copyRoomLinkBtn.innerText;
        elements.copyRoomLinkBtn.innerText = 'Copied!';
        setTimeout(() => elements.copyRoomLinkBtn.innerText = originalText, 1500);
      });
    });

    // 3. Playback Controls
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

    // Progress Bar Scrubbing
    elements.progressBar.addEventListener('click', (e) => {
      if (!app.socketClient.isHost || !app.audioEngine.audioBuffer) return;
      const rect = elements.progressBar.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const pct = Math.max(0, Math.min(1, clickX / rect.width));
      const targetSec = pct * app.audioEngine.currentTrackDuration;
      app.socketClient.schedulePlay(400, targetSec);
    });

    // Volume Slider
    elements.volumeSlider.addEventListener('input', (e) => {
      const vol = parseFloat(e.target.value);
      app.audioEngine.setVolume(vol);
    });

    // Audio Upload & Dropzone
    elements.dropzone.addEventListener('click', () => elements.audioFileInput.click());
    
    elements.dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      elements.dropzone.classList.add('dragover');
    });

    elements.dropzone.addEventListener('dragleave', () => {
      elements.dropzone.classList.remove('dragover');
    });

    elements.dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      elements.dropzone.classList.remove('dragover');
      const files = e.dataTransfer.files;
      if (files.length > 0) this.handleAudioFile(files[0]);
    });

    elements.audioFileInput.addEventListener('change', (e) => {
      const files = e.target.files;
      if (files.length > 0) this.handleAudioFile(files[0]);
    });

    // Preset Synthetic Demo
    elements.demoSynthBtn.addEventListener('click', async () => {
      app.audioEngine.ensureContext();
      this.setTrackLoading('Generating Neon Groove Synthwave...');
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
        alert('Error creating synth audio: ' + err.message);
      }
    });

    // Feature 1: Keep-Alive Metronome
    elements.metronomeToggle.addEventListener('change', (e) => {
      app.audioEngine.ensureContext();
      if (e.target.checked) {
        app.audioEngine.metronome.start();
      } else {
        app.audioEngine.metronome.stop();
      }
    });

    // Feature 2: Precision Latency Tuner (+ / - step buttons)
    if (elements.stepMinus1) {
      elements.stepMinus1.addEventListener('click', () => this.nudgeLatency(-1));
    }
    if (elements.stepPlus1) {
      elements.stepPlus1.addEventListener('click', () => this.nudgeLatency(1));
    }

    elements.latencySlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      this.updateLatencyOffset(val);
    });

    elements.nudgeMinus10.addEventListener('click', () => this.nudgeLatency(-10));
    elements.nudgeMinus2.addEventListener('click', () => this.nudgeLatency(-2));
    elements.nudgePlus2.addEventListener('click', () => this.nudgeLatency(2));
    elements.nudgePlus10.addEventListener('click', () => this.nudgeLatency(10));

    elements.presetWired.addEventListener('click', () => this.applyPreset('wired', 0));
    elements.presetInternal.addEventListener('click', () => this.applyPreset('internal', 15));
    elements.presetBt.addEventListener('click', () => this.applyPreset('bt', 120));
    elements.presetAirplay.addEventListener('click', () => this.applyPreset('airplay', 250));
  }

  renderUserState() {
    const { elements, currentUser } = this;
    if (currentUser) {
      elements.userNameLabel.innerText = currentUser.name ? currentUser.name.split(' ')[0] : 'User';
      if (currentUser.avatar) {
        elements.userAvatarContainer.innerHTML = `<img src="${currentUser.avatar}" alt="Avatar" style="width:100%;height:100%;object-fit:cover;">`;
      } else {
        elements.userAvatarContainer.innerHTML = `<span style="font-weight:700;color:var(--spotify-green);">${currentUser.name ? currentUser.name.charAt(0) : 'U'}</span>`;
      }
      
      elements.authLoggedOutView.style.display = 'none';
      elements.authLoggedInView.style.display = 'flex';
      elements.userModalAvatar.src = currentUser.avatar || 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><circle cx=%2250%22 cy=%2250%22 r=%2245%22 fill=%22%231ed760%22/></svg>';
      elements.userModalName.innerText = currentUser.name || 'Firebase Google User';
      elements.userModalEmail.innerText = currentUser.email || '';
    } else {
      elements.userNameLabel.innerText = 'Sign in';
      elements.userAvatarContainer.innerHTML = `
        <svg class="google-g-icon" viewBox="0 0 24 24">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
        </svg>`;
      
      elements.authLoggedOutView.style.display = 'flex';
      elements.authLoggedInView.style.display = 'none';
    }
  }

  getDeviceName() {
    if (this.currentUser && this.currentUser.name) {
      return `${this.currentUser.name} Speaker`;
    }
    const ua = navigator.userAgent;
    let name = 'Rync Speaker';
    if (/iPhone|iPad/i.test(ua)) name = 'iOS Speaker';
    else if (/Android/i.test(ua)) name = 'Android Speaker';
    else if (/Macintosh/i.test(ua)) name = 'Mac Speaker';
    else if (/Windows/i.test(ua)) name = 'Windows Speaker';
    else if (/Linux/i.test(ua)) name = 'Linux Speaker';
    return `${name} (${Math.floor(Math.random() * 899 + 100)})`;
  }

  async handleAudioFile(file) {
    const app = this.app;
    app.audioEngine.ensureContext();
    this.setTrackLoading(`Decoding ${file.name}...`);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const audioBuffer = await app.audioEngine.loadAudioFromArrayBuffer(arrayBuffer, file.name);
      this.updateTrackUI(file.name, audioBuffer.duration);

      if (app.socketClient.isHost) {
        app.socketClient.sendTrackMetadata({
          name: file.name,
          duration: audioBuffer.duration
        });
        app.socketClient.sendBinary(arrayBuffer);
      }
    } catch (err) {
      console.error(err);
      alert('Gagal mendecode file audio. Format yang didukung: MP3, WAV, FLAC, AAC, OGG.');
      this.setTrackLoading('No track loaded');
    }
  }

  setTrackLoading(msg) {
    this.elements.trackTitle.innerText = msg;
    this.elements.trackSub.innerText = 'Sinkronisasi buffer ke seluruh speaker...';
  }

  updateTrackUI(title, duration) {
    this.elements.trackTitle.innerText = title;
    this.elements.trackSub.innerText = `${this.formatTime(duration)} • Sample-accurate Ready`;
    this.elements.totalTimeText.innerText = this.formatTime(duration);
  }

  updateLatencyOffset(offsetMs) {
    this.app.audioEngine.latencyTuner.setManualOffset(offsetMs);
    this.elements.latencySlider.value = offsetMs;
    const sign = offsetMs > 0 ? '+' : '';
    this.elements.latencyDisplay.innerText = `${sign}${offsetMs} ms`;

    this.app.socketClient.updateLatencyOffset(offsetMs);
  }

  nudgeLatency(delta) {
    const current = parseInt(this.elements.latencySlider.value, 10) || 0;
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
      this.elements.connectionStatus.innerText = 'Connected';
      this.elements.connectionDot.classList.add('connected');
    } else {
      this.elements.connectionStatus.innerText = 'Connecting...';
      this.elements.connectionDot.classList.remove('connected');
    }
  }

  setRoomState(roomId, isHost) {
    this.elements.roomHeroSection.style.display = 'none';
    this.elements.activeRoomSection.style.display = 'block';
    this.elements.roomCodeDisplay.innerText = roomId;

    if (isHost) {
      this.elements.userRoleBadge.className = 'role-pill host';
      this.elements.userRoleBadge.innerText = 'ROOM MASTER (HOST)';
      this.elements.hostControlsSection.style.display = 'flex';
      this.elements.clientNotice.style.display = 'none';
    } else {
      this.elements.userRoleBadge.className = 'role-pill peer';
      this.elements.userRoleBadge.innerText = 'SATELLITE SPEAKER';
      this.elements.hostControlsSection.style.display = 'none';
      this.elements.clientNotice.style.display = 'block';
    }
  }

  setPlayState(isPlaying) {
    if (isPlaying) {
      this.elements.playIcon.style.display = 'none';
      this.elements.pauseIcon.style.display = 'block';
      this.elements.playBtn.classList.add('pulse-anim');
    } else {
      this.elements.playIcon.style.display = 'block';
      this.elements.pauseIcon.style.display = 'none';
      this.elements.playBtn.classList.remove('pulse-anim');
    }
  }

  renderPeerList(peers = []) {
    const list = this.elements.devicesList;
    list.innerHTML = '';
    this.elements.deviceCountBadge.innerText = `${peers.length} Active`;

    peers.forEach(peer => {
      const isSelf = peer.id === this.app.socketClient.peerId;
      const div = document.createElement('div');
      div.className = 'device-item';

      const offsetStr = peer.latencyOffset !== undefined ? `${peer.latencyOffset > 0 ? '+' : ''}${peer.latencyOffset}ms` : '0ms';
      const rttStr = peer.rtt ? `${peer.rtt}ms ping` : '<5ms sync';

      div.innerHTML = `
        <div class="device-name-group">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--spotify-green)" stroke-width="2">
            ${peer.isHost ? '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>' : '<rect width="16" height="20" x="4" y="2" rx="2"/><circle cx="12" cy="14" r="4"/><line x1="12" x2="12.01" y1="6" y2="6"/>'}
          </svg>
          <div>
            <div class="device-name">${peer.deviceName || 'Speaker'} ${isSelf ? '<span style="color:var(--spotify-green);font-size:0.75rem;">(You)</span>' : ''}</div>
            <div class="device-latency-tag">Offset: ${offsetStr} • ${peer.isHost ? 'Master' : 'Satellite'}</div>
          </div>
        </div>
        <span class="ping-badge">${rttStr}</span>
      `;
      list.appendChild(div);
    });
  }

  startPlaybackTicker() {
    setInterval(() => {
      const app = this.app;
      if (app.audioEngine && app.audioEngine.audioBuffer) {
        const cur = app.audioEngine.getCurrentPlaybackPosition();
        const dur = app.audioEngine.currentTrackDuration;
        this.elements.currentTimeText.innerText = this.formatTime(cur);

        if (dur > 0) {
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
