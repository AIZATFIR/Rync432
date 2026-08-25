// 2-Beat Audio Keep-Alive & DAC Heartbeat (LDAP / Mobile Sleep Prevention)
// Continuously feeds a sub-audible keep-alive signal through Web Audio API
// so mobile phone DACs (iOS Safari / Android) do NOT sleep or drop the first audio frames.

export class Metronome {
  constructor(audioContext) {
    this.ctx = audioContext;
    this.isRunning = false;
    this.timerId = null;
    this.bpm = 100;
    this.beatCount = 0;
    this.gainNode = null;
    this.volume = 0.15;
    this.highFreq = 880;
    this.lowFreq = 440;

    // Inaudible DAC Keep-Alive (Sub-audible DAC anti-sleep pipeline)
    this.keepAliveNode = null;
    this.keepAliveGain = null;
    this.isKeepAliveActive = false;
  }

  setContext(audioContext) {
    this.ctx = audioContext;
    this.gainNode = null;
    this.keepAliveNode = null;
    this.keepAliveGain = null;
    this.startInaudibleKeepAlive();
  }

  init() {
    if (!this.gainNode && this.ctx) {
      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = this.volume;
      this.gainNode.connect(this.ctx.destination);
    }
  }

  // Silent 2-beat / 20kHz DAC keep-alive running constantly in background
  startInaudibleKeepAlive() {
    if (!this.ctx || this.isKeepAliveActive) return;
    try {
      if (this.ctx.createBuffer) {
        // Create 2-second silent continuous loop with microscopic sub-audible DC offset (0.00002)
        const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
          // Microscopic 20kHz sine wave (inaudible to humans, keeps DAC clocks active)
          data[i] = Math.sin(2 * Math.PI * 20000 * (i / this.ctx.sampleRate)) * 0.00003;
        }

        this.keepAliveNode = this.ctx.createBufferSource();
        this.keepAliveNode.buffer = buffer;
        this.keepAliveNode.loop = true;

        this.keepAliveGain = this.ctx.createGain();
        this.keepAliveGain.gain.value = 1.0;

        this.keepAliveNode.connect(this.keepAliveGain);
        this.keepAliveGain.connect(this.ctx.destination);

        this.keepAliveNode.start();
        this.isKeepAliveActive = true;
      }
    } catch (e) {
      console.warn('DAC Keep-alive notice:', e.message);
    }
  }

  stopInaudibleKeepAlive() {
    if (this.keepAliveNode) {
      try {
        this.keepAliveNode.stop();
        this.keepAliveNode.disconnect();
      } catch (e) {}
      this.keepAliveNode = null;
    }
    this.isKeepAliveActive = false;
  }

  setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, vol));
    if (this.gainNode && this.ctx) {
      this.gainNode.gain.setValueAtTime(this.volume, this.ctx.currentTime);
    }
  }

  // Audible Metronome Toggle
  start() {
    if (this.isRunning || !this.ctx) return;
    this.init();
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    this.isRunning = true;
    this.beatCount = 0;
    this.scheduleNextBeat();
  }

  stop() {
    this.isRunning = false;
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  toggle() {
    if (this.isRunning) this.stop();
    else this.start();
    return this.isRunning;
  }

  playTone(freq, time, duration = 0.04) {
    if (!this.ctx || !this.gainNode) return;
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, time);

      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(0.3, time + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

      osc.connect(gain);
      gain.connect(this.gainNode);

      osc.start(time);
      osc.stop(time + duration);
    } catch (e) {}
  }

  scheduleNextBeat() {
    if (!this.isRunning || !this.ctx) return;

    const interval = 60 / this.bpm;
    const now = this.ctx.currentTime;
    const isHigh = this.beatCount % 2 === 0;
    const freq = isHigh ? this.highFreq : this.lowFreq;

    this.playTone(freq, now + 0.02, 0.04);
    this.beatCount++;

    this.timerId = setTimeout(() => {
      this.scheduleNextBeat();
    }, interval * 1000);
  }
}
