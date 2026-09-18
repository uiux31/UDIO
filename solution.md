# UDIO — Full 3D Audio Audit, Defect List, and Free Implementation Specification

**Target:** the uploaded `UDIO.zip` project

**Purpose:** This document is an implementation handoff for Antigravity. It is intentionally detailed. Treat the items below as engineering requirements, not optional suggestions.

> **Important scope note:** this is a static/code + architecture audit of the uploaded project, supplemented with current Web Audio/open-source references. I did not perform a controlled listening test on the user's hardware, head/ear measurements, laptop speaker measurements, or a calibrated acoustic room test. Therefore, claims about perceived localization are engineering predictions, while the code defects are directly observable.

---

## 0. Executive diagnosis

The current project is not failing because it needs “more 3D effects.” The main failure is architectural:

1. A normal stereo mix is being treated as if it were already a multichannel/object scene.
2. The same audio information is copied into several virtual positions and summed, producing overlapping images rather than one coherent spatial scene.
3. “Height” is synthesized mostly by filtering Side (L-R) content around 6.5 kHz and moving that filtered signal upward. That is not a valid general elevation reconstruction method.
4. The headphone path uses browser `PannerNode` HRTF panners, but the comments claim a specific “KEMAR” renderer. The code never loads a KEMAR HRTF or a user/preset-specific HRTF dataset.
5. The room/reflection system is described as Image Source Method (ISM), but the implementation uses fixed arbitrary delays/filters and does not calculate image sources from room geometry.
6. The speaker XTC system is not a calibrated transaural system. Fixed 150/180 µs delays and fixed cancellation gains cannot compensate for the actual acoustic transfer paths of an arbitrary laptop.
7. Several DSP modules run before spatialization, and some of them modify the spatial cues they are later supposed to preserve.
8. The “Dynamics” module is actually a parallel nonlinear WaveShaper path, not a conventional compressor/limiter.
9. The generated room IR is random noise and is not a room impulse response with physically meaningful direct/early reflection structure.
10. The application has no automated audio quality tests, no phase/correlation diagnostics, no HRTF verification, no speaker-calibration workflow, and no regression fixtures.

The strongest free path forward is:

**Headphones:**
`stereo analysis → conservative scene extraction → mono source objects → geometry → calibrated HRTF/HRIR rendering → early reflections → late reverb → gentle output limiting`

**Laptop speakers:**
`stereo/scene analysis → virtual loudspeaker or binaural target → speaker transfer-function measurement/calibration → regularized 2×2 inverse/XTC filter → physical speakers`

Do **not** attempt to make the current arbitrary delay/gain XTC “more aggressive.” Replace it with a measured/corrected model, and gracefully fall back to a safe stereo widening mode when calibration is unavailable.

---

# 1. Direct code findings

## 1.1 Critical: the core stereo-to-3D model is conceptually wrong

**File:** `src/engine/SpatialEngine.js` lines 60–195 and 441–480.

The input is split into Left/Right and Mid/Side, then the same mix is independently sent into:

- Center HRTF
- Front-left HRTF
- Front-right HRTF
- Left side HRTF
- Right side HRTF
- Height-left HRTF
- Height-right HRTF
- six “ISM” reflections

This is not a valid reconstruction of a unique 3D sound scene. It is a multi-path remix of the same stereo material.

### Fix
Create a scene-analysis stage that decides **which information becomes which source object**. The default non-AI browser path should remain conservative:

- `Mid` → center/front object
- `Side` → lateral ambience/stereo object
- optional low-frequency mono object
- optional transient/ambience split only when confidence is high

Do not render the entire Mid and entire Side simultaneously at many unrelated positions.

### Acceptance test
A centered mono test tone must remain a single stable phantom/virtual source rather than becoming a large cloud of coincident HRTF outputs.

---

## 1.2 Critical: the code falsely claims “KEMAR HRTF”

**File:** `src/engine/SpatialEngine.js` lines 10 and 344–355.

The helper is named/commented as a “high-resolution KEMAR HRTF PannerNode,” but the code only does:

```js
const panner = this.ctx.createPanner();
panner.panningModel = 'HRTF';
```

No KEMAR file is loaded. No KEMAR HRIR set is parsed. No explicit HRTF coefficients are installed.

Browser `PannerNode` HRTF rendering is based on the browser's implementation and measured HRTF data; it is not proof that a KEMAR dataset is used. MDN documents that `panningModel = "HRTF"` selects an HRTF spatialization algorithm using measured impulse responses, but it does not imply that a KEMAR dataset is exposed to the application. https://developer.mozilla.org/en-US/docs/Web/API/PannerNode/panningModel

### Fix
Rename comments and documentation to “Web Audio HRTF” until an explicit HRTF dataset is actually loaded.

For a professional path, implement an explicit HRIR/HRTF backend using a permitted dataset, ideally in SOFA/SimpleFreeFieldHRIR form. SOFA is a standard for spatially oriented acoustic data, including HRTFs and BRIRs. https://github.com/sofacoustics/SOFAtoolbox

### Acceptance test
A debug panel must report the actual HRTF backend:

- Browser PannerNode HRTF
- Bundled explicit HRTF dataset
- User-loaded HRTF dataset
- Fallback equal-power stereo

---

## 1.3 Critical: source positions are arbitrary and physically inconsistent

Examples:

- Front: `(-2.0, 0.1, -1.8)` / `(2.0, 0.1, -1.8)`
- Side: `(-3.2, 0.2, 0)` / `(3.2, 0.2, 0)`
- Height: `(-1.8, 2.4, -0.8)` / `(1.8, 2.4, -0.8)`
- Reflection: `(-2.4, 0.4, 1.2)` / `(2.4, 0.4, 1.2)`

These positions are not derived from a defined room, speaker layout, reference distance, or source localization model.

### Fix
Define one coordinate convention and use normalized geometry:

- listener at `(0, 0, 0)`
- +X = right
- +Y = up
- -Z = front
- all source coordinates expressed in meters
- angular placement generated from azimuth/elevation/range, not hand-picked XYZ constants

Implement helpers:

```text
sourceFromSpherical(azimuthDeg, elevationDeg, distance)
cartesianToSpherical(x, y, z)
relativeSourceToHead(source, listenerPose)
```

The Web Audio PannerNode uses Cartesian position axes for left-right, vertical, and depth. https://developer.mozilla.org/en-US/docs/Web/API/PannerNode/positionX https://developer.mozilla.org/en-US/docs/Web/API/PannerNode/positionY https://developer.mozilla.org/en-US/docs/Web/API/PannerNode/positionZ

---

## 1.4 Critical: `distanceModel = inverse` creates uncontrolled attenuation

**File:** `SpatialEngine.js` `_createHRTFPanner()`.

Every PannerNode uses:

```js
panner.distanceModel = 'inverse';
panner.refDistance = 1.0;
panner.rolloffFactor = 0.8;
```

Because source positions are several meters away, the browser itself attenuates the sources. Then custom gain boosts are applied. This makes level matching unstable and can change timbre/subjective distance in ways unrelated to the UI controls.

MDN documents the inverse distance model and its attenuation equation. https://developer.mozilla.org/en-US/docs/Web/API/PannerNode/distanceModel

