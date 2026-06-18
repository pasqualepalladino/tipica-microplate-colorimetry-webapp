/**
 * Python plate configurator parity utilities.
 *
 * Source of truth: reference_python/ui_plate_config.py
 *
 * Implements the exact data contract of the Python PlateLayoutUI class.
 * Does not modify the existing WellConfig[] fitting/export pipeline.
 */

import type { WellConfig } from '../types/plateMap';

// ---------------------------------------------------------------------------
// Plate formats  (Python PLATE_FORMATS dict)
// ---------------------------------------------------------------------------

export const PLATE_FORMATS = {
  '6-well (2 x 3)': [2, 3],
  '12-well (3 x 4)': [3, 4],
  '24-well (4 x 6)': [4, 6],
  '48-well (6 x 8)': [6, 8],
  '96-well (8 x 12)': [8, 12],
  '384-well (16 x 24)': [16, 24],
  '1536-well (32 x 48)': [32, 48],
} as const;

export type PlateFormatLabel = keyof typeof PLATE_FORMATS;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlateCellType = 'C' | 'A' | 'U';

/**
 * A single configured well from the Python plate configurator data dict.
 * Row and col are zero-based, matching Python _collect_current_state which
 * uses (r, c) zero-based tuple keys.
 */
export interface WellData {
  row: number;          // zero-based
  col: number;          // zero-based
  conc: number | null;  // null when type is U (Python uses NaN)
  type: PlateCellType;
  df: number;           // always finite; 1.0 fallback applied
  id: string;           // never empty; row-label fallback applied
}

export type PlateData = WellData[];

export interface ExpectedRef {
  refId: string;
  label: string;
  value: number;       // always finite
  sd: number | null;   // null when not provided
}

/**
 * Row/column default strings held by the plate configurator UI.
 * All keys are zero-based indices.  Missing entries fall back to Python
 * natural defaults: rowDf "1", rowId row-label, colDf "", colId str(col+1).
 */
export interface PlateDefaults {
  rowDf: Record<number, string>;
  rowId: Record<number, string>;
  colDf: Record<number, string>;
  colId: Record<number, string>;
}

/**
 * Cell text grid.  Key format: `${row}_${col}` (zero-based indices).
 */
export type CellGrid = Record<string, string>;

/**
 * Complete state produced by Python _collect_current_state.
 */
export interface PlateConfigState {
  unit: string;
  unitBase: string;
  unitExp: string;
  nrow: number;
  ncol: number;
  plateFormat: PlateFormatLabel;
  data: PlateData;
  expectedRefs: ExpectedRef[];
  useBackgroundSubtraction: true;
  initialImageQcEnabled: true;
  blankMode: 'both';
  idDfPriority: 'row' | 'col';
  extendedView: boolean;
}

export interface PlateEditorState {
  grid: CellGrid;
  defaults: PlateDefaults;
  nrow: number;
  ncol: number;
}

// ---------------------------------------------------------------------------
// Row label utilities  (Python _row_label_from_index / _row_index_from_label)
// ---------------------------------------------------------------------------

/**
 * Base-26 alphabetic row label from zero-based index.
 * 0 → "A", 25 → "Z", 26 → "AA", 701 → "ZZ", 702 → "AAA", ...
 * Matches Python _row_label_from_index.
 */
export function rowLabelFromIndex(idx: number): string {
  let i = Math.floor(idx);
  let label = '';
  for (;;) {
    const rem = i % 26;
    label = String.fromCharCode(65 + rem) + label;
    i = Math.floor(i / 26);
    if (i === 0) break;
    i -= 1;
  }
  return label;
}

/**
 * Zero-based row index from alphabetic label ("A" → 0, "Z" → 25, "AA" → 26).
 * Non-alphabetic characters are stripped before parsing.
 * Throws on empty label.
 * Matches Python _row_index_from_label.
 */
export function rowIndexFromLabel(label: string): number {
  const s = label.trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (!s) throw new Error(`Invalid row label: "${label}"`);
  let out = 0;
  for (const ch of s) {
    out = out * 26 + (ch.charCodeAt(0) - 64); // A = 1
  }
  return out - 1;
}

// ---------------------------------------------------------------------------
// Well ID
// ---------------------------------------------------------------------------

/**
 * Well ID string from zero-based row and col.
 * wellId(0, 0) → "A1", wellId(7, 11) → "H12"
 */
