/**
 * presets.js — UDIO Spatial Audio Presets
 *
 * All preset names are honest descriptions of the DSP configuration.
 * No brand-specific algorithm claims (Dolby Atmos, DTS, etc.).
 * No false technology claims (7.1.4, Atmos metadata, etc.).
 *
 * Preset values are tuned for the refactored source-object renderer.
 * See solution.md §27 for the design rationale behind each preset.
 */

export const presets = {
  'wide-binaural': {
    name: '🎧 Wide Binaural',
    mode: 'headphones',
    stereoWidth:  110,   // ±30° front stage
    spatialDepth:  35,   // moderate distance
    centerFocus:   75,
    elevation:     15,   // slight height
    bassEnhance:   20,
    roomReverb:    15,
    dynamics:      10
  },

  'cinema-wide': {
    name: '🎬 Cinema Wide',
    mode: 'headphones',
    stereoWidth:  130,   // wider stage
    spatialDepth:  65,
    centerFocus:   75,
    elevation:     25,
    bassEnhance:   25,
    roomReverb:    30,
    dynamics:      15
  },

  'live-stream': {
    name: '🔴 Live Stream 3D',
    mode: 'headphones',
    stereoWidth:  105,   // subtle widening
    spatialDepth:  15,   // little distance
    centerFocus:   50,   // less center extraction to preserve original mix
    elevation:      0,
    bassEnhance:    5,   // minimal enhancement, system audio usually has enough
    roomReverb:     5,
    dynamics:       5    // minimal compression to prevent pumping
  },

  'music-wide': {
    name: '🎵 Music Wide',
    mode: 'headphones',
    stereoWidth:  105,
    spatialDepth:  40,
    centerFocus:   80,
    elevation:     20,
    bassEnhance:   30,
    roomReverb:    18,
    dynamics:      12
  },

  'laptop-safe': {
    name: '💻 Laptop Stereo Expander',
    mode: 'speakers',
    stereoWidth:  130,   // k=1.3 in M/S matrix
    spatialDepth:  30,
    centerFocus:   80,
    elevation:      0,
    bassEnhance:   40,
    roomReverb:    12,
    dynamics:      20
  },

  'vocal-focus': {
    name: '🎙️ Vocal Focus',
    mode: 'headphones',
    stereoWidth:   75,   // ±22°, narrow stage
    spatialDepth:  20,   // close
    centerFocus:   95,   // maximum center extraction
    elevation:      5,
    bassEnhance:    5,
    roomReverb:     8,
    dynamics:      10
  },

  'large-room': {
    name: '🏛️ Large Room',
    mode: 'headphones',
    stereoWidth:  140,
    spatialDepth:  80,
    centerFocus:   65,
    elevation:     30,
    bassEnhance:   20,
    roomReverb:    55,
    dynamics:      15
  },

  'bass-assist': {
    name: '🔊 Bass Assist',
    mode: 'headphones',
    stereoWidth:  100,
    spatialDepth:  35,
    centerFocus:   85,
    elevation:      5,
    bassEnhance:   80,
    roomReverb:    10,
    dynamics:      25
  },

  'flat': {
    name: '— Flat / Direct —',
    mode: 'headphones',
    stereoWidth:  100,
    spatialDepth:   0,
    centerFocus:  100,
    elevation:      0,
    bassEnhance:    0,
    roomReverb:     0,
    dynamics:       0
  }
};
