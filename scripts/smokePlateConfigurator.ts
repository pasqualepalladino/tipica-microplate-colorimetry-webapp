import {
  buildDefaultPlateDefaults,
  buildPlateMapTemplateCsv,
  collectPlateState,
  createFullPlateRegion,
  importPlateMapCsv,
  isFullPlateRegion,
  nominalWellId,
  normalizePlateRegion,
  parseCellEntry,
  rowIndexFromLabel,
  rowLabelFromIndex,
  wellId,
  wellConfigsToPlateEditorState,
} from '../src/core/plateConfigurator.js';
import { reconcileLoadedGeometryFloor } from '../src/core/geometryReconciliation.js';
import {
  FLAT_BOTTOM_PLATE_GEOMETRY_PRESETS,
  getFlatBottomPlateGeometry,
  getFlatBottomPlateGeometryByWellCount,
  getFloorDimensionToPitchRatio,
  getFloorRadiusPx,
  getMeanPitchMm,
  getMouthDiameterToPitchRatio,
  getMouthRadiusPx,
  getPixelsPerMm,
} from '../src/core/physicalPlateGeometry.js';
import { buildVisiblePlateCornerReferences, computeGeometryAlignmentDiagnostics, estimateNominalFloorRadius, estimateNominalMouthRadius, generate96WellFloorCircles, generate96WellGrid, generatePlateFloorCircles, generatePlateGrid, hasFloorGeometry } from '../src/core/plate.js';
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

