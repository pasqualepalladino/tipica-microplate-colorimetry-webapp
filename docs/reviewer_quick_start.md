# Reviewer Quick Start

## Purpose

TIPICA Webapp is a beta browser-based companion interface for evaluating the browser workflow for image-based plate colorimetric analysis. It currently reproduces the Python-style output package structure and supports local, client-side exploration of the workflow.

## Important limitation

The current webapp is intended for preliminary evaluation of the browser workflow. It should not be used as the authoritative source for the manuscript numerical results unless validation against the Python source and outputs is completed for that specific use.

The webapp was not used to generate the submitted manuscript results.

## Local setup

Install dependencies and run the local development server:

```bash
npm install
npm run dev
```

For validation-oriented local checks:

```bash
npm run build
npm run smoke:plate-configurator
```

## Generate an output package

1. Load a plate image.
2. Load the matching geometry/project inputs.
3. Configure or load the plate map.
4. Run extraction and fitting.
5. Export the complete analysis package.

The intended default package contains:

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

## Interpreting outputs

The exported files are useful for reviewing the browser workflow and the current state of Python-style package generation. Full parity remains unclaimed; validation is still ongoing for numerical values, workbook content, CIELAB/DeltaE diagnostics, fitting inputs beyond the rewired robust IRLS rows, background and ROI diagnostics, geometry diagnostics, captions, XLSX/TXT content, and figure formatting.

Treat the output as beta validation material rather than manuscript-source numerical evidence.

## Reference implementation

The archived Python desktop implementation remains the reference implementation for the manuscript results.
