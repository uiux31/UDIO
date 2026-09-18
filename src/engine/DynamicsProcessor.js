/**
 * DynamicsProcessor.js — Transparent Compressor & Peak Limiter
 *
 * Replaces the previous parallel WaveShaper path (which was mislabeled
 * as a "transparent mastering limiter") with a proper dynamics chain:
 *
 *   input
 *     → DynamicsCompressorNode  (gentle broadband compression)
 *     → WaveShaper soft-clip    (final peak protection, optional)
 *     → output
 *
 * The DynamicsCompressorNode is the correct Web Audio primitive for
 * level control and clipping prevention. The WaveShaper here acts as
 * a final soft-clip ceiling only — it is NOT a limiter.
 *
 * DynamicsCompressorNode reference:
 *   https://developer.mozilla.org/en-US/docs/Web/API/DynamicsCompressorNode
 *
 * Parameters exposed via setAmount():
 *   0   → bypass (no compression, no saturation)
 *   0.5 → gentle compression (-18 dBFS threshold, 3:1 ratio)
 *   1.0 → more compression (-14 dBFS threshold, 5:1 ratio)
 */

export class DynamicsProcessor {
  constructor(ctx) {
    this.ctx = ctx;

    this.input  = ctx.createGain();
    this.output = ctx.createGain();

    // DC blocker / subsonic removal before compressor
    this.dcBlocker = ctx.createBiquadFilter();
    this.dcBlocker.type = 'highpass';
    this.dcBlocker.frequency.value = 25;
    this.dcBlocker.Q.value = 0.7;

    // DynamicsCompressorNode — proper envelope-following compressor
    // with attack, release, and gain-reduction envelope.
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -18;  // dBFS
    this.compressor.knee.value      = 6;    // soft knee width in dB
    this.compressor.ratio.value     = 3;    // compression ratio
    this.compressor.attack.value    = 0.005; // 5ms attack
    this.compressor.release.value   = 0.1;   // 100ms release

    // Final soft-clip WaveShaper — acts as a ceiling only.
    // It is NOT a limiter. It is labeled accurately as "soft clip".
    // Threshold is very close to 1.0 so it only catches extreme peaks.
    this.softClip = ctx.createWaveShaper();
    this.softClip.curve = this._createSoftClipCurve(4096, 0.95);
    this.softClip.oversample = '2x'; // reduce aliasing from nonlinearity

    // Dry path (for bypass / wet blend)
    this.dryGain = ctx.createGain();
    this.dryGain.gain.value = 1.0;

    // Wet path
    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = 0.0;

    // Wire dry path
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);

    // Wire wet path: input → dcBlocker → compressor → softClip → wetGain → output
    this.input.connect(this.dcBlocker);
    this.dcBlocker.connect(this.compressor);
    this.compressor.connect(this.softClip);
    this.softClip.connect(this.wetGain);
    this.wetGain.connect(this.output);
  }

  /**
   * Generates a soft-clip transfer curve.
   * Linear below threshold. tanh-based soft saturation above threshold.
   * This is a ceiling, not a dynamic compressor.
   *
   * @param {number} samples   - Number of curve points
   * @param {number} threshold - Onset of soft clip (0–1, e.g. 0.95)
   */
  _createSoftClipCurve(samples, threshold = 0.95) {
    const curve = new Float32Array(samples);
    const headroom = 1.0 - threshold;

    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / (samples - 1) - 1; // −1 to +1
      const absX = Math.abs(x);

      if (absX <= threshold) {
        curve[i] = x; // linear pass-through
      } else {
        const sign = x < 0 ? -1 : 1;
        const excess = absX - threshold;
        // tanh soft clip: smoothly asymptotes toward 1.0
        const clipped = threshold + headroom * Math.tanh(excess / headroom);
        curve[i] = sign * clipped;
      }
    }
    return curve;
  }

  /**
   * Set dynamics processing amount (0–1).
   * 0   → bypass (dry only)
   * 0.5 → moderate compression
   * 1.0 → more compression
   *
   * @param {number} amount - Normalized [0, 1]
   */
  setAmount(amount) {
    const t = this.ctx.currentTime;
    const clamped = Math.max(0, Math.min(1.0, amount));

    // Dry/wet crossfade
    this.dryGain.gain.setTargetAtTime(1.0 - clamped, t, 0.02);
    this.wetGain.gain.setTargetAtTime(clamped,        t, 0.02);

    // Compressor threshold: less compression at 0, more at 1.0
    // Range: −12 dBFS (slight) → −20 dBFS (moderate)
    const thresholdDB = -12 - clamped * 8; // −12 to −20 dBFS
    this.compressor.threshold.setTargetAtTime(thresholdDB, t, 0.05);

    // Ratio: 2:1 (gentle) to 5:1 (moderate)
    const ratio = 2 + clamped * 3;
    this.compressor.ratio.setTargetAtTime(ratio, t, 0.05);

    // Attack / release: keep fixed (5ms / 100ms) — these are safe defaults.
    // Do not make attack/release dependent on amount since that changes the
    // character unpredictably.
  }
}
