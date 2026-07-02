# TIPICA Webapp

TIPICA Webapp is a beta browser-based companion implementation of TIPICA, designed to improve accessibility of image-based plate colorimetric analysis workflows.

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

## What remains under validation

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

## Reference implementation

The archived Python desktop implementation remains the reference implementation for the manuscript results. The browser implementation is being checked against that reference output before any broader parity claim should be made.

## Output package

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
```

## How to run locally

```bash
npm install
npm run build
npm run smoke:plate-configurator
npm run dev
```

Open the local Vite URL shown in the terminal after `npm run dev`.

## Validation documents

- [Validation status](VALIDATION_STATUS.md)
- [Python parity checklist](docs/python_parity_checklist.md)
- [Reviewer quick start](docs/reviewer_quick_start.md)

## Privacy

All processing is performed locally in the browser. Uploaded images, geometry files, plate maps, and results are not sent to any server by this beta application.

## About

Developed by Pasquale Palladino.
