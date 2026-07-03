# Artifact parity gap map 36Y-F

Date: 2026-07-03

Python source of truth: `tipica-microplate-colorimetry/src/tipica/tipica_core/analyzer.py`

Web beta companion: `dqcolorimetry-webapp-beta/src/App.tsx`

This report does not change the v0.1.0-beta local tag and does not establish artifact parity.

## Executive summary

The beta webapp exports a Python-style analysis package with the same main artifact families as the Python package: RESULTS workbooks, TXT captions, RGB/ROI PNGs, and RAW_DATA_DETAILS diagnostics. That is file-inventory alignment, not artifact parity.

Current source inspection and earlier direct audits still leave full artifact parity unsafe to claim. The strongest blockers are workbook cell/schema differences, non-identical caption text, web-only diagnostics inside the diagnostics workbook, and PNG figure differences where canvas/browser outputs do not yet reproduce Python matplotlib/OpenCV semantics exactly. The post-IRLS integration work improves scoped fitting rows, but it does not close XLSX/TXT/PNG parity.

Safe-to-claim flags:

| Flag | Status |
|---|---|
| `SAFE_TO_CLAIM_FULL_XLSX_TXT_PARITY` | no |
| `SAFE_TO_CLAIM_FULL_PNG_FIGURE_PARITY` | no |
| `SAFE_TO_CLAIM_FULL_ARTIFACT_PARITY` | no |

## Files inspected

| Area | Files |
|---|---|
| Previous audit reports | `test_data/manual_comparison/python_zenodo_to_web_dogmatic_parity_audit_36Y_C0.md`; `test_data/manual_comparison/direct_xlsx_txt_audit_after_36Y_A_true_python_RUN_vs_D3.md`; `test_data/manual_comparison/comparison_after_36W_V_pythonproof_vs_36W_U_web.md`; `notes/36X-A-artifact-parity-audit.md` |
| Audit tooling | `tools/audit_xlsx_txt_parity.py`; `tools/compare_python_web_outputs.py` |
| Python artifact source | `../tipica-microplate-colorimetry/src/tipica/tipica_core/analyzer.py` |
| Web artifact source | `src/App.tsx` |
| Claim scan | `README.md`; `VALIDATION_STATUS.md`; `docs/release_checklist_v0.1.0-beta.md`; `docs/python_parity_checklist.md`; `src/App.tsx` |

## Python artifact inventory

Python writes the primary report package under `RESULTS` and optional diagnostic artifacts under `RAW_DATA_DETAILS`.

### RESULTS workbook

Python writes `<base>_REPORT.xlsx` through `_write_report_workbook`.

| Order | Sheet | Key semantics |
|---:|---|---|
| 01 | `01_CONTENTS` | Index of workbook sheets. |
| 02 | `02_METADATA` | Image metadata and rule-based image QC. |
| 03 | `03_OVERVIEW` | Final quantitative summary, selected method, reliability, references/recovery when configured. |
| 04 | `04_RAW` | Well-level analytical values, RGB pseudo-absorbance, optional CIELAB/DeltaE fields. |
| 05 | `05_REPLICATES_MEAN` | Replicate medians, robust SDs, replicate QC flags. |
| 06 | `06_FITTING` | Calibration, standard-addition, unknown/equation fit rows, including `C0`/`C0_sd` when applicable. |
| 07 | `07_METHOD_COMPARISON` when method comparison exists | Common-factor method ranking with selected/rank columns and external reference checks. |
| 08 | `08_LEGENDS` when method comparison exists | Authoritative formula and field definitions. |

If method comparison rows are absent, Python uses `07_LEGENDS` instead of `07_METHOD_COMPARISON` plus `08_LEGENDS`.

### RAW_DATA_DETAILS diagnostics workbook

Python writes `<base>_DIAGNOSTICS.xlsx` through `_write_diagnostics_workbook`.

| Order | Sheet | Key semantics |
|---:|---|---|
| 01 | `01_CONTENTS` | Index of diagnostic sheets actually present. |
| 02 | `02_BG_SAMPLES` | Accepted inter-well background samples used for the background surface. |
| 03 | `03_BG_WELL_FIT` | Predicted local background at each well. |
| 04 | `04_WELL_ROBUST_STATS` | Well-level robust pixel statistics and optical QC. |
| 05 | `05_GEOMETRY_QC` | Floor/mouth geometry QC descriptors. |
| 06 | `06_WELL_BOTTOM` | Well-bottom and mouth geometry measurements. |
| 07 | `07_PLATE_GEOMETRY` | Nominal plate geometry parameters. |
| 08 | `08_EMPTY_WELLS` | Empty-well diagnostics when available. |
| 09 | `09_SPATIAL_DIAGNOSTICS` | Row/column spatial trends. |
| 10 | `10_METHOD_COMPARISON` | Cross-method diagnostic ranking using common factors. |
| 11 | `11_CIELAB_FITTING` | CIELAB/DeltaE diagnostic fit rows. |
| 12 | `12_LEGENDS` | Diagnostic workbook and figure definitions. |

