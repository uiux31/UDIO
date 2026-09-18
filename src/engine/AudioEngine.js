/**
 * AudioEngine.js — Master Audio Graph Manager for UDIO
 *
 * Correct signal chain (matches solution.md §2.1):
 *
 *   [source]
 *     → dspInput
 *     → EQ (optional input correction)
 *     → BassEnhancer (optional)
 *     → SpatialEngine (scene analysis + binaural/speaker rendering)
 *     → EarlyReflections (image-source geometry, fed from spatial direct bus)
 *     → RoomSimulator (FDN late reverb)
 *     → [Spatial+Early+Late sum]
 *     → DynamicsProcessor (compressor + soft clip ceiling)
 *     → MasterGain
 *     → Destination
 *
 * Note: RoomSimulator and EarlyReflections now follow spatial rendering,
 * not precede it. This ensures the room model has access to source geometry.
 *
 * Bug fixes (solution.md §6):
 *   - play() is now async and awaits resume()
 *   - pauseOffset is clamped to buffer duration
 *   - loadFile() stops any active stream before loading
 *   - URL.createObjectURL() is revoked on file replacement
 *   - Stream media tracks are fully stopped on loadFile()
 */

import { SpatialEngine } from './SpatialEngine.js';
import { BassEnhancer } from './BassEnhancer.js';
import { Equalizer } from './Equalizer.js';
import { DynamicsProcessor } from './DynamicsProcessor.js';
import { RoomSimulator } from './RoomSimulator.js';
import { EarlyReflections } from '../room/EarlyReflections.js';
import { StemRenderer } from './StemRenderer.js';

export class AudioEngine {
  constructor() {
    this.ctx          = null;
    this.sourceNode   = null;
    this.audioBuffer  = null;
    this.isPlaying    = false;
    this.isStreaming  = false;
    this.streamPaused = false;
    this.mediaStream  = null;
    this.startTime    = 0;
    this.pauseOffset  = 0;
    this._objectURL   = null; // tracked for revocation

    // AI Stem Renderer & Mode
    this.stemRenderer = null;
    this.isAIMode     = false;

    // Modules
    this.spatialEngine    = null;
    this.bassEnhancer     = null;
    this.equalizer        = null;
    this.dynamics         = null;
    this.room             = null;
    this.earlyReflections = null;

    // Analysis
    this.analyserLeft  = null;
    this.analyserRight = null;
    this.analyserMain  = null;

    // Master gain
    this.masterGain = null;

    // Callbacks
    this.onEnded = null;
  }

