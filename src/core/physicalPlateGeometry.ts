export type FlatBottomPresetSource = 'Watson' | 'Corning';
export type FloorDimensionKind = 'diameter' | 'width';

export interface FlatBottomPlateGeometryPreset {
  key: string;
  wellCount: number;
  rows: number;
  columns: number;
  displayName: string;
  geometryClass: 'flat-bottom';
  sourceManufacturer: FlatBottomPresetSource;
  sourceDocument: string;
  sourceProfile: string;
  vendorSpecific: true;
  footprintLengthMm: number;
  footprintWidthMm: number;
  plateHeightMm: number | null;
  a1RowOffsetMm: number | null;
  a1ColumnOffsetMm: number | null;
  pitchXmm: number;
  pitchYmm: number;
  mouthDiameterMm: number;
  floorDiameterOrWidthMm: number;
  floorDimensionKind: FloorDimensionKind;
  wellDepthMm: number;
  flangeOrSkirtHeightMm: number | null;
  wellBottomElevationMm: number | null;
  bottomThicknessMm: number | null;
  bottomAreaMm2: number;
  nominalVolumeUl: number;
  workingVolumeMinUl: number | null;
  workingVolumeMaxUl: number | null;
  notes: string;
}

function circularAreaMm2(diameterMm: number): number {
  return Math.PI * (diameterMm / 2) ** 2;
}

