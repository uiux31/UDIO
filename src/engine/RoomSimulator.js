/**
 * RoomSimulator.js — Deterministic FDN Late Reverb
 *
 * Replaces the previous random-noise impulse response with a
 * Feedback Delay Network (FDN) late reverb that is:
 *   - Deterministic: identical output every run for the same settings
 *   - Controllable: RT60-like decay and damping exposed as parameters
 *   - Physically honest: documented as a synthetic reverb, not a room IR
 *
 * Architecture: 4-line FDN
 *   input → [4 delay lines with prime-ish lengths]
 *         → [Hadamard-like mixing matrix (gain inversions)]
 *         → [per-line damping filter (lowpass)]
 *         → [feedback back into delays]
 *         → stereo output decode
 *
 * The convolver from the previous version has been removed.
 * This FDN runs entirely using native Web Audio nodes (DelayNode + BiquadFilter + GainNode).
 *
 * Pre-delay is tied to depth (source distance), not hard-coded to 15ms.
 */

export class RoomSimulator {
  constructor(ctx) {
    this.ctx = ctx;

    this.input  = ctx.createGain();
    this.output = ctx.createGain();

    // Dry path (direct)
    this.dryGain = ctx.createGain();
    this.dryGain.gain.value = 1.0;
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);

    // Pre-delay (geometry-derived; default ~15ms for a 2m source distance)
    this.preDelay = ctx.createDelay(0.2);
    this.preDelay.delayTime.value = 0.015;
    this.input.connect(this.preDelay);

    // Wet master gain
    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = 0.0;
    this.wetGain.connect(this.output);

    // Low-cut filter: prevent low-frequency mud build-up
    this.lowCut = ctx.createBiquadFilter();
    this.lowCut.type = 'highpass';
    this.lowCut.frequency.value = 180;
    this.lowCut.Q.value = 0.7;

    // ---- FDN: 4 delay lines ----
    // Prime-ish delay lengths in samples for ~44100 Hz (scaled at runtime)
    // These give a dense diffuse tail without metallic resonances.
    // Lengths chosen to be mutually co-prime in the sub-100ms range.
    this._fdnDelayMs = [29.7, 37.1, 43.7, 53.3]; // ms

    this._delays  = [];
    this._damps   = [];
    this._fbGains = [];

    for (let i = 0; i < 4; i++) {
      const d = ctx.createDelay(1.0);
      d.delayTime.value = this._fdnDelayMs[i] / 1000;

      // Per-line lowpass damping filter (simulates wall absorption)
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 5500;
      f.Q.value = 0.7;

      // Feedback gain (controls RT60 decay)
      const g = ctx.createGain();
      g.gain.value = 0.5; // default; updated by setAmount()

      this._delays.push(d);
      this._damps.push(f);
      this._fbGains.push(g);
    }

    // Input distribution: pre-delay → all 4 delay lines
    for (let i = 0; i < 4; i++) {
      const inGain = ctx.createGain();
      inGain.gain.value = 0.5;
      this.preDelay.connect(inGain);
      inGain.connect(this._delays[i]);
    }

    // FDN mixing matrix (simplified Hadamard-like, sign inversions):
    // Each delay line feeds into all others (with sign change for two)
    // This avoids modes and creates dense diffusion.
    //
    //  d0 → +d1, +d2, -d3
    //  d1 → +d0, -d2, +d3
    //  d2 → -d0, +d1, +d3
    //  d3 → +d0, -d1, +d2
    //
    const matrix = [
      [ 0,  1,  1, -1],
      [ 1,  0, -1,  1],
      [-1,  1,  0,  1],
      [ 1, -1,  1,  0],
    ];

    for (let from = 0; from < 4; from++) {
      // Wire: delays[from] → damps[from] → fbGains[from] → then distribute
      this._delays[from].connect(this._damps[from]);
      this._damps[from].connect(this._fbGains[from]);

      for (let to = 0; to < 4; to++) {
        const sign = matrix[from][to];
        if (sign === 0) continue;

        const crossGain = ctx.createGain();
        crossGain.gain.value = sign * 0.5; // normalized by 4 inputs
        this._fbGains[from].connect(crossGain);
        crossGain.connect(this._delays[to]);
      }
    }

    // Stereo output decode:
    // Left = fbGains[0] + fbGains[2]
    // Right = fbGains[1] + fbGains[3]
    // (pairs of delay lines decode to left/right for stereo width)
    this._outL = ctx.createGain();
    this._outL.gain.value = 0.5;
    this._outR = ctx.createGain();
    this._outR.gain.value = 0.5;

    this._fbGains[0].connect(this._outL);
    this._fbGains[2].connect(this._outL);
    this._fbGains[1].connect(this._outR);
    this._fbGains[3].connect(this._outR);

    // Merger → lowCut → wetGain → output
    const merger = ctx.createChannelMerger(2);
    this._outL.connect(merger, 0, 0);
    this._outR.connect(merger, 0, 1);
    merger.connect(this.lowCut);
    this.lowCut.connect(this.wetGain);
  }

  /**
   * Set room reverb amount (0–1).
   * Controls wet level (wet/dry ratio) and RT60-like feedback gain.
   *
   * @param {number} amount - Normalized [0, 1]
   */
  setAmount(amount) {
    const t = this.ctx.currentTime;
    const clamped = Math.max(0, Math.min(1.0, amount));

    // Wet level: max 40% wet to maintain speech intelligibility
    this.wetGain.gain.setTargetAtTime(clamped * 0.40, t, 0.02);

    // RT60-like decay: feedback gain maps to perceived reverb time
    // Low amount → fast decay (short room), high amount → longer decay
    // Range: 0.30 (very short) to 0.78 (~2s reverb at these delay lengths)
    const fbGain = 0.30 + clamped * 0.48;
    for (let i = 0; i < 4; i++) {
      this._fbGains[i].gain.setTargetAtTime(fbGain, t, 0.05);
    }

    // Damping: more reverb → slightly warmer (lower HF cutoff)
    const lpFreq = 8000 - clamped * 3500; // 8kHz → 4.5kHz
    for (let i = 0; i < 4; i++) {
      this._damps[i].frequency.setTargetAtTime(lpFreq, t, 0.05);
    }
  }

  /**
   * Set pre-delay from source distance geometry.
   * Call this when depth parameter changes.
   *
   * @param {number} sourceDist - Direct source distance in meters
   * @param {number} roomDist   - Mean room reflection distance in meters (default 5m)
   */
  setPreDelay(sourceDist, roomDist = 5.0) {
    // Pre-delay = time difference between direct path and first reflected path
    const directTime   = sourceDist / 343;
    const reflTime     = roomDist   / 343;
    const preDelayTime = Math.max(0.004, Math.min(0.08, reflTime - directTime));
    this.preDelay.delayTime.setTargetAtTime(preDelayTime, this.ctx.currentTime, 0.05);
  }
}