Sheets 02-09 are conditional on informative CSV-backed rows. Sheets 10 and 11 are conditional on method-comparison and CIELAB/DeltaE rows. Sheet 12 is always appended when the diagnostics workbook is written.

### TXT captions

Python writes exactly two TXT caption files:

| Folder | File | Structure |
|---|---|---|
| `RESULTS` | `<base>_RESULTS_CAPTION.txt` | Title; File scope; Analytical signal; Fitting and quantification; Ranking score; Reference values and recovery; Quality control; Geometry and epsilon/path-length quantification; Units. |
| `RAW_DATA_DETAILS` | `<base>_RAW_DATA_DETAILS_CAPTION.txt` | Title; File scope; `BG_STAT_MASK.png`; `FIGURE_CIELAB_DELTAE.png`; `METHOD_COMPARISON.png`; `DIAGNOSTICS.xlsx`; Geometry and epsilon/path-length quantification; Units. |

Python TXT text is authoritative for Python artifacts. It describes a binary `BG_STAT_MASK.png`, OpenCV BGR-to-Lab CIELAB semantics, and Python path-length/epsilon behavior.

### PNG / figure outputs

| Folder | File | Python source semantics |
|---|---|---|
| `RESULTS` | `<base>_FIGURE_RGB.png` | Primary RGB report figure generated by `_make_a4_report_png`, including overlay, RGB fit panels, method/ranking/reference context, and selected best-channel output. |
| `RESULTS` | `<base>_BEST_CHANNEL.png` | Best-channel plot generated from the selected RGB/PAbs channel. |
| `RESULTS` | `<base>_PLATE_ROI_OVERLAY.png` | Plate ROI overlay saved as a single-column PNG with fixed matplotlib layout sizing. |
| `RAW_DATA_DETAILS` | `<base>_METHOD_COMPARISON.png` | Method-comparison diagnostic figure generated from method-comparison rows and expected references. |
| `RAW_DATA_DETAILS` | `<base>_FIGURE_CIELAB_DELTAE.png` | Combined CIELAB/DeltaE diagnostic report figure, generated only when CIELAB/DeltaE payloads exist. |
| `RAW_DATA_DETAILS` | `<base>_BG_STAT_MASK.png` | Binary accepted-background mask: white accepted pixels, black rejected pixels. |

## Web artifact inventory

The webapp writes a ZIP package with Python-style `RESULTS` and `RAW_DATA_DETAILS` paths from `src/App.tsx`.

### RESULTS workbook

The web builder `createPythonReportWorkbookBlob` always emits:

| Order | Sheet | Current web semantics |
|---:|---|---|
| 01 | `01_CONTENTS` | Static index for the web report workbook. |
| 02 | `02_METADATA` | Browser export metadata and current web analysis settings. |
| 03 | `03_OVERVIEW` | Web-computed summary rows; reliability scoring remains partly blank/caveated. |
| 04 | `04_RAW` | Web measurement rows, display/correction audit columns, RGB and CIELAB/DeltaE fields when present. |
| 05 | `05_REPLICATES_MEAN` | Web replicate summaries. |
| 06 | `06_FITTING` | Web RGB fit rows plus CIELAB fitting rows from browser helpers. |
| 07 | `07_METHOD_COMPARISON` | Web method-comparison rows with expected/reference columns when configured. |
| 08 | `08_LEGENDS` | Web legend text with scoped parity caveats. |

### RAW_DATA_DETAILS diagnostics workbook

The web builder `createPythonDiagnosticsWorkbookBlob` emits the Python-style 01-12 diagnostic sheets plus three web-only proof sheets:

| Order | Sheet | Current web semantics |
|---:|---|---|
| 01-12 | Python-style diagnostic sheet names | Browser-derived background, ROI, geometry, spatial, method-comparison, CIELAB fitting, and legend rows. Several fields are blank where Python quantities are not computed. |
| 13 | `13_BG_MODEL_INPUTS` | Web-only proof export for background model input rows. |
| 14 | `14_BG_MODEL_COEFFICIENTS` | Web-only proof export for polynomial coefficients and residual summaries. |
| 15 | `15_BG_MODEL_PREDICTIONS` | Web-only proof export for per-well raw background predictions. |

### TXT captions

The web captions are intentionally not verbatim Python captions:

| File | Current web semantics |
|---|---|
| `<base>_RESULTS_CAPTION.txt` | Describes the scoped primary RGB robust IRLS port and says full fitting parity across every Python workflow path remains under validation. It adds dynamic reference-value lines and states that epsilon/path-length quantification is not implemented in the web milestone. |
| `<base>_RAW_DATA_DETAILS_CAPTION.txt` | Describes the web `BG_STAT_MASK.png` as an overlay diagnostic, not the Python binary mask; describes CIELAB/DeltaE as Python-style but still dependent on descriptor-input parity. |

### PNG / figure outputs

| Folder | File | Current web source |
|---|---|---|
| `RESULTS` | `<base>_BEST_CHANNEL.png` | `buildPythonStyleBestChannelCanvas` browser canvas. |
| `RESULTS` | `<base>_FIGURE_RGB.png` | `buildPythonStyleFigureRgbCanvas` browser canvas. |
| `RESULTS` | `<base>_PLATE_ROI_OVERLAY.png` | Browser canvas plate overlay. |
| `RAW_DATA_DETAILS` | `<base>_BG_STAT_MASK.png` | `buildBackgroundMaskDiagnosticCanvas`, explicitly overlay-style. |
| `RAW_DATA_DETAILS` | `<base>_FIGURE_CIELAB_DELTAE.png` | `buildPythonStyleCielabDeltaECanvas` browser canvas. |
| `RAW_DATA_DETAILS` | `<base>_METHOD_COMPARISON.png` | `buildPythonStyleMethodComparisonCanvas` browser canvas. |

## XLSX gap table

| Gap | Classification | Evidence | Next action |
|---|---|---|---|
| Full workbook cell parity is not established for either `REPORT.xlsx` or `DIAGNOSTICS.xlsx`. | P0 artifact blocker | `direct_xlsx_txt_audit_after_36Y_A_true_python_RUN_vs_D3.md` reports `XLSX_FULL_PARITY = false`, `SAFE_TO_CLAIM_XLSX_TXT_MATCH = false`, and thousands of cell differences. Later comparator reports still mark REPORT and DIAGNOSTICS as workbook/numeric `DIFFER`. | Re-run a fresh direct XLSX audit after beta readiness and drive differences sheet by sheet to zero or explicitly separate non-Python web diagnostics. |
| Diagnostics workbook sheet count/order differs from Python when web-only BG proof sheets are present. | P0 artifact blocker for exact parity; intentional web-only diagnostic if separated | Python `_write_diagnostics_workbook` defines 01-12. Current web `createPythonDiagnosticsWorkbookBlob` emits 01-15, including `13_BG_MODEL_INPUTS`, `14_BG_MODEL_COEFFICIENTS`, and `15_BG_MODEL_PREDICTIONS`. | Move web-only proof sheets outside the Python-equivalent diagnostics workbook, or keep them in a clearly separate supplemental package. |
| `REPORT/07_METHOD_COMPARISON` has historically lacked Python reference/recovery fields in web direct comparisons. | P0 artifact blocker until freshly re-audited | `comparison_after_36W_V_pythonproof_vs_36W_U_web.md` classifies missing expected/reference/recovery columns as `RELEASE_BLOCKING_GAP`. Current code now builds expected/reference columns, but no fresh post-beta direct audit proves cell parity. | Freshly compare this sheet first; verify headers, row order, selected/rank semantics, expected/reference columns, and cell values. |
| `DIAGNOSTICS/10_METHOD_COMPARISON` has web diagnostic-only extension/header differences. | P0 for exact workbook parity; intentional diagnostic if separated | Earlier audit classifies web method-comparison extensions as `DIAGNOSTIC_ONLY_EXTRA`; direct XLSX audit shows method-comparison cell and header differences. | Decide whether diagnostics 10 must be Python-exact or whether extensions move to supplemental diagnostics. |
| Legends and explanatory sheets are not Python-authoritative text. | P0/P1 | Python legends come from `_build_legends_rows` and `_diagnostics_legend_rows`. Web legends contain scoped beta caveats, browser provenance, and web-only sheet definitions. | After runtime/artifact semantics match, copy/align Python legend rows exactly; until then keep truthful caveats but do not claim parity. |
| Background, ROI, geometry, CIELAB, and empty-well diagnostic cells differ or remain unproven. | P0 artifact blocker | Direct XLSX audit shows differences in `02_BG_SAMPLES`, `03_BG_WELL_FIT`, `04_WELL_ROBUST_STATS`, `05_GEOMETRY_QC`, `06_WELL_BOTTOM`, `07_PLATE_GEOMETRY`, `08_EMPTY_WELLS`, and `11_CIELAB_FITTING`. | Treat these as artifact parity blockers unless a fresh direct audit proves exact matching for the current commit. |
| Web metadata and reliability rows remain web-specific or blank where Python computes values. | P1 visual/format blocker; P0 if claiming exact cells | Web metadata says browser export/current settings; Python metadata is image-level metadata and rule-based QC. Web overview includes a reliability caveat. | Align only in the XLSX/TXT exactness milestone, without inventing unavailable Python values. |

