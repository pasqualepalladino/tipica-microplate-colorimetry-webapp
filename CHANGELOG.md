# Changelog

## Unreleased

- Release-readiness metadata and documentation updates for the beta webapp package.
- No scientific calculation changes in this release-readiness milestone.

## 0.1.0-beta

### Added

- Browser-based beta workflow for local image-based plate colorimetry exploration.
- Python-style `RESULTS/` and `RAW_DATA_DETAILS/` output package structure.
- RGB pseudo-absorbance extraction, calibration, standard addition, reference-value comparison, PNG figures, and report/diagnostic workbook exports.
- TypeScript port of the Python robust residual-based IRLS linear regression helper with covariance propagation for rewired primary RGB calibration and standard-addition fit rows.
- Exported CIELAB/DeltaE diagnostic fitting rows using the robust IRLS helper where currently wired.
- Project JSON save/load support, including improved configurator/project persistence for quantification-affecting fields.
- Python canonical geometry override safety improvements for developer parity checks.
- Local smoke checks for fitting parity, plate configurator behavior, and configurator persistence.

### Validation Limitations

- The Python desktop package remains the source of truth/reference implementation for manuscript results.
- Full workflow, fitting, configurator, image input/QC, XLSX/TXT, ROI/background, and CIELAB/DeltaE parity remain unclaimed.
- XLSX/TXT parity is not fully established.
- The webapp beta deposit must not be treated as equivalent to the archived Python package deposit.
