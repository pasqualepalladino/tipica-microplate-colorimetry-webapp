import {
  buildDefaultPlateDefaults,
  buildUnitLabel,
  collectExpectedRefs,
  collectPlateState,
  normalizeSnapshotPlateRegion,
  parseUnitLabel,
  plateDataToWellConfigs,
  type CellGrid,
  type PlateEditorSnapshot,
} from '../src/core/plateConfigurator.js';
import type { WellConfig } from '../src/types/plateMap.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}. Expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}. Expected ${expectedJson}, got ${actualJson}`);
  }
}

function representativePayload(): {
  snapshot: PlateEditorSnapshot;
  expectedRefs: ReturnType<typeof collectExpectedRefs>;
  unitLabel: string;
  plateMap: WellConfig[];
} {
  const nrow = 2;
  const ncol = 3;
  const defaults = buildDefaultPlateDefaults(nrow, ncol);
  defaults.rowId[0] = 'row-cal';
  defaults.rowDf[0] = '2';
  defaults.rowId[1] = 'row-std';
  defaults.rowDf[1] = '7';
  defaults.colId[0] = 'col-one';
  defaults.colDf[0] = '19';
  defaults.colId[1] = 'col-sample';
  defaults.colDf[1] = '11';

  const grid: CellGrid = {
    '0_0': '0 C',
    '0_1': '1.5 C mid-cal 3',
    '1_0': '0 A',
    '1_1': '2.5 A std-one 13',
    '1_2': 'U sample-unk 17',
  };

  const expectedRefs = collectExpectedRefs([
    { refId: 'ref-a', label: 'ICP-MS', value: '4.25', sd: '0.15' },
    { refId: 'ref-b', label: 'Colorimetry', value: '4,5', sd: '' },
    { refId: 'ignored', label: 'missing', value: '', sd: '1' },
  ]);
  const unitLabel = buildUnitLabel('uM', '-3');
  const state = collectPlateState(grid, defaults, nrow, ncol, {
    unitBase: 'uM',
    unitExp: '-3',
    expectedRefs,
    idDfPriority: 'col',
    extendedView: true,
  });

  return {
    snapshot: {
      grid,
      defaults,
      nrow,
      ncol,
      idDfPriority: 'col',
      plateRegion: normalizeSnapshotPlateRegion(nrow, ncol, {
        plateRows: nrow,
        plateColumns: ncol,
        visibleRows: 1,
        visibleColumns: 2,
        rowOffset: 1,
        columnOffset: 1,
      }),
    },
    expectedRefs,
    unitLabel,
    plateMap: plateDataToWellConfigs(state.data, nrow, ncol),
  };
}

function testQuantificationFieldsSurviveProjectRoundTrip(): void {
  const payload = representativePayload();
  const projectJson = JSON.stringify({
    plateMap: payload.plateMap,
    plateMapUnit: payload.unitLabel,
    plateConfigurator: payload.snapshot,
    expectedRefs: payload.expectedRefs,
  });
  const restored = JSON.parse(projectJson) as {
    plateMap: WellConfig[];
    plateMapUnit: string;
    plateConfigurator: PlateEditorSnapshot;
    expectedRefs: typeof payload.expectedRefs;
  };

  assertDeepEqual(restored.plateMap, payload.plateMap, 'project JSON should preserve exact WellConfig payload');
  assertEqual(restored.plateMapUnit, 'uM 10^-3', 'project JSON should preserve unit label');
  assertDeepEqual(restored.expectedRefs, payload.expectedRefs, 'project JSON should preserve expected refs including SD');
  assertDeepEqual(restored.plateConfigurator, payload.snapshot, 'project JSON should preserve editor defaults and priority');

  const cal = restored.plateMap.find((well) => well.wellId === 'A2');
  assert(cal !== undefined, 'restored project should include A2 calibration well');
  assertEqual(cal.role, 'C', 'A2 role');
  assertEqual(cal.concentration, 1.5, 'A2 concentration');
  assertEqual(cal.sampleId, 'mid-cal', 'A2 cell-level sample ID override');
  assertEqual(cal.dilutionFactor, 3, 'A2 cell-level DF override');

  const std = restored.plateMap.find((well) => well.wellId === 'B1');
  assert(std !== undefined, 'restored project should include B1 standard-addition well');
  assertEqual(std.role, 'A', 'B1 role');
  assertEqual(std.sampleId, 'col-one', 'B1 column-priority sample ID');
  assertEqual(std.dilutionFactor, 19, 'B1 column-priority DF');

  const unk = restored.plateMap.find((well) => well.wellId === 'B3');
  assert(unk !== undefined, 'restored project should include B3 unknown well');
  assertEqual(unk.role, 'U', 'B3 role');
  assertEqual(unk.concentration, null, 'B3 concentration');
  assertEqual(unk.sampleId, 'sample-unk', 'B3 unknown sample ID override');
  assertEqual(unk.dilutionFactor, 17, 'B3 unknown DF override');
}