### Fix
For a perceptual spatializer with its own distance model, start with:

```text
refDistance = 1 m
rolloffFactor = 0
(or a deliberately designed distance attenuation outside PannerNode)
```

Use one explicit distance model in the engine instead of mixing hidden PannerNode attenuation with arbitrary gains.

---

## 1.5 Critical: “Width” changes physical distance, not just angular width

**File:** `SpatialEngine.js` `_updateDSP()` lines 450–465.

For width changes, `frontX`, `sideDistance`, and gains are all changed simultaneously. This makes the Width knob affect:

- source angle
- source distance
- level
- number of energy paths

The control therefore has no single psychoacoustic meaning.

### Fix
Make Width control **azimuth/spread** only. Keep distance fixed.

Suggested normalized mapping:

```text
width 0.0 → ±15°
width 0.5 → ±30°
width 1.0 → ±45°
width 1.5 → ±65°
width 2.0 → ±90°
```

Do not change range unless Depth is explicitly changed.

---

## 1.6 Critical: “Depth” is not real depth

**File:** `SpatialEngine.js` lines 449–479.

Current Depth changes front source distance and early-reflection gain. This is insufficient for distance perception.

### Fix
Depth should control a coordinated set of cues:

1. direct-path level / distance attenuation
2. direct-to-reverberant ratio (DRR)
3. high-frequency air absorption
4. reflection onset and energy
5. optional interaural cue adjustments when geometry changes

Use a defined distance function such as:

```text
r = rMin + depth * (rMax - rMin)
Gdistance = rMin / max(r, rMin)
```

and a separate high-frequency damping filter whose cutoff decreases as distance increases.

Do not call a gain change “externalization.”

---

## 1.7 Critical: Height synthesis is not actual elevation reconstruction

**File:** `SpatialEngine.js` lines 141–161 and 468–476.

The project takes Side energy, runs a band-pass around 6.5 kHz, then duplicates/inverts it into elevated HRTF positions.

That creates an added high-frequency layer, but it does not reconstruct an actual elevated source.

Elevation is strongly dependent on direction-dependent spectral coloration contained in the HRTF/HRIR, not simply “more 6.5 kHz.”

### Fix
When no real height information exists in a stereo recording, use one of two honest modes:

**Mode A — Conservative:** keep height at zero unless a reliable classifier detects material suitable for elevation enhancement.

**Mode B — Artistic height:** intentionally remap selected ambience/transient energy to elevated positions, clearly treated as creative upmixing.

For explicit HRTF rendering, choose HRIRs at the target elevation and interpolate between measured directions.

---

## 1.8 Critical: the “ISM” is not Image Source Method

**File:** `SpatialEngine.js` lines 163–196.

The implementation uses six fixed delays, fixed low-pass frequencies, fixed gains, and two fixed rear-lateral panners.

True Image Source Method requires room geometry and reflection path computation. A reflection's delay is derived from path length:

```text
T = pathLength / c
```

and reflection gain should depend on distance and surface/reflection coefficients.

### Fix
Implement a real shoebox image-source model first:

Inputs:

- room width
- room depth
- room height
- source position
- listener position
- wall absorption/reflection coefficients
- reflection order limit

Generate mirror/image positions, compute path lengths, directions, delays and gains, then render those reflection paths.

For browser performance, start with first-order reflections and a maximum of 6–12 early taps.

---

## 1.9 Critical: the reflection input is the Side-only signal

**File:** `SpatialEngine.js` line 191.

All ISM taps originate from `sideHighPass`, meaning the “room” is made mostly from stereo-difference content rather than the direct source.

### Fix
Early reflections should originate from the **spatialized direct source objects**, not exclusively from the side component.

A source's early reflections are derived from that source's direct sound and geometry.

---

## 1.10 Critical: reflection directions do not correspond to computed wall hits

The code alternates between two panners:

```text
(-2.4, 0.4, 1.2)
(+2.4, 0.4, 1.2)
```

A real room does not produce “left reflection / right reflection” merely by alternating six taps.

### Fix
Each tap must carry:

```text
position
azimuth
elevation
delay
gain
frequency-dependent absorption
```

and be generated from an actual wall/image-source path.

---

## 1.11 Critical: side signal uses phase inversion as a localization mechanism

**File:** `SpatialEngine.js` lines 129–139.

```js
sideSpreadGainL.gain = +1
sideSpreadGainR.gain = -1
```

The Side signal already represents `(L-R)/2`. Inverting it again on one branch is not a general-purpose “true lateral dipole.”

### Fix
Treat Mid and Side mathematically as:

```text
M = 0.5(L + R)
S = 0.5(L - R)
L = M + S
R = M - S
```

Use Side as a source-width/ambience input only when appropriate. Do not assume phase inversion creates a physically located object.

---

## 1.12 Critical: Mid and Side are being mixed with multiple direct copies

The center path receives M, while front L/R receive original L/R. Therefore center material exists in all of these paths.

### Result
A centered vocal can be rendered by:

- center HRTF
- front-left HRTF
- front-right HRTF
- reflection paths
- room reverb later

This is exactly the kind of energy duplication that makes localization vague.

### Fix
Introduce a **center extraction coefficient**:

```text
center = M * centerConfidence
frontStereo = residualized stereo signal
```

and avoid rendering the full M plus full L/R simultaneously.

Start with:

```text
center branch = M * 0.6 to 1.0
front stereo residual = original stereo - controlled center contribution
```

Use a decorrelated residual only when necessary.

---

## 1.13 Critical: “Focus” is only an amplitude boost

**File:** `SpatialEngine.js` lines 445–448.

```js
const centerLevel = 0.65 + this.centerFocus * 0.45;
```

This changes gain; it does not change source coherence or localization confidence.

### Fix
Focus should primarily alter:

- center-source amount
- center coherence
- width of the center source
- optional 1–3 kHz clarity EQ by a very small amount

Do not use a gain-only implementation.

---

## 1.14 Critical: speaker XTC is not actual XTC

**File:** `SpatialEngine.js` lines 233–259 and 495–499; also `StereoWidener.js`.

Current model:

```text
opposite channel → fixed band-pass → fixed delay → fixed negative gain
```

XTC requires cancellation of acoustic crosstalk after the audio leaves the speakers, i.e. the inverse of the listener/speaker acoustic transfer matrix.

A conceptual 2×2 system is:

```text
[yL]   [hLL hLR] [xL]
[yR] = [hRL hRR] [xR]
```

The renderer seeks a filter matrix whose output approximately inverts that transfer function over a useful frequency range, typically with regularization to avoid unstable gain.

### Fix
Implement a calibrated 2×2 regularized inverse filter. Do not assume one global delay and one global gain.

Fallback when calibration is absent:

- normal stereo
- gentle speaker widening using M/S
- no “XTC” label

---

## 1.15 Critical: the 180 µs value is not “the acoustic transit time across the head between laptop speakers”

There are multiple propagation paths:

- speaker-to-near ear
- speaker-to-far ear
- speaker spacing
- listener-to-speaker geometry
- head size
- device placement

A single 180 µs number is not enough to model this.

### Fix
Make XTC delay an output of calibration, not a constant.

Estimate acoustic path delay from measured impulses and optionally initialize with a rough geometric estimate only before calibration.

