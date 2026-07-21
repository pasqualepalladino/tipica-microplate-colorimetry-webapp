# Python Parity Checklist

This checklist supports continued comparison between TIPICA Webapp and the archived Python desktop implementation. Python remains the reference for manuscript results and unaudited workflows.

## Establish a matched case

- Use the same plate image, geometry, plate map, calibration configuration, units, references, and analysis settings.
- Record whether the case is unknown-only, standard-addition-only, mixed, external calibration, or internal calibration.
- Record the expected empty-well distribution and whether it supports two-dimensional QC.
- Export a fresh complete package from both implementations where direct parity is being claimed.

## Package structure

- Confirm only intended `RESULTS/` and `RAW_DATA_DETAILS/` artifacts are present.
- Confirm workflow-inapplicable workbook sheets are omitted.
- Confirm all workbook prefixes are consecutive without gaps.
- Confirm `01_CONTENTS` exactly matches the actual sheet list.
- Confirm no temporary, developer, or legacy files are present.

## Shared result model

- Confirm primary outputs use group-level `ID + DF + method` results.
- Confirm individual wells appear only in raw/diagnostic contexts.
- Confirm `n = 1` has no artificial SD.
- Confirm `n >= 2` uses the sample SD.
- Confirm PNG, XLSX, TXT, and JSON use the same mean, SD, `n`, reference, delta, recovery, and display status.

## Calibration and standard addition

- Compare fit inputs, slope, intercept, covariance, R², LOD, and LOQ where applicable.
- Verify `C0 = DF × q / m` for standard-addition groups.
- Verify propagated C0 SD.
- Verify `beta = m_stdadd / m_cal` and the exported bias definition.
- Verify method ranking uses only applicable metrics.
- Verify unknown-only runs do not display slope agreement, bias, or standard-addition R².
- Verify calibration-plus-standard-addition runs retain the full three-panel comparison.

## References

- Verify each reference ID, label, value, SD, unit, delta, and recovery.
- Test repeated reference labels with different IDs.
- Confirm no dynamic-column collision or silent overwrite occurs.
- Confirm out-of-scale display status does not replace the underlying numerical result or reliability assessment.

## CIELAB-derived outputs

- Compare `L`, `a`, `b`, `DeltaL`, `Deltaa`, `Deltab`, `DeltaE_ab`, and `DeltaE_ab_chroma` where supported by both paths.
- Confirm quantitative CIELAB-derived group rows are present in all applicable outputs.
- Confirm diagnostic fitting rows contain no duplicate descriptor/type pair.

## Empty-well QC

- Confirm empty wells are not counted as unknowns.
- Verify count, distinct rows, distinct columns, coverage fractions, robust SD, P10/P90 span, and spatial correlations.
- Verify sparse one-dimensional coverage produces `available_insufficient` rather than a global `pass`.
- Verify channel-level screening wording is not confused with the overall plate-QC state.
- Confirm QC remains separate from concentration calculations and ranking unless a future validated integration is introduced.

## Workbook and text integrity

- Search for Excel errors such as `#REF!`, `#DIV/0!`, `#VALUE!`, `#NAME?`, and `#N/A`.
- Check sheet headers, row counts, and duplicate rows.
- Confirm captions describe only artifacts and metrics actually present in the run.
- Avoid fixed sheet-number references in text because sheet numbering is dynamic.

## Figure checks

- Confirm each figure consumes the same structured values used by the workbooks and JSON.
- Verify panel applicability, clipping, reference bands, error bars, out-of-scale markers, labels, legends, and margins.
- Verify no individual-well result is promoted into a group-only primary figure.

## Remaining broader audit areas

- Additional Python workflows and edge cases not yet tested with matched packages
- Image input and QC across additional devices and acquisition conditions
- Automatic/assisted geometry detection across non-8×12 configured grids
- Background-model and ROI behavior across additional plates
- Configurator behavior outside the audited persistence paths
- Epsilon/path-length quantification, which is not yet implemented in the browser configurator
- Exact historical figure-style and workbook-layout identity where that level of parity is required
