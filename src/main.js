/**
 * main.js — UDIO Application Entry Point
 * 
 * Wires together:
 * - AudioEngine (3D Spatial Core, HRTF, ISM Early Reflections, Dynamics)
 * - SoundstageRadar (Real-time 3D Acoustic Visualizer)
 * - Spectrum Analyzer & VU Level Meters
 * - Dual Mode Selector (Headphones vs Laptop Speakers)
 * - 6 Precision DSP Knobs (Width, Depth, Focus, Height, Room, Bass)
 * - Waveform Display, Presets & Rock-solid System Audio Streaming
 */

import { AudioEngine } from './engine/AudioEngine.js';
import { presets } from './presets.js';
import { AIClient } from './ai/AIClient.js';
import WaveSurfer from 'wavesurfer.js';

// ============================================================
// Globals
// ============================================================
let engine = null;
let wavesurfer = null;
let animFrameId = null;
let currentFile = null;
const aiClient = new AIClient();
let activePipeline = 'quick'; // 'quick' or 'ai'
let currentSpatialScene = null;

// ============================================================
// DOM References
// ============================================================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const welcomeState = $('#welcomeState');
const playerSection = $('#playerSection');
const btnLoadFile = $('#btnLoadFile');
const btnCaptureAudio = $('#btnCaptureAudio');
const btnHome = $('#btnHome');
const fileInput = $('#fileInput');
const dropZone = $('#dropZone');
const btnPlay = $('#btnPlay');
const playIcon = $('#playIcon');
const pauseIcon = $('#pauseIcon');
const btnPrev = $('#btnPrev');
const btnNext = $('#btnNext');
const timeDisplay = $('#timeDisplay');
const volumeSlider = $('#volumeSlider');
const btnMute = $('#btnMute');
const trackName = $('#trackName');
const presetSelect = $('#presetSelect');
const spectrumCanvas = $('#spectrumCanvas');
const radarCanvas = $('#radarCanvas');
const radarModeBadge = $('#radarModeBadge');
const btnModeHeadphones = $('#btnModeHeadphones');
const btnModeSpeakers = $('#btnModeSpeakers');
const btnSpatialToggle = $('#btnSpatialToggle');
const vuLeft = $('#vuLeft');
const vuRight = $('#vuRight');
const eqToggle = $('#eqToggle');
const btnInfo = $('#btnInfo');
const infoModal = $('#infoModal');
const modalClose = $('#modalClose');

// AI DOM References
const btnPipelineQuick = $('#btnPipelineQuick');
const btnPipelineAI = $('#btnPipelineAI');
const aiBackendBadge = $('#aiBackendBadge');
const aiBadgeText = $('#aiBadgeText');
const aiStemPanel = $('#aiStemPanel');
const aiModelSelect = $('#aiModelSelect');
const btnStartSeparation = $('#btnStartSeparation');
const btnSeparateText = $('#btnSeparateText');
const aiProgressWrap = $('#aiProgressWrap');
const aiProgressStage = $('#aiProgressStage');
const aiProgressPct = $('#aiProgressPct');
const aiProgressFill = $('#aiProgressFill');
const aiStemsContainer = $('#aiStemsContainer');

// ============================================================
// Inject SVG gradient definitions for knobs
// ============================================================
function injectSVGDefs() {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.style.position = 'absolute';
  svg.style.width = '0';
  svg.style.height = '0';
  svg.innerHTML = `
    <defs>
      <linearGradient id="knobGradient" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#6C5CE7"/>
        <stop offset="100%" stop-color="#00E5FF"/>
      </linearGradient>
    </defs>
  `;
  document.body.prepend(svg);
}

