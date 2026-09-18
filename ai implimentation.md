# UDIO — AI + DSP 3D AUDIO MASTER IMPLEMENTATION SPECIFICATION

**Purpose:** Replace the current UDIO pseudo-3D processing with a practical AI-assisted spatial reconstruction pipeline that is free/open-source by default, browser-compatible, and implementable by Antigravity.

**Target:** Web application first, with a backend worker for heavy AI inference and a real-time Web Audio renderer in the browser.

**Implementation rule:** AI analyzes/separates the music; deterministic DSP performs the final spatial rendering. Do **not** ask an LLM to generate or directly “make audio 3D”.

---

## 0. EXECUTIVE DECISION

### Recommended stack

1. **Primary music separation:** BS-RoFormer family, preferably a validated pretrained checkpoint with good vocal/other separation.
2. **Fast/robust fallback:** HTDemucs v4.
3. **Optional single-target/cleanup models:** MDX23C or specialized RoFormer checkpoints where a target stem needs improvement.
4. **Optional musical analysis:** Whisper for vocal/transcript timing; Basic Pitch only where note/event information is useful. Neither is the spatializer.
5. **Backend inference:** Python + FastAPI (or a minimal async Python HTTP worker) with PyTorch.
6. **Audio normalization/encoding:** FFmpeg + libsndfile/soundfile.
7. **Real-time browser DSP:** Web Audio API + AudioWorklet for custom DSP.
8. **HRTF:** Prefer a proper HRTF database / SOFA-derived assets converted to a browser-friendly format, or use native PannerNode HRTF only as a baseline. Do not claim that a few PannerNodes constitute a custom KEMAR convolution engine.
9. **Room/reflections:** deterministic early-reflection network or measured IRs; no random-noise “room IR”.
10. **Speaker mode:** treat laptop-speaker XTC as a calibration-dependent experimental feature; do not hard-code one delay/gain and call it universal transaural processing.

### Core signal flow

```text
                  INPUT STEREO
                       |
                       v
             [Decode / Resample]
                       |
                       v
              [Loudness / Peak Check]
                       |
             +---------+---------+
             |                   |
             v                   v
       [AI Separation]      [Direct Stereo]
             |                   |
       +-----+-----+             |
       |     |     |             |
    Vocals Drums  Bass ...       |
       |     |     |             |
       +-----+-----+-------------+
                     |
                     v
             [Feature Analysis]
                     |
                     v
          [Spatial Scene Planner]
                     |
                     v
             [Per-Stem Renderers]
                     |
            +--------+--------+
            |                 |
            v                 v
       Headphone          Speaker
        renderer          renderer
            |                 |
            v                 v
        HRTF/ITD/ILD      calibrated XTC
            |                 |
            +--------+--------+
                     |
                     v
              Early Reflections
                     |
                     v
                 Late Reverb
                     |
                     v
               Master / Limiter
                     |
                     v
                  OUTPUT
```

---

# 1. WHAT IS WRONG WITH THE CURRENT UDIO IMPLEMENTATION

This section is specifically for the uploaded UDIO project and must be treated as the baseline correction list.

## 1.1 Current SpatialEngine is processing a mixed stereo file as if it were multiple objects

Current architecture duplicates already-mixed material:

- Mid is extracted.
- L and R are separately panned.
- Side is separately panned left/right.
- Side is filtered and reused for “height”.
- Side is reused again for Haas paths.
- Side is reused again for reflection taps.

This produces multiple correlated copies of the same content at different virtual locations. It does not create independent sound objects.

### Fix

When AI stems are available, each stem gets one primary spatial source. The stereo “other” residual may receive a diffuse/ambience treatment, but do not repeatedly duplicate the same signal into many virtual speakers.

For the no-AI fast path, use a conservative stereo-to-binaural enhancement mode rather than pretending to have exact object placement.

---

## 1.2 Current “height” processing is not physically/psychoacoustically valid

Current code takes side energy, applies a band-pass around 6.5 kHz, then sends positive/negative copies to elevated PannerNodes. The code comment says this is a “true 3D vertical localization”. It is not.

### Fix

Elevation must be implemented through an elevation-dependent HRTF response, ideally with actual measured HRTFs. High-pass/band-pass filtering may be a supporting cue, but cannot be the height mechanism by itself.

---

## 1.3 Current “ISM” implementation is not an image-source method

A list of fixed delay taps plus low-pass filters is not a geometric image-source model unless the reflection positions, path lengths, angles, and wall gains are actually derived from a room geometry.

### Fix

Use one of:

- measured early-reflection IRs;
- a deterministic virtual room with explicit image-source geometry; or
- a simple perceptual early-reflection network with honest naming such as `EarlyReflectionNetwork`.

Do not call arbitrary delays “ISM”.

---

## 1.4 Current room reverb uses random noise as an impulse response

`RoomSimulator._generateRoomIR()` creates independent random samples for the impulse response.

Problems:

- no actual geometry;
- no controllable reflection structure;
- no meaningful interaural cues;
- non-repeatable output because `Math.random()` is used;
- can sound metallic/noisy;
- wastes CPU/memory for a poor approximation.

### Fix

Replace with measured or deterministically generated IRs. A browser `ConvolverNode` expects an audio buffer as the impulse response and is appropriate for a measured/custom IR. The MDN documentation explicitly describes the IR as a recording of the space when modeling a real environment.

---

## 1.5 Current speaker XTC is not a valid universal XTC system

Hard-coded values such as 150–180 microseconds and negative gains around -0.65 to -0.85 cannot guarantee crosstalk cancellation on arbitrary laptop hardware and listener positions.

### Fix

Treat speaker XTC as a calibrated 2x2 acoustic inversion problem. Start with a safe stereo/widening fallback. Offer XTC only when a calibration routine measures the transfer matrix.

---

## 1.6 Current “Blumlein shuffler” claim is misleading

A fixed low-shelf boost plus side gain is not a complete Blumlein microphone technique nor a general-purpose loudspeaker spatial decoder.

### Fix

Rename this to something like `MidSideSpeakerWidener` unless the algorithm is intentionally based on a documented encoder/decoder topology.

---

## 1.7 Current Haas crossfeed is not a reliable “rear” cue

16–22 ms crossfeed can create widening or precedence effects, but it does not reliably encode front/back depth or rear location.

### Fix

Use Haas only as a secondary decorrelation cue, with bounded gain, and combine it with spectral filtering, DRR, HRTF and room cues.

