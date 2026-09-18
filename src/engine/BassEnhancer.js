/**
 * BassEnhancer.js — Psychoacoustic Bass Enhancement
 * 
 * Laptop speakers can't produce frequencies below ~200Hz.
 * This module uses the "Missing Fundamental" psychoacoustic effect:
 * 
 * 1. Isolate bass frequencies (20-200Hz)
 * 2. Generate upper harmonics via waveshaping (tanh distortion)
 * 3. High-pass the harmonics to remove the original fundamental
 * 4. Mix harmonics back — brain "fills in" the missing bass
 */

export class BassEnhancer {
  constructor(ctx) {
    this.ctx = ctx;

    this.input = ctx.createGain();
    this.output = ctx.createGain();

    // Dry path (unprocessed signal)
    this.dryGain = ctx.createGain();
    this.dryGain.gain.value = 1.0;

    // Wet path (enhanced bass harmonics)
    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = 0.0;

    // Step 1: Isolate bass with a lowpass filter
    this.bassIsolator = ctx.createBiquadFilter();
    this.bassIsolator.type = 'lowpass';
    this.bassIsolator.frequency.value = 200;
    this.bassIsolator.Q.value = 0.7;

    // Step 2: Pre-gain before waveshaper (controls harmonic intensity)
    this.preGain = ctx.createGain();
    this.preGain.gain.value = 4.0;

    // Step 3: Waveshaper for harmonic generation (tanh curve)
    this.waveshaper = ctx.createWaveShaper();
    this.waveshaper.curve = this._createTanhCurve(4096);
    this.waveshaper.oversample = '4x'; // Reduce aliasing

    // Step 4: Highpass to remove the original fundamental (keep only harmonics)
    this.harmonicFilter = ctx.createBiquadFilter();
    this.harmonicFilter.type = 'highpass';
    this.harmonicFilter.frequency.value = 150;
    this.harmonicFilter.Q.value = 0.5;

    // Step 5: Post-EQ to shape the harmonic content
    this.harmonicEQ = ctx.createBiquadFilter();
    this.harmonicEQ.type = 'peaking';
    this.harmonicEQ.frequency.value = 300;
    this.harmonicEQ.Q.value = 1.0;
    this.harmonicEQ.gain.value = 3.0;

    // Post gain to control harmonic level
    this.postGain = ctx.createGain();
    this.postGain.gain.value = 0.5;

    // Wire dry path
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);

    // Wire wet path: input → bassIsolator → preGain → waveshaper → harmonicFilter → harmonicEQ → postGain → wetGain → output
    this.input.connect(this.bassIsolator);
    this.bassIsolator.connect(this.preGain);
    this.preGain.connect(this.waveshaper);
    this.waveshaper.connect(this.harmonicFilter);
    this.harmonicFilter.connect(this.harmonicEQ);
    this.harmonicEQ.connect(this.postGain);
    this.postGain.connect(this.wetGain);
    this.wetGain.connect(this.output);
  }

  /**
   * Create a tanh waveshaping curve for harmonic generation
   */
  _createTanhCurve(samples) {
    const curve = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      curve[i] = Math.tanh(x * 3);
    }
    return curve;
  }

  /**
   * Set bass enhancement amount (0 to 1)
   */
  setAmount(amount) {
    const t = this.ctx.currentTime;
    this.wetGain.gain.setTargetAtTime(amount * 0.8, t, 0.02);

    // Adjust pre-gain for more aggressive harmonics at higher settings
    const preGainValue = 2.0 + amount * 6.0;
    this.preGain.gain.setTargetAtTime(preGainValue, t, 0.02);
  }
}