// ============================================================
// Format time helper
// ============================================================
function formatTime(seconds) {
  if (!seconds || !isFinite(seconds) || seconds < 0) return '0:00';
  const totalSecs = Math.max(0, Math.floor(seconds));
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ============================================================
// Knob Control System
// ============================================================
class KnobController {
  constructor(element) {
    this.el = element;
    this.param = element.dataset.param;
    this.min = parseFloat(element.dataset.min);
    this.max = parseFloat(element.dataset.max);
    this.value = parseFloat(element.dataset.value);

    this.fillCircle = element.querySelector('.knob-fill');
    this.indicator = element.querySelector('.knob-indicator');

    this.isDragging = false;
    this.startY = 0;
    this.startValue = 0;

    this._bindEvents();
    this._updateVisual();
  }

  _bindEvents() {
    this.el.addEventListener('mousedown', (e) => this._onStart(e));
    this.el.addEventListener('touchstart', (e) => this._onStart(e), { passive: false });

    window.addEventListener('mousemove', (e) => this._onMove(e));
    window.addEventListener('touchmove', (e) => this._onMove(e), { passive: false });

    window.addEventListener('mouseup', () => this._onEnd());
    window.addEventListener('touchend', () => this._onEnd());

    // Double-click to reset to default
    this.el.addEventListener('dblclick', () => {
      const defaultVal = parseFloat(this.el.dataset.value);
      this.setValue(defaultVal);
    });
  }

  _onStart(e) {
    e.preventDefault();
    this.isDragging = true;
    this.startY = e.clientY || e.touches[0].clientY;
    this.startValue = this.value;
    this.el.style.cursor = 'grabbing';
  }

  _onMove(e) {
    if (!this.isDragging) return;
    e.preventDefault();
    const clientY = e.clientY || e.touches[0].clientY;
    const delta = this.startY - clientY;
    const range = this.max - this.min;
    const sensitivity = range / 150;
    const newValue = Math.max(this.min, Math.min(this.max, this.startValue + delta * sensitivity));
    this.setValue(newValue);
  }

  _onEnd() {
    if (!this.isDragging) return;
    this.isDragging = false;
    this.el.style.cursor = 'grab';
  }

  setValue(value) {
    this.value = Math.round(value * 10) / 10;
    this._updateVisual();
    this._emitChange();
  }

  _updateVisual() {
    const fraction = (this.value - this.min) / (this.max - this.min);
    const arcLength = fraction * 230;
    if (this.fillCircle) {
      this.fillCircle.style.strokeDasharray = `${arcLength} 264`;
    }
    if (this.indicator) {
      const angle = -135 + fraction * 270;
      this.indicator.style.transform = `rotate(${angle}deg)`;
      this.indicator.style.transformOrigin = '50px 50px';
    }
  }

  _emitChange() {
    const event = new CustomEvent('knob-change', {
      detail: { param: this.param, value: this.value },
      bubbles: true
    });
    this.el.dispatchEvent(event);
  }
}

// ============================================================
// 3D Soundstage Radar Visualizer
// ============================================================
class SoundstageRadar {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = 1.4;
    this.depth = 0.5;
    this.focus = 0.85;
    this.elevation = 0.3;
    this.mode = 'headphones';
    this.isBypassed = false;
    this.aiSources = null;
    this.waveRings = [];
    this.lastRingTime = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setAISources(sources) {
    this.aiSources = sources;
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = rect.width || 240;
    this.canvas.height = 180;
  }

  setParams(params) {
    if (params.width !== undefined) this.width = params.width;
    if (params.depth !== undefined) this.depth = params.depth;
    if (params.focus !== undefined) this.focus = params.focus;
    if (params.elevation !== undefined) this.elevation = params.elevation;
    if (params.mode !== undefined) this.mode = params.mode;
    if (params.isBypassed !== undefined) this.isBypassed = params.isBypassed;
  }

  draw(levels) {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h * 0.54;

    ctx.clearRect(0, 0, w, h);

    const maxRadius = Math.min(cx - 16, cy - 12);
    const avgLevel = (levels.left + levels.right) * 0.5;

    // A/B BYPASS RENDER: Flat 2D Stereo
    if (this.isBypassed) {
      // Dim grid
      ctx.strokeStyle = 'rgba(255, 170, 0, 0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, maxRadius * 0.7, 0, Math.PI * 2);
      ctx.stroke();

      // Flat stereo axis line
      ctx.strokeStyle = 'rgba(255, 170, 0, 0.4)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(cx - maxRadius * 0.55, cy);
      ctx.lineTo(cx + maxRadius * 0.55, cy);
      ctx.stroke();
      ctx.setLineDash([]);

      // Left & Right flat 2D dots
      const leftSize = 5 + levels.left * 5;
      const rightSize = 5 + levels.right * 5;

      ctx.fillStyle = '#FFAA00';
      ctx.beginPath();
      ctx.arc(cx - maxRadius * 0.55, cy, leftSize, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(cx + maxRadius * 0.55, cy, rightSize, 0, Math.PI * 2);
      ctx.fill();

      ctx.font = '10px JetBrains Mono, monospace';
      ctx.fillStyle = '#FFAA00';
      ctx.textAlign = 'center';
      ctx.fillText('L (2D)', cx - maxRadius * 0.55, cy - leftSize - 4);
      ctx.fillText('R (2D)', cx + maxRadius * 0.55, cy - rightSize - 4);

      // Warning text
      ctx.font = '11px JetBrains Mono, monospace';
      ctx.fillStyle = 'rgba(255, 170, 0, 0.85)';
      ctx.fillText('FLAT 2D STEREO (BYPASSED)', cx, cy + maxRadius * 0.65);

      const telemetryEl = document.getElementById('radarTelemetry');
      if (telemetryEl) {
        telemetryEl.textContent = '3D ENGINE BYPASSED · DIRECT 2D STEREO';
      }
      return;
    }

    // 1. Radar Polar Grid Circles
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    [0.35, 0.7, 1.0].forEach(frac => {
      ctx.beginPath();
      ctx.arc(cx, cy, maxRadius * frac, 0, Math.PI * 2);
      ctx.stroke();
    });

    // Angle Grid Lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    [-60, -30, 0, 30, 60, 90, -90].forEach(deg => {
      const rad = (deg - 90) * (Math.PI / 180);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(rad) * maxRadius, cy + Math.sin(rad) * maxRadius);
      ctx.stroke();
    });

    // 2. Dynamic Acoustic Wave Propagation
    const now = performance.now();
    if (avgLevel > 0.06 && now - this.lastRingTime > 140) {
      this.waveRings.push({
        radius: 12,
        maxR: maxRadius * (0.65 + this.width * 0.2),
        alpha: Math.min(0.65, avgLevel * 1.6),
        speed: 1.4 + avgLevel * 2.2
      });
      this.lastRingTime = now;
    }

    ctx.save();
    for (let i = this.waveRings.length - 1; i >= 0; i--) {
      const ring = this.waveRings[i];
      ring.radius += ring.speed;
      const progress = ring.radius / ring.maxR;
      const curAlpha = (1 - progress) * ring.alpha;

      if (curAlpha <= 0.01 || ring.radius >= ring.maxR) {
        this.waveRings.splice(i, 1);
        continue;
      }

      ctx.strokeStyle = `rgba(0, 229, 255, ${curAlpha})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, ring.radius, -Math.PI * 0.85, -Math.PI * 0.15);
      ctx.stroke();
    }
    ctx.restore();

    // 3. Listener Head at Origin
    ctx.save();
    const headGrad = ctx.createRadialGradient(cx, cy, 2, cx, cy, 15);
    headGrad.addColorStop(0, 'rgba(108, 92, 231, 0.8)');
    headGrad.addColorStop(1, 'rgba(108, 92, 231, 0)');
    ctx.fillStyle = headGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, 15, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#6C5CE7';
    ctx.beginPath();
    ctx.arc(cx, cy, 8, 0, Math.PI * 2);
    ctx.fill();

    // Front Nose / Direction Arrow
    ctx.fillStyle = '#00E5FF';
    ctx.beginPath();
    ctx.moveTo(cx - 3, cy - 8);
    ctx.lineTo(cx + 3, cy - 8);
    ctx.lineTo(cx, cy - 14);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 4. Virtual 3D Audio Source Objects (AI Stems or Virtual DSP Sources)
    if (this.aiSources && this.aiSources.length > 0) {
      const stemColors = {
        vocals: '#00E5FF',
        drums:  '#E056FD',
        bass:   '#FF9F43',
        other:  '#00FFC5'
      };

      ctx.font = '9px JetBrains Mono, monospace';
      ctx.textAlign = 'center';

      this.aiSources.forEach(src => {
        const rad = (src.azimuth - 90) * (Math.PI / 180);
        const normDist = Math.max(0.35, Math.min(0.95, (src.distance || 1.5) / 2.5));
        const sx = cx + Math.cos(rad) * (maxRadius * normDist);
        const sy = cy + Math.sin(rad) * (maxRadius * normDist);
        const color = stemColors[src.id] || '#A29BFE';
        const nodeSize = 5 + (levels.left + levels.right) * 3.5;

        // Ray
        ctx.strokeStyle = `${color}40`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(sx, sy);
        ctx.stroke();

        // Glow halo
        ctx.fillStyle = `${color}35`;
        ctx.beginPath();
        ctx.arc(sx, sy, nodeSize + 4, 0, Math.PI * 2);
        ctx.fill();

        // Node
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(sx, sy, nodeSize, 0, Math.PI * 2);
        ctx.fill();

        // Text label
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(src.id.toUpperCase(), sx, sy - nodeSize - 4);
      });

      const telemetryEl = document.getElementById('radarTelemetry');
      if (telemetryEl) {
        telemetryEl.textContent = 'AI 3D STEMS · 4 SOURCES SPATIALLY MAPPED';
      }
      return;
    }

    const wFactor = Math.min(1.8, Math.max(0.4, this.width));
    const dFactor = 0.65 + this.depth * 0.32;

    const sources = [
      { name: 'C',  angle: 0,                     dist: 0.90 * dFactor, color: '#00E5FF', size: 4 + this.focus * 3 },
      { name: 'L',  angle: -30 * wFactor,         dist: 0.85 * dFactor, color: '#A29BFE', size: 4 + levels.left * 4 },
      { name: 'R',  angle: 30 * wFactor,          dist: 0.85 * dFactor, color: '#A29BFE', size: 4 + levels.right * 4 },
      { name: 'SL', angle: -95 * (wFactor * 0.9), dist: 0.78 * dFactor, color: '#6C5CE7', size: 3.5 + levels.left * 3 },
      { name: 'SR', angle: 95 * (wFactor * 0.9),  dist: 0.78 * dFactor, color: '#6C5CE7', size: 3.5 + levels.right * 3 },
    ];

    if (this.elevation > 0.15) {
      sources.push(
        { name: 'HL', angle: -45 * wFactor, dist: 0.52 * dFactor, color: '#00FFC5', size: 3 + this.elevation * 3 },
        { name: 'HR', angle: 45 * wFactor,  dist: 0.52 * dFactor, color: '#00FFC5', size: 3 + this.elevation * 3 }
      );
    }

    ctx.font = '9px JetBrains Mono, monospace';
    ctx.textAlign = 'center';

    sources.forEach(src => {
      const rad = (src.angle - 90) * (Math.PI / 180);
      const sx = cx + Math.cos(rad) * (maxRadius * src.dist);
      const sy = cy + Math.sin(rad) * (maxRadius * src.dist);

      // Ray
      ctx.strokeStyle = `${src.color}24`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(sx, sy);
      ctx.stroke();

      // Glow halo
      ctx.fillStyle = `${src.color}35`;
      ctx.beginPath();
      ctx.arc(sx, sy, src.size + 3, 0, Math.PI * 2);
      ctx.fill();

      // Node
      ctx.fillStyle = src.color;
      ctx.beginPath();
      ctx.arc(sx, sy, src.size, 0, Math.PI * 2);
      ctx.fill();

      // Text label
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.fillText(src.name, sx, sy - src.size - 3);
    });

    // Update telemetry readout text
    const telemetryEl = document.getElementById('radarTelemetry');
    if (telemetryEl) {
      telemetryEl.textContent = `WIDTH: ${Math.round(this.width * 100)}% · DEPTH: ${Math.round(this.depth * 100)}% · FOCUS: ${Math.round(this.focus * 100)}%`;
    }
  }
}

// ============================================================
// Spectrum Analyzer with Studio Peak-Hold Indicators
// ============================================================
class SpectrumAnalyzer {
  constructor(canvas) {
    this.canvas = canvas;
    this.canvasCtx = canvas.getContext('2d');
    this.peaks = new Float32Array(128);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = rect.width - 24;
    this.canvas.height = 195;
  }

  draw(frequencyData) {
    const { canvasCtx: ctx, canvas } = this;
    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);

    if (!frequencyData || frequencyData.length === 0) return;

    const barCount = Math.min(128, frequencyData.length);
    const barWidth = (width / barCount) * 0.82;
    const barGap = (width / barCount) * 0.18;

    for (let i = 0; i < barCount; i++) {
      const dataIndex = Math.floor(Math.pow(i / barCount, 1.5) * frequencyData.length);
      const value = frequencyData[dataIndex] / 255;
      const barHeight = value * height * 0.85;

      // Peak hold calculation with gravity decay
      if (value > this.peaks[i]) {
        this.peaks[i] = value;
      } else {
        this.peaks[i] = Math.max(0, this.peaks[i] - 0.009);
      }

      const x = i * (barWidth + barGap);
      const y = height - barHeight;

      // Electric gradient (Purple -> Cyan -> Mint)
      const hue = 255 + (i / barCount) * 125;
      const sat = 75 + value * 25;
      const light = 48 + value * 25;

      ctx.fillStyle = `hsla(${hue % 360}, ${sat}%, ${light}%, ${0.55 + value * 0.45})`;
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barHeight, [3, 3, 0, 0]);
      ctx.fill();

      // Peak Hold Indicator Line (Studio gear style)
      if (this.peaks[i] > 0.05) {
        const peakY = height - this.peaks[i] * height * 0.85 - 2;
        ctx.fillStyle = `hsla(${(hue + 20) % 360}, 100%, 75%, 0.85)`;
        ctx.fillRect(x, peakY, barWidth, 2);
      }

      // Dynamic glow for high energy bands
      if (value > 0.65) {
        ctx.shadowColor = `hsla(${hue % 360}, 100%, 65%, 0.4)`;
        ctx.shadowBlur = 10;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }
  }
}

// ============================================================
// Initialize Application
// ============================================================
async function initApp() {
  injectSVGDefs();

  // Initialize audio engine
  engine = new AudioEngine();
  await engine.init();

  // Initialize visualizers
  const spectrum = new SpectrumAnalyzer(spectrumCanvas);
  const radar = new SoundstageRadar(radarCanvas);

  // Initialize knobs
  const knobs = {};
  $$('.knob').forEach(el => {
    const knob = new KnobController(el);
    knobs[knob.param] = knob;
  });

  // Mode Selection (Headphones vs Laptop Speakers)
  function setSpatialMode(mode) {
    engine.setSpatialMode(mode);
    radar.setParams({ mode });

    if (mode === 'headphones') {
      btnModeHeadphones.classList.add('active');
      btnModeSpeakers.classList.remove('active');
      radarModeBadge.textContent = 'BROWSER HRTF';
      radarModeBadge.style.color = 'var(--color-accent)';
      radarModeBadge.style.borderColor = 'rgba(0, 229, 255, 0.35)';
    } else {
      btnModeSpeakers.classList.add('active');
      btnModeHeadphones.classList.remove('active');
      radarModeBadge.textContent = 'STEREO EXPANDER';
      radarModeBadge.style.color = '#A29BFE';
      radarModeBadge.style.borderColor = 'rgba(162, 155, 254, 0.35)';
    }
  }

  btnModeHeadphones.addEventListener('click', () => setSpatialMode('headphones'));
  btnModeSpeakers.addEventListener('click', () => setSpatialMode('speakers'));

  // 3D Spatial A/B Instant Bypass Switch
  function setBypassState(bypassed) {
    engine.setSpatialBypass(bypassed);
    radar.setParams({ isBypassed: bypassed });

    if (btnSpatialToggle) {
      if (bypassed) {
        btnSpatialToggle.classList.remove('active');
        btnSpatialToggle.classList.add('bypassed');
        btnSpatialToggle.querySelector('.bypass-text').textContent = '2D STEREO (BYPASSED)';
        radarModeBadge.textContent = '2D BYPASS';
        radarModeBadge.style.color = '#FFAA00';
        radarModeBadge.style.borderColor = 'rgba(255, 170, 0, 0.4)';
      } else {
        btnSpatialToggle.classList.add('active');
        btnSpatialToggle.classList.remove('bypassed');
        btnSpatialToggle.querySelector('.bypass-text').textContent = '3D SOUND: ON';
        radarModeBadge.textContent = engine.spatialEngine.mode === 'headphones' ? 'BROWSER HRTF' : 'STEREO EXPANDER';
        radarModeBadge.style.color = 'var(--color-accent)';
        radarModeBadge.style.borderColor = 'rgba(0, 229, 255, 0.35)';
      }
    }
  }

  if (btnSpatialToggle) {
    btnSpatialToggle.addEventListener('click', () => {
      const isCurrentlyBypassed = engine.isSpatialBypassed();
      setBypassState(!isCurrentlyBypassed);
    });
  }

  // ============================================================
  // AI Pipeline & Neural Separation Controls
  // ============================================================
  async function updateAIBackendStatus() {
    if (!aiBackendBadge || !aiBadgeText) return;
    const health = await aiClient.checkBackend();
    if (health && aiClient.backendAvailable) {
      aiBackendBadge.classList.remove('offline');
      aiBackendBadge.classList.add('online');
      const modelName = health.models?.bs_roformer ? 'BS-RoFormer' : 'HTDemucs';
      const dev = health.device ? ` · ${health.device.toUpperCase()}` : '';
      aiBadgeText.textContent = `AI: Online · ${modelName}${dev}`;
      aiBackendBadge.title = `Local AI Backend Online: ${health.device || 'CPU'}. Click to re-check.`;
    } else {
      aiBackendBadge.classList.remove('online');
      aiBackendBadge.classList.add('offline');
      aiBadgeText.textContent = 'AI: Offline';
      aiBackendBadge.title = 'Local AI Backend Offline (FastAPI on :8000). Click to re-check.';
    }
  }

  if (aiBackendBadge) {
    aiBackendBadge.addEventListener('click', () => {
      aiBadgeText.textContent = 'AI: Checking...';
      updateAIBackendStatus();
    });
    updateAIBackendStatus();
    setInterval(updateAIBackendStatus, 15000);
  }

  function setPipeline(mode) {
    activePipeline = mode;
    if (mode === 'ai') {
      if (btnPipelineAI) btnPipelineAI.classList.add('active');
      if (btnPipelineQuick) btnPipelineQuick.classList.remove('active');
      if (aiStemPanel && currentFile) {
        aiStemPanel.style.display = 'flex';
      }
      if (!aiClient.backendAvailable) {
        updateAIBackendStatus();
      }
    } else {
      if (btnPipelineQuick) btnPipelineQuick.classList.add('active');
      if (btnPipelineAI) btnPipelineAI.classList.remove('active');
      if (aiStemPanel) aiStemPanel.style.display = 'none';
      engine.clearStemScene();
      radar.setAISources(null);
    }
  }

  if (btnPipelineQuick) btnPipelineQuick.addEventListener('click', () => setPipeline('quick'));
  if (btnPipelineAI) btnPipelineAI.addEventListener('click', () => setPipeline('ai'));

  if (btnStartSeparation) {
    btnStartSeparation.addEventListener('click', async () => {
      if (!currentFile) {
        alert('Please load an audio file first.');
        return;
      }

      if (!aiClient.backendAvailable) {
        const rechecked = await aiClient.checkBackend();
        if (!rechecked) {
          alert(
            'Local AI Backend is not running.\n\n' +
            'To start the AI backend, run this command in your terminal:\n' +
            'cd backend && python -m uvicorn app:app --host 127.0.0.1 --port 8000 --reload\n\n' +
            'UDIO will continue playing in Quick 3D mode in the meantime!'
          );
          return;
        }
      }

      try {
        btnStartSeparation.disabled = true;
        if (btnSeparateText) btnSeparateText.textContent = 'Separating...';
        if (aiProgressWrap) aiProgressWrap.style.display = 'flex';
        if (aiProgressFill) aiProgressFill.style.width = '5%';
        if (aiProgressPct) aiProgressPct.textContent = '5%';
        if (aiProgressStage) aiProgressStage.textContent = 'Uploading audio to local AI pipeline...';

        const spatialScene = await aiClient.separateFile(currentFile, (progress) => {
          const pct = Math.round(progress.percent || 0);
          if (aiProgressFill) aiProgressFill.style.width = `${pct}%`;
          if (aiProgressPct) aiProgressPct.textContent = `${pct}%`;
          if (aiProgressStage) aiProgressStage.textContent = progress.message || progress.status;
        });

        // Separation complete!
        currentSpatialScene = spatialScene;
        if (aiProgressFill) aiProgressFill.style.width = '100%';
        if (aiProgressPct) aiProgressPct.textContent = '100%';
        if (aiProgressStage) aiProgressStage.textContent = 'Initializing 3D spatial stems...';

        // Load into AudioEngine's StemRenderer
        await engine.loadStemScene(spatialScene);

        // Pass stem positions to radar
        radar.setAISources(spatialScene.sources);

        // Show stem controllers
        if (aiProgressWrap) aiProgressWrap.style.display = 'none';
        if (aiStemsContainer) aiStemsContainer.style.display = 'grid';
        if (btnSeparateText) btnSeparateText.textContent = 'Stems Active (3D)';
        btnStartSeparation.disabled = false;

        // Update stem positions display in the UI
        spatialScene.sources.forEach(src => {
          const posEl = $(`#pos${src.id.charAt(0).toUpperCase() + src.id.slice(1)}`);
          if (posEl) {
            posEl.textContent = `${src.azimuth > 0 ? '+' : ''}${src.azimuth}°, ${src.elevation > 0 ? '+' : ''}${src.elevation}°`;
          }
        });

        // Update duration and stop icon
        timeDisplay.textContent = `0:00 / ${formatTime(engine.getDuration())}`;
        setPlayState(false);

      } catch (err) {
        console.error('AI separation failed:', err);
        if (aiProgressStage) aiProgressStage.textContent = `Failed: ${err.message}`;
        btnStartSeparation.disabled = false;
        if (btnSeparateText) btnSeparateText.textContent = 'Retry Separation';
        alert(`AI Separation: ${err.message}`);
      }
    });
  }

  // Stem Volume Sliders
  ['vocals', 'drums', 'bass', 'other'].forEach(stemId => {
    const idCap = stemId.charAt(0).toUpperCase() + stemId.slice(1);
    const slider = $(`#gain${idCap}`);
    const valSpan = $(`#valGain${idCap}`);

    if (slider) {
      slider.addEventListener('input', () => {
        const val = parseFloat(slider.value);
        if (valSpan) valSpan.textContent = `${val}%`;
        if (engine.stemRenderer) {
          engine.stemRenderer.updateSource(stemId, { directGain: val / 100 });
        }
      });
    }
  });

  // Listen for knob changes
  document.addEventListener('knob-change', (e) => {
    const { param, value } = e.detail;
    switch (param) {
      case 'stereoWidth':
        engine.setSpatialWidth(value);
        $('#valStereoWidth').textContent = `${Math.round(value)}%`;
        radar.setParams({ width: value / 100 });
        break;
      case 'spatialDepth':
        engine.setSpatialDepth(value);
        $('#valSpatialDepth').textContent = `${Math.round(value)}%`;
        radar.setParams({ depth: value / 100 });
        break;
      case 'centerFocus':
        engine.setCenterFocus(value);
        $('#valCenterFocus').textContent = `${Math.round(value)}%`;
        radar.setParams({ focus: value / 100 });
        break;
      case 'elevation':
        engine.setSpatialElevation(value);
        $('#valElevation').textContent = `${Math.round(value)}%`;
        radar.setParams({ elevation: value / 100 });
        break;
      case 'roomReverb':
        engine.setRoomReverb(value);
        $('#valRoomReverb').textContent = `${Math.round(value)}%`;
        break;
      case 'bassEnhance':
        engine.setBassEnhance(value);
        $('#valBassEnhance').textContent = `${Math.round(value)}%`;
        break;
      case 'dynamics':
        engine.setDynamics(value);
        break;
    }
  });

  // ============================================================
  // EQ Sliders
  // ============================================================
  $$('.eq-band').forEach(bandEl => {
    const bandIndex = parseInt(bandEl.dataset.band);
    const slider = bandEl.querySelector('.eq-slider');
    const valDisplay = bandEl.querySelector('.eq-val');

    slider.addEventListener('input', () => {
      const gain = parseFloat(slider.value);
      engine.setEQBand(bandIndex, gain);
      valDisplay.textContent = `${gain > 0 ? '+' : ''}${gain} dB`;
    });
  });

  // EQ toggle
  let eqEnabled = true;
  eqToggle.addEventListener('click', () => {
    eqEnabled = !eqEnabled;
    engine.setEQEnabled(eqEnabled);
    const indicator = eqToggle.querySelector('.eq-toggle-indicator');
    if (eqEnabled) {
      indicator.classList.add('active');
      eqToggle.innerHTML = '<span class="eq-toggle-indicator active"></span> ON';
    } else {
      indicator.classList.remove('active');
      eqToggle.innerHTML = '<span class="eq-toggle-indicator"></span> OFF';
    }
  });

  // ============================================================
  // File Loading & System Capture
  // ============================================================
  function handleFileLoad(file) {
    if (!file) return;
    loadAudio(file);
  }

  btnLoadFile.addEventListener('click', () => fileInput.click());
  btnNext.addEventListener('click', () => fileInput.click());

  btnCaptureAudio.addEventListener('click', async () => {
    try {
      const success = await engine.captureSystemAudio();
      if (success) {
        welcomeState.style.display = 'none';
        playerSection.style.display = 'flex';
        btnHome.style.display = 'flex';
        
        trackName.textContent = 'Live System Audio';
        timeDisplay.textContent = 'LIVE STREAM';
        
        $('#waveform').style.display = 'none';
        $('.waveform-panel').style.display = 'none';

        setPlayState(true);
        spectrum.resize();
        radar.resize();
        
        // Apply Live Stream preset automatically to preserve mix and prevent 3D artifacts
        presetSelect.value = 'live-stream';
        applyPresetUI('live-stream');
      }
    } catch (err) {
      alert(err.message);
    }
  });

  btnHome.addEventListener('click', () => {
    engine.stop();
    if (engine.isStreaming) {
      engine.stopStream();
    }
    engine.clearStemScene();
    currentSpatialScene = null;
    if (radar) radar.setAISources(null);
    if (aiStemPanel) aiStemPanel.style.display = 'none';

    if (wavesurfer) {
      wavesurfer.destroy();
      wavesurfer = null;
    }
    
    welcomeState.style.display = 'flex';
    playerSection.style.display = 'none';
    btnHome.style.display = 'none';
    
    $('#waveform').style.display = 'block';
    $('.waveform-panel').style.display = 'block';
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) handleFileLoad(e.target.files[0]);
    fileInput.value = '';
  });

  // Drag & drop
  let dragCounter = 0;
  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    dropZone.classList.add('active');
  });

  document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      dropZone.classList.remove('active');
    }
  });

  document.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropZone.classList.remove('active');
    const file = e.dataTransfer.files[0];
    if (file) handleFileLoad(file);
  });

  // ============================================================
  // Load & Play Audio
  // ============================================================
  async function loadAudio(file) {
    try {
      currentFile = file;
      currentSpatialScene = null;
      if (radar) radar.setAISources(null);
      if (aiStemsContainer) aiStemsContainer.style.display = 'none';
      if (aiProgressWrap) aiProgressWrap.style.display = 'none';
      if (btnStartSeparation) {
        btnStartSeparation.disabled = false;
        if (btnSeparateText) btnSeparateText.textContent = 'Separate Stems (AI)';
      }
      if (aiStemPanel) {
        aiStemPanel.style.display = (activePipeline === 'ai') ? 'flex' : 'none';
      }

      const info = await engine.loadFile(file);

      welcomeState.style.display = 'none';
      playerSection.style.display = 'flex';
      btnHome.style.display = 'flex';

      const cleanName = file.name.replace(/\.[^/.]+$/, '');
      trackName.textContent = cleanName;

      timeDisplay.textContent = `0:00 / ${formatTime(info.duration)}`;

      if (wavesurfer) {
        wavesurfer.destroy();
      }

      wavesurfer = WaveSurfer.create({
        container: '#waveform',
        waveColor: 'rgba(108, 92, 231, 0.35)',
        progressColor: 'rgba(0, 229, 255, 0.7)',
        cursorColor: '#00E5FF',
        cursorWidth: 2,
        barWidth: 2,
        barGap: 1,
        barRadius: 2,
        height: 64,
        responsive: true,
        normalize: true,
        interact: true,
        hideScrollbar: true,
        backend: 'MediaElement',
        muted: true
      });

      // Revoke any previous object URL to prevent memory leaks
      if (engine._objectURL) {
        URL.revokeObjectURL(engine._objectURL);
        engine._objectURL = null;
      }
      const fileUrl = URL.createObjectURL(file);
      engine._objectURL = fileUrl; // tracked for future revocation
      wavesurfer.load(fileUrl);

      // User interaction seeking (click / drag on waveform only)
      wavesurfer.on('interaction', (newTime) => {
        const duration = engine.getDuration();
        if (duration > 0) {
          engine.seek(newTime / duration);
        }
      });

      setPlayState(false);
      spectrum.resize();
      radar.resize();

    } catch (err) {
      console.error('Error loading audio:', err);
    }
  }

  // ============================================================
  // Transport Controls
  // ============================================================
  function setPlayState(playing) {
    if (playing) {
      playIcon.style.display = 'none';
      pauseIcon.style.display = 'block';
    } else {
      playIcon.style.display = 'block';
      pauseIcon.style.display = 'none';
    }
  }

  btnPlay.addEventListener('click', async () => {
    await engine.resume();
    if (engine.isStreaming) {
      const isNowPlaying = engine.toggleStreamPause();
      setPlayState(isNowPlaying);
      return;
    }

    if (engine.isPlaying) {
      engine.pause();
      setPlayState(false);
    } else {
      engine.play();
      setPlayState(true);
    }
  });

  btnPrev.addEventListener('click', () => {
    if (engine.isStreaming) return;
    engine.seek(0);
    if (wavesurfer) {
      try { wavesurfer.setTime(0); } catch (_) {}
    }
    timeDisplay.textContent = `0:00 / ${formatTime(engine.getDuration())}`;
  });

  engine.onEnded = () => {
    setPlayState(false);
    if (wavesurfer) {
      try { wavesurfer.setTime(0); } catch (_) {}
    }
  };

  // Volume
  volumeSlider.addEventListener('input', () => {
    const vol = volumeSlider.value / 100;
    engine.setVolume(vol);
  });

  let isMuted = false;
  let prevVolume = 85;
  btnMute.addEventListener('click', () => {
    isMuted = !isMuted;
    if (isMuted) {
      prevVolume = volumeSlider.value;
      volumeSlider.value = 0;
      engine.setVolume(0);
      btnMute.style.opacity = '0.4';
    } else {
      volumeSlider.value = prevVolume;
      engine.setVolume(prevVolume / 100);
      btnMute.style.opacity = '1';
    }
  });

  // ============================================================
  // ============================================================
  // Presets Application
  // ============================================================
  function applyPresetUI(presetKey) {
    const preset = presets[presetKey];
    if (!preset) return;

    engine.applyPreset(preset);

    // Update Mode button
    if (preset.mode) {
      setSpatialMode(preset.mode);
    }

    // Update knob visual controllers
    if (knobs.stereoWidth && preset.stereoWidth !== undefined) knobs.stereoWidth.setValue(preset.stereoWidth);
    if (knobs.spatialDepth && preset.spatialDepth !== undefined) knobs.spatialDepth.setValue(preset.spatialDepth);
    if (knobs.centerFocus && preset.centerFocus !== undefined) knobs.centerFocus.setValue(preset.centerFocus);
    if (knobs.elevation && preset.elevation !== undefined) knobs.elevation.setValue(preset.elevation);
    if (knobs.roomReverb && preset.roomReverb !== undefined) knobs.roomReverb.setValue(preset.roomReverb);
    if (knobs.bassEnhance && preset.bassEnhance !== undefined) knobs.bassEnhance.setValue(preset.bassEnhance);

    // Update label displays
    if ($('#valStereoWidth') && preset.stereoWidth !== undefined) $('#valStereoWidth').textContent = `${preset.stereoWidth}%`;
    if ($('#valSpatialDepth') && preset.spatialDepth !== undefined) $('#valSpatialDepth').textContent = `${preset.spatialDepth}%`;
    if ($('#valCenterFocus') && preset.centerFocus !== undefined) $('#valCenterFocus').textContent = `${preset.centerFocus}%`;
    if ($('#valElevation') && preset.elevation !== undefined) $('#valElevation').textContent = `${preset.elevation}%`;
    if ($('#valRoomReverb') && preset.roomReverb !== undefined) $('#valRoomReverb').textContent = `${preset.roomReverb}%`;
    if ($('#valBassEnhance') && preset.bassEnhance !== undefined) $('#valBassEnhance').textContent = `${preset.bassEnhance}%`;

    // Update Radar params
    radar.setParams({
      width: (preset.stereoWidth || 100) / 100,
      depth: (preset.spatialDepth || 0) / 100,
      focus: (preset.centerFocus || 80) / 100,
      elevation: (preset.elevation || 0) / 100,
      mode: preset.mode || 'headphones',
      isBypassed: engine.isSpatialBypassed()
    });

    // Update EQ sliders
    if (preset.eq) {
      $$('.eq-band').forEach((bandEl, i) => {
        const slider = bandEl.querySelector('.eq-slider');
        const valDisplay = bandEl.querySelector('.eq-val');
        const gain = preset.eq[i] || 0;
        slider.value = gain;
        valDisplay.textContent = `${gain > 0 ? '+' : ''}${gain} dB`;
      });
    }
  }

  presetSelect.addEventListener('change', () => {
    applyPresetUI(presetSelect.value);
  });

  // Apply default Wide Binaural preset on app startup
  applyPresetUI('wide-binaural');
  presetSelect.value = 'wide-binaural';

  // Modal
  btnInfo.addEventListener('click', () => {
    infoModal.style.display = 'flex';
  });

  modalClose.addEventListener('click', () => {
    infoModal.style.display = 'none';
  });

  infoModal.addEventListener('click', (e) => {
    if (e.target === infoModal) infoModal.style.display = 'none';
  });

  // ============================================================
  // Animation Loop (Radar + Spectrum + VU Meters + Time)
  // ============================================================
  function animationLoop() {
    animFrameId = requestAnimationFrame(animationLoop);

    // Peak levels for VU and Radar pulse
    const levels = engine.getPeakLevels();
    vuLeft.style.width = `${Math.min(100, levels.left * 100 * 1.5)}%`;
    vuRight.style.width = `${Math.min(100, levels.right * 100 * 1.5)}%`;

    // 3D Soundstage Radar
    radar.draw(levels);

    // Spectrum Analyzer
    const freqData = engine.getFrequencyData();
    spectrum.draw(freqData);

    // Live Telemetry Status
    const telemetryText = document.querySelector('#engineTelemetry .telemetry-text');
    if (telemetryText) {
      const sr = engine.ctx ? Math.round(engine.ctx.sampleRate / 1000) + 'kHz' : '48kHz';
      if (engine.isSpatialBypassed()) {
        telemetryText.textContent = `2D STEREO BYPASS · ${sr}`;
      } else if (engine.isStreaming) {
        telemetryText.textContent = engine.streamPaused
          ? `STREAM PAUSED · ${sr}`
          : `BROWSER HRTF ACTIVE · ${sr}`;
      } else if (engine.isPlaying) {
        telemetryText.textContent = `BROWSER HRTF ACTIVE · ${sr}`;
      } else {
        telemetryText.textContent = `BROWSER HRTF READY · ${sr}`;
      }
    }

    // Time display & wavesurfer visual cursor sync
    if (engine.isPlaying && !engine.isStreaming) {
      const current = Math.max(0, engine.getCurrentTime());
      const total = Math.max(0, engine.getDuration());
      timeDisplay.textContent = `${formatTime(current)} / ${formatTime(total)}`;

      if (wavesurfer && total > 0) {
        try {
          wavesurfer.setTime(current);
        } catch (_) {}
      }
    }
  }

  animationLoop();

  // Keyboard Shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    switch (e.code) {
      case 'Space':
        e.preventDefault();
        btnPlay.click();
        break;
      case 'KeyB':
        e.preventDefault();
        if (btnSpatialToggle) btnSpatialToggle.click();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (engine.audioBuffer && !engine.isStreaming) {
          const t = Math.max(0, engine.getCurrentTime() - 5);
          engine.seek(t / engine.getDuration());
        }
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (engine.audioBuffer && !engine.isStreaming) {
          const t = Math.min(engine.getDuration(), engine.getCurrentTime() + 5);
          engine.seek(t / engine.getDuration());
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        volumeSlider.value = Math.min(100, parseInt(volumeSlider.value) + 5);
        engine.setVolume(volumeSlider.value / 100);
        break;
      case 'ArrowDown':
        e.preventDefault();
        volumeSlider.value = Math.max(0, parseInt(volumeSlider.value) - 5);
        engine.setVolume(volumeSlider.value / 100);
        break;
      case 'KeyM':
        btnMute.click();
        break;
    }
  });
}

document.addEventListener('DOMContentLoaded', initApp);
