# 36W-V Python BG model proof export / coefficient parity

## Scope and guardrails
- Python remains the source of truth.
- Change type: diagnostic-proof export only.
- No change to runtime scientific behavior: BG masks, ROI, fit choices, thresholds, model evaluation, MeanBG/PAbs/score/ranking remain unchanged.

## Python BG pipeline functions inspected
- `build_bg_masks_physical` in `reference_python/analyzer.py`.
- `_extract_bg_masks_statistical` in `reference_python/analyzer.py`.
- `_extract_bg_samples` in `reference_python/analyzer.py`.
- `_poly2_design` in `reference_python/analyzer.py`.
- `_fit_poly2_robust` in `reference_python/analyzer.py`.
- `_eval_poly2_model` in `reference_python/analyzer.py`.
- `_predict_bg_for_wells` in `reference_python/analyzer.py`.
- `_safe_gamma_linearize_scalar` and `_meanbg_from_bg` nested in `_build_raw_report_rows` in `reference_python/analyzer.py`.

## Diagnostic-only Python exports added (DIAGNOSTICS workbook)
The Python run now exports proof-only sheets:
- `13_BG_MODEL_INPUTS`
  - `BG_Cell_Row`, `BG_Cell_Col`, `Associated_Wells`, `x`, `y`, `area`,
  - `Red_median_raw`, `Green_median_raw`, `Blue_median_raw`.
- `14_BG_MODEL_COEFFICIENTS`
  - `Channel`, `Basis_Order`, `x0`, `y0`, `sx`, `sy`, `coef_0..coef_5`,
  - robust-trace fields: `samples_total`, `samples_retained`, `samples_rejected`,
  - `retained_ids`, `rejected_ids`, `residual_median`, `residual_mad`, `residual_sigma`, `residual_max_abs`.
- `15_BG_MODEL_PREDICTIONS`
  - `Row`, `Col`, `Well`, `x`, `y`,
  - `BG_Red_raw_model`, `BG_Green_raw_model`, `BG_Blue_raw_model`.

Implementation notes:
- `_fit_poly2_robust` now supports optional trace output (`return_trace=True`) and optional `sample_ids`; default behavior is unchanged.
- The same fitted model dictionaries are still used for downstream BG prediction.
- New CSVs are included in DIAGNOSTICS workbook then removed like existing diagnostic CSVs.

## Comparator updates for coefficient-parity proof
`tools/compare_python_web_outputs.py` now:
- prefers Python proof sheets `13/14/15` when present,
- falls back to Python `02_BG_SAMPLES` and `03_BG_WELL_FIT` if needed,
- compares:
  - Python vs web fit inputs (`13`),
  - Python vs web normalization (`x0/y0/sx/sy`) and term-aligned coefficients (`constant`, `x`, `y`, `x^2`, `x*y`, `y^2`) (`14`),
  - Python vs web robust trace summaries/ID strings (`14`),
  - Python vs web raw model predictions (`15`),
- emits explicit `first proven divergence classification` in ordered stages:
  1) fit inputs,
  2) normalization,
  3) coefficients,
  4) robust retention/rejection,
  5) model prediction,
  6) otherwise downstream MeanBG/PAbs sections.

## Provability status after 36W-V
- Coefficient parity is now provable when both ZIPs include Python and web `14_BG_MODEL_COEFFICIENTS`.
- Robust retained/rejected summary parity is now provable at exported summary level.
- Per-well raw model prediction parity is provable with `15_BG_MODEL_PREDICTIONS`.

## Remaining limits
- Per-iteration robust keep/reject masks are still not exported as step-by-step iteration snapshots.
- Current proof captures final robust state and summary residual metrics, which is sufficient for coefficient-parity classification but not for full iteration-by-iteration replay.
