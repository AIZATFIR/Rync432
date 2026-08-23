import { describe, it, expect, beforeEach } from 'vitest';
import { LatencyTuner } from '../public/js/audio/LatencyTuner.js';

describe('LatencyTuner', () => {
  let tuner;
  beforeEach(() => {
    tuner = new LatencyTuner();
  });

  it('calculates scheduled local start time with custom offset', () => {
    // If target server time is 5000ms, client time is 4900ms (offset = 100ms server ahead)
    // Custom latency adjustment = +30ms (e.g. bluetooth delay compensation)
    tuner.setManualOffset(30);
    
    // serverTimeToClientTime converts 5000 -> 4900
    // Latency adjustment compensates: 4900 - 30 = 4870ms (fire earlier so sound arrives on time)
    const effectiveTime = tuner.calculateEffectiveStartTime(5000, 100);
    expect(effectiveTime).toBe(4870);
  });

  it('provides standard preset delay offsets', () => {
    tuner.applyPreset('bluetooth');
    expect(tuner.manualOffset).toBe(120);

    tuner.applyPreset('wired');
    expect(tuner.manualOffset).toBe(0);

    tuner.applyPreset('internal');
    expect(tuner.manualOffset).toBe(15);
  });

  it('supports nudging latency in steps', () => {
    tuner.setManualOffset(10);
    tuner.nudge(5);
    expect(tuner.manualOffset).toBe(15);
    tuner.nudge(-10);
    expect(tuner.manualOffset).toBe(5);
  });

  it('clamps latency within safe boundaries (-300ms to +500ms)', () => {
    tuner.setManualOffset(999);
    expect(tuner.manualOffset).toBe(500);

    tuner.setManualOffset(-999);
    expect(tuner.manualOffset).toBe(-300);
  });
});
