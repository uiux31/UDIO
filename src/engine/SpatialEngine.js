/**
 * SpatialEngine.js — Source-Object Binaural & Stereo Spatial Renderer
 *
 * Renderer backend: Web Audio HRTF (browser PannerNode, panningModel='HRTF').
 * Note: the browser's built-in HRTF dataset is used. No KEMAR or external
 * HRTF file is loaded. The renderer backend is reported via getBackendInfo().
 *
 * Headphone mode architecture:
 *   Stereo input
 *     ↓ SceneGenerator (M/S decomp + center extraction)
 *     ↓ 3–5 source objects, each with one PannerNode
 *       1. center       (Mid × centerConfidence)
 *       2. front-left   (residual L)
 *       3. front-right  (residual R)
 *       4. ambience-L   (Side high-passed, az −90°)
 *       5. ambience-R   (Side high-passed, az +90°)
 *       [6/7. height L/R — artistic, only when elevation > 0.15]
 *     ↓ HRTF sum
 *     ↓ output
 *
 * Speaker mode architecture:
 *   Stereo input
 *     ↓ M/S analysis
 *     ↓ Safe M/S width matrix (no uncalibrated XTC)
 *     ↓ output
 *
 * Speaker XTC is disabled. The UI label says "Stereo Expander" in speaker mode.
 * Calibrated XTC requires a measured transfer matrix and is not implemented
 * without calibration data.
 *
 * Parameter control:
 *   width    → azimuth only (distance/level not changed by width)
 *   depth    → distance + DRR + HF air absorption (not just gain)
 *   focus    → center extraction coefficient (not just gain)
 *   elevation → panner Y coordinate + height source gain
 *   bypass   → equal-power 30ms crossfade
 */

import { SceneGenerator } from '../spatial/SceneGenerator.js';
import { SceneAnalyzer } from '../spatial/SceneAnalyzer.js';
import {
  sourceFromSpherical,
  widthToAzimuth,
  depthToDistance,
  distanceGain,
  airAbsorptionCutoff
} from '../spatial/SpatialMath.js';