---

## 1.16 Critical: band-limiting XTC to one bandpass is too simplistic

**File:** `SpatialEngine.js` 233–251 and `StereoWidener.js` 36–43.

A 1400 Hz bandpass with Q 0.5 does not implement a broadband crosstalk inverse.

### Fix
Use a frequency-dependent FIR/IIR inverse designed from measured transfer functions.

For a first free prototype:

- measure 2×2 transfer paths
- FFT each path
- compute regularized frequency-domain inverse
- IFFT the filters
- window/truncate to a stable FIR
- partition for real-time convolution

Use Tikhonov regularization / diagonal loading to avoid huge gains near matrix singularities.

---

## 1.17 Critical: XTC and Haas are combined without a physical target field

The speaker mode combines:

- direct L/R
- Mid
- Side shuffler
- XTC
- Haas

but there is no definition of the desired virtual source positions.

### Fix
Define speaker mode as one of:

1. **Stereo expansion mode** — artistic, safe.
2. **Calibrated transaural mode** — physically targeted.

Do not blend them as if they were interchangeable stages.

---

## 1.18 Major: `StereoWidener.js` is dead code

It is not imported anywhere in the current source tree.

### Fix
Delete it, or make it the single official speaker renderer. There must be one source of truth for speaker-mode DSP.

If the new architecture replaces it, remove it to prevent future confusion.

---

## 1.19 Major: the comments claim “Blumlein Stereo Shuffler,” but the implementation is not a complete Blumlein shuffle

**File:** `SpatialEngine.js` 210–230.

A real M/S shuffler is based on controlled sum/difference matrix operations and frequency-dependent weighting. A single lowshelf applied to Side does not constitute the full algorithm.

### Fix
Implement the actual matrix:

```text
M' = M
S' = k(f) S
L' = M' + S'
R' = M' - S'
```

where `k(f)` is the designed frequency-dependent side gain.

Keep gain changes modest and loudness-match against bypass.

---

## 1.20 Major: +7.5 dB Side lowshelf is far too aggressive as a fixed correction

**File:** `SpatialEngine.js` 214–215.

This is an artistic tonal change, not a device-independent acoustic correction.

### Fix
Start at 0 dB and expose the side-EQ correction only as a small optional control, or derive it from calibration.

---

## 1.21 Major: Haas delay path is mislabeled as “rear width/depth”

**File:** `SpatialEngine.js` 261–274; `StereoWidener.js` 64–80.

A 16/22 ms delayed copy can alter localization, image width, comb filtering and coloration. It does not directly represent rear reverberation or true depth.

### Fix
Rename it to “decorrelated ambience” if retained. Use it sparingly, high-passed, low in level, and preferably fed from an ambience/residual signal rather than the full Side signal.

---

## 1.22 Major: Haas gains are signed incorrectly for the intended effect

The implementation uses opposite signs:

```js
haasGainL = +gain
haasGainR = -gain
```

while routing Left→Right and Right→Left.

This can create cancellation/phase interactions rather than a clean decorrelated ambience field.

### Fix
For decorrelation, use positive crossfeed gains unless a specific phase-inversion scheme is scientifically justified and tested. Prefer all-pass/filter-based decorrelation rather than simple negative-gain copies.

---

## 1.23 Major: `setTargetAtTime()` is used as a universal parameter smoother with 20 ms time constants

This is acceptable for UI controls, but not necessarily for spatial movement or fast A/B switching.

### Fix
For spatial trajectories:

- schedule points with `setValueAtTime`/ramps
- use short smoothing for UI only
- use proper interpolation for source trajectories
- do not add 20 ms of unwanted lag to every positional change

For head tracking, update the source/listener pose at a controlled rate while the audio engine interpolates state.

---

## 1.24 Major: no head tracking

The research notes correctly identify dynamic head motion as important, but the current application has no sensor/head-tracking integration.

### Fix — free-first options
Stage 1:

- desktop: mouse/touch orientation control
- mobile: DeviceOrientation API where permitted

Stage 2:

- WebXR pose when available
- optional external tracker integration

The renderer must convert listener orientation to source-relative azimuth/elevation before HRTF lookup.

---

# 2. Audio graph problems

## 2.1 Critical: room reverb is inserted before spatial rendering

**File:** `AudioEngine.js` lines 88–100.

Current:

```text
Bass → EQ → RoomSimulator → SpatialEngine → Dynamics
```

This means the RoomSimulator generates a stereo room signal before the spatial engine positions content.

### Fix
Use:

```text
Bass/EQ (optional) → Scene Analysis → Direct Spatial Renderer
                                  ├→ Early Reflection Renderer
                                  └→ Late Reverb
                                  ↓
                              Spatial Sum
                                  ↓
                             Master Dynamics
```

The room model needs the source geometry; therefore room rendering belongs conceptually with or after source geometry, not as a generic stereo effect before spatialization.

---

## 2.2 Critical: pre-spatial Bass/EQ can damage localization cues

Bass enhancement and broad EQ are currently before spatialization.

### Fix
Separate processing into:

- input correction / safe cleanup
- spatial rendering
- post-spatial tone shaping
- output protection

Never apply strong nonlinear coloration before HRTF rendering unless intentional.

---

## 2.3 Major: Dynamics is after spatial rendering but implemented as parallel nonlinear processing

**File:** `AudioEngine.js` 94–100; `DynamicsProcessor.js`.

Current graph inside Dynamics:

```text
input → dry
input → drive → WaveShaper → HPF → makeup → wet
then dry + wet are summed
```

This is a parallel nonlinear distortion/saturation blend, not a conventional transparent limiter/compressor.

### Fix
Replace with:

```text
spatial sum → optional gentle compressor → true peak limiter → output
```

Use Web Audio `DynamicsCompressorNode` for a free browser-native baseline, or implement a proper envelope-following compressor in AudioWorklet. `DynamicsCompressorNode` is specifically intended for dynamic control and clipping/distortion prevention. https://developer.mozilla.org/en-US/docs/Web/API/DynamicsCompressorNode

---

## 2.4 Major: the current “soft-knee” WaveShaper is not a transparent limiter

`WaveShaperNode` applies a static nonlinear transfer curve. It has no release, attack, gain-reduction envelope, or lookahead.

Therefore the code comment “transparent mastering limiter” is misleading.

### Fix
Use:

- RMS/peak detector
- attack 1–5 ms
- release 50–200 ms
- lookahead 1–5 ms if implemented in worklet
- ratio high enough to cap peaks
- optional soft clip after limiter

Use WaveShaper only for optional saturation/soft clipping.

`oversample = "4x"` is valid and reduces some aliasing for nonlinear shaping, but oversampling does not turn a static Waveshaper into a limiter. https://developer.mozilla.org/en-US/docs/Web/API/WaveShaperNode/oversample

---

## 2.5 Major: limiter is placed after `masterGain`, but VU meters are connected before it

**File:** `AudioEngine.js` lines 97–105.

The analyzers see `masterGain`, not the post-limiter signal.

### Fix
Provide two metering points:

- pre-limit peak/RMS meter
- post-limit output meter

The UI should clearly distinguish them.

---

## 2.6 Major: no loudness matching between processed and bypass paths

