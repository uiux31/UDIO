# Designing a Convincing Binaural Spatial-Audio Engine

## Executive Summary

This report analyzes the scientific and engineering principles behind a high-quality 3D/binaural spatializer. We cover the psychoacoustics of human spatial hearing (interaural time/level differences, pinna cues, the precedence effect, externalization, etc.), the theory and practical handling of HRTFs (measurement, interpolation, personalization, datasets), and the role of head-tracking. We then examine acoustic modeling (early reflections, reverberation) for realism and externalization, and techniques for upmixing 2D/mono/stereo signals into spatial scenes (source separation, localization estimation, decorrelation, and panning strategies). Core signal-processing is detailed (convolution methods, FIR/IIR filters, minimum-phase vs full HRTFs, cross-talk cancellation, binaural rendering pipelines), along with real-time constraints (latency vs CPU/GPU cost) and objective/perceptual evaluation methods. We compare candidate libraries and algorithms by complexity, latency, quality, and license, and recommend test protocols (e.g. localization tasks, ABX tests with noise/speech) and stimuli. Finally, we outline an implementation roadmap with milestones. Throughout, we cite seminal sources to ground our recommendations.

## Psychoacoustics of Spatial Hearing

Human sound localization relies on multiple cues. The primary *binaural cues* are the **interaural time difference (ITD)** and **interaural level difference (ILD)**.  The *duplex theory* (Rayleigh) states that low-frequency localization uses ITDs while high-frequency localization uses ILDs.  Physically, the maximum ITD occurs for a sound at 90° azimuth and is on the order of \~0.7–0.8 ms (for a \~17–18 cm head).  ITD varies roughly with the sine of the azimuth angle:
\[
\\text{ITD}(\\theta) \\approx \\frac{2R}{c}\\sin\\theta
]
(where *R* is the head radius and *c* the speed of sound). ILD arises because the head casts an acoustic “shadow” at high frequencies: ILD is essentially zero for frontal (0°) sources, and increases roughly \~sin(θ) for lateral sources.  Because long wavelengths (<1 kHz) diffract around the head, ILDs become ineffective below \~1 kHz, whereas ITDs become ambiguous above \~1–1.5 kHz due to phase wrapping.  In practice, humans detect ITD differences as small as \~10 μs and ILD differences of \~1 dB.

However, ITD+ILD alone leave a *cone of confusion*: many points off-axis share identical ITD/ILD. The auditory system resolves this ambiguity using *monaural spectral cues* produced by the pinnae and torso. The pinna introduces elevation-dependent notches and peaks in the spectrum above \~3–4 kHz. For example, a prominent notch typically appears in the 6–9 kHz band that shifts with elevation. These spectral-shape cues (encoded in the HRTF magnitude) allow vertical localization and front-back discrimination. In sum, ITDs dominate azimuth localization at low frequencies, ILDs dominate at high frequencies, and spectral cues from the outer ear solve elevation and cone ambiguities.

Another key phenomenon is the **precedence effect**. In real rooms, sound reaches the ears both directly and via reflections. The auditory system “locks on” to the first (direct) wavefront and largely suppresses later echoes for localization. This effect prevents multiple confused images and ensures robustness in reverberant environments.  For externalization, however, some reflections are desirable: the *direct-to-reverberant energy ratio (DRR)* provides a distance cue, and adding early reflections can dramatically improve the sense that a sound is “outside the head.” Studies show that adding moderate reverberation or just a few early reflections (tens of milliseconds delay) causes headphone binaural sounds to be perceived as externalized. In contrast, dry (anechoic) HRTF playback often feels “inside the head.” In summary:

* **Binaural cues**: ITD (effective <1.5 kHz) and ILD (effective >4 kHz) determine azimuth. Sensitivity \~10 µs / 1 dB.
* **Spectral cues**: Pinna-induced notches/peaks above \~4 kHz encode elevation and front/back.
* **Precedence (echo) effect**: The brain localizes on the first-arriving sound.
* **Reverberation \& externalization**: Early reflections and reverb create distance cues (DRR) and externalization.
* **Head motion**: Self-motion (head turns) generates dynamic ITD/ILD changes that resolve remaining ambiguities.

Understanding these cues is fundamental: a spatializer must reproduce ITDs and ILDs consistent with source geometry (e.g. via proper HRTF filtering), include spectral shaping (correct HRTF magnitude), and ideally emulate natural reverberation and allow head-tracking to fully exploit human spatial hearing.

