import { LatencyTuner } from './LatencyTuner.js';
import { Metronome } from './Metronome.js';

export class AudioEngine {
  constructor(clockSync) {
    this.clockSync = clockSync;
    this.ctx = null;
    this.audioBuffer = null;
    this.currentSource = null;
    this.gainNode = null;
    this.analyserNode = null;
    this.isPlaying = false;
    this.currentTrackName = 'No track loaded';
    this.currentTrackDuration = 0;
    this.startAudioContextTime = 0;
    this.startOffsetSec = 0;
    this.pauseOffsetSec = 0;
    this.onPlaybackEnded = null;

    this.latencyTuner = new LatencyTuner();
    this.metronome = null;
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioContextClass({ latencyHint: 'interactive' });
      
      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = 1.0;

      this.analyserNode = this.ctx.createAnalyser();
      this.analyserNode.fftSize = 256;
      this.analyserNode.smoothingTimeConstant = 0.8;

      this.gainNode.connect(this.analyserNode);
      this.analyserNode.connect(this.ctx.destination);

      this.metronome = new Metronome(this.ctx);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  async decodeAudioDataSafe(arrayBuffer) {
    this.ensureContext();
    return new Promise((resolve, reject) => {
      // Clone buffer because decodeAudioData detaches the ArrayBuffer
      const bufferCopy = arrayBuffer.slice(0);
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
    this.ensureContext();
    try {
      this.audioBuffer = await this.decodeAudioDataSafe(arrayBuffer);
      this.currentTrackName = trackName;
      this.currentTrackDuration = this.audioBuffer.duration;
      this.pauseOffsetSec = 0;
      return this.audioBuffer;
    } catch (e) {
      console.error('Audio decode error:', e);
      throw e;
    }
  }

  async loadAudioFromUrl(url, trackName = 'Remote Track') {
    this.ensureContext();
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    return this.loadAudioFromArrayBuffer(arrayBuffer, trackName);
  }

  generateSyntheticTrack(type = 'synthwave') {
    this.ensureContext();
    const sampleRate = this.ctx.sampleRate;
    const duration = 20; // 20 seconds loop
    const numSamples = sampleRate * duration;
    const buffer = this.ctx.createBuffer(2, numSamples, sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    const bpm = 124;
    const beatSec = 60 / bpm;

    // Chords: Am7, Fmaj7, Cmaj7, G7
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

      // 2. Snare / Clap
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
    this.currentTrackName = 'Neon Groove Demo (Built-in)';
    this.currentTrackDuration = duration;
    this.pauseOffsetSec = 0;
    return this.audioBuffer;
  }

  schedulePlayAtServerTime(serverTargetTime, startOffsetSec = 0) {
    this.ensureContext();
    if (!this.audioBuffer) {
      console.warn('Cannot play: no audioBuffer loaded');
      return;
    }

    this.stopLocalPlayback();

    const clientEffectiveTimestamp = this.latencyTuner.calculateEffectiveStartTime(
      serverTargetTime,
      this.clockSync.getBestOffset()
    );

    const nowLocalMs = Date.now();
    const deltaMs = clientEffectiveTimestamp - nowLocalMs;
    const scheduledContextTime = this.ctx.currentTime + (deltaMs / 1000);

    this.currentSource = this.ctx.createBufferSource();
    this.currentSource.buffer = this.audioBuffer;
    this.currentSource.connect(this.gainNode);

    if (scheduledContextTime >= this.ctx.currentTime) {
      this.currentSource.start(scheduledContextTime, startOffsetSec);
    } else {
      const catchupOffset = Math.abs(deltaMs) / 1000 + startOffsetSec;
      if (catchupOffset < this.audioBuffer.duration) {
        this.currentSource.start(0, catchupOffset);
      }
    }

    this.isPlaying = true;
    this.startAudioContextTime = scheduledContextTime;
    this.startOffsetSec = startOffsetSec;

    this.currentSource.onended = () => {
      if (this.currentSource) {
        this.isPlaying = false;
        this.pauseOffsetSec = 0;
        if (this.onPlaybackEnded) {
          this.onPlaybackEnded();
        }
      }
    };
  }

  stopLocalPlayback() {
    if (this.currentSource) {
      try {
        this.currentSource.onended = null;
        this.currentSource.stop();
        this.currentSource.disconnect();
      } catch (e) {}
      this.currentSource = null;
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
