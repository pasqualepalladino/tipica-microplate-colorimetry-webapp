# TIPICA Webapp

TIPICA Webapp is a beta browser-based companion implementation of TIPICA, designed to improve accessibility of image-based plate colorimetric analysis workflows.

## Public webapp, source code, and archive

- Public webapp: https://pasqualepalladino.github.io/tipica-microplate-colorimetry-webapp/
- Source repository: https://github.com/pasqualepalladino/tipica-microplate-colorimetry-webapp
- Webapp archive / Zenodo DOI: https://doi.org/10.5281/zenodo.21218968
- Python reference archive / Zenodo DOI: https://doi.org/10.5281/zenodo.20553451

The browser webapp is archived separately from the Python desktop reference implementation. The public webapp is the operational browser interface; the GitHub repository contains the source code; the Zenodo webapp DOI provides the citable archived software record.

## Beta status and relationship to the Python reference

This beta release is a browser-based companion implementation for TIPICA-style plate colorimetry workflows. It produces Python-style outputs and reproducibility metadata for local review and comparison, but it is not yet validated as a full equivalent to the archived Python reference implementation. Numerical results, XLSX/TXT content, figure formatting, and several diagnostics remain under active parity validation; Python remains the reference for exact artifact structure and scientific outputs.

TIPICA Webapp is currently a beta companion interface under active parity validation. The archived Python desktop implementation remains the reference implementation for the manuscript results.

The webapp was not used to generate the submitted manuscript results. Users should not interpret the current webapp as a validated substitute for the archived Python desktop release.

## Current status

The webapp currently provides a Python-style output package structure and a browser-based workflow for plate colorimetry. Full parity validation remains open for numerical outputs, diagnostic workbook content, CIELAB/DeltaE inputs and outputs, background and ROI diagnostics, configurator behavior, image input/QC, XLSX/TXT contents, and figure formatting. Primary RGB calibration and standard-addition fit rows now use a TypeScript port of the Python robust IRLS fit with covariance propagation.

## What is currently implemented

- Project-based plate colorimetry workflow
- Plate configurator
- RGB pseudo-absorbance analysis
- Calibration and standard addition workflows
- Reference-value comparison
- Python-style `RESULTS/` and `RAW_DATA_DETAILS/` output package
- PNG figure export
- `RESULTS` report workbook
- `RAW_DATA_DETAILS` diagnostics workbook

## Known validation limitations

- Numerical parity with the Python desktop implementation
- Full fitting parity across every Python path
- Robust fitting input parity outside the rewired primary RGB and exported CIELAB/DeltaE fit rows
- Image input/QC parity
- Configurator parity
- XLSX/TXT content parity
- Replicate aggregation and `n_points` parity
- CIELAB/DeltaE diagnostic parity
- Diagnostic workbook content parity
- Background sampling and ROI/core/used-pixel parity
- Geometry diagnostic parity
- Figure-level formatting parity

Safety flags for the beta release:

- SAFE_TO_CLAIM_FULL_WORKFLOW_PARITY = no
- SAFE_TO_CLAIM_FULL_FITTING_PARITY = no
- SAFE_TO_CLAIM_FULL_CONFIGURATOR_PARITY = no
- SAFE_TO_CLAIM_FULL_IMAGE_INPUT_PARITY = no
- SAFE_TO_CLAIM_FULL_XLSX_TXT_PARITY = no
- SAFE_TO_CLAIM_WEBAPP_DEPOSIT_EQUIVALENT_TO_PYTHON_DEPOSIT = no

## Reference implementation

The archived Python desktop implementation remains the reference implementation for the manuscript results. The browser implementation is being checked against that reference output before any broader parity claim should be made.

## Exported artifacts

The webapp exports a complete-analysis package as a ZIP archive containing Python-style RESULTS and RAW_DATA_DETAILS folders. Typical contents include:

- XLSX workbooks for the RESULTS report and RAW_DATA_DETAILS diagnostics
- TXT caption files for the report and raw-data details outputs
- PNG figures for plate ROI overlays, RGB views, CIELAB/DeltaE diagnostics, and method-comparison views
- Reproducibility metadata in RAW_DATA_DETAILS with analysis_run_config.json

The current intended default ZIP structure is:

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

Open the public browser version:

https://pasqualepalladino.github.io/tipica-microplate-colorimetry-webapp/

All processing is performed locally in the browser. Uploaded images, geometry files, plate maps, and results are not sent to any server by this beta application.

## How to run locally

```bash
npm install
npm run build
npm run smoke:plate-configurator
npm run dev
```

Open the local Vite URL shown in the terminal after `npm run dev`.

## How to validate locally

```bash
npm run build
npm run smoke:fitting-parity
npm run smoke:plate-configurator
npm run smoke:configurator-persistence
```

These checks are regression guards for the beta browser implementation. Passing them does not establish full Python workflow or output parity.

## Citation and relationship to Python reference

This repository is the TIPICA Webapp beta browser companion. It is not the archived Python reference implementation and was not used to generate the submitted manuscript results.

If citing this beta webapp, use the metadata in [CITATION.cff](CITATION.cff) and the webapp Zenodo DOI: https://doi.org/10.5281/zenodo.21218968.

When using, validating, or comparing scientific results, also cite the archived Python reference package/manuscript as appropriate. The Python reference package DOI is https://doi.org/10.5281/zenodo.20553451.

## Validation documents

- [Validation status](VALIDATION_STATUS.md)
- [Python parity checklist](docs/python_parity_checklist.md)
- [Reviewer quick start](docs/reviewer_quick_start.md)
- [Release checklist v0.1.0-beta](docs/release_checklist_v0.1.0-beta.md)

## Privacy

All processing is performed locally in the browser. Uploaded images, geometry files, plate maps, and results are not sent to any server by this beta application.

## About

Developed by Pasquale Palladino.