The bypass path is raw input while processed path may include gain changes, room, bass enhancement, HRTF, and limiter.

A/B comparison becomes misleading if processed audio is louder.

### Fix
Implement short-term loudness/energy matching before A/B comparison. A simple free first step:

- compute RMS over 300–1000 ms windows
- match integrated gain within ±0.5 dB

Advanced stage: implement EBU R128-style loudness measurement.

---

## 2.7 Major: “equal-power 30 ms” is not what the current `setTargetAtTime` implementation guarantees

`setTargetAtTime()` uses an exponential approach. It is not a precise 30 ms equal-power crossfade.

### Fix
For A/B:

```text
processed = cos(theta)
 bypass   = sin(theta)
```

or vice versa, with a deterministic 20–50 ms ramp.

---

# 3. RoomSimulator problems

## 3.1 Critical: random-noise IR is not a physical room IR

**File:** `RoomSimulator.js` lines 63–94.

The IR is generated using `Math.random()` samples multiplied by an exponential envelope.

This produces a diffuse noise tail, not a physically meaningful room impulse response.

### Fix
Use either:

**A. Free algorithmic reverb**

- Schroeder/Moorer/FDN structure
- deterministic coefficients
- early reflection taps from geometry
- late diffuse tail with controlled feedback

**B. Real impulse response**

- load a properly licensed room IR
- normalize it yourself
- use it via ConvolverNode

The current random generator should not be called “natural room IR.”

---

## 3.2 Major: `Math.random()` makes startup output nondeterministic

Two runs of the same track/settings generate different room responses.

This makes quality testing impossible.

### Fix
Use a seeded deterministic PRNG if procedural reverb is retained, or design a fixed stable network.

---

## 3.3 Major: the ConvolverNode normalizes the IR by default

**File:** `RoomSimulator.js` line 31.

`ConvolverNode.normalize` defaults to true. The browser can equal-power normalize the IR when it is assigned, which changes the relation between the generated IR amplitude and the wet gain. https://developer.mozilla.org/en-US/docs/Web/API/ConvolverNode/normalize

### Fix
For a hand-designed measured/algorithmic IR with known energy, explicitly choose normalization policy.

If the IR is already gain-calibrated:

```js
convolver.normalize = false;
```

Set this **before** assigning `buffer`.

---

## 3.4 Major: there is no direct path geometry in the room engine

The current reverb has no source/listener position or room dimensions.

### Fix
Create `RoomModel` containing:

```text
width
length
height
wallAbsorption[6]
ceilingAbsorption
floorAbsorption
airAbsorption
```

and calculate first-order reflection geometry.

---

## 3.5 Major: pre-delay of 15 ms is hard-coded regardless of source distance

A fixed pre-delay can produce unnatural spacing for near sources and insufficient separation for far sources.

### Fix
Tie the pre-delay to direct-vs-reflected path difference:

```text
preDelay = max(0, reflectedPath/c - directPath/c)
```

Clamp it to a sane range for performance.

---

## 3.6 Major: reverb wet amount is capped at 45% but not energy-normalized

A percent UI control does not map directly to acoustic reverberation.

### Fix
Map the UI to a calibrated wet/dry ratio and enforce output RMS/peak compensation.

---

## 3.7 Major: “dynamic damping” is not true air absorption

The reverb low-pass changes from 7.5 kHz to 4.5 kHz based on room amount, not source distance or wall material.

### Fix
Separate:

- air absorption = distance-dependent
- wall absorption = reflection-path-dependent
- reverb coloration = room-material-dependent

---

# 4. BassEnhancer problems

## 4.1 Major: bass enhancement is always present in the graph even when amount is 0

At amount 0, wet gain is 0, so this is functionally bypassed, but the nonlinear path still consumes CPU.

### Fix
When amount is zero, disable the path or use a bypass switch if performance testing shows it matters.

---

## 4.2 Major: the “missing fundamental” claim is too strong

The nonlinear waveshaper does generate harmonics, but the result is not guaranteed to reconstruct the perception of a missing fundamental for arbitrary music.

### Fix
Document it as “harmonic bass enhancement inspired by missing-fundamental perception.”

---

## 4.3 Major: high-pass at 150 Hz does not guarantee fundamental removal

The bass source is low-passed at 200 Hz, then harmonics are high-passed at 150 Hz. This allows substantial overlap with the original bass band.

### Fix
For a clean harmonic enhancer:

```text
bass = LPF 120–180 Hz
harmonics = nonlinear(bass)
harmonics = HPF 180–250 Hz
```

and tune based on the target speaker.

---

## 4.4 Major: fixed +3 dB peaking EQ at 300 Hz can add mud

This is not a spatial enhancement and can reduce clarity.

### Fix
Default to 0 dB and tune per playback device only if measurements justify it.

---

## 4.5 Major: no anti-alias test for nonlinear bass generation

4× WaveShaper oversampling helps but does not eliminate every aliasing issue.

### Fix
Add offline FFT tests and compare harmonics at known input frequencies.

---

# 5. Equalizer problems

## 5.1 Major: EQ can be strongly positive by presets, raising clipping risk before nonlinear stages

Several presets add multiple positive dB boosts while Dynamics is also adding gain.

### Fix
Use a global pre-DSP headroom target, for example:

```text
keep 6 dB internal headroom minimum
```

and compensate gain after EQ.

---

## 5.2 Minor: `Q` values on shelf filters are not meaningful in the same way as peaking filters

UI/model documentation calls this a “parametric EQ” while it is really a fixed 5-band tonal EQ.

### Fix
Rename documentation to “5-band EQ,” or implement a proper parametric API with user-controlled frequency/Q/gain.

---

# 6. Audio ingestion/playback problems

## 6.1 Major: loading a file while streaming does not stop the capture tracks

**File:** `AudioEngine.js` `loadFile()` calls `this.stop()`.

`stop()` disconnects the media source when streaming, but it does not stop the `MediaStream` tracks.

### Fix
`loadFile()` should first call:

```text
if (isStreaming) stopStream()
else stop()
```

so the browser capture is fully released.

---

## 6.2 Major: source lifecycle is not centralized

Playback, file source, and streaming source all share `sourceNode` with different lifecycle rules.

### Fix
Create:

```text
SourceManager
  createBufferSource()
  createMediaStreamSource()
  disposeCurrentSource()
```

and make every mode use it.

---

## 6.3 Major: `play()` does not await `resume()`

**File:** `AudioEngine.js` line 284.

The method calls `this.resume()` but does not await it.

### Fix
Make `play()` async and await context resume before scheduling playback.

---

## 6.4 Major: `pauseOffset` can drift near the end of the track

A custom `currentTime` from the AudioContext should be clamped to buffer duration.

### Fix
Clamp:

```text
pauseOffset = min(max(0, pauseOffset), duration)
```

---

## 6.5 Major: WaveSurfer is used as a second playback clock

WaveSurfer uses its own MediaElement backend while `AudioEngine` uses a BufferSource. WaveSurfer volume is set to 0, so it is not the audible source, but it still maintains another timeline and decoding path.

### Fix
Use WaveSurfer strictly for waveform/interaction visualization, not an active playback clock, or drive it entirely from the AudioEngine clock.

A better architecture is:

```text
AudioEngine owns time
Waveform follows AudioEngine time
```

---

## 6.6 Major: URL object is never revoked

**File:** `main.js` line 756.

`URL.createObjectURL(file)` is created but not revoked.

### Fix
Store URL and call `URL.revokeObjectURL()` on file replacement/unload.

---

## 6.7 Major: `wavesurfer.destroy()` can occur while object URL remains live

Covered by the same URL lifecycle fix.

---

## 6.8 Minor: input file handling has no format/size validation

### Fix
Reject/handle unsupported or very large files gracefully. Display a user-facing error.

---

# 7. System-audio capture issues

## 7.1 Major: system capture behavior is browser/platform dependent

`getDisplayMedia` can provide system/tab audio only when the user/browser exposes such a track. It is not a universal low-level “capture all system audio” API.

### Fix
Detect actual audio tracks and clearly explain supported capture modes.

---

## 7.2 Major: `video: true` means the browser capture UI may always request screen/window selection

### Fix
Document tab-audio support and avoid promising universal system capture.

---

## 7.3 Major: captured audio should not be fed into a heavy AI pipeline synchronously

If source separation is later added, live system capture needs a streaming strategy rather than processing giant chunks on the main thread.

### Fix
Use an AudioWorklet + Worker architecture.

---

# 8. Main UI/control issues

## 8.1 Major: UI percentages do not correspond to physical quantities

Width 170%, Depth 70%, Height 45% sound quantitative but are not physical units.

### Fix
Keep percentage knobs if desired, but define them as perceptual controls internally. For advanced mode expose:

- width: degrees
- depth: meters
- elevation: degrees
- room size: meters
- reverb: DRR/RT60-like controls

---

## 8.2 Major: Radar visualizer is not evidence of actual audio positions

`SoundstageRadar` draws positions from UI parameters, not measured/estimated source data.

### Fix
Separate:

```text
Requested scene
vs
Estimated/rendered scene
```

The radar should visualize actual renderer source objects and reflection positions.

---

## 8.3 Major: radar colors/labels claim 3D truth the DSP does not establish

Labels like “BINAURAL 3D” and “LAPTOP XTC” imply a completed physical rendering model.

### Fix
Use accurate labels:

- `BROWSER HRTF`
- `CALIBRATED BINAURAL`
- `SPEAKER STEREO EXPANDER`
- `CALIBRATED XTC`

---

## 8.4 Major: preset names and descriptions overclaim

Examples:

- “3D Holographic”
- “Cinema 7.1 Surround”
- “Concert Hall Immersion”
- “Laptop Speaker Expander”
- “Spatial Music (85/15 Blend)”

The code does not implement actual 7.1.4 decoding, actual Atmos metadata, or a validated 85/15 Dolby algorithm.

### Fix
Rename them to truthful feature names unless there is an exact implemented specification and test suite.

Suggested:

- `Wide Binaural`
- `Cinema Wide`
- `Large Room`
- `Laptop Wide`
- `Vocal Focus`
- `Bass Assist`

---

## 8.5 Critical: the “Dolby Atmos 85/15” claim must be removed

The research note itself states an “85% panning / 15% HRTF blend,” but that should not be presented as a fact about Dolby Atmos unless directly supported by authoritative public documentation. It is not implemented in the current code anyway.

### Fix
Remove brand-specific algorithm claims from UI and docs unless independently verified.

---

# 9. Package/build/reproducibility issues

## 9.1 Major: shipping `node_modules` inside the ZIP is a bad reproducibility strategy

The uploaded package included `node_modules`.

The copied `.bin/vite` file had mode `0666`, so `npm run build` initially failed with:

```text
vite: Permission denied
```

After restoring the executable bit, the bundled Vite/Rolldown installation failed because the native optional binding was missing.

### Fix
Do **not** distribute `node_modules` in the project ZIP.

Distribute:

```text
package.json
package-lock.json
src/
public/
index.html
style.css
vite.config.js
```

Then run:

```bash
npm ci
npm run build
```

on the target environment.

---

## 9.2 Major: build is not currently reproducible from the packaged dependency tree

The current archive depends on native optional dependencies that were not fully preserved.

### Fix
Add CI:

```text
npm ci
npm run build
```

on Linux, Windows and macOS.

---

## 9.3 Good: JavaScript syntax currently passes

Static `node --check` succeeded for all source JavaScript files inspected.

Keep this as a pre-commit check.

---

# 10. The correct replacement architecture

## 10.1 Target data flow

### Headphones

```text
                     ┌───────────────┐
                     │  Audio Input  │
                     └───────┬───────┘
                             │
                     Decode / resample
                             │
                   ┌─────────▼─────────┐
                   │  Source Analysis  │
                   │                    │
                   │ M/S, level,       │
                   │ coherence,        │
                   │ spectral bands,   │
                   │ optional stems    │
                   └─────────┬─────────┘
                             │
                  ┌──────────▼──────────┐
                  │   Scene Generator   │
                  │                    │
                  │ source objects     │
                  │ azimuth/elevation  │
                  │ distance           │
                  │ confidence         │
                  └───────┬───┬────────┘
                          │   │
                ┌─────────┘   └─────────┐
                ▼                       ▼
        Direct source renderer     Room renderer
                │                 early + late
                │                       │
                └──────────┬────────────┘
                           ▼
                    Binaural output
                           │
                    gentle compressor
                           │
                      true limiter
                           │
                        output
```

### Laptop speakers

```text
Audio → scene target → virtual L/R target
                         │
                         ▼
              calibration transfer matrix
                         │
                         ▼
              regularized inverse/XTC
                         │
                         ▼
                    speakers
```

If calibration is unavailable:

```text
Audio → safe stereo/M/S widening → speakers
```

Never label that fallback as XTC.

---

# 11. Free implementation strategy

## 11.1 Browser HRTF option: Web Audio API

Use native `PannerNode` HRTF for the first implementation because it is free, portable, and avoids shipping a custom convolution engine immediately. The API explicitly supports HRTF panning. https://developer.mozilla.org/en-US/docs/Web/API/PannerNode/panningModel

Use one PannerNode per **source object**, not one per arbitrary copy of the stereo mix.

---

## 11.2 Explicit HRTF option: SOFA-based HRIR data

SOFA is designed to represent HRTFs, BRIRs, microphone-array data, and related spatial acoustic measurements. https://github.com/sofacoustics/SOFAtoolbox

Preferred free architecture:

1. Obtain a dataset whose redistribution/use license is explicitly compatible with the app.
2. Convert required HRIRs offline into a compact browser-friendly representation.
3. Store azimuth/elevation metadata and left/right HRIRs.
4. Interpolate between nearby directions.
5. Convolve in AudioWorklet or WASM.

Do not blindly bundle any HRTF file just because it is downloadable. Verify data licensing independently.

---

## 11.3 Free open-source reference: Omnitone

Omnitone is an Apache-2.0 open-source web spatial-audio renderer that performs ambisonic decoding and binaural rendering using Web Audio facilities. It can be used as a reference or as an optional backend for ambisonic content. https://github.com/googlechrome/omnitone

Important: Omnitone is primarily an ambisonic renderer. It does **not** magically solve arbitrary stereo-to-3D scene inference. Use it when you have an actual ambisonic field or intentionally convert your scene into ambisonics.