---

## 1.8 Current PannerNode distance model is being treated as physical depth

`distanceModel='inverse'` changes gain according to distance. That does not by itself make a source externalize in front of or behind the listener.

### Fix

Distance should be represented with a controlled cue bundle:

- direct gain;
- direct-to-reverberant ratio;
- high-frequency air/wall attenuation;
- early reflection level/delay;
- optional source-dependent bandwidth;
- HRTF position.

Do not let the PannerNode's distance attenuation be the sole depth control.

---

## 1.9 Current center path likely causes excessive correlated summation

The center path is derived from M=(L+R)/2 and then the front L/R paths are also present. Center material can therefore be represented multiple times, reducing clarity and changing timbre/center image.

### Fix

When stems are available, vocals/lead can be independently centered. When stems are unavailable, use a correlation-aware center extractor and keep the extracted center contribution conservative.

---

## 1.10 Current output path risks unnecessary gain stacking

Multiple stages apply gains, boosts and limiting. The resulting “3D” sound may be mostly louder/thicker rather than more localized.

### Fix

Use a gain budget. Every processing stage must expose a defined nominal level and a maximum contribution.

Recommended policy:

- pre-DSP peak target <= -6 dBFS;
- spatial summing headroom >= 6 dB;
- no stage should add > +3 dB without compensating gain;
- final true-peak ceiling around -1 dBTP for exported masters;
- loudness match bypass and processed paths before A/B judgment.

---

# 2. BEST AI COMBINATION FOR UDIO

## 2.1 Primary AI: BS-RoFormer

### Use

Primary music source separation. The publicly available implementation describes Band-Split RoFormer as a source-separation architecture using band-split processing and attention across time/frequency, with stereo and multiple-stem support in the implementation.

### Why it is the first choice

- strong music separation quality in current open-source ecosystems;
- suitable for vocal/other and potentially additional source configurations;
- MIT-licensed implementation in the referenced repository;
- runs locally with PyTorch;
- avoids per-request API charges when self-hosted.

### Repository

https://github.com/lucidrains/BS-RoFormer

### License note

The referenced implementation repository is MIT licensed. **Model weights can have their own licensing terms depending on the specific checkpoint. Verify the license of every checkpoint selected for commercial deployment.**

---

## 2.2 Fallback: HTDemucs v4

### Use

Fallback source separator for cases where BS-RoFormer fails quality checks or when a simpler/known 4-stem result is sufficient.

### Typical stems

- vocals
- drums
- bass
- other

The official Demucs repository describes v4 as Hybrid Transformer Demucs and provides Python inference examples. The original Meta repository is MIT licensed, although it is no longer actively maintained; a maintained fork is referenced by the repository.

### Repository

https://github.com/facebookresearch/demucs

### License

MIT for the code repository. Again, verify the exact checkpoint/model terms used in production.

---

## 2.3 Optional targeted refinement: MDX23C / specialized separator

Use a specialized target model only when there is a demonstrable quality improvement for a particular stem. Do not run every available model on every file.

The ZFTurbo music-source-separation repository lists multiple model families including MDX23C, HTDemucs, BS-RoFormer and other architectures and publishes pretrained model tables.

Repository:

https://github.com/ZFTurbo/Music-Source-Separation-Training

A published table there lists example SDR values for several vocal and single-stem models. Treat those numbers as benchmark-specific rather than a guarantee on arbitrary commercial music.

---

## 2.4 Optional AI: Whisper

### Use

Use Whisper only for:

- vocal/activity segmentation;
- transcript/lyrics timing;
- optional section identification;
- optional future semantic controls.

Whisper is **not** the spatializer.

Do not add an LLM or general chatbot into the real-time render loop.

---

## 2.5 Optional AI/musical analysis: Basic Pitch

Basic Pitch is an automatic music transcription system from Spotify. It can output MIDI/pitch events and can help if UDIO later wants event-aware motion or instrument-specific controls.

Repository:

https://github.com/spotify/basic-pitch

License: Apache-2.0 for the repository.

Use it only on isolated stems where note/event analysis improves a concrete feature. It should not run on every file by default.

---

# 3. AI PIPELINE POLICY

## 3.1 Default mode

```text
INPUT
  -> validate
  -> normalize/resample
  -> BS-RoFormer
  -> quality checks
  -> stem package
  -> feature extraction
  -> spatial planner
  -> real-time/browser rendering
```

## 3.2 Fallback mode

```text
INPUT
  -> BS-RoFormer fails/poor confidence
  -> HTDemucs
  -> quality checks
  -> continue
```

## 3.3 No-AI mode

```text
INPUT
  -> stereo analysis
  -> conservative center/side decomposition
  -> binaural enhancement
```

This should be the instant-preview mode when processing time is undesirable.

---

# 4. HOW THE AI SHOULD DECIDE WHAT GOES WHERE

The AI should **not** directly output audio positions frame-by-frame without constraints. Use AI outputs plus deterministic rules.

## 4.1 Stem role mapping

Start with defaults:

| Stem | Default azimuth | Default elevation | Default distance | Width |
|---|---:|---:|---:|---:|
| Vocals | 0° | +2° | 1.2 | narrow |
| Lead guitar | ±25–45° | 0° | 1.8 | medium |
| Piano | ±20–45° | 0° | 2.0 | medium |
| Drums | 0° | 0° | 1.8 | wide |
| Bass | 0° | -5° | 2.0 | narrow |
| Other | estimated | estimated | 2.5 | wide |
| Ambience/residual | diffuse | 0 to +15° | 3–5 | very wide |

These are **starting priors**, not hard truth.

## 4.2 Position estimation inputs

Calculate per-stem/per-frame:

- RMS / LUFS proxy;
- peak;
- spectral centroid;
- spectral rolloff;
- zero crossing rate where useful;
- onset density;
- harmonic/percussive ratio if implemented;
- stereo correlation/coherence;
- Mid/Side ratio;
- inter-channel time difference estimate;
- inter-channel level difference estimate;
- spectral flatness;
- low/mid/high energy ratios.

---

# 5. STEREO ANALYSIS EQUATIONS

## 5.1 Mid/Side

For stereo samples L[n], R[n]:

```text
M[n] = (L[n] + R[n]) / sqrt(2)
S[n] = (L[n] - R[n]) / sqrt(2)
```

Use `sqrt(2)` normalization if preserving power is the explicit goal.