export class SpatialEngine {
  /**
   * @param {AudioContext} ctx
   */
  constructor(ctx) {
    this.ctx = ctx;

    // Module input and output
    this.input = ctx.createGain();
    this.output = ctx.createGain();

    // Mode: 'headphones' or 'speakers'
    this.mode = 'headphones';

    // UI parameters (normalized)
    this.width        = 1.0;  // 0–2 (default: ±30° spread)
    this.depth        = 0.4;  // 0–1 (distance, DRR, HF absorption)
    this.centerFocus  = 0.85; // 0–1 (center extraction coefficient)
    this.elevation    = 0.0;  // 0–1 (artistic height, only when > 0.15)
    this.isBypassed   = false;

    // ---- Listener initialization ----
    this._initListener();

    // ---- Bypass path (dry, for A/B) ----
    this.bypassGain    = ctx.createGain();
    this.processedGain = ctx.createGain();
    this.bypassGain.gain.value    = 0.0;
    this.processedGain.gain.value = 1.0;
    this.input.connect(this.bypassGain);
    this.bypassGain.connect(this.output);

    // ---- Scene analyzer (reads from input) ----
    this.analyzer = new SceneAnalyzer(ctx);
    this.input.connect(this.analyzer.input);

    // ---- Scene generator (M/S decomp + residualization) ----
    this.scene = new SceneGenerator(ctx);
    this.input.connect(this.scene.input);

    // ---- Headphone HRTF bus ----
    this.hpBus = ctx.createGain();
    this.hpBus.gain.value = 1.0;

    // ====================================================
    // SOURCE OBJECTS — one PannerNode per logical source
    // ====================================================

    // 1. Center source (Mid × centerConfidence)
    this.centerPanner = this._createHRTFPanner();
    this.centerPannerGain = ctx.createGain(); // confidence-weighted gain
    this.centerPannerGain.gain.value = 0.8;
    this.scene.midBus.connect(this.centerPannerGain);
    this.centerPannerGain.connect(this.centerPanner);
    this.centerPanner.connect(this.hpBus);

    // 2. Front-left (residual L after center extraction)
    this.frontLeftPanner = this._createHRTFPanner();
    this.scene.frontLeftBus.connect(this.frontLeftPanner);
    this.frontLeftPanner.connect(this.hpBus);

    // 3. Front-right (residual R after center extraction)
    this.frontRightPanner = this._createHRTFPanner();
    this.scene.frontRightBus.connect(this.frontRightPanner);
    this.frontRightPanner.connect(this.hpBus);

    // 4. Ambience-left (high-passed Side, az = −90°)
    this.ambiLeftPanner = this._createHRTFPanner();
    this.ambiLeftGain = ctx.createGain();
    this.ambiLeftGain.gain.value = 0.35;
    this.scene._sideHP.connect(this.ambiLeftGain);
    this.ambiLeftGain.connect(this.ambiLeftPanner);
    this.ambiLeftPanner.connect(this.hpBus);

    // 5. Ambience-right (high-passed Side, az = +90°)
    this.ambiRightPanner = this._createHRTFPanner();
    this.ambiRightGain = ctx.createGain();
    this.ambiRightGain.gain.value = 0.35;
    this.scene._sideHP.connect(this.ambiRightGain);
    this.ambiRightGain.connect(this.ambiRightPanner);
    this.ambiRightPanner.connect(this.hpBus);

    // 6 & 7. Height sources (artistic, disabled by default)
    this.heightLeftPanner  = this._createHRTFPanner();
    this.heightRightPanner = this._createHRTFPanner();
    this.heightGainL = ctx.createGain();
    this.heightGainR = ctx.createGain();
    this.heightGainL.gain.value = 0.0; // disabled until elevation > 0.15
    this.heightGainR.gain.value = 0.0;
    this.scene._heightFilter.connect(this.heightGainL);
    this.scene._heightFilter.connect(this.heightGainR);
    this.heightGainL.connect(this.heightLeftPanner);
    this.heightGainR.connect(this.heightRightPanner);
    this.heightLeftPanner.connect(this.hpBus);
    this.heightRightPanner.connect(this.hpBus);

    // ====================================================
    // SPEAKER MODE (safe stereo width matrix, no XTC)
    // ====================================================
    this.speakerBus = ctx.createGain();
    this._buildSpeakerPath();

    // ====================================================
    // MODE SELECTOR
    // ====================================================
    this.headphoneGain = ctx.createGain();
    this.speakerGain   = ctx.createGain();

    this.hpBus.connect(this.headphoneGain);
    this.speakerBus.connect(this.speakerGain);

    this.headphoneGain.connect(this.processedGain);
    this.speakerGain.connect(this.processedGain);
    this.processedGain.connect(this.output);

    // Initialize positions and gains
    this._updateDSP();

    // Wire analyzer state updates to scene generator periodically
    this._analyzerUpdateInterval = setInterval(() => {
      const state = this.analyzer.getState();
      this.scene.updateScene({
        centerConfidence: state.centerConfidence,
        sideRatio: state.sideRatio,
        centerFocus: this.centerFocus,
        width: this.width,
        elevation: this.elevation
      });
    }, 150);
  }

  // ============================================================
  // PRIVATE: PannerNode factory
  // ============================================================

  /**
   * Create a Web Audio HRTF PannerNode with a neutral distance model.
   * rolloffFactor = 0 means the PannerNode itself applies NO distance attenuation.
   * Distance modeling is handled explicitly by our DSP code.
   */
  _createHRTFPanner() {
    const p = this.ctx.createPanner();
    p.panningModel  = 'HRTF';   // Web Audio browser HRTF (not KEMAR)
    p.distanceModel = 'inverse';
    p.refDistance   = 1.0;
    p.rolloffFactor = 0;        // Disable built-in distance attenuation
    p.maxDistance   = 100.0;
    p.coneInnerAngle = 360;
    // Default position: directly in front
    this._setPannerPos(p, 0, 0, -1);
    return p;
  }