export function wellId(row: number, col: number): string {
  return `${rowLabelFromIndex(row)}${col + 1}`;
}

// ---------------------------------------------------------------------------
// Unit label  (Python unit label construction in _collect_current_state)
// ---------------------------------------------------------------------------

/**
 * Build unit label from base unit and exponent string.
 * exp "" or "0" → just base; otherwise base + " 10^" + exp.
 * Matches Python: unit if exp in ("", "0") else f"{unit} 10^{exp}"
 */
export function buildUnitLabel(base: string, exp: string): string {
  const e = exp.trim();
  if (e === '' || e === '0') return base;
  return `${base} 10^${e}`;
}

/**
 * Inverse of buildUnitLabel.
 */
export function parseUnitLabel(label: string): { base: string; exp: string } {
  const sep = ' 10^';
  const idx = label.indexOf(sep);
  if (idx >= 0) {
    return { base: label.slice(0, idx), exp: label.slice(idx + sep.length) };
  }
  return { base: label, exp: '0' };
}

// ---------------------------------------------------------------------------
// Cell token normalizer  (Python _normalize_cell_tokens)
// ---------------------------------------------------------------------------

const TYPE_SET = new Set(['U', 'UNK', 'UNKNOWN', 'C', 'A']);

function isTypeToken(s: string): boolean {
  return TYPE_SET.has(s.toUpperCase());
}

/**
 * Regex: number immediately followed by a type alias, optionally followed by
 * more text.  Ordering: UNKNOWN > UNK > U so longer matches win.
 * Commas are accepted as decimal separators in the number part.
 */
const NUM_THEN_TYPE_RE =
  /^([+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+))(UNKNOWN|UNK|U|C|A)(.*)$/i;

/**
 * Regex: type alias immediately followed by non-whitespace text (no space
 * before the tail).  Requires at least one trailing character so bare "C",
 * "A", "U" tokens fall through to plain push.
 */
const TYPE_THEN_TEXT_RE = /^(UNKNOWN|UNK|U|C|A)(.+)$/i;

/**
 * Tokenize a cell entry string, splitting concatenated number+type pairs
 * (e.g. "1.5Csample1" → ["1.5", "C", "sample1"]).
 * Comma decimal separators are preserved in numeric tokens; callers must
 * replace "," → "." when parsing to float.
 * Matches Python _normalize_cell_tokens exactly.
 */
