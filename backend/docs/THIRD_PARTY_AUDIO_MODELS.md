# UDIO — Third-Party Audio Models & HRTF License Tracking

> Per spec §44: Record source, license, attribution, and commercial-use status for every
> third-party model or dataset used in UDIO. Update this file whenever a new model is added.

---

## AI Source Separation Models

### HTDemucs v4

| Field | Value |
|---|---|
| Source | https://github.com/facebookresearch/demucs |
| License | MIT |
| License URL | https://github.com/facebookresearch/demucs/blob/main/LICENSE |
| Attribution required | Attribution to Meta AI / Alexandre Défossez et al. |
| Commercial use | Permitted under MIT (verify per checkpoint) |
| Checkpoint source | Downloaded automatically via `demucs` Python package |
| Checkpoint version | `htdemucs` (demucs ≥ 4.0.0) |
| Date verified | YYYY-MM-DD — FILL IN BEFORE PRODUCTION |

**Notes:** The demucs Python package code is MIT licensed. The model weights
are distributed by the demucs package. Verify the weights license specifically
before any commercial deployment.

---

### BS-RoFormer (optional primary separator)

| Field | Value |
|---|---|
| Source (code) | https://github.com/lucidrains/BS-RoFormer |
| Code license | MIT |
| Code license URL | https://github.com/lucidrains/BS-RoFormer/blob/main/LICENSE |
| Attribution required | Attribution to lucidrains + original paper authors |
| Checkpoint source | **NOT YET SET** — place at `backend/models/bs_roformer.ckpt` |
| Checkpoint version | UNSET |
| Checkpoint license | **VERIFY BEFORE USE** — checkpoint license varies by source |
| Commercial use | **UNVERIFIED** — verify checkpoint-specific license |
| Date verified | NOT YET VERIFIED |

**Notes:** The architecture code is MIT licensed. Pretrained checkpoints may
be available from Music-Source-Separation-Training (ZFTurbo) or other sources.
Each checkpoint has its own licensing terms that must be independently verified.

Reference: https://github.com/ZFTurbo/Music-Source-Separation-Training/blob/main/docs/pretrained_models.md

---

## HRTF Datasets

No custom HRTF dataset is currently used. The browser's native `PannerNode`
with `panningModel='HRTF'` is used (browser built-in, no external dataset).

When a custom HRTF dataset is added, add an entry here:

| Field | Value |
|---|---|
| Source | — |
| License | — |
| Attribution | — |
| Commercial use | — |
| Date verified | — |

---

## Whisper (optional, not yet integrated)

| Field | Value |
|---|---|
| Source | https://github.com/openai/whisper |
| License | MIT |
| Commercial use | Permitted under MIT |
| Status | Not yet integrated |

---

## Basic Pitch (optional, not yet integrated)

| Field | Value |
|---|---|
| Source | https://github.com/spotify/basic-pitch |
| License | Apache-2.0 |
| Commercial use | Permitted under Apache-2.0 |
| Status | Not yet integrated |

---

*Last updated: 2026-09-10 — Update this file whenever models or datasets change.*