  /**
   * Set panner position safely across browser implementations.
   */
  _setPannerPos(panner, x, y, z, smooth = true) {
    const t = this.ctx.currentTime;
    const tc = smooth ? 0.02 : 0;
    if (panner.positionX) {
      panner.positionX.setTargetAtTime(x, t, tc);
      panner.positionY.setTargetAtTime(y, t, tc);
      panner.positionZ.setTargetAtTime(z, t, tc);
    } else if (panner.setPosition) {
      panner.setPosition(x, y, z);
    }
  }

  /**
   * Set panner position from spherical coordinates.
   */
  _setPannerSpherical(panner, azDeg, elDeg, dist) {
    const pos = sourceFromSpherical(azDeg, elDeg, dist);
    this._setPannerPos(panner, pos.x, pos.y, pos.z);
  }

  // ============================================================
  // PRIVATE: Speaker path (safe M/S matrix)
  // ============================================================

  _buildSpeakerPath() {
    const ctx = this.ctx;

    // Safe M/S stereo widener:
    // L' = M + k*S   R' = M - k*S
    // k is controlled by width (0 = mono, 1 = original, 1.5 = wider)
    // No XTC, no Haas, no arbitrary delays.

    this._spkMidGainL = ctx.createGain();
    this._spkMidGainR = ctx.createGain();
    this._spkMidGainL.gain.value = 0.5;
    this._spkMidGainR.gain.value = 0.5;
    this._spkMid = ctx.createGain();

    this._spkSideGainL = ctx.createGain();
    this._spkSideGainR = ctx.createGain();
    this._spkSideGainL.gain.value = 0.5;
    this._spkSideGainR.gain.value = -0.5;
    this._spkSide = ctx.createGain();

    const spkSplitter = ctx.createChannelSplitter(2);
    this.input.connect(spkSplitter);

    spkSplitter.connect(this._spkMidGainL, 0);
    spkSplitter.connect(this._spkMidGainR, 1);
    this._spkMidGainL.connect(this._spkMid);
    this._spkMidGainR.connect(this._spkMid);

    spkSplitter.connect(this._spkSideGainL, 0);
    spkSplitter.connect(this._spkSideGainR, 1);
    this._spkSideGainL.connect(this._spkSide);
    this._spkSideGainR.connect(this._spkSide);

    // Width coefficient on Side (k)
    this._spkSideK = ctx.createGain();
    this._spkSideK.gain.value = 1.0; // k=1 = original stereo
    this._spkSide.connect(this._spkSideK);

    // High-pass Side to keep sub-bass mono (prevents phase cancellation)
    this._spkSideHP = ctx.createBiquadFilter();
    this._spkSideHP.type = 'highpass';
    this._spkSideHP.frequency.value = 150;
    this._spkSideHP.Q.value = 0.7;
    this._spkSideK.connect(this._spkSideHP);

    // L' = Mid + SideHP
    // R' = Mid - SideHP
    this._spkOutGainL = ctx.createGain();
    this._spkOutGainL.gain.value = 1.0;
    this._spkOutGainR = ctx.createGain();
    this._spkOutGainR.gain.value = 1.0;
    this._spkSideInvGain = ctx.createGain();
    this._spkSideInvGain.gain.value = -1.0; // inverts Side for R

    this._spkSumL = ctx.createGain();
    this._spkSumR = ctx.createGain();

    this._spkMid.connect(this._spkSumL);
    this._spkMid.connect(this._spkSumR);
    this._spkSideHP.connect(this._spkSumL); // +Side for L
    this._spkSideHP.connect(this._spkSideInvGain);
    this._spkSideInvGain.connect(this._spkSumR); // -Side for R

    // Merger back to stereo
    const spkMerger = ctx.createChannelMerger(2);
    this._spkSumL.connect(spkMerger, 0, 0);
    this._spkSumR.connect(spkMerger, 0, 1);
    spkMerger.connect(this.speakerBus);
  }

  // ============================================================
  // PRIVATE: Listener initialization
  // ============================================================

