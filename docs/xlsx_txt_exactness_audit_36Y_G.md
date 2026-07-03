# XLSX/TXT exactness audit 36Y-G

Date: 2026-07-03

Path selected: Path A - audit-only.

Python source of truth: `../tipica-microplate-colorimetry/src/tipica/tipica_core/analyzer.py`

This report does not establish full XLSX/TXT parity and does not change the `v0.1.0-beta` local tag.

## Executive summary

36Y-G did not make runtime, scientific, XLSX writer, or TXT writer changes. A current webapp ZIP could not be generated non-interactively from local context, so this pass remains audit-only. I reran the direct XLSX/TXT auditor on the committed historical pair used by previous work:

- Python: `test_data/manual_comparison/python_RUN_20260529_122854.zip`
- Web: `test_data/manual_comparison/web_after_36X_D3_method_comparison.zip`
- Output: `test_data/manual_comparison/direct_xlsx_txt_audit_36Y_G_existing_pair.md`

That historical direct audit still reports:

- `XLSX_FULL_PARITY = false`
- `TXT_FULL_PARITY = false`
- `SAFE_TO_CLAIM_XLSX_TXT_MATCH = false`

Because the audited web ZIP is not freshly generated from current `HEAD`, the result is evidence for known gap classes, not a current parity verdict. Full XLSX/TXT parity and full artifact parity remain unsafe to claim.

Safe-to-claim flags:

| Flag | Status |
|---|---|
| `SAFE_TO_CLAIM_FULL_XLSX_TXT_PARITY` | no |
| `SAFE_TO_CLAIM_FULL_ARTIFACT_PARITY` | no |

## Files inspected

| Area | Files |
|---|---|
| Gap map | `docs/artifact_parity_gap_map_36Y_F.md` |
| Direct audit tooling | `tools/audit_xlsx_txt_parity.py`; `tools/compare_python_web_outputs.py` |
| Prior audit reports | `test_data/manual_comparison/python_zenodo_to_web_dogmatic_parity_audit_36Y_C0.md`; `test_data/manual_comparison/direct_xlsx_txt_audit_after_36Y_A_true_python_RUN_vs_D3.md`; `test_data/manual_comparison/comparison_after_36W_V_pythonproof_vs_36W_U_web.md`; `notes/36X-A-artifact-parity-audit.md` |
| Python source | `../tipica-microplate-colorimetry/src/tipica/tipica_core/analyzer.py` |
| Web source | `src/App.tsx` |

## Files changed

| File | Purpose |
|---|---|
| `docs/xlsx_txt_exactness_audit_36Y_G.md` | This audit checkpoint. |
| `test_data/manual_comparison/direct_xlsx_txt_audit_36Y_G_existing_pair.md` | Re-run direct XLSX/TXT audit on the existing committed Python/web ZIP pair. |

No runtime/scientific code changed. No XLSX/TXT writer code changed.

## Python workbook/TXT source-of-truth mapping

### REPORT.xlsx

Python writes `<base>_REPORT.xlsx` through `_write_report_workbook`.

| Order | Sheet | Python semantics |
|---:|---|---|
| 01 | `01_CONTENTS` | Index of report workbook sheets. |
| 02 | `02_METADATA` | Image-level metadata and rule-based image QC. |
| 03 | `03_OVERVIEW` | Final quantitative summary, selected method, reliability score/class, empty-well QC, epsilon/path-length fields when present, and external reference checks. |
| 04 | `04_RAW` | Well-level analytical values: RGB pseudo-absorbance plus conditional CIELAB/DeltaE fields. |
| 05 | `05_REPLICATES_MEAN` | Replicate medians, SDs, replicate counts, and QC flags. |
| 06 | `06_FITTING` | Calibration, standard-addition, unknown/CRM fit rows. Headers are conditional on mode flags. |
| 07 | `07_METHOD_COMPARISON` | Present only when method-comparison rows exist; includes selected/rank and non-empty informative method-comparison fields. |
| 08 | `08_LEGENDS` | Present when method comparison exists; otherwise Python writes `07_LEGENDS`. |

Important Python details:

- `04_RAW` includes CIELAB headers only when CIELAB values are finite and DeltaE headers only when DeltaE values are finite.
- `06_FITTING` conditionally adds calibration and standard-addition/unknown columns from mode flags.
- `07_METHOD_COMPARISON` drops empty/non-informative columns and drops redundant `ScoreUsesSNR`, `FinalScore`, and `Component`.
- `08_LEGENDS` uses `_build_legends_rows` and Python's formula/provenance wording.

