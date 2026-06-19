import {
  buildDefaultPlateDefaults,
  buildPlateMapTemplateCsv,
  collectPlateState,
  importPlateMapCsv,
  parseCellEntry,
  rowIndexFromLabel,
  rowLabelFromIndex,
  wellId,
  wellConfigsToPlateEditorState,
} from '../src/core/plateConfigurator.js';
import { reconcileLoadedGeometryFloor } from '../src/core/geometryReconciliation.js';
import { hasFloorGeometry } from '../src/core/plate.js';
import type { PlateGeometry } from '../src/types/geometry.js';
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

function assertNaN(value: number, message: string): void {
  if (!Number.isNaN(value)) {
    throw new Error(`${message}. Expected NaN, got ${String(value)}`);
  }
}

function testRowLabelFromIndex(): void {
  assertEqual(rowLabelFromIndex(0), 'A', 'rowLabelFromIndex(0)');
  assertEqual(rowLabelFromIndex(7), 'H', 'rowLabelFromIndex(7)');
  assertEqual(rowLabelFromIndex(25), 'Z', 'rowLabelFromIndex(25)');
  assertEqual(rowLabelFromIndex(26), 'AA', 'rowLabelFromIndex(26)');
  assertEqual(rowLabelFromIndex(27), 'AB', 'rowLabelFromIndex(27)');
  assertEqual(rowLabelFromIndex(31), 'AF', 'rowLabelFromIndex(31)');
}

function testRowIndexFromLabel(): void {
  assertEqual(rowIndexFromLabel('A'), 0, 'rowIndexFromLabel(A)');
  assertEqual(rowIndexFromLabel('H'), 7, 'rowIndexFromLabel(H)');
  assertEqual(rowIndexFromLabel('Z'), 25, 'rowIndexFromLabel(Z)');
  assertEqual(rowIndexFromLabel('AA'), 26, 'rowIndexFromLabel(AA)');
  assertEqual(rowIndexFromLabel('AB'), 27, 'rowIndexFromLabel(AB)');
  assertEqual(rowIndexFromLabel('AF'), 31, 'rowIndexFromLabel(AF)');
}

function testWellId(): void {
  assertEqual(wellId(0, 0), 'A1', 'wellId(0,0)');
  assertEqual(wellId(0, 11), 'A12', 'wellId(0,11)');
  assertEqual(wellId(7, 0), 'H1', 'wellId(7,0)');
  assertEqual(wellId(15, 23), 'P24', 'wellId(15,23)');
}

