# DQ Colorimetry Webapp Beta

React + TypeScript + Vite client-side beta prototype for digital quantitative colorimetry on 96-well microplates.

## Current Beta Features

- Image and geometry JSON loading
- Manual four-corner picking and geometry JSON export
- ROI overlay for 96-well microplates
- RGB/PAbs extraction
- Plate map editing and example maps
- Calibration fitting from wells marked `C`
- Standard-addition fitting from wells marked `A`
- Stored/external calibration JSON import/export
- RGB low-signal correction
- Internal and stored slope agreement reporting
- Unknown concentration projection from stored calibration
- CSV/JSON export
- Workflow guide, validation checklist, release-readiness summary, and About/Cite text

## Local Installation

```bash
npm install
npm run dev
```

Open the local Vite URL shown in the terminal.

## Build

```bash
npm run build
```

## Deployment

This beta can be deployed as a static client-side app using GitHub Pages, Netlify, or Vercel. No backend is required.

## Basic Workflow

1. Load a plate image.
2. Load a geometry JSON or pick four corners manually.
3. Check the ROI overlay.
4. Run RGB/PAbs extraction.
5. Load or edit the plate map.
6. Run fitting.
7. Export CSV/JSON results.

## Demo examples

This beta includes guided demo helper cards for the three validation workflows used in the release checklist. Each card provides a quick way to load the matching preset plate map and shows the required image, geometry, and stored calibration files.

- Piastra 70: internal calibration + standard addition
- Calibration Purple: stored calibration source
- SAM 100_50: standard addition with stored calibration

Use the demo cards to load a preset map, then select or manually pick the matching image/geometry files.

## Validation Workflows

### Workflow 1: Piastra 70 internal calibration + standard addition

1. Load `Piastra 70.JPG`.
2. Load `Piastra 70_4corner_wells.json`.
3. Run RGB/PAbs extraction.
4. Load the Piastra 70 example map.
5. Run fitting.

Expected:

- 96 well results
- Calibration fits for R/G/B
- Standard-addition fits for R/G/B
- Internal slope agreement populated
- Blue channel concentration in original sample approximately in the 220-240 mM range

### Workflow 2: Calibration Purple stored calibration

1. Load `Calibration Purple.jpg`.
2. Load `Calibration Purple_4corner_wells.json`.
3. Run RGB/PAbs extraction.
4. Load the Calibration Purple example map.
5. Run fitting.
6. Save current calibration JSON.

Expected:

- Stored calibration JSON version 2
- Corrections section present
- R/G/B calibration fits present

### Workflow 3: SAM 100_50 external calibration

1. Load `SAM 100_50.JPG`.
2. Load the correct SAM geometry JSON or pick four corners manually.
3. Run RGB/PAbs extraction.
4. Load the SAM 100_50 example map.
5. Load the stored calibration JSON generated from Calibration Purple.
6. Run fitting.

Expected:

- Standard-addition fits for R/G/B
- Stored calibration slope populated
- Stored slope agreement populated

When an external stored calibration is loaded, the webapp additionally reports a stored-calibration corrected standard-addition concentration computed as DF × intercept / stored calibration slope. This does not replace the ordinary standard-addition fit result.

## Scientific Limitations

This beta web application is a simplified browser demonstration. It does not include CIELAB/DeltaE, advanced QC, diagnostics workbooks, server upload, or backend processing.

The manuscript analyses used the full Python implementation, not this beta webapp.

The beta currently supports 96-well plates only.

The beta currently supports RGB PAbs descriptors only.

The full diagnostic workbook, advanced QC, CIELAB/DeltaE, and full Python-equivalent background model are not yet included.

The RGB low-signal correction keeps raw PAbs values unchanged and creates corrected PAbs values for fitting only when the checkbox is enabled.

Saved stored calibration JSON uses version 2 and includes correction metadata when correction metadata is available. Version 1 stored calibration JSON files still load and behave without corrections.

## Privacy

All processing is performed locally in the browser. Uploaded images, geometry files, plate maps, and results are not sent to any server by this beta application.

## About/Cite

Developed by Pasquale Palladino

Pre-publication beta version. This web application is a simplified demonstration of the digital quantitative colorimetry workflow developed by Pasquale Palladino. The analyses reported in the associated manuscript were performed using the full Python implementation described in the Methods and Supplementary Information. The web version is intended for preliminary evaluation and will be updated with complete functionality and citation details upon publication.

In the associated scientific work, digital images and plate-reader measurements were obtained from the same physical microplates. Therefore, RGB-derived outputs and reference optical measurements refer to the same calibration and analytical wells, avoiding variability from independently prepared replicate plates.
