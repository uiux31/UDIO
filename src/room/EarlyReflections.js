/**
 * EarlyReflections.js — First-Order Image-Source Early Reflection Engine
 *
 * Implements a real (simplified) image-source model for first-order wall reflections.
 *
 * For a shoebox room with dimensions (W × L × H):
 *   The 6 first-order image sources are reflections across each of the 6 walls.
 *   For each image source:
 *     - Position: mirror of source across the wall plane
 *     - Path length: |imagePosition - listenerPosition|
 *     - Delay: pathLength / c  (c = 343 m/s)
 *     - Gain: 1/pathLength × wallReflectionCoeff
 *     - Direction: unit vector from listenerPosition toward imagePosition
 *     - LPF cutoff: decreases with path length (wall absorption + air)
 *     - PannerNode azimuth/elevation: from direction vector
 *
 * The reflection input is the spatialEngine direct output bus
 * (centered + front residual mixed), NOT the Side-only signal.
 *
 * Renderer: Web Audio HRTF PannerNode per reflection tap (6 panners).
 * rolloffFactor = 0 — distance attenuation is computed explicitly.
 */

import { cartesianToSpherical, sourceFromSpherical } from '../spatial/SpatialMath.js';

const SPEED_OF_SOUND = 343; // m/s

export class EarlyReflections {
  /**
   * @param {AudioContext} ctx
   * @param {object} [roomConfig] - Initial room configuration
   */
  constructor(ctx, roomConfig = {}) {
    this.ctx = ctx;

    // Room geometry defaults (meters)
    this.room = {
      width:  roomConfig.width  ?? 6.0,
      length: roomConfig.length ?? 8.0,
      height: roomConfig.height ?? 2.8,
      wallAbsorption: roomConfig.wallAbsorption ?? [0.25, 0.25, 0.20, 0.20, 0.30, 0.30]
      // Absorption per wall: [xMin, xMax, yMin, yMax, zMin, zMax]
    };

    // Listener position (near center of room)
    this.listenerPos = {
      x: this.room.width  * 0.5,
      y: 1.2,  // ear height
      z: this.room.length * 0.55
    };

    // Source position (updated from spatial engine)
    this.sourcePos = {
      x: this.room.width  * 0.5,
      y: 1.2,
      z: this.room.length * 0.3
    };

    // ---- Audio graph ----
    // input: receives the direct source signal
    this.input  = ctx.createGain();
    // output: summed reflections
    this.output = ctx.createGain();

    // Master wet gain (controlled by depth/room amount)
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0.0; // starts silent; set via setAmount()
    this.masterGain.connect(this.output);

    // Build 6 reflection taps (one per wall)
    this._taps = this._buildTaps();

    // Initial geometry computation
    this._updateGeometry();
  }

  /**
   * Build the 6 first-order image-source reflection paths.
   * Each tap: DelayNode → BiquadFilter (LPF) → GainNode → PannerNode → masterGain
   */
  _buildTaps() {
    const taps = [];
    const walls = ['xMin', 'xMax', 'yMin', 'yMax', 'zMin', 'zMax'];

    for (let i = 0; i < 6; i++) {
      const delay = this.ctx.createDelay(1.0); // up to 1s
      delay.delayTime.value = 0.02; // placeholder; updated by _updateGeometry

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 8000;

      const gain = this.ctx.createGain();
      gain.gain.value = 0.0; // placeholder; updated by _updateGeometry

      const panner = this.ctx.createPanner();
      panner.panningModel  = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance   = 1.0;
      panner.rolloffFactor = 0; // we control gain explicitly
      panner.maxDistance   = 100;
      panner.coneInnerAngle = 360;
      this._setPannerPos(panner, 0, 0, -2);

      // Wire up
      this.input.connect(delay);
      delay.connect(filter);
      filter.connect(gain);
      gain.connect(panner);
      panner.connect(this.masterGain);

      taps.push({ delay, filter, gain, panner, wall: walls[i] });
    }

    return taps;
  }