---

## 11.4 Free open-source reference: Resonance Audio Web SDK

Google's Resonance Audio Web SDK is Apache-2.0, but the repository was archived on April 19, 2026. Treat it as reference code or legacy infrastructure rather than assuming it will receive future fixes. https://github.com/resonance-audio/resonance-audio-web-sdk

Do not make UDIO dependent on an archived package without understanding maintenance risk.

---

## 11.5 Optional source separation: Demucs

Demucs is MIT-licensed source code, but the official repository was archived on January 1, 2025. https://github.com/facebookresearch/demucs

For a commercial/product build, separately review the license terms of pretrained model weights and any redistribution restrictions before bundling them. The project itself historically had questions/issues around model licensing. https://github.com/facebookresearch/demucs/issues/327

### Recommended product strategy

**Browser-only baseline:** no AI required.

**Optional enhanced mode:** offline/server/WebGPU source separation where the user explicitly enables it.

This gives UDIO a useful spatializer even on weaker devices.

---

# 12. Stereo scene analysis that is actually achievable for free

A stereo track does not contain explicit object metadata. Therefore UDIO must infer a plausible scene, not recover the original Atmos scene exactly.

Implement a confidence-based analyzer.

## 12.1 Measure per-band stereo coherence

For each analysis window:

1. FFT L and R.
2. Compute magnitude spectra.
3. Compute cross-spectrum.
4. Estimate inter-channel coherence:

```text
coherence(f) = |S_LR(f)| / sqrt(S_LL(f) S_RR(f) + eps)
```

High coherence suggests centered/coherent material.
Low coherence suggests wider/diffuse content.

---

## 12.2 Measure Mid/Side ratio

```text
M = (L + R) / 2
S = (L - R) / 2
```

Calculate band energies:

```text
E_M(f)
E_S(f)
```

Then derive:

```text
sideRatio = E_S / (E_M + E_S + eps)
```

Do not interpret Side as a physical side source; use it as a stereo-information feature.

---

## 12.3 Optional center-content confidence

A useful heuristic for music/voice:

```text
centerConfidence = clamp(
    weighted(midEnergy / totalEnergy) * weighted(coherence),
    0,
    1
)
```

Use this to decide how much signal becomes the center object.

---

## 12.4 Optional vocal-band confidence

Use a conservative speech/vocal probability estimate from:

- energy in roughly 150 Hz–4 kHz
- harmonicity
- temporal modulation
- Mid dominance
- pitch stability

Do not call this “AI vocal separation” unless a trained model is actually used.

---

## 12.5 Confidence must control aggressiveness

When confidence is low:

```text
spatialization amount ↓
```

When confidence is high:

```text
spatialization amount ↑
```

This is much safer than applying 100% of the effect to every song.

---

# 13. Source-object model

Create a new structure:

```js
{
  id: 'center',
  signal: AudioNode,
  azimuth: 0,
  elevation: 0,
  distance: 2.0,
  gain: 0.8,
  width: 0.15,
  directivity: 1.0,
  confidence: 0.9,
  category: 'center'
}
```

Possible categories:

- center
- front-left
- front-right
- wide-left
- wide-right
- ambience
- height-artistic
- reflection

Every object must have one reason for its existence.

---

# 14. Better headphone renderer

## 14.1 Start with 3–5 sources, not 10–20 copies

Default:

1. center
2. front-left
3. front-right
4. ambience-left
5. ambience-right

Only create height sources when explicitly enabled and only from selected residual content.

---

## 14.2 Do not use huge gain boosts

Keep source gains near unity and loudness-match the scene. Large gains such as `1.2` or more should be exceptional.

---

## 14.3 Keep distance independent of width

Width changes angle.
Depth changes distance + DRR + HF damping.
Elevation changes angle.
Focus changes source coherence/center contribution.

---

## 14.4 HRTF interpolation

For explicit HRIR data:

1. convert target position to azimuth/elevation
2. locate neighboring measurements
3. interpolate carefully
4. preserve onset/ITD separately where possible
5. crossfade filters for moving sources

Avoid naïvely linearly blending raw HRIR samples from widely separated directions.

---

# 15. Early-reflection engine

## 15.1 First-order image-source equations

For room dimension `Lx, Ly, Lz`, reflect source position across each wall.

Example for an x=0 wall:

```text
imageX = -sourceX
```

For x=Lx:

```text
imageX = 2Lx - sourceX
```

General higher-order image coordinates follow integer reflection indices.

For each image source:

```text
vector = imagePosition - listenerPosition
path = |vector|
delay = path / c
gain ∝ 1/path × reflectionCoefficient
```

Then low-pass/damp based on wall absorption and air attenuation.

---

## 15.2 Use no more than 6–12 first-order taps initially

This is cheap enough for a browser and can be made deterministic.

---

# 16. Late reverb engine

Replace random IR with a deterministic FDN or Schroeder/Moorer reverb.

## Free baseline

Use 4–8 feedback delay lines with mutually prime-ish delays and a loss/mixing matrix.

Simplified:

```text
x → input mix → [delay1..delayN]
             → feedback matrix
             → damping filters
             → stereo decode
```

Start with deterministic delay lengths.

Expose:

- RT60-ish decay
- damping
- wet level
- stereo width

This is mathematically controllable and does not require proprietary technology.

---

# 17. Air absorption

For source distance `r`, use a simple distance-dependent low-pass cutoff:

```text
fc(r) = fc_near / (1 + k * max(0, r - r0))
```

Do not pretend this is a full atmospheric acoustic model. It is a controllable approximation.

---

# 18. Speaker mode: free calibration workflow

This is the most important improvement for laptop speakers.

## 18.1 Why calibration matters

A laptop varies by:

- speaker placement
- chassis geometry
- driver response
- left/right spacing
- listener position
- room
- desk reflections

Therefore universal XTC coefficients are impossible to guarantee.

---

## 18.2 Free calibration test signal

Generate a logarithmic sweep, for example:

```text
100 Hz → 16 kHz
```

Play:

1. left speaker only
2. right speaker only
3. optionally both with known phase

Record with a phone or USB microphone placed at the listening position.

This creates four approximate acoustic transfer paths:

```text
H_LL
H_LR
H_RL
H_RR
```

The calibration UI should explain that the measurement is approximate and depends strongly on the measurement microphone.

---

## 18.3 Derive the inverse

For each FFT frequency bin:

```text
H(f) = [H_LL H_LR
        H_RL H_RR]
```

Compute a regularized inverse:

```text
G(f) = H(f)^H [H(f)H(f)^H + λI]^-1
```

where:

- `H^H` = conjugate transpose
- `λ` = regularization parameter

Then transform each inverse transfer path back to FIR filters.

Use frequency smoothing and gain caps.

---

## 18.4 Why regularization is mandatory

Some frequencies make the transfer matrix nearly singular. Exact inversion can create enormous boosts and unstable/harsh output.

Regularization keeps the inverse bounded.

---

## 18.5 Add a calibration quality score

Compute:

- condition number
- max inverse gain
- average cancellation error

Then classify:

```text
GOOD
ACCEPTABLE
UNSAFE
```

If unsafe, disable XTC and fall back to stereo widening.

