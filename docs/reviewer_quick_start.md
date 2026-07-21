# Reviewer Quick Start

## Purpose

TIPICA Webapp is a beta, client-side browser companion for image-based plate colorimetry. It supports complete browser workflows and structured exports while keeping uploaded data local to the browser.

The webapp was not used to generate the submitted manuscript results. The archived Python desktop implementation remains the reference for those results.

## Public browser version

https://pasqualepalladino.github.io/tipica-microplate-colorimetry-webapp/

## Local setup

```bash
npm install
npm run build
npm run dev
```

Optional regression checks:

```bash
npm run smoke:fitting-parity
npm run smoke:plate-configurator
npm run smoke:configurator-persistence
```

## Generate an analysis package

1. Load or acquire a plate image.
2. Load or define the matching geometry.
3. Configure or load the plate map.
4. Load an external calibration or configure internal calibration when required.
5. Run extraction and fitting.
6. Export the complete analysis package.

Typical artifacts are:

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

Workbook sheets are workflow-dependent, consecutively numbered, and listed in `01_CONTENTS`. Non-applicable empty sheets are omitted.

## Interpretation

Primary results are group-level summaries. Individual wells are retained in diagnostic/raw sheets.

`METHOD_COMPARISON` is workflow-aware:

- unknown-only with external calibration: concentration/reference and calibration-quality panels;
- calibration plus standard addition: agreement/bias, concentration/reference, and calibration/standard-addition R² panels.

Empty wells can support plate background and illumination screening. They are not quantitative unknowns. Sparse spatial coverage may yield `available_insufficient` even when channel-level spread checks are acceptable.

## Validation scope

Representative output packages have been audited for external-calibration unknown-only, external-calibration standard-addition, internal-calibration standard-addition, and sparse/extensive empty-well cases. The audit checked internal consistency among PNG, XLSX, TXT, and JSON artifacts.

Do not interpret this as universal equivalence with every Python workflow, historical workbook, image-input condition, or configurator path.

## Citation

Use the webapp citation metadata in `CITATION.cff` for this browser software. For scientific comparison or manuscript-related use, also cite the archived Python reference package/manuscript:

https://doi.org/10.5281/zenodo.20553451