  /**
   * Initialize the audio context and build the processing graph.
   */
  async init() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: 'interactive'
    });

    // Initialize DSP modules
    this.spatialEngine    = new SpatialEngine(this.ctx);
    this.bassEnhancer     = new BassEnhancer(this.ctx);
    this.equalizer        = new Equalizer(this.ctx);
    this.dynamics         = new DynamicsProcessor(this.ctx);
    this.room             = new RoomSimulator(this.ctx);
    this.earlyReflections = new EarlyReflections(this.ctx);

    // Master gain
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.85;

    // Analysers
    this.analyserLeft  = this.ctx.createAnalyser();
    this.analyserLeft.fftSize = 256;
    this.analyserRight = this.ctx.createAnalyser();
    this.analyserRight.fftSize = 256;
    this.analyserMain  = this.ctx.createAnalyser();
    this.analyserMain.fftSize = 2048;
    this.analyserMain.smoothingTimeConstant = 0.82;

    // Stereo splitter for VU analysers
    this.splitter = this.ctx.createChannelSplitter(2);

    // DSP entry point
    this.dspInput = this.ctx.createGain();

    // ============================================================
    // CORRECT SIGNAL CHAIN ORDER:
    //
    //  dspInput → EQ → Bass → Spatial
    //                              ├─ direct output → EarlyReflections → spatialSum
    //                              └─ direct output → RoomSimulator    → spatialSum
    //                  spatialSum → Dynamics → MasterGain → Dest
    //
    // The spatial engine output is the primary output.
    // EarlyReflections taps from spatialEngine output (direct source sum).
    // RoomSimulator taps from spatialEngine output (for late reverb).
    // ============================================================

    // Pre-spatial: EQ cleanup and optional bass enhancement
    this.dspInput.connect(this.equalizer.input);
    this.equalizer.output.connect(this.bassEnhancer.input);

    // Spatial engine: source analysis + binaural/speaker rendering
    this.bassEnhancer.output.connect(this.spatialEngine.input);

    // Summing bus for spatial + early reflections + late reverb
    this.spatialSum = this.ctx.createGain();
    this.spatialSum.gain.value = 1.0;

    // Spatial direct path into sum
    this.spatialEngine.output.connect(this.spatialSum);

    // Early reflections: fed from spatial output (NOT Side-only)
    this.spatialEngine.output.connect(this.earlyReflections.input);
    this.earlyReflections.output.connect(this.spatialSum);

    // Late reverb: fed from spatial output
    this.spatialEngine.output.connect(this.room.input);
    this.room.output.connect(this.spatialSum);

    // Post-spatial: dynamics (compressor + soft clip)
    this.spatialSum.connect(this.dynamics.input);
    this.dynamics.output.connect(this.masterGain);

    // Master → Analysers → Destination
    this.masterGain.connect(this.analyserMain);
    this.analyserMain.connect(this.ctx.destination);

    // VU analysers (post-master, pre-destination)
    this.masterGain.connect(this.splitter);
    this.splitter.connect(this.analyserLeft,  0);
    this.splitter.connect(this.analyserRight, 1);

    return this;
  }

  /**
   * Resume audio context (needed after user gesture).
   */
  async resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  /**
   * Load an audio file from a File or Blob.
   * Stops any active stream and revokes any previous object URL.
   */
  async loadFile(file) {
    await this.resume();

    // Stop active stream first (if any), then stop playback
    if (this.isStreaming) {
      this.stopStream();
    } else {
      this.stop();
    }

    // Revoke previous object URL to avoid memory leaks
    if (this._objectURL) {
      URL.revokeObjectURL(this._objectURL);
      this._objectURL = null;
    }
    this.clearStemScene();

    const arrayBuffer = await file.arrayBuffer();
    this.audioBuffer  = await this.ctx.decodeAudioData(arrayBuffer);
    this.pauseOffset  = 0;

    return {
      duration:  this.audioBuffer.duration,
      sampleRate: this.audioBuffer.sampleRate,
      channels:  this.audioBuffer.numberOfChannels,
      name:      file.name
    };
  }

  /**
   * Create and connect a new buffer source node.
   */
  _createSource() {
    if (this.sourceNode) {
      try { this.sourceNode.disconnect(); } catch (e) { /* already disconnected */ }
    }

    this.sourceNode = this.ctx.createBufferSource();
    this.sourceNode.buffer = this.audioBuffer;
    this.sourceNode.connect(this.dspInput);

    this.sourceNode.onended = () => {
      if (this.isPlaying && !this.isStreaming) {
        this.isPlaying   = false;
        this.pauseOffset = 0;
        if (this.onEnded) this.onEnded();
      }
    };
  }

  /**
   * Capture system audio via getDisplayMedia.
   * Note: audio track availability depends on browser/OS permissions.
   * This API does NOT guarantee low-level system audio capture on all platforms.
   */
  async captureSystemAudio() {
    await this.resume();

    if (this.isStreaming) this.stopStream();
    else this.stop();

    try {
      this.mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          autoGainControl:  false,
          echoCancellation: false,
          noiseSuppression: false,
          suppressLocalAudioPlayback: true
        }
      });

      const audioTracks = this.mediaStream.getAudioTracks();
      if (audioTracks.length === 0) {
        this.stopStream();
        throw new Error(
          "No audio track found. In the browser dialog, make sure " +
          "'Share audio' or 'Share tab audio' is checked."
        );
      }

      this.isStreaming  = true;
      this.streamPaused = false;

      if (this.sourceNode) {
        try { this.sourceNode.disconnect(); } catch (e) { /* ignore */ }
      }

      this.sourceNode = this.ctx.createMediaStreamSource(this.mediaStream);
      this.sourceNode.connect(this.dspInput);
      this.isPlaying = true;

      // End events
      audioTracks[0].onended = () => {
        this.stopStream();
        if (this.onEnded) this.onEnded();
      };
      const videoTrack = this.mediaStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = () => {
          this.stopStream();
          if (this.onEnded) this.onEnded();
        };
      }

      return true;
    } catch (err) {
      console.error('System audio capture failed:', err);
      throw err;
    }
  }

  /**
   * Toggle pause for live streaming.
   */
  toggleStreamPause() {
    if (!this.isStreaming || !this.mediaStream) return;
    this.streamPaused = !this.streamPaused;
    this.mediaStream.getAudioTracks().forEach(t => {
      t.enabled = !this.streamPaused;
    });
    this.isPlaying = !this.streamPaused;
    return this.isPlaying;
  }

  /**
   * Stop and release the active media stream (all tracks).
   */
  stopStream() {
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    this.isStreaming  = false;
    this.streamPaused = false;
    this.stop();
  }

  /**
   * Load a SpatialScene JSON from AI backend and initialize StemRenderer.
   * Switches engine to AI stem rendering mode.
   *
   * @param {object} spatialScene
   * @returns {Promise<{duration: number, sources: Array, jobId: string}>}
   */
  async loadStemScene(spatialScene) {
    await this.resume();
    this.stop();
    if (this.isStreaming) this.stopStream();

    if (!this.stemRenderer) {
      this.stemRenderer = new StemRenderer(
        this.ctx,
        this.spatialSum,
        this.room ? this.room.input : null,
        this.earlyReflections ? this.earlyReflections.input : null
      );
    }

    this.stemRenderer.onEnded = () => {
      this.isPlaying = false;
      if (this.onEnded) this.onEnded();
    };

    await this.stemRenderer.loadScene(spatialScene);
    this.isAIMode = true;

    return {
      duration: this.stemRenderer.duration,
      sources: spatialScene.sources || [],
      jobId: spatialScene.jobId
    };
  }

  /**
   * Clear active stem renderer and return to standard stereo DSP mode.
   */
  clearStemScene() {
    if (this.stemRenderer) {
      this.stemRenderer.dispose();
      this.stemRenderer = null;
    }
    this.isAIMode = false;
  }

  /**
   * Play audio. Awaits context resume before scheduling.
   */
  async play() {
    await this.resume();

    if (this.isAIMode && this.stemRenderer) {
      await this.stemRenderer.play();
      this.isPlaying = true;
      return;
    }

    if (this.isStreaming) {
      if (this.streamPaused) this.toggleStreamPause();
      return;
    }
    if (!this.audioBuffer) return;

    this._createSource();
    this.sourceNode.start(0, this.pauseOffset);
    this.startTime = this.ctx.currentTime - this.pauseOffset;
    this.isPlaying = true;
  }

  /**
   * Pause audio.
   */
  pause() {
    if (this.isAIMode && this.stemRenderer) {
      this.stemRenderer.pause();
      this.isPlaying = false;
      return;
    }

    if (this.isStreaming) {
      if (!this.streamPaused) this.toggleStreamPause();
      return;
    }
    if (!this.isPlaying) return;

    // Clamp pauseOffset to buffer duration to prevent drift
    const raw = this.ctx.currentTime - this.startTime;
    this.pauseOffset = Math.min(
      Math.max(0, raw),
      this.audioBuffer ? this.audioBuffer.duration : 0
    );
    this.sourceNode.onended = null;
    try { this.sourceNode.stop(); } catch (e) { /* ok */ }
    this.isPlaying = false;
  }

  /**
   * Stop and reset playback.
   */
  stop() {
    if (this.isAIMode && this.stemRenderer) {
      this.stemRenderer.stop();
      this.isPlaying = false;
      return;
    }

    if (this.sourceNode && !this.isStreaming) {
      this.sourceNode.onended = null;
      try { this.sourceNode.stop(); } catch (e) { /* not started */ }
    } else if (this.sourceNode && this.isStreaming) {
      try { this.sourceNode.disconnect(); } catch (e) { /* ignore */ }
    }
    this.isPlaying   = false;
    this.pauseOffset = 0;
  }

  /**
   * Seek to a position fraction (0–1).
   */
  seek(fraction) {
    if (this.isAIMode && this.stemRenderer) {
      this.stemRenderer.seek(fraction);
      return;
    }

    if (!this.audioBuffer) return;
    const time = fraction * this.audioBuffer.duration;
    const wasPlaying = this.isPlaying;

    if (wasPlaying) {
      this.sourceNode.onended = null;
      try { this.sourceNode.stop(); } catch (e) { /* ok */ }
      this.isPlaying = false;
    }

    // Clamp seek target
    this.pauseOffset = Math.max(0, Math.min(time, this.audioBuffer.duration));

    if (wasPlaying) this.play();
  }

  /**
   * Get current playback time in seconds.
   */
  getCurrentTime() {
    if (this.isAIMode && this.stemRenderer) {
      return this.stemRenderer.getCurrentTime();
    }

    if (this.isPlaying && !this.isStreaming) {
      const raw = this.ctx.currentTime - this.startTime;
      if (this.audioBuffer) {
        return Math.min(raw, this.audioBuffer.duration);
      }
      return raw;
    }
    return this.pauseOffset;
  }

  /**
   * Get total duration in seconds.
   */
  getDuration() {
    if (this.isAIMode && this.stemRenderer) {
      return this.stemRenderer.duration || 0;
    }
    return this.audioBuffer ? this.audioBuffer.duration : 0;
  }

  /**
   * Set master volume (0–1).
   */
  setVolume(value) {
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.02);
    }
  }

  /**
   * Set spatial reproduction mode ('headphones' or 'speakers').
   */
  setSpatialMode(mode) {
    if (this.spatialEngine) this.spatialEngine.setMode(mode);
  }

  /**
   * Enable/disable spatial bypass for A/B comparison.
   */
  setSpatialBypass(bypassed) {
    if (this.spatialEngine) {
      this.spatialEngine.setBypass(bypassed);
      return this.spatialEngine.isBypassed;
    }
    return false;
  }

  /**
   * Check if spatial engine is bypassed.
   */
  isSpatialBypassed() {
    return this.spatialEngine ? this.spatialEngine.isBypassed : false;
  }

  /**
   * Set stage width (0–200 → normalized 0–2.0).
   * Controls azimuth angle only (not distance or level).
   */
  setSpatialWidth(value) {
    if (this.spatialEngine) this.spatialEngine.setWidth(value / 100);
  }

  /** Backward compatibility alias. */
  setStereoWidth(value) { this.setSpatialWidth(value); }

  /**
   * Set depth (0–100 → normalized 0–1.0).
   * Controls distance + DRR + HF air absorption.
   */
  setSpatialDepth(value) {
    const norm = value / 100;
    if (this.spatialEngine) this.spatialEngine.setDepth(norm);
    // Sync early reflections source depth
    if (this.earlyReflections) this.earlyReflections.setSourceDepth(norm);
    // Sync late reverb pre-delay
    const { depthToDistance } = this._getSpatialMath();
    if (this.room) {
      this.room.setPreDelay(depthToDistance(norm));
    }
  }

  /**
   * Helper to lazily import SpatialMath (avoids circular import issue).
   * @private
   */
  _getSpatialMath() {
    // Inline the simple distance mapping to avoid dynamic import complexity
    const depthToDistance = (depth, near = 0.75, far = 8.0) =>
      near + depth * (far - near);
    return { depthToDistance };
  }

  /**
   * Set center focus / vocal anchor (0–100 → normalized 0–1.0).
   * Controls center extraction coefficient (not just gain).
   */
  setCenterFocus(value) {
    if (this.spatialEngine) this.spatialEngine.setCenterFocus(value / 100);
  }

  /**
   * Set artistic height elevation (0–100 → normalized 0–1.0).
   */
  setSpatialElevation(value) {
    if (this.spatialEngine) this.spatialEngine.setElevation(value / 100);
  }

  /**
   * Set bass enhancement (0–100).
   */
  setBassEnhance(value) {
    if (this.bassEnhancer) this.bassEnhancer.setAmount(value / 100);
  }

  /**
   * Set room reverb amount (0–100).
   * Controls both early reflections and late reverb.
   */
  setRoomReverb(value) {
    const norm = value / 100;
    if (this.room) this.room.setAmount(norm);
    if (this.earlyReflections) this.earlyReflections.setAmount(norm);
  }

  /**
   * Set dynamics processing amount (0–100).
   */
  setDynamics(value) {
    if (this.dynamics) this.dynamics.setAmount(value / 100);
  }

  /**
   * Set EQ band gain in dB.
   */
  setEQBand(band, gain) {
    if (this.equalizer) this.equalizer.setBand(band, gain);
  }

  /**
   * Enable/disable EQ.
   */
  setEQEnabled(enabled) {
    if (this.equalizer) this.equalizer.setEnabled(enabled);
  }

  /**
   * Get frequency data for spectrum analyzer.
   */
  getFrequencyData() {
    if (!this.analyserMain) return new Uint8Array(0);
    const data = new Uint8Array(this.analyserMain.frequencyBinCount);
    this.analyserMain.getByteFrequencyData(data);
    return data;
  }

  /**
   * Get peak levels for VU meters ({ left, right } from 0–1).
   */
  getPeakLevels() {
    if (!this.analyserLeft || !this.analyserRight) return { left: 0, right: 0 };

    const leftData  = new Uint8Array(this.analyserLeft.frequencyBinCount);
    const rightData = new Uint8Array(this.analyserRight.frequencyBinCount);
    this.analyserLeft.getByteTimeDomainData(leftData);
    this.analyserRight.getByteTimeDomainData(rightData);

    let leftPeak = 0, rightPeak = 0;
    for (let i = 0; i < leftData.length; i++) {
      const lv = Math.abs(leftData[i]  - 128) / 128;
      const rv = Math.abs(rightData[i] - 128) / 128;
      if (lv > leftPeak)  leftPeak  = lv;
      if (rv > rightPeak) rightPeak = rv;
    }

    return { left: leftPeak, right: rightPeak };
  }

  /**
   * Get backend info for UI status display.
   */
  getBackendInfo() {
    return this.spatialEngine
      ? this.spatialEngine.getBackendInfo()
      : { renderer: 'Not initialized' };
  }

  /**
   * Apply a preset configuration.
   */
  applyPreset(preset) {
    if (preset.mode         !== undefined) this.setSpatialMode(preset.mode);
    if (preset.stereoWidth  !== undefined) this.setSpatialWidth(preset.stereoWidth);
    if (preset.spatialDepth !== undefined) this.setSpatialDepth(preset.spatialDepth);
    if (preset.centerFocus  !== undefined) this.setCenterFocus(preset.centerFocus);
    if (preset.elevation    !== undefined) this.setSpatialElevation(preset.elevation);
    if (preset.bassEnhance  !== undefined) this.setBassEnhance(preset.bassEnhance);
    if (preset.roomReverb   !== undefined) this.setRoomReverb(preset.roomReverb);
    if (preset.dynamics     !== undefined) this.setDynamics(preset.dynamics);
    if (preset.eq) {
      preset.eq.forEach((gain, i) => this.setEQBand(i, gain));
    }
  }

  /**
   * Teardown: dispose spatial engine and release resources.
   */
  dispose() {
    this.clearStemScene();
    if (this.spatialEngine) this.spatialEngine.dispose();
    if (this._objectURL) {
      URL.revokeObjectURL(this._objectURL);
      this._objectURL = null;
    }
  }
}
