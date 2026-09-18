/**
 * SpatialMath.js — Coordinate System Helpers for UDIO Spatial Renderer
 *
 * Coordinate convention (Web Audio API standard):
 *   Listener at origin (0, 0, 0)
 *   +X = right
 *   +Y = up
 *   -Z = front (in front of listener)
 *   All distances in meters
 *
 * All source positions must be derived through these helpers —
 * never use hand-picked XYZ constants elsewhere.
 */

/**
 * Convert spherical coordinates to Cartesian (Web Audio convention).
 * @param {number} azimuthDeg  - Horizontal angle in degrees. 0 = front, +90 = right, -90 = left.
 * @param {number} elevationDeg - Vertical angle in degrees. 0 = ear level, +90 = directly above.
 * @param {number} distance     - Distance from listener in meters.
 * @returns {{ x: number, y: number, z: number }}
 */
export function sourceFromSpherical(azimuthDeg, elevationDeg, distance) {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;

  // Project onto unit sphere then scale by distance
  const cosEl = Math.cos(el);
  const x = distance * Math.sin(az) * cosEl;
  const y = distance * Math.sin(el);
  const z = -distance * Math.cos(az) * cosEl; // -Z is front

  return { x, y, z };
}

/**
 * Convert Cartesian coordinates to spherical (azimuth/elevation/distance).
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {{ azimuthDeg: number, elevationDeg: number, distance: number }}
 */
export function cartesianToSpherical(x, y, z) {
  const distance = Math.sqrt(x * x + y * y + z * z) || 0.001;
  const elevationRad = Math.asin(Math.max(-1, Math.min(1, y / distance)));
  const azimuthRad = Math.atan2(x, -z); // -z because front is -Z

  return {
    azimuthDeg: (azimuthRad * 180) / Math.PI,
    elevationDeg: (elevationRad * 180) / Math.PI,
    distance
  };
}

/**
 * Map a normalized width parameter (0–2) to a front-stage azimuth in degrees.
 * Width controls angle only; distance is unchanged by width changes.
 *
 *   width 0.0 → ±15°
 *   width 0.5 → ±22°
 *   width 1.0 → ±30°
 *   width 1.5 → ±52°
 *   width 2.0 → ±75°
 *
 * @param {number} width - Normalized width [0, 2]
 * @returns {number} Azimuth in degrees (positive = right, apply sign for left/right)
 */
export function widthToAzimuth(width) {
  // Piecewise interpolation: subtle at low values, opens up at high values
  const w = Math.max(0, Math.min(2, width));
  if (w <= 1.0) {
    return 15 + w * 15; // 15° → 30°
  } else {
    return 30 + (w - 1.0) * 45; // 30° → 75°
  }
}

/**
 * Compute direct-path gain from distance using inverse-square law,
 * clamped to a reference distance so near-field never exceeds unity.
 *
 * @param {number} distance  - Source distance in meters
 * @param {number} refDist   - Reference distance (gain = 1.0 at this distance)
 * @returns {number} Linear gain [0, 1]
 */
export function distanceGain(distance, refDist = 1.0) {
  return refDist / Math.max(distance, refDist);
}

/**
 * Compute air-absorption low-pass cutoff frequency for a given distance.
 * At near distances: ~18 kHz (essentially full bandwidth).
 * At far distances: cutoff falls toward ~3 kHz.
 *
 * @param {number} distance - Source distance in meters
 * @param {number} nearFreq - Cutoff at reference distance (Hz)
 * @param {number} farFreq  - Minimum cutoff at maximum distance (Hz)
 * @param {number} maxDist  - Distance at which farFreq is reached
 * @returns {number} Lowpass cutoff in Hz
 */
export function airAbsorptionCutoff(
  distance,
  nearFreq = 18000,
  farFreq = 3000,
  maxDist = 20
) {
  const t = Math.max(0, Math.min(1, (distance - 1) / (maxDist - 1)));
  return nearFreq + t * (farFreq - nearFreq);
}

/**
 * Compute a geometry-derived direct-to-reverberant-ratio (DRR) gain.
 * Used to scale early-reflection and late-reverb wet level relative to direct.
 *
 * @param {number} distance - Source distance in meters
 * @param {number} refDist  - Reference distance in meters (DRR = 0 dB here)
 * @returns {number} DRR in dB (negative means more reverberant)
 */
export function computeDRR_dB(distance, refDist = 2.0) {
  return -6 * Math.log2(Math.max(distance, 0.5) / refDist);
}

/**
 * Map a normalized depth parameter (0–1) to a source distance (meters).
 * @param {number} depth - Normalized depth [0, 1]
 * @param {number} near  - Minimum distance (depth=0)
 * @param {number} far   - Maximum distance (depth=1)
 * @returns {number} Distance in meters
 */
export function depthToDistance(depth, near = 0.75, far = 8.0) {
  return near + depth * (far - near);
}