function testParseCellEntry(): void {
  const rowIdDefault = 'A';

  assertEqual(parseCellEntry('', rowIdDefault), null, 'parseCellEntry("") returns null');

  const v10 = parseCellEntry('10', rowIdDefault);
  assert(v10 !== null, 'parseCellEntry("10") should parse');
  assertEqual(v10.conc, 10, 'parseCellEntry("10").conc');
  assertEqual(v10.type, 'A', 'parseCellEntry("10").type');
  assertEqual(v10.id, 'A', 'parseCellEntry("10").id');
  assertNaN(v10.df, 'parseCellEntry("10").df');

  const v10A = parseCellEntry('10 A', rowIdDefault);
  assert(v10A !== null, 'parseCellEntry("10 A") should parse');
  assertEqual(v10A.conc, 10, 'parseCellEntry("10 A").conc');
  assertEqual(v10A.type, 'A', 'parseCellEntry("10 A").type');
  assertEqual(v10A.id, 'A', 'parseCellEntry("10 A").id');

  const v10C = parseCellEntry('10 C sample1', rowIdDefault);
  assert(v10C !== null, 'parseCellEntry("10 C sample1") should parse');
  assertEqual(v10C.conc, 10, 'parseCellEntry("10 C sample1").conc');
  assertEqual(v10C.type, 'C', 'parseCellEntry("10 C sample1").type');
  assertEqual(v10C.id, 'sample1', 'parseCellEntry("10 C sample1").id');

  const v10ADF = parseCellEntry('10 A sample1 5', rowIdDefault);
  assert(v10ADF !== null, 'parseCellEntry("10 A sample1 5") should parse');
  assertEqual(v10ADF.conc, 10, 'parseCellEntry("10 A sample1 5").conc');
  assertEqual(v10ADF.type, 'A', 'parseCellEntry("10 A sample1 5").type');
  assertEqual(v10ADF.id, 'sample1', 'parseCellEntry("10 A sample1 5").id');
  assertEqual(v10ADF.df, 5, 'parseCellEntry("10 A sample1 5").df');

  const u = parseCellEntry('U sample1', rowIdDefault);
  assert(u !== null, 'parseCellEntry("U sample1") should parse');
  assertEqual(u.conc, null, 'parseCellEntry("U sample1").conc');
  assertEqual(u.type, 'U', 'parseCellEntry("U sample1").type');
  assertEqual(u.id, 'sample1', 'parseCellEntry("U sample1").id');

  const uDf = parseCellEntry('U sample1 10', rowIdDefault);
  assert(uDf !== null, 'parseCellEntry("U sample1 10") should parse');
  assertEqual(uDf.conc, null, 'parseCellEntry("U sample1 10").conc');
  assertEqual(uDf.type, 'U', 'parseCellEntry("U sample1 10").type');
  assertEqual(uDf.id, 'sample1', 'parseCellEntry("U sample1 10").id');
  assertEqual(uDf.df, 10, 'parseCellEntry("U sample1 10").df');

  const unknown = parseCellEntry('UNKNOWN sample1', rowIdDefault);
  assert(unknown !== null, 'parseCellEntry("UNKNOWN sample1") should parse');
  assertEqual(unknown.conc, null, 'parseCellEntry("UNKNOWN sample1").conc');
  assertEqual(unknown.type, 'U', 'parseCellEntry("UNKNOWN sample1").type');
  assertEqual(unknown.id, 'sample1', 'parseCellEntry("UNKNOWN sample1").id');

  const unk = parseCellEntry('UNK sample1 3', rowIdDefault);
  assert(unk !== null, 'parseCellEntry("UNK sample1 3") should parse');
  assertEqual(unk.conc, null, 'parseCellEntry("UNK sample1 3").conc');
  assertEqual(unk.type, 'U', 'parseCellEntry("UNK sample1 3").type');
  assertEqual(unk.id, 'sample1', 'parseCellEntry("UNK sample1 3").id');
  assertEqual(unk.df, 3, 'parseCellEntry("UNK sample1 3").df');

  const comma = parseCellEntry('1,5 C sample1', rowIdDefault);
  assert(comma !== null, 'parseCellEntry("1,5 C sample1") should parse');
  assertEqual(comma.conc, 1.5, 'parseCellEntry("1,5 C sample1").conc');
  assertEqual(comma.type, 'C', 'parseCellEntry("1,5 C sample1").type');
  assertEqual(comma.id, 'sample1', 'parseCellEntry("1,5 C sample1").id');

  const compact = parseCellEntry('1.5Csample1', rowIdDefault);
  assert(compact !== null, 'parseCellEntry("1.5Csample1") should parse');
  assertEqual(compact.conc, 1.5, 'parseCellEntry("1.5Csample1").conc');
  assertEqual(compact.type, 'C', 'parseCellEntry("1.5Csample1").type');
  assertEqual(compact.id, 'sample1', 'parseCellEntry("1.5Csample1").id');
}

