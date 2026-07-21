# TIPICA Webapp

TIPICA Webapp is the beta browser-based companion implementation of TIPICA, designed to make image-based plate colorimetry workflows accessible through a local, client-side web interface.

## Public webapp, source code, and archives

- Public webapp: https://pasqualepalladino.github.io/tipica-microplate-colorimetry-webapp/
- Source repository: https://github.com/pasqualepalladino/tipica-microplate-colorimetry-webapp
- Webapp Zenodo concept DOI: https://doi.org/10.5281/zenodo.21218967
- Latest currently archived webapp version before this release: v0.1.32-beta, https://doi.org/10.5281/zenodo.21398838
- Python reference archive DOI: https://doi.org/10.5281/zenodo.20553451

The browser webapp is archived separately from the Python desktop reference implementation. The public GitHub Pages site is the operational browser interface; the repository contains the source code; Zenodo provides citable, versioned software archives.

## Beta status and relationship to the Python reference

The webapp is a browser-based companion implementation for TIPICA-style plate colorimetry workflows. It was not used to generate the submitted manuscript results. The archived Python desktop implementation remains the reference implementation for those results and for exact comparison where a workflow has not yet been audited.

The current beta has undergone a detailed output-consistency audit covering representative workflows with:

- external calibration and unknown-only samples;
- external calibration and standard addition;
- internal calibration and internal standard addition;
- sparse and extensive empty-well coverage.

For the audited browser workflows, the exported PNG, XLSX, TXT, and JSON artifacts now share the same group-level result model, reference metadata, uncertainty values, recovery values, method applicability, and workflow-dependent method-comparison logic. This does not establish universal, file-for-file equivalence with every Python path, input mode, or historical artifact.

## Current capabilities

- Project-based plate colorimetry workflow
- Plate configurator and project persistence
- RGB pseudo-absorbance analysis
- Quantitative RGB calibration
- External and internal calibration workflows
- Standard-addition workflows
- Unknown-only group quantification from calibration
- Quantitative CIELAB-derived projections where supported
- Multiple reference values with uncertainty, delta, and recovery reporting
- Workflow-aware method comparison
- Empty-well background and illumination-uniformity screening
- Python-style `RESULTS/` and `RAW_DATA_DETAILS/` output package
- PNG figures, XLSX workbooks, TXT captions, and JSON reproducibility metadata
- Dynamic, consecutive workbook sheet numbering with non-applicable empty sheets omitted

## Output model

Primary scientific summaries are group-based:

- for `n = 1`, one group result is reported without an artificial SD;
- for `n >= 2`, the group mean, sample SD, and `n` are reported;
- individual wells are retained in diagnostic/raw outputs rather than promoted as primary results.

`METHOD_COMPARISON` adapts to the available workflow:

- calibration plus standard addition: full comparison with slope agreement, bias, calibration R², and standard-addition R²;
- external-calibration unknown-only: concentration-versus-reference and calibration-quality panels only;
- metrics that are not applicable are omitted or explicitly marked as not applicable rather than represented as zero.

Empty wells may be used for background and illumination screening, but they are not counted as quantitative unknowns. The QC summary distinguishes unavailable, insufficient-coverage, pass, warning, and fail states and records spatial coverage and channel-specific screening statistics.

## Remaining validation boundaries

The following broader claims remain intentionally unmade:

- full equivalence across every Python workflow and fitting path;
- exact equality of every historical Python workbook, caption, and figure layout;
- complete image-input, geometry, ROI, background-model, and configurator parity for every supported plate design;
- complete parity for workflows not yet audited with matched inputs and outputs;
- equivalence between the webapp Zenodo deposit and the Python reference deposit.

The Python implementation remains the source of truth for manuscript results and for any unaudited scientific path.

Safety flags:

- `SAFE_TO_CLAIM_FULL_WORKFLOW_PARITY = no`
- `SAFE_TO_CLAIM_FULL_FITTING_PARITY = no`
- `SAFE_TO_CLAIM_FULL_CONFIGURATOR_PARITY = no`
- `SAFE_TO_CLAIM_FULL_IMAGE_INPUT_PARITY = no`
- `SAFE_TO_CLAIM_UNIVERSAL_XLSX_TXT_PARITY = no`
- `SAFE_TO_CLAIM_WEBAPP_DEPOSIT_EQUIVALENT_TO_PYTHON_DEPOSIT = no`

## Exported artifacts

The webapp exports a complete-analysis ZIP with `RESULTS/` and `RAW_DATA_DETAILS/` folders. The exact files and workbook sheets are workflow-dependent; non-applicable empty sheets are omitted.

Typical contents are:

```text
RESULTS/
  <base>_BEST_CHANNEL.png
  <base>_FIGURE_RGB.png
  <base>_PLATE_ROI_OVERLAY.png
  <base>_REPORT.xlsx
  <base>_RESULTS_CAPTION.txt

RAW_DATA_DETAILS/
  <base>_BG_STAT_MASK.png
  <base>_DIAGNOSTICS.xlsx
  <base>_FIGURE_CIELAB_DELTAE.png
  <base>_METHOD_COMPARISON.png
  <base>_RAW_DATA_DETAILS_CAPTION.txt
  <base>_analysis_run_config.json
```

## How to use the public webapp

Open:

https://pasqualepalladino.github.io/tipica-microplate-colorimetry-webapp/

All processing is performed locally in the browser. Uploaded images, geometry files, plate maps, and results are not sent to a server by the application.

## How to run locally

```bash
npm install
npm run build
npm run smoke:plate-configurator
npm run dev
```

Open the local Vite URL shown after `npm run dev`.

## Local regression checks

```bash
npm run build
npm run smoke:fitting-parity
npm run smoke:plate-configurator
npm run smoke:configurator-persistence
```

These checks are regression guards. Passing them does not, by itself, establish universal Python equivalence.

## Citation

For the webapp as a whole, cite the Zenodo concept DOI: https://doi.org/10.5281/zenodo.21218967.

For scientific comparison or manuscript-related use, also cite the archived Python reference package/manuscript as appropriate: https://doi.org/10.5281/zenodo.20553451.

The version-specific DOI for the next webapp archive will be added after Zenodo completes the release deposition.

## Validation documents

- [Validation status](VALIDATION_STATUS.md)
- [Python parity checklist](docs/python_parity_checklist.md)
- [Reviewer quick start](docs/reviewer_quick_start.md)
- [Release checklist](docs/release_checklist.md)

## Privacy

All processing is performed locally in the browser. Uploaded images, geometry files, plate maps, and results are not sent to any server by the application.

## About

Developed by Pasquale Palladino.
