# Validation Status

## Scope

TIPICA Webapp is a beta browser companion to the archived Python desktop implementation. It was not used to generate the submitted manuscript results. Python remains the reference for those results and for any workflow not yet audited with matched inputs and outputs.

## Audited browser workflows

The current output-consistency audit includes representative runs for:

1. external calibration with unknown-only samples;
2. external calibration with standard addition;
3. internal calibration with internal standard addition;
4. sparse empty-well coverage;
5. extensive empty-well coverage.

The audit compared complete exported packages, including PNG figures, TXT captions, JSON metadata, report workbooks, diagnostic workbooks, sheet applicability, sheet numbering, duplicated rows, reference handling, and cross-file numerical consistency.

## Current validated behavior within that scope

| Area | Current status | Notes |
|---|---|---|
| Group-level primary reporting | Audited | Primary figures and summaries use `ID + DF + method` group results. Individual wells remain in raw/diagnostic outputs. |
| Replicate reporting | Audited | `n = 1` is reported without artificial SD; `n >= 2` uses mean, sample SD, and `n`. |
| External-calibration unknown-only workflow | Audited | Two-panel method comparison; standard-addition-only metrics are omitted or marked not applicable. |
| External calibration plus standard addition | Audited | Three-panel comparison retains slope agreement, bias, calibration R², and standard-addition R². |
| Internal calibration plus standard addition | Audited | Calibration and standard-addition fit rows, method comparison, references, and C0 outputs were cross-checked. |
| RGB and supported CIELAB unknown projections | Audited for tested workflows | Shared group-level values are synchronized across figure, XLSX, TXT, and JSON outputs. |
| Reference handling | Audited | Multiple references, including repeated labels, retain distinct IDs, values, SDs, delta, and recovery. |
| Workbook structure | Audited | Applicable sheets are numbered consecutively; `01_CONTENTS` is generated from the actual sheet list; non-applicable empty sheets are omitted. |
| Empty-well QC | Audited for sparse and extensive coverage | Empty wells are not unknowns. QC includes robust spread, spatial coverage, trend screening, and explicit sufficiency states. |
| Caption applicability | Audited | Captions distinguish unknown-only, standard-addition-only, and mixed contexts and avoid fixed sheet numbers. |
| Excel integrity | Audited in tested packages | No `#REF!`, `#DIV/0!`, `#VALUE!`, `#NAME?`, or `#N/A` errors were found in the audited packages. |

## Important boundaries

The completed audit supports consistency claims for the tested browser workflows. It does not establish:

- universal equivalence with every Python workflow or code path;
- exact identity with every historical Python workbook, caption, or figure;
- complete parity for every image-input mode, geometry configuration, background model, ROI rule, or plate design;
- complete configurator parity outside the tested persistence and workflow paths;
- equivalence between the webapp Zenodo archive and the Python reference archive;
- use of the webapp as the source of the submitted manuscript results.

A special Python feature for epsilon/path-length concentration calculation is not currently implemented in the browser configurator and is outside the present workflow audit.

## Safety flags

- `SAFE_TO_CLAIM_FULL_WORKFLOW_PARITY = no`
- `SAFE_TO_CLAIM_FULL_FITTING_PARITY = no`
- `SAFE_TO_CLAIM_FULL_CONFIGURATOR_PARITY = no`
- `SAFE_TO_CLAIM_FULL_IMAGE_INPUT_PARITY = no`
- `SAFE_TO_CLAIM_UNIVERSAL_XLSX_TXT_PARITY = no`
- `SAFE_TO_CLAIM_WEBAPP_DEPOSIT_EQUIVALENT_TO_PYTHON_DEPOSIT = no`

## Appropriate wording

Appropriate:

> The audited browser workflows produce internally consistent group-level PNG, XLSX, TXT, and JSON outputs for the tested external-calibration, internal-calibration, standard-addition, unknown-only, and empty-well-QC cases.

Not appropriate:

> The webapp is fully identical to the Python implementation in every workflow and artifact.

## Reference implementation

The archived Python desktop implementation remains the reference implementation for manuscript results:

https://doi.org/10.5281/zenodo.20553451
