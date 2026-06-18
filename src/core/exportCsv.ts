import type { CalibrationFit, StandardAdditionFit, WellConfig } from '../types/plateMap';
import type { MethodMetadata, WellMeasurement } from '../types/results';
import type { UnknownConcentrationResult } from '../types/storedCalibration';

const MISSING_VALUE = '—';

const WELL_CSV_HEADERS = [
  'Well',
  'Row',
  'Column',
  'Plate map role',
  'Sample ID',
  'Dilution factor',
  'Added concentration',
  'Nominal concentration',
  'Group key used for standard addition',
  'Include in calibration?',
  'Include in standard addition?',
  'Include in blank?',
  'ROI pixels',
  'BG pixels',
  'ROI mode',
  'ROI pixel statistics mode',
  'ROI full pixels',
  'ROI core pixels',
  'ROI used pixels',
  'ROI used fraction',
  'ROI trim dark q',
  'ROI trim bright q',
  'ROI statistics warning',
  'Floor geometry available',
  'Floor radius used',
  'Mouth radius used',
  'Background model',
  'Background actual model used',
  'Background candidate pixels',
  'Background accepted samples',
  'Background mask algorithm',
  'Background fallback/warning',
  'Geometry A1 mismatch px',
  'Geometry A12 mismatch px',
  'Geometry H12 mismatch px',
  'Geometry H1 mismatch px',
  'Geometry alignment warning',
  'Well R',
  'Well G',
  'Well B',
  'BG R',
  'BG G',
  'BG B',
  'PAbs_R_raw',
  'PAbs_G_raw',
  'PAbs_B_raw',
  'PAbs_R_corrected',
  'PAbs_G_corrected',
  'PAbs_B_corrected',
  'Correction applied',
  'Correction source/metadata',
  'Warnings',
];
const CALIBRATION_CSV_HEADERS = [
  'Channel',
  'Slope',
  'Intercept',
  'R2',
  'N',
  'Correction applied',
  'S0',
  'Mean clip delta',
];
const STANDARD_ADDITION_CSV_HEADERS = [
  'ROI mode',
  'ROI pixel statistics mode',
  'Background model',
  'Background actual model used',
  'Background mask algorithm',
  'Correction applied',
  'Stored calibration source/method metadata',
  'Sample ID',
  'Dilution factor',
  'Channel',
  'Slope',
  'Intercept',
  'R2',
  'Concentration in original sample',
  'Internal calibration slope',
  'Internal slope agreement',
  'Stored calibration slope',
  'Stored slope agreement',
  'Stored-calibration corrected concentration in original sample',
  'Stored-calibration corrected concentration source',
  'Stored-calibration corrected concentration warning',
  'Fit correction applied',
  'S0',
  'Mean clip delta',
  'Warnings',
  'N',
  'Concentration in diluted sample',
  'Number of wells used',
  'Wells used',
  'Added concentrations used',
  'Mean signal values used for fit',
  'Replicates per added concentration',
  'Fit x min',
  'Fit x max',
  'Fit y min',
  'Fit y max',
  'Fit warning',
  'Signal source column used for fit',
  'Robust diagnostic enabled/available',
  'Suspected outlier added concentrations',
  'Suspected outlier wells',
  'Number of levels used in robust diagnostic fit',
  'Added concentrations used in robust diagnostic fit',
  'Mean signal values used in robust diagnostic fit',
  'Robust diagnostic slope',
  'Robust diagnostic intercept',
  'Robust diagnostic R2',
  'Robust diagnostic concentration in original sample',
  'Robust diagnostic warning',
];
const UNKNOWN_RESULTS_CSV_HEADERS = [
  'Well',
  'Row',
  'Col',
  'Sample ID',
  'Dilution factor',
  'Channel',
  'PAbs raw',
  'PAbs corrected',
  'Correction applied',
  'S0',
  'Clip delta',
  'Stored calibration slope',
  'Stored calibration intercept',
  'Concentration in diluted sample',
  'Concentration in original sample',
  'Warnings',
];

