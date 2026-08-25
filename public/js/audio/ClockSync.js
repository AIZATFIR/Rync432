export class ClockSync {
  constructor(socketSender = null) {
    this.socketSender = socketSender;
    this.samples = [];
    this.maxSamples = 12;
    this.offset = 0;
    this.rtt = 0;
    this.isSynced = false;
    this.syncInterval = null;
    this.useHttpFallback = false;
  }

  calculateSample({ t0, t1, t2, t3 }) {
    const rtt = (t3 - t0) - (t2 - t1);
    const offset = ((t1 - t0) + (t2 - t3)) / 2;
    return { rtt: Math.max(0, rtt), offset };
  }

  addSample(sample) {
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
    this.updateComputedOffset();
  }

  updateComputedOffset() {
    if (this.samples.length === 0) return;

    // Sort by RTT ascending (lowest jitter is most accurate)
    const sorted = [...this.samples].sort((a, b) => a.rtt - b.rtt);
    // Take the best 50% lowest-latency samples
    const bestHalf = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2)));
    
    // Compute average offset of the lowest RTT samples
    const sumOffset = bestHalf.reduce((acc, s) => acc + s.offset, 0);
    this.offset = sumOffset / bestHalf.length;
    this.rtt = bestHalf[0].rtt;
    this.isSynced = this.samples.length >= 3;
  }

  getBestOffset() {
    this.updateComputedOffset();
    return this.offset;
  }

  ping() {
    if (this.useHttpFallback || !this.socketSender) {
      this.pingHttp();
      return;
    }
    const clientTimestamp = Date.now();
    this.socketSender('SYNC_PING', { clientTimestamp });
  }

  async pingHttp() {
    const t0 = Date.now();
    try {
      const res = await fetch(`/api/health?t0=${t0}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const t3 = Date.now();
      const t1 = data.t1 || data.timestamp || t3;
      const t2 = data.t2 || data.timestamp || t3;

      const sample = this.calculateSample({ t0, t1, t2, t3 });
      this.addSample(sample);
    } catch (e) {
      // Offline fallback: offset is 0
      this.offset = 0;
    }
  }

  handlePong(t0OrObj, t1, t2) {
    const t3 = Date.now();
    let t0, serverT1, serverT2;
    if (typeof t0OrObj === 'object' && t0OrObj !== null) {
      t0 = t0OrObj.clientTimestamp || t0OrObj.t0 || (t3 - 30);
      serverT1 = t0OrObj.serverReceiveTime || t0OrObj.t1 || t3;
      serverT2 = t0OrObj.serverTransmitTime || t0OrObj.t2 || t3;
    } else {
      t0 = t0OrObj || (t3 - 30);
      serverT1 = t1 || t3;
      serverT2 = t2 || t3;
    }
    const sample = this.calculateSample({ t0, t1: serverT1, t2: serverT2, t3 });
    if (!isNaN(sample.offset) && !isNaN(sample.rtt)) {
      this.addSample(sample);
    }
  }

  startPeriodicSync(intervalMs = 3000) {
    this.stopPeriodicSync();
    // Burst sync at start: 5 pings every 150ms
    for (let i = 0; i < 5; i++) {
      setTimeout(() => this.ping(), i * 150);
    }
    // Then regular heartbeat ping
    this.syncInterval = setInterval(() => {
      this.ping();
    }, intervalMs);
  }

  stopPeriodicSync() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  getServerTime() {
    return Date.now() + this.offset;
  }

  toClientLocalTime(serverTime) {
    return serverTime - this.offset;
  }
}
