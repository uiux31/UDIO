/**
 * StemRenderer.js — Per-Stem HRTF Spatial Renderer
 *
 * Consumes a SpatialScene JSON (from the AI backend) and renders each stem
 * as an independent, spatially positioned audio source using HRTF PannerNodes.
 *
 * Architecture:
 *   For each source in SpatialScene:
 *     AudioBufferSourceNode → GainNode (directGain) → PannerNode → output
 *                                                   → reverbSend → room
 *
 * All stems are started at the same AudioContext.currentTime for perfect sync.
 *
 * Supports:
 *   - play(), pause(), stop(), seek(fraction)
 *   - Real-time position update from UI (updateSource)
 *   - Graceful teardown (dispose)
 *
 * Width is implemented as a small azimuth offset around the center position,
 * NOT as a gain trick or panner duplication.
 */

import { sourceFromSpherical, widthToAzimuth } from '../spatial/SpatialMath.js';

export class StemRenderer {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} outputBus        - main output (e.g. spatialSum)
   * @param {AudioNode} reverbBus        - late reverb send
   * @param {AudioNode} earlyRefBus      - early reflections send
   */
  constructor(ctx, outputBus, reverbBus, earlyRefBus) {
    this.ctx          = ctx;
    this.outputBus    = outputBus;
    this.reverbBus    = reverbBus;
    this.earlyRefBus  = earlyRefBus;

    // Playback state
    this.isPlaying    = false;
    this.startTime    = 0;     // AudioContext time when play() was called
    this.pauseOffset  = 0;     // seconds into the playback
    this.duration     = 0;

    // Per-stem data
    this._stems  = [];  // { id, buffer, gainNode, reverbSend, panner, sourceNode }
    this._scene  = null;

    // Callback when all stems end
    this.onEnded = null;
  }

  /**
   * Load a SpatialScene JSON and fetch all stem audio buffers.
   * Call this BEFORE play().
   *
   * @param {object} scene  - SpatialScene JSON from backend
   * @returns {Promise<void>}
   */
  async loadScene(scene) {
    this.dispose(); // tear down any existing stems
    this._scene   = scene;
    this.duration = scene.duration || 0;
    this._stems   = [];

    // Set listener position (identity — listener is always at origin)
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
    }

    // Fetch and decode all stem audio in parallel
    await Promise.all(scene.sources.map(source => this._loadStem(source)));

    // Record duration from the longest stem buffer
    const maxDuration = Math.max(
      ...this._stems.filter(s => s.buffer).map(s => s.buffer.duration),
      0
    );
    if (maxDuration > 0) this.duration = maxDuration;
  }

  /**
   * Fetch and decode one stem, create its audio graph nodes.
   * @private
   */
  async _loadStem(source) {
    let buffer = null;
    try {
      const url = source.stemUrl.startsWith('http')
        ? source.stemUrl
        : `http://127.0.0.1:8000${source.stemUrl}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
      const arrayBuffer = await resp.arrayBuffer();
      buffer = await this.ctx.decodeAudioData(arrayBuffer);
    } catch (e) {
      console.error(`StemRenderer: failed to load stem "${source.id}":`, e);
      // Continue without this stem rather than failing the whole render
    }

    // Build per-stem audio graph nodes
    const gainNode  = this.ctx.createGain();
    gainNode.gain.value = source.directGain ?? 0.8;

    const reverbSend = this.ctx.createGain();
    reverbSend.gain.value = source.reverbSend ?? 0.12;

    const panner = this._createHRTFPanner();
    this._positionPanner(panner, source.azimuth, source.elevation, source.distance, source.width);

    // Wiring: gainNode → panner → outputBus
    gainNode.connect(panner);
    panner.connect(this.outputBus);

    // Reverb send: gainNode → reverbSend → reverbBus
    if (this.reverbBus) {
      gainNode.connect(reverbSend);
      reverbSend.connect(this.reverbBus);
    }

    // Early reflection send: gainNode → earlyRefBus (if available)
    if (this.earlyRefBus) {
      gainNode.connect(this.earlyRefBus);
    }

    this._stems.push({
      id:         source.id,
      buffer,
      gainNode,
      reverbSend,
      panner,
      sourceNode: null,  // created fresh on each play()
      scene:      source,
    });
  }

  /**
   * Create one HRTF PannerNode. rolloffFactor = 0 (we control distance explicitly).
   * @private
   */
  _createHRTFPanner() {
    const p = this.ctx.createPanner();
    p.panningModel   = 'HRTF';
    p.distanceModel  = 'inverse';
    p.refDistance    = 1.0;
    p.rolloffFactor  = 0;    // distance attenuation handled explicitly via gain
    p.maxDistance    = 100;
    p.coneInnerAngle = 360;
    return p;
  }

  /**
   * Set panner position from azimuth (deg), elevation (deg), distance (m), width (0-1).
   * Width is realized as a slight azimuth spread — NOT a duplicated source.
   * @private
   */
  _positionPanner(panner, azDeg, elDeg, dist, width = 0) {
    // Width adds a small azimuth offset (max ±15°) using widthToAzimuth
    const widthAzOffset = width * 15;  // small — width is decorrelation, not duplication
    const pos = sourceFromSpherical(azDeg + widthAzOffset * 0.5, elDeg, dist);
    const t = this.ctx.currentTime;
    if (panner.positionX) {
      panner.positionX.setTargetAtTime(pos.x, t, 0.02);
      panner.positionY.setTargetAtTime(pos.y, t, 0.02);
      panner.positionZ.setTargetAtTime(pos.z, t, 0.02);
    } else if (panner.setPosition) {
      panner.setPosition(pos.x, pos.y, pos.z);
    }
  }

  /**
   * Start playback. All stems started at the same AudioContext time for sync.
   */
  async play() {
    if (this.isPlaying) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    const startAt = this.ctx.currentTime + 0.05; // small schedule ahead
    let endedCount = 0;
    const totalStems = this._stems.filter(s => s.buffer).length;

    this._stems.forEach(stem => {
      if (!stem.buffer) return;

      const src = this.ctx.createBufferSource();
      src.buffer = stem.buffer;
      src.connect(stem.gainNode);

      const offset = Math.min(this.pauseOffset, stem.buffer.duration - 0.001);
      src.start(startAt, offset);

      src.onended = () => {
        endedCount++;
        if (endedCount >= totalStems && this.isPlaying) {
          this.isPlaying = false;
          this.pauseOffset = 0;
          if (this.onEnded) this.onEnded();
        }
      };

      stem.sourceNode = src;
    });

    this.startTime = startAt - this.pauseOffset;
    this.isPlaying = true;
  }

  /**
   * Pause playback.
   */
  pause() {
    if (!this.isPlaying) return;
    const raw = this.ctx.currentTime - this.startTime;
    this.pauseOffset = Math.min(Math.max(0, raw), this.duration || 999);
    this._stopAllSources();
    this.isPlaying = false;
  }

  /**
   * Stop and reset.
   */
  stop() {
    this._stopAllSources();
    this.isPlaying   = false;
    this.pauseOffset = 0;
  }

  /**
   * Seek to a normalized fraction (0–1).
   */
  seek(fraction) {
    const wasPlaying = this.isPlaying;
    if (wasPlaying) {
      this._stopAllSources();
      this.isPlaying = false;
    }
    this.pauseOffset = fraction * (this.duration || 0);
    if (wasPlaying) this.play();
  }

  /**
   * Get current playback time in seconds.
   */
  getCurrentTime() {
    if (this.isPlaying) {
      return Math.max(0, Math.min(
        this.ctx.currentTime - this.startTime,
        this.duration || 999
      ));
    }
    return Math.max(0, this.pauseOffset);
  }

  /**
   * Update a source's spatial position in real time.
   * Called when the user moves a UI knob.
   *
   * @param {string} stemId
   * @param {object} params — { azimuth, elevation, distance, directGain, reverbSend, width }
   */
  updateSource(stemId, params) {
    const stem = this._stems.find(s => s.id === stemId);
    if (!stem) return;
    const t = this.ctx.currentTime;

    if (params.directGain !== undefined) {
      stem.gainNode.gain.setTargetAtTime(params.directGain, t, 0.02);
    }
    if (params.reverbSend !== undefined) {
      stem.reverbSend.gain.setTargetAtTime(params.reverbSend, t, 0.02);
    }
    if (
      params.azimuth !== undefined ||
      params.elevation !== undefined ||
      params.distance !== undefined
    ) {
      const az  = params.azimuth   ?? stem.scene.azimuth;
      const el  = params.elevation ?? stem.scene.elevation;
      const d   = params.distance  ?? stem.scene.distance;
      const w   = params.width     ?? stem.scene.width;
      this._positionPanner(stem.panner, az, el, d, w);
    }
  }

  /**
   * Get list of loaded stems with their scene positions.
   * Used by the UI to populate stem cards.
   */
  getStems() {
    return this._stems.map(s => ({
      id:    s.id,
      scene: s.scene,
      loaded: !!s.buffer,
    }));
  }

  /**
   * Stop all active BufferSourceNodes.
   * @private
   */
  _stopAllSources() {
    this._stems.forEach(stem => {
      if (stem.sourceNode) {
        stem.sourceNode.onended = null;
        try { stem.sourceNode.stop(); } catch { /* not started */ }
        stem.sourceNode = null;
      }
    });
  }

  /**
   * Disconnect all nodes and release buffers.
   */
  dispose() {
    this._stopAllSources();
    this._stems.forEach(stem => {
      try { stem.gainNode.disconnect();   } catch { /* ignore */ }
      try { stem.reverbSend.disconnect(); } catch { /* ignore */ }
      try { stem.panner.disconnect();     } catch { /* ignore */ }
    });
    this._stems  = [];
    this._scene  = null;
    this.isPlaying   = false;
    this.pauseOffset = 0;
  }
}
