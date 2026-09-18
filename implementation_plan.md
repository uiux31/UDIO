# UDIO — Audio Engine Refactor Implementation Plan

## Goal

Refactor UDIO from a physically incorrect "copy stereo to many HRTF positions" architecture into a physically coherent source-object spatial renderer with a deterministic room model, safe speaker renderer, honest labels, and proper dynamics — all as specified in `solution.md`.

> [!IMPORTANT]
> This is a **full replacement** of the core DSP architecture, not incremental patching. The existing `SpatialEngine.js`, `RoomSimulator.js`, and `DynamicsProcessor.js` will be completely rewritten. The UI and all knobs are preserved.

---

## Proposed Changes

### Module Restructuring (new directory layout)

#### [NEW] `src/spatial/SpatialMath.js`
Coordinate helpers: `sourceFromSpherical(az, el, dist)`, `cartesianToSpherical(x,y,z)`. Defines a clean coordinate system (listener at origin, +X=right, +Y=up, -Z=front).

#### [NEW] `src/spatial/SceneAnalyzer.js`
Per-block M/S coherence analysis:
- FFT-based inter-channel coherence `|S_LR| / sqrt(S_LL * S_RR)`
- Mid/Side energy ratio per band
- `centerConfidence` heuristic
- `sideRatio` → drives ambience source gain

#### [NEW] `src/spatial/SceneGenerator.js`
Converts analyzer output + UI params into 3–5 source objects:
1. **center** — Mid × centerConfidence, az=0°, el=0°
2. **front-left** — residual L, az from width mapping
3. **front-right** — residual R, az from width mapping
4. **ambience-left** — high-passed Side, az=−90°
5. **ambience-right** — high-passed Side, az=+90°

Width maps to azimuth: 0→±15°, 0.5→±30°, 1.0→±45°, 2.0→±90° (angle only, distance fixed).

#### [MODIFY] `src/engine/SpatialEngine.js` → **Full rewrite**
New coherent headphone renderer:
- One `PannerNode` per source object (max 5 panners vs current 9+)
- `rolloffFactor = 0`, custom distance model outside PannerNode
- Depth controls: distance attenuation + DRR + HF air absorption filter
- Focus controls: centerConfidence coefficient (not gain-only)
- Elevation: actually moves panner Y coordinate, height gain only when elevation > 0
- Accurate comments: "Browser Web Audio HRTF" (not "KEMAR")
- Speaker mode: safe M/S width matrix only, no uncalibrated XTC label

#### [NEW] `src/room/EarlyReflections.js`
First-order image-source room model:
- Inputs: room W/L/H, source position, listener position, wall absorption[6]
- Generates 6 image-source positions with correct path delays: `T = pathLength / c`
- Gain: `1/path × reflectionCoeff`
- Each tap has correct azimuth/elevation from image-source → listener vector
- LPF per tap based on wall absorption
- Each tap feeds its own PannerNode (correct direction)

#### [MODIFY] `src/engine/RoomSimulator.js` → **Full rewrite**
Replace random-noise IR with deterministic FDN (Feedback Delay Network) reverb:
- 4 feedback delay lines with prime-ish delays
- Feedback mixing matrix (Hadamard-like)
- Damping filters per line
- `convolver.normalize = false` explicitly
- RT60-like decay control
- Pre-delay derived from geometry (not hardcoded 15ms)

#### [MODIFY] `src/engine/DynamicsProcessor.js` → **Full rewrite**
Replace parallel WaveShaper with `DynamicsCompressorNode` + true-peak soft limiter:
- `DynamicsCompressorNode`: threshold −18 dB, ratio 4:1, attack 5ms, release 100ms
- Optional gentle saturation via WaveShaper (explicitly labeled)
- WaveShaper only for final soft clip, not as "limiter"

#### [MODIFY] `src/engine/AudioEngine.js`
Fix signal chain order (critical):
```
Input → EQ cleanup → Scene Analysis → Direct Renderer
                                     ├→ Early Reflections
                                     └→ Late FDN Reverb
                                     ↓
                                 Spatial Sum
                                     ↓
                              DynamicsCompressor
                                     ↓
                                Soft Limiter
                                     ↓
                                 Metering
                                     ↓
                               Destination
```
Also fix:
- `play()` awaits `resume()`
- `pauseOffset` clamped to buffer duration
- `loadFile()` stops stream before loading
- URL object revocation

#### [MODIFY] `src/presets.js`
Rename all presets to truthful names per solution.md §27:
- `3D Holographic` → `Wide Binaural`
- `Cinema 7.1 Surround` → `Cinema Wide`
- `Spatial Music (85/15 Blend)` → `Music Wide`
- `Laptop Speaker Expander` → `Laptop Safe`
- `Vocal Clarity & Dialogue` → `Vocal Focus`
- `Concert Hall Immersion` → `Large Room`
- `Bass Immersion` → `Bass Assist`
Remove Dolby Atmos brand claim from preset descriptions.

#### [DELETE] `src/engine/StereoWidener.js`
Dead code (not imported anywhere). Removed per solution.md §1.18.

#### [MODIFY] `src/main.js` (minimal)
- Fix URL revocation on file load
- Update UI labels: "Stereo Width" → "Stage Width", "Spatial Depth" → "Depth"
- Add backend status badge: "Renderer: Browser HRTF | Mode: Headphones"
- Remove Dolby Atmos/KEMAR claims from any display text

---

## What Is NOT Changing (out of scope for this iteration)

- AudioWorklet migration (P1)
- Explicit SOFA HRTF dataset loading (P1)
- Head tracking (P1)
- Speaker calibration workflow (P1/P2)
- Source separation / AI (P2)
- Full automated DSP test suite (P1 — but basic determinism achieved by removing randomness)

---

## Verification Plan

### Automated
- The random IR is eliminated → **determinism** guaranteed by construction
- `node --check` passes on all files
- `npm run dev` serves without errors

### Manual (in browser)
1. Load a mono test tone → confirm it stays centered
2. Load a stereo track → confirm coherent spatializaton, no vague cloud
3. Toggle room off → confirm no reflections bleed through
4. Toggle bypass → confirm loudness matched (rough check)
5. Check backend status badge shows "Browser HRTF" not "KEMAR"
6. Check preset names are accurate

---

## Open Questions

> [!NOTE]
> The Bass Enhancer and Equalizer modules have minor issues (§4, §5) but are **not blocking** P0 fixes. They will be left mostly intact with minor comment corrections to avoid scope creep.

> [!NOTE]
> The FDN reverb replaces the random IR. A full geometry-aware pre-delay requires knowing source distance, which will be approximated from the Depth control value.
