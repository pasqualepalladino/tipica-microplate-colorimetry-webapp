import { buildCielabDiagnosticPoints, computeCielabStdAddBetaBias, resolveStoredCalibrationSlopeForCielabDescriptor } from '../src/core/cielab.js';
import { buildReliabilityPayload, computeEmptyWellQcStatus, parseStoredCalibrationJson } from '../src/core/storedCalibration.js';

const calibration = parseStoredCalibrationJson({
  channels: {
    Signal_Red: { m: 1, q: 0, R2: 1, n_points: 2 },
    Signal_Green: { m: 1, q: 0, R2: 1, n_points: 2 },
    Signal_Blue: { m: 1, q: 0, R2: 1, n_points: 2 },
    DeltaL: { m: 0.4, q: 0, R2: 1, n_points: 2 },
  },
  selected_channel: 'Signal_Red',
  unit_label: 'mM',
  image_basename: 'demo',
  cielab_reference: {
    L_ref: 70,
    a_ref: 2,
    b_ref: -1,
    source: 'python_bundle',
  },

  empty_well_payload: {
    Red: {
      n: 2,
      mean: 0.1,
      median: 0.1,
      robust_sd: 0.01,
    },
    Green: {
      n: 2,
      mean: 0.2,
      median: 0.2,
      robust_sd: 0.02,
    },
    Blue: {
      n: 2,
      mean: 0.3,
      median: 0.3,
      robust_sd: 0.03,
    },
  },
  empty_well_rows: [
    {
      Row: 'A',
      Col: 1,
      Well: 'A1',
      Signal_Red: 0.1,
      Signal_Green: 0.2,
      Signal_Blue: 0.3,
      UsedFraction: 1,
    },
  ],

});

if (!calibration.cielabReference) {
  throw new Error('Expected parsed stored calibration to include cielabReference');
}
if (!calibration.emptyWellPayload) {
  throw new Error('Expected parsed stored calibration to include emptyWellPayload');
}

if (!calibration.emptyWellRows || calibration.emptyWellRows.length === 0) {
  throw new Error('Expected parsed stored calibration to include emptyWellRows');
}

if (calibration.emptyWellPayload.Red?.robust_sd !== 0.01) {
  throw new Error('Expected parsed stored calibration to preserve Red robust_sd');
}

if (calibration.emptyWellRows[0]?.Signal_Green !== 0.2) {
  throw new Error('Expected parsed stored calibration to preserve empty-well row signals');
}

const emptyQcOk = computeEmptyWellQcStatus(calibration.emptyWellPayload);
if (emptyQcOk.status !== 'ok' || emptyQcOk.n_empty_channels !== 3 || emptyQcOk.empty_robust_sd_median !== 0.02) {
  throw new Error('Expected empty-well QC to match Python ok/median behavior');
}

const emptyQcWatch = computeEmptyWellQcStatus(calibration.emptyWellPayload, [{ Ratio_median: Math.exp(0.15) }]);
if (emptyQcWatch.status !== 'watch') {
  throw new Error('Expected empty-well QC to flag watch for Python drift threshold');
}

const emptyQcWarning = computeEmptyWellQcStatus(calibration.emptyWellPayload, [{ Ratio_median: Math.exp(0.25) }]);
if (emptyQcWarning.status !== 'warning') {
  throw new Error('Expected empty-well QC to flag warning for Python drift threshold');
}

const emptyQcMissing = computeEmptyWellQcStatus(undefined);
if (emptyQcMissing.status !== 'not_available' || emptyQcMissing.n_empty_channels !== 0) {
  throw new Error('Expected empty-well QC to match Python not_available behavior');
}

