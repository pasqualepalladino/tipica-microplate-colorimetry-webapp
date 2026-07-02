# Python Parity Checklist

This checklist tracks practical comparison work between TIPICA Webapp and the archived Python desktop implementation. The Python desktop implementation remains the reference implementation for the manuscript results.

## Reference files

- Use the Python package source under `tipica-microplate-colorimetry/src/tipica/tipica_core/analyzer.py` as the local source reference.
- Use the archived Python output package, including `RUN_20260529_122854/`, when available.
- Compare against a freshly generated web ZIP from the same image, geometry, plate map, and analysis settings.
- Record any intentional browser differences separately from unresolved parity differences.

## Output structure checks

- Confirm the ZIP contains only the intended `RESULTS/` and `RAW_DATA_DETAILS/` files.
- Confirm no legacy lowercase folders or debug/developer files are present.
- Confirm PNG filenames and workbook filenames match the Python-style package structure.
- Confirm workbook sheet names and sheet order.

## Workbook checks

- Check `RESULTS/<base>_REPORT.xlsx` sheet order, headers, row counts, and cell values.
- Check `RAW_DATA_DETAILS/<base>_DIAGNOSTICS.xlsx` sheet order, headers, row counts, and cell values.
- Verify blank or `NA` cells are used only where the Python output does the same or where the webapp does not yet compute the quantity.
- Confirm explanatory legend rows describe only quantities actually exported by the webapp.

## Numerical checks

- Compare RGB pseudo-absorbance values on common wells.
- Compare replicate aggregation and `n_points` values.
- Compare calibration and standard-addition fitting inputs. Primary RGB calibration and standard-addition fit rows now use the TypeScript port of the Python robust IRLS helper, but full fitting parity still requires every Python fit path and input aggregation path to be covered.
- Compare standard-addition C0 and C0_sd outputs and marker semantics. C0_sd is covariance-propagated only for rewired standard-addition fit rows.
- Compare configurator/project persistence for concentration, type, ID, DF, expected references, unit labels, and row/column priority. Current webapp persistence guards are improved, but full configurator parity remains unclaimed.
- Compare CIELAB/DeltaE descriptors where computed by both implementations.
- Compare background sampling, ROI/core/used-pixel counts, and geometry diagnostics.

## Figure checks

- Confirm each figure consumes the same corrected data structures used by the workbooks.
- Compare figure dimensions and panel structure.
- Compare plotted points, fitted lines, method rows, labels, and captions.
- Document any visual-style differences that are intentionally retained during beta validation.

## Known priority fixes

- `REPORT.xlsx / 04_RAW` row and column parity
- Add Python RAW columns `L`, `a`, `b`, `DeltaL`, `Deltaa`, `Deltab`, `DeltaE_ab`, `DeltaE_ab_chroma`, `ImageWarning` where computed
- Exclude/include wells exactly as Python does
- Full fitting parity across every Python path; Python uses replicate means in calibration where applicable
- Method-comparison row parity including `DeltaE_chroma`, `DeltaE_ab`, `DeltaL`, `Deltaa`, `Deltab`
- Background sample centroid/RGB median/area parity
- ROI/core/used-pixel statistics parity
- Geometry QC and well-bottom diagnostic parity
- Spatial diagnostics `applied` / `not_applied` conditions
- Caption parity
- Figure visual/data parity
