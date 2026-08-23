export class Metronome {
  constructor(audioContext) {
    this.ctx = audioContext;
    this.isRunning = false;
    this.timerId = null;
    this.bpm = 100;
    this.beatCount = 0;
    this.gainNode = null;
    this.volume = 0.2; // subtle pleasant level
    this.highFreq = 880; // High tone (A5)
    this.lowFreq = 440;  // Low tone (A4)
  }

  setContext(audioContext) {
    this.ctx = audioContext;
    this.gainNode = null;
  }

  init() {
    if (!this.gainNode && this.ctx) {
      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = this.volume;
      this.gainNode.connect(this.ctx.destination);
    }
  }

  setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, vol));
    if (this.gainNode && this.ctx) {
      this.gainNode.gain.setValueAtTime(this.volume, this.ctx.currentTime);
    }
  }

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

  playTone(freq, time, duration = 0.05) {
    if (!this.ctx || !this.gainNode) return;
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, time);

      // Clean, pleasant percussive click envelope
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(0.4, time + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

      osc.connect(gain);
      gain.connect(this.gainNode);

      osc.start(time);
      osc.stop(time + duration);
    } catch (e) {
      console.error('Metronome tone error:', e);
    }
  }

  scheduleNextBeat() {
    if (!this.isRunning || !this.ctx) return;

    const interval = 60 / this.bpm;
    const now = this.ctx.currentTime;
    const isHigh = this.beatCount % 2 === 0;
    const freq = isHigh ? this.highFreq : this.lowFreq;

    this.playTone(freq, now + 0.02, 0.05);
    this.beatCount++;

    this.timerId = setTimeout(() => {
      this.scheduleNextBeat();
    }, interval * 1000);
  }
}
