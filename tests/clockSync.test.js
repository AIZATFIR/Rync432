import { describe, it, expect, beforeEach } from 'vitest';
import { ClockSync } from '../public/js/audio/ClockSync.js';

describe('ClockSync (NTP Algorithm)', () => {
  let clockSync;
  beforeEach(() => {
    clockSync = new ClockSync();
  });

  it('calculates accurate clock offset and RTT', () => {
    // Scenario: Client sends at T0=1000. Server receives at T1=1020, sends at T2=1022. Client receives at T3=1046.
    // RTT = (T3 - T0) - (T2 - T1) = (1046 - 1000) - (1022 - 1020) = 46 - 2 = 44ms (one-way ~22ms)
    // Offset = ((T1 - T0) + (T2 - T3)) / 2 = ((1020 - 1000) + (1022 - 1046)) / 2 = (20 - 24) / 2 = -2ms
    const sample = clockSync.calculateSample({
      t0: 1000,
      t1: 1020,
      t2: 1022,
      t3: 1046
    });

    expect(sample.rtt).toBe(44);
    expect(sample.offset).toBe(-2);
  });

  it('filters outlier samples and computes median offset', () => {
    clockSync.addSample({ rtt: 10, offset: 50 });
    clockSync.addSample({ rtt: 12, offset: 52 });
    clockSync.addSample({ rtt: 80, offset: 120 }); // Outlier spike
    clockSync.addSample({ rtt: 11, offset: 51 });

    const bestOffset = clockSync.getBestOffset();
    // Best samples with lowest RTT should determine offset (~51)
    expect(Math.round(bestOffset)).toBe(51);
  });

  it('converts server time to client local time accurately', () => {
    clockSync.offset = 100; // Server is 100ms ahead of client
    const serverTime = 5000;
    const clientTime = clockSync.toClientLocalTime(serverTime);
    expect(clientTime).toBe(4900);
  });

  it('handles handlePong with both positional arguments and object parameter', () => {
    const t0 = Date.now() - 30;
    const t1 = Date.now() - 10;
    const t2 = Date.now() - 9;

    // Positional call
    clockSync.handlePong(t0, t1, t2);
    expect(clockSync.samples.length).toBe(1);
    expect(isNaN(clockSync.samples[0].offset)).toBe(false);

    // Object call
    clockSync.handlePong({ clientTimestamp: t0, serverReceiveTime: t1, serverTransmitTime: t2 });
    expect(clockSync.samples.length).toBe(2);
    expect(isNaN(clockSync.samples[1].offset)).toBe(false);
  });
});
