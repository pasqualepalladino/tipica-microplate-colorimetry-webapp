import { buildCielabDiagnosticPoints, computeCielabStdAddBetaBias, resolveStoredCalibrationSlopeForCielabDescriptor } from '../src/core/cielab.js';
import { parseStoredCalibrationJson } from '../src/core/storedCalibration.js';

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
});

if (!calibration.cielabReference) {
  throw new Error('Expected parsed stored calibration to include cielabReference');
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
