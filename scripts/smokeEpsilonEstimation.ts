import { buildEstimatedEpsilonRows, molarPerDisplayedUnit } from '../src/core/epsilonEstimation';
import type { FlatBottomPlateGeometryPreset } from '../src/core/physicalPlateGeometry';
import type { CalibrationFit } from '../src/types/plateMap';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function closeTo(actual: number, expected: number, tolerance = 1e-9): boolean {
  return Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected));
}

const preset: FlatBottomPlateGeometryPreset = {
  key: '8x12',
  wellCount: 96,
  rows: 8,
  columns: 12,
  displayName: '96-well flat-bottom reference geometry',
  geometryClass: 'flat-bottom',
  sourceManufacturer: 'Corning',
  sourceDocument: 'MicroplateDimensions96-384-1536.pdf',
  sourceProfile: '96 well flat bottom, solid polystyrene',
  vendorSpecific: true,
  footprintLengthMm: 127.8,
  footprintWidthMm: 85.5,
  plateHeightMm: 14.2,
  a1RowOffsetMm: 11.2,
  a1ColumnOffsetMm: 14.3,
  pitchXmm: 9,
  pitchYmm: 9,
  mouthDiameterMm: 6.86,
  floorDiameterOrWidthMm: 6.35,
  floorDimensionKind: 'diameter',
  wellDepthMm: 10.67,
  flangeOrSkirtHeightMm: 6.096,
  wellBottomElevationMm: 3.55,
  bottomThicknessMm: 1.27,
  bottomAreaMm2: 31.65,
  nominalVolumeUl: 360,
  workingVolumeMinUl: null,
  workingVolumeMaxUl: null,
  notes: 'Nominal geometry for smoke testing.',
};

const fits: CalibrationFit[] = [
  { channel: 'R', slope: 0.011204, intercept: 0, r2: 0.99, n: 11 },
  { channel: 'G', slope: 0.004594, intercept: 0, r2: 0.99, n: 11 },
  { channel: 'B', slope: 0.006975, intercept: 0, r2: 0.99, n: 11 },
];

assert(molarPerDisplayedUnit('M') === 1, 'M conversion failed.');
assert(molarPerDisplayedUnit('mM') === 1e-3, 'mM conversion failed.');
assert(molarPerDisplayedUnit('uM 10^-3') === 1e-9, 'Scaled uM conversion failed.');
assert(molarPerDisplayedUnit('% m/v') === null, 'Non-molar unit must not be accepted.');

const rows = buildEstimatedEpsilonRows({
  unitLabel: 'mM',
  liquidVolumeUl: 200,
  nominalPlatePreset: preset,
  calibrationFits: fits,
});

assert(rows.length === 3, 'Expected one epsilon estimate for each PAbs channel.');
const expectedPathLength = 200 / 31.65 / 10;
assert(closeTo(rows[0].EstimatedPathLength_cm, expectedPathLength), 'Path-length calculation failed.');
assert(
  closeTo(rows[0].EstimatedEpsilon_M_1_cm_1, (0.011204 / 1e-3) / expectedPathLength),
  'Epsilon calculation failed.',
);
assert(rows.every((row) => row.ValidationStatus === 'estimated_not_validated'), 'Validation status missing.');
assert(rows.every((row) => Object.values(row).every((value) => value !== '' && value != null)), 'Rows must not contain empty cells.');

assert(buildEstimatedEpsilonRows({
  unitLabel: '% m/v',
  liquidVolumeUl: 200,
  nominalPlatePreset: preset,
  calibrationFits: fits,
}).length === 0, 'Unsupported units must not generate output.');

assert(buildEstimatedEpsilonRows({
  unitLabel: 'mM',
  liquidVolumeUl: null,
  nominalPlatePreset: preset,
  calibrationFits: fits,
}).length === 0, 'Missing volume must not generate output.');

console.log(JSON.stringify({
  result: 'PASS',
  rows,
}, null, 2));