function testCollectPlateStateFallbacks(): void {
  const nrow = 2;
  const ncol = 3;
  const defaults = buildDefaultPlateDefaults(nrow, ncol);
  defaults.rowId[0] = 'RowA';
  defaults.rowDf[0] = '2';
  defaults.colId[1] = 'Col2';
  defaults.colDf[1] = '5';

  const grid = {
    '0_1': '10 A',
    '1_2': 'U sampleU',
  };

  const rowPriority = collectPlateState(grid, defaults, nrow, ncol, {
    unitBase: 'mM',
    unitExp: '0',
    expectedRefs: [],
    idDfPriority: 'row',
    extendedView: true,
  });

  assertEqual(rowPriority.data.length, 2, 'collectPlateState row priority should include only non-empty cells');
  const rowPriA = rowPriority.data.find((d) => d.row === 0 && d.col === 1);
  assert(rowPriA !== undefined, 'row-priority data should include row0 col1');
  assertEqual(rowPriA.id, 'RowA', 'row-priority should use row ID default');
  assertEqual(rowPriA.df, 2, 'row-priority should use row DF default');

  const rowPriU = rowPriority.data.find((d) => d.row === 1 && d.col === 2);
  assert(rowPriU !== undefined, 'row-priority should include unknown cell');
  assertEqual(rowPriU.conc, null, 'unknown concentration should be null after collectPlateState');
  assertEqual(rowPriU.df, 1, 'missing DF should fallback to 1.0 after collectPlateState');
  assert(Number.isFinite(rowPriU.df), 'df should always be finite after collectPlateState fallback');

  const colPriority = collectPlateState(grid, defaults, nrow, ncol, {
    unitBase: 'mM',
    unitExp: '0',
    expectedRefs: [],
    idDfPriority: 'col',
    extendedView: true,
  });

  const colPriA = colPriority.data.find((d) => d.row === 0 && d.col === 1);
  assert(colPriA !== undefined, 'col-priority data should include row0 col1');
  assertEqual(colPriA.id, 'Col2', 'col-priority should use column ID default');
  assertEqual(colPriA.df, 5, 'col-priority should use column DF default');
}

function testBuildPlateMapTemplateCsv(): void {
  const csv = buildPlateMapTemplateCsv({}, buildDefaultPlateDefaults(2, 3), 2, 3, 'row');
  const lines = csv.split(/\r?\n/);

  assertEqual(lines[0], 'Well,Conc,Type,ID,DF', 'CSV header');
  assertEqual(lines.length, 1 + 2 * 3, 'CSV should include one row per well plus header');
}

function testImportPlateMapCsv(): void {
  const csvSemicolon = [
    'Well;Conc;Type;ID;DF',
    'A1;10;C;cal1;2',
    'A2;;UNKNOWN;unk1;3',
    'A3;;UNK;unk2;4',
    'B1;8;X;badType;9',
    'Z99;1;A;outside;1',
  ].join('\n');

  const grid = importPlateMapCsv(csvSemicolon, 2, 3);

  assertEqual(grid['0_0'], '10 C cal1 2', 'import A1 as C');
  assertEqual(grid['0_1'], 'U unk1 3', 'UNKNOWN should normalize to U');
  assertEqual(grid['0_2'], 'U unk2 4', 'UNK should normalize to U');
  assertEqual(grid['1_0'], '8 U badType 9', 'invalid type should normalize to U');
  assert(!('25_98' in grid), 'out-of-range wells should be omitted');
}

function testWellConfigsToPlateEditorState(): void {
  const plateMap: WellConfig[] = [];

  for (let row = 1; row <= 8; row += 1) {
    for (let col = 1; col <= 12; col += 1) {
      const rowLabel = rowLabelFromIndex(row - 1);
      const role = col <= 3 ? 'C' : col <= 6 ? 'A' : 'U';

      plateMap.push({
        wellId: `${rowLabel}${col}`,
        row,
        col,
        role,
        concentration: role === 'U' ? null : col - 1,
        sampleId: row <= 4 ? '1' : '2',
        dilutionFactor: row <= 4 ? 10 : 1,
      });
    }
  }

  // Force a mixed row: row B has non-uniform ID/DF, so defaults must stay fallback.
  const b1 = plateMap.find((well) => well.wellId === 'B1');
  assert(b1 !== undefined, 'B1 should exist');
  b1.sampleId = 'mix';
  b1.dilutionFactor = 3;

  const state = wellConfigsToPlateEditorState(plateMap);

  assertEqual(state.defaults.rowId[0], '1', 'row A ID should be reconstructed from uniform row');
  assertEqual(state.defaults.rowDf[0], '10', 'row A DF should be reconstructed from uniform row');
  assertEqual(state.defaults.rowId[4], '2', 'row E ID should be reconstructed from uniform row');
  assertEqual(state.defaults.rowDf[4], '1', 'row E DF should be reconstructed from uniform row');

  assertEqual(state.defaults.rowId[1], 'B', 'row B ID should remain fallback when row is mixed');
  assertEqual(state.defaults.rowDf[1], '1', 'row B DF should remain fallback when row is mixed');

  assertEqual(state.grid['0_0'], '0 C', 'uniform row defaults should be omitted from cell tokens');
  assertEqual(state.grid['4_0'], '0 C', 'uniform E row defaults should be omitted from cell tokens');
  assertEqual(state.grid['1_0'], '0 C mix 3', 'mixed row should keep explicit cell overrides');
}