### DIAGNOSTICS.xlsx

Python writes `<base>_DIAGNOSTICS.xlsx` through `_write_diagnostics_workbook`.

| Order | Sheet | Python semantics |
|---:|---|---|
| 01 | `01_CONTENTS` | Index of diagnostic sheets actually present. |
| 02 | `02_BG_SAMPLES` | Accepted inter-well background samples used to fit the background surface. |
| 03 | `03_BG_WELL_FIT` | Predicted local background at each well. |
| 04 | `04_WELL_ROBUST_STATS` | Well-level robust pixel statistics and optical QC. |
| 05 | `05_GEOMETRY_QC` | Floor/mouth geometry QC descriptors. |
| 06 | `06_WELL_BOTTOM` | Detailed well-bottom and mouth geometry measurements. |
| 07 | `07_PLATE_GEOMETRY` | Nominal plate geometry parameters. |
| 08 | `08_EMPTY_WELLS` | Empty-well diagnostic values when informative. |
| 09 | `09_SPATIAL_DIAGNOSTICS` | Spatial trends across row/column positions. |
| 10 | `10_METHOD_COMPARISON` | Cross-method diagnostic comparison using common score factors. |
| 11 | `11_CIELAB_FITTING` | CIELAB/DeltaE diagnostic fit rows. |
| 12 | `12_LEGENDS` | Diagnostic workbook and figure definitions. |

Important Python details:

- Sheets 02-09 are conditional on informative CSV-backed rows.
- Sheets 10 and 11 are conditional on available method-comparison and CIELAB fit rows.
- Python does not write web-only sheets 13-15.
- `12_LEGENDS` uses `_diagnostics_legend_rows` and states `BG_STAT_MASK` as a binary mask.

### TXT captions

Python writes two fixed caption files:

| File | Python paragraph structure |
|---|---|
| `<base>_RESULTS_CAPTION.txt` | Title; File scope; Analytical signal; Fitting and quantification; Ranking score; Reference values and recovery; Quality control; Geometry and epsilon/path-length quantification; Units. |
| `<base>_RAW_DATA_DETAILS_CAPTION.txt` | Title; File scope; `BG_STAT_MASK.png`; `FIGURE_CIELAB_DELTAE.png`; `METHOD_COMPARISON.png`; `DIAGNOSTICS.xlsx`; Geometry and epsilon/path-length quantification; Units. |

Python captions describe Python behavior, including robust IRLS across Python fits, binary `BG_STAT_MASK.png`, OpenCV BGR-to-Lab CIELAB semantics, and epsilon/path-length quantification.

## Web workbook/TXT current mapping

### REPORT.xlsx

The web builder `createPythonReportWorkbookBlob` currently emits `01_CONTENTS` through `08_LEGENDS` unconditionally for the Python-style report package. It does not currently mirror Python's conditional `07_LEGENDS` fallback for no method-comparison rows.

Known current web differences from source inspection:

- `02_METADATA` describes browser export metadata and current web settings, not Python image QC metadata exactly.
- `03_OVERVIEW` has blank/caveated reliability fields where Python computes values.
- `04_RAW`, `05_REPLICATES_MEAN`, and `06_FITTING` include web audit/proof columns for correction and fit-input tracing.
- `08_LEGENDS` uses scoped web caveats and browser provenance rather than Python verbatim legend rows.

### DIAGNOSTICS.xlsx

The web builder `createPythonDiagnosticsWorkbookBlob` emits the Python-style diagnostic sheets plus proof-only web diagnostics:

| Sheet | Status |
|---|---|
| `01_CONTENTS` through `12_LEGENDS` | Python-style sheet names, but browser-derived rows and caveats. |
| `13_BG_MODEL_INPUTS` | Web-only proof sheet. |
| `14_BG_MODEL_COEFFICIENTS` | Web-only proof sheet. |
| `15_BG_MODEL_PREDICTIONS` | Web-only proof sheet. |

Source inspection found a schema consistency issue to resolve in a future controlled pass: `buildDiagnosticsContentsRows` lists `13_BG_MODEL_INPUTS`, `14_BG_MODEL_COEFFICIENTS`, and `15_BG_MODEL_PREDICTIONS` before `12_LEGENDS`, while `createPythonDiagnosticsWorkbookBlob` creates the actual workbook sheets as `12_LEGENDS` followed by sheets 13-15. This is a structural/textual issue, not a numeric algorithm issue.