const reliabilityHigh = buildReliabilityPayload(
  { calibration: 2, unknown: 1 },
  [
    { FitType: 'Calibration', m: 1, UsedFraction: 0.9 },
    { FitType: 'StdAdd', C0: 1.2, UsedFraction: 0.9 },
  ],
  {},
  { status: 'OK', critical_wells: 0, total_wells: 2 },
  emptyQcOk,
  { ranking: [{ Score: 1.0 }, { Score: 0.5 }], best: { Mode: 'available' } },
  { epsilon: 1000, path_length: 0.5, path_length_source: 'configured' },
);
if (
  reliabilityHigh.reliability_score !== 80 ||
  reliabilityHigh.confidence_class !== 'HIGH' ||
  reliabilityHigh.quantification_status !== 'available' ||
  !reliabilityHigh.notes.includes('intraplate calibration present')
) {
  throw new Error('Expected Python reliability payload high-confidence calibration behavior');
}

const reliabilityStoredWarning = buildReliabilityPayload(
  { unknown: 1 },
  [{ FitType: 'UnknownFromCal', C0: 1.2, UsedFraction: 0.9 }],
  { use_stored_calibration: true },
  { status: 'OK', critical_wells: 0, total_wells: 1 },
  emptyQcWarning,
  { ranking: [{ Score: 1.0 }, { Score: 0.95 }], best: { Mode: 'available' } },
  {},
);
if (
  reliabilityStoredWarning.reliability_score !== 14 ||
  reliabilityStoredWarning.confidence_class !== 'LOW' ||
  !reliabilityStoredWarning.reason.includes('stored calibration is less reliable than intraplate calibration') ||
  !reliabilityStoredWarning.reason.includes('empty-well drift indicates limited comparability') ||
  !reliabilityStoredWarning.reason.includes('method ranking is not strongly separated')
) {
  throw new Error('Expected Python reliability payload stored/warning penalties');
}

const reliabilityUnavailable = buildReliabilityPayload(
  { unknown: 1 },
  [],
  {},
  { status: 'OK', critical_wells: 0, total_wells: 1 },
  emptyQcMissing,
  { ranking: [], best: { Mode: 'unavailable' } },
  {},
);
if (
  reliabilityUnavailable.reliability_score !== 15 ||
  reliabilityUnavailable.confidence_class !== 'LOW' ||
  reliabilityUnavailable.quantification_available !== false ||
  reliabilityUnavailable.quantification_status !== 'not available'
) {
  throw new Error('Expected Python reliability payload unknown-only fallback behavior');
}

const storedSlope = resolveStoredCalibrationSlopeForCielabDescriptor('DeltaL', calibration);
if (storedSlope === null || !Number.isFinite(storedSlope)) {
  throw new Error('Expected stored calibration slope lookup to resolve DeltaL');
}

const { beta, biasIndex } = computeCielabStdAddBetaBias(1.2, Number.NaN, storedSlope);
if (beta === null || biasIndex === null || Math.abs(beta - 3) > 1e-12 || Math.abs(biasIndex - 2) > 1e-12) {
  throw new Error(`Expected stored-slope beta/bias fallback to be 3/2 within tolerance, got ${beta}/${biasIndex}`);
}

const measurements = [
  {
    wellId: 'A1',
    row: 0,
    col: 0,
    rgbWell: { r: 200, g: 180, b: 150 },
    rgbBackground: { r: 200, g: 180, b: 150 },
    pabs: { r: 0, g: 0, b: 0 },
    warnings: [],
    roiPixels: 1,
    bgPixels: 0,
    backgroundModel: 'annular' as const,
    roiUsedPixels: 1,
  },
];

const plateMap = [
  { wellId: 'A1', row: 0, col: 0, role: 'A' as const, sampleId: 'S1', concentration: 1, dilutionFactor: 1 },
];

const { points, referenceSource } = buildCielabDiagnosticPoints(measurements, plateMap, calibration.cielabReference);
const firstPoint = points[0];

if (!Number.isFinite(firstPoint.deltaL as number)) {
  throw new Error('Expected stored CIELAB reference to produce finite DeltaL for A wells');
}

if (referenceSource === 'unavailable') {
  throw new Error('Expected stored CIELAB reference to produce a usable reference source');
}

console.log('stored calibration cielab smoke passed');