export function normalizeCellTokens(text: string): string[] {
  const raw = text.trim().split(/\s+/).filter((t) => t.length > 0);
  const out: string[] = [];

  for (const tok of raw) {
    const mNum = NUM_THEN_TYPE_RE.exec(tok);
    if (mNum) {
      out.push(mNum[1]);
      out.push(mNum[2].toUpperCase());
      const tail = (mNum[3] ?? '').trim();
      if (tail) out.push(tail);
      continue;
    }

    // Preserve standalone type tokens exactly (U / UNK / UNKNOWN / C / A).
    // Without this guard, tokens like "UNKNOWN" can be mis-split by the
    // concatenated type+text regex as "UNK" + "NOWN".
    if (isTypeToken(tok)) {
      out.push(tok.toUpperCase());
      continue;
    }

    const mType = TYPE_THEN_TEXT_RE.exec(tok);
    if (mType) {
      out.push(mType[1].toUpperCase());
      const tail = mType[2].trim();
      if (tail) out.push(tail);
      continue;
    }

    out.push(tok);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Cell entry parser  (Python _parse_cell_entry + _split_override_id_df_tokens)
// ---------------------------------------------------------------------------

function looksLikeNumber(token: string): boolean {
  const s = token.trim().replace(',', '.');
  return s.length > 0 && Number.isFinite(Number(s));
}

/**
 * Extract trailing override ID and DF from a token list.
 * If the last token is numeric it becomes override DF (NaN otherwise).
 * Matches Python _split_override_id_df_tokens.
 */
function splitOverrideIdDf(tokens: string[]): { id: string; df: number } {
  let df = Number.NaN;
  let rest = [...tokens];

  if (rest.length > 0 && looksLikeNumber(rest[rest.length - 1])) {
    df = Number(rest[rest.length - 1].replace(',', '.'));
    rest = rest.slice(0, -1);
  }

  const id = rest
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .join(' ');
  return { id, df };
}

/**
 * Parse a single cell entry string into its constituent fields.
 *
 * Returns null for empty or unparseable cells.
 * The returned df may be NaN — callers must resolve it via getDefaultIdDf.
 * The returned id uses rowIdDefault when no cell-level ID override is present.
 *
 * Matches Python _parse_cell_entry.
 *
 * Accepted examples:
 *   "10"               → { conc:10,   type:"A", id:rowIdDefault, df:NaN }
 *   "10 A"             → { conc:10,   type:"A", id:rowIdDefault, df:NaN }
 *   "10 C sample1"     → { conc:10,   type:"C", id:"sample1",    df:NaN }
 *   "10 A sample1 5"   → { conc:10,   type:"A", id:"sample1",    df:5   }
 *   "U sample1"        → { conc:null, type:"U", id:"sample1",    df:NaN }
 *   "U sample1 10"     → { conc:null, type:"U", id:"sample1",    df:10  }
 *   "UNKNOWN sample1"  → { conc:null, type:"U", id:"sample1",    df:NaN }
 *   "1.5Csample1"      → { conc:1.5,  type:"C", id:"sample1",    df:NaN }
 *   "1,5C"             → { conc:1.5,  type:"C", id:rowIdDefault, df:NaN }
 */
export function parseCellEntry(
  text: string,
  rowIdDefault: string,
): { conc: number | null; type: PlateCellType; id: string; df: number } | null {
  const tokens = normalizeCellTokens(text);
  if (tokens.length === 0) return null;

  const first = tokens[0].toUpperCase();

  // U / UNK / UNKNOWN → unknown sample, no concentration
  if (first === 'U' || first === 'UNK' || first === 'UNKNOWN') {
    const { id: overId, df: overDf } = splitOverrideIdDf(tokens.slice(1));
    return {
      conc: null,
      type: 'U',
      id: overId || rowIdDefault.trim(),
      df: overDf,
    };
  }

  // First token must be a finite number
  const concNum = Number(tokens[0].replace(',', '.'));
  if (!Number.isFinite(concNum)) return null;

  let type: PlateCellType = 'A'; // Python default type
  let overrideTokens: string[] = [];

  if (tokens.length >= 2) {
    const second = tokens[1].toUpperCase();
    if (second === 'C' || second === 'A') {
      type = second;
      overrideTokens = tokens.slice(2);
    } else if (second === 'U' || second === 'UNK' || second === 'UNKNOWN') {
      type = 'U';
      overrideTokens = tokens.slice(2);
    } else {
      overrideTokens = tokens.slice(1);
    }
  }

  const { id: overId, df: overDf } = splitOverrideIdDf(overrideTokens);
  return {
    conc: concNum,
    type,
    id: overId || rowIdDefault.trim(),
    df: overDf,
  };
}

// ---------------------------------------------------------------------------
// Row/column defaults resolver  (Python _get_default_id_df_for_position)
// ---------------------------------------------------------------------------

function parseOptionalFloat(s: string): number {
  const cleaned = (s ?? '').trim().replace(',', '.');
  if (!cleaned) return Number.NaN;
  const v = Number(cleaned);
  return Number.isFinite(v) ? v : Number.NaN;
}

/**
 * Resolve default ID and DF for a well position from row/column defaults.
 * Always returns a non-empty id and a finite df (1.0 ultimate fallback).
 * Matches Python _get_default_id_df_for_position.
 */
export function getDefaultIdDf(
  row: number,
  col: number,
  defaults: PlateDefaults,
  _nrow: number,
  _ncol: number,
  priority: 'row' | 'col',
): { id: string; df: number } {
  const rowId = (defaults.rowId[row] ?? rowLabelFromIndex(row)).trim();
  const colId = (defaults.colId[col] ?? String(col + 1)).trim();
  const rowDf = parseOptionalFloat(defaults.rowDf[row] ?? '1');
  const colDf = parseOptionalFloat(defaults.colDf[col] ?? '');

  let id: string;
  let df: number;

  if (priority === 'col') {
    id = colId || rowId;
    df = Number.isFinite(colDf) ? colDf : rowDf;
  } else {
    // "row" (Python default)
    id = rowId || colId;
    df = Number.isFinite(rowDf) ? rowDf : colDf;
  }

  // Ultimate fallbacks matching Python
  if (!id) id = rowLabelFromIndex(row) || String(col + 1);
  if (!Number.isFinite(df)) df = 1.0;

  return { id, df };
}

// ---------------------------------------------------------------------------
// Plate defaults factory
// ---------------------------------------------------------------------------

/**
 * Build a PlateDefaults object with Python-equivalent initial values:
 *   rowDf[r]  = "1"
 *   rowId[r]  = row label (A, B, …, AA, …)
 *   colDf[c]  = ""        (no default — NaN when parsed)
 *   colId[c]  = str(c+1)
 */
export function buildDefaultPlateDefaults(nrow: number, ncol: number): PlateDefaults {
  const rowDf: Record<number, string> = {};
  const rowId: Record<number, string> = {};
  const colDf: Record<number, string> = {};
  const colId: Record<number, string> = {};

  for (let r = 0; r < nrow; r++) {
    rowDf[r] = '1';
    rowId[r] = rowLabelFromIndex(r);
  }
  for (let c = 0; c < ncol; c++) {
    colDf[c] = '';
    colId[c] = String(c + 1);
  }

  return { rowDf, rowId, colDf, colId };
}

/** Build an empty cell grid (all cells blank). */
export function buildEmptyCellGrid(): CellGrid {
  return {};
}

function parseFallbackDf(dfText: string): number {
  const parsed = parseOptionalFloat(dfText);
  return Number.isFinite(parsed) ? parsed : 1;
}

function buildCellText(
  well: WellData,
  rowDefaultId: string,
  rowDefaultDf: number,
  includeIdOverride: boolean,
  includeDfOverride: boolean,
): string {
  const tokens: string[] = [];

  if (well.type === 'U' && well.conc === null) {
    tokens.push('U');
  } else {
    tokens.push(well.conc === null ? '0' : String(well.conc));
    tokens.push(well.type);
  }

  if (includeIdOverride && well.id.trim() !== '' && well.id !== rowDefaultId) {
    tokens.push(well.id);
  }

  if (includeDfOverride && Number.isFinite(well.df) && well.df !== rowDefaultDf) {
    tokens.push(String(well.df));
  }

  return tokens.join(' ');
}

/**
 * Reconstruct plate editor state from a WellConfig[] payload.
 *
 * Python-like behavior:
 * - Defaults start from row label / DF=1 and column fallback defaults.
 * - If a row has non-empty wells and all share the same non-empty ID, row ID
 *   default is set to that value.
 * - If a row has non-empty wells and all share the same finite DF, row DF
 *   default is set to that value.
 * - Cell text omits ID/DF tokens when equal to reconstructed row defaults.
 */
export function wellConfigsToPlateEditorState(wells: WellConfig[]): PlateEditorState {
  const data = wellConfigsToPlateData(wells);
  let nrow = 8;
  let ncol = 12;

  for (const well of wells) {
    if (Number.isFinite(well.row)) nrow = Math.max(nrow, Math.floor(well.row));
    if (Number.isFinite(well.col)) ncol = Math.max(ncol, Math.floor(well.col));
  }

  const defaults = buildDefaultPlateDefaults(nrow, ncol);
  const dataByRow = new Map<number, WellData[]>();

  for (const well of data) {
    const rowData = dataByRow.get(well.row);
    if (rowData) {
      rowData.push(well);
    } else {
      dataByRow.set(well.row, [well]);
    }
  }

  const uniformRowId = new Map<number, string>();
  const uniformRowDf = new Map<number, number>();

  for (let row = 0; row < nrow; row += 1) {
    const rowData = dataByRow.get(row) ?? [];

    if (rowData.length === 0) {
      continue;
    }

    const rowIds = rowData
      .map((well) => well.id.trim())
      .filter((id) => id !== '');

    if (rowIds.length === rowData.length) {
      const firstId = rowIds[0];
      if (rowIds.every((id) => id === firstId)) {
        defaults.rowId[row] = firstId;
        uniformRowId.set(row, firstId);
      }
    }

    const rowDfs = rowData.map((well) => well.df);
    if (rowDfs.length === rowData.length && rowDfs.every((df) => Number.isFinite(df))) {
      const firstDf = rowDfs[0];
      if (rowDfs.every((df) => df === firstDf)) {
        defaults.rowDf[row] = String(firstDf);
        uniformRowDf.set(row, firstDf);
      }
    }
  }

  const grid: CellGrid = {};
  for (const well of data) {
    const key = `${well.row}_${well.col}`;
    const rowDefaultId = defaults.rowId[well.row] ?? rowLabelFromIndex(well.row);
    const rowDefaultDf = parseFallbackDf(defaults.rowDf[well.row] ?? '1');
    const hasUniformId = uniformRowId.has(well.row);
    const hasUniformDf = uniformRowDf.has(well.row);

    grid[key] = buildCellText(
      well,
      rowDefaultId,
      rowDefaultDf,
      !hasUniformId,
      !hasUniformDf,
    );
  }

  return {
    grid,
    defaults,
    nrow,
    ncol,
  };
}

// ---------------------------------------------------------------------------
// Collect plate state  (Python _collect_current_state)
// ---------------------------------------------------------------------------

function plateLabelFromDims(nrow: number, ncol: number): PlateFormatLabel {
  for (const label of Object.keys(PLATE_FORMATS) as PlateFormatLabel[]) {
    const dims = PLATE_FORMATS[label];
    if (dims[0] === nrow && dims[1] === ncol) return label;
  }
  return '96-well (8 x 12)';
}

/**
 * Build a PlateConfigState from grid text, row/col defaults, and options.
 * Empty cells and unparseable cells are silently skipped.
 * Dilution factors are resolved against defaults and fall back to 1.0.
 * Matches Python _collect_current_state.
 */
export function collectPlateState(
  grid: CellGrid,
  defaults: PlateDefaults,
  nrow: number,
  ncol: number,
  opts: {
    unitBase: string;
    unitExp: string;
    expectedRefs: ExpectedRef[];
    idDfPriority: 'row' | 'col';
    extendedView: boolean;
  },
): PlateConfigState {
  const data: PlateData = [];

  for (let r = 0; r < nrow; r++) {
    for (let c = 0; c < ncol; c++) {
      const txt = (grid[`${r}_${c}`] ?? '').trim();
      if (!txt) continue;

      const { id: defaultId, df: defaultDf } = getDefaultIdDf(
        r, c, defaults, nrow, ncol, opts.idDfPriority,
      );
      const parsed = parseCellEntry(txt, defaultId);
      if (!parsed) continue;

      const dfFinal = Number.isFinite(parsed.df) ? parsed.df : defaultDf;
      data.push({
        row: r,
        col: c,
        conc: parsed.conc,
        type: parsed.type,
        df: dfFinal,
        id: parsed.id || defaultId,
      });
    }
  }

  return {
    unit: buildUnitLabel(opts.unitBase, opts.unitExp),
    unitBase: opts.unitBase,
    unitExp: opts.unitExp,
    nrow,
    ncol,
    plateFormat: plateLabelFromDims(nrow, ncol),
    data,
    expectedRefs: opts.expectedRefs,
    useBackgroundSubtraction: true,
    initialImageQcEnabled: true,
    blankMode: 'both',
    idDfPriority: opts.idDfPriority,
    extendedView: opts.extendedView,
  };
}

// ---------------------------------------------------------------------------
// Cell tag rebuild  (Python _rebuild_cell_with_tag)
// ---------------------------------------------------------------------------

/**
 * Replace (or insert) the type tag in a cell entry string.
 * The numeric value token and any trailing ID/DF tokens are preserved.
 * Empty cell → returns just the tag string.
 * Matches Python _rebuild_cell_with_tag.
 */
export function rebuildCellWithTag(text: string, tag: PlateCellType): string {
  const tokens = normalizeCellTokens(text);
  if (tokens.length === 0) return tag;

  const first = tokens[0];
  let rest = tokens.slice(1);

  // Remove existing type token at position 1, if present
  if (rest.length > 0 && isTypeToken(rest[0])) {
    rest = rest.slice(1);
  }

  return [first, tag, ...rest]
    .filter((t) => t.trim().length > 0)
    .join(' ');
}

// ---------------------------------------------------------------------------
// Apply tag to row  (Python tag_row)
// ---------------------------------------------------------------------------

function cellHasTagC(text: string): boolean {
  const tokens = normalizeCellTokens(text);
  return tokens.length >= 2 && tokens[1].toUpperCase() === 'C';
}

/**
 * Apply a type tag to all cells in a row, respecting stored-calibration gating.
 *
 *   - tag === "C" && storedCalibrationLoaded → no-op (Python early return).
 *   - Cells already carrying a C tag when storedCalibrationLoaded is true are
 *     skipped (equivalent to Python "disabled" widget state).
 *
 * Returns a new CellGrid (input is not mutated).
 * Matches Python tag_row.
 */
export function applyTagToRow(
  grid: CellGrid,
  row: number,
  ncol: number,
  tag: PlateCellType,
  storedCalibrationLoaded: boolean,
): CellGrid {
  if (tag === 'C' && storedCalibrationLoaded) return grid;

  const next = { ...grid };
  for (let c = 0; c < ncol; c++) {
    const key = `${row}_${c}`;
    const txt = grid[key] ?? '';
    // Skip cells disabled by stored-calibration (those with C tag)
    if (storedCalibrationLoaded && cellHasTagC(txt)) continue;
    next[key] = rebuildCellWithTag(txt, tag);
  }
  return next;
}

// ---------------------------------------------------------------------------
// CSV export  (Python export_plate_map_template_csv)
// ---------------------------------------------------------------------------

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Build a CSV plate map template string.
 * Header: Well,Conc,Type,ID,DF
 * Matches Python export_plate_map_template_csv.
 */
export function buildPlateMapTemplateCsv(
  grid: CellGrid,
  defaults: PlateDefaults,
  nrow: number,
  ncol: number,
  priority: 'row' | 'col',
): string {
  const lines: string[] = ['Well,Conc,Type,ID,DF'];

  for (let r = 0; r < nrow; r++) {
    for (let c = 0; c < ncol; c++) {
      const wId = wellId(r, c);
      const txt = (grid[`${r}_${c}`] ?? '').trim();
      let conc = '';
      let typ = '';
      let id = '';
      let df = '';

      if (txt) {
        const { id: defaultId, df: defaultDf } = getDefaultIdDf(
          r, c, defaults, nrow, ncol, priority,
        );
        const parsed = parseCellEntry(txt, defaultId);
        if (parsed !== null) {
          conc = parsed.conc === null ? '' : String(parsed.conc);
          typ = parsed.type;
          id = parsed.id;
          df = Number.isFinite(parsed.df) ? String(parsed.df) : String(defaultDf);
        }
      }

      lines.push([wId, conc, typ, id, df].map(csvEscape).join(','));
    }
  }

  return lines.join('\r\n');
}

// ---------------------------------------------------------------------------
// CSV import  (Python import_plate_map_csv)
// ---------------------------------------------------------------------------

function parseCsvLine(line: string, delim: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuote = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === delim) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

/**
 * Import a CSV plate map and return a partial cell grid update.
 * Only cells whose well names map to valid positions within [0, nrow) ×
 * [0, ncol) are included; all other wells are silently skipped.
 *
 * Delimiter is auto-detected (comma / semicolon / tab).
 * Type aliases UNKNOWN/UNK → U.  Unrecognised or missing types → U.
 * Required column: Well.
 * Optional columns with aliases:
 *   Conc / Concentration
 *   Type
 *   ID / SampleID / Sample_ID
 *   DF / Dilution / DilutionFactor
 *
 * Matches Python import_plate_map_csv.
 */
export function importPlateMapCsv(
  csvText: string,
  nrow: number,
  ncol: number,
): Partial<CellGrid> {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return {};

  // Auto-detect delimiter: whichever splits the header into the most fields
  const headerRaw = lines[0];
  const byComma = headerRaw.split(',').length;
  const bySemi = headerRaw.split(';').length;
  const byTab = headerRaw.split('\t').length;
  const delim =
    bySemi > byComma && bySemi >= byTab ? ';'
    : byTab > byComma ? '\t'
    : ',';

  const headers = parseCsvLine(headerRaw, delim).map((h) => h.trim());

  function findCol(...names: string[]): number {
    for (const name of names) {
      const idx = headers.findIndex(
        (h) => h.toLowerCase() === name.toLowerCase(),
      );
      if (idx >= 0) return idx;
    }
    return -1;
  }

  const wellIdx = findCol('Well');
  if (wellIdx < 0) return {};

  const concIdx = findCol('Conc', 'Concentration');
  const typeIdx = findCol('Type');
  const idIdx   = findCol('ID', 'SampleID', 'Sample_ID');
  const dfIdx   = findCol('DF', 'Dilution', 'DilutionFactor');

  const result: Partial<CellGrid> = {};

  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i], delim);
    const wellStr = (row[wellIdx] ?? '').trim();
    if (!wellStr) continue;

    const wm = wellStr.match(/^([A-Za-z]+)(\d+)$/);
    if (!wm) continue;

    let r: number;
    let c: number;
    try {
      r = rowIndexFromLabel(wm[1]);
      c = parseInt(wm[2], 10) - 1;
    } catch {
      continue;
    }
    if (r < 0 || r >= nrow || c < 0 || c >= ncol) continue;

    const conc = concIdx >= 0 ? (row[concIdx] ?? '').trim() : '';
    let typ  = typeIdx >= 0 ? (row[typeIdx] ?? '').trim().toUpperCase() : '';
    const id = idIdx   >= 0 ? (row[idIdx]   ?? '').trim() : '';
    const df = dfIdx   >= 0 ? (row[dfIdx]   ?? '').trim() : '';

    // Normalize type — matches Python logic
    if (typ === 'UNKNOWN' || typ === 'UNK') typ = 'U';
    if (typ !== 'C' && typ !== 'A' && typ !== 'U') typ = 'U';

    // Build cell token string — matches Python assembly
    const tokens: string[] = [];
    if (typ === 'U' && !conc) {
      tokens.push('U');
    } else {
      tokens.push(conc || '0');
      tokens.push(typ);
    }
    if (id) tokens.push(id);
    if (df) tokens.push(df);

    result[`${r}_${c}`] = tokens.join(' ');
  }

  return result;
}

