/**
 * SceneGenerator.js — Source-Object Scene Builder for UDIO
 *
 * Converts stereo M/S decomposition + SceneAnalyzer confidence scores
 * + UI parameters into a set of discrete source objects, each with:
 *   - an AudioNode signal feed
 *   - azimuth, elevation, distance
 *   - gain
 *   - a semantic category
 *
 * The default scene uses 3–5 sources. Each has exactly ONE reason to exist.
 * This prevents the multi-path energy duplication that caused vague localization
 * in the previous architecture.
 *
 * Sources:
 *   1. center       — Mid × centerConfidence  (az=0°, el=0°)
 *   2. front-left   — residual L              (az from width, el=0°)
 *   3. front-right  — residual R              (az from width, el=0°)
 *   4. ambience-L   — high-passed Side        (az=−90°, el=0°, low gain)
 *   5. ambience-R   — high-passed Side        (az=+90°, el=0°, low gain)
 *
 * Height sources (6, 7) are only added when elevation > 0.15 (user has
 * intentionally enabled elevation). They receive selected ambience residual,
 * not raw Side energy.
 */

import { widthToAzimuth, sourceFromSpherical, depthToDistance } from './SpatialMath.js';

export class SceneGenerator {
  /**
   * @param {AudioContext} ctx
   */
  constructor(ctx) {
    this.ctx = ctx;

    // ---- INPUT: M/S Decomposition ----
    // These are the AudioNodes representing the logical sources.
    // The SpatialEngine feeds its splitter/mid/side buses into these.

    this.splitter = ctx.createChannelSplitter(2);

    // Mid = (L + R) / 2
    this._midGainL = ctx.createGain();
    this._midGainR = ctx.createGain();
    this._midGainL.gain.value = 0.5;
    this._midGainR.gain.value = 0.5;
    this.midBus = ctx.createGain();
    this.splitter.connect(this._midGainL, 0);
    this.splitter.connect(this._midGainR, 1);
    this._midGainL.connect(this.midBus);
    this._midGainR.connect(this.midBus);

    // Side = (L - R) / 2
    this._sideGainL = ctx.createGain();
    this._sideGainR = ctx.createGain();
    this._sideGainL.gain.value = 0.5;
    this._sideGainR.gain.value = -0.5;
    this.sideBus = ctx.createGain();
    this.splitter.connect(this._sideGainL, 0);
    this.splitter.connect(this._sideGainR, 1);
    this._sideGainL.connect(this.sideBus);
    this._sideGainR.connect(this.sideBus);

    // High-pass Side (>120 Hz) — used for ambience objects.
    // Low bass stays mono to prevent phase cancellation.
    this._sideHP = ctx.createBiquadFilter();
    this._sideHP.type = 'highpass';
    this._sideHP.frequency.value = 120;
    this._sideHP.Q.value = 0.7;
    this.sideBus.connect(this._sideHP);

    // Residual front-left: original L minus center contribution
    // residualL = L - Mid * centerConfidence
    this._residualGainL = ctx.createGain(); // feeds: original L
    this._residualGainR = ctx.createGain(); // feeds: original R
    this._centerExtractL = ctx.createGain(); // negative Mid to subtract center
    this._centerExtractR = ctx.createGain(); // negative Mid to subtract center

    this.frontLeftBus = ctx.createGain();
    this.frontRightBus = ctx.createGain();

    this.splitter.connect(this._residualGainL, 0);
    this.splitter.connect(this._residualGainR, 1);
    this._residualGainL.connect(this.frontLeftBus);
    this._residualGainR.connect(this.frontRightBus);

    // Subtract center component from front buses (extract coefficient)
    this.midBus.connect(this._centerExtractL);
    this.midBus.connect(this._centerExtractR);
    this._centerExtractL.connect(this.frontLeftBus);
    this._centerExtractR.connect(this.frontRightBus);

    // Elevation bandpass for height sources (artistic, clearly labeled as such)
    // Only active when elevation > 0.15 per update
    this._heightFilter = ctx.createBiquadFilter();
    this._heightFilter.type = 'bandpass';
    this._heightFilter.frequency.value = 5000;
    this._heightFilter.Q.value = 0.7;
    this._sideHP.connect(this._heightFilter);

    // The stereo splitter input IS the module input
    this.input = this.splitter;

    // Default scene state
    this._centerConfidence = 0.7;
    this._sideRatio = 0.3;
    this._residualGainL.gain.value = 1.0;
    this._residualGainR.gain.value = 1.0;
    this._centerExtractL.gain.value = -0.35; // subtract 35% of Mid from front-L
    this._centerExtractR.gain.value = -0.35;
  }

  /**
   * Update scene from analyzer state and UI parameters.
   * Call this when analyzer reports new confidence scores or UI params change.
   *
   * @param {object} opts
   * @param {number} opts.centerConfidence  - [0, 1] from SceneAnalyzer
   * @param {number} opts.sideRatio         - [0, 1] from SceneAnalyzer
   * @param {number} opts.centerFocus       - [0, 1] from UI (Focus knob)
   * @param {number} opts.width             - [0, 2] from UI (Width knob)
   * @param {number} opts.elevation         - [0, 1] from UI (Height knob)
   */
  updateScene({ centerConfidence, sideRatio, centerFocus, width, elevation }) {
    const t = this.ctx.currentTime;

    this._centerConfidence = centerConfidence;
    this._sideRatio = sideRatio;

    // centerExtract: how much Mid is subtracted from front buses
    // Range: 0.3 (low confidence) to 0.7 (high confidence + high focus)
    const extractCoeff = -(centerConfidence * 0.4 + centerFocus * 0.3);
    const clampedExtract = Math.max(-0.7, Math.min(0, extractCoeff));
    this._centerExtractL.gain.setTargetAtTime(clampedExtract, t, 0.05);
    this._centerExtractR.gain.setTargetAtTime(clampedExtract, t, 0.05);

    // Ambience (Side) gain scales with sideRatio and width
    // But we do NOT change this here; ambience gain is managed by SpatialEngine
    // to keep the panner coupling in one place.

    // Update height filter characteristics based on elevation
    if (elevation > 0.1) {
      // Artistic height mode: push to presence/air frequencies
      const fc = 4000 + elevation * 5000; // 4kHz → 9kHz
      this._heightFilter.frequency.setTargetAtTime(fc, t, 0.05);
    }
  }

  /**
   * Get the current center confidence (for use by SpatialEngine).
   */
  getCenterConfidence() {
    return this._centerConfidence;
  }

  /**
   * Get the current side ratio (for ambience source gain).
   */
  getSideRatio() {
    return this._sideRatio;
  }
}