The current UDIO implementation uses 0.5 coefficients, which changes the energy convention. Either convention is usable, but the entire gain budget must be designed around one consistent convention.

---

## 5.2 Inter-channel level difference (ILD)

For RMS values `E_L` and `E_R`:

```text
ILD_dB = 20 * log10((E_L + eps) / (E_R + eps))
```

Use smoothed values, not raw sample values.

Recommended temporal smoothing:

- attack: 20–50 ms;
- release: 100–300 ms.

Clamp the estimate before converting it to spatial angle.

---

## 5.3 Inter-channel time difference (ITD)

Estimate the lag that maximizes short-window cross-correlation:

```text
R_lr[k] = sum_n L[n] * R[n-k]
```

Select the lag around the correlation maximum subject to a bounded physical range.

Do not invent extreme delays. Human-likeness requires constraints.

---

## 5.4 Stereo correlation

```text
rho = cov(L,R) / (sigma_L * sigma_R + eps)
```

Interpretation:

- close to +1: strongly centered/correlated;
- around 0: decorrelated;
- negative: anti-correlated and potentially risky for speaker playback.

Use correlation to decide how aggressively to process side energy.

---

# 6. HEADPHONE 3D RENDERER

## 6.1 Principle

For each source `s`:

```text
x_s(t) -> HRTF_left(theta,phi,r) -> y_L_s(t)
x_s(t) -> HRTF_right(theta,phi,r) -> y_R_s(t)
```

Then:

```text
y_L(t) = sum_s y_L_s(t)
y_R(t) = sum_s y_R_s(t)
```

This is the correct conceptual model: each virtual source contributes a binaural pair.

---

## 6.2 HRTF source strategy

### Preferred

Use measured HRTFs from a permissively licensed dataset and pre-generate browser assets.

Recommended asset pipeline:

```text
SOFA / WAV HRTF dataset
        -> resample
        -> normalize
        -> convert to lookup table
        -> browser-friendly stereo IRs
```

### Browser baseline

Native `PannerNode` with `panningModel = 'HRTF'` may be used initially. The Web Audio API defines spatialization via `PannerNode` and `AudioListener`.

However, keep the design modular so UDIO can replace native panning with a custom HRTF convolution engine later.

---

# 7. DO NOT CHAIN MANY PANNER NODES FOR ONE SOURCE

Current UDIO effectively does:

```text
same source
 -> front
 -> center
 -> side
 -> height
 -> reflections
```

Replace with:

```text
stem source
 -> one direct HRTF source position
 -> optional reflection sends
 -> optional late reverb send
```

A stem can have a small number of intentional reflection sends, but the direct path should be unique.

---

# 8. DISTANCE / DEPTH MODEL

Implement depth as a parameter bundle.

## 8.1 Direct gain

Use a bounded perceptual distance curve, for example:

```text
G_direct(r) = clamp(g_min, g_max, 1 / (1 + a*(r-r0)))
```

Do not rely blindly on the PannerNode inverse model. Web Audio's inverse model is documented, but it is only a gain-distance law; it is not a complete perceptual externalization model.

## 8.2 Air absorption

For a simple implementation use a low-pass filter whose cutoff decreases smoothly with distance:

```text
fc(r) = fc_near / (1 + k*(r-r0))
```

Clamp `fc` to a safe range such as 2.5–20 kHz.

Do not remove all high frequencies from “far” objects.

## 8.3 Direct-to-reverberant ratio

Farther source -> lower direct/reverb ratio.

Example controlled mapping:

```text
DRR_dB = lerp(+8 dB, -2 dB, depth)
```

Use as a design parameter, not a universal acoustic law.

---

# 9. EARLY REFLECTION ENGINE

## 9.1 Replace the current fake ISM network

Implement an actual room parameter model:

- room width W;
- room depth D;
- room height H;
- listener position;
- source position;
- wall absorption coefficients.

For each wall reflection compute a first-order image source.

Conceptually:

```text
source S
wall x=0
image source S' = reflection(S, wall)
path = distance(listener, S')
delay = path / c
angle = atan2(...)
gain = reflection_coefficient / path
```

where `c` is the speed of sound (approx. 343 m/s at room temperature; allow configuration).

## 9.2 First-order reflections only for v1

Do not attempt a huge ray tracer.

Use:

- 4 walls;
- floor;
- ceiling;
- optionally 2nd-order side reflections later.

For browser real-time performance, precompute per source update frame and interpolate slowly.

---

# 10. REVERB

## 10.1 Remove random IR generation

Delete the current `Math.random()` IR generator.

## 10.2 Preferred

Use licensed measured room IRs where available.

`ConvolverNode` is appropriate for loading an impulse response buffer.

## 10.3 Free procedural fallback

Use a deterministic algorithmic reverb, not white-noise IR injection.

Minimum structure:

```text
input
  -> predelay 10–30 ms
  -> early reflections
  -> diffuse feedback delay network
  -> HF damping
  -> low-cut
  -> wet gain
```

Use mutually prime delay lengths and stable feedback gains.

For a simple Schroeder-style fallback:

- 4 parallel combs;
- 2–4 all-pass stages;
- low-pass in each feedback path for damping;
- decorrelation between left/right.

Keep reverb wet low. The goal is externalization, not washout.

---

# 11. FILTER DESIGN

## 11.1 Input high-pass

Optional safety filter:

```text
HPF 20–30 Hz, Q ~ 0.7
```

Do not automatically high-pass all music at 150 Hz.

---

## 11.2 Side low-frequency protection

Do not create a huge side high-pass at 150 Hz purely because “bass must be mono”. Use a frequency-dependent side attenuation curve.

Recommended approach:

```text
0–80 Hz: strong side attenuation
80–150 Hz: gradual transition
150+ Hz: progressively restore side
```

This preserves musical content while reducing low-frequency spatial instability.

---

## 11.3 Air-absorption filter

Use one low-pass per source/reflection send.

Recommended starting range:

- near: 16–20 kHz;
- medium: 10–16 kHz;
- far: 5–10 kHz.

Make cutoff source/distance dependent.

---

## 11.4 Reflection filters

Use progressively lower cutoff for later reflections.

Example:

```text
reflection 1: 8–12 kHz
reflection 2: 6–10 kHz
reflection 3: 4.5–8 kHz
late tail: 3.5–7 kHz
```

These are safe starting ranges, not mandatory values.

---

## 11.5 Center/lead clarity

