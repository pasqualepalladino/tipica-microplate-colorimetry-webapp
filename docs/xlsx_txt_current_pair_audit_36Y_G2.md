# Current XLSX/TXT artifact pair audit 36Y-G2

Date: 2026-07-03

Path selected: limited Path B schema/text fix plus audit report.

Python source of truth: `../tipica-microplate-colorimetry/src/tipica/tipica_core/analyzer.py`

This report does not establish full XLSX/TXT parity and does not change the `v0.1.0-beta` local tag.

## Executive summary

36Y-G2 investigated whether the current webapp can generate a reproducible ZIP non-interactively from committed fixtures. No existing scripted current web ZIP export path was found in `package.json`, `scripts/`, or `tools/`. The current export remains tied to browser application state and a download action in `src/App.tsx`.

Because a current generated web ZIP was not available, no exact current Python-vs-web direct audit was run. No parity result is invented.

A narrow schema/text Path B patch was still safe and directly supported by the Python source and 36Y-F/36Y-G findings:

- Python-equivalent `RAW_DATA_DETAILS/<base>_DIAGNOSTICS.xlsx` now emits only the Python-style diagnostic workbook surface, sheets `01_CONTENTS` through `12_LEGENDS`.
- Web-only background-model proof sheets formerly embedded as `13_BG_MODEL_INPUTS`, `14_BG_MODEL_COEFFICIENTS`, and `15_BG_MODEL_PREDICTIONS` are preserved in a supplemental workbook: `RAW_DATA_DETAILS/<base>_WEB_BG_MODEL_PROOF.xlsx`.
- The RAW_DATA_DETAILS caption now truthfully documents `WEB_BG_MODEL_PROOF.xlsx` as supplemental web-only output and restores a scoped geometry/epsilon/path-length caveat.

No scientific numeric calculations, fitting algorithms, ROI/background algorithms, image decoding, CIELAB conversion, configurator logic, stored calibration logic, unknown/epsilon calculations, PNG rendering, dependencies, or release tags were changed.

Safe-to-claim flags:

| Flag | Status |
|---|---|
| `SAFE_TO_CLAIM_FULL_XLSX_TXT_PARITY` | no |
| `SAFE_TO_CLAIM_FULL_ARTIFACT_PARITY` | no |

## Baseline status

| Check | Result |
|---|---|
| `HEAD` | `2880a8d Audit XLSX TXT exactness gaps` at start of work |
| Working tree before changes | clean |
| `v0.1.0-beta` | present |
| `v0.1.0-beta` target | `a156c2b6e6a1679d2cc3228c063c93efe1c97949` |
| `a156c2b` resolves to | `a156c2b6e6a1679d2cc3228c063c93efe1c97949` |

## Files inspected

| Area | Files |
|---|---|
| Previous reports | `docs/artifact_parity_gap_map_36Y_F.md`; `docs/xlsx_txt_exactness_audit_36Y_G.md`; `test_data/manual_comparison/direct_xlsx_txt_audit_after_36Y_A_true_python_RUN_vs_D3.md`; `test_data/manual_comparison/comparison_after_36W_V_pythonproof_vs_36W_U_web.md` |
| Audit tooling | `tools/audit_xlsx_txt_parity.py`; `tools/compare_python_web_outputs.py` |
| Python source | `../tipica-microplate-colorimetry/src/tipica/tipica_core/analyzer.py` |
| Web source and scripts | `src/App.tsx`; `package.json`; `scripts/smokeFittingParity.ts`; `scripts/smokePlateConfigurator.ts`; `scripts/smokeConfiguratorPersistence.ts`; `tools/` |

## Files changed

| File | Change |
|---|---|
| `src/App.tsx` | Moved web-only BG proof workbook sheets out of `DIAGNOSTICS.xlsx` and into supplemental `WEB_BG_MODEL_PROOF.xlsx`; updated RAW_DATA_DETAILS caption wording. |
| `docs/xlsx_txt_current_pair_audit_36Y_G2.md` | This audit and schema-separation report. |

## Current artifact generation result

| Artifact | Status | Provenance |
|---|---|---|
| Current Python reference ZIP | not generated in this turn | Python source of truth is available, but this milestone first needed an unambiguous paired web export path. |
| Current webapp ZIP from `HEAD` | not generated in this turn | No non-interactive committed fixture/export script was found; browser export depends on live app state and `downloadBlob`. |
| Fresh current direct audit | not run | Blocked by missing current generated web ZIP. |

Existing committed historical ZIPs remain useful for gap classification, but they are not current `HEAD` artifacts and must not be used as current parity proof.

## Fresh audit status

| Item | Status |
|---|---|
| Fresh current web ZIP generation succeeded | no |
| Exact Python artifact path | none for current generated pair |
| Exact web artifact path | none for current generated pair |
| Fresh direct XLSX/TXT audit run | no |
| Historical direct audit evidence | available from 36Y-G and prior reports |

Precise blocker:

- The web package export is implemented inside `src/App.tsx` using current React/browser state and `downloadBlob`.
- No existing script was found that loads committed image/project fixtures, runs the app extraction/fitting workflow, and writes the same ZIP package without manual browser interaction.
- Creating a pseudo-ZIP by mixing reference outputs or partially reusing helper functions would have ambiguous provenance and would not satisfy a current direct audit.

## Limited Path B schema/text changes

### DIAGNOSTICS.xlsx sheet separation

Before G2, current web source placed proof-only BG model sheets inside `createPythonDiagnosticsWorkbookBlob`:

- `13_BG_MODEL_INPUTS`
- `14_BG_MODEL_COEFFICIENTS`
- `15_BG_MODEL_PREDICTIONS`

Python `_write_diagnostics_workbook` writes the diagnostic workbook with Python-style sheets `01_CONTENTS` through `12_LEGENDS`; it does not write those proof-only sheets.

After G2:

- `createPythonDiagnosticsWorkbookBlob` emits `01_CONTENTS` through `12_LEGENDS`.
- `buildDiagnosticsContentsRows` lists only the sheets inside that workbook, fixing the contents-order/schema inconsistency noted in 36Y-G.
- New helper `createWebBgModelProofWorkbookBlob` preserves proof-only BG tables in `WEB_BG_MODEL_PROOF.xlsx`.
- The export ZIP adds `RAW_DATA_DETAILS/<base>_WEB_BG_MODEL_PROOF.xlsx`.

### TXT caption wording

The RAW_DATA_DETAILS caption now:

- identifies `WEB_BG_MODEL_PROOF.xlsx` as supplemental web-only proof output;
- says the workbook is not part of the Python `DIAGNOSTICS.xlsx` schema;
- keeps the statement that it does not change calculations;
- adds a scoped geometry/epsilon/path-length caveat without claiming web epsilon/path-length implementation.

## REPORT.xlsx remaining gaps

| Gap | Classification | Status after G2 |
|---|---|---|
| Current direct cell parity not proven. | P0 artifact blocker | unchanged; blocked by missing current web ZIP generation. |
| Web metadata and overview rows still differ from Python semantics. | P0/P1 | unchanged. |
| Web report includes audit/proof columns in raw/replicate/fitting sheets. | P0 for exact parity unless separated or proven intended | unchanged. |
| Method-comparison numeric/text parity remains unproven after post-IRLS work. | P0 | unchanged. |
| Legend text contains truthful web caveats instead of Python-verbatim text. | P1/P0 depending on claim | unchanged. |

## DIAGNOSTICS.xlsx remaining gaps

| Gap | Classification | Status after G2 |
|---|---|---|
| Web-only sheets 13-15 inside Python-equivalent diagnostics workbook. | previously P0 artifact blocker | improved: moved to supplemental `WEB_BG_MODEL_PROOF.xlsx`. |
| Current direct cell parity not proven for sheets 01-12. | P0 artifact blocker | unchanged; still requires current direct audit. |
| `02_BG_SAMPLES` still carries web-specific proof columns such as `Web_*`. | P0/P1 | unchanged; content preserved in `DIAGNOSTICS.xlsx` for now because suppressing columns requires current audit proof and a preservation decision. |
| Background, ROI, geometry, empty-well, CIELAB, and method-comparison numeric cells remain unproven. | P0 | unchanged. |
| Diagnostic legend text still includes web caveats for non-Python behavior, including overlay `BG_STAT_MASK`. | P1/P0 depending on claim | unchanged and truthful. |

## TXT caption remaining gaps

| Gap | Classification | Status after G2 |
|---|---|---|
| `RESULTS_CAPTION.txt` remains non-verbatim Python text. | P0 for exact text parity; intentional beta truthfulness | unchanged. |
| `RAW_DATA_DETAILS_CAPTION.txt` remains non-verbatim Python text. | P0 for exact text parity; intentional beta truthfulness | changed but still intentionally divergent. |
| RAW caption now documents supplemental web workbook. | intentional web-only diagnostic | improved truthfulness, not Python parity. |
| RAW caption uses web-specific epsilon/path-length caveat rather than Python-verbatim paragraph. | intentional beta truthfulness | improved structure, not Python parity. |

## What remains unsafe to claim

- Full XLSX/TXT parity.
- Full artifact parity.
- Current Python/web artifact parity.
- Current workbook numeric parity.
- Current caption exactness.
- Python-equivalent `BG_STAT_MASK.png` semantics, because the web output remains an overlay diagnostic.

## Next recommended milestone

Use 36Y-G3 rather than 36Y-H if the next priority is still XLSX/TXT exactness.

36Y-G3 should add a reproducible current artifact generation fixture:

1. Load a committed project/image fixture non-interactively.
2. Execute the same web extraction/fitting/export path used by the browser package.
3. Write the web ZIP to `test_data/manual_comparison/` or another documented audit directory.
4. Generate the paired Python reference ZIP from the Python source of truth and the same input set.
5. Run `tools/audit_xlsx_txt_parity.py --numeric-tolerance 0`.

Move to 36Y-H PNG/figure parity only after the XLSX/TXT generation path is reproducible and the remaining workbook/text gaps are intentionally classified.