---

# 19. Headphone calibration/personalization

A free first version does not need AI ear scanning.

Implement HRTF profile choices:

- generic
- bright
- dark
- user-loaded

Best long-term design:

- user selects a public HRTF set
- optionally choose from a database by anthropometric similarity
- optionally support head-tracking

Do not claim individualized HRTF accuracy unless actual personalization exists.

---

# 20. AudioWorklet architecture

The DSP should gradually move to AudioWorklet for predictable real-time processing.

Recommended split:

```text
Main thread:
  UI
  waveform
  non-real-time analysis

Worker:
  FFT analysis
  source separation
  HRTF table preparation
  calibration computation

AudioWorklet:
  real-time DSP
  fractional delay
  mixing
  convolution
  limiter

WASM (optional):
  FFT
  partitioned convolution
  matrix inversion
  high-performance DSP
```

Do not put heavy AI inference or large matrix calculations directly inside the render callback.

---

# 21. Fractional delays

When arbitrary geometry produces non-integer sample delays:

```text
delaySamples = delaySeconds * sampleRate
```

split into:

```text
N = floor(delaySamples)
frac = delaySamples - N
```

Implement fractional delay with a stable interpolator.

Free first options:

- linear interpolation for simple reflection taps
- 3rd-order Lagrange for better fidelity
- first-order Thiran for phase-oriented designs

Avoid changing `DelayNode.delayTime` rapidly for many moving sources if it causes audible interpolation artifacts; an AudioWorklet can implement deterministic fractional delay processing.

---

# 22. Master loudness and protection

Implement a proper final stage:

```text
scene output
→ DC/high-pass cleanup if required
→ gentle compressor (optional)
→ true-peak-ish limiter
→ output gain
→ meter
```

At minimum:

- pre-peak meter
- post-peak meter
- RMS/LUFS-like meter
- clipping counter

Never hide level changes inside spatial controls.

---

# 23. Bypass and testing mode

Create explicit test buttons:

```text
RAW 2D
M/S ONLY
HRTF ONLY
ROOM OFF
ROOM ON
XTC OFF
XTC ON
FULL ENGINE
```

This allows debugging one stage at a time.

---

# 24. Automated DSP test suite — mandatory

Antigravity must add test audio fixtures generated programmatically; do not depend only on music files.

## Test 1 — mono impulse

Input:

```text
L = impulse
R = impulse
```

Expected:

- center source remains centered
- no random left/right drift
- no huge extra echoes at room=0

## Test 2 — left impulse

Expected:

- left localization stronger than right
- stable timing
- no duplicated center source unless intentionally designed

## Test 3 — right impulse

Mirror of left.

## Test 4 — low-frequency mono sine

Expected:

- spatial width control has limited effect at very low frequencies
- no strong phase cancellation in speaker fallback mode

## Test 5 — broadband click at multiple angles

Render at:

```text
-90, -60, -30, 0, +30, +60, +90 degrees
```

Check left/right energy and arrival-time behavior.

## Test 6 — elevation sweep

Render:

```text
-30, 0, +30, +60 degrees
```

Check that elevated HRTF output changes spectral shape rather than only gain.

## Test 7 — depth sweep

Render one source at:

```text
0.75, 1, 2, 4 meters
```

Check:

- attenuation
- DRR
- HF damping

## Test 8 — phase/correlation test

Compute stereo correlation before/after.

Flag:

```text
correlation < -0.3
```

for potential mono-compatibility problems.

## Test 9 — impulse response determinism

Run the same setting twice.

Expected:

```text
bitwise or numerically near-identical result
```

unless intentionally randomized.

## Test 10 — bypass loudness

A/B levels should be matched within a small tolerance.

---

# 25. Objective metrics to add

## 25.1 Interaural level difference

Estimate ILD:

```text
ILD_dB(f) = 20 log10(|H_L(f)| / |H_R(f)|)
```

## 25.2 Interaural time difference

Estimate delay from cross-correlation/phase slope in a low-frequency band.

## 25.3 Interaural cross-correlation

Use IACC as a useful width/envelopment diagnostic.

## 25.4 Spectral distortion

Compare processed output against the direct reference to detect excessive coloration.

## 25.5 Clipping rate

Count samples/blocks beyond the target output ceiling.

## 25.6 CPU/render health

Measure:

- audio callback underruns
- worklet processing time
- max processing time per render quantum
- average CPU load if available

---

# 26. UI changes required

## 26.1 Rename controls to honest meanings

Current → proposed:

```text
Stereo Width      → Stage Width
Spatial Depth     → Depth
Center Focus      → Center Focus
Elevation         → Height
Room Reverb       → Room
Bass Enhance      → Bass
```

Keep the simple UI while internally using physically meaningful mappings.

---

## 26.2 Add backend status

Display:

```text
Renderer: Browser HRTF
HRTF: Generic
Head Tracking: Off
Speaker Calibration: Not Available
```

or equivalent.

---

## 26.3 Add “safe mode” automatically

If the analyzer sees:

- highly decorrelated content
- mono source
- unstable phase
- very high dynamic processing

reduce spatialization amount automatically.

---

# 27. Preset redesign

## Wide Binaural

```text
mode=headphones
width=1.1
close-to-neutral depth
focus=0.75
elevation=0.15
room=0.15
bass=0.10
dynamics=0.10
```

## Cinema Wide

```text
width=1.3
depth=0.65
focus=0.75
elevation=0.25
room=0.30
bass=0.25
dynamics=0.15
```

## Vocal Focus

```text
width=0.75
depth=0.20
focus=0.95
elevation=0.05
room=0.08
bass=0.05
dynamics=0.10
```

## Laptop Safe

```text
mode=speakers
width=1.05
xtc=OFF unless calibrated
haas=low
sideBoost=low
bass=0.15
```

## Calibrated XTC

Only selectable when calibration data passes quality thresholds.

---

# 28. Code organization to implement

Create these modules:

```text
src/audio/
  AudioEngine.js
  SourceManager.js
  Metering.js

src/spatial/
  SceneAnalyzer.js
  SceneGenerator.js
  BinauralRenderer.js
  HRTFProvider.js
  SpatialMath.js
  HeadTracking.js

src/room/
  ImageSourceRoom.js
  EarlyReflections.js
  FDNReverb.js

src/speakers/
  SpeakerCalibration.js
  XTCFilterDesigner.js
  TransauralRenderer.js
  StereoFallback.js

src/dsp/
  Compressor.js
  Limiter.js
  FractionalDelay.js
  Loudness.js

src/worklet/
  SpatialProcessor.js
  ConvolutionProcessor.js
  XTCProcessor.js
```

Do not put all spatial logic into one 500-line file.

---

# 29. Remove misleading terminology from source comments

Replace:

```text
Professional 3D Binaural & Transaural Spatializer
KEMAR HRTF
True 3D vertical localization
ISM
true lateral dipole
broadcast-grade transparent mastering limiter
Dolby Atmos 85/15 style blend
```

with technically accurate descriptions unless the claimed algorithm is genuinely implemented.

This is important for maintainability and future legal/product documentation.

---

# 30. Brand/IP safety

Do not copy proprietary coefficients or claim to reproduce a commercial vendor's secret implementation.