If a stem is designated “lead center”:

- high-pass only as needed;
- mild 2–4 kHz presence trim/boost only after listening tests;
- avoid aggressive shelving.

Never solve center clarity by simply turning the center gain way up.

---

# 12. BASS ENHANCER CORRECTIONS

The existing `BassEnhancer` can create harmonics using waveshaping, but its fixed 200 Hz low-pass + 150 Hz high-pass + +3 dB 300 Hz peak is too blunt.

## Better design

1. split low band at a configurable 100–180 Hz;
2. generate 2nd/3rd harmonic content using a restrained waveshaper;
3. high-pass the generated harmonics so fundamental energy is preserved in the dry path;
4. low-pass the harmonic path around 500–800 Hz;
5. keep wet contribution small;
6. oversample if the custom shaper is nonlinear.

Use a dynamic wet amount tied to bass RMS so the enhancer does not become aggressive on dense mixes.

---

# 13. MASTER DYNAMICS

## Rule

Dynamics must run after spatial summing, but do not use a compressor to create “3D”.

Recommended chain:

```text
spatial sum
 -> gentle bus compression (optional)
 -> true-peak limiting
```

Avoid aggressive compression because it can flatten direct/reverberant cues.

For A/B:

- loudness-match processed vs bypass;
- compare at the same integrated/short-term loudness.

---

# 14. SPEAKER MODE: SAFE ARCHITECTURE

## 14.1 Important limitation

Laptop speaker XTC is extremely sensitive to the geometry and acoustics of the playback system.

Therefore v1 should have three speaker modes:

### A. Safe Stereo Expansion

No XTC. Use controlled Mid/Side widening, low-frequency protection and mild decorrelation.

### B. Calibrated XTC

User runs a calibration routine. UDIO estimates a 2x2 transfer matrix from virtual loudspeaker outputs to the two ears.

### C. Experimental XTC

Only for users who explicitly enable it and accept that different laptops can behave differently.

---

# 15. CALIBRATED XTC MATHEMATICS

Let the acoustic transfer matrix be:

```text
A(f) = [ H_LL(f)  H_LR(f) ]
       [ H_RL(f)  H_RR(f) ]
```

where each H is measured from a physical speaker to an ear.

We want a filter matrix `W(f)` such that:

```text
A(f) * W(f) ≈ I
```

Then virtual signals `v(f)` become speaker signals:

```text
s(f) = W(f) * v(f)
```

Do not use the raw inverse where the matrix is ill-conditioned. Use regularized inversion.

A common concept is:

```text
W(f) = (A^H A + lambda I)^(-1) A^H
```

where `lambda` is a regularization term.

For implementation, estimate the transfer functions, stabilize bins with large condition numbers, then convert the resulting filters into causal FIR filters with safe length.

---

# 16. XTC CALIBRATION UX

The user should see:

```text
Place laptop on normal desk.
Sit at normal listening position.
Keep head centered.
Do not move during calibration.

[ Start Calibration ]
```

Play swept/chirp test signals from left and right physical speakers.

Capture using the microphone only if the browser/device permissions and microphone access are explicitly supported. Otherwise calibration is unavailable.

Never imply microphone calibration works identically across all devices.

---

# 17. AI BACKEND API

## 17.1 Suggested endpoint layout

```text
POST /api/analyze
POST /api/separate
POST /api/render-plan
GET  /api/job/:id
GET  /api/health
```

Optional:

```text
POST /api/calibrate/xtc
```

## 17.2 `POST /api/separate`

Request:

```json
{
  "audioUrl": "...",
  "model": "bs_roformer",
  "stems": ["vocals", "drums", "bass", "other"],
  "sampleRate": 48000
}
```

Response:

```json
{
  "jobId": "uuid",
  "status": "queued"
}
```

Do not send multi-minute audio to an external API from the browser with secret tokens.

---

# 18. ZERO-COST SOFTWARE DEPLOYMENT

## 18.1 Mandatory architecture

UDIO must be implemented with **no paid AI API, no paid inference provider, and no mandatory cloud service**.

Run all AI inference locally on the developer/user machine or on hardware controlled by the project. The browser performs the final real-time spatial rendering.

Recommended local stack:

```text
Browser / React + Web Audio API
            |
            v
Local Python service (FastAPI)
            |
     +------+-------+
     |              |
     v              v
BS-RoFormer       HTDemucs
(primary)         (fallback)
     |              |
     +------+-------+
            v
     Local audio analysis
            |
            v
     JSON spatial scene
            |
            v
Browser AudioWorklet + HRTF DSP
```

## 18.2 Free/open-source software components

Use software that can be obtained and run locally without subscription or per-request API charges:

- Python
- FastAPI
- PyTorch
- torchaudio
- NumPy
- SciPy
- soundfile / libsndfile
- FFmpeg
- BS-RoFormer implementation and a checkpoint whose license permits the intended use
- HTDemucs / Demucs
- Whisper, only when vocal timing/transcription is useful
- Basic Pitch, only when note/event information is useful
- Web Audio API
- AudioWorklet

Example environment:

```bash
python -m venv .venv
# activate the environment
pip install torch torchaudio
pip install fastapi uvicorn python-multipart soundfile numpy scipy
```

Install the selected model packages/checkpoints locally according to their repositories and verify each checkpoint's license before distribution.

## 18.3 No external AI calls in the core path

The production core path must work with networking disabled after model installation. Audio uploads, separation, analysis, and spatial-scene generation must remain local.

Do not design the application around an external inference endpoint, API key, monthly allowance, subscription, or pay-per-request service.

## 18.4 Compute reality

The software stack can be zero-cost, but AI inference still consumes the user's CPU/GPU, RAM, storage, and electricity. GPU acceleration is optional; the application must have a CPU fallback and clear progress reporting.

## 18.5 Deployment priority

For the first complete version, prioritize:

1. Local development machine.
2. Local Python worker + browser renderer.
3. Optional LAN deployment to another machine owned/controlled by the developer.

Do not add a paid cloud dependency merely to make the prototype easier to deploy.

---

# 20. SECURITY

## Never do this

```text
VITE_AI_API_KEY=secret
```

and then ship the secret to the browser.

Everything beginning with `VITE_` can be exposed to the client build.

## Correct

```text
Browser
  -> UDIO backend
      -> provider/model
```

Secrets live on the backend only.

---

# 21. AUDIO PREPROCESSING BEFORE AI

Normalize source audio consistently.