function assertThrows(fn: () => void, message: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) {
    throw new Error(`${message}. Expected function to throw.`);
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

function testVisiblePlateCornerReferences(): void {
  const sixWell = buildVisiblePlateCornerReferences({
    plateRows: 2,
    plateColumns: 3,
    visibleRows: 2,
    visibleColumns: 3,
    rowOffset: 0,
    columnOffset: 0,
  });
  assertEqual(sixWell.map((reference) => reference.label).join(','), 'A1,A3,B3,B1', '6-well visible corner labels');

  const cropped96 = buildVisiblePlateCornerReferences({
    plateRows: 8,
    plateColumns: 12,
    visibleRows: 2,
    visibleColumns: 4,
    rowOffset: 3,
    columnOffset: 5,
  });
  assertEqual(cropped96.map((reference) => reference.label).join(','), 'A1,A4,B4,B1', 'cropped labels should remain local');

  const cropped384 = buildVisiblePlateCornerReferences({
    plateRows: 16,
    plateColumns: 24,
    visibleRows: 6,
    visibleColumns: 8,
    rowOffset: 2,
    columnOffset: 3,
  });
  assertEqual(cropped384.map((reference) => reference.label).join(','), 'A1,A8,F8,F1', '384 cropped visible corner labels');

  const oneByOne = buildVisiblePlateCornerReferences({
    plateRows: 8,
    plateColumns: 12,
    visibleRows: 1,
    visibleColumns: 1,
    rowOffset: 0,
    columnOffset: 0,
  });
  assertEqual(oneByOne.map((reference) => reference.label).join(','), 'A1', '1x1 should require one reference');

  const oneByFour = buildVisiblePlateCornerReferences({
    plateRows: 8,
    plateColumns: 12,
    visibleRows: 1,
    visibleColumns: 4,
    rowOffset: 0,
    columnOffset: 0,
  });
  assertEqual(oneByFour.map((reference) => reference.label).join(','), 'A1,A4', '1x4 should require two references');

  const fourByOne = buildVisiblePlateCornerReferences({
    plateRows: 8,
    plateColumns: 12,
    visibleRows: 4,
    visibleColumns: 1,
    rowOffset: 0,
    columnOffset: 0,
  });
  assertEqual(fourByOne.map((reference) => reference.label).join(','), 'A1,D1', '4x1 should require two references');
}

function testPlateRegionDefinition(): void {
  const legacy = createFullPlateRegion(8, 12);
  assertEqual(legacy.plateRows, 8, 'legacy plate rows');
  assertEqual(legacy.plateColumns, 12, 'legacy plate columns');
  assertEqual(legacy.visibleRows, 8, 'legacy visible rows');
  assertEqual(legacy.visibleColumns, 12, 'legacy visible columns');
  assertEqual(legacy.rowOffset, 0, 'legacy row offset');
  assertEqual(legacy.columnOffset, 0, 'legacy column offset');
  assert(isFullPlateRegion(legacy), 'legacy region should cover the full plate');
  assertEqual(nominalWellId(legacy, 7, 11), 'H12', 'legacy nominal H12');

  const cropped = normalizePlateRegion({
    plateRows: 16,
    plateColumns: 24,
    visibleRows: 6,
    visibleColumns: 8,
    rowOffset: 2,
    columnOffset: 3,
  });
  assert(!isFullPlateRegion(cropped), 'cropped region should not be full plate');
  assertEqual(nominalWellId(cropped, 0, 0), 'C4', 'cropped first nominal well');
  assertEqual(nominalWellId(cropped, 5, 7), 'H11', 'cropped last nominal well');

  const offsetDefaults = normalizePlateRegion({
    plateRows: 8,
    plateColumns: 12,
    rowOffset: 2,
    columnOffset: 4,
  });
  assertEqual(offsetDefaults.visibleRows, 6, 'offset default visible rows');
  assertEqual(offsetDefaults.visibleColumns, 8, 'offset default visible columns');

  assertThrows(
    () => normalizePlateRegion({ plateRows: 0, plateColumns: 12 }),
    'zero nominal rows should be rejected',
  );
  assertThrows(
    () => normalizePlateRegion({ plateRows: 8, plateColumns: 12, rowOffset: 8 }),
    'row offset outside nominal plate should be rejected',
  );
  assertThrows(
    () => normalizePlateRegion({
      plateRows: 8,
      plateColumns: 12,
      visibleRows: 7,
      rowOffset: 2,
    }),
    'visible row region extending outside nominal plate should be rejected',
  );
  assertThrows(
    () => nominalWellId(cropped, 6, 0),
    'visible row outside cropped region should be rejected',
  );
}

function testGeneratePlateGrid(): void {
  const geometry: PlateGeometry = {
    corner_a1: { x: 10, y: 20 },
    corner_a12: { x: 110, y: 30 },
    corner_h12: { x: 120, y: 90 },
    corner_h1: { x: 20, y: 80 },
  };

  const legacyRegion = createFullPlateRegion(8, 12);
  const genericLegacy = generatePlateGrid(geometry, legacyRegion);
  const wrappedLegacy = generate96WellGrid(geometry);
  assertEqual(genericLegacy.length, 96, 'generic legacy grid well count');
  assertEqual(wrappedLegacy.length, genericLegacy.length, 'legacy wrapper well count');

  for (let index = 0; index < genericLegacy.length; index += 1) {
    const genericWell = genericLegacy[index];
    const wrappedWell = wrappedLegacy[index];
    assertEqual(wrappedWell.wellId, genericWell.wellId, `legacy wrapper wellId ${index}`);
    assertEqual(wrappedWell.row, genericWell.row, `legacy wrapper row ${index}`);
    assertEqual(wrappedWell.col, genericWell.col, `legacy wrapper col ${index}`);
    assertEqual(wrappedWell.x, genericWell.x, `legacy wrapper x ${index}`);
    assertEqual(wrappedWell.y, genericWell.y, `legacy wrapper y ${index}`);
  }

  assertEqual(genericLegacy[0].wellId, 'A1', 'legacy first nominal well');
  assertEqual(genericLegacy[95].wellId, 'H12', 'legacy last nominal well');
  assertEqual(genericLegacy[0].x, geometry.corner_a1.x, 'legacy A1 x');
  assertEqual(genericLegacy[0].y, geometry.corner_a1.y, 'legacy A1 y');
  assertEqual(genericLegacy[11].x, geometry.corner_a12.x, 'legacy A12 x');
  assertEqual(genericLegacy[11].y, geometry.corner_a12.y, 'legacy A12 y');
  assertEqual(genericLegacy[95].x, geometry.corner_h12.x, 'legacy H12 x');
  assertEqual(genericLegacy[95].y, geometry.corner_h12.y, 'legacy H12 y');
  assertEqual(genericLegacy[84].x, geometry.corner_h1.x, 'legacy H1 x');
  assertEqual(genericLegacy[84].y, geometry.corner_h1.y, 'legacy H1 y');

  const croppedRegion = normalizePlateRegion({
    plateRows: 16,
    plateColumns: 24,
    visibleRows: 6,
    visibleColumns: 8,
    rowOffset: 2,
    columnOffset: 3,
  });
  const cropped = generatePlateGrid(geometry, croppedRegion);
  assertEqual(cropped.length, 48, 'cropped grid well count');
  assertEqual(cropped[0].wellId, 'C4', 'cropped first nominal well');
  assertEqual(cropped[0].row, 0, 'cropped first local row');
  assertEqual(cropped[0].col, 0, 'cropped first local column');
  assertEqual(cropped[7].wellId, 'C11', 'cropped first-row last nominal well');
  assertEqual(cropped[8].wellId, 'D4', 'cropped row-major order');
  assertEqual(cropped[47].wellId, 'H11', 'cropped last nominal well');
  assertEqual(cropped[47].row, 5, 'cropped last local row');
  assertEqual(cropped[47].col, 7, 'cropped last local column');
  assertEqual(cropped[0].x, geometry.corner_a1.x, 'cropped upper-left x');
  assertEqual(cropped[7].x, geometry.corner_a12.x, 'cropped upper-right x');
  assertEqual(cropped[47].x, geometry.corner_h12.x, 'cropped lower-right x');
  assertEqual(cropped[40].x, geometry.corner_h1.x, 'cropped lower-left x');

  const beyondZ = generatePlateGrid(geometry, normalizePlateRegion({
    plateRows: 32,
    plateColumns: 48,
    visibleRows: 2,
    visibleColumns: 2,
    rowOffset: 26,
    columnOffset: 0,
  }));
  assertEqual(beyondZ[0].wellId, 'AA1', 'row labels beyond Z');
  assertEqual(beyondZ[3].wellId, 'AB2', 'row labels beyond Z lower-right');

  const full384 = generatePlateGrid(geometry, createFullPlateRegion(16, 24));
  assertEqual(full384.length, 384, 'full 384-well grid count');
  assertEqual(full384[383].wellId, 'P24', 'full 384-well last ID');

  assertThrows(
    () => generatePlateGrid(geometry, {
      plateRows: 8,
      plateColumns: 12,
      visibleRows: 7,
      visibleColumns: 12,
      rowOffset: 2,
      columnOffset: 0,
    }),
    'generatePlateGrid should reject a region outside nominal rows',
  );
}
function testDynamicGeometryHelpers(): void {
  const geometry: PlateGeometry = {
    corner_a1: { x: 10, y: 20 },
    corner_a12: { x: 110, y: 30 },
    corner_h12: { x: 120, y: 90 },
    corner_h1: { x: 20, y: 80 },
    floor_a1_circle_img: { x: 12, y: 22, r: 4 },
    floor_a12_circle_img: { x: 108, y: 32, r: 5 },
    floor_h12_circle_img: { x: 118, y: 88, r: 6 },
    floor_h1_circle_img: { x: 22, y: 78, r: 7 },
  };
  const region = normalizePlateRegion({
    plateRows: 16,
    plateColumns: 24,
    visibleRows: 6,
    visibleColumns: 8,
    rowOffset: 2,
    columnOffset: 3,
  });
  const wells = generatePlateGrid(geometry, region);
  const diagnostics = computeGeometryAlignmentDiagnostics(geometry, wells, region);
  assertEqual(diagnostics.warning, null, 'dynamic geometry diagnostics should match visible corners');

  const floorCircles = generatePlateFloorCircles(geometry, region, null);
  assert(floorCircles !== null, 'dynamic floor circles should be generated');
  assertEqual(floorCircles.length, 48, 'dynamic floor circle count');
  assertEqual(floorCircles[0].x, geometry.floor_a1_circle_img?.x, 'dynamic floor upper-left x');
  assertEqual(floorCircles[7].x, geometry.floor_a12_circle_img?.x, 'dynamic floor upper-right x');
  assertEqual(floorCircles[47].x, geometry.floor_h12_circle_img?.x, 'dynamic floor lower-right x');
  assertEqual(floorCircles[40].x, geometry.floor_h1_circle_img?.x, 'dynamic floor lower-left x');

  const legacyWells = generate96WellGrid(geometry);
  const genericLegacyFloor = generatePlateFloorCircles(geometry, createFullPlateRegion(8, 12), legacyWells);
  const wrappedLegacyFloor = generate96WellFloorCircles(geometry, legacyWells);
  assert(genericLegacyFloor !== null, 'generic legacy floor circles should be generated');
  assert(wrappedLegacyFloor !== null, 'wrapped legacy floor circles should be generated');
  assertEqual(wrappedLegacyFloor.length, genericLegacyFloor.length, 'legacy floor wrapper count');
  for (let index = 0; index < wrappedLegacyFloor.length; index += 1) {
    assertEqual(wrappedLegacyFloor[index].x, genericLegacyFloor[index].x, `legacy floor wrapper x ${index}`);
    assertEqual(wrappedLegacyFloor[index].y, genericLegacyFloor[index].y, `legacy floor wrapper y ${index}`);
    assertEqual(wrappedLegacyFloor[index].r, genericLegacyFloor[index].r, `legacy floor wrapper r ${index}`);
  }

  const preset96 = getFlatBottomPlateGeometry(8, 12);
  assert(preset96 !== null, '96-well preset should exist for floor clamp smoke coverage');
  const oversizedFloorGeometry: PlateGeometry = {
    ...geometry,
    floor_a1_circle_img: { ...geometry.floor_a1_circle_img!, r: 100 },
    floor_a12_circle_img: { ...geometry.floor_a12_circle_img!, r: 100 },
    floor_h12_circle_img: { ...geometry.floor_h12_circle_img!, r: 100 },
    floor_h1_circle_img: { ...geometry.floor_h1_circle_img!, r: 100 },
  };
  const nominalFloorCircles = generatePlateFloorCircles(
    oversizedFloorGeometry,
    createFullPlateRegion(8, 12),
    legacyWells,
    preset96,
  );
  assert(nominalFloorCircles !== null, 'nominal floor circles should be generated');
  for (let index = 0; index < nominalFloorCircles.length; index += 1) {
    const well = legacyWells[index];
    const mouthRadius = estimateNominalMouthRadius(legacyWells, well.row, well.col, preset96);
    assert(nominalFloorCircles[index].r < mouthRadius, `nominal floor radius must remain below mouth radius ${index}`);
  }
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
  assert(!('1_0' in grid), 'invalid type should be skipped so the well remains unconfigured');
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

function testFlatBottomPlateGeometryPresets(): void {
  assertEqual(FLAT_BOTTOM_PLATE_GEOMETRY_PRESETS.length, 7, 'physical preset count');

  const expected = [
    [6, 2, 3, 'Watson'],
    [12, 3, 4, 'Watson'],
    [24, 4, 6, 'Watson'],
    [48, 6, 8, 'Watson'],
    [96, 8, 12, 'Corning'],
    [384, 16, 24, 'Corning'],
    [1536, 32, 48, 'Corning'],
  ] as const;

  for (const [wellCount, rows, columns, source] of expected) {
    const preset = getFlatBottomPlateGeometry(rows, columns);
    assert(preset !== null, `${wellCount}-well preset should exist`);
    assertEqual(preset.wellCount, wellCount, `${wellCount}-well count`);
    assertEqual(preset.sourceManufacturer, source, `${wellCount}-well source`);
    assertEqual(preset.geometryClass, 'flat-bottom', `${wellCount}-well geometry class`);
    assert(preset.pitchXmm > preset.mouthDiameterMm, `${wellCount}-well pitch should exceed mouth diameter`);
    assert(preset.mouthDiameterMm > preset.floorDiameterOrWidthMm, `${wellCount}-well mouth should exceed floor dimension`);
    assert(preset.bottomAreaMm2 > 0, `${wellCount}-well bottom area should be positive`);
    assert(getMouthDiameterToPitchRatio(preset) > 0, `${wellCount}-well mouth ratio`);
    assert(getFloorDimensionToPitchRatio(preset) > 0, `${wellCount}-well floor ratio`);
    assertEqual(getFlatBottomPlateGeometryByWellCount(wellCount)?.key, preset.key, `${wellCount}-well lookup parity`);
  }

  const plate384 = getFlatBottomPlateGeometry(16, 24);
  assert(plate384 !== null, '384-well preset should exist');
  assertEqual(plate384.floorDimensionKind, 'width', '384-well lower dimension is documented as width');
  assertEqual(getFlatBottomPlateGeometry(5, 5), null, 'unsupported layout should not invent a preset');
}

function testNominalPhysicalRuntimeScaling(): void {
  const formats = [[2, 3], [4, 6], [8, 12], [16, 24], [32, 48]] as const;

  for (const [rows, columns] of formats) {
    const preset = getFlatBottomPlateGeometry(rows, columns);
    assert(preset !== null, `${rows}x${columns} runtime preset should exist`);
    const localPitchPx = 180;
    assertEqual(getMeanPitchMm(preset), (preset.pitchXmm + preset.pitchYmm) / 2, `${preset.wellCount}-well mean pitch`);
    assertEqual(getPixelsPerMm(localPitchPx, preset), localPitchPx / getMeanPitchMm(preset), `${preset.wellCount}-well px/mm`);
    assert(getMouthRadiusPx(localPitchPx, preset) > getFloorRadiusPx(localPitchPx, preset), `${preset.wellCount}-well mouth radius should exceed floor radius`);
  }

  const preset96 = getFlatBottomPlateGeometry(8, 12);
  assert(preset96 !== null, '96-well runtime preset should exist');
  const reducedVisibleWells = [
    { wellId: 'A1', row: 0, col: 0, x: 0, y: 0 },
    { wellId: 'A2', row: 0, col: 1, x: 90, y: 0 },
    { wellId: 'B1', row: 1, col: 0, x: 0, y: 90 },
    { wellId: 'B2', row: 1, col: 1, x: 90, y: 90 },
  ];
  assertEqual(estimateNominalMouthRadius(reducedVisibleWells, 0, 0, preset96), getMouthRadiusPx(90, preset96), 'reduced 96-well region mouth radius');
  assertEqual(estimateNominalFloorRadius(reducedVisibleWells, 0, 0, preset96), getFloorRadiusPx(90, preset96), 'reduced 96-well region floor radius');
}

function run(): void {
  testRowLabelFromIndex();
  testRowIndexFromLabel();
  testWellId();
  testVisiblePlateCornerReferences();
  testPlateRegionDefinition();
  testGeneratePlateGrid();
  testDynamicGeometryHelpers();
  testParseCellEntry();
  testCollectPlateStateFallbacks();
  testBuildPlateMapTemplateCsv();
  testImportPlateMapCsv();
  testWellConfigsToPlateEditorState();
  testProjectAfterGeometryPreservesFloorPath();
  testFlatBottomPlateGeometryPresets();
  testNominalPhysicalRuntimeScaling();

  console.log('smoke:plate-configurator passed');
}

run();