const PRESETS: readonly FlatBottomPlateGeometryPreset[] = [
  {
    key: '2x3', wellCount: 6, rows: 2, columns: 3,
    displayName: '6-well flat-bottom reference geometry',
    geometryClass: 'flat-bottom', sourceManufacturer: 'Watson',
    sourceDocument: 'EN_MicroPlate_DimensionTable.pdf',
    sourceProfile: '6 well flat bottom', vendorSpecific: true,
    footprintLengthMm: 127.6, footprintWidthMm: 85.3, plateHeightMm: 20.3,
    a1RowOffsetMm: 23.2, a1ColumnOffsetMm: 24.8,
    pitchXmm: 39.0, pitchYmm: 39.0,
    mouthDiameterMm: 35.5, floorDiameterOrWidthMm: 34.3,
    floorDimensionKind: 'diameter', wellDepthMm: 17.8,
    flangeOrSkirtHeightMm: 2.1, wellBottomElevationMm: 2.5,
    bottomThicknessMm: 1.3, bottomAreaMm2: circularAreaMm2(34.3),
    nominalVolumeUl: 16800, workingVolumeMinUl: null, workingVolumeMaxUl: null,
    notes: 'Nominal Watson flat-bottom reference geometry; verify the actual plate model for quantitative path-length work.',
  },
  {
    key: '3x4', wellCount: 12, rows: 3, columns: 4,
    displayName: '12-well flat-bottom reference geometry',
    geometryClass: 'flat-bottom', sourceManufacturer: 'Watson',
    sourceDocument: 'EN_MicroPlate_DimensionTable.pdf',
    sourceProfile: '12 well flat bottom', vendorSpecific: true,
    footprintLengthMm: 127.6, footprintWidthMm: 85.3, plateHeightMm: 20.6,
    a1RowOffsetMm: 16.4, a1ColumnOffsetMm: 24.5,
    pitchXmm: 26.0, pitchYmm: 26.0,
    mouthDiameterMm: 22.7, floorDiameterOrWidthMm: 22.3,
    floorDimensionKind: 'diameter', wellDepthMm: 17.6,
    flangeOrSkirtHeightMm: 2.2, wellBottomElevationMm: 2.7,
    bottomThicknessMm: 1.4, bottomAreaMm2: circularAreaMm2(22.3),
    nominalVolumeUl: 7000, workingVolumeMinUl: null, workingVolumeMaxUl: null,
    notes: 'Nominal Watson flat-bottom reference geometry; verify the actual plate model for quantitative path-length work.',
  },
  {
    key: '4x6', wellCount: 24, rows: 4, columns: 6,
    displayName: '24-well flat-bottom reference geometry',
    geometryClass: 'flat-bottom', sourceManufacturer: 'Watson',
    sourceDocument: 'EN_MicroPlate_DimensionTable.pdf',
    sourceProfile: '24 well flat bottom', vendorSpecific: true,
    footprintLengthMm: 127.6, footprintWidthMm: 85.3, plateHeightMm: 20.5,
    a1RowOffsetMm: 15.4, a1ColumnOffsetMm: 18.5,
    pitchXmm: 18.0, pitchYmm: 18.0,
    mouthDiameterMm: 15.5, floorDiameterOrWidthMm: 15.1,
    floorDimensionKind: 'diameter', wellDepthMm: 17.5,
    flangeOrSkirtHeightMm: 2.2, wellBottomElevationMm: 2.7,
    bottomThicknessMm: 1.4, bottomAreaMm2: circularAreaMm2(15.1),
    nominalVolumeUl: 3200, workingVolumeMinUl: null, workingVolumeMaxUl: null,
    notes: 'Nominal Watson flat-bottom reference geometry; verify the actual plate model for quantitative path-length work.',
  },
  {
    key: '6x8', wellCount: 48, rows: 6, columns: 8,
    displayName: '48-well flat-bottom reference geometry',
    geometryClass: 'flat-bottom', sourceManufacturer: 'Watson',
    sourceDocument: 'EN_MicroPlate_DimensionTable.pdf',
    sourceProfile: '48 well flat bottom', vendorSpecific: true,
    footprintLengthMm: 127.6, footprintWidthMm: 85.4, plateHeightMm: 20.4,
    a1RowOffsetMm: 10.2, a1ColumnOffsetMm: 18.3,
    pitchXmm: 13.0, pitchYmm: 13.0,
    mouthDiameterMm: 10.6, floorDiameterOrWidthMm: 10.4,
    floorDimensionKind: 'diameter', wellDepthMm: 17.4,
    flangeOrSkirtHeightMm: 2.2, wellBottomElevationMm: 2.7,
    bottomThicknessMm: 1.4, bottomAreaMm2: circularAreaMm2(10.4),
    nominalVolumeUl: 1500, workingVolumeMinUl: null, workingVolumeMaxUl: null,
    notes: 'Nominal Watson flat-bottom reference geometry; verify the actual plate model for quantitative path-length work.',
  },
  {
    key: '8x12', wellCount: 96, rows: 8, columns: 12,
    displayName: '96-well flat-bottom reference geometry',
    geometryClass: 'flat-bottom', sourceManufacturer: 'Corning',
    sourceDocument: 'MicroplateDimensions96-384-1536.pdf',
    sourceProfile: '96 well flat bottom, solid polystyrene', vendorSpecific: true,
    footprintLengthMm: 127.8, footprintWidthMm: 85.5, plateHeightMm: 14.2,
    a1RowOffsetMm: 11.2, a1ColumnOffsetMm: 14.3,
    pitchXmm: 9.0, pitchYmm: 9.0,
    mouthDiameterMm: 6.86, floorDiameterOrWidthMm: 6.35,
    floorDimensionKind: 'diameter', wellDepthMm: 10.67,
    flangeOrSkirtHeightMm: 6.096, wellBottomElevationMm: 3.55,
    bottomThicknessMm: 1.27, bottomAreaMm2: 31.65,
    nominalVolumeUl: 360, workingVolumeMinUl: null, workingVolumeMaxUl: null,
    notes: 'Nominal Corning standard flat-bottom reference geometry; product families and materials can differ.',
  },
  {
    key: '16x24', wellCount: 384, rows: 16, columns: 24,
    displayName: '384-well flat-bottom reference geometry',
    geometryClass: 'flat-bottom', sourceManufacturer: 'Corning',
    sourceDocument: 'MicroplateDimensions96-384-1536.pdf',
    sourceProfile: '384 well flat bottom, solid polystyrene', vendorSpecific: true,
    footprintLengthMm: 127.8, footprintWidthMm: 85.5, plateHeightMm: 14.2,
    a1RowOffsetMm: 8.99, a1ColumnOffsetMm: 12.12,
    pitchXmm: 4.5, pitchYmm: 4.5,
    mouthDiameterMm: 3.63, floorDiameterOrWidthMm: 2.67,
    floorDimensionKind: 'width', wellDepthMm: 11.43,
    flangeOrSkirtHeightMm: 6.096, wellBottomElevationMm: 2.667,
    bottomThicknessMm: 1.27, bottomAreaMm2: 6.19,
    nominalVolumeUl: 112, workingVolumeMinUl: null, workingVolumeMaxUl: null,
    notes: 'Corning reports the lower dimension as bottom width for this profile; it is not treated as a universal circular diameter.',
  },
  {
    key: '32x48', wellCount: 1536, rows: 32, columns: 48,
    displayName: '1536-well flat-bottom reference geometry',
    geometryClass: 'flat-bottom', sourceManufacturer: 'Corning',
    sourceDocument: 'MicroplateDimensions96-384-1536.pdf',
    sourceProfile: '1536 well solid flat bottom, polystyrene', vendorSpecific: true,
    footprintLengthMm: 127.8, footprintWidthMm: 85.5, plateHeightMm: 10.4,
    a1RowOffsetMm: 7.86, a1ColumnOffsetMm: 11.0,
    pitchXmm: 2.25, pitchYmm: 2.25,
    mouthDiameterMm: 1.8, floorDiameterOrWidthMm: 1.63,
    floorDimensionKind: 'diameter', wellDepthMm: 4.8,
    flangeOrSkirtHeightMm: 2.16, wellBottomElevationMm: 5.6,
    bottomThicknessMm: 0.076, bottomAreaMm2: 2.09,
    nominalVolumeUl: 12.8, workingVolumeMinUl: null, workingVolumeMaxUl: null,
    notes: 'Nominal Corning standard flat-bottom reference geometry; high-base and low-base variants differ.',
  },
] as const;

