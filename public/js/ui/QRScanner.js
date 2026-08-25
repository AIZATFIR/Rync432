/**
 * Lightweight Zero-Dependency Camera QR Scanner for Rync432
 * Uses native Web BarcodeDetector with video stream.
 */
export class QRScanner {
  constructor(videoElement, onCodeDetected) {
    this.video = videoElement;
    this.onCodeDetected = onCodeDetected;
    this.stream = null;
    this.scanning = false;
    this.detector = null;
    if ('BarcodeDetector' in window) {
      try {
        this.detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch (e) {}
    }
  }

  async start() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false
      });
      this.video.srcObject = this.stream;
      await this.video.play();
      this.scanning = true;
      this.scanLoop();
      return true;
    } catch (err) {
      console.warn('Camera access error:', err.message);
      throw new Error('Izin kamera ditolak atau tidak didukung.');
    }
  }

  async scanLoop() {
    if (!this.scanning) return;

    if (this.detector && this.video.readyState >= 2) {
      try {
        const barcodes = await this.detector.detect(this.video);
        if (barcodes.length > 0) {
          const rawValue = barcodes[0].rawValue || '';
          this.handleScannedText(rawValue);
          return;
        }
      } catch (e) {}
    }

    if (this.scanning) {
      requestAnimationFrame(() => this.scanLoop());
    }
  }

  handleScannedText(text) {
    let roomCode = '';
    // Check for ?room=XXXX in URL
    const match = text.match(/[?&]room=([a-zA-Z0-9]{4})/i);
    if (match) {
      roomCode = match[1].toUpperCase();
    } else if (text.trim().length === 4) {
      roomCode = text.trim().toUpperCase();
    }

    if (roomCode) {
      this.stop();
      this.onCodeDetected(roomCode);
    } else if (this.scanning) {
      requestAnimationFrame(() => this.scanLoop());
    }
  }

  stop() {
    this.scanning = false;
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
    }
  }
}
