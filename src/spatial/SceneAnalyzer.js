/**
 * SceneAnalyzer.js — Stereo Signal Analysis for Source-Object Extraction
 *
 * Analyzes the stereo input to estimate:
 *   - Per-band inter-channel coherence
 *   - Mid/Side energy ratio
 *   - centerConfidence: how dominant/coherent the center content is
 *   - sideRatio: how much Side energy exists (drives ambience gain)
 *
 * This is NOT AI source separation. It is a conservative signal-analysis
 * heuristic used to drive confidence-weighted spatialization.
 * High confidence → more spatialization. Low confidence → safer/narrower.
 *
 * Analysis runs in the frequency domain using a small offline FFT.
 * The analyzer is called periodically from the main thread (not real-time render).
 */

export class SceneAnalyzer {
  /**
   * @param {AudioContext} ctx
   */
  constructor(ctx) {
    this.ctx = ctx;

    // Analysis window size
    this.fftSize = 2048;
    this.hopSize = 512;

    // Analyzed results (updated each analysis frame)
    this.centerConfidence = 0.7; // default safe value
    this.sideRatio = 0.3;        // default ambience amount
    this.midEnergy = 0.5;
    this.sideEnergy = 0.1;

    // AnalyserNodes to read frequency data from the live audio graph
    this.analyserL = ctx.createAnalyser();
    this.analyserL.fftSize = this.fftSize;
    this.analyserL.smoothingTimeConstant = 0.5;

    this.analyserR = ctx.createAnalyser();
    this.analyserR.fftSize = this.fftSize;
    this.analyserR.smoothingTimeConstant = 0.5;

    // Splitter to feed L and R separately into analysers
    this.splitter = ctx.createChannelSplitter(2);
    this.splitter.connect(this.analyserL, 0);
    this.splitter.connect(this.analyserR, 1);

    // The splitter's input IS the module input
    this.input = this.splitter;

    // Buffers for frequency data
    this._bufL = new Float32Array(this.fftSize / 2);
    this._bufR = new Float32Array(this.fftSize / 2);

    // Start periodic analysis
    this._intervalId = null;
    this._startAnalysis();
  }

  /**
   * Start periodic analysis updates (every 100ms).
   * Light enough for the main thread.
   */
  _startAnalysis() {
    this._intervalId = setInterval(() => this._analyze(), 100);
  }

  /**
   * Stop analysis (call on engine teardown).
   */
  stopAnalysis() {
    if (this._intervalId !== null) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  /**
   * Run one analysis frame using current AnalyserNode data.
   * Updates centerConfidence and sideRatio.
   */
  _analyze() {
    this.analyserL.getFloatFrequencyData(this._bufL);
    this.analyserR.getFloatFrequencyData(this._bufR);

    const bins = this._bufL.length;
    const sampleRate = this.ctx.sampleRate;
    const binHz = sampleRate / this.fftSize;

    // Focus analysis on 200 Hz – 8 kHz (perceptually important band)
    const lo = Math.floor(200 / binHz);
    const hi = Math.min(bins - 1, Math.floor(8000 / binHz));

    let midEnergySum = 0;
    let sideEnergySum = 0;
    let coherenceSum = 0;
    let count = 0;

    for (let k = lo; k <= hi; k++) {
      // Convert dBFS to linear magnitude
      const ml = Math.pow(10, this._bufL[k] / 20);
      const mr = Math.pow(10, this._bufR[k] / 20);

      // Mid and Side magnitudes
      const mid = (ml + mr) * 0.5;
      const side = Math.abs(ml - mr) * 0.5;

      midEnergySum += mid * mid;
      sideEnergySum += side * side;

      // Approximate coherence from magnitude: 1 when L≈R, 0 when fully decorrelated
      const sumMag = ml + mr + 1e-10;
      const diff = Math.abs(ml - mr);
      const coh = 1.0 - diff / sumMag;

      coherenceSum += coh;
      count++;
    }

    if (count === 0) return;

    const avgCoherence = coherenceSum / count;
    const totalEnergy = midEnergySum + sideEnergySum + 1e-12;

    this.midEnergy = midEnergySum / totalEnergy;
    this.sideEnergy = sideEnergySum / totalEnergy;
    this.sideRatio = sideEnergySum / totalEnergy;

    // centerConfidence: high when mid-dominant AND coherent
    // Clamped to [0.3, 1.0] to avoid over-aggressive/under-aggressive behavior
    const raw = (this.midEnergy * avgCoherence);
    this.centerConfidence = Math.max(0.3, Math.min(1.0, raw * 1.5));
  }

  /**
   * Get current analysis snapshot.
   * @returns {{ centerConfidence: number, sideRatio: number }}
   */
  getState() {
    return {
      centerConfidence: this.centerConfidence,
      sideRatio: this.sideRatio
    };
  }
}