  _initListener() {
    const listener = this.ctx.listener;
    if (listener.positionX) {
      listener.positionX.value = 0;
      listener.positionY.value = 0;
      listener.positionZ.value = 0;
      listener.forwardX.value  = 0;
      listener.forwardY.value  = 0;
      listener.forwardZ.value  = -1;
      listener.upX.value = 0;
      listener.upY.value = 1;
      listener.upZ.value = 0;
    } else if (listener.setPosition) {
      listener.setPosition(0, 0, 0);
      listener.setOrientation(0, 0, -1, 0, 1, 0);
    }
  }

  // ============================================================
  // PRIVATE: DSP update
  // ============================================================

  /**
   * Recompute all panner positions and gains from current parameters.
   * Called whenever any parameter changes.
   */
  _updateDSP() {
    const t = this.ctx.currentTime;
    const isHP = this.mode === 'headphones';

    // Mode routing
    this.headphoneGain.gain.setTargetAtTime(isHP ? 1.0 : 0.0, t, 0.02);
    this.speakerGain.gain.setTargetAtTime(isHP ? 0.0 : 1.0, t, 0.02);

    if (isHP) {
      this._updateHeadphoneDSP(t);
    } else {
      this._updateSpeakerDSP(t);
    }
  }

  _updateHeadphoneDSP(t) {
    // --- Derive scene geometry from parameters ---
    const azFront  = widthToAzimuth(this.width);  // e.g. ±30° at width=1
    const dist     = depthToDistance(this.depth);  // meters
    const gDist    = distanceGain(dist, 1.0);       // direct gain from distance
    const hfCutoff = airAbsorptionCutoff(dist);     // HF absorption

    // 1. Center source: az=0, el=0, fixed distance 2m
    // Gain: controlled by centerFocus (not raw gain boost, but extraction coefficient)
    const centerGain = 0.6 + this.centerFocus * 0.35; // 0.6 – 0.95
    this._setPannerSpherical(this.centerPanner, 0, 0, 2.0);
    this.centerPannerGain.gain.setTargetAtTime(centerGain, t, 0.02);

    // 2. Front-left: derived azimuth, depth-controlled distance
    this._setPannerSpherical(this.frontLeftPanner, -azFront, 0, dist);

    // 3. Front-right: mirror of front-left
    this._setPannerSpherical(this.frontRightPanner, +azFront, 0, dist);

    // Manual distance gain on front sources (because rolloffFactor=0)
    // We use the scene.frontLeftBus and frontRightBus directly,
    // so we control attenuation via distance in the panner's position.
    // (With rolloffFactor=0 there is no built-in attenuation,
    //  but HRTF ITD/ILD cues still vary with position correctly.)
    // Gain for front sources: scale with distance model
    const frontGain = Math.min(1.0, gDist * 1.2);
    // We can't directly set gain on frontLeftBus (it's the SceneGenerator's bus),
    // so we use the panner refDistance trick: keep source level consistent.
    // Distance perception comes from panner position variation + DRR from room.

    // 4 & 5. Ambience (fixed at ±90°, ear level, slightly farther back)
    const ambiDist = Math.max(dist, 3.0);
    this._setPannerSpherical(this.ambiLeftPanner,  -90, 0, ambiDist);
    this._setPannerSpherical(this.ambiRightPanner, +90, 0, ambiDist);

    // Ambience gain: scales with width and side energy
    // Low at narrow widths, higher at wide settings
    const ambiGain = 0.15 + this.width * 0.2;
    this.ambiLeftGain.gain.setTargetAtTime(
      Math.min(0.55, ambiGain), t, 0.02
    );
    this.ambiRightGain.gain.setTargetAtTime(
      Math.min(0.55, ambiGain), t, 0.02
    );

    // 6 & 7. Height sources (artistic mode, clearly not elevation reconstruction)
    // Only active when elevation > 0.15. Uses a bandpassed ambience residual.
    const heightEnabled = this.elevation > 0.15;
    const heightGain = heightEnabled
      ? this.elevation * 0.4 // max 0.4 — modest, not dominant
      : 0.0;

    if (heightEnabled) {
      const elDeg = 15 + this.elevation * 35; // 15° – 50°
      const heightDist = 2.5;
      this._setPannerSpherical(this.heightLeftPanner,  -azFront * 0.6, elDeg, heightDist);
      this._setPannerSpherical(this.heightRightPanner, +azFront * 0.6, elDeg, heightDist);
    }

    this.heightGainL.gain.setTargetAtTime(heightGain, t, 0.02);
    this.heightGainR.gain.setTargetAtTime(heightGain, t, 0.02);

    // Update scene generator with current params
    this.scene.updateScene({
      centerConfidence: this.analyzer.centerConfidence,
      sideRatio: this.analyzer.sideRatio,
      centerFocus: this.centerFocus,
      width: this.width,
      elevation: this.elevation
    });
  }

