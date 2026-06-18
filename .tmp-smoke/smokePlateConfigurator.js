import { buildDefaultPlateDefaults, buildPlateMapTemplateCsv, collectPlateState, importPlateMapCsv, parseCellEntry, rowIndexFromLabel, rowLabelFromIndex, wellId, } from '../src/core/plateConfigurator';
function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}
function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message}. Expected ${String(expected)}, got ${String(actual)}`);
    }
}
function assertNaN(value, message) {
    if (!Number.isNaN(value)) {
        throw new Error(`${message}. Expected NaN, got ${String(value)}`);
    }
}
function testRowLabelFromIndex() {
    assertEqual(rowLabelFromIndex(0), 'A', 'rowLabelFromIndex(0)');
    assertEqual(rowLabelFromIndex(7), 'H', 'rowLabelFromIndex(7)');
    assertEqual(rowLabelFromIndex(25), 'Z', 'rowLabelFromIndex(25)');
    assertEqual(rowLabelFromIndex(26), 'AA', 'rowLabelFromIndex(26)');
    assertEqual(rowLabelFromIndex(27), 'AB', 'rowLabelFromIndex(27)');
    assertEqual(rowLabelFromIndex(31), 'AF', 'rowLabelFromIndex(31)');
}
function testRowIndexFromLabel() {
    assertEqual(rowIndexFromLabel('A'), 0, 'rowIndexFromLabel(A)');
    assertEqual(rowIndexFromLabel('H'), 7, 'rowIndexFromLabel(H)');
    assertEqual(rowIndexFromLabel('Z'), 25, 'rowIndexFromLabel(Z)');
    assertEqual(rowIndexFromLabel('AA'), 26, 'rowIndexFromLabel(AA)');
    assertEqual(rowIndexFromLabel('AB'), 27, 'rowIndexFromLabel(AB)');
    assertEqual(rowIndexFromLabel('AF'), 31, 'rowIndexFromLabel(AF)');
}
function testWellId() {
    assertEqual(wellId(0, 0), 'A1', 'wellId(0,0)');
    assertEqual(wellId(0, 11), 'A12', 'wellId(0,11)');
    assertEqual(wellId(7, 0), 'H1', 'wellId(7,0)');
    assertEqual(wellId(15, 23), 'P24', 'wellId(15,23)');
}
function testParseCellEntry() {
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
function testCollectPlateStateFallbacks() {
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
        useStoredCalibration: false,
        saveRawDataDetails: false,
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
        useStoredCalibration: false,
        saveRawDataDetails: false,
        expectedRefs: [],
        idDfPriority: 'col',
        extendedView: true,
    });
    const colPriA = colPriority.data.find((d) => d.row === 0 && d.col === 1);
    assert(colPriA !== undefined, 'col-priority data should include row0 col1');
    assertEqual(colPriA.id, 'Col2', 'col-priority should use column ID default');
    assertEqual(colPriA.df, 5, 'col-priority should use column DF default');
}
function testBuildPlateMapTemplateCsv() {
    const csv = buildPlateMapTemplateCsv({}, buildDefaultPlateDefaults(2, 3), 2, 3, 'row');
    const lines = csv.split(/\r?\n/);
    assertEqual(lines[0], 'Well,Conc,Type,ID,DF', 'CSV header');
    assertEqual(lines.length, 1 + 2 * 3, 'CSV should include one row per well plus header');
}
function testImportPlateMapCsv() {
    const csvSemicolon = [
        'Well;Conc;Type;ID;DF',
        'A1;10;C;cal1;2',
        'A2;;UNKNOWN;unk1;3',
        'A3;;UNK;unk2;4',
        'A4;8;X;badType;9',
        'Z99;1;A;outside;1',
    ].join('\n');
    const grid = importPlateMapCsv(csvSemicolon, 2, 3);
    assertEqual(grid['0_0'], '10 C cal1 2', 'import A1 as C');
    assertEqual(grid['0_1'], 'U unk1 3', 'UNKNOWN should normalize to U');
    assertEqual(grid['0_2'], 'U unk2 4', 'UNK should normalize to U');
    assertEqual(grid['1_0'], '8 U badType 9', 'invalid type should normalize to U');
    assert(!('25_98' in grid), 'out-of-range wells should be omitted');
}
function run() {
    testRowLabelFromIndex();
    testRowIndexFromLabel();
    testWellId();
    testParseCellEntry();
    testCollectPlateStateFallbacks();
    testBuildPlateMapTemplateCsv();
    testImportPlateMapCsv();
    console.log('smoke:plate-configurator passed');
}
run();