## HRTF Theory and Measurement

The **Head-Related Transfer Function (HRTF)** characterizes how the body, head, and pinnae filter sound from a given direction before it reaches the eardrum. Concretely, an HRTF is the frequency response (or impulse response, HRIR) from a distant point source (at a fixed position, usually 1–2 m) to a microphone placed in the ear canal. HRTFs capture all direction-dependent cues (ILD, ITD, spectral shape). In practice, HRTFs are measured by rotating a dummy head or human subject in an anechoic chamber, emitting impulses or chirps, and recording left/right ear signals. Prominent publicly available databases include **CIPIC** (UC Davis, 54 subjects), **MIT-KEMAR**, **IRCAM Listen** (50 subjects), **FIU**, **ARI/OAW** (208 subjects), **HUTUBS** (96 subjects with anthropometry), and others. These datasets typically sample directions on a sphere at intervals (e.g. 5–15°).

#### Individual vs. Generic HRTFs.

Generic or dummy HRTFs (e.g. KEMAR) can be used out-of-the-box but often yield localization errors, especially in elevation and front-back judgments. Individualized HRTFs generally improve spatial accuracy and externalization. For instance, using a subject’s own HRTFs tends to increase externalization and reduce front/back confusions (though some studies note that for speech stimuli the difference may be modest). Personalization methods include anthropometric selection (choosing the closest HRTF from a database by head/ear size), fitting parametric HRTF models to measurements or images, or even *in-situ* estimation (e.g. using captured binaural room responses or neural networks). Recent work uses ear-shape imaging or ML to predict individualized HRTFs. In practice, an engine may support either generic HRTFs (for simplicity) or allow loading measured/personalized sets.

#### Interpolation and Representation.

Because HRTFs are measured at discrete angles, a spatializer needs to interpolate them for arbitrary source positions. Simple approaches linearly interpolate magnitude spectra and ITDs between nearest measured directions. More advanced methods decompose HRTFs into basis functions (e.g. spherical harmonics, principal components) or use learned models. For real-time binaural playback, a common strategy is **partitioned minimum-phase filtering**: extract the geometric delay (ITD) separately and model the remaining spectral HRTF as a minimum-phase filter of manageable length. This reduces convolution cost and minimizes artifacts from phase interpolation.

#### HRTF Databases and Formats.

For convenience, many spatial engines use prepackaged HRTF sets. For example, Google’s Spatial Media specs suggest using MIT’s KEMAR set, and VR SDKs often include 3–10 HRTF profiles. The SOFA (Spatially Oriented Format for Acoustics) standard provides a uniform way to store HRTFs/BRIRs. Popular sets include the **CIPIC** database (45 subjects, 1250 directions) and the **IRCAM LISTEN** database (50 subjects). Open-source libraries like \[libspatialaudio] include built-in HRTFs (e.g. MIT KEMAR) or allow loading SOFA files.

## Head-Tracking and Dynamic Cues

**Head-tracking** (or head-tracked rendering) means updating the perceived sound location when the listener turns their head. This is critical for realism. When the user moves, the engine must quickly adjust the direction relative to the listener; effectively, one’s head orientation becomes part of the coordinate frame for the HRTFs. Without head-tracking, static HRTF playback often yields front-back confusions and a less stable image. With tracking, even simple sounds become easily localizable because the relative ITD/ILD change naturally with motion. In practice, head-tracking is implemented by applying the HRTF for the *new* azimuth/elevation each audio frame. System latency from motion-to-audio should be low (<20–50 ms): studies show that delays >60 ms can degrade spatial stability. Modern engines aim for <10–20 ms update latency (including sensor readout, computation, and audio output) so motion feels instantaneous. Often, head rotation updates can be applied by quickly re-indexing HRTF tables or re-stereoizing signals without needing full recomputation of room acoustics. In summary: **dynamic cues** (head motion) greatly enhance localization and externalization, so a real-time engine should incorporate head-orientation data and re-render binaural cues accordingly.

## Room Acoustics and Externalization

Real acoustic spaces contribute strongly to realism. To **externalize** a sound (make it seem outside the head and at a distance), the engine should add **early reflections and reverberation**. Early reflections (first few echoes) can be modeled by additional HRTF convolutions: e.g. compute one or more virtual sources for first-bounce reflections (using an image-source or ray-tracing model) and convolve each with appropriate HRTFs. Late reverberation can be added via a standard reverb algorithm or convolution with a measured binaural impulse response (BRIR). Key points:

* **Direct vs Reflected balance**: The direct sound level drops with distance (–6 dB/doubling) while reverberant energy decays more slowly. The ratio (DRR) cues distance.
* **Reverberation time and frequency**: Rooms have frequency-dependent decay; modeling this (or using measured BRIRs) improves warmth.
* **Externalization effect**: Experiments show that adding even modest reverberation (especially early reflections) greatly increases perceived externalization. Often, “half-dry” DRR and diffuse late tail suffice.
* **Precedence / Haas effect**: Keep the first arrival uncolored; ensure early echoes arrive after >1 ms to avoid front-back flipping.
* **Implementation**: Common real-time methods include Schroeder reverberators (comb/all-pass networks) or partitioned convolution with FIR reverb tails. If using Ambisonics, one can apply a spherical reverb kernel. The main trade-off is CPU/GPU load vs quality: using multiple convolution for reflections is costly, so many engines simulate only a few discrete reflections plus a simpler diffuse reverberator for the rest.

Recommended parameters: An early reflection pattern (e.g. 5–10 reflections, delays 5–50 ms, decaying) plus a reverberation time (T60) that depends on room size (e.g. 0.5–2 seconds) often yields good results. The level of reflections is typically set so early and late energy combine to match realistic DRR at different distances. In practice, one may allow the engine user to control “room size” and “wetness” parameters to tune realism.

## Upmixing and Scene Analysis from Mono/Stereo

To convert 2D or mono/stereo inputs into a full 3D scene, the engine must perform *upmixing* and scene analysis. This may involve source separation, direction estimation, and decorrelation:

* **Source estimation**: For stereo input, a basic assumption is that differences between left and right channels indicate direction. Simple rules (e.g. IID/ITD mapping) or more complex techniques (beamforming, independent component analysis) can guess the positions of one or two dominant sources. Machine learning (neural source separation) is increasingly used to extract multiple instrument/voice sources.
* **Panning and Decorrelation**: Once source positions are estimated or chosen, signals are panned in 3D. Traditional panning methods include *Vector Base Amplitude Panning (VBAP)* and *intensity stereo*. VBAP places a virtual source among speakers (or virtual loudspeakers), with amplitudes computed by spherical geometry. Ambisonics encoding is another powerful approach: the stereo (or mono) can be upmixed into Ambisonics (e.g. distribute a mono signal into a horizontal plane) and then decoded to binaural. Ambisonic orders of 1–3 are typical for consumer VR (higher order increases precision at cost of computation). Decorrelation is often applied to add spatial “width”: for instance, adding a slightly delayed or diffused copy of each source can avoid unnaturally narrow images when played binaurally. Simple decorrelation can be achieved by all-pass filters, reverberation, or generating low-level noise signals.
* **Machine Learning Upmix**: Recent methods use deep learning for upmixing; for example, ImmersiveFlow (2024) uses a VAE+Flow model to generate 7.1.4 outputs from stereo, outperforming traditional fixed-delay panning. Similarly, neural networks can predict multi-source binaural outputs from monaural input by leveraging visual cues or audio cues. These methods are still cutting-edge and computationally heavy, but they illustrate that data-driven upmix can yield richer spatialization than classic DSP alone.

In practice, a simpler engine might allow only manual placement of sources or simple stereo expanders. A robust design might support both: a default ambisonic upmix of stereo to broaden the soundfield, plus an optional “auto-localization” mode that assigns principal sources. Key parameters include the number of virtual sources (1–N), panning law (linear/amplitude vs equal-power), and degree of decorrelation (0 = fully correlated, 100% = uncorrelated diffuse). A typical choice is ambisonic 1st/2nd order for broad scenes, and fixed VBAP for discrete objects.

## Binaural Rendering Algorithms

Once a spatial scene is defined, the engine must render to two channels (left/right) using HRTFs:

* **Convolution**: The core operation is convolution of each source with the left and right HRIRs corresponding to its direction. If there are *S* sound sources, this means *2S* convolutions. Direct time-domain FIR convolution has complexity O(N·L) per sample (N=taps, L=block length). More commonly, engines use FFT-based overlap-add convolution, which is O(K log K) per block (with block size K). Partitioned convolution is used for very long IRs: one splits each HRIR into segments (e.g. 64–256 samples) and convolves incrementally, allowing very low latency on the direct path.
* **FIR vs IIR / Minimum-Phase**: Full HRTFs are FIR (often thousands of taps, containing the natural phase). However, a common trick is to make them minimum-phase (retain magnitude response and compress delays). One computes a minimum-phase filter from the magnitude spectrum (e.g. via cepstral liftering) and applies the interaural delay separately. This halves the filter length (no long tail) while preserving spectral cues. The trade-off is slight coloration error (neglecting natural phase reflections), but it drastically reduces cost. Engine designers often choose min-phase HRTFs + delay for efficiency, or allow full FIR HRIRs if CPU permits.
* **Cross-Talk Cancellation**: This is only relevant for loudspeaker output (not headphones). If targeting a multi-speaker system, cross-talk cancellation (XTC) filters are inserted to cancel the left ear’s perception of the right speaker, and vice versa. Implementing XTC requires measuring the listener’s geometry and applying an inverse filter matrix. For headphone-based binaural rendering, XTC is not needed since each channel goes directly to one ear.
* **Implementation Options**: In practice, engines either convolve each source in real time (on CPU/GPU) or use specialized libraries. For example, a GPU can perform thousands of convolutions in parallel (see \[46]). Some systems use FFT on CPU with optimized libraries (FFTW, Intel IPP). IIR biquad approximations are rarely used for HRTFs due to accuracy loss, but are common in reverb.
* **Latency vs Complexity**: There is a trade-off: longer HRTFs (higher quality) require more computation. Typically HRIRs are 2–4 kSamples (to capture pinna resonances up to \~20 kHz). Partitioned FFT convolution with 256–1024 sample blocks is a good compromise: e.g., 512-sample blocks (\~11 ms at 44.1 kHz) give moderate latency. Smaller blocks (<64 samples) yield <5 ms latency but high overhead.  Likewise, rendering many sources or higher-order ambisonics raises CPU load. Thus engines often limit the number of simultaneous sounds (or use mixing objects into fewer channels) to control cost.

In summary, a real-time binaural renderer will: receive audio sources, determine their az/el, convolve each with the appropriate left/right HRTFs (FIR or min-phase), sum all left outputs to L ear and rights to R ear, then add in any ear-specific early reflections/reverb. Efficient strategies (FFT, partitioning, min-phase) are recommended to meet low-latency requirements.

## Latency, Real-Time Performance, and Trade-offs

A key challenge is meeting real-time constraints. For immersive interactivity, total end-to-end latency (audio input to headphone output) should ideally be <20 ms, and head-tracking latency <10 ms for seamless alignment with visuals. The budget must cover sensor updates, HRTF convolution, room simulation, mixing, and audio driver delays.

**Processing load:** As an example, convolving a single 2048-tap HRIR with a 512-sample block requires \~2×2048 multiplies per block, or roughly 8.2k operations (plus overhead). With 10 sources, that’s \~80k multiplies per block (\~22M ops/s at 44.1 kHz) just for HRTF, per ear. FFT convolution reduces it to \~K log₂K, e.g. 512×9 (\~4608) per block, cutting overhead. GPU acceleration can multiply throughput: e.g. \[46] shows GPUs handling much longer convolutions in real time. In practice, a modern desktop CPU can handle on the order of 10–20 simultaneous full-resolution HRIR convolutions (stereo) with optimized code; more requires partitioning or simpler filters.

**Buffer sizing:** A larger FFT block lowers CPU per sample but increases latency. For instance, a 1024-sample block yields \~23 ms buffer latency at 44.1kHz. Many VR systems target 256–512 sample frames (\~5–12 ms) and overlap-add partitioned filters to reduce latency further.

**Head-tracking update rate:** Typically, head orientation is sampled at 60–120 Hz (10–16 ms). Changing HRTFs at each frame is cheap (simply re-index filters) but care must be taken to crossfade or interpolate if block transitions coincide with motion, to avoid clicks.

**Trade-offs:** Tabletop stereo systems might accept >50 ms latency; gaming/VR ideally <20 ms. More CPU time can buy higher spatial order (ambisonic order), longer reverbs, or multi-path reflections. If budget is tight (e.g. mobile CPU), one might simplify: use lower-order ambisonics, prune inaudible frequencies (HB-bass cutoff), shorten HRIRs, or even use head-locked (non-updated) HRTFs as a fallback. The designer must balance *perceptual fidelity* against *computational cost*. In general: use FFT or GPU acceleration to cut CPU use, and choose algorithmic complexity (FIR length, reverb complexity) to fit the target hardware.

## Evaluation Methods and Test Protocols