function testProjectAfterGeometryPreservesFloorPath(): void {
  const geometryJson: PlateGeometry = {
    corner_a1: { x: 257.44049072265625, y: 299.1071472167969 },
    corner_a12: { x: 1766.3690185546875, y: 296.1309509277344 },
    corner_h12: { x: 1770.8333740234375, y: 1252.9761962890625 },
    corner_h1: { x: 257.44049072265625, y: 1260.4166259765625 },
    floor_a1_circle_img: { x: 285.71429443359375, y: 322.9166564941406, r: 52.65758514404297 },
    floor_a12_circle_img: { x: 1747.0238037109375, y: 318.452392578125, r: 52.31482696533203 },
    floor_h12_circle_img: { x: 1751.488037109375, y: 1247.0238037109375, r: 52.52491760253906 },
    floor_h1_circle_img: { x: 287.202392578125, y: 1250, r: 52.87022399902344 },
  };
  const mouthOnlyProjectGeometry: PlateGeometry = {
    corner_a1: { x: 265.717674970344, y: 303.4373765310154 },
    corner_a12: { x: 1755.6346381969156, y: 305.80798103516395 },
    corner_h12: { x: 1758.0071174377224, y: 1256.4203871987356 },
    corner_h1: { x: 260.9727164887307, y: 1263.5322007111813 },
  };

  const projectAfterGeometry = reconcileLoadedGeometryFloor(
    mouthOnlyProjectGeometry,
    'none',
    geometryJson,
    'json',
    {
      allowApproximateMouthGeometryMatch: true,
      preferCurrentFloorGeometry: true,
    },
  );

  assert(projectAfterGeometry.preservedCurrentPlateGeometry, 'project-after-geometry should preserve floor-capable geometry');
  assert(hasFloorGeometry(projectAfterGeometry.geometry), 'project-after-geometry should keep floor circles available');
  assertEqual(projectAfterGeometry.geometry.corner_a1.x, geometryJson.corner_a1.x, 'project-after-geometry should keep geometry JSON A1 x');
  assertEqual(projectAfterGeometry.floorGeometrySource, 'json', 'project-after-geometry floor source');

  const geometryAfterProject = reconcileLoadedGeometryFloor(
    geometryJson,
    'json',
    mouthOnlyProjectGeometry,
    'none',
  );

  assert(hasFloorGeometry(geometryAfterProject.geometry), 'geometry-after-project should load floor geometry');
  assertEqual(
    geometryAfterProject.geometry.corner_a1.x,
    projectAfterGeometry.geometry.corner_a1.x,
    'both load orders should converge on the same A1 x',
  );
}

function run(): void {
  testRowLabelFromIndex();
  testRowIndexFromLabel();
  testWellId();
  testParseCellEntry();
  testCollectPlateStateFallbacks();
  testBuildPlateMapTemplateCsv();
  testImportPlateMapCsv();
  testWellConfigsToPlateEditorState();
  testProjectAfterGeometryPreservesFloorPath();

  console.log('smoke:plate-configurator passed');
}

run();