export const FLAT_BOTTOM_PLATE_GEOMETRY_PRESETS = PRESETS;

export function getFlatBottomPlateGeometry(
  rows: number,
  columns: number,
): FlatBottomPlateGeometryPreset | null {
  return PRESETS.find((preset) => preset.rows === rows && preset.columns === columns) ?? null;
}

export function getFlatBottomPlateGeometryByWellCount(
  wellCount: number,
): FlatBottomPlateGeometryPreset | null {
  return PRESETS.find((preset) => preset.wellCount === wellCount) ?? null;
}

export function getMouthDiameterToPitchRatio(
  preset: FlatBottomPlateGeometryPreset,
): number {
  return preset.mouthDiameterMm / ((preset.pitchXmm + preset.pitchYmm) / 2);
}

export function getFloorDimensionToPitchRatio(
  preset: FlatBottomPlateGeometryPreset,
): number {
  return preset.floorDiameterOrWidthMm / ((preset.pitchXmm + preset.pitchYmm) / 2);
}

export function getMeanPitchMm(
  preset: FlatBottomPlateGeometryPreset,
): number {
  return (preset.pitchXmm + preset.pitchYmm) / 2;
}

export function getPixelsPerMm(
  localPitchPx: number,
  preset: FlatBottomPlateGeometryPreset,
): number {
  return localPitchPx / getMeanPitchMm(preset);
}

export function getMouthRadiusPx(
  localPitchPx: number,
  preset: FlatBottomPlateGeometryPreset,
): number {
  return localPitchPx * preset.mouthDiameterMm / (2 * getMeanPitchMm(preset));
}

export function getFloorRadiusPx(
  localPitchPx: number,
  preset: FlatBottomPlateGeometryPreset,
): number {
  return localPitchPx * preset.floorDiameterOrWidthMm / (2 * getMeanPitchMm(preset));
}

export function flatBottomPlateGeometryEntries(
  preset: FlatBottomPlateGeometryPreset,
): Array<{ key: string; value: string | number }> {
  return [
    { key: 'name', value: preset.displayName },
    { key: 'geometry_class', value: preset.geometryClass },
    { key: 'source_manufacturer', value: preset.sourceManufacturer },
    { key: 'source_document', value: preset.sourceDocument },
    { key: 'source_profile', value: preset.sourceProfile },
    { key: 'vendor_specific', value: preset.vendorSpecific ? 'true' : 'false' },
    { key: 'plate_analysis_support_level', value: getPlateAnalysisSupportLevel(preset.rows, preset.columns) },
    { key: 'plate_analysis_support_note', value: getPlateAnalysisSupportNote(getPlateAnalysisSupportLevel(preset.rows, preset.columns), preset.rows, preset.columns) },
    { key: 'plate_workflow_test_status', value: getPlateWorkflowTestStatus(preset.rows, preset.columns) },
    { key: 'well_count', value: preset.wellCount },
    { key: 'plate_rows', value: preset.rows },
    { key: 'plate_columns', value: preset.columns },
    { key: 'footprint_length_mm', value: preset.footprintLengthMm },
    { key: 'footprint_width_mm', value: preset.footprintWidthMm },
    { key: 'plate_height_mm', value: preset.plateHeightMm ?? '' },
    { key: 'a1_row_offset_mm', value: preset.a1RowOffsetMm ?? '' },
    { key: 'a1_column_offset_mm', value: preset.a1ColumnOffsetMm ?? '' },
    { key: 'pitch_x_mm', value: preset.pitchXmm },
    { key: 'pitch_y_mm', value: preset.pitchYmm },
    { key: 'mouth_diameter_mm', value: preset.mouthDiameterMm },
    { key: 'floor_dimension_mm', value: preset.floorDiameterOrWidthMm },
    { key: 'floor_dimension_kind', value: preset.floorDimensionKind },
    { key: 'well_depth_mm', value: preset.wellDepthMm },
    { key: 'flange_or_skirt_height_mm', value: preset.flangeOrSkirtHeightMm ?? '' },
    { key: 'well_bottom_elevation_mm', value: preset.wellBottomElevationMm ?? '' },
    { key: 'bottom_thickness_mm', value: preset.bottomThicknessMm ?? '' },
    { key: 'bottom_area_mm2', value: preset.bottomAreaMm2 },
    { key: 'nominal_volume_ul', value: preset.nominalVolumeUl },
    { key: 'working_volume_min_ul', value: preset.workingVolumeMinUl ?? '' },
    { key: 'working_volume_max_ul', value: preset.workingVolumeMaxUl ?? '' },
    { key: 'notes', value: preset.notes },
  ];
}

