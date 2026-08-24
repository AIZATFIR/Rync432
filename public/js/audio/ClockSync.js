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

  handlePong({ clientTimestamp, serverReceiveTime, serverTransmitTime }) {
    const clientReceiveTime = Date.now();
    const sample = this.calculateSample({
      t0: clientTimestamp,
      t1: serverReceiveTime,
      t2: serverTransmitTime,
      t3: clientReceiveTime
    });
    this.addSample(sample);
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