  /**
   * Compute image-source positions and update all tap parameters.
   * Called when room geometry or source/listener position changes.
   */
  _updateGeometry() {
    const { width, length, height, wallAbsorption } = this.room;
    const { listenerPos: L, sourcePos: S } = this;
    const t = this.ctx.currentTime;
    const c = SPEED_OF_SOUND;

    // The 6 first-order image-source positions
    // Each is a mirror of S across one room boundary wall
    const imageSources = [
      { pos: { x: -S.x,           y: S.y,          z: S.z          }, wallIdx: 0 }, // x=0 wall
      { pos: { x: 2*width - S.x,  y: S.y,          z: S.z          }, wallIdx: 1 }, // x=W wall
      { pos: { x: S.x,            y: -S.y,         z: S.z          }, wallIdx: 2 }, // y=0 (floor)
      { pos: { x: S.x,            y: 2*height-S.y, z: S.z          }, wallIdx: 3 }, // y=H (ceiling)
      { pos: { x: S.x,            y: S.y,          z: -S.z         }, wallIdx: 4 }, // z=0 wall (front)
      { pos: { x: S.x,            y: S.y,          z: 2*length-S.z }, wallIdx: 5 }, // z=L wall (rear)
    ];

    imageSources.forEach((img, i) => {
      const tap = this._taps[i];

      // Vector from listener to image source
      const dx = img.pos.x - L.x;
      const dy = img.pos.y - L.y;
      const dz = img.pos.z - L.z;
      const pathLen = Math.sqrt(dx*dx + dy*dy + dz*dz);

      if (pathLen < 0.01) return; // degenerate

      // Delay from path length
      const delayTime = Math.min(pathLen / c, 0.9); // clamped to max buffer
      tap.delay.delayTime.setTargetAtTime(delayTime, t, 0.02);

      // Gain: inverse distance × wall reflection coefficient
      const refl = 1.0 - (wallAbsorption[img.wallIdx] ?? 0.25);
      const rawGain = refl / Math.max(pathLen, 1.0);
      tap.gain.gain.setTargetAtTime(Math.min(rawGain, 0.6), t, 0.02);

      // Low-pass cutoff: wall absorption + simple air absorption
      // Higher absorption → lower cutoff; longer paths lose more HF
      const absCoeff = wallAbsorption[img.wallIdx] ?? 0.25;
      const lpFreq = Math.max(1500, 10000 - absCoeff * 8000 - pathLen * 200);
      tap.filter.frequency.setTargetAtTime(lpFreq, t, 0.05);

      // Direction: listener → image source (listener-relative)
      // Convert to Web Audio Cartesian (listener at origin)
      const normDx = dx / pathLen;
      const normDy = dy / pathLen;
      const normDz = dz / pathLen;

      // Place panner at the direction of the image source, at 2m distance
      // (position encodes direction; gain encodes amplitude)
      this._setPannerPos(
        tap.panner,
        normDx * 2,
        normDy * 2,
        normDz * 2
      );
    });
  }

  _setPannerPos(panner, x, y, z) {
    const t = this.ctx.currentTime;
    if (panner.positionX) {
      panner.positionX.setTargetAtTime(x, t, 0.02);
      panner.positionY.setTargetAtTime(y, t, 0.02);
      panner.positionZ.setTargetAtTime(z, t, 0.02);
    } else if (panner.setPosition) {
      panner.setPosition(x, y, z);
    }
  }

  /**
   * Set room geometry and recompute all reflection paths.
   *
   * @param {object} room
   * @param {number} room.width
   * @param {number} room.length
   * @param {number} room.height
   * @param {number[]} [room.wallAbsorption] - 6-element array [0, 1]
   */
  setRoom(room) {
    Object.assign(this.room, room);
    this._updateGeometry();
  }

  /**
   * Set source position relative to room (used to compute reflection paths).
   * Called by AudioEngine when depth changes.
   *
   * @param {number} depth  - Normalized depth [0, 1]; maps to Z position in room
   */
  setSourceDepth(depth) {
    // Map depth to a position along room length
    // depth=0 → front (z=0.15L), depth=1 → far (z=0.85L)
    this.sourcePos.z = this.room.length * (0.15 + depth * 0.7);
    this._updateGeometry();
  }

  /**
   * Set wet amount (reflections level), 0–1.
   * @param {number} amount
   */
  setAmount(amount) {
    const t = this.ctx.currentTime;
    const wet = Math.max(0, Math.min(1.0, amount)) * 0.6;
    this.masterGain.gain.setTargetAtTime(wet, t, 0.02);
  }
}
