import { LatencyTuner } from './LatencyTuner.js';
import { Metronome } from './Metronome.js';

export class AudioEngine {
  constructor(clockSync) {
    this.clockSync = clockSync;
    this.ctx = null;
    this.audioBuffer = null;
    this.currentSource = null;
    
    // DSP Mastering Nodes (Studio Quality Sound)
    this.bassFilter = null;
    this.warmthFilter = null;
    this.trebleFilter = null;
    this.compressorNode = null;
    
    this.pannerNode = null;
    this.gainNode = null;
    this.analyserNode = null;
    this.isPlaying = false;
    this.currentTrackName = 'No track loaded';
    this.currentTrackDuration = 0;
    this.startAudioContextTime = 0;
    this.startOffsetSec = 0;
    this.pauseOffsetSec = 0;
    this.onPlaybackEnded = null;
    this.spatialRole = 'stereo'; // 'stereo' | 'left' | 'right' | 'center'
    this.currentEqPreset = 'studio';
    this.pendingScheduledPlay = null;

    this.latencyTuner = new LatencyTuner();
    this.metronome = null;
  }

  async ensureContext() {
    if (!this.ctx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioContextClass({ latencyHint: 'interactive' });
      
      // 1. Studio Equalizer Filter Nodes
      this.bassFilter = this.ctx.createBiquadFilter();
      this.bassFilter.type = 'lowshelf';
      this.bassFilter.frequency.value = 100;

      this.warmthFilter = this.ctx.createBiquadFilter();
      this.warmthFilter.type = 'peaking';
      this.warmthFilter.frequency.value = 400;
      this.warmthFilter.Q.value = 1.0;

      this.trebleFilter = this.ctx.createBiquadFilter();
      this.trebleFilter.type = 'highshelf';
      this.trebleFilter.frequency.value = 10000;

      // 2. Studio Multi-Band Dynamics Compressor (Apple & Spotify RMS Punch)
      this.compressorNode = this.ctx.createDynamicsCompressor();
      this.compressorNode.threshold.value = -20;
      this.compressorNode.knee.value = 25;
      this.compressorNode.ratio.value = 3.5;
      this.compressorNode.attack.value = 0.003;
      this.compressorNode.release.value = 0.25;

      // Apply initial studio preset
      this.setEqPreset(this.currentEqPreset);

      // 3. Panner Node for Spatial Matrix
      if (this.ctx.createStereoPanner) {
        this.pannerNode = this.ctx.createStereoPanner();
      } else {
        this.pannerNode = this.ctx.createGain();
      }

      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = 1.0;

      this.analyserNode = this.ctx.createAnalyser();
      this.analyserNode.fftSize = 256;
      this.analyserNode.smoothingTimeConstant = 0.8;

      // 4. Master Brickwall Limiter to prevent Left/Right speaker distortion
      this.limiterNode = this.ctx.createDynamicsCompressor();
      this.limiterNode.threshold.value = -1.0;
      this.limiterNode.knee.value = 0.0;
      this.limiterNode.ratio.value = 20.0;
      this.limiterNode.attack.value = 0.001;
      this.limiterNode.release.value = 0.050;

      // Master Pipeline Routing:
      // Source -> bassFilter -> warmthFilter -> trebleFilter -> compressor -> panner -> gain -> analyser -> limiter -> destination
      this.bassFilter.connect(this.warmthFilter);
      this.warmthFilter.connect(this.trebleFilter);
      this.trebleFilter.connect(this.compressorNode);
      this.compressorNode.connect(this.pannerNode);
      this.pannerNode.connect(this.gainNode);
      this.gainNode.connect(this.analyserNode);
      this.analyserNode.connect(this.limiterNode);
      this.limiterNode.connect(this.ctx.destination);

      this.metronome = new Metronome(this.ctx);
    }

    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch (e) {}
    }
    return this.ctx;
  }

  setEqPreset(preset = 'studio') {
    this.currentEqPreset = preset;
    if (!this.ctx || !this.bassFilter) return;

    const t = this.ctx.currentTime;
    switch (preset) {
      case 'studio': // Apple Music / Spotify Mastered Sound
        this.bassFilter.gain.setValueAtTime(4.5, t);
        this.warmthFilter.gain.setValueAtTime(1.5, t);
        this.trebleFilter.gain.setValueAtTime(3.0, t);
        this.compressorNode.threshold.setValueAtTime(-20, t);
        this.compressorNode.ratio.setValueAtTime(3.5, t);
        break;

      case 'bassboost': // Deep Heavy Bass
        this.bassFilter.gain.setValueAtTime(8.5, t);
        this.warmthFilter.gain.setValueAtTime(2.0, t);
        this.trebleFilter.gain.setValueAtTime(1.5, t);
        this.compressorNode.threshold.setValueAtTime(-18, t);
        this.compressorNode.ratio.setValueAtTime(4.0, t);
        break;

      case 'vocal': // Crisp Vocals & Acoustic
        this.bassFilter.gain.setValueAtTime(1.0, t);
        this.warmthFilter.gain.setValueAtTime(4.0, t);
        this.trebleFilter.gain.setValueAtTime(4.5, t);
        this.compressorNode.threshold.setValueAtTime(-22, t);
        this.compressorNode.ratio.setValueAtTime(2.5, t);
        break;

      case 'flat': // Pure Raw Audio (Bypass)
      default:
        this.bassFilter.gain.setValueAtTime(0, t);
        this.warmthFilter.gain.setValueAtTime(0, t);
        this.trebleFilter.gain.setValueAtTime(0, t);
        this.compressorNode.threshold.setValueAtTime(0, t);
        this.compressorNode.ratio.setValueAtTime(1.0, t);
        break;
    }
  }

  setSpatialChannel(role = 'stereo') {
    this.spatialRole = role;
    if (!this.pannerNode || !this.ctx) return;

    const currentTime = this.ctx.currentTime;
    const spatialGain = 0.85;

    if (this.pannerNode.pan) {
      if (role === 'left') {
        this.pannerNode.pan.setValueAtTime(-1.0, currentTime);
        if (this.gainNode) this.gainNode.gain.setValueAtTime(spatialGain, currentTime);
      } else if (role === 'right') {
        this.pannerNode.pan.setValueAtTime(1.0, currentTime);
        if (this.gainNode) this.gainNode.gain.setValueAtTime(spatialGain, currentTime);
      } else if (role === 'center') {
        this.pannerNode.pan.setValueAtTime(0.0, currentTime);
        if (this.gainNode) this.gainNode.gain.setValueAtTime(1.0, currentTime);
      } else {
        this.pannerNode.pan.setValueAtTime(0.0, currentTime);
        if (this.gainNode) this.gainNode.gain.setValueAtTime(1.0, currentTime);
      }
    }
  }

  async decodeAudioDataSafe(arrayBuffer) {
    if (!arrayBuffer) throw new Error('Buffer audio kosong');
    if (arrayBuffer instanceof AudioBuffer) {
      return arrayBuffer;
    }
    await this.ensureContext();
    return new Promise((resolve, reject) => {
      let bufferCopy;
      if (arrayBuffer instanceof ArrayBuffer) {
        bufferCopy = arrayBuffer.slice(0);
      } else if (ArrayBuffer.isView(arrayBuffer)) {
        bufferCopy = arrayBuffer.buffer.slice(arrayBuffer.byteOffset, arrayBuffer.byteOffset + arrayBuffer.byteLength);
      } else {
        bufferCopy = arrayBuffer;
      }
      let isResolved = false;

      const promise = this.ctx.decodeAudioData(
        bufferCopy,
        (decoded) => {
          if (!isResolved) {
            isResolved = true;
            resolve(decoded);
          }
        },
        (err) => {
          if (!isResolved) {
            isResolved = true;
            reject(err || new Error('Format audio tidak dapat didecode oleh browser'));
          }
        }
      );

      if (promise && typeof promise.then === 'function') {
        promise.then((decoded) => {
          if (!isResolved) {
            isResolved = true;
            resolve(decoded);
          }
        }).catch((err) => {
          if (!isResolved) {
            isResolved = true;
            reject(err);
          }
        });
      }
    });
  }

  async loadAudioFromArrayBuffer(arrayBuffer, trackName = 'Uploaded Track') {
    await this.ensureContext();
    try {
      this.stopLocalPlayback();
      if (arrayBuffer instanceof AudioBuffer) {
        this.audioBuffer = arrayBuffer;
      } else {
        this.audioBuffer = await this.decodeAudioDataSafe(arrayBuffer);
      }
      this.currentTrackName = trackName;
      this.currentTrackDuration = this.audioBuffer.duration;
      this.currentServerTargetTime = null;
      this.pauseOffsetSec = 0;

      if (this.pendingScheduledPlay) {
        const { serverTargetTime, startOffsetSec } = this.pendingScheduledPlay;
        this.pendingScheduledPlay = null;
        this.schedulePlayAtServerTime(serverTargetTime, startOffsetSec);
      }

      return this.audioBuffer;
    } catch (e) {
      console.error('Audio decode error:', e);
      throw e;
    }
  }

  async loadAudioFromUrl(url, trackName = 'Remote Track') {
    await this.ensureContext();
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return this.loadAudioFromArrayBuffer(arrayBuffer, trackName);
  }

  generateSyntheticTrack(type = 'synthwave') {
    this.ensureContext();
    const sampleRate = this.ctx.sampleRate || 44100;
    const duration = 20; // 20 seconds loop
    const numSamples = sampleRate * duration;
    const buffer = this.ctx.createBuffer(2, numSamples, sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    const bpm = 124;
    const beatSec = 60 / bpm;

    const chords = [
      [220, 261.63, 329.63, 392.00],
      [174.61, 220, 261.63, 329.63],
      [261.63, 329.63, 392.00, 493.88],
      [196.00, 246.94, 293.66, 349.23]
    ];

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const bar = Math.floor(t / (beatSec * 4)) % chords.length;
      const chord = chords[bar];
      const beatInBar = (t % (beatSec * 4)) / beatSec;

      // 1. Kick Drum
      const kickPhase = (t % beatSec) / beatSec;
      const kickFreq = 140 * Math.exp(-kickPhase * 18) + 38;
      const kickEnv = Math.exp(-kickPhase * 8);
      const kick = Math.sin(2 * Math.PI * kickFreq * t) * kickEnv * 0.45;

      // 2. Snare
      let snare = 0;
      if (beatInBar >= 1 && beatInBar < 2) {
        const snarePhase = (beatInBar - 1);
        snare = (Math.random() * 2 - 1) * Math.exp(-snarePhase * 12) * 0.25;
      } else if (beatInBar >= 3 && beatInBar < 4) {
        const snarePhase = (beatInBar - 3);
        snare = (Math.random() * 2 - 1) * Math.exp(-snarePhase * 12) * 0.25;
      }

      // 3. Hi-hat
      const sixteenth = (t % (beatSec / 4)) / (beatSec / 4);
      const hihat = (Math.random() * 2 - 1) * Math.exp(-sixteenth * 30) * 0.08;

      // 4. Synth Chord Pad
      let pad = 0;
      for (let c = 0; c < chord.length; c++) {
        const freq = chord[c];
        pad += Math.sin(2 * Math.PI * freq * t) * 0.04;
        pad += Math.sin(2 * Math.PI * (freq * 1.005) * t) * 0.03;
      }

      // 5. Arpeggio Synth
      const arpNoteIndex = Math.floor(t / (beatSec / 4)) % chord.length;
      const arpFreq = chord[arpNoteIndex] * 2;
      const arpEnv = Math.exp(-((t % (beatSec / 4)) / (beatSec / 4)) * 6);
      const arp = Math.sin(2 * Math.PI * arpFreq * t) * arpEnv * 0.12;

      left[i] = Math.max(-1, Math.min(1, kick + snare + hihat * 0.8 + pad * 1.1 + arp * 0.8));
      right[i] = Math.max(-1, Math.min(1, kick + snare + hihat * 1.2 + pad * 0.9 + arp * 1.2));
    }

    this.audioBuffer = buffer;
    this.currentTrackName = 'Neon Groove Synthwave';
    this.currentTrackDuration = duration;
    this.pauseOffsetSec = 0;
    return this.audioBuffer;
  }

  schedulePlayAtServerTime(serverTargetTime, startOffsetSec = 0) {
    this.ensureContext();
    if (this.ctx && this.ctx.state === 'suspended') {
      try { this.ctx.resume(); } catch (e) {}
    }

    if (!this.audioBuffer) {
      console.warn('Playback queued: audioBuffer still loading...');
      this.pendingScheduledPlay = { serverTargetTime, startOffsetSec };
      return;
    }

    // Prevent redundant playback restarts and audio stutter if already playing
    if (this.isPlaying && this.currentServerTargetTime === serverTargetTime && this.audioBuffer) {
      return;
    }
    this.currentServerTargetTime = serverTargetTime;

    this.stopLocalPlayback();

    const bestOffset = this.clockSync ? this.clockSync.getBestOffset() : 0;
    const clientEffectiveTimestamp = this.latencyTuner.calculateEffectiveStartTime(
      serverTargetTime || Date.now(),
      bestOffset
    );

    const nowLocalMs = Date.now();
    const deltaMs = clientEffectiveTimestamp - nowLocalMs;
    const scheduledContextTime = this.ctx.currentTime + (deltaMs / 1000);

    this.currentSource = this.ctx.createBufferSource();
    this.currentSource.buffer = this.audioBuffer;

    // Connect source to DSP chain entrance (bassFilter)
    this.currentSource.connect(this.bassFilter || this.pannerNode || this.gainNode);

    if (scheduledContextTime > this.ctx.currentTime) {
      this.currentSource.start(scheduledContextTime, startOffsetSec);
      this.startAudioContextTime = scheduledContextTime;
    } else {
      const catchupOffset = Math.abs(deltaMs) / 1000 + startOffsetSec;
      if (catchupOffset < this.audioBuffer.duration) {
        this.currentSource.start(0, catchupOffset);
        this.startAudioContextTime = this.ctx.currentTime - (Math.abs(deltaMs) / 1000);
      } else {
        this.currentSource.start(0, startOffsetSec);
        this.startAudioContextTime = this.ctx.currentTime;
      }
    }

    const activeSource = this.currentSource;
    activeSource.onended = () => {
      if (this.currentSource === activeSource) {
        this.isPlaying = false;
        const pos = this.getCurrentPlaybackPosition();
        const isTrackFullyFinished = this.currentTrackDuration > 2 && pos >= (this.currentTrackDuration - 1.5);
        
        if (isTrackFullyFinished) {
          this.pauseOffsetSec = 0;
          this.currentServerTargetTime = null;
          if (this.onPlaybackEnded) {
            this.onPlaybackEnded();
          }
        }
      }
    };
  }

  stopLocalPlayback() {
    if (this.currentSource) {
      try {
        const src = this.currentSource;
        this.currentSource = null;
        src.onended = null;
        src.stop();
        src.disconnect();
      } catch (e) {}
    }
    this.isPlaying = false;
  }

  getCurrentPlaybackPosition() {
    if (!this.isPlaying || !this.ctx) return this.pauseOffsetSec;
    const elapsed = this.ctx.currentTime - this.startAudioContextTime;
    if (elapsed < 0) return this.startOffsetSec;
    return Math.min(this.currentTrackDuration, Math.max(0, elapsed + this.startOffsetSec));
  }

  setVolume(vol) {
    if (this.gainNode && this.ctx) {
      this.gainNode.gain.setValueAtTime(Math.max(0, Math.min(1, vol)), this.ctx.currentTime);
    }
  }

  getFrequencyData(array) {
    if (this.analyserNode) {
      this.analyserNode.getByteFrequencyData(array);
    }
  }

  getTimeDomainData(array) {
    if (this.analyserNode) {
      this.analyserNode.getByteTimeDomainData(array);
    }
  }
}
