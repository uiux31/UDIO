/**
 * AIClient.js — Frontend REST client for the UDIO AI Backend
 *
 * Responsibilities:
 *   - Check if the local Python backend is running (GET /api/health)
 *   - Upload an audio file and start a separation job (POST /api/separate)
 *   - Poll job status until render-ready or failed (GET /api/jobs/{id})
 *   - Retrieve the SpatialScene JSON (GET /api/scene/{id})
 *   - Report backend availability to the UI
 *   - Never expose an API key (all calls are localhost, no auth required)
 *
 * Graceful degradation:
 *   - If health check fails → backendAvailable = false → caller uses Quick 3D mode
 *   - If separation job fails → throws with descriptive error
 */

const BACKEND_BASE = 'http://127.0.0.1:8000';
const POLL_INTERVAL_MS = 1500;
const HEALTH_TIMEOUT_MS = 2500;

export class AIClient {
  constructor() {
    this.backendAvailable = false;
    this._healthStatus = null;
    this._activeJobId = null;
  }

  /**
   * Check if the local AI backend is reachable and has models loaded.
   * Non-throwing — sets this.backendAvailable to true/false.
   *
   * @returns {Promise<object>} health status object, or null if offline
   */
  async checkBackend() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

      const resp = await fetch(`${BACKEND_BASE}/api/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        this.backendAvailable = false;
        return null;
      }

      this._healthStatus = await resp.json();
      this.backendAvailable = true;
      return this._healthStatus;

    } catch {
      this.backendAvailable = false;
      return null;
    }
  }

  /**
   * Get the last health status (from the most recent checkBackend call).
   * @returns {object|null}
   */
  getHealthStatus() {
    return this._healthStatus;
  }

  /**
   * Upload an audio file and start a separation job.
   *
   * @param {File} file          — the audio File object from the browser
   * @param {function} onProgress — called with { status, percent, message } updates
   * @returns {Promise<object>}  — the completed SpatialScene JSON
   *
   * Throws if:
   *   - backend is unavailable
   *   - upload fails
   *   - job fails
   *   - job times out (> 20 minutes)
   */
  async separateFile(file, onProgress = () => {}) {
    if (!this.backendAvailable) {
      throw new Error('AI backend is not available. Using Quick 3D mode instead.');
    }

    // --- Upload ---
    onProgress({ status: 'uploading', percent: 5, message: 'Uploading audio...' });

    const formData = new FormData();
    formData.append('file', file);

    const uploadResp = await fetch(`${BACKEND_BASE}/api/separate`, {
      method: 'POST',
      body: formData,
    });

    if (!uploadResp.ok) {
      const err = await uploadResp.json().catch(() => ({ detail: uploadResp.statusText }));
      throw new Error(`Upload failed: ${err.detail || uploadResp.statusText}`);
    }

    const { jobId } = await uploadResp.json();
    this._activeJobId = jobId;

    onProgress({ status: 'queued', percent: 10, message: 'Job queued...' });

    // --- Poll until done ---
    const scene = await this._pollJob(jobId, onProgress);
    this._activeJobId = null;
    return scene;
  }

  /**
   * Poll a job until render-ready or failed.
   * @private
   */
  async _pollJob(jobId, onProgress) {
    const startTime = Date.now();
    const MAX_WAIT_MS = 20 * 60 * 1000; // 20 minutes

    const STATUS_PROGRESS = {
      queued:      { percent: 10, message: 'Queued for processing...' },
      processing:  { percent: 20, message: 'Preprocessing audio...' },
      separating:  { percent: 40, message: 'Separating stems (AI)...' },
      analyzing:   { percent: 80, message: 'Building spatial scene...' },
      'render-ready': { percent: 100, message: 'Done!' },
    };

    while (Date.now() - startTime < MAX_WAIT_MS) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

      let job;
      try {
        const resp = await fetch(`${BACKEND_BASE}/api/jobs/${jobId}`);
        if (!resp.ok) continue;
        job = await resp.json();
      } catch {
        continue; // transient network error, keep polling
      }

      const prog = STATUS_PROGRESS[job.status] || { percent: 50, message: job.status };
      onProgress({ status: job.status, ...prog });

      if (job.status === 'render-ready') {
        // Fetch the spatial scene
        const sceneResp = await fetch(`${BACKEND_BASE}/api/scene/${jobId}`);
        if (!sceneResp.ok) {
          throw new Error('Failed to retrieve spatial scene from backend');
        }
        return await sceneResp.json();
      }

      if (job.status === 'failed') {
        throw new Error(`AI separation failed: ${job.error || 'Unknown error'}`);
      }
    }

    throw new Error('AI separation timed out (> 20 min). Try a shorter file.');
  }

  /**
   * Get the stem audio URL for a given job + stem name.
   * Returns a full URL to the backend stem endpoint.
   *
   * @param {string} jobId
   * @param {string} stemName
   * @returns {string}
   */
  getStemUrl(jobId, stemName) {
    return `${BACKEND_BASE}/api/stems/${jobId}/${stemName}`;
  }

  /**
   * Cancel the active job if one is running.
   * (Backend doesn't yet have a cancel endpoint — this is a no-op for now,
   *  but provided for UI parity.)
   */
  cancelActiveJob() {
    this._activeJobId = null;
  }
}
