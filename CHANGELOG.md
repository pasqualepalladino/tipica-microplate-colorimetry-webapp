# Changelog

## v0.1.0-beta

### Completed Features

- React + TypeScript + Vite client-side prototype.
- Image and four-corner geometry JSON loading.
- Manual four-corner picking and geometry JSON export.
- 96-well grid generation with ROI overlay.
- RGB/PAbs extraction with raw and corrected PAbs reporting.
- Plate map editor with example maps for Piastra 70, Calibration Purple, and SAM 100_50.
- Demo examples helper section for guided loading of Piastra 70, Calibration Purple, and SAM 100_50 workflows.
- Calibration fitting from wells marked `C`.
- Standard-addition fitting from wells marked `A`.
- Stored/external calibration JSON import/export.
- Version 2 stored calibration JSON with RGB low-signal correction metadata.
- Optional RGB calibration-derived low-signal correction.
- Internal and stored slope agreement reporting.
- Unknown concentration projection from stored calibration for wells marked `U`.
- CSV export for RGB/PAbs well results, calibration results, standard-addition results, and unknown results.
- About/Cite, privacy note, workflow guide, validation checklist, and release-readiness summary.

### Known Limitations

- Pre-publication beta for controlled evaluation.
- Manuscript analyses used the full Python implementation, not this web beta.
- Static client-side app only; no backend processing or server upload.
- Beta supports 96-well plates only.
- Beta descriptors are RGB PAbs only.
- Full diagnostic workbook is not included.
- Advanced QC is not included.
- CIELAB/DeltaE is not included.
- Full Python-equivalent background model is not included.