### TXT captions

The web captions intentionally differ from Python:

- `createPythonResultsCaptionText` keeps scoped robust-IRLS and fitting-parity caveats, adds dynamic reference lines, and says web epsilon/path-length quantification is not implemented.
- `createPythonRawDataDetailsCaptionText` describes `BG_STAT_MASK.png` as an overlay diagnostic and preserves CIELAB descriptor-input caveats.

These caveats are scientifically necessary while web behavior differs from Python.

## Fresh audit status

| Item | Status |
|---|---|
| Fresh current Python output generated in this turn | no |
| Fresh current webapp output generated in this turn | no |
| Fresh direct audit against current generated pair | no |
| Historical direct audit re-run in this turn | yes |

Reason fresh current generation was not completed:

- The repository contains committed ZIP pairs and extracted outputs, but no current-webapp ZIP generated from `HEAD=d5193bb`.
- The browser export path is interactive and no non-interactive current-output generation script was identified in this pass.
- Generating a current pair without a known scripted path would risk inventing or mixing artifact provenance.

Historical direct audit command:

```bash
python3 tools/audit_xlsx_txt_parity.py \
  --python test_data/manual_comparison/python_RUN_20260529_122854.zip \
  --web test_data/manual_comparison/web_after_36X_D3_method_comparison.zip \
  --report test_data/manual_comparison/direct_xlsx_txt_audit_36Y_G_existing_pair.md \
  --numeric-tolerance 0 \
  --max-diffs-per-sheet 20 \
  --reference-label python_RUN_20260529_122854
```

Historical direct audit result:

| Metric | Result |
|---|---|
| XLSX workbooks audited | 2 |
| TXT files audited | 2 |
| File-list parity | 10 common files, no files only in Python or only in web |
| XLSX full parity | false |
| TXT full parity | false |
| Safe to claim XLSX/TXT match | false |
| Total XLSX cell differences | 15438 |

## REPORT.xlsx gap table

| Gap | Classification | Evidence | Next action |
|---|---|---|---|
| REPORT workbook cells are not Python-identical. | P0 artifact blocker | Historical audit reports `RESULTS/Piastra 70_REPORT.xlsx` has matching sheet names/order but `Cell values=False` and `Full match=False`. | Generate a current pair and rerun direct cell audit before patching writer code. |
| `04_RAW`, `05_REPLICATES_MEAN`, and `06_FITTING` include web audit/proof columns not present in Python. | P0 for exact parity; intentional diagnostics if separated | Historical audit shows blank-vs-nonblank header differences such as `PAbs_*_raw`, fit-input columns, and clip trace columns. Current source still includes correction and fit-input audit columns. | Decide whether these columns are supplemental-only or whether Python-equivalent REPORT must suppress them. |
| `07_METHOD_COMPARISON` numeric/text cells differ. | P0 | Historical audit shows channel naming and numeric differences for CIELAB/DeltaE and concentration/reference fields. | Do not patch numerics in 36Y-G; first produce a current direct audit and isolate schema-only from data-source differences. |
| `08_LEGENDS` differs strongly from Python source. | P1/P0 depending on exactness claim | Historical audit shows legend row order/text differences. Current web source uses scoped beta caveats and browser provenance. | Align only where truthful; retain caveats where web behavior differs. |
| Conditional sheet logic differs for no-method-comparison cases. | P1 structural | Python can emit `07_LEGENDS`; web currently emits `07_METHOD_COMPARISON` and `08_LEGENDS` unconditionally. | Add a targeted scripted fixture before changing this path. |

## DIAGNOSTICS.xlsx gap table