## TXT gap table

| Gap | Classification | Evidence | Next action |
|---|---|---|---|
| TXT file names are aligned, but exact text parity is not established. | P0 artifact blocker | Current web writes both expected captions, and prior audits show file-list alignment. Direct audits still reject full TXT parity. | Re-run direct paragraph/line audit using `tools/audit_xlsx_txt_parity.py`. |
| `RESULTS_CAPTION.txt` is intentionally not Python-verbatim. | P0 for exact TXT parity; intentional beta caveat | Web caption adds scoped robust-IRLS wording, dynamic reference lines, LOQ fallback notes, and states web epsilon/path-length quantification is not implemented. Python caption describes Python behavior directly. | Keep caveats until corresponding Python behavior exists in web; only copy Python text when it is truthful. |
| `RAW_DATA_DETAILS_CAPTION.txt` differs because `BG_STAT_MASK.png` and CIELAB semantics differ or remain scoped. | P0/P1 | Python caption says binary mask and OpenCV BGR-to-Lab semantics. Web caption says overlay diagnostic and descriptor-input parity remains under validation. | Either make artifacts match Python, or retain explicit caveats and exclude the file from any Python-equivalent claim. |
| Caption paragraph structure and explanatory details are not locked to Python. | P1 visual/format blocker | Python captions include Geometry/epsilon/path-length paragraphs in both captions; web RAW caption omits that section and web RESULTS uses a non-Python path-length caveat. | XLSX/TXT exactness milestone should compare paragraph headings and body text directly. |
| Web caveats are scientifically necessary while runtime behavior differs. | Intentional beta truthfulness | Claim scan confirms current wording avoids full fitting/workflow/XLSX-TXT parity claims. | Do not remove caveats merely to improve textual similarity. |

## PNG gap table

| Gap | Classification | Evidence | Next action |
|---|---|---|---|
| PNG file names are aligned for the main package. | Not a blocker by itself | Prior audits report the six expected PNG names present in both outputs. | Preserve file names while working on semantic and visual parity. |
| `FIGURE_RGB.png` and `BEST_CHANNEL.png` are not safe to claim as Python-equivalent. | P0 artifact blocker | Earlier visual/semantic audit classified both as `RELEASE_BLOCKING_GAP` because web RESULTS figure context lacked reference/recovery evidence while Python provided it. Current code may have improved supporting rows, but a post-beta figure audit has not proven parity. | Fresh side-by-side audit after current code: dimensions, panel layout, selected method, fit lines, C0/C0_sd, reference/recovery, legends, and text placement. |
| `METHOD_COMPARISON.png` still has graphic/layout differences. | P1 visual/format blocker | Prior audit: dimensions match but pixels differ, classified as `STYLE_DIFFERENCE_ONLY`. Python uses its plotting stack; web uses canvas. | Align layout, labels, legends, ordering, and text placement after workbook method-comparison rows are exact. |
| `BG_STAT_MASK.png` semantics differ: Python binary mask versus web overlay diagnostic. | P1 visual blocker; P0 if claiming exact PNG parity | Python writes `union_mask_stat` as a binary accepted-background mask. Web builds an overlay canvas and captions it as overlay; previous C0 audit also flags binary-vs-overlay divergence. | Either export a Python-style binary mask for the Python-equivalent package or move overlay to supplemental diagnostics. |
| `FIGURE_CIELAB_DELTAE.png` parity is not established across current code. | P1/P0 depending on claim | Some older comparisons reported pixel identity for a specific pair, but source still uses browser CIELAB/DeltaE helpers and caption caveats descriptor-input parity. | Freshly audit figure dimensions, panels, descriptor values, fit rows, references, and plotted data sources. |
| `PLATE_ROI_OVERLAY.png` visual parity remains unproven. | P1 visual/format blocker | Prior audit found dimensions matched but pixels differed/style differed. Python saves a matplotlib single-column layout; web uses canvas. | Compare overlay geometry, colors, alpha, crop/frame, DPI, labels, and layout. |
| Browser canvas versus Python OpenCV/matplotlib rendering can produce font, antialiasing, legend, and layout differences. | P2 polish after semantic parity | This is expected from different rendering stacks. | After semantic figure parity, define acceptable pixel tolerance or exact rendering requirements. |

