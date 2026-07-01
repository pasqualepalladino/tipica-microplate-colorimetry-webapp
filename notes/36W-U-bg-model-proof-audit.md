# 36W-U BG Model Proof Audit (Python-first)

## Scope
- Proof-only diagnostic milestone.
- No runtime scientific behavior change requested.
- Target chain: BG samples -> BG polynomial fit -> per-well BG prediction -> MeanBG assignment.

## Python Reference Functions Audited
- `build_bg_masks_physical` in `reference_python/analyzer.py` (around line 495)
- `_extract_bg_masks_statistical` in `reference_python/analyzer.py` (around line 592)
- `_extract_bg_samples` in `reference_python/analyzer.py` (around line 618)
- `_poly2_design` in `reference_python/analyzer.py` (around line 649)
- `_fit_poly2_robust` in `reference_python/analyzer.py` (around line 653)
- `_eval_poly2_model` in `reference_python/analyzer.py` (around line 707)
- `_predict_bg_for_wells` in `reference_python/analyzer.py` (around line 716)
- `_safe_gamma_linearize_scalar` in `reference_python/analyzer.py` (around line 1329)
- `_build_raw_report_rows` and nested `_meanbg_from_bg` in `reference_python/analyzer.py` (around lines 1757 and 1779)
- BG fit invocation with explicit `max_iter=6` in `run` path in `reference_python/analyzer.py` (around lines 9417-9420)

## Python Export Availability (workbook/ZIP)
What Python workbook exports provide now:
- `DIAGNOSTICS/02_BG_SAMPLES`:
  - BG cell id, associated wells, x/y, area, raw medians per RGB.
- `DIAGNOSTICS/03_BG_WELL_FIT`:
  - per-well x/y and BG_Red_raw/BG_Green_raw/BG_Blue_raw model outputs.
- `REPORT/04_RAW`:
  - MeanBG_* after gamma linearization (`_safe_gamma_linearize_scalar`) and downstream PAbs fields.

What Python workbook exports do NOT currently provide:
- BG polynomial coefficients (`coef`, `x0`, `y0`, `sx`, `sy`) for current run.
- Robust retained/rejected sample identities per channel and residual vectors.
- Per-iteration robust-fit keep/reject states.

Additional Python data that exists but is outside workbook proof path:
- Stored calibration bundle can include `bg_models` and `bg_samples` (`_save_stored_calibration_bundle`), but this is not part of standard report/diagnostics workbook exports for the current run.

## TypeScript Functions Audited
- `createPhysicalInterwellCandidates` in `src/core/backgroundModels.ts`
- `buildPhysicalCellSamples` in `src/core/backgroundModels.ts`
- `poly2Design` / `fitLeastSquares` / `fitPoly2Robust` / `evaluatePoly2` in `src/core/backgroundModels.ts`
- `estimatePhysicalInterwellPolynomialBackgrounds` in `src/core/backgroundModels.ts`
- `buildBackgroundVisualDiagnostics` in `src/core/backgroundModels.ts`
- `buildDiagnosticsBackgroundSampleRows` in `src/App.tsx`
- `buildDiagnosticsBackgroundWellFitRows` in `src/App.tsx`
- `buildReportRawRows` in `src/App.tsx`

## Proof Gaps Addressed in 36W-U
- Added web proof-only diagnostics for:
  - fit input rows used by BG polynomial model,
  - basis order + normalization + coefficients per channel,
  - retained/rejected counts and residual summaries per channel,
  - per-well raw model predictions before downstream transformations.

## Remaining Proof Limits (Python-side)
- Direct Python-vs-web coefficient equality cannot be proven from current workbook exports alone.
- Direct Python-vs-web retained/rejected sample parity per robust iteration cannot be proven from current workbook exports alone.

## Smallest future Python-side diagnostic export needed (if requested later)
- Export per-run BG fit proof sheet with:
  - `Channel`, `Basis_Order`, `x0`, `y0`, `sx`, `sy`, `coef_0..coef_5`,
  - sample id (`cell_r`, `cell_c`) retain/reject flag per channel,
  - final residual per retained sample,
  - optional per-iteration keep count.
