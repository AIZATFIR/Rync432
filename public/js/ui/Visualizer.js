export class Visualizer {
  constructor(canvasElement, audioEngine) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.audioEngine = audioEngine;
    this.animationId = null;
    this.freqData = new Uint8Array(128);
    this.idleTime = 0;

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * (window.devicePixelRatio || 1) || 600;
    this.canvas.height = rect.height * (window.devicePixelRatio || 1) || 140;
  }

  start() {
    if (this.animationId) return;
    this.render();
  }

  stop() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  render() {
    this.animationId = requestAnimationFrame(() => this.render());

    const width = this.canvas.width;
    const height = this.canvas.height;
    const ctx = this.ctx;

    ctx.clearRect(0, 0, width, height);

    const isPlaying = this.audioEngine && this.audioEngine.isPlaying;

    if (isPlaying) {
      this.audioEngine.getFrequencyData(this.freqData);
    } else {
      // Subtle rhythmic idle wave
      this.idleTime += 0.035;
      for (let i = 0; i < this.freqData.length; i++) {
        const wave = Math.sin(this.idleTime + i * 0.18) * 12 + 15;
        this.freqData[i] = Math.max(3, wave);
      }
    }

    // 1. Center subtle baseline
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    // 2. Spotify Green Frequency Spectrum Bars
    const barCount = 54;
    const barWidth = (width / barCount) * 0.65;
    const gap = (width / barCount) * 0.35;

    for (let i = 0; i < barCount; i++) {
      const dataIndex = Math.floor((i / barCount) * (this.freqData.length * 0.7));
      const value = this.freqData[dataIndex] || 0;
      const percent = value / 255;
      const barHeight = Math.max(3, percent * (height * 0.82));

      const x = i * (barWidth + gap) + gap / 2;
      const y = height - barHeight;

      // Spotify Green Gradient
      const gradient = ctx.createLinearGradient(0, y, 0, height);
      if (isPlaying) {
        gradient.addColorStop(0, '#1ed760');   // Spotify Green Top
        gradient.addColorStop(0.6, '#1db954'); // Spotify Mid Green
        gradient.addColorStop(1, '#181818');   // Charcoal Base
      } else {
        gradient.addColorStop(0, 'rgba(30, 215, 96, 0.35)');
        gradient.addColorStop(1, 'rgba(24, 24, 24, 0.1)');
      }

      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barHeight, [3, 3, 0, 0]);
      ctx.fill();

      // Top glowing dot
      if (isPlaying && percent > 0.35) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x, y - 2, barWidth, 2);
      }
    }

    // 3. Central Harmonic Phase Line
    ctx.strokeStyle = isPlaying ? 'rgba(30, 215, 96, 0.85)' : 'rgba(179, 179, 179, 0.2)';
    ctx.lineWidth = 2;
    ctx.beginPath();

    const sliceWidth = width / barCount;
    let waveX = 0;

    for (let i = 0; i < barCount; i++) {
      const val = this.freqData[i] / 255.0;
      const waveY = (height / 2) - (val * (height * 0.38) * Math.sin(i * 0.25));

      if (i === 0) {
        ctx.moveTo(waveX, waveY);
      } else {
        ctx.lineTo(waveX, waveY);
      }
      waveX += sliceWidth;
    }
    ctx.stroke();
  }
}