Recommended pipeline:

```text
decode
 -> stereo validation
 -> NaN/Inf check
 -> DC offset check
 -> resample to model sample rate
 -> floating-point PCM
 -> peak headroom
 -> chunking with overlap
 -> AI inference
 -> overlap-add reconstruction
```

Do not permanently normalize a song to an arbitrary loudness before separation without documenting the transform.

---

# 22. CHUNKING FOR LONG SONGS

AI separation should use overlapping windows.

Conceptual design:

```text
[0 -------- 30s]
        [20s -------- 50s]
                [40s -------- 70s]
```

Blend overlaps with a smooth crossfade/window.

Do not concatenate independently separated chunks without overlap handling because boundary clicks and level changes can occur.

---

# 23. STEM RECONSTRUCTION / QUALITY CONTROL

After AI separation, compute:

### Energy conservation

```text
error = RMS(mix - sum(stems))
```

Large residual error is a warning.

### Correlation check

Compare stem/residual relationships to detect bizarre outputs.

### Clipping check

Reject or attenuate stems that clip.

### Silence/low-energy check

If a model produces a near-silent stem on a track expected to have that source, fallback to another model or no-AI treatment.

---

# 24. MODEL ENSEMBLING

Do not automatically average multiple separator outputs.

Bad:

```text
BS-RoFormer + Demucs
 -> average waveforms
```

Better:

```text
BS-RoFormer
       |
 quality score
       |
   +---+---+
   |       |
 good    poor
   |       |
 use     Demucs
```

For future advanced mode, ensemble in a controlled frequency/time mask space only after objective evaluation.

---

# 25. SPATIAL PLANNER

Create a `SpatialScene` JSON object.

Example:

```json
{
  "listener": {
    "position": [0,0,0],
    "forward": [0,0,-1],
    "up": [0,1,0]
  },
  "sources": [
    {
      "id": "vocals",
      "azimuth": 0,
      "elevation": 2,
      "distance": 1.2,
      "directGain": 0.9,
      "reverbSend": 0.12,
      "width": 0.1
    },
    {
      "id": "drums",
      "azimuth": 0,
      "elevation": 0,
      "distance": 1.8,
      "directGain": 0.75,
      "reverbSend": 0.20,
      "width": 0.65
    }
  ]
}
```

The browser renderer should consume this plan; it should not invent object positions on its own.

---

# 26. DYNAMIC MOTION

Do not make every source continuously orbit.

Motion should be:

- slow;
- musically meaningful;
- optional;
- smoothed;
- phase-safe.

Use a low-rate control loop (e.g. 20–60 Hz) to update target positions, while the audio engine interpolates continuously.

Never jump HRTF positions at audio rate based on noisy AI estimates.

---

# 27. WIDTH CONTROL

Replace “width = 0..200%” with a perceptual control.

Use:

```text
width = 0 -> near mono
width = 0.5 -> natural stereo
width = 1.0 -> spatial preset
width > 1.0 -> exaggerated
```

But internally map the UI value to constrained source-angle, source-width, side-energy and decorrelation parameters.

Do not simply multiply panner X coordinates by 2 and increase gains.

---

# 28. CENTER FOCUS CONTROL

Implement center focus using:

```text
centerFocus
 -> vocal/lead stem direct gain
 -> center source width
 -> center reverb send
 -> center spectral stability
```

Do not use a massive center duplicate derived from the whole stereo mix.

---

# 29. ELEVATION CONTROL

Implement as:

```text
0 -> sources stay near ear level
0.5 -> selected ambience/lead cues slightly elevated
1.0 -> stronger elevation for selected sources
```

Use actual HRTF elevation whenever available.

Never create height by forcing positive/negative copies of the side channel through a 6.5 kHz bandpass.

---

# 30. DEPTH CONTROL

Recommended mapping:

```text
Depth 0
  direct dominant
  little room
  near high-frequency content

Depth 50
  moderate DRR
  moderate reflections
  mild HF absorption

Depth 100
  lower direct ratio
  stronger early reflections
  moderate HF absorption
  longer room tail
```

Keep the dry direct signal present enough to preserve clarity.

---

# 31. ROOM CONTROL

User-facing “Room” should control:

- early reflection level;
- late reverb send;
- reflection decay;
- HF damping;
- optional room dimensions.

A room size slider should **not** simply increase delay times without changing reflection density/decay.

---

# 32. WEB AUDIO IMPLEMENTATION

Use `AudioWorklet` for custom real-time DSP. MDN documents AudioWorklet as the mechanism for custom processing in a separate audio thread with low-latency processing.

Reference:

https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet

Recommended module layout:

```text
src/audio/
  AudioGraph.js
  SpatialRenderer.js
  HRTFRenderer.js
  EarlyReflectionEngine.js
  ReverbEngine.js
  SpeakerRenderer.js
  GainStaging.js
  analysis/
  worklets/
```

---

# 33. DO NOT PUT HEAVY AI IN THE AUDIO WORKLET

AudioWorklet is for real-time DSP.

AI separation is a background/offline job.

Bad:

```text
AudioWorklet
 -> PyTorch model
```

Correct:

```text
Backend worker
 -> stems / metadata
 -> browser
 -> AudioWorklet / HRTF renderer
```

---

# 34. WEBGPU BROWSER AI (OPTIONAL FUTURE MODE)

Transformers.js can run some model inference in-browser with WebGPU. This can be attractive for smaller analysis models, but browser support/performance varies and it is not the preferred v1 route for large music separation models.

Reference:

https://huggingface.co/docs/transformers.js/guides/webgpu

Possible use later:

- lightweight music classification;
- simple onset/feature analysis;
- small semantic model.

Do not make v1 dependent on browser WebGPU model support.

---

# 35. API / BACKEND TECHNOLOGY RECOMMENDATION

### Backend

FastAPI

### Worker

Python process using PyTorch.

### Queue

Start with an in-process queue. Move to Redis/Celery or another worker queue only when concurrent users require it.

### Storage

Temporary job directory with automatic cleanup.

### Output formats

- WAV for processing/mastering;
- FLAC for lossless download/storage;
- AAC/Opus for preview only if required.

Keep a lossless internal path as long as possible.

---

# 36. DATABASE / JOB STATE

Minimal job states:

```text
queued
processing
separating
analyzing
render-ready
failed
completed
```

Store:

- source hash;
- duration;
- sample rate;
- model used;
- model version/checkpoint ID;
- processing settings;
- scene-plan version;
- output hash.

This enables reproducibility.

---

# 37. CACHING

Audio separation is expensive.

Hash:

```text
SHA-256(audio bytes + model id + model version + separation settings)
```

If the same file/settings are requested again, reuse the cached stems.

This is one of the biggest cost/performance improvements available.

---

# 38. REAL-TIME PREVIEW STRATEGY

Use two paths:

### Instant preview

No AI.

```text
stereo -> light spatial enhancer -> preview
```

### High-quality processing

```text
stereo -> AI separation -> scene plan -> HRTF render
```

UI:

```text
QUICK 3D
HIGH QUALITY AI 3D
```

Do not leave users wondering why one mode takes longer.

---

# 39. QUALITY FALLBACK RULES

Implement exact rules:

```text
if stereo input invalid:
    abort

if duration <= short-preview threshold:
    allow local/hosted fast path

run BS-RoFormer

if separation quality score < threshold:
    run HTDemucs

if HTDemucs is better:
    use HTDemucs
else:
    use BS-RoFormer

if both poor:
    use no-AI stereo spatializer
```

Never return unusable stems merely because a model completed successfully.

---

# 40. QUALITY SCORING FOR SEPARATION

Start simple.

Per stem calculate:

```text
energy
spectral continuity
reconstruction residual
crest factor
clipping percentage
silence percentage
```

Combine into a heuristic score.

Do not claim this is an objective perceptual metric.

For future work, benchmark on known mixtures using SDR/SI-SDR-type metrics.

---

# 41. SOURCE-SPECIFIC SPATIAL RULES

## Vocals

- near center;
- narrow width;
- low reverb send;
- modest elevation only;
- strong HRTF frontal cue.

## Bass

- near center azimuth;
- low elevation;
- narrow width;
- minimal decorrelation;
- no aggressive lateral delay.

## Drums

- moderate width;
- center kick/snare perception;
- cymbal/overhead energy slightly elevated or wider;
- controlled room send.

## Guitar / piano when detected

- place according to stereo evidence;
- do not force arbitrary ±90°.

## Residual/other

- use stereo evidence first;
- distribute ambience conservatively;
- never explode all residual energy around the listener.

---

# 42. OPTIONAL HYBRID “OTHER” PROCESSING

Residual `other` can be decomposed further by frequency bands:

```text
other
  |
  +-- low
  +-- low-mid
  +-- mid
  +-- high
```

Then assign very mild depth/width variation.

Do not treat frequency bands as independent physical objects unless there is a clear perceptual reason.

---

# 43. IMPULSE RESPONSE ASSETS

Do not generate giant IRs on app startup.

Precompute/load assets asynchronously.

Use a small validated set:

```text
assets/hrtf/
assets/room/
assets/early-reflections/
```

Keep metadata for:

- sample rate;
- azimuth;
- elevation;
- distance;
- license/source.

---

# 44. HRTF ASSET LICENSE REQUIREMENT

Before shipping any third-party HRTF dataset/model:

1. record source URL;
2. record license;
3. record attribution requirement;
4. verify commercial-use permission;
5. keep a `THIRD_PARTY_AUDIO_MODELS.md` file.

Never assume an HRTF or model checkpoint is commercially free merely because its code repository is open source.

---

# 45. A/B TESTING

The bypass must be truly level matched.

Current UDIO exposes a processed/bypass crossfade, but the processed path can be louder because of gain stacking.

Implement:

```text
bypass RMS / LUFS estimate
processed RMS / LUFS estimate
compensation gain
then crossfade
```

Goal: a louder path must not win simply because it is louder.

---

# 46. METERS

Current VU implementation uses byte time-domain analysis. Keep it for UI, but add a DSP-side meter for:

- true-ish peak proxy;
- RMS;
- output clipping;
- spatial bus levels;
- wet/dry ratio.

Do not let meter code influence audio routing.

---

# 47. AUDIO ENGINE ORDER

Recommended final order:

```text
SOURCE
 -> input cleanup
 -> optional AI stems
 -> per-source spatial rendering
 -> early reflections
 -> late reverb
 -> optional bass enhancer
 -> gentle bus dynamics
 -> final safety limiter
 -> output
```

For mastering-style EQ, apply it where the UI promises it applies. Avoid applying broad spectral shaping before spatial separation if it makes source separation less stable.

A practical production layout is:

```text
SOURCE
 -> AI separation (offline)
 -> STEM PLAYBACK
 -> STEM EQ (optional)
 -> SPATIAL
 -> ROOM
 -> MASTER BUS
```

---

# 48. IMPORTANT: OFFLINE AI VS REAL-TIME AUDIO

The best architecture is hybrid:

### Offline / asynchronous

- source separation;
- transcript;
- deep feature analysis;
- scene-plan generation.

### Real time

- gain;
- filters;
- panning/HRTF;
- reflections;
- reverb;
- motion;
- limiter.

This keeps CPU spikes away from the audio thread.

---

# 49. PERFORMANCE TARGETS

For browser playback:

- no main-thread heavy DSP loops;
- avoid rebuilding the audio graph for every slider movement;
- use AudioParam automation;
- update spatial targets at control rate;
- keep HRTF nodes stable;
- cache FFT buffers;
- use typed arrays;
- dispose old sources/temporary buffers.

For backend:

- GPU optional;
- batch short stems where practical;
- cache results;
- use overlap-add chunking;
- limit concurrent jobs.

---

# 50. CURRENT UDIO PACKAGING ISSUE

The uploaded ZIP contains `node_modules/.bin/vite` without an executable bit in the archived copy. This can lead to a permissions error when trying to invoke the local binary on Unix-like systems.

### Fix

Do not ship `node_modules` in the source ZIP.

Ship:

```text
package.json
package-lock.json
src/
public/
...
```

Then:

```bash
npm ci
npm run build
```

This also makes the project reproducible.

---

# 51. FILE STRUCTURE AFTER IMPLEMENTATION

Recommended:

```text
UDIO/
  frontend/
    src/
      audio/
        AudioGraph.js
        SpatialRenderer.js
        HRTFRenderer.js
        EarlyReflectionEngine.js
        ReverbEngine.js
        SpeakerRenderer.js
        GainStaging.js
        analysis/
      worklets/
        spatial-processor.js
        convolution-processor.js
    public/
      hrtf/
      ir/
  backend/
    app.py
    routes/
      analyze.py
      separate.py
      jobs.py
      xtc.py
    workers/
      separator.py
      quality.py
    models/
    audio/
      preprocess.py
      chunking.py
      reconstruction.py
  docs/
    THIRD_PARTY_AUDIO_MODELS.md
    SPATIAL_ALGORITHM.md
```