Rigorous evaluation is crucial. We recommend both **objective** measures and **subjective** listening tests:

* **Objective Metrics:** Although spatial audio is inherently perceptual, some computational metrics exist. For example, *BINAQUAL* is a recent full-reference metric that quantifies localization similarity. It extends ambisonic measures to binaural and correlates with human tests. Other metrics include computing the error in perceived direction (comparing synthesized vs. target ITD/ILD), interaural cross-correlation (IACC) to gauge diffuseness, or spectral distortion measures on HRTFs. For reverberation, early decay time and clarity (C80) measures can be used. These give quick feedback on algorithm tweaks.
* **Subjective Listening Tests:** Ultimately, human judgments matter. Standard protocols include:

  * *Localization tasks*: Present short (e.g. 250 ms) broadband sounds from various azimuths/elevations (random order) and ask listeners to indicate perceived direction (pointing or angle report). Compute accuracy (angular error) and confusion rates (e.g. front-back confusions). Tasks like Minimum Audible Angle (discrimination threshold of small angle changes) can quantify sensitivity.
  * *Externalization ratings*: Play a target sound (e.g. noise burst, speech) and have listeners rate how “in-head” vs “out-of-head” it sounds on a scale. Test conditions might include dry HRTF vs HRTF+reverb.
  * *Distance perception*: If distance cues are simulated, ask subjects to estimate source distance or choose between near/far presentations.
  * *MUSHRA-like or AB tests*: For perceived realism or quality, one can adapt high-end audio tests. For example, give listeners a real recording vs the spatialized output and ask for similarity (e.g. 5-point scale), or ask which sounds more natural. ABX or forced-choice preference between competing algorithms is common. Note: MUSHRA normally tests spectral fidelity; for spatial tests one may use paired comparisons instead.

**Test Stimuli:** Use a variety of signals to cover different cues. Broadband noise (pink or white) is ideal for localization due to full spectrum. Tones (e.g. 500 Hz vs 4 kHz) can isolate ITD vs ILD. Speech and music test realism in complex signals. Impulse trains or clicks test temporal/spatial fusion. For room cues, use sustained noises or speech in virtual space. Stimuli should be well-controlled (constant level, duration \~0.5–1 s) and clearly cover each direction of interest.

In addition, blind tests (unknown conditions) with multiple listeners are recommended for reliability. For example, a balanced design might have each subject compare headphone HRTF-only vs HRTF+reverb, or generic vs personalized HRTFs. Record objective responses and analyze statistically.

## Implementation Patterns and Open-Source References

A practical spatializer is often built in layers (see diagram below). An open-source example is \[libspatialaudio], which unifies Ambisonics, object positioning, and binaural rendering. It supports Ambisonic encoding/decoding up to 3rd order, object-based panning, and headphone rendering via SOFA HRTFs (including a built-in MIT KEMAR set). Other projects include:

* **Steam Audio** (Valve) – offers HRTF binaural rendering, reverb, and ray-traced reflections. It is free for use (proprietary source).
* **Google Resonance Audio** – an open-source SDK (now archived) for HRTF spatialization and ambisonics (Web and native APIs).
* **SoundScape Renderer (SSR)** – a GPL C++ library by Dr. Farnell. It can handle real-time binaural and Ambisonics with various panning.
* **ITU Audio Definition Model (ADM)** – a metadata standard for object-based audio; engines like libspatialaudio can render ADM scenes (positions, levels) to binaural output.
* **SOFA and libmysofa** – libraries to handle HRIR data in SOFA files, enabling interchange of HRTFs.
* **Faust** – a functional DSP language that can generate efficient convolution/IIR code for spatial tasks.

In a custom engine, one might combine these: e.g. use libspatialaudio for Ambisonics and HRTFs, use FFTW or Intel IPP for fast convolution, use eigen or custom math for mixing matrices, etc. Many VR audio plugins (Unity, Unreal) use variants of these engines under the hood. For hardware, GPUs (CUDA/OpenCL) and SIMD (AVX, NEON) are commonly exploited to parallelize convolution and mixing.

Below is a simplified system-flow diagram (Mermaid) illustrating the processing pipeline:

```mermaid
flowchart LR
    A\[Input: Mono or Stereo] --> B\[Preprocessing \& Upmix]
    B --> C\[Directional Panning / Ambisonics]
    C --> D\[HRTF Convolution (Left/Right FIR filters)]
    D --> E\[Add Early Reflections \& Reverb]
    E --> F\[Output: Binaural Headphone Signal]
    G\[Head-Tracker] -.-> D
```