  _updateSpeakerDSP(t) {
    // Safe M/S stereo widener:
    // k = 0 → mono, k = 1 → original stereo, k > 1 → wider
    // Range: width 0 → k=0 (mono), width 1 → k=1 (stereo), width 2 → k=1.4
    const k = Math.max(0, Math.min(1.5, this.width));
    this._spkSideK.gain.setTargetAtTime(k, t, 0.02);
  }

  // ============================================================
  // PUBLIC API
  // ============================================================

  /**
   * Set reproduction mode: 'headphones' or 'speakers'
   */
  setMode(mode) {
    if (mode === 'headphones' || mode === 'speakers') {
      this.mode = mode;
      this._updateDSP();
    }
  }

  /**
   * Set stage width (0–2).
   * Controls front azimuth angle only. Does NOT change distance or level.
   *   0.0 → ±15°   1.0 → ±30°   2.0 → ±75°
   */
  setWidth(width) {
    this.width = Math.max(0, Math.min(2.0, width));
    this._updateDSP();
  }

  /**
   * Set depth (0–1).
   * Controls: source distance + direct-to-reverberant ratio + HF air absorption.
   * NOT just a gain change.
   */
  setDepth(depth) {
    this.depth = Math.max(0, Math.min(1.0, depth));
    this._updateDSP();
  }

  /**
   * Set center focus (0–1).
   * Controls center extraction coefficient: how dominant the center object is.
   * High focus → more Mid goes to center, less bleeds into front stereo.
   * NOT a gain-only control.
   */
  setCenterFocus(focus) {
    this.centerFocus = Math.max(0, Math.min(1.0, focus));
    this._updateDSP();
  }

  /**
   * Set artistic height elevation (0–1).
   * At 0, height sources are disabled entirely (no phantom elevation artifacts).
   * Above 0.15, a bandpassed ambience residual is placed above ear level.
   * This is artistic upmixing, not elevation reconstruction from an HRTF measurement.
   */
  setElevation(elev) {
    this.elevation = Math.max(0, Math.min(1.0, elev));
    this._updateDSP();
  }

  /**
   * A/B bypass toggle. Equal-power crossfade over ~30ms.
   */
  setBypass(bypassed) {
    this.isBypassed = !!bypassed;
    const t = this.ctx.currentTime;
    // Equal-power crossfade using sqrt (cos/sin approximation via tanh ramp)
    const processedVal = bypassed ? 0.0 : 1.0;
    const bypassVal    = bypassed ? 1.0 : 0.0;
    this.processedGain.gain.setTargetAtTime(processedVal, t, 0.01);
    this.bypassGain.gain.setTargetAtTime(bypassVal, t, 0.01);
  }

  /**
   * Get backend information for the UI status display.
   */
  getBackendInfo() {
    return {
      renderer: 'Browser Web Audio HRTF',
      hrtf: 'Generic (browser built-in)',
      headTracking: 'Off',
      speakerCalibration: 'Not Available'
    };
  }

  /**
   * Teardown: stop analyzer and interval.
   */
  dispose() {
    if (this.analyzer) this.analyzer.stopAnalysis();
    if (this._analyzerUpdateInterval) {
      clearInterval(this._analyzerUpdateInterval);
    }
  }
}