| Gap | Classification | Evidence | Next action |
|---|---|---|---|
| Diagnostics workbook sheet count/order differs when web-only sheets 13-15 are included. | P0 artifact blocker for exact parity | Historical audit: Python sheets 01-12; web sheets 01-15. Current source still emits `13_BG_MODEL_INPUTS`, `14_BG_MODEL_COEFFICIENTS`, `15_BG_MODEL_PREDICTIONS`. | Future Path B candidate: move sheets 13-15 to a supplemental web-only workbook while preserving their content. |
| `01_CONTENTS` order does not match actual web workbook order. | P1 structural | Current source lists sheets 13-15 before `12_LEGENDS` in contents, while workbook creation emits `12_LEGENDS` before 13-15. | Safe future schema fix after current-output fixture exists. |
| `02_BG_SAMPLES` has extra web columns and numeric differences. | P0 | Historical audit reports Python shape `(78, 9)`, web shape `(78, 18)`, plus numeric and blank-pattern differences. | Separate web proof columns or suppress in Python-equivalent workbook; do not change background calculations here. |
| `03_BG_WELL_FIT`, `04_WELL_ROBUST_STATS`, `05_GEOMETRY_QC`, `06_WELL_BOTTOM`, `07_PLATE_GEOMETRY`, and `08_EMPTY_WELLS` have cell differences. | P0 | Historical direct audit reports numeric/text/blank-pattern/type differences across these sheets. | Treat as broader runtime/input parity evidence; not safe for schema-only patching. |
| `10_METHOD_COMPARISON` and `11_CIELAB_FITTING` differ. | P0 | Historical audit shows text/numeric differences and shape differences for CIELAB fitting rows. | Requires current direct audit after post-IRLS changes before deciding if any remaining gap is structural-only. |
| `12_LEGENDS` differs from Python diagnostic legends. | P1/P0 depending on claim | Python diagnostic legend says binary `BG_STAT_MASK`; web legend says overlay diagnostic and includes web-only proof-sheet terms. | Keep truthful web caveats until outputs are separated or made Python-identical. |

## TXT caption gap table

| Gap | Classification | Evidence | Next action |
|---|---|---|---|
| `RESULTS_CAPTION.txt` is not exact Python text. | P0 for exact TXT parity; intentional beta truthfulness | Historical audit reports text difference. Current web caption has scoped IRLS/covariance claims, dynamic reference lines, and web epsilon/path-length caveat. | Do not copy Python text until web behavior supports it. |
| `RAW_DATA_DETAILS_CAPTION.txt` is not exact Python text. | P0 for exact TXT parity; intentional beta truthfulness | Historical audit reports text difference. Current web caption describes overlay `BG_STAT_MASK` and CIELAB descriptor-input caveats. | Keep caveats unless artifact behavior changes. |
| RAW caption omits Python's Geometry and epsilon/path-length paragraph. | P1 textual structure | Python RAW caption includes this paragraph; current web RAW caption jumps from `DIAGNOSTICS.xlsx` to `Units`. | Future text-only candidate: add a truthful web-specific geometry/epsilon caveat paragraph if it does not imply implemented epsilon/path-length quantification. |
| Dynamic reference lines make RESULTS caption intentionally non-verbatim. | P1/P0 for exactness | Web adds configured reference values under the reference paragraph; Python source does not. | Decide whether reference details belong in supplemental web text or workbook-only fields. |

## Exact changes made

No code changes were made.

No package scripts, dependencies, XLSX writer code, TXT writer code, fitting code, ROI/background code, CIELAB code, configurator code, stored-calibration code, unknown/epsilon code, PNG/canvas code, or release/tag metadata were changed.

The only changes are markdown/report files.

## What remains unsafe to claim

- Full XLSX/TXT parity.
- Full artifact parity.
- Python-equivalent diagnostics workbook parity while web sheets 13-15 remain inside `DIAGNOSTICS.xlsx`.
- Python-equivalent TXT caption parity while web captions require truthful caveats.
- Any numeric workbook parity from the historical audit pair.
- Any current-output parity without a fresh direct audit from current Python and current web artifacts.

## Reproducible TODO for current fresh generation

1. Add or identify a non-interactive fixture/export path that generates a current web ZIP from the same committed input set as the Python reference.
2. Generate a fresh Python reference output from the Python package source of truth.
3. Run `tools/audit_xlsx_txt_parity.py` with `--numeric-tolerance 0` against those current outputs.
4. Only after that audit, choose a Path B patch set limited to structural/textual/schema changes.

## Recommended next milestone

36Y-G2 should remain focused on XLSX/TXT exactness before PNG/figure parity:

- Generate current Python/web artifact pair non-interactively.
- Move or reclassify web-only diagnostics sheets 13-15 into a supplemental workbook.
- Align diagnostics contents order with actual sheet order.
- Add a truthful RAW caption geometry/epsilon caveat only if scoped correctly.
- Re-run direct XLSX/TXT audit and keep full parity flags at `no` until exact audit passes.