Use foundational/public-domain mathematics and clearly documented open-source components.

Open-source references with permissive licenses include Omnitone (Apache-2.0). https://github.com/googlechrome/omnitone

The Resonance Audio Web SDK is Apache-2.0 but archived as of April 19, 2026. https://github.com/resonance-audio/resonance-audio-web-sdk

---

# 31. Priority order for Antigravity

## P0 — must fix before claiming 3D quality

1. Replace multi-copy stereo→many-HRTF architecture with source-object rendering.
2. Remove false KEMAR claim.
3. Rebuild headphone spatial scene around one coherent source per logical object.
4. Replace fake ISM with real geometry-driven early reflections.
5. Replace random room IR.
6. Remove fixed-gain/fixed-delay XTC as “XTC.”
7. Add safe uncalibrated speaker fallback.
8. Separate room rendering from generic stereo pre-processing.
9. Replace fake Dynamics limiter with real dynamics stage.
10. Add loudness-matched A/B.
11. Add automated impulse/sine/angle test suite.

## P1 — required for a strong product

12. Add AudioWorklet for real-time custom DSP.
13. Add explicit HRTF backend or documented browser HRTF backend.
14. Add HRTF interpolation framework.
15. Add deterministic FDN late reverb.
16. Add fractional delay.
17. Add head tracking.
18. Add scene confidence scoring.
19. Add phase/correlation meters.
20. Add calibration workflow for speaker mode.

## P2 — advanced

21. User-selectable HRTF datasets.
22. Personalization/anthropometric HRTF selection.
23. Optional source separation.
24. AI scene classification.
25. Device-specific tuning profiles.
26. WebGPU/WASM accelerated analysis.

---

# 32. Exact implementation rules

Antigravity must obey all of these:

### Rule A
Do not add another arbitrary delay/gain “3D effect” just because localization seems weak.

### Rule B
Every signal path must have an explicit purpose.

### Rule C
Do not call an algorithm ISM, XTC, HRTF-KEMAR, 7.1.4, Atmos, or transaural unless the implementation actually satisfies the corresponding technical definition.

### Rule D
All important spatial controls must have a measurable DSP mapping.

### Rule E
All gains introduced by spatial processing must be loudness-managed.

### Rule F
No random processing in the production renderer unless it is intentionally seeded and documented.

### Rule G
No device-specific speaker cancellation without calibration.

### Rule H
No heavy model inference inside the real-time audio render callback.

### Rule I
The engine must degrade gracefully:

```text
explicit HRTF unavailable
→ browser HRTF
→ safe stereo spatialization
→ bypass
```

### Rule J
Every new spatial algorithm must come with at least one deterministic DSP test.

---

# 33. Recommended minimum viable “good” version

Do not try to implement every research feature in one jump.

The first genuinely good version should be:

```text
Stereo input
   ↓
M/S + coherence analysis
   ↓
3 logical sources
   ├─ Center
   ├─ Front stereo residual
   └─ Ambience
   ↓
Web Audio HRTF panners
   ↓
Geometry-based 4–6 early reflections
   ↓
Deterministic FDN late reverb
   ↓
Gentle compressor
   ↓
Limiter
   ↓
Output
```

For speakers:

```text
Stereo input
   ↓
M/S analysis
   ↓
safe width matrix
   ↓
optional calibrated XTC
   ↓
limiter
   ↓
output
```

This will already be materially better than the present “copy everything to many positions” design.

---

# 34. Recommended “pro” version

After the MVP is stable:

```text
Stereo
 ↓
analysis
 ↓
optional source separation
 ↓
object scene
 ↓
HRTF renderer with explicit dataset
 ↓
head tracking
 ↓
ISM early reflections
 ↓
BRIR/FDN late field
 ↓
loudness-managed master
 ↓
headphones
```

and:

```text
Stereo / objects
 ↓
virtual loudspeaker target
 ↓
measured laptop transfer matrix
 ↓
regularized transaural inverse
 ↓
speaker output
```

---

# 35. Final verification checklist for Antigravity

Antigravity must not report “3D fixed” merely because the application builds or sounds louder.

The implementation is complete only when all are true:

- [ ] Mono centered test stays centered.
- [ ] Left/right test impulses localize cleanly.
- [ ] ±30/60/90° sources produce monotonic lateral movement.
- [ ] Elevation changes HRTF spectral cues, not just gain.
- [ ] Depth changes direct level + DRR + HF absorption.
- [ ] Room-off removes reflections cleanly.
- [ ] Room-on produces deterministic, geometry-consistent reflections.
- [ ] Bypass is loudness matched.
- [ ] Speaker XTC cannot activate without valid calibration, or the UI explicitly labels it as experimental.
- [ ] No random IR generation remains in production.
- [ ] No dead `StereoWidener.js` remains unless intentionally integrated.
- [ ] No misleading KEMAR/Atmos/ISM/XTC claims remain.
- [ ] No audio dropout occurs under normal UI operation.
- [ ] Build works from a clean `npm ci` install.
- [ ] Automated DSP fixtures pass.

---

# 36. Reference sources

### Web Audio API

- MDN — PannerNode HRTF model: https://developer.mozilla.org/en-US/docs/Web/API/PannerNode/panningModel
- MDN — PannerNode: https://developer.mozilla.org/en-US/docs/Web/API/PannerNode
- MDN — PannerNode position axes: https://developer.mozilla.org/en-US/docs/Web/API/PannerNode/positionX
- MDN — PannerNode distance model: https://developer.mozilla.org/en-US/docs/Web/API/PannerNode/distanceModel
- MDN — ConvolverNode: https://developer.mozilla.org/en-US/docs/Web/API/ConvolverNode
- MDN — ConvolverNode normalization: https://developer.mozilla.org/en-US/docs/Web/API/ConvolverNode/normalize
- MDN — DynamicsCompressorNode: https://developer.mozilla.org/en-US/docs/Web/API/DynamicsCompressorNode
- MDN — WaveShaperNode oversampling: https://developer.mozilla.org/en-US/docs/Web/API/WaveShaperNode/oversample

### Open-source spatial audio

- Omnitone — Apache-2.0 web spatial audio / ambisonic / binaural renderer: https://github.com/googlechrome/omnitone
- Resonance Audio Web SDK — Apache-2.0, archived April 19, 2026: https://github.com/resonance-audio/resonance-audio-web-sdk
- SOFA Toolbox — spatial acoustic/HRTF format tooling: https://github.com/sofacoustics/SOFAtoolbox
- SOFA SimpleFreeFieldHRTF convention: https://www.sofacoustics.org/mediawiki/index.php/SimpleFreeFieldHRTF

### Source separation

- Demucs — MIT source code, official repository archived Jan 1, 2025: https://github.com/facebookresearch/demucs
- Demucs model-license discussion: https://github.com/facebookresearch/demucs/issues/327

---

# 37. One-line instruction for Antigravity

> **Do not patch the current spatial effects incrementally. Refactor UDIO into a physically coherent source-object spatial renderer, deterministic room model, calibrated-or-safe speaker renderer, proper real-time DSP architecture, and automated spatial test suite; preserve the existing UI where possible, remove misleading claims, and use only free/open-source or explicitly redistributable components.**
