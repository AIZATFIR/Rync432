export class LatencyTuner {
  constructor(onOffsetChange = null) {
    this.manualOffset = 0; // in milliseconds (-300 to +500)
    this.onOffsetChange = onOffsetChange;
    this.presets = {
      wired: 0,
      internal: 15,
      bluetooth: 120,
      airplay: 250
    };
  }

  setManualOffset(ms) {
    this.manualOffset = Math.max(-300, Math.min(500, Math.round(ms)));
    if (this.onOffsetChange) {
      this.onOffsetChange(this.manualOffset);
    }
  }

  nudge(deltaMs) {
    this.setManualOffset(this.manualOffset + deltaMs);
  }

  applyPreset(presetName) {
    if (presetName in this.presets) {
      this.setManualOffset(this.presets[presetName]);
    }
  }

  calculateEffectiveStartTime(serverTargetTime, clockOffset) {
    // clientLocalTargetTime = serverTargetTime - clockOffset
    // We subtract manualOffset (if positive / lagging speaker, start earlier)
    const clientLocalTargetTime = serverTargetTime - clockOffset;
    return clientLocalTargetTime - this.manualOffset;
  }
}