// ---------------------------------------------------------------------------
// Expected refs  (Python _collect_expected_refs)
// ---------------------------------------------------------------------------

/**
 * Collect and deduplicate expected reference values from raw string UI entries.
 * Entries with non-finite value are excluded.
 * Duplicate entries (same refId + label + value + sd) are silently skipped.
 * Matches Python _collect_expected_refs.
 */
export function collectExpectedRefs(
  entries: Array<{ refId: string; label: string; value: string; sd: string }>,
): ExpectedRef[] {
  const result: ExpectedRef[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const refId = entry.refId.trim();
    const label = entry.label.trim();
    const value = parseOptionalFloat(entry.value);
    const sd    = parseOptionalFloat(entry.sd);

    if (!Number.isFinite(value)) continue;

    const sdKey = Number.isFinite(sd) ? String(sd) : 'null';
    const dedupKey = `${refId}\0${label}\0${value}\0${sdKey}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    result.push({
      refId,
      label,
      value,
      sd: Number.isFinite(sd) ? sd : null,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// WellConfig compatibility adapters
// ---------------------------------------------------------------------------

/**
 * Convert PlateData to WellConfig[] for the existing fitting/export pipeline.
 * Generates an EMPTY WellConfig entry for every well not present in PlateData.
 * Output row/col are 1-based to match the existing WellConfig convention used
 * by createEmptyPlateMap and the fitting pipeline.
 */
export function plateDataToWellConfigs(
  data: PlateData,
  nrow: number,
  ncol: number,
): WellConfig[] {
  const dataMap = new Map<string, WellData>();
  for (const wd of data) {
    dataMap.set(wellId(wd.row, wd.col), wd);
  }

  const configs: WellConfig[] = [];
  for (let r = 0; r < nrow; r++) {
    for (let c = 0; c < ncol; c++) {
      const wId = wellId(r, c);
      const wd  = dataMap.get(wId);
      if (wd) {
        configs.push({
          wellId: wId,
          row: r + 1,  // 1-based to match WellConfig convention
          col: c + 1,
          role: wd.type,
          concentration: wd.conc,
          sampleId: wd.id,
          dilutionFactor: wd.df,
        });
      } else {
        configs.push({
          wellId: wId,
          row: r + 1,
          col: c + 1,
          role: 'EMPTY',
          concentration: null,
          sampleId: '',
          dilutionFactor: 1,
        });
      }
    }
  }

  return configs;
}

/**
 * Convert existing WellConfig[] to PlateData.
 * EMPTY wells are omitted.
 * Input row/col are expected to be 1-based (WellConfig convention used by
 * createEmptyPlateMap); output row/col are 0-based (WellData convention).
 */
export function wellConfigsToPlateData(wells: WellConfig[]): PlateData {
  const result: PlateData = [];

  for (const w of wells) {
    if (w.role === 'EMPTY') continue;

    result.push({
      row: w.row - 1,  // 1-based → 0-based
      col: w.col - 1,
      conc: w.concentration,
      type: w.role as PlateCellType,
      df: Number.isFinite(w.dilutionFactor) ? w.dilutionFactor : 1.0,
      id: w.sampleId.trim() || rowLabelFromIndex(w.row - 1),
    });
  }

  return result;
}