## Comparison of Algorithms and Libraries

|**Algorithm / Tool**|**Description**|**Complexity**|**Latency**|**Perceptual Quality**|**License**|
|-|-|-|-|-|-|
|**FFT Convolution (overlap-add)**|Time-domain convolution via FFT per block.|\~O(N log N) per filter-block|Moderate (block size)|High (full FIR)|Depends on lib|
|**Partitioned FFT Convolution**|Split HRTF into segments for low latency.|\~O(N log N) with overhead|Very low (sub-block)|Very High (full FIR)|-|
|**IIR (Min-phase) Filters**|Approximate HRTF by biquads + delay.|O(N) per output|Very low (<1 ms)|Medium (some spectral loss)|-|
|**Vector-Based Amplitude Panning**|VBAP for object placement (no HRTF).|Low (few multiplies)|Negligible|Low–Medium (no external cues)|Open (many libs)|
|**Ambisonic Decoding**|Decode Ambisonics to binaural via SH basis.|O(N m) (N taps, m channels)|Block-latency|High (order-dependent)|libspatialaudio (LGPL)|
|**LibSpatialAudio**|C++ library: Ambisonics+objects+binaural.|Medium (optimized C++)|Audio-buffer limited|High (MIT HRTF included)|MIT/Apache|
|**Steam Audio**|Commercial C/C++ spatial audio SDK.|High (GPU-capable)|Low (hardware accel.)|High|Free (proprietary)|
|**Resonance Audio**|Google’s spatial audio (legacy).|Medium|Low|High|Apache 2.0|
|**SoundScape Renderer (SSR)**|GPL C++ spatial audio toolkit.|High (optimized)|Low|High|GPL-3.0|
|**Custom Cross-talk Canceller**|Two-speaker CTA for free-field.|Medium (matrix conv)|Buffer-limited|High (speaker setups)|-|

* *FFT Convolution:* Using FFT libraries (FFTW, CUFFT) yields very high-quality rendering at the cost of block-based latency (tens of ms). Partitioned schemes (e.g. small-latency direct path) cut latency with some overhead.
* *IIR (Min-phase):* Much lower CPU, but misses non-minimal phase detail (slightly duller spatial cues).
* *VBAP/Ambisonics:* Provide spatialization from generic signals; quality improves with Ambisonic order. Ambisonic decoding typically requires summing many channels (O(m) per tap, where m≈(order+1)²).
* *Libraries:* LibSpatialAudio (open-source) integrates these in C++. Steam/Resonance are polished but have license constraints. SSR is research-grade and open but GPL-licensed.

## Suggested Test Protocols and Stimuli

**Listening Tests:** We recommend designing standardized tests. For localization accuracy, use pointing or laser-pointer tasks: play a brief broadband noise burst (0.5–1 s) at random azimuth/elevation; have listener indicate direction. Compute error (mean, standard deviation) and confusion matrix (e.g. front-back errors). For distance, use a rating scale or distance-discrimination tasks (e.g. identify which of two sounds is farther). For externalization, use paired comparisons: e.g. present HRTF-only vs HRTF+reverb and ask which sounds more “outside” the head. A MUSHRA-like setup could be used for overall spatial quality: provide the “ground truth” (recording or ideal rendering) and several spatializer variants (including anchors with known flaws), and have listeners rate on a quality scale.

**Stimuli:** Include a variety:

* **Broadband noise** (pink/white) for general localization (all cues available).
* **Pure tones** (e.g. 500 Hz, 4 kHz) to isolate ITD vs ILD ability.
* **Speech and music**: to test realistic content and signal-dependent cues.
* **Clicks/Impulses**: to test temporal cues and precedence.
* **Dynamic scenes**: moving sounds or head rotations to test trackability.

Ensure all stimuli are matched in level and pre-filtered appropriately. Follow guidelines like ISO 389-7 for threshold measurements if needed. For *objective* checks, one can calculate the target vs rendered ILD/ITD for known source positions to quantify cue errors.

## References

Key references used in this report include: The Frontiers review on auditory localization, which summarizes ITD/ILD and reverberation effects; the Frontiers on anatomical ITD limits; Zonooz *et al.* on spectral cues; and Shariat-Panah *et al.* introducing the BINAQUAL localization metric. Open-source resources like the NYU HRIR repository and libspatialaudio documentation guided the practical aspects. Each section above cites these and other primary sources.