Antigravity does not have to reproduce this exact directory tree if the current app uses another structure, but the responsibilities must remain separated.

---

# 52. IMPLEMENTATION PHASES

## Phase 1 — Fix the current DSP mistakes

1. Remove random room IR.
2. Remove fake “height from 6.5 kHz side band”.
3. Remove fake ISM naming and replace with explicit early-reflection module.
4. Remove hard-coded universal XTC from default mode.
5. Add proper gain staging.
6. Level-match A/B.
7. Separate headphone and speaker rendering pipelines.
8. Keep existing UI functional.

## Phase 2 — Build AI backend

1. FastAPI endpoint.
2. BS-RoFormer integration.
3. HTDemucs fallback.
4. WAV/stereo conversion.
5. chunk overlap/reconstruction.
6. job status.
7. temporary file cleanup.
8. caching.

## Phase 3 — Build AI-aware scene planner

1. detect stems;
2. compute features;
3. assign constrained positions;
4. create `SpatialScene` JSON;
5. send scene to browser.

## Phase 4 — Build real headphone renderer

1. stable source buses;
2. HRTF source renderer;
3. distance cue system;
4. early reflections;
5. late reverb;
6. source motion smoothing;
7. gain compensation.

## Phase 5 — Speaker mode

1. safe stereo expansion;
2. calibration UX;
3. measured XTC path;
4. regularized FIR design;
5. experimental mode.

## Phase 6 — QA

1. reference tracks;
2. listening tests;
3. localization tests;
4. phase tests;
5. performance tests;
6. regression tests.

---

# 53. TEST SUITE

Create automated tests for:

### DSP correctness

- mono input remains centered;
- pure left input stays left of center;
- pure right input stays right of center;
- null/near-null stereo behavior is safe;
- no output clipping from normal inputs;
- stable gain under slider changes.

### Spatial correctness

- source at 0° produces symmetric L/R HRTF response;
- source at +X and -X swap appropriately;
- elevation changes HRTF set/parameters;
- distance reduces direct gain but does not mute source;
- room amount changes reflections/reverb without deleting the direct signal.

### Speaker safety

- XTC disabled by default unless calibrated;
- calibration coefficients bounded;
- unstable inverse is regularized;
- speaker output remains finite.

### AI pipeline

- invalid upload rejected;
- mono input handled correctly;
- long tracks chunked;
- chunk overlaps reconstruct without audible boundary jumps;
- failed primary model triggers fallback;
- failed fallback triggers no-AI mode.

---

# 54. LISTENING TEST MATERIAL

Prepare at least:

1. mono vocal;
2. hard-panned stereo music;
3. dense pop mix;
4. acoustic song;
5. electronic song with strong stereo effects;
6. speech/dialogue;
7. transient-heavy drums;
8. low-bass-heavy track;
9. phasey/old stereo recording;
10. already-spatialized/binaural reference.

The renderer should never claim success just because it sounds “bigger”. Evaluate localization and externalization separately.

---

# 55. USER-EXPOSED QUALITY LABELS

Use honest labels:

### `2D Stereo`
Original/unprocessed.

### `3D Quick`
Real-time stereo-to-binaural enhancement; no deep separation.

### `3D AI`
AI-assisted source separation + spatial scene rendering.

### `3D AI + Room`
AI separation + HRTF + early reflections + late reverb.

### `Speaker Experimental`
Speaker expansion; calibration-dependent.

Do not call everything “Dolby Atmos” or “true Atmos”. UDIO should describe its own method unless it is actually consuming/rendering licensed Atmos content.

---

# 56. ZERO-COST SERVICE STRATEGY

## 56.1 AI access method

There is **no external AI API requirement**. Antigravity should implement a local HTTP API between the frontend and the local Python worker so the browser can request jobs using ordinary REST endpoints.

Example:

```text
POST /api/analyze
POST /api/separate
POST /api/scene
GET  /api/jobs/{jobId}
GET  /api/health
```

The service runs on the same machine as UDIO during development.

## 56.2 Frontend/backend boundary

```text
React/Vite frontend
        |
        | HTTP localhost
        v
FastAPI local worker
        |
        +--> BS-RoFormer
        +--> HTDemucs
        +--> Whisper (optional)
        +--> Basic Pitch (optional)
        +--> feature extraction
```

No secret API keys are required for this architecture.

## 56.3 Offline-first requirement

After model/checkpoint installation, the main audio-processing pipeline should continue to work with internet access disabled. Internet access may be used only for optional installation/update operations.

## 56.4 Graceful degradation

If the local AI worker is unavailable:

```text
AI unavailable
     |
     v
3D Quick mode
     |
     v
Direct stereo analysis + deterministic HRTF DSP
```

This keeps UDIO usable without any online AI service.

---

# 57. MODEL REGISTRY

Create a backend registry:

```json
{
  "bs_roformer_primary": {
    "type": "music_source_separation",
    "provider": "local",
    "version": "PINNED_CHECKPOINT_VERSION",
    "license": "VERIFY_CHECKPOINT",
    "enabled": true
  },
  "htdemucs_fallback": {
    "type": "music_source_separation",
    "provider": "local",
    "version": "PINNED_VERSION",
    "license": "MIT_CODE_VERIFY_MODEL",
    "enabled": true
  }
}
```

Never pull “latest” weights silently in production.

Pin exact versions/checkpoints.

---

# 58. LOGGING

Every AI job should record:

```text
job_id
model
model_version
input_duration
input_sr
output_sr
processing_time
GPU/CPU
fallback_used
quality_score
cache_hit
```

Do not log the audio itself unnecessarily.

---

# 59. PRIVACY

For user-uploaded music:

- temporary storage by default;
- automatic deletion policy;
- no model-provider upload without consent if using a hosted service;
- clear privacy notice;
- avoid storing raw audio indefinitely.

---

# 60. WHAT NOT TO IMPLEMENT

Do **not** implement the following as “3D” features:

- random noise added as spatial ambience;
- arbitrary phase inversion for width;
- fixed 180 µs XTC for all laptops;
- giant fixed high-shelf/low-shelf boosts;
- duplicating full stereo into many Panners;
- forcing side energy to the ceiling for “height”;
- 15–20 ms crossfeed labeled “rear”;
- random impulse responses labeled as physical rooms;
- continuous hard panner jumps based on noisy AI output;
- general LLM API in the real-time audio loop.

These can be optional effects, but they must not be described as physically correct spatialization.

---

# 61. RECOMMENDED DEFAULT PARAMETERS FOR FIRST BUILD

These are starting values to be tuned through listening tests:

```text
Sample rate: native playback rate
Input safety HPF: 25 Hz, Q 0.707
Side low-frequency attenuation: strong below ~80 Hz
Side transition: ~80–150 Hz
Default source direct gain: normalized to stem RMS
Near distance: 1.2 m
Default mid distance: 1.8 m
Far distance: 3.0 m
Early reflection send: 0.08–0.25
Late reverb send: 0.03–0.15
Reverb predelay: 15–25 ms
Reverb HF damping: 4–8 kHz starting range
Motion update rate: 30–60 Hz
Position smoothing: 80–250 ms depending on control
Master true-peak target: <= -1 dBTP for export
A/B loudness matching: enabled
XTC default: OFF unless calibrated
```

Do not hard-code all of these permanently; expose sensible constants/config.

---

# 62. WHY THIS COMBINATION IS BETTER

The combination works because the jobs are separated:

```text
BS-RoFormer / HTDemucs
    = WHAT is in the mix?

Whisper / Basic Pitch (optional)
    = WHEN / WHAT musical events occur?

Feature analysis
    = HOW wide / correlated / energetic is each source?

Spatial planner
    = WHERE should the source be placed?

HRTF + ITD + ILD
    = HOW should the listener's ears receive it?

Early reflections + reverb
    = HOW far / externalized does it feel?

Calibrated XTC
    = HOW can speakers approximate binaural cues?
```

This is far more defensible than adding many generic “3D effects”.

---

# 63. PRACTICAL V1 IMPLEMENTATION CHOICE

For the first usable high-quality release, implement exactly this:

```text
Frontend:
  Vite + existing UDIO UI

Backend:
  FastAPI

Primary AI:
  BS-RoFormer

Fallback AI:
  HTDemucs

Optional:
  Whisper

Audio processing:
  FFmpeg / soundfile / scipy

Browser renderer:
  Web Audio API + AudioWorklet

Headphones:
  HRTF source renderer

Room:
  deterministic early reflections + measured/procedural reverb

Speaker:
  safe M/S expansion first
  calibrated XTC later
```

---

# 64. ANTIGRAVITY IMPLEMENTATION INSTRUCTION

The following should be treated as the implementation brief:

> **Modify the existing UDIO application according to this document, preserving the current UI and playback features unless a feature conflicts with correct audio architecture. First refactor the DSP so headphone and speaker rendering are separate. Remove the fake height path, random room IR, misleading ISM naming, and universal hard-coded XTC. Build a modular AI backend with BS-RoFormer as the primary separator and HTDemucs as fallback. Keep AI outside the real-time audio thread. Produce a versioned `SpatialScene` JSON plan from stems and audio features. Implement per-stem HRTF rendering, physically/psychoacoustically motivated depth cues, deterministic early reflections, and controlled reverb. Keep speaker XTC off by default unless calibrated. Add gain staging, level-matched A/B, cacheing, model/version logging, automated tests, and third-party license tracking. Never expose provider API keys in the frontend. Do not fabricate functionality; every UI control must map to an actual DSP parameter. Keep a no-AI quick mode for low latency.**

---

# 65. ACCEPTANCE CRITERIA

A build should not be called complete until all are true:

1. Mono vocal is centered and stable.
2. Stereo music becomes wider without excessive comb filtering.
3. Headphone mode produces lateral and front/depth changes that are audible and repeatable.
4. Elevation changes use actual HRTF/elevation processing rather than a simple side-band EQ trick.
5. Room is controlled and does not sound like noise.
6. Processed/bypass A/B is loudness matched.
7. AI separation runs outside the real-time audio thread.
8. BS-RoFormer failure falls back to HTDemucs.
9. If both models fail quality checks, the app falls back to no-AI mode.
10. No provider/API secret is shipped in client JavaScript.
11. Speaker XTC is disabled by default until calibration exists.
12. Long tracks are chunked with overlap and reconstructed without obvious boundaries.
13. Model/checkpoint versions are pinned and recorded.
14. Third-party model and HRTF licenses are documented.
15. `npm ci && npm run build` works from a clean checkout without shipping `node_modules`.

---

# 66. REFERENCES / AUTHORITATIVE SOURCES

### BS-RoFormer

GitHub: https://github.com/lucidrains/BS-RoFormer

MIT license in referenced repository: https://github.com/lucidrains/BS-RoFormer/blob/main/LICENSE

### Demucs

Repository: https://github.com/facebookresearch/demucs

MIT license: https://github.com/facebookresearch/demucs/blob/main/LICENSE

### Music Source Separation Training / model catalog

https://github.com/ZFTurbo/Music-Source-Separation-Training

Pretrained-model listing:

https://github.com/ZFTurbo/Music-Source-Separation-Training/blob/main/docs/pretrained_models.md

### Basic Pitch

https://github.com/spotify/basic-pitch



### Web Audio PannerNode

https://developer.mozilla.org/en-US/docs/Web/API/PannerNode

### Web Audio distance model

https://developer.mozilla.org/en-US/docs/Web/API/PannerNode/distanceModel

### Web Audio ConvolverNode

https://developer.mozilla.org/en-US/docs/Web/API/ConvolverNode

### Web Audio BiquadFilterNode

https://developer.mozilla.org/en-US/docs/Web/API/BiquadFilterNode

### AudioWorklet

https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet

### Transformers.js WebGPU

https://huggingface.co/docs/transformers.js/guides/webgpu

---

# 67. FINAL ENGINEERING PRIORITY

### Highest priority

**Correct source representation + correct HRTF rendering + gain staging.**

### Second priority

**Distance/externalization + early reflections + controlled reverb.**

### Third priority

**AI quality and adaptive stem selection.**

### Fourth priority

**Speaker XTC calibration.**

### Lowest priority

**Extra “wow” effects, huge width, aggressive bass, random decorrelation.**

The goal is not to make the waveform look complicated. The goal is to make the listener perceive a stable, believable spatial scene.

---

## END OF SPECIFICATION
