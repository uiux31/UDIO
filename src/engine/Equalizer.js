/**
 * Equalizer.js — 5-Band Parametric EQ
 * 
 * Bands:
 *   0: 60Hz  (lowshelf)
 *   1: 250Hz (peaking)
 *   2: 1kHz  (peaking)
 *   3: 4kHz  (peaking)
 *   4: 12kHz (highshelf)
 */

export class Equalizer {
  constructor(ctx) {
    this.ctx = ctx;

    this.input = ctx.createGain();
    this.output = ctx.createGain();

    // Bypass path
    this.bypassGain = ctx.createGain();
    this.bypassGain.gain.value = 0; // EQ enabled by default

    // EQ path gain
    this.eqGain = ctx.createGain();
    this.eqGain.gain.value = 1;

    this.enabled = true;

    // Create 5 EQ bands
    const bandConfigs = [
      { type: 'lowshelf',  frequency: 60,   Q: 0.7 },
      { type: 'peaking',   frequency: 250,  Q: 1.0 },
      { type: 'peaking',   frequency: 1000, Q: 1.0 },
      { type: 'peaking',   frequency: 4000, Q: 1.0 },
      { type: 'highshelf', frequency: 12000, Q: 0.7 },
    ];

    this.bands = bandConfigs.map(config => {
      const filter = ctx.createBiquadFilter();
      filter.type = config.type;
      filter.frequency.value = config.frequency;
      filter.Q.value = config.Q;
      filter.gain.value = 0;
      return filter;
    });

    // Chain the bands together
    this.input.connect(this.bands[0]);
    for (let i = 0; i < this.bands.length - 1; i++) {
      this.bands[i].connect(this.bands[i + 1]);
    }
    this.bands[this.bands.length - 1].connect(this.eqGain);
    this.eqGain.connect(this.output);

    // Bypass path
    this.input.connect(this.bypassGain);
    this.bypassGain.connect(this.output);
  }

  /**
   * Set gain for a specific band
   * @param {number} band - Band index (0-4)
   * @param {number} gain - Gain in dB (-12 to +12)
   */
  setBand(band, gain) {
    if (band >= 0 && band < this.bands.length) {
      this.bands[band].gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02);
    }
  }

  /**
   * Get current gain values for all bands
   */
  getBands() {
    return this.bands.map(b => b.gain.value);
  }

  /**
   * Enable/disable EQ (smooth bypass)
   */
  setEnabled(enabled) {
    this.enabled = enabled;
    const t = this.ctx.currentTime;
    if (enabled) {
      this.eqGain.gain.setTargetAtTime(1, t, 0.02);
      this.bypassGain.gain.setTargetAtTime(0, t, 0.02);
    } else {
      this.eqGain.gain.setTargetAtTime(0, t, 0.02);
      this.bypassGain.gain.setTargetAtTime(1, t, 0.02);
    }
  }

  /**
   * Reset all bands to 0 dB
   */
  reset() {
    const t = this.ctx.currentTime;
    this.bands.forEach(band => {
      band.gain.setTargetAtTime(0, t, 0.02);
    });
  }
}