## Web-only diagnostics and separation recommendations

The web-only diagnostics are useful for debugging but should not live inside a package that is later claimed to be Python-equivalent unless Python exports the same sheets and fields.

| Web-only / web-specific item | Current location | Recommendation |
|---|---|---|
| `13_BG_MODEL_INPUTS` | `RAW_DATA_DETAILS/<base>_DIAGNOSTICS.xlsx` | Move to a supplemental browser diagnostics workbook or a separate web-only section. |
| `14_BG_MODEL_COEFFICIENTS` | `RAW_DATA_DETAILS/<base>_DIAGNOSTICS.xlsx` | Move with BG proof diagnostics. |
| `15_BG_MODEL_PREDICTIONS` | `RAW_DATA_DETAILS/<base>_DIAGNOSTICS.xlsx` | Move with BG proof diagnostics. |
| Overlay-style `BG_STAT_MASK.png` | `RAW_DATA_DETAILS` | Either replace with Python binary mask in the Python-equivalent package, or rename/move overlay as supplemental. |
| Browser provenance and beta caveats in legends/captions | REPORT/DIAGNOSTICS legends and TXT captions | Keep while behavior differs; remove only after exact Python behavior is implemented and audited. |

## Prioritized next milestones

### 36Y-G: XLSX/TXT exactness

Goal: make workbook and caption parity claims testable and truthful, without changing scientific calculations unless a separate scientific milestone authorizes it.

Scope:

- Generate fresh Python and web packages from the same committed input set.
- Use `tools/audit_xlsx_txt_parity.py` as the direct regression guard.
- Lock expected sheet presence/order, headers, row order, blank-vs-nonblank patterns, formulas/legend text, and TXT paragraph structure.
- Decide explicitly whether web-only proof sheets remain supplemental or are removed from the Python-equivalent diagnostics workbook.
- Keep `SAFE_TO_CLAIM_FULL_XLSX_TXT_PARITY = no` until exact direct audit passes.

### 36Y-H: PNG / figure parity

Goal: align the six PNG outputs at semantic and visual levels after workbook data sources are settled.

Scope:

- Audit dimensions, panel layout, labels, titles, legends, plotted data, selected method, C0/C0_sd, expected/reference values, recovery, and readability.
- Prioritize `FIGURE_RGB.png`, `BEST_CHANNEL.png`, `METHOD_COMPARISON.png`, and `BG_STAT_MASK.png`.
- Decide whether parity means pixel identity, bounded visual tolerance, or a documented semantic-visual checklist.
- Keep `SAFE_TO_CLAIM_FULL_PNG_FIGURE_PARITY = no` until the chosen standard passes.

### 36Y-I: Supplemental web diagnostics separation

Goal: preserve useful browser audit/proof outputs without confusing them with Python-equivalent artifacts.

Scope:

- Move web-only BG model proof sheets and overlay diagnostics into a clearly named supplemental export.
- Keep Python-equivalent paths limited to Python-authored artifact semantics.
- Update captions/legends so users can distinguish source-of-truth artifacts from browser-only diagnostics.

## Final claim state

No scientific/runtime calculations are changed by this report. No XLSX, TXT, PNG, fitting, ROI/background, image extraction, CIELAB, configurator, stored calibration, unknown/epsilon, or package-generation runtime code is changed.

The beta remains a browser companion with scoped validated paths and known artifact parity gaps. Full XLSX/TXT parity, PNG/figure parity, full artifact parity, full workflow parity, full configurator parity, full image-input parity, and full fitting parity remain unclaimed.

This report does not change the v0.1.0-beta local tag and does not establish artifact parity.