/** Returns the number of quadrilateral inter-well cells in a local visible grid. */
export function countPhysicalInterwellCells(visibleRows: number, visibleColumns: number): number {
  const rows = Math.max(0, Math.trunc(visibleRows));
  const columns = Math.max(0, Math.trunc(visibleColumns));
  return Math.max(0, rows - 1) * Math.max(0, columns - 1);
}
export type PlateAnalysisSupportLevel =
  | 'validated'
  | 'internal-testing'
  | 'configurable-only'
  | 'unsupported';

export interface PlateVisibleRegionInput {
  plateRows: number;
  plateColumns: number;
  visibleRows: number;
  visibleColumns: number;
  rowOffset: number;
  columnOffset: number;
  actualWellCount: number;
}

export function getPlateAnalysisSupportLevel(
  plateRows: number,
  plateColumns: number,
): PlateAnalysisSupportLevel {
  if (plateRows === 8 && plateColumns === 12) return 'validated';
  if (
    (plateRows === 2 && plateColumns === 3) ||
    (plateRows === 3 && plateColumns === 4) ||
    (plateRows === 4 && plateColumns === 6) ||
    (plateRows === 6 && plateColumns === 8) ||
    (plateRows === 16 && plateColumns === 24) ||
    (plateRows === 32 && plateColumns === 48)
  ) return 'internal-testing';
  return 'unsupported';
}

function isHighDensityWorkflowTestingInProgress(
  plateRows: number | undefined,
  plateColumns: number | undefined,
): boolean {
  return (
    (plateRows === 16 && plateColumns === 24) ||
    (plateRows === 32 && plateColumns === 48)
  );
}

export function getPlateWorkflowTestStatus(
  plateRows: number,
  plateColumns: number,
): string {
  const level = getPlateAnalysisSupportLevel(plateRows, plateColumns);
  if (level === 'validated') return 'experimentally validated';
  if (isHighDensityWorkflowTestingInProgress(plateRows, plateColumns)) {
    return 'internal technical workflow testing in progress';
  }
  if (level === 'internal-testing') {
    return 'internal technical workflow testing completed';
  }
  return 'not yet internally tested';
}

export function getPlateAnalysisSupportNote(
  level: PlateAnalysisSupportLevel,
  plateRows?: number,
  plateColumns?: number,
): string {
  if (level === 'validated') {
    return 'Complete image-analysis workflow experimentally validated for nominal 96-well plates.';
  }
  if (level === 'internal-testing') {
    if (isHighDensityWorkflowTestingInProgress(plateRows, plateColumns)) {
      return 'Complete image-analysis execution is enabled exclusively for internal technical workflow testing in progress; this does not constitute experimental validation of the nominal format.';
    }
    return 'Internal technical workflow testing has been completed with real near-frontal images; this does not constitute experimental validation of the nominal format.';
  }
  if (level === 'configurable-only') {
    return 'Geometry is configurable and supported in principle, but complete image-analysis execution remains disabled pending internal image-workflow testing.';
  }
  return 'No supported nominal flat-bottom analysis profile is registered for this layout.';
}

export function isValidVisiblePlateRegion(input: PlateVisibleRegionInput): boolean {
  const values = [
    input.plateRows,
    input.plateColumns,
    input.visibleRows,
    input.visibleColumns,
    input.rowOffset,
    input.columnOffset,
    input.actualWellCount,
  ];
  if (!values.every(Number.isInteger)) return false;
  if (input.plateRows < 1 || input.plateColumns < 1) return false;
  if (input.visibleRows < 1 || input.visibleRows > input.plateRows) return false;
  if (input.visibleColumns < 1 || input.visibleColumns > input.plateColumns) return false;
  if (input.rowOffset < 0 || input.columnOffset < 0) return false;
  if (input.rowOffset + input.visibleRows > input.plateRows) return false;
  if (input.columnOffset + input.visibleColumns > input.plateColumns) return false;
  return input.actualWellCount === input.visibleRows * input.visibleColumns;
}

export function isAnalysisExecutionAllowed(input: PlateVisibleRegionInput): boolean {
  const level = getPlateAnalysisSupportLevel(input.plateRows, input.plateColumns);
  return (level === 'validated' || level === 'internal-testing') && isValidVisiblePlateRegion(input);
}
