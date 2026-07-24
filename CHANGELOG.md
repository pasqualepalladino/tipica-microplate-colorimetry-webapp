# Changelog

## 0.1.58-beta - 2026-07-24

- Added percentage concentration units: % m/v, % v/v and % m/m, with the existing freely configurable scale behavior preserved.
- Made stored-calibration units universal and derived from the configurator instead of being fixed to mM.
- Preserved legacy mM fallback for older calibration files and retained imported Python unit labels.
## 0.1.57-beta - 2026-07-24

- Enabled full internal technical workflow testing for 384-well and 1536-well plates, including dynamic row labels, mouth/floor geometry, physical inter-well background, analysis and exports.
- Added dynamic nominal manual-corner metadata for all configured plate formats and offset subregions while preserving legacy geometry keys for backward compatibility.
- Expanded plate-configurator smoke coverage for 6, 12, 24, 48, 96, 384 and 1536 wells.
## 0.1.56-beta - 2026-07-23

### Plate-format workflows

- Completed internal technical workflow testing for nominal flat-bottom 6-, 12-, 24- and 48-well formats using real near-frontal images.
- Preserved 96-well as the experimentally validated format and 384-/1536-well as geometrically configurable and supported in principle, but not yet internally workflow-tested.
- Added dynamic nominal plate geometry, physical mouth/floor scaling, and physical inter-well background regions across supported layouts.
- Added dynamic and compact BG_STAT_MASK corner labels and diagnostics for small source images.
- Enforced floor radii below their corresponding local mouth radii consistently across ROI use, overlays and JSON export.

### Validation boundaries

- Epsilon/path-length quantification remains not implemented; related equations and fields are informational placeholders only.
## 0.1.54-beta - 2026-07-21

### Changed

- Replaced the hardcoded GitHub Pages workflow run name with a branch-aware dynamic label.
- Converted the TypeScript build pipeline to explicit no-emit type checks before the Vite build.
- Removed generated `vite.config.js` and `vite.config.d.ts` artifacts from the repository.
- Added ignore rules for generated Vite configuration and TypeScript build-info files.
- Preserved the validated v0.1.53-beta scientific-output and documentation changes.

## 0.1.53-beta - 2026-07-21

### Documentation and release metadata

- Updated README, citation metadata, validation status, reviewer guidance, parity checklist, and release checklist to reflect the completed v0.1.52 audit work.
- Replaced obsolete references to v0.1.0-beta and v0.1.32-beta as the current software state.
- Preserved explicit limitations: the browser implementation is not claimed as universally equivalent to every Python workflow or historical artifact.
- Prepared metadata for the next GitHub and Zenodo release.

### Scientific calculations

- No new scientific-calculation change relative to v0.1.52-beta.

## 0.1.52-beta - 2026-07-21

### Output consistency and quantitative reporting

- Unified primary group-only reporting across PNG, XLSX, TXT, and JSON outputs.
- Added consistent mean, sample SD, replicate count, reference uncertainty, delta, and recovery propagation.
- Added quantitative RGB and supported CIELAB-derived unknown projections.
- Made method comparison workflow-aware:
  - two panels for external-calibration unknown-only runs;
  - three panels when calibration and standard addition are available.
- Removed non-applicable slope-agreement, bias, and standard-addition R-squared claims from unknown-only runs.
- Preserved full standard-addition comparison for external and internal calibration workflows.
- Added handling for multiple references with identical labels without column collisions.

### Figures and captions

- Aligned method labels, reference bands, out-of-scale markers, clipping, margins, and panel-dependent legends.
- Preserved fixed-width scientific tables and controlled formula wrapping.
- Updated captions conditionally for unknown-only, standard-addition-only, and mixed workflows.

### XLSX and diagnostics

- Made workbook sheets dynamic and consecutively numbered.
- Omitted non-applicable empty sheets and generated `01_CONTENTS` from the final sheet list.
- Confined individual-well results to raw/diagnostic outputs.
- Corrected RGB diagnostic row/column coordinates.
- Removed duplicate CIELAB fitting rows.
- Synchronized METHOD_COMPARISON rows with the same group-level model used by figures and JSON.

### Empty-well plate QC

- Added empty-well screening for background and illumination uniformity.
- Added robust spread, spatial-trend, row/column coverage, and channel-level statistics.
- Added `not_available`, `available_insufficient`, `pass`, `warning`, and `fail` states.
- Kept empty-well QC separate from quantitative concentration calculations and method ranking.

### Validation

Representative packages were checked for:

- external calibration with unknown-only samples;
- external calibration with standard addition;
- internal calibration with internal standard addition;
- sparse and extensive empty-well coverage.

## 0.1.0-beta

### Added

- Initial browser-based beta workflow for local image-based plate colorimetry exploration.
- Python-style output package structure.
- RGB pseudo-absorbance extraction, calibration, standard addition, reference comparison, figures, and workbook exports.