function escapeCsvValue(value: string | number): string {
  const text = String(value);

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function formatRgb(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : MISSING_VALUE;
}

function formatPAbs(value: number): string {
  return Number.isFinite(value) ? value.toPrecision(6) : MISSING_VALUE;
}

function formatFitNumber(value: number): string {
  return Number.isFinite(value) ? value.toPrecision(6) : MISSING_VALUE;
}

function formatText(value: string): string {
  return value.trim() === '' ? MISSING_VALUE : value;
}

function formatStoredCalibrationMethodMetadata(sourceName: string | undefined, metadata: MethodMetadata | undefined): string {
  const source = sourceName && sourceName.trim() !== '' ? `source=${sourceName}` : null;

  if (!metadata) {
    return [source, 'Stored calibration has limited method metadata.'].filter((part): part is string => Boolean(part)).join('; ');
  }

  return [
    source,
    `roi=${metadata.roiMode}`,
    `roiStats=${metadata.roiPixelStatisticsMode}`,
    `background=${metadata.backgroundModel}`,
    `actual=${metadata.backgroundActualModel ?? 'pending'}`,
    `mask=${metadata.backgroundMaskAlgorithm ?? MISSING_VALUE}`,
    `correction=${metadata.correctionApplied ? 'yes' : 'no'}`,
    metadata.correctionSource ? `correctionSource=${metadata.correctionSource}` : null,
  ].filter((part): part is string => Boolean(part)).join('; ');
}

function formatNumberList(values: number[] | undefined): string {
  if (!values || values.length === 0) {
    return MISSING_VALUE;
  }

  return values.map((value) => formatFitNumber(value)).join('|');
}

function formatTextList(values: string[] | undefined): string {
  if (!values || values.length === 0) {
    return MISSING_VALUE;
  }

  return values.join('|');
}

function standardAdditionGroupKey(well: WellConfig | undefined): string {
  if (!well || well.role !== 'A' || well.sampleId.trim() === '') {
    return '';
  }

  const dilutionFactor = Number.isFinite(well.dilutionFactor) ? well.dilutionFactor : 1;
  return `${well.sampleId.trim()}|DF=${dilutionFactor}`;
}

function downloadCsv(csv: string, fileName: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function wellMeasurementsToCsv(
  measurements: WellMeasurement[],
  correctedMeasurements: WellMeasurement[] = [],
  correctionApplied = false,
  plateMap: WellConfig[] = [],
  correctionSourceMetadata = '',
): string {
  const correctedByWell = new Map(correctedMeasurements.map((measurement) => [measurement.wellId, measurement]));
  const plateMapByWell = new Map(plateMap.map((well) => [well.wellId, well]));
  const rows = measurements.map((measurement) => {
    const well = plateMapByWell.get(measurement.wellId);
    const concentration = well?.concentration ?? null;

    return [
      measurement.wellId,
      measurement.row,
      measurement.col,
      well?.role ?? 'EMPTY',
      well?.sampleId ?? '',
      formatFitNumber(well?.dilutionFactor ?? Number.NaN),
      well?.role === 'A' ? formatFitNumber(concentration ?? Number.NaN) : MISSING_VALUE,
      concentration === null ? MISSING_VALUE : formatFitNumber(concentration),
      standardAdditionGroupKey(well),
      well?.role === 'C' ? 'yes' : 'no',
      well?.role === 'A' ? 'yes' : 'no',
      well?.role === 'EMPTY' ? 'yes' : 'no',
      measurement.roiPixels,
      measurement.bgPixels,
      measurement.roiMode ?? 'simple',
      measurement.roiPixelStatisticsMode ?? 'simple-median',
      measurement.roiFullPixels ?? measurement.roiPixels,
      measurement.roiCorePixels ?? measurement.roiPixels,
      measurement.roiUsedPixels ?? measurement.roiPixels,
      formatFitNumber(measurement.roiUsedFraction ?? Number.NaN),
      formatFitNumber(measurement.roiTrimDarkQ ?? Number.NaN),
      formatFitNumber(measurement.roiTrimBrightQ ?? Number.NaN),
      formatText(measurement.roiStatisticsWarning ?? ''),
      measurement.floorGeometryAvailable ? 'yes' : 'no',
      formatFitNumber(measurement.floorRadiusUsed ?? Number.NaN),
      formatFitNumber(measurement.mouthRadiusUsed ?? Number.NaN),
      measurement.backgroundModel,
      measurement.backgroundActualModel ?? measurement.backgroundModel,
      measurement.candidatePixels ?? 0,
      measurement.acceptedSamples ?? measurement.acceptedPixels ?? 0,
      formatText(measurement.backgroundMaskAlgorithm ?? ''),
      formatText(measurement.backgroundWarning ?? ''),
      formatFitNumber(measurement.geometryA1MismatchPx ?? Number.NaN),
      formatFitNumber(measurement.geometryA12MismatchPx ?? Number.NaN),
      formatFitNumber(measurement.geometryH12MismatchPx ?? Number.NaN),
      formatFitNumber(measurement.geometryH1MismatchPx ?? Number.NaN),
      formatText(measurement.geometryAlignmentWarning ?? ''),
      formatRgb(measurement.rgbWell.r),
      formatRgb(measurement.rgbWell.g),
      formatRgb(measurement.rgbWell.b),
      formatRgb(measurement.rgbBackground.r),
      formatRgb(measurement.rgbBackground.g),
      formatRgb(measurement.rgbBackground.b),
      formatPAbs(measurement.pabs.r),
      formatPAbs(measurement.pabs.g),
      formatPAbs(measurement.pabs.b),
      correctionApplied ? formatPAbs(correctedByWell.get(measurement.wellId)?.pabs.r ?? Number.NaN) : MISSING_VALUE,
      correctionApplied ? formatPAbs(correctedByWell.get(measurement.wellId)?.pabs.g ?? Number.NaN) : MISSING_VALUE,
      correctionApplied ? formatPAbs(correctedByWell.get(measurement.wellId)?.pabs.b ?? Number.NaN) : MISSING_VALUE,
      correctionApplied ? 'yes' : 'no',
      formatText(correctionSourceMetadata),
      formatText(measurement.warnings.join('; ')),
    ];
  });

  return [WELL_CSV_HEADERS, ...rows]
    .map((row) => row.map(escapeCsvValue).join(','))
    .join('\r\n');
}

export function calibrationFitsToCsv(fits: CalibrationFit[]): string {
  const rows = fits.map((fit) => [
    fit.channel,
    formatFitNumber(fit.slope),
    formatFitNumber(fit.intercept),
    formatFitNumber(fit.r2),
    fit.n,
    fit.correctionApplied ? 'yes' : 'no',
    formatFitNumber(fit.S0 ?? Number.NaN),
    formatFitNumber(fit.meanClipDelta ?? Number.NaN),
  ]);

  return [CALIBRATION_CSV_HEADERS, ...rows]
    .map((row) => row.map(escapeCsvValue).join(','))
    .join('\r\n');
}

export function standardAdditionFitsToCsv(
  fits: StandardAdditionFit[],
  methodMetadata?: MethodMetadata,
  storedCalibrationMethodMetadata?: MethodMetadata,
  storedCalibrationSourceName?: string,
): string {
  const rows = fits.map((fit) => [
    (fit.methodMetadata ?? methodMetadata)?.roiMode ?? MISSING_VALUE,
    (fit.methodMetadata ?? methodMetadata)?.roiPixelStatisticsMode ?? MISSING_VALUE,
    (fit.methodMetadata ?? methodMetadata)?.backgroundModel ?? MISSING_VALUE,
    (fit.methodMetadata ?? methodMetadata)?.backgroundActualModel ?? MISSING_VALUE,
    (fit.methodMetadata ?? methodMetadata)?.backgroundMaskAlgorithm ?? MISSING_VALUE,
    (fit.methodMetadata ?? methodMetadata)?.correctionApplied ? 'yes' : 'no',
    formatStoredCalibrationMethodMetadata(storedCalibrationSourceName, storedCalibrationMethodMetadata),
    fit.sampleId,
    formatFitNumber(fit.dilutionFactor),
    fit.channel,
    formatFitNumber(fit.slope),
    formatFitNumber(fit.intercept),
    formatFitNumber(fit.r2),
    formatFitNumber(fit.concentrationInOriginalSample),
    formatFitNumber(fit.internalCalibrationSlope ?? Number.NaN),
    formatFitNumber(fit.internalSlopeAgreement ?? Number.NaN),
    formatFitNumber(fit.storedCalibrationSlope ?? Number.NaN),
    formatFitNumber(fit.storedSlopeAgreement ?? Number.NaN),
    formatFitNumber(fit.storedCalibrationCorrectedConcentrationInOriginalSample ?? Number.NaN),
    formatText(fit.storedCalibrationCorrectedConcentrationSource ?? ''),
    formatText(fit.storedCalibrationCorrectedConcentrationWarning ?? ''),
    fit.correctionApplied ? 'yes' : 'no',
    formatFitNumber(fit.S0 ?? Number.NaN),
    formatFitNumber(fit.meanClipDelta ?? Number.NaN),
    formatText(fit.warnings.join('; ')),
    fit.n,
    formatFitNumber(fit.concentrationInDilutedSample),
    fit.wellsUsed?.length ?? fit.n,
    formatTextList(fit.wellsUsed),
    formatNumberList(fit.addedConcentrationsUsed),
    formatNumberList(fit.meanSignalValuesUsed),
    formatTextList(fit.replicatesPerAddedConcentration),
    formatFitNumber(fit.fitXMin ?? Number.NaN),
    formatFitNumber(fit.fitXMax ?? Number.NaN),
    formatFitNumber(fit.fitYMin ?? Number.NaN),
    formatFitNumber(fit.fitYMax ?? Number.NaN),
    formatText(fit.fitDiagnosticWarning ?? ''),
    formatText(fit.signalSourceUsedForFit ?? ''),
    fit.robustDiagnosticAvailable ? 'yes' : 'no',
    formatNumberList(fit.suspectedOutlierAddedConcentrations),
    formatTextList(fit.suspectedOutlierWells),
    formatFitNumber(fit.robustDiagnosticLevelsUsed ?? Number.NaN),
    formatNumberList(fit.robustDiagnosticAddedConcentrationsUsed),
    formatNumberList(fit.robustDiagnosticMeanSignalValuesUsed),
    formatFitNumber(fit.robustDiagnosticSlope ?? Number.NaN),
    formatFitNumber(fit.robustDiagnosticIntercept ?? Number.NaN),
    formatFitNumber(fit.robustDiagnosticR2 ?? Number.NaN),
    formatFitNumber(fit.robustDiagnosticConcentrationInOriginalSample ?? Number.NaN),
    formatText(fit.robustDiagnosticWarning ?? ''),
  ]);

  return [STANDARD_ADDITION_CSV_HEADERS, ...rows]
    .map((row) => row.map(escapeCsvValue).join(','))
    .join('\r\n');
}

export function unknownResultsToCsv(results: UnknownConcentrationResult[]): string {
  const rows = results.map((result) => [
    result.wellId,
    result.row,
    result.col,
    result.sampleId,
    formatFitNumber(result.dilutionFactor),
    result.channel,
    formatPAbs(result.pabsRaw),
    result.correctionApplied ? formatPAbs(result.pabsCorrected) : MISSING_VALUE,
    result.correctionApplied ? 'yes' : 'no',
    formatFitNumber(result.S0),
    formatFitNumber(result.clipDelta),
    formatFitNumber(result.storedCalibrationSlope),
    formatFitNumber(result.storedCalibrationIntercept),
    formatFitNumber(result.concentrationInDilutedSample),
    formatFitNumber(result.concentrationInOriginalSample),
    formatText(result.warnings.join('; ')),
  ]);

  return [UNKNOWN_RESULTS_CSV_HEADERS, ...rows]
    .map((row) => row.map(escapeCsvValue).join(','))
    .join('\r\n');
}

export function downloadWellMeasurementsCsv(
  measurements: WellMeasurement[],
  correctedMeasurements: WellMeasurement[] = [],
  correctionApplied = false,
  plateMap: WellConfig[] = [],
  correctionSourceMetadata = '',
  fileName = 'well_results.csv',
): void {
  const csv = wellMeasurementsToCsv(measurements, correctedMeasurements, correctionApplied, plateMap, correctionSourceMetadata);
  downloadCsv(csv, fileName);
}

export function downloadCalibrationFitsCsv(
  fits: CalibrationFit[],
  fileName = 'calibration_results.csv',
): void {
  downloadCsv(calibrationFitsToCsv(fits), fileName);
}

export function downloadStandardAdditionFitsCsv(
  fits: StandardAdditionFit[],
  methodMetadata?: MethodMetadata,
  storedCalibrationMethodMetadata?: MethodMetadata,
  storedCalibrationSourceName?: string,
  fileName = 'standard_addition_results.csv',
): void {
  downloadCsv(standardAdditionFitsToCsv(fits, methodMetadata, storedCalibrationMethodMetadata, storedCalibrationSourceName), fileName);
}

export function downloadUnknownResultsCsv(
  results: UnknownConcentrationResult[],
  fileName = 'unknown_results.csv',
): void {
  downloadCsv(unknownResultsToCsv(results), fileName);
}