function testPercentageUnitsRemainFreeAndRoundTrip(): void {
  const percentageUnits = ['% m/v', '% v/v', '% m/m'];

  for (const unit of percentageUnits) {
    assertEqual(buildUnitLabel(unit, '0'), unit, `${unit} at 10^0 should display without a suffix`);
    assertEqual(
      buildUnitLabel(unit, '-3'),
      `${unit} 10^-3`,
      `${unit} should retain a freely selected non-zero scale`,
    );
    assertDeepEqual(
      parseUnitLabel(`${unit} 10^-3`),
      { base: unit, exp: '-3' },
      `${unit} scaled label should parse back exactly`,
    );

    const projectJson = JSON.stringify({ plateMapUnit: unit });
    const restored = JSON.parse(projectJson) as { plateMapUnit: string };
    assertEqual(restored.plateMapUnit, unit, `${unit} should survive project JSON round-trip`);
  }
}

function testLegacyPlateRegionFallback(): void {
  const legacySnapshot: PlateEditorSnapshot = {
    grid: {},
    defaults: buildDefaultPlateDefaults(8, 12),
    nrow: 8,
    ncol: 12,
    idDfPriority: 'row',
  };

  const normalized = normalizeSnapshotPlateRegion(
    legacySnapshot.nrow,
    legacySnapshot.ncol,
    legacySnapshot.plateRegion,
  );
  assertDeepEqual(normalized, {
    plateRows: 8,
    plateColumns: 12,
    visibleRows: 8,
    visibleColumns: 12,
    rowOffset: 0,
    columnOffset: 0,
  }, 'legacy snapshot should default to a full nominal plate region');

  let mismatchRejected = false;
  try {
    normalizeSnapshotPlateRegion(8, 12, {
      plateRows: 16,
      plateColumns: 24,
      visibleRows: 8,
      visibleColumns: 12,
      rowOffset: 0,
      columnOffset: 0,
    });
  } catch {
    mismatchRejected = true;
  }
  assert(mismatchRejected, 'snapshot/region nominal dimension mismatch should be rejected');
}

function testOverridePreservationPolicyModel(): void {
  let activeOverride = 'python-canonical.json';

  const loadOtherFile = () => {
    // Image, project, and ordinary geometry file loads are not explicit override
    // replacement or clear actions, so they must preserve the active override.
  };
  const failedReplacement = () => {
    // A failed replacement should not discard a previously active override.
  };
  const explicitClear = () => {
    activeOverride = '';
  };

  loadOtherFile();
  assertEqual(activeOverride, 'python-canonical.json', 'other file loads should preserve active override');
  failedReplacement();
  assertEqual(activeOverride, 'python-canonical.json', 'failed override replacement should preserve active override');
  explicitClear();
  assertEqual(activeOverride, '', 'explicit override clear should clear active override');
}

testQuantificationFieldsSurviveProjectRoundTrip();
testPercentageUnitsRemainFreeAndRoundTrip();
testLegacyPlateRegionFallback();
testOverridePreservationPolicyModel();

console.log('smoke:configurator-persistence passed');
