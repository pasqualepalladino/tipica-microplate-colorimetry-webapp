import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { ImageGeometryLoader } from './components/ImageGeometryLoader';
import { PlateCanvas } from './components/PlateCanvas';
import { PlateMapEditor } from './components/PlateMapEditor';
import packageJson from '../package.json';
import { fitCalibration, fitLineWithCovariance, fitLinearRegression, fitStandardAddition, stdAddC0SdFromFit } from './core/fitting';
import { computePythonImageQcInfo, type PythonImageQcInfo } from './core/imageQc';
import { buildPythonReportOverviewRows } from './core/reportOverview';
import {
  buildCielabDiagnosticPoints,
  computeCielabStdAddBetaBias,
  resolveStoredCalibrationSlopeForCielabDescriptor,
  type CielabDiagnosticPoint,
  type LabValue,
} from './core/cielab';
import {
  addCorrectionMetadataToCalibrationFits,
  addCorrectionMetadataToStandardAdditionFits,
  applyRgbLowSignalCorrections,
  computeRgbLowSignalCorrections,
} from './core/lowSignalCorrection';
import type { WellChannelCorrectionApplication } from './core/lowSignalCorrection';
import { computePAbs, linearizeRgb } from './core/pabs';
import {
  computeGeometryAlignmentDiagnostics,
  estimateLocalPitch,
  estimateRoiRadius,
  generate96WellGrid,
  getCanvasCoordinateSize,
  getImageAnalysisSize,
  generate96WellFloorCircles,
  hasFloorGeometry,
} from './core/plate';
import {
  FLOOR_CIRCLE_REFERENCES,
  geometryWithFloorCircles,
  geometryWithoutFloorCircles,
  getReferenceFloorCircles,
  reconcileLoadedGeometryFloor,
  type FloorGeometrySource,
} from './core/geometryReconciliation';
import {
  createEmptyPlateMap,
} from './core/plateMap';
import type { ExpectedRef, PlateEditorSnapshot } from './core/plateConfigurator';
import { estimateLocalBackground, sampleCircularRoi, sampleCircleIntersectionRoi } from './core/sampling';
import {
  buildBackgroundVisualDiagnostics,
  estimateBackground,
  estimatePhysicalInterwellPolynomialBackgrounds,
  type BackgroundEstimateWithModel,
  type BackgroundVisualDiagnostics,
  type BackgroundModel,
  type WellExclusionRadiusMap,
} from './core/backgroundModels';
import {
  addCalibrationSlopeContextToStandardAddition,
  canCreateStoredCalibration,
  buildReliabilityPayload,
  computeEmptyWellQcStatus,
  createStoredCalibrationFromFits,
  downloadStoredCalibrationJson,
  estimateUnknownConcentrationsFromStoredCalibration,
  parseStoredCalibrationJson,
} from './core/storedCalibration';
import type { FloorCircle, PlateGeometry, Point } from './types/geometry';
import type { WellCenter } from './types/plate';
import type { CalibrationFit, FitChannel, StandardAdditionFit, WellConfig } from './types/plateMap';
import type { MethodMetadata, Rgb, RoiMode, RoiPixelStatisticsMode, WellMeasurement } from './types/results';
import type {
  RgbLowSignalCorrection,
  StoredCalibration,
  StoredCielabReference,
  UnknownConcentrationResult,
} from './types/storedCalibration';

const DEFAULT_RADIUS_FACTOR = 0.3;
const DEFAULT_MANUAL_MOUTH_RADIUS_PX = 28;
const MIN_MANUAL_MOUTH_RADIUS_PX = 8;
const MAX_MANUAL_MOUTH_RADIUS_PX = 120;
const MANUAL_CORNER_LABELS = ['A1', 'A12', 'H12', 'H1'];
const LIMITED_STORED_CALIBRATION_METADATA_WARNING = 'Stored calibration has limited method metadata.';
const STORED_CALIBRATION_METHOD_MISMATCH_WARNING = 'Stored calibration method differs from current extraction method; results may not be comparable.';
const MISSING_VALUE = 'Not available';
const SHARED_GEOMETRY_OVERRIDE_SOURCE = 'python_canonical_override';
const VALIDATION_SEARCH_PARAMS = typeof window !== 'undefined'
  ? new URLSearchParams(window.location.search)
  : null;
const SHOW_VALIDATION_CONTROLS = VALIDATION_SEARCH_PARAMS?.get('validation') === '1' ||
  VALIDATION_SEARCH_PARAMS?.get('dev') === '1';
const SHOW_PUBLIC_PROJECT_CONTROLS = SHOW_VALIDATION_CONTROLS;
const SHOW_PUBLIC_GEOMETRY_JSON_UPLOAD = SHOW_VALIDATION_CONTROLS;
const SHOW_PUBLIC_GEOMETRY_DEVELOPER_CONTROLS = SHOW_VALIDATION_CONTROLS;

interface SharedGeometryOverrideRecord {
  wellId: string;
  mouthCx: number;
  mouthCy: number;
  floorCx: number;
  floorCy: number;
  mouthRadius: number;
  floorRadius: number;
  floorRadiusGeom?: number;
  mouthRadiusGeom?: number;
  cylRadiusBg?: number;
  localPitchPx?: number;
  floorSource?: string;
}

interface SharedGeometryOverrideState {
  sourceName: string;
  recordsByWell: Map<string, SharedGeometryOverrideRecord>;
  wellCount: number;
  missingWells: string[];
  ignoredFields: string[];
  mappingSummary: string;
}

function geometryFromManualPoints(points: Point[]): PlateGeometry | null {
  if (points.length !== 4) {
    return null;
  }

  return {
    corner_a1: points[0],
    corner_a12: points[1],
    corner_h12: points[2],
    corner_h1: points[3],
  };
}

function pointDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function medianNumber(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }

  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function estimateCornerPitchFromManualPoints(points: Point[]): number | null {
  const [a1, a12, h12, h1] = points;
  const pitches: number[] = [];

  if (a1 && a12) {
    pitches.push(pointDistance(a1, a12) / 11);
  }

  if (h1 && h12) {
    pitches.push(pointDistance(h1, h12) / 11);
  }

  if (a1 && h1) {
    pitches.push(pointDistance(a1, h1) / 7);
  }

  if (a12 && h12) {
    pitches.push(pointDistance(a12, h12) / 7);
  }

  return medianNumber(pitches.filter((pitch) => Number.isFinite(pitch) && pitch > 0));
}

function clampManualMouthRadiusPx(radius: number): number {
  if (!Number.isFinite(radius)) {
    return DEFAULT_MANUAL_MOUTH_RADIUS_PX;
  }

  return Math.max(MIN_MANUAL_MOUTH_RADIUS_PX, Math.min(MAX_MANUAL_MOUTH_RADIUS_PX, radius));
}

function isCanonicalWellId(value: string): boolean {
  const match = /^([A-H])(\d{1,2})$/i.exec(value.trim());
  if (!match) {
    return false;
  }

  const col = Number(match[2]);
  return Number.isInteger(col) && col >= 1 && col <= 12;
}

function defaultSharedGeometryWellIds(): string[] {
  const ids: string[] = [];
  for (let row = 0; row < 8; row += 1) {
    for (let col = 1; col <= 12; col += 1) {
      ids.push(`${String.fromCharCode(65 + row)}${col}`);
    }
  }
  return ids;
}

function finiteNumberFromRecord(record: Record<string, unknown>, field: string): number | null {
  const raw = record[field];
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

function stringFromRecord(record: Record<string, unknown>, ...fields: string[]): string {
  for (const field of fields) {
    const raw = record[field];
    if (typeof raw === 'string' && raw.trim() !== '') {
      return raw.trim();
    }
  }
  return '';
}

function canonicalGeometryRecordsFromJson(parsed: unknown): Record<string, unknown>[] {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Shared geometry JSON must be an object.');
  }

  const root = parsed as Record<string, unknown>;
  if (Array.isArray(root.records)) {
    return root.records.filter((record): record is Record<string, unknown> => (
      Boolean(record) && typeof record === 'object' && !Array.isArray(record)
    ));
  }

  if (Array.isArray(root.per_well)) {
    return root.per_well.filter((record): record is Record<string, unknown> => (
      Boolean(record) && typeof record === 'object' && !Array.isArray(record)
    ));
  }

  if (root.per_well && typeof root.per_well === 'object' && !Array.isArray(root.per_well)) {
    return Object.entries(root.per_well as Record<string, unknown>)
      .filter(([, value]) => Boolean(value) && typeof value === 'object' && !Array.isArray(value))
      .map(([wellId, value]) => ({ Well: wellId, ...(value as Record<string, unknown>) }));
  }

  throw new Error('Shared geometry JSON must contain records or per_well geometry rows.');
}

function parseSharedGeometryOverrideJson(
  text: string,
  sourceName: string,
  requiredWellIds: string[],
): SharedGeometryOverrideState {
  const parsed = JSON.parse(text) as unknown;
  const rawRecords = canonicalGeometryRecordsFromJson(parsed);
  const knownFields = new Set([
    'Well',
    'well',
    'well_id',
    'mouth_cx',
    'mouth_cy',
    'floor_cx',
    'floor_cy',
    'mouth_r',
    'floor_r',
    'mouth_r_geom',
    'floor_r_geom',
    'cyl_r_bg',
    'local_pitch_px',
    'pitch_px',
    'floor_source',
    'source_fields_available',
  ]);
  const ignoredFields = new Set<string>();
  const recordsByWell = new Map<string, SharedGeometryOverrideRecord>();

  rawRecords.forEach((record) => {
    Object.keys(record).forEach((field) => {
      if (!knownFields.has(field)) {
        ignoredFields.add(field);
      }
    });

    const wellId = stringFromRecord(record, 'Well', 'well', 'well_id').toUpperCase();
    if (!isCanonicalWellId(wellId)) {
      throw new Error(`Shared geometry record has invalid well id "${wellId || '(blank)'}".`);
    }
    if (recordsByWell.has(wellId)) {
      throw new Error(`Shared geometry JSON has duplicate well ${wellId}.`);
    }

    const mouthCx = finiteNumberFromRecord(record, 'mouth_cx');
    const mouthCy = finiteNumberFromRecord(record, 'mouth_cy');
    const floorCx = finiteNumberFromRecord(record, 'floor_cx');
    const floorCy = finiteNumberFromRecord(record, 'floor_cy');
    const mouthRadius = finiteNumberFromRecord(record, 'mouth_r');
    const floorRadius = finiteNumberFromRecord(record, 'floor_r');

    if (
      mouthCx === null ||
      mouthCy === null ||
      floorCx === null ||
      floorCy === null ||
      mouthRadius === null ||
      floorRadius === null ||
      mouthRadius <= 0 ||
      floorRadius <= 0
    ) {
      throw new Error(`Shared geometry well ${wellId} is missing required mouth/floor center or radius fields.`);
    }

    recordsByWell.set(wellId, {
      wellId,
      mouthCx,
      mouthCy,
      floorCx,
      floorCy,
      mouthRadius,
      floorRadius,
      mouthRadiusGeom: finiteNumberFromRecord(record, 'mouth_r_geom') ?? undefined,
      floorRadiusGeom: finiteNumberFromRecord(record, 'floor_r_geom') ?? undefined,
      cylRadiusBg: finiteNumberFromRecord(record, 'cyl_r_bg') ?? undefined,
      localPitchPx: finiteNumberFromRecord(record, 'local_pitch_px') ?? finiteNumberFromRecord(record, 'pitch_px') ?? undefined,
      floorSource: stringFromRecord(record, 'floor_source') || undefined,
    });
  });

  const missingWells = requiredWellIds.filter((wellId) => !recordsByWell.has(wellId));
  if (missingWells.length > 0) {
    throw new Error(`Shared geometry override missing required wells: ${missingWells.slice(0, 12).join(', ')}${missingWells.length > 12 ? '...' : ''}.`);
  }

  return {
    sourceName,
    recordsByWell,
    wellCount: recordsByWell.size,
    missingWells,
    ignoredFields: [...ignoredFields].sort(),
    mappingSummary: 'Extraction mapping: mouth_cx/mouth_cy/mouth_r drive mouth ROI; floor_cx/floor_cy/floor_r drive floor ROI; cyl_r_bg drives background well exclusion when present; local_pitch_px and floor_source are diagnostic/reporting fields.',
  };
}

function manualMouthRadiusToRadiusFactor(points: Point[], radiusPx: number): number | null {
  const pitch = estimateCornerPitchFromManualPoints(points);

  if (!pitch || pitch <= 0) {
    return null;
  }

  return Math.max(0.05, Math.min(0.75, radiusPx / pitch));
}

function estimateInitialManualMouthRadius(wells: WellCenter[], radiusFactor: number): number {
  const a1 = wells.find((well) => well.row === 0 && well.col === 0);

  if (!a1) {
    return DEFAULT_MANUAL_MOUTH_RADIUS_PX;
  }

  return clampManualMouthRadiusPx(estimateRoiRadius(wells, a1.row, a1.col, radiusFactor));
}

function getReferenceMouthCircle(wells: WellCenter[], referenceIndex: number, radiusFactor: number): FloorCircle | null {
  const reference = FLOOR_CIRCLE_REFERENCES[referenceIndex];

  if (!reference) {
    return null;
  }

  const well = wells.find((candidate) => candidate.row === reference.row && candidate.col === reference.col);

  if (!well) {
    return null;
  }

  return {
    x: well.x,
    y: well.y,
    r: estimateRoiRadius(wells, well.row, well.col, radiusFactor),
  };
}

function geometryJsonPayload(geometry: PlateGeometry) {
  return {
    corner_a1: [geometry.corner_a1.x, geometry.corner_a1.y],
    corner_a12: [geometry.corner_a12.x, geometry.corner_a12.y],
    corner_h12: [geometry.corner_h12.x, geometry.corner_h12.y],
    corner_h1: [geometry.corner_h1.x, geometry.corner_h1.y],
    ...(geometry.mouth_radius_px ? { mouth_radius_px: geometry.mouth_radius_px } : {}),
    ...(geometry.roi_radius_factor ? { roi_radius_factor: geometry.roi_radius_factor } : {}),
    ...(geometry.floor_a1_circle_img ? { floor_a1_circle_img: [geometry.floor_a1_circle_img.x, geometry.floor_a1_circle_img.y, geometry.floor_a1_circle_img.r] } : {}),
    ...(geometry.floor_a12_circle_img ? { floor_a12_circle_img: [geometry.floor_a12_circle_img.x, geometry.floor_a12_circle_img.y, geometry.floor_a12_circle_img.r] } : {}),
    ...(geometry.floor_h12_circle_img ? { floor_h12_circle_img: [geometry.floor_h12_circle_img.x, geometry.floor_h12_circle_img.y, geometry.floor_h12_circle_img.r] } : {}),
    ...(geometry.floor_h1_circle_img ? { floor_h1_circle_img: [geometry.floor_h1_circle_img.x, geometry.floor_h1_circle_img.y, geometry.floor_h1_circle_img.r] } : {}),
  };
}

function parseProjectFloorGeometrySource(value: unknown, geometry: PlateGeometry): FloorGeometrySource {
  if (!hasFloorGeometry(geometry)) {
    return 'none';
  }

  if (value === 'json' || value === 'manual' || value === 'project') {
    return value;
  }

  return 'project';
}

function formatFloorGeometrySource(source: FloorGeometrySource, available: boolean): string {
  if (!available) {
    return 'none';
  }

  if (source === 'json') {
    return 'JSON';
  }

  if (source === 'manual') {
    return 'manual';
  }

  if (source === 'project') {
    return 'project';
  }

  return 'unknown';
}

function formatRoiPixelStatisticsMode(mode: RoiPixelStatisticsMode): string {
  return mode === 'robust-trimmed-v1' ? 'Robust trimmed ROI v1' : 'Simple median';
}

function formatRoiMode(mode: RoiMode): string {
  if (mode === 'mouth-floor-intersection') {
    return 'Mouth-floor intersection ROI';
  }

  if (mode === 'floor-aware') {
    return 'Floor-aware ROI';
  }

  return 'Simple center ROI';
}

function formatBackgroundModel(mode: BackgroundModel): string {
  if (mode === 'physical-interwell-polynomial-v1') {
    return 'Physical inter-well polynomial v1';
  }

  if (mode === 'robust-interwell-v1') {
    return 'Robust inter-well background v1';
  }

  return 'Annular background';
}

function summarizeCorrectionMetadata(
  correctionApplied: boolean,
  correctionSource: string,
  corrections: RgbLowSignalCorrection[],
): string {
  if (!correctionApplied) {
    return 'not applied';
  }

  const channels = corrections.map((correction) => correction.channel).join('/');
  return `source=${correctionSource}; channels=${channels || 'none'}`;
}

function methodMetadataMatches(current: MethodMetadata, stored: MethodMetadata | undefined): boolean {
  if (!stored) {
    return false;
  }

  return current.roiMode === stored.roiMode &&
    current.roiPixelStatisticsMode === stored.roiPixelStatisticsMode &&
    current.backgroundModel === stored.backgroundModel &&
    current.correctionApplied === stored.correctionApplied;
}

function geometryExportFileName(imageName: string | null): string {
  if (!imageName) {
    return 'manual_4corner_wells.json';
  }

  return `${imageName.replace(/\.[^.]+$/, '')}_4corner_wells.json`;
}

function downloadGeometryJson(geometry: PlateGeometry, imageName: string | null): void {
  const payload = geometryJsonPayload(geometry);
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = geometryExportFileName(imageName);
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadJsonFile(payload: unknown, fileName: string): void {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json;charset=utf-8' });
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

function downloadBlob(blob: Blob, fileName: string): void {
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

function downloadTextFile(text: string, fileName: string, mimeType = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([text], { type: mimeType });
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

function downloadCanvasPng(canvas: HTMLCanvasElement, fileName: string): void {
  const link = document.createElement('a');

  link.href = canvas.toDataURL('image/png');
  link.download = fileName;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Could not encode diagnostic PNG.'));
      }
    }, 'image/png');
  });
}

const ZIP_CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let crc = index;

  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }

  return crc >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc = ZIP_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16(target: number[], value: number): void {
  target.push(value & 0xff, (value >>> 8) & 0xff);
}

function writeUint32(target: number[], value: number): void {
  target.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function dosDateTime(date = new Date()): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());

  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

async function createZipBlob(files: { name: string; blob: Blob }[]): Promise<Blob> {
  const encoder = new TextEncoder();
  const chunks: BlobPart[] = [];
  const centralDirectory: number[] = [];
  let offset = 0;
  const timestamp = dosDateTime();

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const dataBytes = new Uint8Array(await file.blob.arrayBuffer());
    const checksum = crc32(dataBytes);
    const localHeader: number[] = [];

    writeUint32(localHeader, 0x04034b50);
    writeUint16(localHeader, 20);
    writeUint16(localHeader, 0x0800);
    writeUint16(localHeader, 0);
    writeUint16(localHeader, timestamp.time);
    writeUint16(localHeader, timestamp.date);
    writeUint32(localHeader, checksum);
    writeUint32(localHeader, dataBytes.length);
    writeUint32(localHeader, dataBytes.length);
    writeUint16(localHeader, nameBytes.length);
    writeUint16(localHeader, 0);

    chunks.push(new Uint8Array(localHeader), nameBytes, dataBytes);

    writeUint32(centralDirectory, 0x02014b50);
    writeUint16(centralDirectory, 20);
    writeUint16(centralDirectory, 20);
    writeUint16(centralDirectory, 0x0800);
    writeUint16(centralDirectory, 0);
    writeUint16(centralDirectory, timestamp.time);
    writeUint16(centralDirectory, timestamp.date);
    writeUint32(centralDirectory, checksum);
    writeUint32(centralDirectory, dataBytes.length);
    writeUint32(centralDirectory, dataBytes.length);
    writeUint16(centralDirectory, nameBytes.length);
    writeUint16(centralDirectory, 0);
    writeUint16(centralDirectory, 0);
    writeUint16(centralDirectory, 0);
    writeUint16(centralDirectory, 0);
    writeUint32(centralDirectory, 0);
    writeUint32(centralDirectory, offset);
    centralDirectory.push(...nameBytes);

    offset += localHeader.length + nameBytes.length + dataBytes.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectoryBytes = new Uint8Array(centralDirectory);
  const endRecord: number[] = [];

  writeUint32(endRecord, 0x06054b50);
  writeUint16(endRecord, 0);
  writeUint16(endRecord, 0);
  writeUint16(endRecord, files.length);
  writeUint16(endRecord, files.length);
  writeUint32(endRecord, centralDirectoryBytes.length);
  writeUint32(endRecord, centralDirectoryOffset);
  writeUint16(endRecord, 0);

  chunks.push(centralDirectoryBytes, new Uint8Array(endRecord));

  return new Blob(chunks, { type: 'application/zip' });
}

function parseProjectPoint(value: unknown): Point {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error('Invalid geometry point in project JSON.');
  }

  const [x, y] = value;

  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('Invalid geometry point in project JSON.');
  }

  return { x, y };
}

function parseProjectFloorCircle(value: unknown): { x: number; y: number; r: number } {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error('Invalid floor circle in project JSON.');
  }

  const [x, y, r] = value;

  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof r !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(r) ||
    r <= 0
  ) {
    throw new Error('Invalid floor circle in project JSON.');
  }

  return { x, y, r };
}

function parseProjectGeometry(raw: unknown): PlateGeometry {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('Project JSON is missing geometry.');
  }

  const geometry = raw as Record<string, unknown>;

  const result: PlateGeometry = {
    corner_a1: parseProjectPoint(geometry.corner_a1),
    corner_a12: parseProjectPoint(geometry.corner_a12),
    corner_h12: parseProjectPoint(geometry.corner_h12),
    corner_h1: parseProjectPoint(geometry.corner_h1),
  };

  if (geometry.mouth_radius_px !== undefined) {
    const mouthRadiusPx = geometry.mouth_radius_px;

    if (typeof mouthRadiusPx !== 'number' || !Number.isFinite(mouthRadiusPx) || mouthRadiusPx <= 0) {
      throw new Error('Invalid mouth radius in project geometry.');
    }

    result.mouth_radius_px = mouthRadiusPx;
  }

  if (geometry.roi_radius_factor !== undefined) {
    const roiRadiusFactor = geometry.roi_radius_factor;

    if (typeof roiRadiusFactor !== 'number' || !Number.isFinite(roiRadiusFactor) || roiRadiusFactor <= 0) {
      throw new Error('Invalid ROI radius factor in project geometry.');
    }

    result.roi_radius_factor = roiRadiusFactor;
  }

  if (geometry.floor_a1_circle_img !== undefined) {
    result.floor_a1_circle_img = parseProjectFloorCircle(geometry.floor_a1_circle_img);
  }

  if (geometry.floor_a12_circle_img !== undefined) {
    result.floor_a12_circle_img = parseProjectFloorCircle(geometry.floor_a12_circle_img);
  }

  if (geometry.floor_h12_circle_img !== undefined) {
    result.floor_h12_circle_img = parseProjectFloorCircle(geometry.floor_h12_circle_img);
  }

  if (geometry.floor_h1_circle_img !== undefined) {
    result.floor_h1_circle_img = parseProjectFloorCircle(geometry.floor_h1_circle_img);
  }

  return result;
}

function parseWellConfig(raw: unknown): WellConfig {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('Invalid well config in project JSON.');
  }

  const config = raw as Record<string, unknown>;
  const role = config.role;

  if (typeof config.wellId !== 'string' || typeof config.row !== 'number' || typeof config.col !== 'number') {
    throw new Error('Invalid well config in project JSON.');
  }

  if (role !== 'EMPTY' && role !== 'C' && role !== 'A' && role !== 'U') {
    throw new Error('Invalid well role in project JSON.');
  }

  const concentration = config.concentration;
  const sampleId = config.sampleId;
  const dilutionFactor = config.dilutionFactor;

  if (typeof sampleId !== 'string' || typeof dilutionFactor !== 'number' || !Number.isFinite(dilutionFactor)) {
    throw new Error('Invalid well config in project JSON.');
  }

  if (concentration !== null && typeof concentration !== 'number') {
    throw new Error('Invalid concentration value in project JSON.');
  }

  return {
    wellId: config.wellId,
    row: config.row,
    col: config.col,
    role,
    concentration: concentration === null ? null : concentration,
    sampleId,
    dilutionFactor,
  };
}

function parseProjectPlateMap(raw: unknown): WellConfig[] {
  if (!Array.isArray(raw)) {
    throw new Error('Project JSON is missing plateMap.');
  }

  return raw.map(parseWellConfig);
}

function parseProjectExpectedRefs(raw: unknown): ExpectedRef[] {
  if (raw === undefined || raw === null) {
    return [];
  }

  if (!Array.isArray(raw)) {
    throw new Error('Invalid expectedRefs in project JSON.');
  }

  return raw.map((entry) => {
    if (entry === null || typeof entry !== 'object') {
      throw new Error('Invalid expectedRefs row in project JSON.');
    }

    const row = entry as Record<string, unknown>;
    const refId = typeof row.refId === 'string' ? row.refId : '';
    const label = typeof row.label === 'string' ? row.label : '';
    const value = row.value;
    const sd = row.sd;

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('Invalid expectedRefs value in project JSON.');
    }

    if (sd !== null && (typeof sd !== 'number' || !Number.isFinite(sd))) {
      throw new Error('Invalid expectedRefs sd in project JSON.');
    }

    return {
      refId,
      label,
      value,
      sd: sd === null ? null : sd,
    };
  });
}

function parseProjectStringRecord(raw: unknown, label: string): Record<number, string> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Invalid ${label} in project JSON.`);
  }

  const result: Record<number, string> = {};
  Object.entries(raw as Record<string, unknown>).forEach(([key, value]) => {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || typeof value !== 'string') {
      throw new Error(`Invalid ${label} in project JSON.`);
    }
    result[index] = value;
  });
  return result;
}

function parseProjectPlateEditorSnapshot(raw: unknown): PlateEditorSnapshot | null {
  if (raw === undefined || raw === null) {
    return null;
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid plateConfigurator in project JSON.');
  }

  const payload = raw as Record<string, unknown>;
  const nrow = payload.nrow;
  const ncol = payload.ncol;
  const priority = payload.idDfPriority;
  const defaults = payload.defaults;

  if (
    typeof nrow !== 'number' ||
    typeof ncol !== 'number' ||
    !Number.isInteger(nrow) ||
    !Number.isInteger(ncol) ||
    nrow <= 0 ||
    ncol <= 0
  ) {
    throw new Error('Invalid plateConfigurator dimensions in project JSON.');
  }

  if (priority !== 'row' && priority !== 'col') {
    throw new Error('Invalid plateConfigurator idDfPriority in project JSON.');
  }

  if (defaults === null || typeof defaults !== 'object' || Array.isArray(defaults)) {
    throw new Error('Invalid plateConfigurator defaults in project JSON.');
  }

  const defaultPayload = defaults as Record<string, unknown>;

  return {
    grid: parseProjectStringRecord(payload.grid, 'plateConfigurator grid'),
    defaults: {
      rowDf: parseProjectStringRecord(defaultPayload.rowDf, 'plateConfigurator rowDf'),
      rowId: parseProjectStringRecord(defaultPayload.rowId, 'plateConfigurator rowId'),
      colDf: parseProjectStringRecord(defaultPayload.colDf, 'plateConfigurator colDf'),
      colId: parseProjectStringRecord(defaultPayload.colId, 'plateConfigurator colId'),
    },
    nrow,
    ncol,
    idDfPriority: priority,
  };
}

function isImageAnalysisSize(raw: unknown): raw is { width: number; height: number } {
  return (
    raw !== null &&
    typeof raw === 'object' &&
    typeof (raw as Record<string, unknown>).width === 'number' &&
    typeof (raw as Record<string, unknown>).height === 'number' &&
    Number.isFinite((raw as Record<string, unknown>).width) &&
    Number.isFinite((raw as Record<string, unknown>).height)
  );
}

function parseProjectJson(raw: unknown) {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('Project JSON is not an object.');
  }

  const project = raw as Record<string, unknown>;
  const imageName = project.imageName;
  const lowSignalCorrectionEnabled = project.lowSignalCorrectionEnabled;
  const lastExtractionSummary = project.lastExtractionSummary;
  const lastFittingSummary = project.lastFittingSummary;
  const backgroundModelValue = project.backgroundModel;
  const methodMetadataRaw = project.methodMetadata;
  const methodMetadata = methodMetadataRaw !== null
    && typeof methodMetadataRaw === 'object'
    && !Array.isArray(methodMetadataRaw)
    ? methodMetadataRaw
    : null;

  if (imageName !== null && typeof imageName !== 'string') {
    throw new Error('Invalid imageName in project JSON.');
  }

  if (typeof lowSignalCorrectionEnabled !== 'boolean') {
    throw new Error('Invalid lowSignalCorrectionEnabled in project JSON.');
  }

  if (typeof lastExtractionSummary !== 'string' || typeof lastFittingSummary !== 'string') {
    throw new Error('Invalid project summary values in project JSON.');
  }

  const projectGeometry = parseProjectGeometry(project.geometry);
  const floorGeometrySource = parseProjectFloorGeometrySource(project.floorGeometrySource, projectGeometry);
  const projectPlateMap = parseProjectPlateMap(project.plateMap);
  const expectedRefs = parseProjectExpectedRefs(project.expectedRefs);
  const plateMapUnit = typeof project.plateMapUnit === 'string' && project.plateMapUnit.trim() !== ''
    ? project.plateMapUnit
    : 'mM';
  const plateEditorSnapshot = parseProjectPlateEditorSnapshot(project.plateConfigurator);
  const storedCalibrationRaw = project.storedCalibration;
  const storedCalibration = storedCalibrationRaw == null
    ? null
    : parseStoredCalibrationJson(storedCalibrationRaw);

  const roiRadiusFactor = project.roiRadiusFactor;

  if (typeof roiRadiusFactor !== 'number' || !Number.isFinite(roiRadiusFactor)) {
    throw new Error('Invalid roiRadiusFactor in project JSON.');
  }

  const roiModeValue = project.roiMode;
  const roiMode: RoiMode | null =
    roiModeValue === 'simple' || roiModeValue === 'floor-aware' || roiModeValue === 'mouth-floor-intersection'
      ? roiModeValue
      : null;
  const roiPixelStatisticsModeValue = project.roiPixelStatisticsMode;
  const roiPixelStatisticsMode: RoiPixelStatisticsMode | null =
    roiPixelStatisticsModeValue === 'simple-median' || roiPixelStatisticsModeValue === 'robust-trimmed-v1'
      ? roiPixelStatisticsModeValue
      : null;

  const floorRoiRadiusFactorValue = project.floorRoiRadiusFactor;
  const floorRoiRadiusFactor = typeof floorRoiRadiusFactorValue === 'number' && Number.isFinite(floorRoiRadiusFactorValue)
    ? floorRoiRadiusFactorValue
    : null;

  const analysisSize = project.imageAnalysisSize;

  if (analysisSize !== null && !isImageAnalysisSize(analysisSize)) {
    throw new Error('Invalid imageAnalysisSize in project JSON.');
  }

  const backgroundModel: BackgroundModel | null =
    backgroundModelValue === 'robust-interwell-v1' || backgroundModelValue === 'physical-interwell-polynomial-v1'
      ? backgroundModelValue
      : backgroundModelValue === 'annular'
        ? backgroundModelValue
        : null;

  return {
    version: project.version,
    createdAt: typeof project.createdAt === 'string' ? project.createdAt : new Date().toISOString(),
    appVersion: typeof project.appVersion === 'string' ? project.appVersion : 'unknown',
    imageName,
    imageAnalysisSize: analysisSize !== null ? analysisSize : null,
    geometry: projectGeometry,
    floorGeometrySource,
    roiRadiusFactor,
    plateMap: projectPlateMap,
    plateMapUnit,
    plateEditorSnapshot,
    expectedRefs,
    storedCalibration,
    lowSignalCorrectionEnabled,
    lastExtractionSummary,
    lastFittingSummary,
    backgroundModel,
    roiMode,
    roiPixelStatisticsMode,
    floorRoiRadiusFactor,
    methodMetadata,
  };
}

function createProjectFileName(imageName: string | null): string {
  if (!imageName) {
    return 'dqcolorimetry_project.json';
  }

  return `${imageName.replace(/\.[^.]+$/, '')}_dqcolorimetry_project.json`;
}

function createProjectPayload(
  image: HTMLImageElement | null,
  imageName: string | null,
  geometry: PlateGeometry,
  radiusFactor: number,
  plateMap: WellConfig[],
  plateMapUnit: string,
  plateEditorSnapshot: PlateEditorSnapshot | null,
  expectedRefs: ExpectedRef[],
  storedCalibration: StoredCalibration | null,
  lowSignalCorrectionEnabled: boolean,
  backgroundModel: BackgroundModel,
  roiMode: 'simple' | 'floor-aware' | 'mouth-floor-intersection',
  roiPixelStatisticsMode: RoiPixelStatisticsMode,
  floorRoiRadiusFactor: number,
  floorGeometrySource: FloorGeometrySource,
  extractionSummary: string,
  fittingSummary: string,
) {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    appVersion: packageJson.version,
    imageName,
    imageAnalysisSize: image ? getImageAnalysisSize(image) : null,
    geometry: geometryJsonPayload(geometry),
    floorGeometrySource,
    roiRadiusFactor: radiusFactor,
    floorRoiRadiusFactor,
    roiMode,
    roiPixelStatisticsMode,
    plateMap,
    plateMapUnit,
    plateConfigurator: plateEditorSnapshot,
    expectedRefs,
    storedCalibration: storedCalibration ?? null,
    lowSignalCorrectionEnabled,
    lastExtractionSummary: extractionSummary,
    lastFittingSummary: fittingSummary,
    backgroundModel,
    methodMetadata: {
      appVersion: packageJson.version,
      roiMode,
      roiPixelStatisticsMode,
      backgroundModel,
      lowSignalCorrectionEnabled,
      floorGeometrySource,
      roiRadiusFactor: radiusFactor,
      floorRoiRadiusFactor,
      lastExtractionSummary: extractionSummary,
      lastFittingSummary: fittingSummary,
  },
  };
}

function createAnalysisImageData(image: HTMLImageElement, wells: WellCenter[]): ImageData {
  const coordinateSize = getCanvasCoordinateSize(image, wells);
  const canvas = document.createElement('canvas');

  canvas.width = coordinateSize.width;
  canvas.height = coordinateSize.height;

  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new Error('Could not create an analysis canvas.');
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, coordinateSize.width, coordinateSize.height);

  return ctx.getImageData(0, 0, coordinateSize.width, coordinateSize.height);
}

function summarizePlateMapForMetadata(plateMap: WellConfig[]): { wellCount: number; roles: Record<string, number>; rowLabels: string[]; colLabels: number[] } {
  const roles = plateMap.reduce<Record<string, number>>((accumulator, well) => {
    accumulator[well.role] = (accumulator[well.role] ?? 0) + 1;
    return accumulator;
  }, {});

  return {
    wellCount: plateMap.length,
    roles,
    rowLabels: Array.from(new Set(plateMap.map((well) => String(well.row)))).sort(),
    colLabels: Array.from(new Set(plateMap.map((well) => well.col))).sort((a, b) => a - b),
  };
}

function createAnalysisRunConfigMetadata(options: {
  imageName: string | null;
  geometryName: string | null;
  geometrySource: string;
  roiMode: RoiMode;
  roiPixelStatisticsMode: RoiPixelStatisticsMode;
  backgroundModel: BackgroundModel;
  radiusFactor: number;
  floorRoiRadiusFactor: number;
  floorGeometryAvailable: boolean;
  floorCircles: FloorCircle[] | null;
  geometry: PlateGeometry | null;
  wells: WellCenter[];
  plateMap: WellConfig[];
  plateMapUnit: string;
  expectedRefs: ExpectedRef[];
  storedCalibration: StoredCalibration | null;
  sharedGeometryOverride: SharedGeometryOverrideState | null;
  appVersion: string;
  generatedAt: string;
}): Record<string, unknown> {
  return {
    appVersion: options.appVersion,
    generatedAt: options.generatedAt,
    imageName: options.imageName ?? null,
    geometryName: options.geometryName ?? null,
    geometrySource: options.geometrySource,
    roiMode: options.roiMode,
    roiPixelStatisticsMode: options.roiPixelStatisticsMode,
    backgroundModel: options.backgroundModel,
    radiusFactor: options.radiusFactor,
    floorRoiRadiusFactor: options.floorRoiRadiusFactor,
    floorGeometryAvailable: options.floorGeometryAvailable,
    manualMouthGeometry: options.geometry
      ? {
        corner_a1: options.geometry.corner_a1,
        corner_a12: options.geometry.corner_a12,
        corner_h12: options.geometry.corner_h12,
        corner_h1: options.geometry.corner_h1,
        mouth_radius_px: options.geometry.mouth_radius_px ?? null,
      }
      : null,
    floorCircles: options.floorGeometryAvailable && options.floorCircles && options.floorCircles.length === options.wells.length
      ? options.floorCircles.map((circle) => ({ x: circle.x, y: circle.y, r: circle.r }))
      : null,
    sharedGeometryOverride: options.sharedGeometryOverride
      ? {
        sourceName: options.sharedGeometryOverride.sourceName,
        wellCount: options.sharedGeometryOverride.wellCount,
        missingWells: options.sharedGeometryOverride.missingWells,
        ignoredFields: options.sharedGeometryOverride.ignoredFields,
        records: Array.from(options.sharedGeometryOverride.recordsByWell.values()).map((record) => ({
          wellId: record.wellId,
          mouthCx: record.mouthCx,
          mouthCy: record.mouthCy,
          floorCx: record.floorCx,
          floorCy: record.floorCy,
          mouthRadius: record.mouthRadius,
          floorRadius: record.floorRadius,
          floorRadiusGeom: record.floorRadiusGeom ?? null,
          mouthRadiusGeom: record.mouthRadiusGeom ?? null,
          cylRadiusBg: record.cylRadiusBg ?? null,
          localPitchPx: record.localPitchPx ?? null,
          floorSource: record.floorSource ?? null,
        })),
      }
      : null,
    storedCalibration: options.storedCalibration
      ? {
        sourceName: options.storedCalibration.sourceName ?? null,
        createdAt: options.storedCalibration.createdAt ?? null,
        selectedChannel: options.storedCalibration.selectedChannel ?? null,
        fitCount: options.storedCalibration.fits?.length ?? 0,
        channelCount: options.storedCalibration.pythonChannels?.length ?? 0,
      }
      : null,
    expectedRefs: options.expectedRefs.map((expectedRef) => ({
      refId: expectedRef.refId,
      label: expectedRef.label,
      value: expectedRef.value,
      sd: expectedRef.sd,
    })),
    plateMap: {
      unit: options.plateMapUnit,
      summary: summarizePlateMapForMetadata(options.plateMap),
    },
  };
}

function createDiagnosticCanvas(imageData: ImageData): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');

  canvas.width = imageData.width;
  canvas.height = imageData.height;

  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new Error('Could not create a diagnostic canvas.');
  }

  ctx.putImageData(imageData, 0, 0);

  return { canvas, ctx };
}

function drawDiagnosticPixels(
  ctx: CanvasRenderingContext2D,
  pixels: Array<{ x: number; y: number }> | undefined,
  color: string,
  size = 1,
): void {
  if (!pixels || pixels.length === 0) {
    return;
  }

  ctx.save();
  ctx.fillStyle = color;
  pixels.forEach((pixel) => {
    ctx.fillRect(Math.floor(pixel.x), Math.floor(pixel.y), size, size);
  });
  ctx.restore();
}

function drawDiagnosticLabel(ctx: CanvasRenderingContext2D, text: string, x = 12, y = 20): void {
  ctx.save();
  ctx.font = '700 16px Inter, ui-sans-serif, system-ui, sans-serif';
  ctx.textBaseline = 'top';
  const metrics = ctx.measureText(text);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
  ctx.fillRect(x - 6, y - 5, metrics.width + 12, 26);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawCornerWellLabels(ctx: CanvasRenderingContext2D, wells: WellCenter[]): void {
  const cornerIds = new Set(['A1', 'A12', 'H12', 'H1']);

  ctx.save();
  ctx.font = '700 15px Inter, ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  wells.forEach((well) => {
    if (!cornerIds.has(well.wellId)) {
      return;
    }

    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.78)';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.98)';
    ctx.strokeText(well.wellId, well.x, well.y);
    ctx.fillText(well.wellId, well.x, well.y);
  });

  ctx.restore();
}

function drawGeometryCornerDiagnosticMarkers(
  ctx: CanvasRenderingContext2D,
  geometry: PlateGeometry | null,
  wells: WellCenter[],
): void {
  if (!geometry) {
    return;
  }

  const corners = [
    { label: 'A1', picked: geometry.corner_a1, generated: wells.find((well) => well.row === 0 && well.col === 0) },
    { label: 'A12', picked: geometry.corner_a12, generated: wells.find((well) => well.row === 0 && well.col === 11) },
    { label: 'H12', picked: geometry.corner_h12, generated: wells.find((well) => well.row === 7 && well.col === 11) },
    { label: 'H1', picked: geometry.corner_h1, generated: wells.find((well) => well.row === 7 && well.col === 0) },
  ];

  ctx.save();
  ctx.font = '800 14px Inter, ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  corners.forEach(({ label, picked, generated }) => {
    ctx.beginPath();
    ctx.arc(picked.x, picked.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 0, 255, 0.92)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.96)';
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();

    if (generated) {
      ctx.beginPath();
      ctx.moveTo(generated.x - 7, generated.y);
      ctx.lineTo(generated.x + 7, generated.y);
      ctx.moveTo(generated.x, generated.y - 7);
      ctx.lineTo(generated.x, generated.y + 7);
      ctx.strokeStyle = 'rgba(0, 255, 255, 0.98)';
      ctx.lineWidth = 3;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(picked.x, picked.y);
      ctx.lineTo(generated.x, generated.y);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.78)';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.98)';
    ctx.strokeText(`${label} picked/generated`, picked.x + 9, picked.y);
    ctx.fillText(`${label} picked/generated`, picked.x + 9, picked.y);
  });

  ctx.restore();
}

function drawBackgroundDiagnostics(
  ctx: CanvasRenderingContext2D,
  wells: WellCenter[],
  diagnostics: BackgroundVisualDiagnostics,
): void {
  const {
    candidateRegionX0,
    candidateRegionY0,
    candidateRegionX1,
    candidateRegionY1,
    wellExclusionRadiusApprox,
  } = diagnostics.diagnostics;

  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.strokeRect(
    candidateRegionX0,
    candidateRegionY0,
    Math.max(0, candidateRegionX1 - candidateRegionX0),
    Math.max(0, candidateRegionY1 - candidateRegionY0),
  );
  ctx.restore();

  ctx.save();
  ctx.fillStyle = 'rgba(255, 0, 70, 0.08)';
  ctx.strokeStyle = 'rgba(255, 0, 70, 0.28)';
  ctx.lineWidth = 1;
  wells.forEach((well) => {
    if (wellExclusionRadiusApprox <= 0) {
      return;
    }

    ctx.beginPath();
    ctx.arc(well.x, well.y, wellExclusionRadiusApprox, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });
  ctx.restore();

  const stride = Math.max(1, diagnostics.diagnostics.candidateStride);
  drawDiagnosticPixels(ctx, diagnostics.candidatePixels, 'rgba(0, 128, 255, 0.30)', Math.max(1, Math.floor(stride / 2)));
  drawDiagnosticPixels(ctx, diagnostics.acceptedPixels, 'rgba(255, 224, 0, 0.75)', Math.max(1, Math.floor(stride / 2)));
  drawDiagnosticPixels(ctx, diagnostics.samplePixels, 'rgba(255, 0, 255, 0.90)', Math.max(2, Math.floor(stride)));

  drawCornerWellLabels(ctx, wells);
  drawDiagnosticLabel(
    ctx,
    `Background mask: ${diagnostics.diagnostics.maskAlgorithm ?? diagnostics.selectedModel}; candidates ${diagnostics.candidatePixels.length}, accepted ${diagnostics.acceptedPixels.length}, samples ${diagnostics.samplePixels.length}`,
  );

  if (diagnostics.warning) {
    drawDiagnosticLabel(ctx, diagnostics.warning, 12, 50);
  }
}

function buildBackgroundMaskDiagnosticCanvas(
  imageData: ImageData,
  wells: WellCenter[],
  diagnostics: BackgroundVisualDiagnostics,
  geometry: PlateGeometry | null,
): HTMLCanvasElement {
  const { canvas, ctx } = createDiagnosticCanvas(imageData);

  drawBackgroundDiagnostics(ctx, wells, diagnostics);
  drawGeometryCornerDiagnosticMarkers(ctx, geometry, wells);

  return canvas;
}

function rgbFromSample(sample: Rgb): Rgb {
  return {
    r: sample.r,
    g: sample.g,
    b: sample.b,
  };
}

function formatRgbCell(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : MISSING_VALUE;
}

function formatPAbsCell(value: number): string {
  return Number.isFinite(value) ? value.toPrecision(6) : MISSING_VALUE;
}

function formatFitCell(value: number): string {
  return Number.isFinite(value) ? value.toPrecision(6) : MISSING_VALUE;
}

function formatOptionalFitCell(value: number | null | undefined): string {
  return value === null || value === undefined ? MISSING_VALUE : formatFitCell(value);
}

function formatTextCell(value: string): string {
  return value.trim() === '' ? MISSING_VALUE : value;
}

function formatCompactNumberList(values: number[] | undefined): string {
  if (!values || values.length === 0) {
    return MISSING_VALUE;
  }

  return values.map(formatFitCell).join(' | ');
}

function formatCompactTextList(values: string[] | undefined): string {
  if (!values || values.length === 0) {
    return MISSING_VALUE;
  }

  return values.join(' | ');
}

function ResultSection({
  title,
  summary,
  hasData,
  children,
  note,
}: {
  title: string;
  summary: string;
  hasData: boolean;
  children: ReactNode;
  note?: ReactNode;
}) {
  if (!hasData) {
    return (
      <section className="results-panel compact-result-panel" aria-label={title}>
        <div className="results-empty compact-result-empty" role="status">
          <strong>{title}</strong>
          <span>{summary}</span>
        </div>
      </section>
    );
  }

  return (
    <section className="results-panel compact-result-panel" aria-label={title}>
      <details className="result-details" open>
        <summary>
          <strong>{title}</strong>
          <span>{summary}</span>
        </summary>
        {note ? <p className="panel-note result-section-note">{note}</p> : null}
        {children}
      </details>
    </section>
  );
}

const FIT_CHANNEL_COLORS: Record<FitChannel, string> = {
  R: '#cf2e2e',
  G: '#1f8a4c',
  B: '#2563c7',
};

const PYTHON_RESULTS_CHANNELS: FitChannel[] = ['R', 'G', 'B'];
const PYTHON_RESULTS_CHANNEL_LABELS: Record<FitChannel, string> = {
  R: 'PAbs_Red',
  G: 'PAbs_Green',
  B: 'PAbs_Blue',
};

interface PythonResultsPlotPoint {
  x: number;
  y: number;
  yerr?: number;
  n?: number;
}

interface PythonResultsStandardAdditionGroup {
  fit: StandardAdditionFit;
  points: PythonResultsPlotPoint[];
}

interface PythonResultsChannelRank {
  channel: FitChannel;
  score: number;
  r2Cal: number;
  r2Std: number;
  slopeAgreement: number;
  sigmaCal: number;
  sigmaSource: string;
  lod: number;
  loq: number;
  scoreFormula: string;
}

function pabsChannelValue(measurement: WellMeasurement, channel: FitChannel): number {
  if (channel === 'R') {
    return measurement.pabs.r;
  }

  if (channel === 'G') {
    return measurement.pabs.g;
  }

  return measurement.pabs.b;
}

function safePythonResultsBaseName(imageName: string | null): string {
  const rawBase = (imageName ?? 'TIPICA').replace(/\.[^.]+$/, '').trim() || 'TIPICA';
  const safe = rawBase
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();

  return safe || 'TIPICA';
}

function addZipBlob(
  files: { name: string; blob: Blob }[],
  name: string,
  blob: Blob,
): void {
  files.push({ name, blob });
}

function createPythonResultsCaptionText(imageBase: string, unitLabel: string, expectedRefs: ExpectedRef[]): string {
  const referenceLines = expectedRefs.length > 0
    ? expectedRefs.map((ref, index) => {
      const label = ref.label || ref.refId || `Reference ${index + 1}`;
      const sdText = ref.sd !== null && Number.isFinite(ref.sd) ? ` +/- ${formatFitCell(ref.sd)}` : '';
      return `- ${label}: ${formatFitCell(ref.value)}${sdText} ${unitLabel}`;
    }).join('\n')
    : '- No external reference values were configured.';

  return `RESULTS caption - RGB quantitative output

File scope
This caption applies to the primary RGB outputs in the RESULTS folder for ${imageBase}, especially the *_FIGURE_RGB.png and *_REPORT.xlsx files.

Analytical signal
The primary RGB signal is pseudo-absorbance, reported as PAbs_Red, PAbs_Green and PAbs_Blue:
    PAbs = log10(I_BG / I_well) = -log10(I_well / I_BG)
where I_well is the linearized median intensity from the well ROI and I_BG is the linearized local inter-well background predicted for that well. This is an image-derived pseudo-absorbance and is not assumed to be a spectrophotometric absorbance.

Fitting and quantification
Calibration and standard-addition fits in the primary RGB export path use the Python robust residual-based IRLS linear regression port with covariance propagation. Full fitting parity across every Python workflow path remains under validation. For standard addition, the original-sample concentration is C0 = DF x q/m, where y = m x + q and x is the added concentration.

Ranking score
For methods with both calibration and standard addition, the Python desktop global score is:
    GlobalScore = slope_agreement^2 x sqrt(R2_cal x R2_std) x (1/LOQ)
with slope_agreement = min(|m_cal|, |m_std|) / max(|m_cal|, |m_std|). This web export computes LOQ for PNG channel selection from the median calibration replicate SD when that SD is available, following the current Python-style ranking helper. If LOQ is unavailable, the browser fallback uses the fit-only common factors. Expected/reference values, recovery, SNR and clipping are external checks and are not used to choose the ranked RGB method.

Reference values and recovery
External reference values, when provided, are used only for external comparison (Delta and recovery). They are not used to choose the ranked RGB method.
${referenceLines}

Quality control
Image, plate, geometry and floor-QC messages are alerts on data quality. No automatic image correction is applied.

Geometry and epsilon/path-length quantification
When epsilon-based unknown quantification is used, the Python desktop estimates optical path length from configured liquid volume and nominal flat-bottom well area. This web milestone does not implement epsilon/path-length quantification; when added, it must assume ANSI/SLAS-compatible flat-bottom microplate geometry and flag non-flat or non-certified geometries for separate validation.

Units
Reported concentrations are expressed in ${unitLabel}.
`;
}

function createPythonRawDataDetailsCaptionText(imageBase: string, unitLabel: string): string {
  return `RAW_DATA_DETAILS caption - diagnostics and method-development outputs

File scope
This caption applies to diagnostic outputs in RAW_DATA_DETAILS for ${imageBase}: BG_STAT_MASK.png, FIGURE_CIELAB_DELTAE.png, METHOD_COMPARISON.png and DIAGNOSTICS.xlsx.

BG_STAT_MASK.png
Current web export shows the accepted inter-well background sampling mask overlaid on the analyzed image. It supports auditability of background sampling and does not change calculations; the exact Python binary-mask rendering is not yet reproduced.

FIGURE_CIELAB_DELTAE.png
Python-style CIELAB/DeltaE fitting/report figure with plate preview, descriptor fitting panels, reference values, C0/Score/Delta/Recovery tables, calibration and standard-addition summaries. The exported CIELAB/DeltaE fit rows use the robust IRLS helper, but full CIELAB parity also depends on descriptor-input parity.

METHOD_COMPARISON.png
Cross-method diagnostic comparison for currently available webapp methods. Score uses common fit-quality factors; external reference values and recovery checks are displayed as checks and do not affect ranking.

DIAGNOSTICS.xlsx
Python-style diagnostic workbook with available background, ROI, geometry, spatial, method-comparison and CIELAB fitting tables. Fields not computed by the webapp are left blank.

WEB_BG_MODEL_PROOF.xlsx
Supplemental web-only workbook preserving browser background-model proof tables that are not part of the Python DIAGNOSTICS.xlsx schema. These tables support auditability of the web background-model implementation and do not change calculations.

Geometry and epsilon/path-length quantification
When epsilon-based unknown quantification is used, the Python desktop estimates optical path length from configured liquid volume and nominal flat-bottom well area. This web milestone does not implement epsilon/path-length quantification; non-flat or non-certified geometries require separate validation.

Units
Reported concentrations are expressed in ${unitLabel}.
`;
}

type XlsxCellValue = string | number | boolean | null | undefined;
type XlsxRow = Record<string, XlsxCellValue>;

interface XlsxSheet {
  name: string;
  rows: XlsxCellValue[][];
}

const REPORT_RGB_CHANNELS: FitChannel[] = ['R', 'G', 'B'];

interface PythonReportWorkbookOptions {
  imageBase: string;
  imageName: string | null;
  imageQcInfo?: PythonImageQcInfo;
  unitLabel: string;
  selectedChannel: FitChannel;
  generatedAt: string;
  measurements: WellMeasurement[];
  displayMeasurements: WellMeasurement[];
  plateMap: WellConfig[];
  calibrationFits: CalibrationFit[];
  standardAdditionFits: StandardAdditionFit[];
  unknownResults: UnknownConcentrationResult[];
  expectedRefs: ExpectedRef[];
  rankings: PythonResultsChannelRank[];
  methodMetadata: MethodMetadata;
  geometryName: string | null;
  geometrySource: string;
  floorGeometryAvailable: boolean;
  correctionApplied: boolean;
  lowSignalCorrections: RgbLowSignalCorrection[];
  correctionApplications: WellChannelCorrectionApplication[];
  sharedGeometryOverride: SharedGeometryOverrideState | null;
  storedCalibration: StoredCalibration | null;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function excelColumnName(index: number): string {
  let column = '';
  let value = index + 1;

  while (value > 0) {
    const remainder = (value - 1) % 26;
    column = String.fromCharCode(65 + remainder) + column;
    value = Math.floor((value - 1) / 26);
  }

  return column;
}

function xlsxCellXml(value: XlsxCellValue, rowIndex: number, columnIndex: number): string {
  const ref = `${excelColumnName(columnIndex)}${rowIndex + 1}`;

  if (value === null || value === undefined || value === '') {
    return `<c r="${ref}"/>`;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? `<c r="${ref}" t="n"><v>${value}</v></c>`
      : `<c r="${ref}"/>`;
  }

  if (typeof value === 'boolean') {
    return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }

  return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
}

function xlsxWorksheetXml(rows: XlsxCellValue[][]): string {
  const sheetRows = rows.map((row, rowIndex) => (
    `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => xlsxCellXml(value, rowIndex, columnIndex)).join('')}</row>`
  )).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${sheetRows}</sheetData>
</worksheet>`;
}

function tableRows(headers: string[], rows: XlsxRow[]): XlsxCellValue[][] {
  return [
    headers,
    ...rows.map((row) => headers.map((header) => row[header] ?? '')),
  ];
}

async function createXlsxWorkbookBlob(sheets: XlsxSheet[]): Promise<Blob> {
  const contentTypeOverrides = sheets.map((_, index) => (
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  )).join('');
  const workbookSheets = sheets.map((sheet, index) => (
    `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
  )).join('');
  const workbookRelationships = sheets.map((_, index) => (
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
  )).join('');
  const xlsxFiles = [
    {
      name: '[Content_Types].xml',
      blob: new Blob([`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${contentTypeOverrides}
</Types>`], { type: 'application/xml' }),
    },
    {
      name: '_rels/.rels',
      blob: new Blob([`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`], { type: 'application/xml' }),
    },
    {
      name: 'xl/workbook.xml',
      blob: new Blob([`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${workbookSheets}</sheets>
</workbook>`], { type: 'application/xml' }),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      blob: new Blob([`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${workbookRelationships}
  <Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`], { type: 'application/xml' }),
    },
    {
      name: 'xl/styles.xml',
      blob: new Blob([`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`], { type: 'application/xml' }),
    },
    ...sheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      blob: new Blob([xlsxWorksheetXml(sheet.rows)], { type: 'application/xml' }),
    })),
  ];

  return createZipBlob(xlsxFiles);
}

function reportChannelName(channel: FitChannel): string {
  return PYTHON_RESULTS_CHANNEL_LABELS[channel];
}

function calibrationFitsFromStoredCalibration(calibration: StoredCalibration | null): CalibrationFit[] {
  if (!calibration) {
    return [];
  }

  return calibration.fits.map((fit) => ({
    channel: fit.channel,
    slope: fit.slope,
    intercept: fit.intercept,
    r2: fit.r2,
    rmse: fit.rmse,
    n: fit.n,
    sigmaCal: fit.sigmaCal,
    sigmaSource: fit.sigmaSource,
    snr: fit.snr,
    lod: fit.lod,
    loq: fit.loq,
    S0: fit.S0,
    meanClipDelta: null,
    clipX: fit.clipX,
    clipDelta: fit.clipDelta,
    source: 'stored_calibration',
  }));
}

function storedCalibrationDiagnosticFitRows(calibration: StoredCalibration | null): XlsxRow[] {
  if (!calibration?.pythonChannels) {
    return [];
  }

  return calibration.pythonChannels.filter((fit) => ![
    'Signal_Red',
    'Signal_Green',
    'Signal_Blue',
    'PAbs_Red',
    'PAbs_Green',
    'PAbs_Blue',
    'Red',
    'Green',
    'Blue',
  ].includes(fit.channel)).map((fit) => ({
    Channel: fit.channel.replace(/^Signal_/, 'PAbs_'),
    FitType: 'Calibration',
    ID: '',
    DF: '',
    n_points: fit.n,
    m: fit.slope,
    q: fit.intercept,
    R2: fit.r2,
    RMSE: fit.rmse ?? '',
    sigma_cal: fit.sigmaCal ?? '',
    sigma_source: fit.sigmaSource ?? '',
    SNR: fit.snr ?? '',
    LOD: fit.lod ?? '',
    LOQ: fit.loq ?? '',
    C0: '',
    C0_sd: '',
    beta_k: '',
    bias_index_k: '',
    S0_calibration: fit.S0 ?? '',
    S0_applied: fit.S0 ?? '',
    NClipPoints: fit.nClipPoints ?? '',
    ClipX: fit.clipX ?? '',
    ClipDelta: fit.clipDelta ?? '',
  }));
}

function reportFitSignalSourceLabel(channel: FitChannel, corrected: boolean): string {
  return `PAbs_${channel}${corrected ? '_corrected' : ''}`;
}

function channelFieldSuffix(channel: FitChannel): 'Red' | 'Green' | 'Blue' {
  if (channel === 'R') {
    return 'Red';
  }

  if (channel === 'G') {
    return 'Green';
  }

  return 'Blue';
}

function buildCorrectionApplicationLookup(
  applications: WellChannelCorrectionApplication[],
): Map<string, Map<FitChannel, WellChannelCorrectionApplication>> {
  const lookup = new Map<string, Map<FitChannel, WellChannelCorrectionApplication>>();

  for (const application of applications) {
    const byChannel = lookup.get(application.wellId) ?? new Map<FitChannel, WellChannelCorrectionApplication>();
    byChannel.set(application.channel, application);
    lookup.set(application.wellId, byChannel);
  }

  return lookup;
}

function correctionForWellChannel(
  lookup: Map<string, Map<FitChannel, WellChannelCorrectionApplication>>,
  wellId: string,
  channel: FitChannel,
): WellChannelCorrectionApplication | null {
  return lookup.get(wellId)?.get(channel) ?? null;
}

function correctionForChannel(
  corrections: RgbLowSignalCorrection[],
  channel: FitChannel,
): RgbLowSignalCorrection | null {
  return corrections.find((correction) => correction.channel === channel) ?? null;
}

function joinedNumberCell(values: Array<number | '' | null | undefined>): string {
  if (values.length === 0) {
    return '';
  }

  return values.map((value) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : '')).join(',');
}

function groupedMedianPoints(points: { x: number; y: number }[]): { x: number; y: number }[] {
  return groupedMedianRows(points)
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .sort((a, b) => a.x - b.x);
}

function collectCalibrationMedianPointsForChannel(
  channel: FitChannel,
  measurements: WellMeasurement[],
  plateMap: WellConfig[],
): { x: number; y: number }[] {
  const measurementByWell = new Map(measurements.map((measurement) => [measurement.wellId, measurement]));
  const points: { x: number; y: number }[] = [];

  plateMap.forEach((well) => {
    if (well.role !== 'C' || well.concentration === null || !Number.isFinite(well.concentration)) {
      return;
    }

    const measurement = measurementByWell.get(well.wellId);
    const y = measurement ? pabsChannelValue(measurement, channel) : Number.NaN;

    if (!Number.isFinite(y)) {
      return;
    }

    points.push({ x: well.concentration, y });
  });

  return groupedMedianPoints(points);
}

function collectStandardAdditionMedianPointsForChannel(
  fit: StandardAdditionFit,
  channel: FitChannel,
  measurements: WellMeasurement[],
  plateMap: WellConfig[],
): { x: number; y: number }[] {
  const measurementByWell = new Map(measurements.map((measurement) => [measurement.wellId, measurement]));
  const sampleId = fit.sampleId.trim();
  const points: { x: number; y: number }[] = [];

  plateMap.forEach((well) => {
    if (
      well.role !== 'A' ||
      well.sampleId.trim() !== sampleId ||
      well.concentration === null ||
      !Number.isFinite(well.concentration)
    ) {
      return;
    }

    const dilutionFactor = Number.isFinite(well.dilutionFactor) ? well.dilutionFactor : 1;
    if (Math.abs(dilutionFactor - fit.dilutionFactor) > 1e-12) {
      return;
    }

    const measurement = measurementByWell.get(well.wellId);
    const y = measurement ? pabsChannelValue(measurement, channel) : Number.NaN;

    if (!Number.isFinite(y)) {
      return;
    }

    points.push({ x: well.concentration, y });
  });

  return groupedMedianPoints(points);
}

function alignedYValues(points: { x: number; y: number }[], xValues: number[]): Array<number | ''> {
  const pointByX = new Map(points.map((point) => [point.x, point.y]));
  return xValues.map((x) => (Number.isFinite(x) && Number.isFinite(pointByX.get(x) ?? Number.NaN) ? pointByX.get(x) ?? '' : ''));
}

function alignedClipValues(correction: RgbLowSignalCorrection | null, xValues: number[]): {
  clipDelta: Array<number | ''>;
  yObserved: Array<number | ''>;
  yShifted: Array<number | ''>;
  yExpected: Array<number | ''>;
  yCorrected: Array<number | ''>;
  threshold: Array<number | ''>;
} {
  if (!correction) {
    return {
      clipDelta: xValues.map(() => ''),
      yObserved: xValues.map(() => ''),
      yShifted: xValues.map(() => ''),
      yExpected: xValues.map(() => ''),
      yCorrected: xValues.map(() => ''),
      threshold: xValues.map(() => ''),
    };
  }

  const clipPointByX = new Map(correction.clipPoints.map((point) => [point.concentration, point]));

  return {
    clipDelta: xValues.map((x) => clipPointByX.get(x)?.clipDelta ?? ''),
    yObserved: xValues.map((x) => clipPointByX.get(x)?.yRaw ?? ''),
    yShifted: xValues.map((x) => clipPointByX.get(x)?.yShifted ?? ''),
    yExpected: xValues.map((x) => clipPointByX.get(x)?.yExpected ?? ''),
    yCorrected: xValues.map((x) => {
      const point = clipPointByX.get(x);
      return point ? point.yShifted + point.clipDelta : '';
    }),
    threshold: xValues.map((x) => clipPointByX.get(x)?.threshold ?? ''),
  };
}

function sampleSdOrBlank(values: number[]): number | '' {
  const finiteValues = values.filter(Number.isFinite);
  return finiteValues.length >= 2 ? sampleStandardDeviation(finiteValues) : '';
}

function meanOrBlank(values: number[]): number | '' {
  const value = meanFinite(values);
  return Number.isFinite(value) ? value : '';
}

function medianOrBlank(values: number[]): number | '' {
  const value = medianFinite(values);
  return Number.isFinite(value) ? value : '';
}

function robustSdOrBlank(values: number[]): number | '' {
  const finite = values.filter(Number.isFinite);

  if (finite.length < 2) {
    return '';
  }

  const center = medianFinite(finite);
  const mad = medianFinite(finite.map((value) => Math.abs(value - center)));
  const robustSd = 1.4826 * mad;

  return Number.isFinite(robustSd) ? robustSd : '';
}

function finiteRmse(points: { x: number; y: number }[], slope: number, intercept: number): number | '' {
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) {
    return '';
  }

  const residuals = points
    .map((point) => (Number.isFinite(point.x) && Number.isFinite(point.y) ? point.y - (slope * point.x + intercept) : Number.NaN))
    .filter(Number.isFinite);

  if (residuals.length === 0) {
    return '';
  }

  return Math.sqrt(residuals.reduce((sum, residual) => sum + residual ** 2, 0) / residuals.length);
}

function groupedMedianRows(points: { x: number; y: number }[]): { x: number; y: number }[] {
  const groups = new Map<number, number[]>();

  points.forEach((point) => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return;
    }

    const values = groups.get(point.x) ?? [];
    values.push(point.y);
    groups.set(point.x, values);
  });

  return [...groups.entries()]
    .map(([x, values]) => ({ x, y: medianFinite(values) }))
    .filter((point) => Number.isFinite(point.y))
    .sort((a, b) => a.x - b.x);
}

function expectedRefKey(label: string, index: number): string {
  const trimmed = label.trim();
  const fallback = `Expected_${index}`;
  const base = trimmed || fallback;
  const safe = base
    .replace(/[^A-Za-z0-9_ \/\\-]+/g, '')
    .replace(/[ \/\\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return safe || fallback;
}

function referenceMatchesSample(ref: ExpectedRef, sampleId: string): boolean {
  const refId = ref.refId.trim().toLowerCase();
  const label = ref.label.trim().toLowerCase();
  const sample = sampleId.trim().toLowerCase();
  return Boolean(sample && (sample === refId || sample === label));
}

function buildReportRawRows(
  measurements: WellMeasurement[],
  displayMeasurements: WellMeasurement[],
  plateMap: WellConfig[],
  correctionApplications: WellChannelCorrectionApplication[],
  storedCielabReference?: StoredCielabReference,
): XlsxRow[] {
  const configByWell = new Map(plateMap.map((well) => [well.wellId, well]));
  const displayByWell = new Map(displayMeasurements.map((measurement) => [measurement.wellId, measurement]));
  const correctionLookup = buildCorrectionApplicationLookup(correctionApplications);
  const { points: cielabPoints, referenceSource } = buildCielabDiagnosticPoints(displayMeasurements, plateMap, storedCielabReference);
  const cielabByWell = new Map(cielabPoints.map((point) => [point.wellId, point]));

  return measurements.filter((measurement) => configByWell.get(measurement.wellId)?.role !== 'EMPTY').map((measurement) => {
    const config = configByWell.get(measurement.wellId);
    const parsed = parseWellPosition(measurement.wellId);
    const cielab = cielabByWell.get(measurement.wellId);
    const wellLinear = linearizeRgb(measurement.rgbWell);
    const backgroundLinear = linearizeRgb(measurement.rgbBackground);
    const signalTRed = backgroundLinear.r > 0 ? wellLinear.r / backgroundLinear.r : Number.NaN;
    const signalTGreen = backgroundLinear.g > 0 ? wellLinear.g / backgroundLinear.g : Number.NaN;
    const signalTBlue = backgroundLinear.b > 0 ? wellLinear.b / backgroundLinear.b : Number.NaN;
    const auditFields = REPORT_RGB_CHANNELS.reduce<XlsxRow>((acc, channel) => {
      const suffix = channelFieldSuffix(channel);
      const rawValue = pabsChannelValue(measurement, channel);
      const exportedValue = rawValue;

      acc[`PAbs_${suffix}_raw`] = finiteOrBlank(rawValue);
      acc[`PAbs_${suffix}_exported`] = finiteOrBlank(exportedValue);
      acc[`PAbs_${suffix}_correction_delta`] = Number.isFinite(rawValue) && Number.isFinite(exportedValue)
        ? exportedValue - rawValue
        : '';
      acc[`S0_${suffix}_applied`] = '';
      acc[`ClipDelta_${suffix}_applied`] = '';
      acc[`TotalDelta_${suffix}_applied`] = '';
      return acc;
    }, {});

    return {
      Row: parsed ? rowLabel(parsed.row) : rowLabel(measurement.row),
      Col: parsed ? parsed.col + 1 : measurement.col + 1,
      Well: measurement.wellId,
      ID: config?.sampleId ?? '',
      Type: config?.role ?? '',
      Conc: config?.concentration ?? '',
      DF: config?.dilutionFactor ?? '',
      MeanW_Red: wellLinear.r,
      MeanW_Green: wellLinear.g,
      MeanW_Blue: wellLinear.b,
      MeanBG_Red: backgroundLinear.r,
      MeanBG_Green: backgroundLinear.g,
      MeanBG_Blue: backgroundLinear.b,
      SignalT_Red: Number.isFinite(signalTRed) ? signalTRed : '',
      SignalT_Green: Number.isFinite(signalTGreen) ? signalTGreen : '',
      SignalT_Blue: Number.isFinite(signalTBlue) ? signalTBlue : '',
      PAbs_Red: measurement.pabs.r,
      PAbs_Green: measurement.pabs.g,
      PAbs_Blue: measurement.pabs.b,
      L: finiteOrBlank(cielab?.l),
      a: finiteOrBlank(cielab?.a),
      b: finiteOrBlank(cielab?.b),
      DeltaL: finiteOrBlank(typeof cielab?.deltaL === 'number' ? cielab.deltaL : Number.NaN),
      Deltaa: finiteOrBlank(typeof cielab?.deltaA === 'number' ? cielab.deltaA : Number.NaN),
      Deltab: finiteOrBlank(typeof cielab?.deltaB === 'number' ? cielab.deltaB : Number.NaN),
      DeltaE_ab: finiteOrBlank(typeof cielab?.deltaE === 'number' ? cielab.deltaE : Number.NaN),
      DeltaE_ab_chroma: finiteOrBlank(typeof cielab?.deltaEChroma === 'number' ? cielab.deltaEChroma : Number.NaN),
      CIELAB_ref_source: referenceSource,
      ImageWarning: measurement.warnings.length > 0 || Boolean(measurement.roiStatisticsWarning || measurement.geometryAlignmentWarning) ? 1 : 0,
      ...auditFields,
    };
  });
}

function buildReportReplicateRows(
  measurements: WellMeasurement[],
  displayMeasurements: WellMeasurement[],
  plateMap: WellConfig[],
  correctionApplications: WellChannelCorrectionApplication[],
  storedCielabReference?: StoredCielabReference,
): XlsxRow[] {
  const configByWell = new Map(plateMap.map((well) => [well.wellId, well]));
  const measurementByWell = new Map(measurements.map((measurement) => [measurement.wellId, measurement]));
  const correctionLookup = buildCorrectionApplicationLookup(correctionApplications);
  const { points: cielabPoints, referenceSource } = buildCielabDiagnosticPoints(displayMeasurements, plateMap, storedCielabReference);
  const cielabByWell = new Map(cielabPoints.map((point) => [point.wellId, point]));
  const groups = new Map<string, { config: WellConfig; measurements: WellMeasurement[] }>();

  displayMeasurements.forEach((measurement) => {
    const config = configByWell.get(measurement.wellId);
    if (!config || config.role === 'EMPTY') {
      return;
    }

    const key = [
      config.sampleId.trim(),
      config.role,
      config.concentration ?? '',
      Number.isFinite(config.dilutionFactor) ? config.dilutionFactor : 1,
    ].join('|');
    const group = groups.get(key);

    if (group) {
      group.measurements.push(measurement);
    } else {
      groups.set(key, { config, measurements: [measurement] });
    }
  });

  return [...groups.values()]
    .sort((a, b) => (
      String(a.config.role).localeCompare(String(b.config.role)) ||
      a.config.sampleId.localeCompare(b.config.sampleId) ||
      (a.config.concentration ?? -Infinity) - (b.config.concentration ?? -Infinity) ||
      a.config.dilutionFactor - b.config.dilutionFactor
    ))
    .map(({ config, measurements: groupMeasurements }) => {
      const rawGroupMeasurements = groupMeasurements.map((measurement) => measurementByWell.get(measurement.wellId) ?? measurement);
      const pabsRed = rawGroupMeasurements.map((measurement) => measurement.pabs.r);
      const pabsGreen = rawGroupMeasurements.map((measurement) => measurement.pabs.g);
      const pabsBlue = rawGroupMeasurements.map((measurement) => measurement.pabs.b);
      const rawPabsRed = rawGroupMeasurements.map((measurement) => measurement.pabs.r);
      const rawPabsGreen = rawGroupMeasurements.map((measurement) => measurement.pabs.g);
      const rawPabsBlue = rawGroupMeasurements.map((measurement) => measurement.pabs.b);
      const groupCielab = groupMeasurements.map((measurement) => cielabByWell.get(measurement.wellId)).filter((point): point is CielabDiagnosticPoint => Boolean(point));
      const labValues = {
        l: groupCielab.map((point) => point.l),
        a: groupCielab.map((point) => point.a),
        b: groupCielab.map((point) => point.b),
        deltaL: groupCielab.map((point) => cielabValueAsNumber(point.deltaL)),
        deltaA: groupCielab.map((point) => cielabValueAsNumber(point.deltaA)),
        deltaB: groupCielab.map((point) => cielabValueAsNumber(point.deltaB)),
        deltaE: groupCielab.map((point) => cielabValueAsNumber(point.deltaE)),
        deltaEChroma: groupCielab.map((point) => cielabValueAsNumber(point.deltaEChroma)),
      };
      const warningCount = groupMeasurements.filter((measurement) => measurement.warnings.length > 0 || measurement.roiStatisticsWarning).length;
      const criticalCount = groupMeasurements.filter((measurement) => (
        [...measurement.warnings, measurement.roiStatisticsWarning ?? '', measurement.geometryAlignmentWarning ?? '']
          .some((warning) => warning.toLowerCase().includes('critical'))
      )).length;
      const fitInputApplies = config.role === 'C' || config.role === 'A';
      const auditFields = REPORT_RGB_CHANNELS.reduce<XlsxRow>((acc, channel) => {
        const suffix = channelFieldSuffix(channel);
        const displayValues = groupMeasurements.map((measurement) => pabsChannelValue(measurement, channel));
        const rawValues = rawGroupMeasurements.map((measurement) => pabsChannelValue(measurement, channel));
        const applicationValues = groupMeasurements
          .map((measurement) => correctionForWellChannel(correctionLookup, measurement.wellId, channel))
          .filter((application): application is WellChannelCorrectionApplication => Boolean(application?.correctionApplied));
        const rawMedian = medianOrBlank(rawValues);
        const rawSd = robustSdOrBlank(rawValues);
        const fitInputMedian = fitInputApplies ? medianOrBlank(displayValues) : '';
        const fitInputSd = fitInputApplies ? robustSdOrBlank(displayValues) : '';
        const numericRawMedian = typeof rawMedian === 'number' ? rawMedian : Number.NaN;
        const numericFitInputMedian = typeof fitInputMedian === 'number' ? fitInputMedian : Number.NaN;

        acc[`PAbs_${suffix}_raw_median`] = rawMedian;
        acc[`PAbs_${suffix}_raw_sd`] = rawSd;
        acc[`PAbs_${suffix}_fit_input_median`] = fitInputMedian;
        acc[`PAbs_${suffix}_fit_input_sd`] = fitInputSd;
        acc[`PAbs_${suffix}_fit_input_delta`] = Number.isFinite(numericRawMedian) && Number.isFinite(numericFitInputMedian)
          ? numericFitInputMedian - numericRawMedian
          : '';
        acc[`S0_${suffix}_fit_input`] = applicationValues.length > 0 ? medianOrBlank(applicationValues.map((application) => application.S0)) : '';
        acc[`ClipDelta_${suffix}_fit_input`] = applicationValues.length > 0 ? medianOrBlank(applicationValues.map((application) => application.clipDelta)) : '';
        acc[`TotalDelta_${suffix}_fit_input`] = applicationValues.length > 0 ? medianOrBlank(applicationValues.map((application) => application.totalDelta)) : '';
        return acc;
      }, {});

      return {
        ID: config.sampleId,
        DF: config.dilutionFactor,
        Type: config.role,
        Conc: config.concentration ?? '',
        PAbs_Red_median: medianOrBlank(pabsRed),
        PAbs_Red_sd: robustSdOrBlank(pabsRed),
        PAbs_Green_median: medianOrBlank(pabsGreen),
        PAbs_Green_sd: robustSdOrBlank(pabsGreen),
        PAbs_Blue_median: medianOrBlank(pabsBlue),
        PAbs_Blue_sd: robustSdOrBlank(pabsBlue),
        L_median: medianOrBlank(labValues.l),
        L_sd: robustSdOrBlank(labValues.l),
        a_median: medianOrBlank(labValues.a),
        a_sd: robustSdOrBlank(labValues.a),
        b_median: medianOrBlank(labValues.b),
        b_sd: robustSdOrBlank(labValues.b),
        DeltaL_median: medianOrBlank(labValues.deltaL),
        DeltaL_sd: robustSdOrBlank(labValues.deltaL),
        Deltaa_median: medianOrBlank(labValues.deltaA),
        Deltaa_sd: robustSdOrBlank(labValues.deltaA),
        Deltab_median: medianOrBlank(labValues.deltaB),
        Deltab_sd: robustSdOrBlank(labValues.deltaB),
        DeltaE_ab_median: medianOrBlank(labValues.deltaE),
        DeltaE_ab_sd: robustSdOrBlank(labValues.deltaE),
        DeltaE_ab_chroma_median: medianOrBlank(labValues.deltaEChroma),
        DeltaE_ab_chroma_sd: robustSdOrBlank(labValues.deltaEChroma),
        CIELAB_ref_source: referenceSource,
        NReplicates: groupMeasurements.length,
        QCFlagged: warningCount > 0 ? 1 : 0,
        QCCritical: criticalCount > 0 ? 1 : 0,
        ...auditFields,
      };
    });
}

function buildReportFitRows(
  measurements: WellMeasurement[],
  calibrationFits: CalibrationFit[],
  standardAdditionFits: StandardAdditionFit[],
  unknownResults: UnknownConcentrationResult[],
  displayMeasurements: WellMeasurement[],
  plateMap: WellConfig[],
  rankings: PythonResultsChannelRank[],
  lowSignalCorrections: RgbLowSignalCorrection[],
): XlsxRow[] {
  const rows: XlsxRow[] = [];
  const rankingByChannel = new Map(rankings.map((ranking) => [ranking.channel, ranking]));

  calibrationFits.forEach((fit) => {
    const pointRows = collectCalibrationMedianPointsForChannel(fit.channel, displayMeasurements, plateMap);
    const rawPointRows = collectCalibrationMedianPointsForChannel(fit.channel, measurements, plateMap);
    const ranking = rankingByChannel.get(fit.channel);
    // Prefer stored calibration reported sigma/LOQ when the fit originates from a stored calibration payload.
    const isStoredCalibration = (fit as any).source === 'stored_calibration';
    let sigmaCal = isStoredCalibration
      ? (Number.isFinite(fit.sigmaCal ?? Number.NaN) ? fit.sigmaCal as number : (Number.isFinite(ranking?.sigmaCal ?? Number.NaN) ? ranking!.sigmaCal : Number.NaN))
      : (fit.sigmaCal ?? ranking?.sigmaCal ?? Number.NaN);
    let sigmaSource = isStoredCalibration
      ? (Number.isFinite(fit.sigmaCal ?? Number.NaN) ? (fit.sigmaSource ?? 'stored_calibration') : (ranking?.sigmaSource ?? ''))
      : (fit.sigmaSource ?? ranking?.sigmaSource ?? '');
    let lodValue = isStoredCalibration
      ? (Number.isFinite(fit.lod ?? Number.NaN) ? fit.lod as number : (Number.isFinite(ranking?.lod ?? Number.NaN) ? ranking!.lod : Number.NaN))
      : (Number.isFinite(fit.lod ?? Number.NaN) ? fit.lod as number : (Number.isFinite(ranking?.lod ?? Number.NaN) ? ranking!.lod : Number.NaN));
    let loqValue = isStoredCalibration
      ? (Number.isFinite(fit.loq ?? Number.NaN) ? fit.loq as number : (Number.isFinite(ranking?.loq ?? Number.NaN) ? ranking!.loq : Number.NaN))
      : (Number.isFinite(fit.loq ?? Number.NaN) ? fit.loq as number : (Number.isFinite(ranking?.loq ?? Number.NaN) ? ranking!.loq : Number.NaN));

    // If stored calibration fit lacked sigma/LOQ, attempt to estimate sigma from the stored calibration calibration points
    // using the same estimator as the Python ranking helper, and compute LOD/LOQ from it when possible.
    if (isStoredCalibration && !Number.isFinite(sigmaCal)) {
      const estimated = estimateSigmaForPythonResultsLoq(pointRows);
      if (Number.isFinite(estimated.sigma)) {
        sigmaCal = estimated.sigma;
        if (!sigmaSource) {
          sigmaSource = estimated.source;
        }
      }
    }

    if (isStoredCalibration && !Number.isFinite(lodValue) && Number.isFinite(sigmaCal) && Number.isFinite(fit.slope) && Math.abs(fit.slope) > 1e-15) {
      lodValue = (3 * sigmaCal) / Math.abs(fit.slope);
    }
    if (isStoredCalibration && !Number.isFinite(loqValue) && Number.isFinite(sigmaCal) && Number.isFinite(fit.slope) && Math.abs(fit.slope) > 1e-15) {
      loqValue = (10 * sigmaCal) / Math.abs(fit.slope);
    }
    const correction = correctionForChannel(lowSignalCorrections, fit.channel);
    const fitX = pointRows.map((point) => point.x);
    const rawY = alignedYValues(rawPointRows, fitX);
    const fitY = pointRows.map((point) => point.y);
    const clipAudit = alignedClipValues(correction, fitX);

    rows.push({
      Channel: reportChannelName(fit.channel),
      FitType: 'Calibration',
      n_points: fit.n,
      m: fit.slope,
      q: fit.intercept,
      R2: fit.r2,
      RMSE: Number.isFinite(fit.rmse ?? Number.NaN) ? fit.rmse as number : finiteRmse(pointRows, fit.slope, fit.intercept),
      sigma_cal: Number.isFinite(sigmaCal) ? sigmaCal : '',
      sigma_source: sigmaSource ?? '',
      SNR: Number.isFinite(fit.snr ?? Number.NaN) ? fit.snr as number : Number.isFinite(sigmaCal) && sigmaCal > 0 ? Math.abs(fit.slope) / sigmaCal : '',
      LOD: Number.isFinite(lodValue) ? lodValue : '',
      LOQ: Number.isFinite(loqValue) ? loqValue : '',
      S0_calibration: fit.S0 ?? '',
      S0_applied: fit.S0 ?? '',
      NClipPoints: correction?.nClipPoints ?? '',
      ClipX: fit.clipX ?? (correction ? joinedNumberCell(correction.clipPoints.map((point) => point.concentration)) : ''),
      ClipDelta: fit.clipDelta ?? fit.meanClipDelta ?? '',
      FitSignalSource: reportFitSignalSourceLabel(fit.channel, Boolean(fit.correctionApplied)),
      FitX_points: joinedNumberCell(fitX),
      FitY_raw_points: joinedNumberCell(rawY),
      FitY_input_points: joinedNumberCell(fitY),
      FitY_input_delta_points: joinedNumberCell(fitY.map((value, index) => {
        const rawValue = rawY[index];
        return typeof rawValue === 'number' && Number.isFinite(rawValue) ? value - rawValue : '';
      })),
      ClipDelta_points: joinedNumberCell(clipAudit.clipDelta),
      ClipY_observed_points: joinedNumberCell(clipAudit.yObserved),
      ClipY_shifted_points: joinedNumberCell(clipAudit.yShifted),
      ClipY_expected_points: joinedNumberCell(clipAudit.yExpected),
      ClipY_corrected_points: joinedNumberCell(clipAudit.yCorrected),
      ClipSDThreshold_points: joinedNumberCell(clipAudit.threshold),
    });
  });

  standardAdditionFits.forEach((fit) => {
    const cal = calibrationFits.find((calFit) => calFit.channel === fit.channel);
    const beta = cal && Number.isFinite(cal.slope) && Math.abs(cal.slope) > 1e-15
      ? fit.slope / cal.slope
      : Number.NaN;
    const fitX = fit.addedConcentrationsUsed ?? [];
    const rawPointRows = collectStandardAdditionMedianPointsForChannel(fit, fit.channel, measurements, plateMap);
    const rawY = alignedYValues(rawPointRows, fitX);
    const fitY = fit.meanSignalValuesUsed ?? [];
    const correction = correctionForChannel(lowSignalCorrections, fit.channel);
    const clipAudit = alignedClipValues(correction, fitX);
    const points = fitX.map((x, index) => ({ x, y: typeof fitY[index] === 'number' ? fitY[index] : Number.NaN }));
    rows.push({
      Channel: reportChannelName(fit.channel),
      FitType: 'StdAdd',
      n_points: fit.n,
      m: fit.slope,
      q: fit.intercept,
      R2: fit.r2,
      RMSE: finiteRmse(points, fit.slope, fit.intercept),
      sigma_cal: '',
      sigma_source: '',
      SNR: '',
      LOD: '',
      LOQ: '',
      ID: fit.sampleId,
      DF: fit.dilutionFactor,
      C0: fit.concentrationInOriginalSample,
      C0_sd: Number.isFinite(fit.concentrationInOriginalSampleSd ?? Number.NaN) ? fit.concentrationInOriginalSampleSd as number : '',
      beta_k: Number.isFinite(beta) ? beta : '',
      bias_index_k: Number.isFinite(beta) ? Math.abs(beta - 1) : '',
      S0_calibration: '',
      S0_applied: fit.S0 ?? '',
      NClipPoints: '',
      ClipX: '',
      ClipDelta: fit.meanClipDelta ?? '',
      FitSignalSource: fit.signalSourceUsedForFit ?? '',
      FitX_points: joinedNumberCell(fitX),
      FitY_raw_points: joinedNumberCell(rawY),
      FitY_input_points: joinedNumberCell(fitY),
      FitY_input_delta_points: joinedNumberCell(fitY.map((value, index) => {
        const rawValue = rawY[index];
        return typeof rawValue === 'number' && Number.isFinite(rawValue) ? value - rawValue : '';
      })),
      ClipDelta_points: joinedNumberCell(clipAudit.clipDelta),
    });
  });

  unknownResults.forEach((result) => {
    rows.push({
      Channel: reportChannelName(result.channel),
      FitType: 'UnknownFromCal',
      n_points: '',
      m: result.storedCalibrationSlope,
      q: result.storedCalibrationIntercept,
      R2: '',
      RMSE: '',
      sigma_cal: '',
      sigma_source: 'stored_calibration',
      SNR: '',
      LOD: '',
      LOQ: '',
      ID: result.sampleId,
      DF: result.dilutionFactor,
      C0: result.concentrationInOriginalSample,
      C0_sd: '',
      beta_k: '',
      bias_index_k: '',
      S0_calibration: '',
      S0_applied: result.correctionApplied ? result.S0 : '',
      NClipPoints: '',
      ClipX: '',
      ClipDelta: result.correctionApplied ? result.clipDelta : '',
      FitSignalSource: reportFitSignalSourceLabel(result.channel, result.correctionApplied),
      FitX_points: '',
      FitY_raw_points: Number.isFinite(result.pabsRaw) ? String(result.pabsRaw) : '',
      FitY_input_points: Number.isFinite(result.pabs) ? String(result.pabs) : '',
      FitY_input_delta_points: Number.isFinite(result.pabsRaw) && Number.isFinite(result.pabs)
        ? String(result.pabs - result.pabsRaw)
        : '',
      ClipDelta_points: result.correctionApplied ? String(result.clipDelta) : '',
    });
  });

  return rows;
}

function numericRowValue(row: XlsxRow | undefined, key: string): number {
  const value = row?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
}

function stringRowValue(row: XlsxRow | undefined, key: string): string {
  const value = row?.[key];
  return typeof value === 'string' ? value : '';
}

function methodFamily(method: string): string {
  if (method.startsWith('PAbs_')) {
    return 'RGB';
  }

  if (method.startsWith('Delta')) {
    return 'DeltaCIELAB';
  }

  return 'CIELAB';
}

function slopeAgreement(mCal: number, mStd: number): number {
  const absCal = Math.abs(mCal);
  const absStd = Math.abs(mStd);

  if (!Number.isFinite(absCal) || !Number.isFinite(absStd) || absCal <= 1e-15 || absStd <= 1e-15) {
    return Number.NaN;
  }

  return Math.min(absCal, absStd) / Math.max(absCal, absStd);
}

function methodScore(r2Cal: number, r2Std: number, agreement: number, loq: number): { score: number; formula: string; comparableGroup: string; commonFactorsN: number; rankMode: string } {
  const hasCal = Number.isFinite(r2Cal);
  const hasStd = Number.isFinite(r2Std);
  const hasSlope = Number.isFinite(agreement);

  if (hasCal && hasStd && hasSlope) {
    const base = agreement ** 2 * Math.sqrt(Math.max(0, r2Cal) * Math.max(0, r2Std));
    const loqValue = Number.isFinite(loq) ? loq : Number.NaN;
    return {
      score: loqValue > 0 ? base / loqValue : base,
      formula: 'slope_agreement^2 * sqrt(R2_cal * R2_std) * (1/LOQ)',
      comparableGroup: 'calibration_plus_stdadd',
      commonFactorsN: 3,
      rankMode: 'calibration_plus_stdadd',
    };
  }

  if (hasCal) {
    return {
      score: Math.max(0, r2Cal),
      formula: 'R2_cal',
      comparableGroup: 'calibration_only',
      commonFactorsN: 1,
      rankMode: 'calibration_only',
    };
  }

  if (hasStd) {
    return {
      score: Math.max(0, r2Std),
      formula: 'R2_std_mean',
      comparableGroup: 'stdadd_only',
      commonFactorsN: 1,
      rankMode: 'stdadd_only',
    };
  }

  return {
    score: 0,
    formula: 'not_ranked',
    comparableGroup: 'not_ranked',
    commonFactorsN: 0,
    rankMode: 'not_ranked',
  };
}

function buildMethodComparisonRowsFromFitRows(fitRows: XlsxRow[], expectedRefs: ExpectedRef[], includeSelectionColumns: boolean): XlsxRow[] {
  const methods = [...new Set(fitRows.map((row) => stringRowValue(row, 'Channel')).filter(Boolean))];
  const rows = methods.map((method) => {
    const channelRows = fitRows.filter((row) => stringRowValue(row, 'Channel') === method);
    const cal = channelRows.find((row) => row.FitType === 'Calibration');
    const stdRows = channelRows.filter((row) => row.FitType === 'StdAdd');
    const unknownRows = channelRows.filter((row) => row.FitType === 'UnknownFromCal');
    const mCal = numericRowValue(cal, 'm');
    const mStdValues = stdRows.map((row) => numericRowValue(row, 'm')).filter(Number.isFinite);
    const mStdMean = meanFinite(mStdValues);
    const r2Cal = numericRowValue(cal, 'R2');
    const r2Std = meanFinite(stdRows.map((row) => numericRowValue(row, 'R2')).filter(Number.isFinite));
    const c0Values = stdRows.map((row) => numericRowValue(row, 'C0')).filter(Number.isFinite);
    const c0SdValues = stdRows.map((row) => numericRowValue(row, 'C0_sd')).filter(Number.isFinite);
    const unknownC0Values = unknownRows.map((row) => numericRowValue(row, 'C0')).filter(Number.isFinite);
    const betaValues = stdRows.map((row) => numericRowValue(row, 'beta_k')).filter(Number.isFinite);
    const biasValues = stdRows.map((row) => numericRowValue(row, 'bias_index_k')).filter(Number.isFinite);
    const agreementValues = mStdValues.map((mStd) => slopeAgreement(mCal, mStd)).filter(Number.isFinite);
    const agreement = meanFinite(agreementValues);
    const loq = numericRowValue(cal, 'LOQ');
    const scoreInfo = methodScore(r2Cal, r2Std, agreement, loq);
    const estimateValue = unknownC0Values.length > 0 ? medianFinite(unknownC0Values) : medianFinite(c0Values);
    const baseRow: XlsxRow = {
      Method: method,
      Family: methodFamily(method),
      ComparableGroup: scoreInfo.comparableGroup,
      CommonFactorsN: scoreInfo.commonFactorsN,
      Score: finiteOrBlank(scoreInfo.score),
      ScoreFormula: scoreInfo.formula,
      RankMode: scoreInfo.rankMode,
      R2_cal: finiteOrBlank(r2Cal),
      R2_std_mean: finiteOrBlank(r2Std),
      m_cal: finiteOrBlank(mCal),
      m_std_mean: finiteOrBlank(mStdMean),
      SlopeAgreement: finiteOrBlank(agreement),
      beta_mean: meanOrBlank(betaValues),
      bias_index_mean: meanOrBlank(biasValues),
      SNR: cal?.SNR ?? '',
      LOD: cal?.LOD ?? '',
      LOQ: cal?.LOQ ?? '',
      n_stdadd: stdRows.length,
      n_unknown: unknownRows.length,
      C0_mean: meanOrBlank(c0Values),
      C0_median: medianOrBlank(c0Values),
      C0_sd_median: medianOrBlank(c0SdValues),
      Estimate_value: Number.isFinite(estimateValue) ? estimateValue : '',
      Estimate_sd: medianOrBlank(c0SdValues),
      Estimate_source: unknownC0Values.length > 0 ? 'unknown_from_calibration' : c0Values.length > 0 ? 'standard_addition' : '',
    };

    expectedRefs.forEach((ref, refIndex) => {
      const label = ref.label || ref.refId || `Reference ${refIndex + 1}`;
      const key = expectedRefKey(label, refIndex + 1);
      const matchedStd = stdRows
        .filter((row) => referenceMatchesSample(ref, stringRowValue(row, 'ID')))
        .map((row) => numericRowValue(row, 'C0'))
        .filter(Number.isFinite);
      const matchedUnknown = unknownRows
        .filter((row) => referenceMatchesSample(ref, stringRowValue(row, 'ID')))
        .map((row) => numericRowValue(row, 'C0'))
        .filter(Number.isFinite);
      const estimateForRef = matchedUnknown.length > 0
        ? medianFinite(matchedUnknown)
        : matchedStd.length > 0
          ? medianFinite(matchedStd)
          : estimateValue;

      baseRow[`expected_label_${key}`] = label;
      baseRow[`expected_id_${key}`] = ref.refId;
      baseRow[`expected_value_${key}`] = ref.value;
      baseRow[`expected_sd_${key}`] = ref.sd ?? '';
      baseRow[`estimate_for_expected_${key}`] = Number.isFinite(estimateForRef) ? estimateForRef : '';
      baseRow[`delta_expected_${key}`] = Number.isFinite(estimateForRef) && Number.isFinite(ref.value) ? estimateForRef - ref.value : '';
      baseRow[`recovery_pct_${key}`] = Number.isFinite(estimateForRef) && Number.isFinite(ref.value) && Math.abs(ref.value) > 1e-15 ? (100 * estimateForRef) / ref.value : '';
      baseRow[`rel_error_${key}`] = Number.isFinite(estimateForRef) && Number.isFinite(ref.value) && Math.abs(ref.value) > 1e-15 ? (estimateForRef - ref.value) / ref.value : '';
    });

    baseRow.BaseScore = finiteOrBlank(scoreInfo.score);

    return baseRow;
  });

  rows.sort((a, b) => (
    Number(b.CommonFactorsN) - Number(a.CommonFactorsN) ||
    (Number.isFinite(numericRowValue(b, 'Score')) ? numericRowValue(b, 'Score') : Number.NEGATIVE_INFINITY) -
      (Number.isFinite(numericRowValue(a, 'Score')) ? numericRowValue(a, 'Score') : Number.NEGATIVE_INFINITY) ||
    String(a.Family).localeCompare(String(b.Family)) ||
    String(a.Method).localeCompare(String(b.Method))
  ));

  if (!includeSelectionColumns) {
    rows.forEach((row) => {
      delete row.BaseScore;
    });
  }

  if (includeSelectionColumns) {
    const maxFactors = Math.max(...rows.map((row) => Number(row.CommonFactorsN) || 0), 0);
    const rankableRows = rows.filter((row) => (Number(row.CommonFactorsN) || 0) === maxFactors);
    const selectedMethod = stringRowValue(rankableRows[0], 'Method');
    const rankByMethod = new Map<string, number>();

    rankableRows.forEach((row, index) => {
      rankByMethod.set(stringRowValue(row, 'Method'), index + 1);
    });

    rows.forEach((row) => {
      const method = stringRowValue(row, 'Method');
      row.Selected = method === selectedMethod ? 1 : 0;
      row.Rank = rankByMethod.get(method) ?? '';
    });
  }

  return rows;
}

function buildReportOverviewRows(
  imageBase: string,
  unitLabel: string,
  selectedChannel: FitChannel,
  rankings: PythonResultsChannelRank[],
  methodComparisonRows: XlsxRow[],
  fitRows: XlsxRow[],
  plateMap: WellConfig[],
  expectedRefs: ExpectedRef[],
  storedCalibration: StoredCalibration | null,
  imageQcInfo: PythonImageQcInfo | undefined,
  methodMetadata: MethodMetadata,
): XlsxRow[] {
  const rows: XlsxRow[] = [];
  const cmpRows = [...methodComparisonRows];
  const bestCmp = cmpRows.find((row) => Number(row.Selected) === 1) ?? cmpRows[0] ?? {};
  const selectedName = stringRowValue(bestCmp, 'Method') || stringRowValue(bestCmp, 'Channel') || reportChannelName(selectedChannel);
  const selectedRgbMethod = reportChannelName(selectedChannel);

  const metadataCounts = countPlateMapMetadataTypes(plateMap);
  const emptyQcPayload = computeEmptyWellQcStatus(storedCalibration?.emptyWellPayload);
  const reliabilityPayload = buildReliabilityPayload(
    metadataCounts,
    fitRows,
    { use_stored_calibration: Boolean(storedCalibration) },
    {
      status: imageQcInfo?.initial_image_qc ?? 'OK',
      critical_wells: 0,
      total_wells: plateMap.length || fitRows.length || 1,
    },
    emptyQcPayload,
    {
      ranking: methodComparisonRows,
      best: bestCmp,
    },
    {
      epsilon: undefined,
      path_length: undefined,
      liquid_volume_ul: undefined,
      path_length_mm: undefined,
      path_length_source: undefined,
      well_bottom_diam_mm_for_pathlength: undefined,
      well_bottom_area_mm2_for_pathlength: undefined,
      plate_geometry_name: undefined,
      plate_geometry_assumption: undefined,
    },
  );

  const addRow = (field: string, value: XlsxCellValue): void => {
    if (value === null || value === undefined || value === '') {
      return;
    }

    if (typeof value === 'number' && !Number.isFinite(value)) {
      return;
    }

    rows.push({ Field: field, Value: value });
  };

  addRow('Quantification', reliabilityPayload.quantification_status);
  addRow('Reliability score', reliabilityPayload.reliability_score);
  addRow('Confidence class', reliabilityPayload.confidence_class);
  addRow('Reliability note', reliabilityPayload.reason);
  addRow('Empty-well QC status', reliabilityPayload.empty_qc_status);
  addRow('Empty drift score', reliabilityPayload.empty_drift_score);

  addRow('Configured epsilon (M-1 cm-1)', reliabilityPayload.epsilon);
  addRow('Liquid volume per well (uL)', reliabilityPayload.liquid_volume_ul);
  addRow('Calculated path length (cm)', reliabilityPayload.path_length);
  addRow('Calculated liquid height (mm)', reliabilityPayload.path_length_mm);
  addRow('Path-length source', reliabilityPayload.path_length_source);
  addRow('Plate geometry for path length', reliabilityPayload.plate_geometry_name);
  addRow('Plate geometry assumption', reliabilityPayload.plate_geometry_assumption);

  addRow('Selected method from rank', selectedName);
  addRow('Selected quantitative RGB channel', selectedRgbMethod);
  addRow('Selected family', bestCmp.Family ?? methodFamilyFromReportMethod(selectedName));
  addRow('Ranking mode', bestCmp.RankMode ?? bestCmp.Mode ?? '');
  addRow('Selected method score', bestCmp.Score ?? '');

  [
    ['R2 calibration', 'R2_cal'],
    ['R2 std add', 'R2_std_mean'],
    ['Slope agreement', 'SlopeAgreement'],
    ['C0 median', 'C0_median'],
    ['C0 SD median', 'C0_sd_median'],
    ['beta (mean)', 'beta_mean'],
    ['Bias index (mean)', 'bias_index_mean'],
    ['LOD', 'LOD'],
    ['LOQ', 'LOQ'],
  ].forEach(([label, key]) => addRow(label, bestCmp[key]));

  fitRows
    .filter((row) => stringRowValue(row, 'Channel') === selectedName)
    .forEach((row) => {
      const fitType = stringRowValue(row, 'FitType');
      if (!['StdAdd', 'UnknownFromCal', 'UnknownFromEpsilon'].includes(fitType)) {
        return;
      }

      const c0 = finiteNumber(row.C0, Number.NaN);
      if (!Number.isFinite(c0)) {
        return;
      }

      const id = stringRowValue(row, 'ID');
      const df = row.DF ?? '';
      addRow(`${fitType} ID=${id} DF=${df} C0 (${unitLabel})`, c0);

      const c0sd = finiteNumber(row.C0_sd, Number.NaN);
      if (Number.isFinite(c0sd)) {
        addRow(`${fitType} ID=${id} DF=${df} C0 SD (${unitLabel})`, c0sd);
      }
    });

  appendOverviewReferenceRows(rows, fitRows, selectedName, expectedRefs, unitLabel);

  if (reliabilityPayload.notes.length > 0) {
    addRow('Status notes', reliabilityPayload.notes.join('; '));
  }

  if (imageBase) {
    addRow('Report', imageBase);
  }

  if (unitLabel) {
    addRow('Unit', unitLabel);
  }

  if (rankings.length > 0) {
    addRow('RGB ranking mode', calibrationAndStdAddModeLabel(methodComparisonRows));
  }

  return rows;
}

function finiteNumber(value: XlsxCellValue, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function methodFamilyFromReportMethod(method: string): string {
  if (method.startsWith('PAbs_') || method.startsWith('Signal_') || ['Red', 'Green', 'Blue'].includes(method)) {
    return 'RGB';
  }

  if (['L', 'a', 'b'].includes(method)) {
    return 'CIELAB';
  }

  if (method.startsWith('Delta')) {
    return 'DeltaCIELAB';
  }

  return 'other';
}

function countPlateMapMetadataTypes(plateMap: WellConfig[]): Record<string, number> {
  const counts = { calibration: 0, stdadd: 0, unknown: 0 };
  const typeCalibration = new Set(['CAL', 'STD', 'STANDARD', 'CALIBRATION', 'C']);
  const typeStdAdd = new Set(['A', 'SA', 'STDADD', 'STANDARD_ADDITION', 'ADDITION']);
  const typeUnknown = new Set(['UNK', 'UNKNOWN', 'U']);

  plateMap.forEach((well) => {
    const type = String(well.role ?? '').trim().toUpperCase();

    if (typeCalibration.has(type)) {
      counts.calibration += 1;
    } else if (typeStdAdd.has(type)) {
      counts.stdadd += 1;
    } else if (typeUnknown.has(type)) {
      counts.unknown += 1;
    }
  });

  return counts;
}

function appendOverviewReferenceRows(
  rows: XlsxRow[],
  fitRows: XlsxRow[],
  selectedName: string,
  expectedRefs: ExpectedRef[],
  unitLabel: string,
): void {
  if (!expectedRefs.length) {
    return;
  }

  const selectedRows = fitRows.filter((row) => stringRowValue(row, 'Channel') === selectedName);

  selectedRows.forEach((row) => {
    expectedRefs.forEach((ref, index) => {
      const label = ref.label?.trim() || ref.refId?.trim() || `Reference ${index + 1}`;
      const value = typeof ref.value === 'number' ? ref.value : Number.NaN;

      if (!Number.isFinite(value)) {
        return;
      }

      rows.push({ Field: 'Reference label', Value: label });
      rows.push({ Field: `Reference value (${unitLabel})`, Value: value });

      if (typeof ref.sd === 'number' && Number.isFinite(ref.sd)) {
        rows.push({ Field: `Reference SD (${unitLabel})`, Value: ref.sd });
      }

      const c0 = finiteNumber(row.C0, Number.NaN);
      if (Number.isFinite(c0)) {
        const rowTag = `${stringRowValue(row, 'FitType')} ID=${stringRowValue(row, 'ID')} DF=${row.DF ?? ''}`;
        rows.push({ Field: `${rowTag} delta (${unitLabel})`, Value: c0 - value });
        if (value !== 0) {
          rows.push({ Field: `${rowTag} recovery (%)`, Value: 100 * c0 / value });
        }
      }
    });
  });
}

function calibrationAndStdAddModeLabel(methodComparisonRows: XlsxRow[]): string {
  const hasCal = methodComparisonRows.some((row) => row.R2_cal !== '');
  const hasStd = methodComparisonRows.some((row) => row.R2_std_mean !== '');
  const hasUnknown = methodComparisonRows.some((row) => Number(row.n_unknown) > 0);

  if (hasCal && hasStd && hasUnknown) {
    return 'Mode: calibration + standard addition + unknown';
  }

  if (hasCal && hasStd) {
    return 'Mode: calibration + standard addition';
  }

  if (hasCal && hasUnknown) {
    return 'Mode: calibration + unknown';
  }

  if (hasCal) {
    return 'Mode: calibration only';
  }

  if (hasStd) {
    return 'Mode: standard addition only';
  }

  return 'Mode: no valid analytical fit available';
}

function buildReportMetadataRows(options: PythonReportWorkbookOptions): XlsxRow[] {
  const rows: XlsxRow[] = [];
  const info = options.imageQcInfo;

  const addRow = (field: string, value: XlsxCellValue, notes: string): void => {
    if (value === null || value === undefined || value === '') {
      return;
    }

    if (typeof value === 'number' && !Number.isFinite(value)) {
      return;
    }

    rows.push({ Field: field, Value: value, Notes: notes });
  };

  addRow('Analysis image source', info?.analysis_image_source ?? null, 'original or in-memory resized image used for all measurements');
  addRow('Original image path', info?.original_image_path ?? null, 'source file selected by the user');
  addRow('Original image size', info?.original_image_size ?? null, 'width x height in pixels, when known');
  addRow('Analysis image size', info?.analysis_image_size ?? null, 'width x height in pixels actually analyzed');
  addRow('Resize scale', info?.resize_scale ?? null, 'analysis_width / original_width, when a resized image is used');
  addRow('Initial image QC', info?.initial_image_qc ?? null, 'Rule-based result: FAIL if destructive=True; WARNING if quality_warning=True or borderline=True; otherwise OK. No image correction is applied.');
  addRow('Initial image QC class', info?.image_qc_class ?? null, 'non_correctable if destructive=True; quality_warning if flatfield_span > 0.18 and no destructive defect; usable_with_warnings if only borderline defects; good if no flags.');
  addRow('Initial image QC messages', info?.image_qc_messages ?? null, 'Messages list the threshold rules triggered by the measured fields below.');
  rows.push({ Field: 'Image QC decision rules', Value: 'thresholds', Notes: 'destructive = dead_channel OR saturation_fraction>0.003 OR saturation_all_channels_fraction>0.0008 OR specular_fraction>0.003 OR max_side<900 OR approx_roi_pixels<120; borderline = saturation_fraction>0.0005 OR specular_fraction>0.0005 OR blur_score<35; quality_warning = flatfield_span>0.18.' });
  addRow('Flat-field span', info?.flatfield_span ?? null, 'Flatfield_span = (P95 - P5) / median of the slow illumination field estimated from the grayscale image. Larger values indicate stronger illumination/background gradient.');
  addRow('Specular fraction', info?.specular_fraction ?? null, 'fraction of bright low-saturation pixels');
  addRow('Saturation fraction', info?.saturation_fraction ?? null, 'fraction of pixels with at least one saturated channel');
  addRow('Dead channel', info?.dead_channel ?? null, '1 if a channel is near-dead by mean/variance checks');
  addRow('Approx well pitch', info?.approx_well_pitch_px ?? null, 'median distance between adjacent well centers, in pixels');
  addRow('Approx ROI pixels/well', info?.approx_roi_pixels_per_well ?? null, 'median number of pixels used in the final floor ROI mask per well');
  addRow('Blur score', info?.blur_score ?? null, 'variance of Laplacian of the analysis image; lower values indicate stronger blur');

  return rows;
}

function buildReportLegendRows(unitLabel: string): XlsxRow[] {
  return [
    { Term: "a", Meaning: "CIELAB green–red axis", Formula: "median ROI value after RGB → CIELAB conversion", Unit: "dimensionless", "Where used": "RAW, SUMMARY", "Shown when": "CIELAB enabled", Notes: "" },
    { Term: "b", Meaning: "CIELAB blue–yellow axis", Formula: "median ROI value after RGB → CIELAB conversion", Unit: "dimensionless", "Where used": "RAW, SUMMARY", "Shown when": "CIELAB enabled", Notes: "" },
    { Term: "BaseScore/FinalScore", Meaning: "Intermediate/final score fields when present", Formula: "same common score unless an explicit post-score adjustment is applied", Unit: "dimensionless", "Where used": "METHOD_COMPARISON", "Shown when": "method comparison", Notes: "If identical to Score in the exported workbook, Score is the authoritative field." },
    { Term: "beta_k", Meaning: "Slope ratio for one standard-addition curve", Formula: "m_std / m_cal", Unit: "dimensionless", "Where used": "FITTING, METHOD_COMPARISON", "Shown when": "stdadd present", Notes: "Used to assess whether StdAdd and calibration slopes are coherent." },
    { Term: "beta_k/beta_mean", Meaning: "Standard-addition/calibration slope ratio", Formula: "m_std / m_cal; beta_mean is the mean across available standard-addition fits", Unit: "dimensionless", "Where used": "06_FITTING, 07_METHOD_COMPARISON", "Shown when": "calibration plus standard addition present", Notes: "" },
    { Term: "bias_index_k", Meaning: "Absolute relative slope bias for one standard-addition curve", Formula: "|beta_k − 1|", Unit: "dimensionless", "Where used": "FITTING, METHOD_COMPARISON", "Shown when": "stdadd present", Notes: "0 means identical slopes." },
    { Term: "bias_index_k/bias_index_mean", Meaning: "Relative slope-bias index", Formula: "|m_std/m_cal - 1|; bias_index_mean is the mean across available fits", Unit: "dimensionless", "Where used": "06_FITTING, 07_METHOD_COMPARISON", "Shown when": "calibration plus standard addition present", Notes: "" },
    { Term: "BiasIndex", Meaning: "Relative slope bias between standard addition and calibration", Formula: "|β − 1|, where β = m_std / m_cal", Unit: "dimensionless", "Where used": "METHOD_COMPARISON", "Shown when": "stdadd present", Notes: "Equals 0 when the standard-addition slope equals the calibration slope. Larger values indicate stronger slope bias." },
    { Term: "C0", Meaning: "Concentration in original sample", Formula: "standard addition: DF × (q/m); unknown/CRM from calibration: DF × ((y − q)/m); unknown from epsilon: DF × PAbs/(epsilon × l_cm), converted from M to the selected unit", Unit: unitLabel, "Where used": "FITTING, OVERVIEW", "Shown when": "stdadd present or unknown/CRM present", Notes: "Same symbol is used for standard addition and unknown/CRM results; FitType defines the method." },
    { Term: "C0/C0_sd", Meaning: "Estimated original-sample concentration and associated uncertainty", Formula: "standard addition: DF x q/m; calibration projection: DF x (y - q)/m; epsilon mode: DF x PAbs/(epsilon x l_cm), converted from M to the selected unit", Unit: unitLabel, "Where used": "FIGURE_RGB.png, 03_OVERVIEW, 06_FITTING", "Shown when": "standard addition, unknown or epsilon quantification present", Notes: "FitType identifies which calculation path produced C0." },
    { Term: "C0_sd", Meaning: "Uncertainty on C0", Formula: "Fit covariance for calibration/std-add; for epsilon mode, propagated PAbs replicate SD divided by epsilon × l_cm and converted to the selected unit", Unit: unitLabel, "Where used": "FITTING, OVERVIEW", "Shown when": "stdadd present or unknown/CRM present", Notes: "Reported in the same concentration units as C0." },
    { Term: "Channel", Meaning: "Fitted analytical descriptor", Formula: "PAbs_Red, PAbs_Green, PAbs_Blue or diagnostic CIELAB/DeltaE descriptor", Unit: "text", "Where used": "FITTING, METHOD_COMPARISON", "Shown when": "always", Notes: "" },
    { Term: "CIELAB (L*, a*, b*)", Meaning: "CIE 1976 color coordinates derived from the RGB image", Formula: "L* = 116 f(Y/Yn) - 16; a* = 500[f(X/Xn) - f(Y/Yn)]; b* = 200[f(Y/Yn) - f(Z/Zn)]", Unit: "dimensionless", "Where used": "RAW, REPLICATES_MEAN, CIELAB diagnostics", "Shown when": "CIELAB enabled", Notes: "D65 is the reference white used by the sRGB/OpenCV conversion convention. References: CIE 1976 L*a*b* and CIE standard illuminant D65." },
    { Term: "CIELAB_ref_source", Meaning: "Source of the CIELAB reference used to compute Delta variables", Formula: "zero calibration or other reported fallback source", Unit: "text", "Where used": "04_RAW, 05_REPLICATES_MEAN", "Shown when": "CIELAB/DeltaE outputs present", Notes: "Reported only for CIELAB-derived variables because RGB pseudo-absorbance does not use this CIELAB reference." },
    { Term: "ClipDelta", Meaning: "Positive calibration-derived clipping correction", Formula: "max(0, y_expected − y_shifted) when deficit exceeds SD threshold", Unit: "signal", "Where used": "FITTING", "Shown when": "RGB calibration", Notes: "Computed from calibration after S0 and zero-intercept fit; applied by same channel and same x." },
    { Term: "ClipX", Meaning: "Calibration x values where clipping correction was evaluated", Formula: "list of calibration concentrations", Unit: unitLabel, "Where used": "FITTING", "Shown when": "RGB calibration", Notes: "Transferred to StdAdd at the same channel and same x values." },
    { Term: "Code implementation", Meaning: "Main computational libraries and code provenance", Formula: "custom Python code using NumPy, OpenCV, openpyxl and matplotlib", Unit: "software provenance", "Where used": "all generated outputs", "Shown when": "always", Notes: "Sources/libraries: NumPy for least-squares solves; OpenCV for image masks/color conversion; openpyxl for xlsx export; matplotlib for PNG figures." },
    { Term: "Col", Meaning: "Plate column index", Formula: "1-based column number", Unit: "well-column index", "Where used": "RAW, REPLICATES_MEAN", "Shown when": "always", Notes: "" },
    { Term: "CommonFactorsN", Meaning: "Number of common factors used in the score", Formula: "3 for R²_cal, R²_std, slope agreement; 1 for calibration-only or stdadd-only fallbacks", Unit: "integer", "Where used": "METHOD_COMPARISON", "Shown when": "always", Notes: "Used to avoid comparing scores obtained from different formulas." },
    { Term: "ComparableGroup", Meaning: "Set of methods scored with the same formula", Formula: "calibration_plus_stdadd, calibration_only, stdadd_only, or not_ranked", Unit: "text", "Where used": "METHOD_COMPARISON", "Shown when": "always", Notes: "Scores are directly comparable only within the same group. The group with the largest CommonFactorsN is used for Selected/Rank." },
    { Term: "Conc", Meaning: "Configured concentration for calibration or added-standard wells", Formula: "user/configurator input", Unit: unitLabel, "Where used": "RAW, REPLICATES_MEAN, FITTING", "Shown when": "always", Notes: "Unknown wells may have undefined Conc." },
    { Term: "Confidence class", Meaning: "Qualitative class derived from reliability score", Formula: "HIGH >= 75; MEDIUM >= 45; LOW < 45; NOT QUANTIFIABLE when no valid quantification is available", Unit: "class", "Where used": "OVERVIEW", "Shown when": "always", Notes: "Interpret together with the reliability reason." },
    { Term: "delta_expected_*/delta_reference_*", Meaning: "Difference between estimate and external reference", Formula: "estimate - reference", Unit: unitLabel, "Where used": "METHOD_COMPARISON.png, 03_OVERVIEW, 07_METHOD_COMPARISON", "Shown when": "reference values configured", Notes: "" },
    { Term: "delta_reference_*", Meaning: "Difference between estimated concentration and an external reference", Formula: "C0 - reference_value", Unit: unitLabel, "Where used": "OVERVIEW, METHOD_COMPARISON, FIGURE_RGB", "Shown when": "reference values configured", Notes: "" },
    { Term: "Deltaa", Meaning: "Difference in CIELAB a* relative to the selected reference", Formula: "a - a_ref", Unit: "dimensionless", "Where used": "RAW, SUMMARY", "Shown when": "CIELAB enabled", Notes: "Reference source is reported in CIELAB_ref_source." },
    { Term: "Deltab", Meaning: "Difference in CIELAB b* relative to the selected reference", Formula: "b - b_ref", Unit: "dimensionless", "Where used": "RAW, SUMMARY", "Shown when": "CIELAB enabled", Notes: "Reference source is reported in CIELAB_ref_source." },
    { Term: "DeltaE_ab", Meaning: "Total CIELAB color difference", Formula: "sqrt(DeltaL^2 + Deltaa^2 + Deltab^2)", Unit: "dimensionless", "Where used": "FIGURE_CIELAB_DELTAE.png, RAW_DATA_DETAILS_CAPTION.txt, 04_RAW, 05_REPLICATES_MEAN, 07_METHOD_COMPARISON, diagnostics", "Shown when": "DeltaE outputs present", Notes: "Reference: CIE 1976 L*a*b* color-difference form." },
    { Term: "DeltaE_ab_chroma", Meaning: "Chromatic CIELAB color difference without lightness", Formula: "sqrt(Deltaa^2 + Deltab^2)", Unit: "dimensionless", "Where used": "FIGURE_CIELAB_DELTAE.png, RAW_DATA_DETAILS_CAPTION.txt, 04_RAW, 05_REPLICATES_MEAN, diagnostics", "Shown when": "DeltaE outputs present", Notes: "Reference source is reported in CIELAB_ref_source." },
    { Term: "DeltaL", Meaning: "Difference in CIELAB lightness relative to the selected reference", Formula: "L - L_ref", Unit: "dimensionless", "Where used": "RAW, SUMMARY", "Shown when": "CIELAB enabled", Notes: "Reference source is reported in CIELAB_ref_source." },
    { Term: "DeltaL/Deltaa/Deltab", Meaning: "CIELAB coordinate differences from the selected CIELAB reference", Formula: "DeltaL = L - L_ref; Deltaa = a - a_ref; Deltab = b - b_ref", Unit: "dimensionless", "Where used": "FIGURE_CIELAB_DELTAE.png, 04_RAW, 05_REPLICATES_MEAN, diagnostics", "Shown when": "Delta outputs present", Notes: "The reference source is reported in CIELAB_ref_source." },
    { Term: "DF", Meaning: "Dilution factor used to report original-sample concentration", Formula: "C0 = DF x concentration in analyzed/diluted well", Unit: "dimensionless", "Where used": "RAW, REPLICATES_MEAN, FITTING", "Shown when": "always", Notes: "" },
    { Term: "Empty-well QC", Meaning: "QC based on empty-well robust SD and/or stored empty comparison", Formula: "warning/watch/ok/not_available from drift score and robust SD thresholds", Unit: "class", "Where used": "OVERVIEW", "Shown when": "always", Notes: "Flags comparability or background/empty-well drift." },
    { Term: "epsilon", Meaning: "User-configured Beer-Lambert-like proportionality coefficient for PAbs quantification", Formula: "PAbs = epsilon × l_cm × C_M", Unit: "M-1 cm-1", "Where used": "FITTING, OVERVIEW", "Shown when": "unknown-only epsilon mode", Notes: "C_M is mol/L. The analyzer converts the calculated concentration to the selected output unit." },
    { Term: "Estimate_value/Estimate_sd", Meaning: "Representative concentration estimate and associated SD used for method comparison", Formula: "derived from standard addition, calibration projection, or epsilon mode depending on Estimate_source", Unit: unitLabel, "Where used": "METHOD_COMPARISON", "Shown when": "method comparison", Notes: "" },
    { Term: "Estimate_value/Estimate_sd/Estimate_source", Meaning: "Representative concentration estimate, associated SD and source", Formula: "selected according to Estimate_source", Unit: "mM and text", "Where used": "METHOD_COMPARISON.png, 07_METHOD_COMPARISON", "Shown when": "method comparison present", Notes: "" },
    { Term: "expected_*/reference_*", Meaning: "External reference metadata configured by the user", Formula: "user/configurator input", Unit: "text or mM", "Where used": "METHOD_COMPARISON.png, 03_OVERVIEW, 07_METHOD_COMPARISON", "Shown when": "reference values configured", Notes: "External reference values are checks only and are not used for ranking." },
    { Term: "Family", Meaning: "Method family used in method comparison", Formula: "RGB, CIELAB, DeltaCIELAB, or other", Unit: "text", "Where used": "METHOD_COMPARISON", "Shown when": "always", Notes: "" },
    { Term: "Field", Meaning: "Name of a metadata or overview item", Formula: "label reported in the first column of the sheet", Unit: "text", "Where used": "02_METADATA, 03_OVERVIEW", "Shown when": "always", Notes: "" },
    { Term: "FitType", Meaning: "Type of fit or concentration-estimation row", Formula: "Calibration, StdAdd, UnknownFromCal, UnknownFromEpsilon, UnknownOnly", Unit: "text", "Where used": "FITTING", "Shown when": "always", Notes: "" },
    { Term: "flatfield_span", Meaning: "Image-level slow-field nonuniformity", Formula: "(P95 − P5) / median of the slow grayscale field", Unit: "dimensionless", "Where used": "METADATA", "Shown when": "always", Notes: "Part of rule-based image QC; larger values indicate stronger illumination/background gradient." },
    { Term: "FracWellWarnings/FracWellCritical", Meaning: "Fractions of replicate wells with warning or critical optical QC", Formula: "count / NReplicates", Unit: "dimensionless", "Where used": "REPLICATES_MEAN", "Shown when": "always", Notes: "" },
    { Term: "Geometry and epsilon/path-length quantification", Meaning: "Assumption used when epsilon-based unknown quantification is enabled", Formula: "l_cm = (volume_uL / well_bottom_area_mm2) / 10; C_M = PAbs / (epsilon x l_cm)", Unit: "cm and M", "Where used": "RESULTS_CAPTION.txt, RAW_DATA_DETAILS_CAPTION.txt, REPORT", "Shown when": "epsilon/path-length mode configured", Notes: "Assumes ANSI/SLAS-compatible flat-bottom microplate geometry; non-flat or non-certified geometries require separate validation." },
    { Term: "ID", Meaning: "Sample or reference identifier assigned in the plate map", Formula: "user/configurator input", Unit: "text", "Where used": "RAW, REPLICATES_MEAN, FITTING, METHOD_COMPARISON", "Shown when": "always", Notes: "" },
    { Term: "ImageWarning", Meaning: "Well-level optical QC warning flag", Formula: "1 if optical QC rules flag the well, else 0", Unit: "0/1", "Where used": "04_RAW", "Shown when": "always", Notes: "" },
    { Term: "ImageWarning_any", Meaning: "Group-level indicator that at least one replicate had an image warning", Formula: "1 if any replicate ImageWarning = 1", Unit: "0/1", "Where used": "REPLICATES_MEAN", "Shown when": "always", Notes: "" },
    { Term: "IRLS", Meaning: "Iteratively reweighted least-squares robust linear regression with residual-based weights", Formula: "minimize sum_i w_i (y_i - (m x_i + q))^2; w_i is updated iteratively from residual magnitude", Unit: "dimensionless", "Where used": "FIGURE_RGB.png, FIGURE_CIELAB_DELTAE.png, RESULTS_CAPTION.txt, RAW_DATA_DETAILS_CAPTION.txt, 06_FITTING, 07_METHOD_COMPARISON, diagnostic fitting tables", "Shown when": "always", Notes: "Reference: Huber, P. J. (1964), Robust Estimation of a Location Parameter. Implementation: custom NumPy-based IRLS using repeated least-squares solves." },
    { Term: "L", Meaning: "CIELAB lightness", Formula: "median ROI value after RGB → CIELAB conversion", Unit: "dimensionless", "Where used": "RAW, SUMMARY", "Shown when": "CIELAB enabled", Notes: "" },
    { Term: "L/a/b", Meaning: "CIELAB lightness and opponent-color coordinates", Formula: "median ROI value after RGB to CIELAB conversion", Unit: "dimensionless", "Where used": "FIGURE_CIELAB_DELTAE.png, 04_RAW, 05_REPLICATES_MEAN, diagnostics", "Shown when": "CIELAB outputs present", Notes: "" },
    { Term: "liquid_volume_ul", Meaning: "Liquid volume loaded into each well", Formula: "user input", Unit: "uL", "Where used": "OVERVIEW, FITTING", "Shown when": "epsilon mode configured", Notes: "Used only to calculate path length for flat-bottom wells." },
    { Term: "LOD", Meaning: "Limit of detection", Formula: "3 × σ / |m|", Unit: unitLabel, "Where used": "FITTING, OVERVIEW", "Shown when": "calibration only or calibration present", Notes: "Shown only for calibration rows." },
    { Term: "LOD/LOQ", Meaning: "Detection and quantification limits from calibration", Formula: "LOD = 3 x sigma_cal / |m|; LOQ = 10 x sigma_cal / |m|", Unit: unitLabel, "Where used": "FIGURE_RGB.png, FIGURE_CIELAB_DELTAE.png, 03_OVERVIEW, 06_FITTING, 07_METHOD_COMPARISON", "Shown when": "calibration present", Notes: "" },
    { Term: "LOQ", Meaning: "Limit of quantification", Formula: "10 × σ / |m|", Unit: unitLabel, "Where used": "FITTING, OVERVIEW", "Shown when": "calibration only or calibration present", Notes: "Shown only for calibration rows." },
    { Term: "m", Meaning: "Slope of linear fit", Formula: "y = m x + q", Unit: "signal / mM", "Where used": "FITTING", "Shown when": "always", Notes: "Calibration and standard-addition fits use the same notation." },
    { Term: "m/q", Meaning: "Slope and intercept of the linear fit", Formula: "y = m x + q", Unit: "response / concentration and response", "Where used": "FIGURE_RGB.png, FIGURE_CIELAB_DELTAE.png, 06_FITTING", "Shown when": "fit rows present", Notes: "" },
    { Term: "MeanBG_*", Meaning: "Linearized local background intensity for the channel", Formula: "background surface evaluated at the well and gamma linearized", Unit: "dimensionless", "Where used": "RAW", "Shown when": "always", Notes: "Derived from inter-well background reconstruction." },
    { Term: "MeanBG_Red/MeanBG_Green/MeanBG_Blue", Meaning: "Linearized local inter-well background intensity for each RGB channel", Formula: "2D background surface evaluated at the well and gamma-linearized", Unit: "dimensionless", "Where used": "04_RAW", "Shown when": "always", Notes: "" },
    { Term: "MeanW_*", Meaning: "Linearized median well intensity for the channel", Formula: "median ROI channel intensity after gamma linearization", Unit: "dimensionless", "Where used": "RAW", "Shown when": "always", Notes: "Computed from selected well ROI pixels." },
    { Term: "MeanW_Red/MeanW_Green/MeanW_Blue", Meaning: "Linearized median well intensity for each RGB channel", Formula: "median ROI channel intensity after gamma linearization", Unit: "dimensionless", "Where used": "04_RAW", "Shown when": "always", Notes: "" },
    { Term: "Method/Family/ComparableGroup/RankMode", Meaning: "Method-comparison identifiers and comparable-score grouping", Formula: "text labels defining descriptor, family and score comparability", Unit: "text", "Where used": "METHOD_COMPARISON.png, 07_METHOD_COMPARISON", "Shown when": "method comparison present", Notes: "Scores should be compared directly only within the same ComparableGroup." },
    { Term: "n_points", Meaning: "Number of finite data points used by the fit", Formula: "count of finite x,y pairs", Unit: "count", "Where used": "FITTING", "Shown when": "always", Notes: "All finite points are retained by robust IRLS." },
    { Term: "NClipPoints/ClipX/ClipDelta", Meaning: "Calibration clipping/baseline diagnostic fields", Formula: "NClipPoints = number of adjusted points; ClipX = concentrations; ClipDelta = applied response adjustments", Unit: "count, concentration, response", "Where used": "06_FITTING", "Shown when": "calibration present", Notes: "Diagnostic only; clipping is not part of the common method score." },
    { Term: "NReplicates", Meaning: "Number of replicate wells in a summarized group", Formula: "count of wells in group", Unit: "count", "Where used": "05_REPLICATES_MEAN", "Shown when": "always", Notes: "" },
    { Term: "NWellWarnings/NWellCritical", Meaning: "Counts of replicate wells with warning or critical optical QC", Formula: "count over replicate wells", Unit: "count", "Where used": "REPLICATES_MEAN", "Shown when": "always", Notes: "" },
    { Term: "PAbs", Meaning: "Image-derived RGB pseudo-absorbance", Formula: "PAbs = log10(I_BG / I_well) = -log10(I_well / I_BG)", Unit: "dimensionless", "Where used": "FIGURE_RGB.png, RESULTS_CAPTION.txt, 04_RAW, 05_REPLICATES_MEAN, 06_FITTING, 07_METHOD_COMPARISON", "Shown when": "always", Notes: "Pseudo-absorbance is not assumed to be spectrophotometric absorbance." },
    { Term: "PAbs_Blue", Meaning: "RGB pseudo-absorbance (blue channel)", Formula: "log10(BG_blue/W_blue) = -log10(W_blue/BG_blue)", Unit: "dimensionless", "Where used": "RAW, REPLICATES_MEAN, FITTING", "Shown when": "always", Notes: "Image-derived pseudo-absorbance with fixed full-background normalization." },
    { Term: "PAbs_Green", Meaning: "RGB pseudo-absorbance (green channel)", Formula: "log10(BG_green/W_green) = -log10(W_green/BG_green)", Unit: "dimensionless", "Where used": "RAW, REPLICATES_MEAN, FITTING", "Shown when": "always", Notes: "Image-derived pseudo-absorbance with fixed full-background normalization." },
    { Term: "PAbs_Red", Meaning: "RGB pseudo-absorbance (red channel)", Formula: "log10(BG_red/W_red) = -log10(W_red/BG_red)", Unit: "dimensionless", "Where used": "RAW, REPLICATES_MEAN, FITTING", "Shown when": "always", Notes: "Image-derived pseudo-absorbance with fixed full-background normalization." },
    { Term: "PAbs_Red/PAbs_Green/PAbs_Blue", Meaning: "RGB pseudo-absorbance for the red, green and blue channels", Formula: "log10(MeanBG_channel / MeanW_channel)", Unit: "dimensionless", "Where used": "FIGURE_RGB.png, 04_RAW, 05_REPLICATES_MEAN, 06_FITTING, 07_METHOD_COMPARISON", "Shown when": "always", Notes: "Exported in standard RGB order even though OpenCV stores images internally as BGR." },
    { Term: "path_length", Meaning: "Estimated optical path length", Formula: "l_cm = (V_uL / A_bottom_mm2) / 10", Unit: "cm", "Where used": "OVERVIEW, FITTING", "Shown when": "epsilon mode configured", Notes: "Assumes 1 uL = 1 mm^3 and a flat-bottom well with nominal bottom area." },
    { Term: "path_length_mm", Meaning: "Estimated liquid height", Formula: "l_mm = V_uL / A_bottom_mm2", Unit: "mm", "Where used": "OVERVIEW, FITTING", "Shown when": "epsilon mode configured", Notes: "Converted to cm before Beer-Lambert-like concentration calculation." },
    { Term: "Purpose", Meaning: "Short description of the sheet role", Formula: "free-text description", Unit: "text", "Where used": "01_CONTENTS", "Shown when": "always", Notes: "" },
    { Term: "q", Meaning: "Intercept of linear fit", Formula: "y = m x + q", Unit: "signal", "Where used": "FITTING", "Shown when": "always", Notes: "For standard addition, C0 is derived from m and q." },
    { Term: "QCCritical", Meaning: "Group-level critical optical quality flag", Formula: "1 if FracWellCritical >= 0.50", Unit: "0/1", "Where used": "REPLICATES_MEAN", "Shown when": "always", Notes: "Critical flag; points remain reported and used." },
    { Term: "QCFlagged", Meaning: "Group-level optical quality warning", Formula: "1 if any replicate has ImageWarning, any critical replicate, or median UsedFraction < 0.70", Unit: "0/1", "Where used": "REPLICATES_MEAN", "Shown when": "always", Notes: "Warning flag; points remain reported and used." },
    { Term: "QCFlagged/QCCritical", Meaning: "Replicate-group QC warning and critical flags", Formula: "rule-based aggregation of well-level warnings, critical wells and UsedFraction", Unit: "0/1", "Where used": "05_REPLICATES_MEAN", "Shown when": "always", Notes: "" },
    { Term: "R2", Meaning: "Coefficient of determination", Formula: "1 - SSE/SST", Unit: "dimensionless", "Where used": "FIGURE_RGB.png, FIGURE_CIELAB_DELTAE.png, 06_FITTING, 07_METHOD_COMPARISON", "Shown when": "fit rows present", Notes: "Closer to 1 indicates better fit." },
    { Term: "R2_cal/R2_std_mean/m_cal/m_std_mean", Meaning: "Calibration and standard-addition fit descriptors used in method comparison", Formula: "R2_cal from calibration fit; R2_std_mean = mean standard-addition R2; m_cal and m_std_mean are fit slopes", Unit: "mixed", "Where used": "METHOD_COMPARISON.png, 07_METHOD_COMPARISON", "Shown when": "method comparison present", Notes: "" },
    { Term: "Rank", Meaning: "Workbook-level rank of each method", Formula: "1 = highest Score within the selected ComparableGroup", Unit: "integer", "Where used": "METHOD_COMPARISON", "Shown when": "always", Notes: "Rows outside the selected ComparableGroup are not assigned a direct rank." },
    { Term: "RankMode", Meaning: "Data basis available for ranking", Formula: "calibration_plus_stdadd, calibration_only, stdadd_only, or unavailable", Unit: "text", "Where used": "METHOD_COMPARISON", "Shown when": "always", Notes: "" },
    { Term: "recovery_pct_*", Meaning: "Recovery relative to external reference", Formula: "100 x estimate / reference", Unit: "%", "Where used": "FIGURE_RGB.png, METHOD_COMPARISON.png, 03_OVERVIEW, 07_METHOD_COMPARISON", "Shown when": "reference values configured", Notes: "" },
    { Term: "rel_error_*", Meaning: "Relative error versus external reference", Formula: "100 x (estimate - reference) / reference", Unit: "%", "Where used": "03_OVERVIEW, 07_METHOD_COMPARISON", "Shown when": "reference values configured", Notes: "" },
    { Term: "Reliability criteria", Meaning: "Rule used to flag a method as low reliability in method comparison", Formula: "low if slope agreement < 0.5 OR R² < 0.8 OR |Δ| > threshold", Unit: "rule", "Where used": "METHOD_COMPARISON", "Shown when": "stdadd present", Notes: "The Δ threshold is max(3×reference SD, 50% of the reference value), evaluated against the nearest available reference." },
    { Term: "Reliability score", Meaning: "Overall report-level reliability score", Formula: "starts at 50 and adds/subtracts rule-based penalties/bonuses for calibration availability, stored calibration, plate QC, critical wells, used fraction, empty-well QC, and ranking separation", Unit: "0-100", "Where used": "OVERVIEW", "Shown when": "always", Notes: "Not a statistical probability; it is a heuristic audit score." },
    { Term: "RGB linearization", Meaning: "Conversion of gamma-domain RGB values to an intensity-like scale", Formula: "I_lin = (I/255)^gamma, gamma approximately 2.2", Unit: "dimensionless", "Where used": "PAbs calculation in 04_RAW and FIGURE_RGB.png", "Shown when": "always", Notes: "No automatic image correction is applied." },
    { Term: "RGB to CIELAB", Meaning: "Diagnostic conversion from image RGB/BGR values to CIE L*a*b* descriptors", Formula: "OpenCV BGR->Lab for 8-bit sRGB-like images; reference form: linearized sRGB -> XYZ using the standard sRGB-to-XYZ matrix and D65 reference white -> CIE L*a*b*", Unit: "dimensionless", "Where used": "FIGURE_CIELAB_DELTAE.png, RAW_DATA_DETAILS_CAPTION.txt, 04_RAW, 05_REPLICATES_MEAN, DIAGNOSTICS", "Shown when": "CIELAB/DeltaE outputs present", Notes: "References: OpenCV color conversions; IEC 61966-2-1:1999 sRGB; CIE 1976 L*a*b*; CIE standard illuminant D65." },
    { Term: "RMSE", Meaning: "Root mean squared error of the fit", Formula: "sqrt(mean(residual^2))", Unit: "response unit", "Where used": "06_FITTING", "Shown when": "fit rows present", Notes: "Interpret in the units of the fitted response." },
    { Term: "Robust SD", Meaning: "Robust dispersion across replicates", Formula: "1.4826 × MAD, where MAD = median(|x − median(x)|)", Unit: "same as variable", "Where used": "REPLICATES_MEAN", "Shown when": "always", Notes: "Computed within each replicate group." },
    { Term: "Row", Meaning: "Plate row label", Formula: "A-based alphabetical row label", Unit: "well-row label", "Where used": "RAW, REPLICATES_MEAN", "Shown when": "always", Notes: "" },
    { Term: "S0_calibration", Meaning: "Channel-wide low-signal offset estimated from raw calibration", Formula: "max(0, −min(raw calibration response))", Unit: "signal", "Where used": "FITTING", "Shown when": "RGB calibration", Notes: "Estimated before forced-zero calibration and transferred to StdAdd/unknown data." },
    { Term: "Score", Meaning: "Common method-ranking score", Formula: "for calibration plus standard addition: SlopeAgreement^2 x sqrt(R2_cal x R2_std) x (1/LOQ)", Unit: `1/${unitLabel}`, "Where used": "FIGURE_RGB.png, METHOD_COMPARISON.png, 07_METHOD_COMPARISON", "Shown when": "method comparison present", Notes: "Expected/reference values, recovery, SNR and clipping are not used in this score." },
    { Term: "ScoreFormula", Meaning: "Formula used to compute Score", Formula: "text descriptor", Unit: "text", "Where used": "METHOD_COMPARISON", "Shown when": "always", Notes: "Documents which score formula was applied to the row." },
    { Term: "Selected", Meaning: "Workbook-level selected method flag", Formula: "1 for the highest-ranked row within the most informative ComparableGroup, otherwise 0", Unit: "0/1", "Where used": "METHOD_COMPARISON", "Shown when": "always", Notes: "Selection in the workbook is derived from method-comparison rank and not from expected/recovery." },
    { Term: "Selected/Rank", Meaning: "Selected method flag and rank position", Formula: "Selected = 1 for the selected method; Rank = score order within the highest common-factor group", Unit: "0/1 and integer", "Where used": "07_METHOD_COMPARISON", "Shown when": "method comparison present", Notes: "" },
    { Term: "Sheet", Meaning: "Workbook sheet name", Formula: "worksheet name", Unit: "text", "Where used": "01_CONTENTS", "Shown when": "always", Notes: "" },
    { Term: "sigma_cal", Meaning: "Noise estimate for calibration", Formula: "SD at zero concentration or median calibration SD", Unit: "signal", "Where used": "FITTING", "Shown when": "calibration only or calibration present", Notes: "Source is reported in sigma_source." },
    { Term: "sigma_cal/sigma_source/SNR", Meaning: "Calibration noise estimate, its source and slope-to-noise ratio", Formula: "SNR = |m| / sigma_cal", Unit: "mixed", "Where used": "06_FITTING, 07_METHOD_COMPARISON", "Shown when": "calibration present", Notes: "SNR is diagnostic only and is not used in the common score." },
    { Term: "sigma_source", Meaning: "Source of sigma_cal", Formula: "median_calibration_sd, blank_zero_calibration_sd, or unavailable", Unit: "text", "Where used": "FITTING", "Shown when": "calibration present", Notes: "" },
    { Term: "SignalT_*", Meaning: "Transmittance-like intensity ratio before logarithm", Formula: "MeanW_* / MeanBG_*", Unit: "dimensionless", "Where used": "RAW", "Shown when": "always", Notes: "PAbs_* = -log10(SignalT_*)." },
    { Term: "SignalT_Red/SignalT_Green/SignalT_Blue", Meaning: "Transmittance-like ratio before logarithmic conversion", Formula: "SignalT_channel = MeanW_channel / MeanBG_channel", Unit: "dimensionless", "Where used": "04_RAW", "Shown when": "always", Notes: "PAbs_channel = -log10(SignalT_channel)." },
    { Term: "SlopeAgreement", Meaning: "Agreement between calibration and standard-addition slope magnitudes", Formula: "min(|m_cal|, |m_std|) / max(|m_cal|, |m_std|)", Unit: "dimensionless", "Where used": "METHOD_COMPARISON.png, 07_METHOD_COMPARISON", "Shown when": "calibration plus standard addition present", Notes: "Equals 1 when slopes are identical in magnitude; lower values indicate poorer agreement between calibration and standard addition." },
    { Term: "SNR", Meaning: "Slope-to-noise ratio", Formula: "|m| / sigma_cal", Unit: "dimensionless", "Where used": "FITTING", "Shown when": "calibration only or calibration present", Notes: "Used only for calibration rows." },
    { Term: "Type", Meaning: "Well role in the analytical workflow", Formula: "C = calibration; A = standard addition; U = unknown; other labels may be reported when present", Unit: "text", "Where used": "RAW, REPLICATES_MEAN", "Shown when": "always", Notes: "" },
    { Term: "UsedFraction", Meaning: "Fraction of ROI core pixels retained after filtering", Formula: "n_used / n_core", Unit: "dimensionless", "Where used": "RAW, SUMMARY", "Shown when": "always", Notes: "Lower values indicate stronger filtering. Closer to 1 means less aggressive trimming." },
    { Term: "UsedFraction_median", Meaning: "Median UsedFraction across replicate wells in a group", Formula: "median(UsedFraction)", Unit: "dimensionless", "Where used": "REPLICATES_MEAN", "Shown when": "always", Notes: "" },
    { Term: "Value", Meaning: "Value associated with a metadata or overview item", Formula: "reported value for the corresponding Field", Unit: "mixed", "Where used": "02_METADATA, 03_OVERVIEW", "Shown when": "always", Notes: "" },
    { Term: "Well", Meaning: "Human-readable well identifier", Formula: "Well = Row + Col", Unit: "well label", "Where used": "RAW, REPLICATES_MEAN", "Shown when": "always", Notes: "" },
    { Term: "well_bottom_area_mm2", Meaning: "Nominal flat-bottom well area used for path-length calculation", Formula: "pi × (d_bottom/2)^2", Unit: "mm^2", "Where used": "OVERVIEW", "Shown when": "epsilon mode configured", Notes: "Derived from the selected plate geometry." },
  ];
}

function uniqueHeaders(preferred: string[], rows: XlsxRow[]): string[] {
  const headers = [...preferred];
  rows.forEach((row) => {
    Object.keys(row).forEach((key) => {
      if (!headers.includes(key)) {
        headers.push(key);
      }
    });
  });
  return headers;
}

async function createPythonReportWorkbookBlob(options: PythonReportWorkbookOptions): Promise<Blob> {
  const contentsRows: XlsxRow[] = [
    { Sheet: '01_CONTENTS', Purpose: 'Index of primary results workbook sheets.' },
    { Sheet: '02_METADATA', Purpose: 'Image-level metadata and rule-based image QC used to audit the analysis.' },
    { Sheet: '03_OVERVIEW', Purpose: 'Final quantitative summary, selected method, reliability and external reference checks when provided.' },
    { Sheet: '04_RAW', Purpose: 'Well-level analytical values used by the fitting pipeline.' },
    { Sheet: '05_REPLICATES_MEAN', Purpose: 'Replicate-group medians, robust SDs and group QC flags.' },
    { Sheet: '06_FITTING', Purpose: 'Calibration, standard-addition and unknown/CRM fit results.' },
    { Sheet: '07_METHOD_COMPARISON', Purpose: 'Method ranking using only common score factors; expected values are external checks only.' },
    { Sheet: '08_LEGENDS', Purpose: 'Definitions for all fields reported in this workbook and primary RGB figure.' },
  ];
  const { points: cielabPoints } = buildCielabDiagnosticPoints(options.measurements, options.plateMap, options.storedCalibration?.cielabReference);
  const rawRows = buildReportRawRows(options.measurements, options.displayMeasurements, options.plateMap, options.correctionApplications, options.storedCalibration?.cielabReference);
  const replicateRows = buildReportReplicateRows(options.measurements, options.displayMeasurements, options.plateMap, options.correctionApplications, options.storedCalibration?.cielabReference);
  const rgbFitRows = buildReportFitRows(
    options.measurements,
    options.calibrationFits,
    options.standardAdditionFits,
    options.unknownResults,
    options.displayMeasurements,
    options.plateMap,
    options.rankings,
    options.lowSignalCorrections,
  );
  const fitRows = [
    ...rgbFitRows,
    ...storedCalibrationDiagnosticFitRows(options.storedCalibration),
    ...buildCielabFittingRows(cielabPoints, undefined, options.storedCalibration),
  ];
  const methodComparisonRows = buildMethodComparisonRowsFromFitRows(fitRows, options.expectedRefs, true);
  const overviewRows = buildReportOverviewRows(
    options.imageBase,
    options.unitLabel,
    options.selectedChannel,
    options.rankings,
    methodComparisonRows,
    fitRows,
    options.plateMap,
    options.expectedRefs,
    options.storedCalibration,
    options.imageQcInfo,
    options.methodMetadata,
  );
  const methodComparisonPreferred = [
    'Selected',
    'Rank',
    'Method',
    'Family',
    'ComparableGroup',
    'CommonFactorsN',
    'Score',
    'ScoreFormula',
    'RankMode',
    'R2_cal',
    'R2_std_mean',
    'm_cal',
    'm_std_mean',
    'SlopeAgreement',
    'beta_mean',
    'bias_index_mean',
    'SNR',
    'LOD',
    'LOQ',
    'n_stdadd',
    'n_unknown',
    'C0_mean',
    'C0_median',
    'C0_sd_median',
    'Estimate_value',
    'Estimate_sd',
    'Estimate_source',
  ];

  return createXlsxWorkbookBlob([
    { name: '01_CONTENTS', rows: tableRows(['Sheet', 'Purpose'], contentsRows) },
    { name: '02_METADATA', rows: tableRows(['Field', 'Value', 'Notes'], buildReportMetadataRows(options)) },
    { name: '03_OVERVIEW', rows: tableRows(['Field', 'Value'], overviewRows) },
    {
      name: '04_RAW',
      rows: tableRows(
        uniqueHeaders(['Row', 'Col', 'Well', 'ID', 'Type', 'Conc', 'DF', 'MeanW_Red', 'MeanW_Green', 'MeanW_Blue', 'MeanBG_Red', 'MeanBG_Green', 'MeanBG_Blue', 'SignalT_Red', 'SignalT_Green', 'SignalT_Blue', 'PAbs_Red', 'PAbs_Green', 'PAbs_Blue', 'L', 'a', 'b', 'DeltaL', 'Deltaa', 'Deltab', 'DeltaE_ab', 'DeltaE_ab_chroma', 'CIELAB_ref_source', 'ImageWarning'], rawRows),
        rawRows,
      ),
    },
    {
      name: '05_REPLICATES_MEAN',
      rows: tableRows(
        uniqueHeaders(['ID', 'DF', 'Type', 'Conc', 'PAbs_Red_median', 'PAbs_Red_sd', 'PAbs_Green_median', 'PAbs_Green_sd', 'PAbs_Blue_median', 'PAbs_Blue_sd', 'L_median', 'L_sd', 'a_median', 'a_sd', 'b_median', 'b_sd', 'DeltaL_median', 'DeltaL_sd', 'Deltaa_median', 'Deltaa_sd', 'Deltab_median', 'Deltab_sd', 'DeltaE_ab_median', 'DeltaE_ab_sd', 'DeltaE_ab_chroma_median', 'DeltaE_ab_chroma_sd', 'CIELAB_ref_source', 'NReplicates', 'QCFlagged', 'QCCritical'], replicateRows),
        replicateRows,
      ),
    },
    {
      name: '06_FITTING',
      rows: tableRows(
        uniqueHeaders(['Channel', 'FitType', 'n_points', 'm', 'q', 'R2', 'RMSE', 'sigma_cal', 'sigma_source', 'SNR', 'LOD', 'LOQ', 'ID', 'DF', 'C0', 'C0_sd', 'beta_k', 'bias_index_k', 'S0_calibration', 'S0_applied', 'NClipPoints', 'ClipX', 'ClipDelta'], fitRows),
        fitRows,
      ),
    },
    {
      name: '07_METHOD_COMPARISON',
      rows: tableRows(uniqueHeaders(methodComparisonPreferred, methodComparisonRows), methodComparisonRows),
    },
    {
      name: '08_LEGENDS',
      rows: tableRows(['Term', 'Meaning', 'Formula', 'Unit', 'Where used', 'Shown when', 'Notes'], buildReportLegendRows(options.unitLabel)),
    },
  ]);
}

interface PythonDiagnosticsWorkbookOptions extends PythonReportWorkbookOptions {
  wells: WellCenter[];
  geometry: PlateGeometry | null;
  backgroundDiagnostics: BackgroundVisualDiagnostics | null;
  radiusFactor: number;
  floorRoiRadiusFactor: number;
  floorCircles: FloorCircle[] | null;
}

function rowLabel(rowZeroBased: number): string {
  return Number.isFinite(rowZeroBased) ? String.fromCharCode(65 + rowZeroBased) : '';
}

function parseWellPosition(wellId: string): { row: number; col: number } | null {
  const match = /^([A-H])(\d{1,2})$/i.exec(wellId.trim());

  if (!match) {
    return null;
  }

  const row = match[1].toUpperCase().charCodeAt(0) - 65;
  const col = Number(match[2]) - 1;

  return Number.isInteger(row) && Number.isInteger(col) ? { row, col } : null;
}

function finiteOrBlank(value: number | null | undefined): number | '' {
  return typeof value === 'number' && Number.isFinite(value) ? value : '';
}

function diagnosticWellContext(
  wellId: string,
  wellsById: Map<string, WellCenter>,
): { row: number; col: number; rowName: string; colName: number | ''; center: WellCenter | null } {
  const center = wellsById.get(wellId) ?? null;
  const parsed = parseWellPosition(wellId);
  const row = center?.row ?? parsed?.row ?? Number.NaN;
  const col = center?.col ?? parsed?.col ?? Number.NaN;

  return {
    row,
    col,
    rowName: rowLabel(row),
    colName: Number.isFinite(col) ? col + 1 : '',
    center,
  };
}

function associatedWellsForBackgroundCell(cellRow: number, cellCol: number): string {
  if (!Number.isInteger(cellRow) || !Number.isInteger(cellCol) || cellRow < 0 || cellCol < 0 || cellRow > 6 || cellCol > 10) {
    return '';
  }

  return [
    `${rowLabel(cellRow)}${cellCol + 1}`,
    `${rowLabel(cellRow)}${cellCol + 2}`,
    `${rowLabel(cellRow + 1)}${cellCol + 1}`,
    `${rowLabel(cellRow + 1)}${cellCol + 2}`,
  ].join('-');
}

function buildDiagnosticsContentsRows(): XlsxRow[] {
  return [
    { Sheet: '01_CONTENTS', Purpose: 'Index of diagnostic sheets.' },
    { Sheet: '02_BG_SAMPLES', Purpose: 'Accepted inter-well background samples used to fit the BG surface.' },
    { Sheet: '03_BG_WELL_FIT', Purpose: 'Predicted local background at each well.' },
    { Sheet: '04_WELL_ROBUST_STATS', Purpose: 'Well-level robust pixel statistics and optical QC.' },
    { Sheet: '05_GEOMETRY_QC', Purpose: 'Floor/mouth geometry quality-control descriptors.' },
    { Sheet: '06_WELL_BOTTOM', Purpose: 'Detailed well-bottom and mouth geometry measurements.' },
    { Sheet: '07_PLATE_GEOMETRY', Purpose: 'Nominal plate geometry parameters used by the analyzer.' },
    { Sheet: '08_EMPTY_WELLS', Purpose: 'Empty-well diagnostic values when empty wells are present.' },
    { Sheet: '09_SPATIAL_DIAGNOSTICS', Purpose: 'Spatial trends across row/column positions.' },
    { Sheet: '10_METHOD_COMPARISON', Purpose: 'Cross-method diagnostic comparison using common score factors.' },
    { Sheet: '11_CIELAB_FITTING', Purpose: 'CIELAB/DeltaE diagnostic fit rows.' },
    { Sheet: '12_LEGENDS', Purpose: 'Definitions for diagnostic workbook fields and figures.' },
  ];
}

function buildDiagnosticsBackgroundSampleRows(options: PythonDiagnosticsWorkbookOptions): XlsxRow[] {
  const cellDiagnostics = options.backgroundDiagnostics?.diagnostics.cellDiagnostics ?? [];

  return cellDiagnostics.map((cell) => ({
    BG_Cell_Row: cell.cellRow,
    BG_Cell_Col: cell.cellColumn,
    Associated_Wells: associatedWellsForBackgroundCell(cell.cellRow, cell.cellColumn),
    x: finiteOrBlank(cell.acceptedCentroidX),
    y: finiteOrBlank(cell.acceptedCentroidY),
    area: cell.finalAcceptedPixels,
    Web_Sampled_Final_Accepted_Pixels: cell.sampledFinalAcceptedPixels ?? '',
    Web_FullRes_After_Well_Exclusion: cell.fullResolutionPixelsAfterWellDiskExclusion ?? '',
    Web_FullRes_Final_Accepted_Pixels: cell.fullResolutionFinalAcceptedPixels ?? '',
    Web_Projected_Cell_Area_Px: finiteOrBlank(cell.projectedPolygonAreaPx),
    Web_Raw_Canonical_Mask_Samples: cell.rawCanonicalMaskPixels,
    Web_Sampled_After_Well_Exclusion: cell.pixelsAfterWellDiskExclusion,
    Web_Sampled_After_Luminance_Chroma_Filtering: cell.pixelsAfterLuminanceChromaFiltering,
    Web_Zero_Reason: cell.zeroReason,
    Web_Geometry_Source: options.geometrySource,
    Red_median_raw: finiteOrBlank(cell.redMedianRaw),
    Green_median_raw: finiteOrBlank(cell.greenMedianRaw),
    Blue_median_raw: finiteOrBlank(cell.blueMedianRaw),
  }));
}

function buildDiagnosticsBackgroundWellFitRows(options: PythonDiagnosticsWorkbookOptions): XlsxRow[] {
  const wellsById = new Map(options.wells.map((well) => [well.wellId, well]));

  return options.measurements.map((measurement) => {
    const context = diagnosticWellContext(measurement.wellId, wellsById);

    return {
      Row: context.rowName,
      Col: context.colName,
      Well: measurement.wellId,
      x: finiteOrBlank(context.center?.x),
      y: finiteOrBlank(context.center?.y),
      BG_Red_raw: measurement.rgbBackground.r,
      BG_Green_raw: measurement.rgbBackground.g,
      BG_Blue_raw: measurement.rgbBackground.b,
    };
  });
}

function buildDiagnosticsBgModelInputRows(options: PythonDiagnosticsWorkbookOptions): XlsxRow[] {
  const fitInputs = options.backgroundDiagnostics?.physicalModelProof?.fitInputs ?? [];

  return fitInputs.map((sample) => ({
    BG_Cell_Row: sample.cellRow,
    BG_Cell_Col: sample.cellColumn,
    Associated_Wells: associatedWellsForBackgroundCell(sample.cellRow, sample.cellColumn),
    x: finiteOrBlank(sample.x),
    y: finiteOrBlank(sample.y),
    area: sample.area,
    Red_median_raw: finiteOrBlank(sample.redMedianRaw),
    Green_median_raw: finiteOrBlank(sample.greenMedianRaw),
    Blue_median_raw: finiteOrBlank(sample.blueMedianRaw),
  }));
}

function buildDiagnosticsBgModelCoefficientRows(options: PythonDiagnosticsWorkbookOptions): XlsxRow[] {
  const channelFits = options.backgroundDiagnostics?.physicalModelProof?.channelFits ?? [];

  return channelFits.map((fit) => ({
    Channel: fit.channel,
    Basis_Order: fit.basisOrder,
    x0: finiteOrBlank(fit.x0),
    y0: finiteOrBlank(fit.y0),
    sx: finiteOrBlank(fit.sx),
    sy: finiteOrBlank(fit.sy),
    coef_0: finiteOrBlank(fit.coefficients[0]),
    coef_1: finiteOrBlank(fit.coefficients[1]),
    coef_2: finiteOrBlank(fit.coefficients[2]),
    coef_3: finiteOrBlank(fit.coefficients[3]),
    coef_4: finiteOrBlank(fit.coefficients[4]),
    coef_5: finiteOrBlank(fit.coefficients[5]),
    samples_total: fit.samplesTotal,
    samples_retained: fit.samplesRetained,
    samples_rejected: fit.samplesRejected,
    residual_median: finiteOrBlank(fit.residualMedian),
    residual_mad: finiteOrBlank(fit.residualMad),
    residual_sigma: finiteOrBlank(fit.residualSigma),
    residual_max_abs: finiteOrBlank(fit.residualMaxAbs),
  }));
}

function buildDiagnosticsBgModelPredictionRows(options: PythonDiagnosticsWorkbookOptions): XlsxRow[] {
  const predictions = options.backgroundDiagnostics?.physicalModelProof?.wellPredictions ?? [];

  return predictions.map((prediction) => ({
    Row: rowLabel(prediction.row),
    Col: prediction.col + 1,
    Well: prediction.wellId,
    x: finiteOrBlank(prediction.x),
    y: finiteOrBlank(prediction.y),
    BG_Red_raw_model: finiteOrBlank(prediction.bgRedRawModel),
    BG_Green_raw_model: finiteOrBlank(prediction.bgGreenRawModel),
    BG_Blue_raw_model: finiteOrBlank(prediction.bgBlueRawModel),
  }));
}

function buildDiagnosticsWellRobustStatsRows(
  options: PythonDiagnosticsWorkbookOptions,
  cielabPoints: CielabDiagnosticPoint[],
): XlsxRow[] {
  const wellsById = new Map(options.wells.map((well) => [well.wellId, well]));
  const labByWell = new Map(cielabPoints.map((point) => [point.wellId, point]));

  return options.measurements.map((measurement) => {
    const context = diagnosticWellContext(measurement.wellId, wellsById);
    const lab = labByWell.get(measurement.wellId);
    const warnings = [
      ...measurement.warnings,
      measurement.roiStatisticsWarning ?? '',
      measurement.geometryAlignmentWarning ?? '',
    ].filter((warning) => warning.trim() !== '');

    return {
      Row: context.rowName,
      Col: context.colName,
      Well: measurement.wellId,
      n_roi: measurement.roiFullPixels ?? measurement.roiPixels,
      n_core: measurement.roiCorePixels ?? '',
      n_used: measurement.roiUsedPixels ?? measurement.roiPixels,
      used_fraction: measurement.roiUsedFraction ?? '',
      highlight_fraction_roi: measurement.highlightFractionRoi ?? '',
      highlight_fraction_core: measurement.highlightFractionCore ?? '',
      Gray_mean: '',
      Gray_median: '',
      Gray_sd: '',
      Gray_p10: '',
      Gray_p25: '',
      Gray_p50: '',
      Gray_p75: '',
      Gray_p90: '',
      Gray_iqr: '',
      Purple_mean: '',
      Purple_median: '',
      Purple_sd: '',
      Purple_p10: '',
      Purple_p25: '',
      Purple_p50: '',
      Purple_p75: '',
      Purple_p90: '',
      Purple_iqr: '',
      L_mean: '',
      L_median: lab?.l ?? '',
      L_sd: '',
      L_p10: '',
      L_p25: '',
      L_p50: lab?.l ?? '',
      L_p75: '',
      L_p90: '',
      L_iqr: '',
      a_mean: '',
      a_median: lab?.a ?? '',
      a_sd: '',
      a_p10: '',
      a_p25: '',
      a_p50: lab?.a ?? '',
      a_p75: '',
      a_p90: '',
      a_iqr: '',
      b_mean: '',
      b_median: lab?.b ?? '',
      b_sd: '',
      b_p10: '',
      b_p25: '',
      b_p50: lab?.b ?? '',
      b_p75: '',
      b_p90: '',
      b_iqr: '',
      BrightExcludedFraction: measurement.brightExcludedFraction ?? '',
      BrightExcludedMeanGray: measurement.brightExcludedMeanGray ?? '',
      BrightExcessMeanGray: measurement.brightExcessMeanGray ?? '',
      HighlightIndex: measurement.highlightIndex ?? '',
      is_image_quality_warning: warnings.length > 0 ? 1 : 0,
      warning_reason: warnings.join('; '),
      Red_mean: '',
      Green_mean: '',
      Blue_mean: '',
      Red_median: measurement.rgbWell.r,
      Green_median: measurement.rgbWell.g,
      Blue_median: measurement.rgbWell.b,
      Red_sd: '',
      Green_sd: '',
      Blue_sd: '',
      Red_p10: '',
      Green_p10: '',
      Blue_p10: '',
      Red_p25: '',
      Green_p25: '',
      Blue_p25: '',
      Red_p50: measurement.rgbWell.r,
      Green_p50: measurement.rgbWell.g,
      Blue_p50: measurement.rgbWell.b,
      Red_p75: '',
      Green_p75: '',
      Blue_p75: '',
      Red_p90: '',
      Green_p90: '',
      Blue_p90: '',
      Red_iqr: '',
      Green_iqr: '',
      Blue_iqr: '',
    };
  });
}

function buildDiagnosticsGeometryQcRows(options: PythonDiagnosticsWorkbookOptions): XlsxRow[] {
  const wellsById = new Map(options.wells.map((well) => [well.wellId, well]));
  const override = options.sharedGeometryOverride;

  return options.measurements.map((measurement) => {
    const context = diagnosticWellContext(measurement.wellId, wellsById);
    const overrideRecord = override?.recordsByWell.get(measurement.wellId);
    const floor = Number.isFinite(context.row) && Number.isFinite(context.col) && options.floorCircles?.length === options.wells.length
      ? options.floorCircles[context.row * 12 + context.col]
      : null;
    const fallbackMouthRadius = Number.isFinite(context.row) && Number.isFinite(context.col) && options.wells.length === 96
      ? estimateRoiRadius(options.wells, context.row, context.col, options.radiusFactor)
      : measurement.mouthRadiusUsed;
    const fallbackFloorRadius = floor && Number.isFinite(floor.r) ? floor.r : measurement.floorRadiusUsed;
    const mouthRadius = overrideRecord?.mouthRadius ?? measurement.mouthRadiusUsed ?? fallbackMouthRadius;
    const floorRadius = overrideRecord?.floorRadius ?? measurement.floorRadiusUsed ?? fallbackFloorRadius;
    const finiteMouthRadius = finiteOrBlank(mouthRadius);
    const finiteFloorRadius = finiteOrBlank(floorRadius);
    const shiftPx = floor && context.center ? Math.hypot(floor.x - context.center.x, floor.y - context.center.y) : Number.NaN;
    const ratio = typeof finiteMouthRadius === 'number' && finiteMouthRadius > 0 && typeof finiteFloorRadius === 'number' && finiteFloorRadius > 0
      ? finiteFloorRadius / finiteMouthRadius
      : Number.NaN;

    return {
      Row: context.rowName,
      Col: context.colName,
      Well: measurement.wellId,
      floor_source: overrideRecord ? `${overrideRecord.floorSource ?? 'manual_D_projection'}_override` : options.floorGeometryAvailable ? options.geometrySource : 'none',
      local_pitch_px: Number.isFinite(context.row) && Number.isFinite(context.col) && options.wells.length === 96
        ? overrideRecord?.localPitchPx ?? estimateLocalPitch(options.wells, context.row, context.col)
        : measurement.medianPitch ?? '',
      mouth_r: finiteMouthRadius,
      floor_r: finiteFloorRadius,
      shift_px: finiteOrBlank(shiftPx),
      shift_frac_of_mouth_r: Number.isFinite(shiftPx) && typeof finiteMouthRadius === 'number' && finiteMouthRadius > 0 ? shiftPx / finiteMouthRadius : '',
      floor_to_mouth_r_ratio: finiteOrBlank(ratio),
      floor_to_mouth_area_ratio: Number.isFinite(ratio) ? ratio ** 2 : '',
      D_warning: '',
      D_critical: '',
    };
  });
}

function buildDiagnosticsWellBottomRows(options: PythonDiagnosticsWorkbookOptions): XlsxRow[] {
  const wellsById = new Map(options.wells.map((well) => [well.wellId, well]));
  const override = options.sharedGeometryOverride;

  return options.measurements.map((measurement) => {
    const context = diagnosticWellContext(measurement.wellId, wellsById);
    const overrideRecord = override?.recordsByWell.get(measurement.wellId);
    const floor = Number.isFinite(context.row) && Number.isFinite(context.col) && options.floorCircles?.length === options.wells.length
      ? options.floorCircles[context.row * 12 + context.col]
      : null;
    const localPitch = Number.isFinite(context.row) && Number.isFinite(context.col) && options.wells.length === 96
      ? overrideRecord?.localPitchPx ?? estimateLocalPitch(options.wells, context.row, context.col)
      : Number.NaN;
    const fallbackMouthRadius = Number.isFinite(context.row) && Number.isFinite(context.col) && options.wells.length === 96
      ? estimateRoiRadius(options.wells, context.row, context.col, options.radiusFactor)
      : measurement.mouthRadiusUsed;
    const fallbackFloorRadius = floor && Number.isFinite(floor.r) ? floor.r : measurement.floorRadiusUsed;
    const mouthRadius = overrideRecord?.mouthRadius ?? measurement.mouthRadiusUsed ?? fallbackMouthRadius;
    const floorRadius = overrideRecord?.floorRadius ?? measurement.floorRadiusUsed ?? fallbackFloorRadius;
    const shiftPx = floor && context.center ? Math.hypot(floor.x - context.center.x, floor.y - context.center.y) : Number.NaN;

    return {
      Row: context.rowName,
      Col: context.colName,
      Well: measurement.wellId,
      cx: finiteOrBlank(context.center?.x),
      cy: finiteOrBlank(context.center?.y),
      local_pitch_px: finiteOrBlank(localPitch),
      px_per_mm: Number.isFinite(localPitch) ? localPitch / 9 : '',
      cyl_r_bg: measurement.wellExclusionRadiusApprox ?? '',
      mouth_r_geom: finiteOrBlank(overrideRecord?.mouthRadiusGeom ?? mouthRadius),
      floor_r_geom: finiteOrBlank(overrideRecord?.floorRadiusGeom ?? floorRadius),
      mouth_cx: finiteOrBlank(context.center?.x),
      mouth_cy: finiteOrBlank(context.center?.y),
      mouth_r: finiteOrBlank(mouthRadius),
      mouth_score: '',
      floor_cx: finiteOrBlank(floor?.x),
      floor_cy: finiteOrBlank(floor?.y),
      floor_r: finiteOrBlank(floorRadius),
      floor_score: '',
      shift_px: finiteOrBlank(shiftPx),
    };
  });
}

function buildDiagnosticsPlateGeometryRows(options: PythonDiagnosticsWorkbookOptions): XlsxRow[] {
  const geometry = options.geometry;
  const diagnostics = options.backgroundDiagnostics?.diagnostics;
  const rows: XlsxRow[] = [
    { key: 'image_basename', value: options.imageBase },
    { key: 'image_file', value: options.imageName ?? '' },
    { key: 'application', value: 'TIPICA webapp' },
    { key: 'application_version', value: packageJson.version },
    { key: 'geometry_name', value: options.geometryName ?? '' },
    { key: 'geometry_source', value: options.geometrySource },
    { key: 'roi_mode', value: options.methodMetadata.roiMode },
    { key: 'roi_pixel_statistics_mode', value: options.methodMetadata.roiPixelStatisticsMode },
    { key: 'background_model', value: options.methodMetadata.backgroundModel },
    { key: 'background_actual_model', value: options.methodMetadata.backgroundActualModel ?? '' },
    { key: 'background_mask_algorithm', value: options.methodMetadata.backgroundMaskAlgorithm ?? diagnostics?.maskAlgorithm ?? '' },
    { key: 'background_candidate_pixels', value: options.methodMetadata.backgroundCandidatePixels ?? diagnostics?.candidatePixels ?? '' },
    { key: 'background_accepted_pixels', value: diagnostics?.acceptedPixels ?? '' },
    { key: 'background_accepted_samples', value: options.methodMetadata.backgroundAcceptedSamples ?? diagnostics?.acceptedSamples ?? '' },
    { key: 'background_fit_success', value: diagnostics?.fitSuccess === undefined ? '' : diagnostics.fitSuccess ? 1 : 0 },
    { key: 'floor_geometry_available', value: options.floorGeometryAvailable ? 1 : 0 },
    { key: 'shared_geometry_override_active', value: options.sharedGeometryOverride ? 1 : 0 },
    { key: 'shared_geometry_override_source', value: options.sharedGeometryOverride?.sourceName ?? '' },
    { key: 'shared_geometry_override_wells', value: options.sharedGeometryOverride?.wellCount ?? '' },
    { key: 'shared_geometry_override_mapping', value: options.sharedGeometryOverride?.mappingSummary ?? '' },
    { key: 'roi_radius_factor', value: options.radiusFactor },
    { key: 'floor_roi_radius_factor', value: options.floorRoiRadiusFactor },
    { key: 'unit_label', value: options.unitLabel },
    { key: 'measurements', value: options.measurements.length },
    { key: 'plate_map_entries', value: options.plateMap.length },
    { key: 'missing_fields_note', value: 'Blank cells indicate Python diagnostic quantities not yet computed by the webapp.' },
  ];

  if (geometry) {
    rows.push(
      { key: 'corner_a1_x', value: geometry.corner_a1.x },
      { key: 'corner_a1_y', value: geometry.corner_a1.y },
      { key: 'corner_a12_x', value: geometry.corner_a12.x },
      { key: 'corner_a12_y', value: geometry.corner_a12.y },
      { key: 'corner_h12_x', value: geometry.corner_h12.x },
      { key: 'corner_h12_y', value: geometry.corner_h12.y },
      { key: 'corner_h1_x', value: geometry.corner_h1.x },
      { key: 'corner_h1_y', value: geometry.corner_h1.y },
      { key: 'mouth_radius_px', value: geometry.mouth_radius_px ?? '' },
      { key: 'geometry_roi_radius_factor', value: geometry.roi_radius_factor ?? '' },
    );
  }

  return rows;
}

function buildDiagnosticsEmptyWellRows(
  options: PythonDiagnosticsWorkbookOptions,
  cielabPoints: CielabDiagnosticPoint[],
): XlsxRow[] {
  const configByWell = new Map(options.plateMap.map((well) => [well.wellId, well]));
  const displayByWell = new Map(options.displayMeasurements.map((measurement) => [measurement.wellId, measurement]));
  const wellsById = new Map(options.wells.map((well) => [well.wellId, well]));
  const labByWell = new Map(cielabPoints.map((point) => [point.wellId, point]));

  return options.measurements
    .filter((measurement) => configByWell.get(measurement.wellId)?.role === 'EMPTY')
    .map((measurement) => {
      const display = displayByWell.get(measurement.wellId) ?? measurement;
      const context = diagnosticWellContext(measurement.wellId, wellsById);
      const lab = labByWell.get(measurement.wellId);
      const wellLinear = linearizeRgb(measurement.rgbWell);
      const backgroundLinear = linearizeRgb(measurement.rgbBackground);

      return {
        Row: context.rowName,
        Col: context.colName,
        Well: measurement.wellId,
        MeanW_Red: wellLinear.r,
        MeanBG_Red: backgroundLinear.r,
        PAbs_Red: display.pabs.r,
        MeanW_Green: wellLinear.g,
        MeanBG_Green: backgroundLinear.g,
        PAbs_Green: display.pabs.g,
        MeanW_Blue: wellLinear.b,
        MeanBG_Blue: backgroundLinear.b,
        PAbs_Blue: display.pabs.b,
        L: lab?.l ?? '',
        a: lab?.a ?? '',
        b: lab?.b ?? '',
        UsedFraction: measurement?.roiUsedFraction ?? '',
        BrightExcludedFraction: '',
        HighlightIndex: '',
      };
    });
}

function pearsonCorrelation(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) {
    return Number.NaN;
  }

  const xMean = meanFinite(xs);
  const yMean = meanFinite(ys);
  const numerator = xs.reduce((sum, x, index) => sum + (x - xMean) * (ys[index] - yMean), 0);
  const xDenominator = Math.sqrt(xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0));
  const yDenominator = Math.sqrt(ys.reduce((sum, y) => sum + (y - yMean) ** 2, 0));

  return xDenominator > 0 && yDenominator > 0 ? numerator / (xDenominator * yDenominator) : Number.NaN;
}

function buildSpatialDiagnosticRow(dataset: string, measurements: WellMeasurement[]): XlsxRow {
  const points = measurements
    .map((measurement) => ({
      row: parseWellPosition(measurement.wellId)?.row ?? Number.NaN,
      col: parseWellPosition(measurement.wellId)?.col ?? Number.NaN,
      y: measurement.pabs.r,
    }))
    .filter((point) => Number.isFinite(point.row) && Number.isFinite(point.col) && Number.isFinite(point.y));

  if (points.length < 3) {
    return {
      Dataset: dataset,
      Status: 'not_applied',
      Applicability: 'requires usable unknown or empty wells distributed across rows/columns',
      Reason: 'fewer than 3 usable wells available for this spatial-trend dataset',
      n: points.length,
      intercept: '',
      slope_col: '',
      slope_row: '',
      R2: '',
      corr_col: '',
      corr_row: '',
    };
  }

  const colFit = fitLinearRegression(points.map((point) => point.col), points.map((point) => point.y));
  const rowFit = fitLinearRegression(points.map((point) => point.row), points.map((point) => point.y));
  const slopeCol = Number.isFinite(colFit.slope) ? colFit.slope : 0;
  const slopeRow = Number.isFinite(rowFit.slope) ? rowFit.slope : 0;
  const intercept = meanFinite(points.map((point) => point.y))
    - slopeCol * meanFinite(points.map((point) => point.col))
    - slopeRow * meanFinite(points.map((point) => point.row));
  const residuals = points.map((point) => point.y - (intercept + slopeCol * point.col + slopeRow * point.row));
  const yMean = meanFinite(points.map((point) => point.y));
  const sse = residuals.reduce((sum, residual) => sum + residual ** 2, 0);
  const sst = points.reduce((sum, point) => sum + (point.y - yMean) ** 2, 0);
  const r2 = sst > 1e-12 ? 1 - sse / sst : Number.NaN;

  return {
    Dataset: dataset,
    Status: 'applied',
    Applicability: 'requires usable unknown or empty wells distributed across rows/columns',
    Reason: '',
    n: points.length,
    intercept,
    slope_col: slopeCol,
    slope_row: slopeRow,
    R2: finiteOrBlank(r2),
    corr_col: finiteOrBlank(pearsonCorrelation(points.map((point) => point.col), points.map((point) => point.y))),
    corr_row: finiteOrBlank(pearsonCorrelation(points.map((point) => point.row), points.map((point) => point.y))),
  };
}

function buildDiagnosticsSpatialRows(options: PythonDiagnosticsWorkbookOptions): XlsxRow[] {
  const configByWell = new Map(options.plateMap.map((well) => [well.wellId, well]));
  const unknownMeasurements = options.displayMeasurements.filter((measurement) => configByWell.get(measurement.wellId)?.role === 'U');

  return [
    buildSpatialDiagnosticRow('unknown', unknownMeasurements),
    buildSpatialDiagnosticRow('empty', []),
  ];
}

const CIELAB_REPORT_DESCRIPTORS = [
  { channel: 'L', getValue: (point: CielabDiagnosticPoint) => point.l },
  { channel: 'a', getValue: (point: CielabDiagnosticPoint) => point.a },
  { channel: 'b', getValue: (point: CielabDiagnosticPoint) => point.b },
  { channel: 'DeltaL', getValue: (point: CielabDiagnosticPoint) => point.deltaL },
  { channel: 'Deltaa', getValue: (point: CielabDiagnosticPoint) => point.deltaA },
  { channel: 'Deltab', getValue: (point: CielabDiagnosticPoint) => point.deltaB },
  { channel: 'DeltaE_ab', getValue: (point: CielabDiagnosticPoint) => point.deltaE },
  { channel: 'DeltaE_ab_chroma', getValue: (point: CielabDiagnosticPoint) => point.deltaEChroma },
] as const;

const CIELAB_DIAGNOSTIC_DESCRIPTORS = CIELAB_REPORT_DESCRIPTORS.filter((descriptor) => descriptor.channel.startsWith('Delta'));

type CielabFittingDescriptor = (typeof CIELAB_REPORT_DESCRIPTORS)[number];

function cielabValueAsNumber(value: number | ''): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
}

function diagnosticCielabPointsForRole(
  points: CielabDiagnosticPoint[],
  role: string,
  sampleId?: string,
  dilutionFactor?: number,
): CielabDiagnosticPoint[] {
  return points.filter((point) => {
    if (point.type !== role || typeof point.conc !== 'number') {
      return false;
    }

    if (sampleId !== undefined && point.id.trim() !== sampleId.trim()) {
      return false;
    }

    if (dilutionFactor !== undefined && Math.abs(point.df - dilutionFactor) > 1e-12) {
      return false;
    }

    return true;
  });
}

function groupedMedianCielabFitRows(points: CielabDiagnosticPoint[], getValue: (point: CielabDiagnosticPoint) => number | ''): { x: number; y: number }[] {
  const groups = new Map<number, number[]>();

  points.forEach((point) => {
    if (typeof point.conc !== 'number' || !Number.isFinite(point.conc)) {
      return;
    }

    const value = cielabValueAsNumber(getValue(point));

    if (!Number.isFinite(value)) {
      return;
    }

    const values = groups.get(point.conc) ?? [];
    values.push(value);
    groups.set(point.conc, values);
  });

  return [...groups.entries()]
    .map(([x, values]) => ({ x, y: medianFinite(values) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .sort((a, b) => a.x - b.x);
}

function buildCielabFittingRows(
  points: CielabDiagnosticPoint[],
  descriptors: readonly CielabFittingDescriptor[] = CIELAB_REPORT_DESCRIPTORS,
  storedCalibration?: StoredCalibration | null,
): XlsxRow[] {
  const rows: XlsxRow[] = [];
  const calibrationPoints = diagnosticCielabPointsForRole(points, 'C');
  const standardGroups = new Map<string, { sampleId: string; dilutionFactor: number; points: CielabDiagnosticPoint[] }>();

  points.forEach((point) => {
    if (point.type !== 'A' || typeof point.conc !== 'number' || point.id.trim() === '') {
      return;
    }

    const key = `${point.id}\u0000${point.df}`;
    const group = standardGroups.get(key);

    if (group) {
      group.points.push(point);
    } else {
      standardGroups.set(key, { sampleId: point.id, dilutionFactor: point.df, points: [point] });
    }
  });

  descriptors.forEach((descriptor) => {
    const groupedCalRows = groupedMedianCielabFitRows(calibrationPoints, descriptor.getValue);
    const xCal = groupedCalRows.map((point) => point.x);
    const yCal = groupedCalRows.map((point) => point.y);
    const calFit = fitLineWithCovariance(xCal, yCal);
    const calPointRows = calibrationPoints
      .map((point) => ({ x: point.conc as number, y: cielabValueAsNumber(descriptor.getValue(point)) }))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    const groupedCalibration = new Map<number, number[]>();

    calPointRows.forEach((point) => {
      const values = groupedCalibration.get(point.x) ?? [];
      values.push(point.y);
      groupedCalibration.set(point.x, values);
    });

    const sigmaCal = medianFinite([...groupedCalibration.values()].map(sampleStandardDeviation).filter(Number.isFinite));
    const lod = Number.isFinite(sigmaCal) && sigmaCal > 0 && Number.isFinite(calFit.slope) && Math.abs(calFit.slope) > 1e-15
      ? (3 * sigmaCal) / Math.abs(calFit.slope)
      : Number.NaN;
    const loq = Number.isFinite(sigmaCal) && sigmaCal > 0 && Number.isFinite(calFit.slope) && Math.abs(calFit.slope) > 1e-15
      ? (10 * sigmaCal) / Math.abs(calFit.slope)
      : Number.NaN;

    if (calFit.n > 0) {
      rows.push({
        Channel: descriptor.channel,
        FitType: 'Calibration',
        ID: '',
        DF: '',
        n_points: calFit.n,
        m: finiteOrBlank(calFit.slope),
        q: finiteOrBlank(calFit.intercept),
        R2: finiteOrBlank(calFit.r2),
        RMSE: finiteRmse(groupedCalRows, calFit.slope, calFit.intercept),
        LOD: finiteOrBlank(lod),
        LOQ: finiteOrBlank(loq),
        C0: '',
        C0_sd: '',
        sigma_cal: finiteOrBlank(sigmaCal),
        sigma_source: Number.isFinite(sigmaCal) ? 'median_calibration_sd' : 'unavailable',
        SNR: Number.isFinite(sigmaCal) && sigmaCal > 0 && Number.isFinite(calFit.slope) ? Math.abs(calFit.slope) / sigmaCal : '',
        beta_k: '',
        bias_index_k: '',
      });
    }

    standardGroups.forEach((group) => {
      const groupedStdRows = groupedMedianCielabFitRows(group.points, descriptor.getValue);
      const xStd = groupedStdRows.map((point) => point.x);
      const yStd = groupedStdRows.map((point) => point.y);
      const stdFit = fitLineWithCovariance(xStd, yStd);
      const storedSlope = resolveStoredCalibrationSlopeForCielabDescriptor(descriptor.channel, storedCalibration);
      const { beta, biasIndex } = computeCielabStdAddBetaBias(stdFit.slope, calFit.slope, storedSlope);
      const c0Fit = stdAddC0SdFromFit(stdFit);
      const c0 = Number.isFinite(c0Fit.c0)
        ? group.dilutionFactor * c0Fit.c0
        : Number.NaN;
      const c0Sd = Number.isFinite(c0Fit.c0Sd)
        ? group.dilutionFactor * c0Fit.c0Sd
        : '';

      rows.push({
        Channel: descriptor.channel,
        FitType: 'StdAdd',
        ID: group.sampleId,
        DF: group.dilutionFactor,
        n_points: stdFit.n,
        m: finiteOrBlank(stdFit.slope),
        q: finiteOrBlank(stdFit.intercept),
        R2: finiteOrBlank(stdFit.r2),
        RMSE: finiteRmse(groupedStdRows, stdFit.slope, stdFit.intercept),
        LOD: '',
        LOQ: '',
        C0: finiteOrBlank(c0),
        C0_sd: c0Sd,
        sigma_cal: '',
        sigma_source: '',
        SNR: '',
        beta_k: finiteOrBlank(beta),
        bias_index_k: finiteOrBlank(biasIndex),
      });
    });
  });

  return rows;
}

function buildDiagnosticsLegendRows(unitLabel: string): XlsxRow[] {
  return [
    { Term: 'BG_STAT_MASK', Meaning: 'Overlay diagnostic image of accepted inter-well background pixels', Formula: 'accepted BG mask composited over source image', Unit: 'image', 'Where used': 'BG_STAT_MASK.png', Notes: 'The exact Python binary-mask rendering is not yet reproduced.' },
    { Term: 'BG_Cell_Row/BG_Cell_Col', Meaning: 'Inter-well background-cell row/column index', Formula: '0-based grid index of the inter-well cell, not a well row/column', Unit: 'index', 'Where used': '02_BG_SAMPLES', Notes: 'Populated when physical inter-well cell diagnostics are available.' },
    { Term: 'Associated_Wells', Meaning: 'Four wells surrounding an inter-well BG sample cell', Formula: 'well(r,c)-well(r,c+1)-well(r+1,c)-well(r+1,c+1)', Unit: 'well labels', 'Where used': '02_BG_SAMPLES', Notes: '' },
    { Term: 'Row/Col/Well', Meaning: 'Human-readable well position', Formula: 'Row is A-based; Col is 1-based; Well = Row+Col', Unit: 'well label', 'Where used': '03_BG_WELL_FIT, 04_WELL_ROBUST_STATS, 05_GEOMETRY_QC, 06_WELL_BOTTOM, 08_EMPTY_WELLS', Notes: '' },
    { Term: 'x/y', Meaning: 'Image coordinates', Formula: 'pixel coordinate in analyzed image', Unit: 'pixel', 'Where used': '02_BG_SAMPLES, 03_BG_WELL_FIT, 06_WELL_BOTTOM', Notes: 'For 02_BG_SAMPLES, x/y are the centroid of accepted background pixels when physical inter-well diagnostics are available.' },
    { Term: 'area', Meaning: 'Accepted mask area', Formula: 'number of full-resolution accepted pixels in the BG sample mask', Unit: 'pixels', 'Where used': '02_BG_SAMPLES', Notes: 'Diagnostics-only parity field; the physical background fit still uses the existing sampled web model inputs.' },
    { Term: 'Web_Sampled_Final_Accepted_Pixels', Meaning: 'Sampled BG points retained by the current web physical background model for this cell', Formula: 'count after sampled canonical-cell generation and per-cell robust filtering', Unit: 'sampled points', 'Where used': '02_BG_SAMPLES', Notes: 'Previously this sampled count was reported as area; retained to diagnose sampling versus mask-area differences.' },
    { Term: 'Web_FullRes_After_Well_Exclusion', Meaning: 'Full-resolution candidate pixels remaining after canonical BG model and well exclusion', Formula: 'integer image pixels in the inter-well cell after model/background and neighboring-well exclusion', Unit: 'pixels', 'Where used': '02_BG_SAMPLES', Notes: 'Diagnostics only; not used to change quantitative outputs.' },
    { Term: 'Web_FullRes_Final_Accepted_Pixels', Meaning: 'Full-resolution accepted pixels used for the Python-style area field', Formula: 'full-resolution cell candidates after web per-cell robust filtering', Unit: 'pixels', 'Where used': '02_BG_SAMPLES', Notes: 'Same value as area when available.' },
    { Term: 'Web_Projected_Cell_Area_Px / Web_Raw_Canonical_Mask_Samples / Web_Sampled_After_*', Meaning: 'Intermediate web BG-cell validation counters', Formula: 'projected cell polygon area and sampled-candidate counts at major filtering stages', Unit: 'pixels or sampled points', 'Where used': '02_BG_SAMPLES', Notes: 'These are web validation extensions for diagnosing geometry/mask/sample-count differences.' },
    { Term: 'Web_Zero_Reason', Meaning: 'Cell-level reason when the final accepted BG cell is empty', Formula: 'diagnostic category inferred from sampled/full-resolution cell counters', Unit: 'text', 'Where used': '02_BG_SAMPLES', Notes: 'Diagnostics only; not consumed by quantitative outputs.' },
    { Term: 'Web_Geometry_Source', Meaning: 'Geometry provenance used for the current extraction/export run', Formula: 'same source label exported in metadata and geometry sheets', Unit: 'text', 'Where used': '02_BG_SAMPLES', Notes: 'Repeated per BG cell to simplify direct Python-vs-web comparison joins.' },
    { Term: 'BG_Red_raw/BG_Green_raw/BG_Blue_raw', Meaning: 'Predicted or sampled local raw background at a well', Formula: 'background model value at well center', Unit: 'raw image intensity', 'Where used': '03_BG_WELL_FIT', Notes: 'Exported in standard RGB order.' },
    { Term: 'n_roi/n_core/n_used', Meaning: 'Pixel counts used during well ROI filtering', Formula: 'ROI pixels, core pixels and retained pixels', Unit: 'pixels', 'Where used': '04_WELL_ROBUST_STATS', Notes: '' },
    { Term: 'used_fraction/UsedFraction', Meaning: 'Fraction of ROI core pixels retained after filtering', Formula: 'n_used / n_core', Unit: 'dimensionless', 'Where used': '04_WELL_ROBUST_STATS, 08_EMPTY_WELLS', Notes: '' },
    { Term: 'Red_median/Green_median/Blue_median', Meaning: 'Median well RGB intensities currently computed by the webapp', Formula: 'median over sampled ROI pixels after selected ROI statistics mode', Unit: 'raw image intensity', 'Where used': '04_WELL_ROBUST_STATS', Notes: 'Distribution percentiles and SD remain blank because the webapp does not retain them.' },
    { Term: 'L/a/b', Meaning: 'CIELAB coordinates derived from extracted well RGB values', Formula: 'sRGB-like RGB to CIE L*a*b* conversion using D65 reference white', Unit: 'dimensionless', 'Where used': '04_WELL_ROBUST_STATS, 08_EMPTY_WELLS, 11_CIELAB_FITTING', Notes: 'Diagnostic descriptor, not the primary quantitative output.' },
    { Term: 'DeltaL/Deltaa/Deltab/DeltaE_ab/DeltaE_ab_chroma', Meaning: 'CIELAB difference descriptors', Formula: 'Delta values relative to zero or lowest calibration reference; DeltaE_ab = sqrt(DeltaL^2 + Deltaa^2 + Deltab^2)', Unit: 'dimensionless', 'Where used': '11_CIELAB_FITTING, FIGURE_CIELAB_DELTAE.png', Notes: '' },
    { Term: 'floor_source/local_pitch_px/px_per_mm/cyl_r_bg', Meaning: 'Geometry-source and local scale descriptors', Formula: 'reported source, local pitch, pixel/mm scale and background exclusion radius', Unit: 'mixed', 'Where used': '05_GEOMETRY_QC, 06_WELL_BOTTOM', Notes: 'px_per_mm assumes 9.0 mm 96-well pitch.' },
    { Term: 'mouth_* / floor_*', Meaning: 'Mouth/floor circle center and radius descriptors', Formula: 'projected circle parameters from loaded geometry and current ROI settings', Unit: 'pixels', 'Where used': '06_WELL_BOTTOM', Notes: 'Mouth/floor scores are blank because the webapp does not compute Python detector scores.' },
    { Term: 'shift_px/shift_frac_of_mouth_r/floor_to_mouth_r_ratio/floor_to_mouth_area_ratio', Meaning: 'Mouth-to-floor alignment descriptors', Formula: 'shift distance and relative floor/mouth radius or area ratios', Unit: 'pixels or dimensionless', 'Where used': '05_GEOMETRY_QC, 06_WELL_BOTTOM', Notes: '' },
    { Term: 'D_warning/D_critical', Meaning: 'Floor-geometry warning and critical flags', Formula: 'Python threshold flags', Unit: '0/1', 'Where used': '05_GEOMETRY_QC', Notes: 'Blank because the webapp does not compute Python floor-geometry warning thresholds.' },
    { Term: 'MeanW_*/MeanBG_*/PAbs_*', Meaning: 'Linearized well intensity, background intensity and RGB pseudo-absorbance', Formula: 'PAbs = log10(MeanBG / MeanW)', Unit: 'dimensionless', 'Where used': '08_EMPTY_WELLS, 10_METHOD_COMPARISON', Notes: '' },
    { Term: 'Dataset/Status/Applicability/Reason', Meaning: 'Applicability status for optional spatial diagnostics', Formula: 'applied or not_applied with reason text', Unit: 'text', 'Where used': '09_SPATIAL_DIAGNOSTICS', Notes: 'Unknown spatial diagnostics use PAbs_Red when unknown wells are available; empty spatial diagnostics require Python-style structural empty rows and remain not_applied in the webapp.' },
    { Term: 'n/intercept/slope_col/slope_row/R2/corr_col/corr_row', Meaning: 'Spatial-trend descriptors', Formula: 'linear trend of PAbs_Red versus row/column position', Unit: 'mixed', 'Where used': '09_SPATIAL_DIAGNOSTICS', Notes: 'Diagnostic only; does not alter quantitative results.' },
    { Term: 'Method/Family/ComparableGroup/CommonFactorsN/RankMode', Meaning: 'Method-comparison identifiers and comparable-score grouping', Formula: 'text labels and number of factors defining score comparability', Unit: 'mixed', 'Where used': '10_METHOD_COMPARISON, METHOD_COMPARISON.png', Notes: 'Scores are directly comparable only within the same ComparableGroup.' },
    { Term: 'Score/ScoreFormula', Meaning: 'Common method-ranking score and formula descriptor', Formula: 'slope_agreement^2 x sqrt(R2_cal x R2_std) x (1/LOQ) when LOQ is available', Unit: `1/${unitLabel}`, 'Where used': '10_METHOD_COMPARISON, METHOD_COMPARISON.png', Notes: 'Expected/reference values, SNR and clipping are not part of Score.' },
    { Term: 'R2_cal/R2_std_mean/m_cal/m_std_mean/SlopeAgreement', Meaning: 'Fit-quality and slope-agreement descriptors for method comparison', Formula: 'SlopeAgreement = min(abs(m_cal), abs(m_std_mean)) / max(abs(m_cal), abs(m_std_mean))', Unit: 'mixed', 'Where used': '10_METHOD_COMPARISON, METHOD_COMPARISON.png', Notes: '' },
    { Term: 'C0_mean/C0_median/C0_sd_median', Meaning: 'Summary of available original-concentration estimates', Formula: 'mean/median of C0 estimates and median of associated C0_sd values', Unit: unitLabel, 'Where used': '10_METHOD_COMPARISON', Notes: 'C0_sd is populated from the robust IRLS covariance when the rewired fit path exposes it.' },
    { Term: 'Channel/FitType/ID/DF/n_points/m/q/R2/RMSE', Meaning: 'Diagnostic fitting identifiers and robust IRLS descriptors', Formula: 'y = m x + q; R2 = 1 - SSE/SST; RMSE = sqrt(mean(residual^2))', Unit: 'mixed', 'Where used': '11_CIELAB_FITTING', Notes: 'CIELAB/DeltaE exported fitting rows use the Python robust IRLS port; full CIELAB parity still depends on descriptor-input parity.' },
    { Term: 'LOD/LOQ', Meaning: 'Detection and quantification limits', Formula: 'LOD = 3 sigma_cal / abs(m); LOQ = 10 sigma_cal / abs(m)', Unit: unitLabel, 'Where used': '10_METHOD_COMPARISON, 11_CIELAB_FITTING', Notes: '' },
    { Term: 'sigma_cal/sigma_source/SNR', Meaning: 'Calibration noise estimate, source and slope-to-noise ratio', Formula: 'SNR = abs(m) / sigma_cal', Unit: 'mixed', 'Where used': '10_METHOD_COMPARISON, 11_CIELAB_FITTING', Notes: 'SNR is diagnostic and is not part of the common Score.' },
    { Term: 'beta_k/bias_index_k', Meaning: 'Per-fit slope ratio and relative slope-bias index', Formula: 'beta_k = m_std / m_cal; bias_index_k = abs(beta_k - 1)', Unit: 'dimensionless', 'Where used': '11_CIELAB_FITTING', Notes: '' },
    { Term: 'Blank cells', Meaning: 'Unavailable Python diagnostic quantities', Formula: 'left blank when the webapp does not currently compute the Python field', Unit: 'mixed', 'Where used': 'all sheets', Notes: 'No placeholder or fake values are generated.' },
    { Term: 'Code implementation', Meaning: 'Main computational libraries and code provenance', Formula: 'browser TypeScript using built-in Canvas, XML and ZIP helpers', Unit: 'software provenance', 'Where used': 'DIAGNOSTICS.xlsx and diagnostic PNG files', Notes: 'Workbook uses the existing browser-side XLSX writer; no new dependency was added.' },
  ];
}

async function createPythonDiagnosticsWorkbookBlob(options: PythonDiagnosticsWorkbookOptions): Promise<Blob> {
  const { points: cielabPoints } = buildCielabDiagnosticPoints(options.measurements, options.plateMap, options.storedCalibration?.cielabReference);
  const rgbFitRows = buildReportFitRows(
    options.measurements,
    options.calibrationFits,
    options.standardAdditionFits,
    options.unknownResults,
    options.displayMeasurements,
    options.plateMap,
    options.rankings,
    options.lowSignalCorrections,
  );
  const methodComparisonRows = buildMethodComparisonRowsFromFitRows([
    ...rgbFitRows,
    ...storedCalibrationDiagnosticFitRows(options.storedCalibration),
    ...buildCielabFittingRows(cielabPoints, undefined, options.storedCalibration),
  ], options.expectedRefs, false);
  const methodComparisonPreferred = [
    'Method',
    'Family',
    'ComparableGroup',
    'CommonFactorsN',
    'Score',
    'ScoreFormula',
    'RankMode',
    'R2_cal',
    'R2_std_mean',
    'm_cal',
    'm_std_mean',
    'SlopeAgreement',
    'beta_mean',
    'bias_index_mean',
    'C0_median',
    'C0_sd_median',
    'Estimate_value',
    'Estimate_sd',
    'Estimate_source',
    'LOD',
    'LOQ',
    'SNR',
    'n_stdadd',
    'n_unknown',
    'C0_mean',
  ];

  return createXlsxWorkbookBlob([
    { name: '01_CONTENTS', rows: tableRows(['Sheet', 'Purpose'], buildDiagnosticsContentsRows()) },
    {
      name: '02_BG_SAMPLES',
      rows: tableRows(
        ['BG_Cell_Row', 'BG_Cell_Col', 'Associated_Wells', 'x', 'y', 'area', 'Web_Sampled_Final_Accepted_Pixels', 'Web_FullRes_After_Well_Exclusion', 'Web_FullRes_Final_Accepted_Pixels', 'Web_Projected_Cell_Area_Px', 'Web_Raw_Canonical_Mask_Samples', 'Web_Sampled_After_Well_Exclusion', 'Web_Sampled_After_Luminance_Chroma_Filtering', 'Web_Zero_Reason', 'Web_Geometry_Source', 'Red_median_raw', 'Green_median_raw', 'Blue_median_raw'],
        buildDiagnosticsBackgroundSampleRows(options),
      ),
    },
    {
      name: '03_BG_WELL_FIT',
      rows: tableRows(
        ['Row', 'Col', 'Well', 'x', 'y', 'BG_Red_raw', 'BG_Green_raw', 'BG_Blue_raw'],
        buildDiagnosticsBackgroundWellFitRows(options),
      ),
    },
    {
      name: '04_WELL_ROBUST_STATS',
      rows: tableRows(
        ['Row', 'Col', 'Well', 'n_roi', 'n_core', 'n_used', 'used_fraction', 'highlight_fraction_roi', 'highlight_fraction_core', 'Gray_mean', 'Gray_median', 'Gray_sd', 'Gray_p10', 'Gray_p25', 'Gray_p50', 'Gray_p75', 'Gray_p90', 'Gray_iqr', 'Purple_mean', 'Purple_median', 'Purple_sd', 'Purple_p10', 'Purple_p25', 'Purple_p50', 'Purple_p75', 'Purple_p90', 'Purple_iqr', 'L_mean', 'L_median', 'L_sd', 'L_p10', 'L_p25', 'L_p50', 'L_p75', 'L_p90', 'L_iqr', 'a_mean', 'a_median', 'a_sd', 'a_p10', 'a_p25', 'a_p50', 'a_p75', 'a_p90', 'a_iqr', 'b_mean', 'b_median', 'b_sd', 'b_p10', 'b_p25', 'b_p50', 'b_p75', 'b_p90', 'b_iqr', 'BrightExcludedFraction', 'BrightExcludedMeanGray', 'BrightExcessMeanGray', 'HighlightIndex', 'is_image_quality_warning', 'warning_reason', 'Red_mean', 'Green_mean', 'Blue_mean', 'Red_median', 'Green_median', 'Blue_median', 'Red_sd', 'Green_sd', 'Blue_sd', 'Red_p10', 'Green_p10', 'Blue_p10', 'Red_p25', 'Green_p25', 'Blue_p25', 'Red_p50', 'Green_p50', 'Blue_p50', 'Red_p75', 'Green_p75', 'Blue_p75', 'Red_p90', 'Green_p90', 'Blue_p90', 'Red_iqr', 'Green_iqr', 'Blue_iqr'],
        buildDiagnosticsWellRobustStatsRows(options, cielabPoints),
      ),
    },
    {
      name: '05_GEOMETRY_QC',
      rows: tableRows(
        ['Row', 'Col', 'Well', 'floor_source', 'local_pitch_px', 'mouth_r', 'floor_r', 'shift_px', 'shift_frac_of_mouth_r', 'floor_to_mouth_r_ratio', 'floor_to_mouth_area_ratio', 'D_warning', 'D_critical'],
        buildDiagnosticsGeometryQcRows(options),
      ),
    },
    {
      name: '06_WELL_BOTTOM',
      rows: tableRows(
        ['Row', 'Col', 'Well', 'cx', 'cy', 'local_pitch_px', 'px_per_mm', 'cyl_r_bg', 'mouth_r_geom', 'floor_r_geom', 'mouth_cx', 'mouth_cy', 'mouth_r', 'mouth_score', 'floor_cx', 'floor_cy', 'floor_r', 'floor_score', 'shift_px'],
        buildDiagnosticsWellBottomRows(options),
      ),
    },
    { name: '07_PLATE_GEOMETRY', rows: tableRows(['key', 'value'], buildDiagnosticsPlateGeometryRows(options)) },
    {
      name: '08_EMPTY_WELLS',
      rows: tableRows(
        ['Row', 'Col', 'Well', 'MeanW_Red', 'MeanBG_Red', 'PAbs_Red', 'MeanW_Green', 'MeanBG_Green', 'PAbs_Green', 'MeanW_Blue', 'MeanBG_Blue', 'PAbs_Blue', 'L', 'a', 'b', 'UsedFraction', 'BrightExcludedFraction', 'HighlightIndex'],
        buildDiagnosticsEmptyWellRows(options, cielabPoints),
      ),
    },
    {
      name: '09_SPATIAL_DIAGNOSTICS',
      rows: tableRows(
        ['Dataset', 'Status', 'Applicability', 'Reason', 'n', 'intercept', 'slope_col', 'slope_row', 'R2', 'corr_col', 'corr_row'],
        buildDiagnosticsSpatialRows(options),
      ),
    },
    {
      name: '10_METHOD_COMPARISON',
      rows: tableRows(uniqueHeaders(methodComparisonPreferred, methodComparisonRows), methodComparisonRows),
    },
    {
      name: '11_CIELAB_FITTING',
      rows: tableRows(
        ['Channel', 'FitType', 'ID', 'DF', 'n_points', 'm', 'q', 'R2', 'RMSE', 'LOD', 'LOQ', 'C0', 'C0_sd', 'sigma_cal', 'sigma_source', 'SNR', 'beta_k', 'bias_index_k'],
        buildCielabFittingRows(cielabPoints, CIELAB_DIAGNOSTIC_DESCRIPTORS, options.storedCalibration),
      ),
    },
    {
      name: '12_LEGENDS',
      rows: tableRows(['Term', 'Meaning', 'Formula', 'Unit', 'Where used', 'Notes'], buildDiagnosticsLegendRows(options.unitLabel)),
    },
  ]);
}

async function createWebBgModelProofWorkbookBlob(options: PythonDiagnosticsWorkbookOptions): Promise<Blob> {
  const contentsRows: XlsxRow[] = [
    { Sheet: '13_BG_MODEL_INPUTS', Purpose: 'Proof-only BG polynomial fit inputs exported by the web path.' },
    { Sheet: '14_BG_MODEL_COEFFICIENTS', Purpose: 'Proof-only BG polynomial coefficients and robust-fit summaries exported by the web path.' },
    { Sheet: '15_BG_MODEL_PREDICTIONS', Purpose: 'Proof-only per-well raw BG predictions from the fitted web BG model before downstream transformations.' },
  ];

  return createXlsxWorkbookBlob([
    { name: '01_CONTENTS', rows: tableRows(['Sheet', 'Purpose'], contentsRows) },
    {
      name: '13_BG_MODEL_INPUTS',
      rows: tableRows(
        ['BG_Cell_Row', 'BG_Cell_Col', 'Associated_Wells', 'x', 'y', 'area', 'Red_median_raw', 'Green_median_raw', 'Blue_median_raw'],
        buildDiagnosticsBgModelInputRows(options),
      ),
    },
    {
      name: '14_BG_MODEL_COEFFICIENTS',
      rows: tableRows(
        ['Channel', 'Basis_Order', 'x0', 'y0', 'sx', 'sy', 'coef_0', 'coef_1', 'coef_2', 'coef_3', 'coef_4', 'coef_5', 'samples_total', 'samples_retained', 'samples_rejected', 'residual_median', 'residual_mad', 'residual_sigma', 'residual_max_abs'],
        buildDiagnosticsBgModelCoefficientRows(options),
      ),
    },
    {
      name: '15_BG_MODEL_PREDICTIONS',
      rows: tableRows(
        ['Row', 'Col', 'Well', 'x', 'y', 'BG_Red_raw_model', 'BG_Green_raw_model', 'BG_Blue_raw_model'],
        buildDiagnosticsBgModelPredictionRows(options),
      ),
    },
  ]);
}

function pointColorForRole(role: string): string {
  if (role === 'C') {
    return '#2563c7';
  }
  if (role === 'A') {
    return '#1f8a4c';
  }
  if (role === 'U') {
    return '#cf2e2e';
  }
  return '#6b7280';
}

function drawSimpleAxis(
  ctx: CanvasRenderingContext2D,
  plot: { x: number; y: number; width: number; height: number },
  xRange: { min: number; max: number },
  yRange: { min: number; max: number },
  xLabel: string,
  yLabel: string,
): { xToPx: (value: number) => number; yToPx: (value: number) => number } {
  const xToPx = (value: number) => plot.x + ((value - xRange.min) / (xRange.max - xRange.min)) * plot.width;
  const yToPx = (value: number) => plot.y + plot.height - ((value - yRange.min) / (yRange.max - yRange.min)) * plot.height;
  const xTicks = niceTicks(xRange.min, xRange.max, 5);
  const yTicks = niceTicks(yRange.min, yRange.max, 5);

  ctx.strokeStyle = '#dce4e1';
  ctx.lineWidth = 1;
  xTicks.forEach((tick) => {
    const x = xToPx(tick);
    ctx.beginPath();
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.height);
    ctx.stroke();
  });
  yTicks.forEach((tick) => {
    const y = yToPx(tick);
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.width, y);
    ctx.stroke();
  });

  ctx.strokeStyle = '#263238';
  ctx.lineWidth = 2;
  ctx.strokeRect(plot.x, plot.y, plot.width, plot.height);
  ctx.fillStyle = '#465255';
  ctx.font = '18px Inter, Arial, sans-serif';
  xTicks.forEach((tick) => ctx.fillText(formatFitCell(tick), xToPx(tick) - 20, plot.y + plot.height + 28));
  yTicks.forEach((tick) => ctx.fillText(formatFitCell(tick), plot.x - 68, yToPx(tick) + 6));
  ctx.fillStyle = '#263238';
  ctx.font = '700 20px Inter, Arial, sans-serif';
  ctx.fillText(xLabel, plot.x + plot.width / 2 - 120, plot.y + plot.height + 58);
  ctx.save();
  ctx.translate(plot.x - 92, plot.y + plot.height / 2 + 70);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();

  return { xToPx, yToPx };
}

const CIELAB_COMPOSITE_CHANNELS = ['DeltaE_ab', 'DeltaE_ab_chroma', 'DeltaL', 'Deltaa', 'Deltab'] as const;

type CielabCompositeChannel = (typeof CIELAB_COMPOSITE_CHANNELS)[number];

interface CielabCompositePoint {
  x: number;
  y: number;
  yerr: number;
}

interface CielabCompositeStdGroup {
  sampleId: string;
  dilutionFactor: number;
  fit: XlsxRow | undefined;
  points: CielabCompositePoint[];
}

function cielabCompositeDisplayName(channel: CielabCompositeChannel): string {
  return channel;
}

function cielabCompositeColor(channel: CielabCompositeChannel): string {
  const palette: Record<CielabCompositeChannel, string> = {
    DeltaE_ab: '#2b3437',
    DeltaE_ab_chroma: '#7a4d00',
    DeltaL: '#405f0a',
    Deltaa: '#5b2c83',
    Deltab: '#0b6b76',
  };

  return palette[channel];
}

function cielabCompositeValueGetter(channel: CielabCompositeChannel): (point: CielabDiagnosticPoint) => number | '' {
  const descriptor = CIELAB_REPORT_DESCRIPTORS.find((item) => item.channel === channel);

  if (descriptor) {
    return descriptor.getValue;
  }

  return (point: CielabDiagnosticPoint) => point.deltaE;
}

function collectCielabCompositeCalibrationPoints(
  channel: CielabCompositeChannel,
  points: CielabDiagnosticPoint[],
): CielabCompositePoint[] {
  const calibrationPoints = diagnosticCielabPointsForRole(points, 'C');
  const grouped = groupedMedianCielabFitRows(calibrationPoints, cielabCompositeValueGetter(channel));
  const yerrByX = new Map<number, number>();

  grouped.forEach((groupedPoint) => {
    const values = calibrationPoints
      .filter((point) => Number.isFinite(point.conc) && Math.abs((point.conc as number) - groupedPoint.x) <= 1e-12)
      .map((point) => cielabValueAsNumber(cielabCompositeValueGetter(channel)(point)))
      .filter(Number.isFinite);
    yerrByX.set(groupedPoint.x, sampleStandardDeviation(values));
  });

  return grouped.map((point) => ({
    x: point.x,
    y: point.y,
    yerr: yerrByX.get(point.x) ?? 0,
  }));
}

function collectCielabCompositeStdGroups(
  channel: CielabCompositeChannel,
  points: CielabDiagnosticPoint[],
  fitRows: XlsxRow[],
): CielabCompositeStdGroup[] {
  const stdRows = fitRows.filter((row) => row.FitType === 'StdAdd' && String(row.Channel) === channel);
  const groups: CielabCompositeStdGroup[] = [];

  stdRows.forEach((fitRow) => {
    const sampleId = String(fitRow.ID ?? '');
    const dilutionFactor = numericRowValue(fitRow, 'DF');
    const stdPointsRaw = diagnosticCielabPointsForRole(points, 'A', sampleId, dilutionFactor);
    const grouped = groupedMedianCielabFitRows(stdPointsRaw, cielabCompositeValueGetter(channel));
    const yerrByX = new Map<number, number>();

    grouped.forEach((groupedPoint) => {
      const values = stdPointsRaw
        .filter((point) => Number.isFinite(point.conc) && Math.abs((point.conc as number) - groupedPoint.x) <= 1e-12)
        .map((point) => cielabValueAsNumber(cielabCompositeValueGetter(channel)(point)))
        .filter(Number.isFinite);
      yerrByX.set(groupedPoint.x, sampleStandardDeviation(values));
    });

    groups.push({
      sampleId,
      dilutionFactor,
      fit: fitRow,
      points: grouped.map((point) => ({ x: point.x, y: point.y, yerr: yerrByX.get(point.x) ?? 0 })),
    });
  });

  return groups;
}

function buildCielabCompositeScientificLines({
  unitLabel,
  measurements,
  plateMap,
  expectedRefs,
  fitRows,
  comparisonRows,
  selectedDescriptor,
}: {
  unitLabel: string;
  measurements: WellMeasurement[];
  plateMap: WellConfig[];
  expectedRefs: ExpectedRef[];
  fitRows: XlsxRow[];
  comparisonRows: XlsxRow[];
  selectedDescriptor: string;
}): Array<{ text: string; emphasize?: boolean }> {
  const lines: Array<{ text: string; emphasize?: boolean }> = [];
  const comparisonByMethod = new Map(comparisonRows.map((row) => [String(row.Method ?? ''), row]));
  const selectedLabel = selectedDescriptor.trim();
  const pushText = (text: string, emphasize = false) => lines.push({ text, emphasize });
  const pushTable = (tableLines: string[]) => {
    tableLines.forEach((line, index) => {
      const isDataRow = index >= 2;
      const selectedRow = isDataRow && line.trimStart().startsWith(selectedLabel);
      pushText(line, selectedRow);
    });
  };
  const stdRows = fitRows.filter((row) => row.FitType === 'StdAdd');
  const calRows = fitRows.filter((row) => row.FitType === 'Calibration');
  const hasStd = stdRows.length > 0;
  const hasCal = calRows.length > 0;
  const modeLabel = hasCal && hasStd
    ? 'calibration + standard addition'
    : hasCal
      ? 'calibration only'
      : hasStd
        ? 'standard addition only'
        : 'no valid analytical fit available';
  const flagged = measurements.filter((measurement) => measurement.warnings.length > 0 || Boolean(measurement.roiStatisticsWarning || measurement.geometryAlignmentWarning)).length;
  const critical = measurements.filter((measurement) => (
    [...measurement.warnings, measurement.roiStatisticsWarning ?? '', measurement.geometryAlignmentWarning ?? '']
      .some((warning) => warning.toLowerCase().includes('critical'))
  )).length;
  const total = measurements.length;
  const plateStatus = critical === 0 && flagged <= Math.max(1, Math.floor(total * 0.2)) ? 'Passed' : 'Warning';

  pushText('DeltaE_ab = sqrt((L-Lref)^2 + (a-aref)^2 + (b-bref)^2)');
  pushText('DeltaE_ab,chroma = sqrt((a-aref)^2 + (b-bref)^2)');
  pushText('');
  pushText(`Mode: ${modeLabel}`);
  pushText('Fit: robust IRLS for exported fit rows');
  pushText(`Plate: ${plateMap.length}-well | QC: ${plateStatus}`);
  pushText(`Plate QC: wells flagged ${flagged}/${total} | wells critical ${critical}/${total}`);
  pushText('');
  pushText('REFERENCE VALUES', true);
  if (expectedRefs.length === 0) {
    pushText('NA');
  } else {
    expectedRefs.forEach((ref, index) => {
      const label = ref.label.trim() || ref.refId.trim() || `Reference ${index + 1}`;
      const valueText = formatFigureScientificNumber(ref.value);
      const sdText = ref.sd !== null && Number.isFinite(ref.sd) ? ` +/- ${formatFigureScientificNumber(ref.sd)}` : '';
      pushText(`${label}: ${valueText}${sdText} ${unitLabel}`);
    });
  }

  const groups = new Map<string, XlsxRow[]>();
  stdRows.forEach((row) => {
    const key = `${stringRowValue(row, 'ID')}|${numericRowValue(row, 'DF')}`;
    const items = groups.get(key) ?? [];
    items.push(row);
    groups.set(key, items);
  });

  for (const [groupKey, rows] of groups.entries()) {
    const [sampleId, dilutionFactorRaw] = groupKey.split('|');
    const dilutionFactor = Number(dilutionFactorRaw);
    pushText('');
    pushText(`Std Add | ID: ${sampleId} | DF=${formatFigureScientificNumber(dilutionFactor)}`, true);

    const resultRows = CIELAB_COMPOSITE_CHANNELS.map((channel) => {
      const fitRow = rows.find((row) => String(row.Channel) === channel);
      const methodRow = comparisonByMethod.get(channel);
      const c0 = numericRowValue(fitRow, 'C0');
      const score = numericRowValue(methodRow, 'Score');
      const matchedRef = expectedRefs.find((ref) => referenceMatchesSample(ref, sampleId));
      const refValue = matchedRef?.value ?? Number.NaN;
      const delta = Number.isFinite(c0) && Number.isFinite(refValue) ? c0 - refValue : Number.NaN;
      const recovery = Number.isFinite(c0) && Number.isFinite(refValue) && Math.abs(refValue) > 1e-15
        ? (100 * c0) / refValue
        : Number.NaN;
      return [
        cielabCompositeDisplayName(channel),
        formatFigureScientificNumber(c0),
        formatFigureScientificNumber(score),
        formatFigureScientificNumber(delta),
        Number.isFinite(recovery) ? recovery.toFixed(1) : 'NA',
      ];
    });
    pushTable(formatFigureRgbTable(
      ['Channel', `C0 (${unitLabel})`, 'Score', `Delta (${unitLabel})`, 'Recovery (%)'],
      resultRows,
    ));

    pushText('');
    pushText('Calibration', true);
    const calibrationRows = CIELAB_COMPOSITE_CHANNELS.map((channel) => {
      const calRow = calRows.find((row) => String(row.Channel) === channel);
      const methodRow = comparisonByMethod.get(channel);
      return [
        cielabCompositeDisplayName(channel),
        formatFigureScientificNumber(numericRowValue(calRow, 'm')),
        formatFigureScientificNumber(numericRowValue(calRow, 'q')),
        formatFigureScientificNumber(numericRowValue(calRow, 'R2')),
        formatFigureScientificNumber(numericRowValue(methodRow, 'LOD')),
        formatFigureScientificNumber(numericRowValue(methodRow, 'LOQ')),
      ];
    });
    pushTable(formatFigureRgbTable(
      ['Channel', 'Slope', 'Intercept', 'R2', `LOD (${unitLabel})`, `LOQ (${unitLabel})`],
      calibrationRows,
    ));

    pushText('');
    pushText(`Std Add | ID: ${sampleId} | DF=${formatFigureScientificNumber(dilutionFactor)}`, true);
    const stdFitRows = CIELAB_COMPOSITE_CHANNELS.map((channel) => {
      const fitRow = rows.find((row) => String(row.Channel) === channel);
      return [
        cielabCompositeDisplayName(channel),
        formatFigureScientificNumber(numericRowValue(fitRow, 'm')),
        formatFigureScientificNumber(numericRowValue(fitRow, 'q')),
        formatFigureScientificNumber(numericRowValue(fitRow, 'R2')),
      ];
    });
    pushTable(formatFigureRgbTable(['Channel', 'Slope', 'Intercept', 'R2'], stdFitRows));
  }

  return lines;
}

function drawPythonStyleCielabCompositePanel(
  ctx: CanvasRenderingContext2D,
  bounds: { x: number; y: number; width: number; height: number },
  channel: CielabCompositeChannel,
  calibrationFit: XlsxRow | undefined,
  standardGroups: CielabCompositeStdGroup[],
  calibrationPoints: CielabCompositePoint[],
  methodRow: XlsxRow | undefined,
  unitLabel: string,
  expectedRefs: ExpectedRef[],
): void {
  const color = cielabCompositeColor(channel);
  const margin = { left: 84, right: 24, top: 62, bottom: 78 };
  const plot = {
    x: bounds.x + margin.left,
    y: bounds.y + margin.top,
    width: bounds.width - margin.left - margin.right,
    height: bounds.height - margin.top - margin.bottom,
  };

  const stdFits = standardGroups.map((group) => group.fit).filter((fit): fit is XlsxRow => Boolean(fit));
  const stdPoints = standardGroups.flatMap((group) => group.points);
  const refXValues = standardGroups.flatMap((group) => expectedRefs.flatMap((ref) => {
    if (!referenceMatchesSample(ref, group.sampleId)) {
      return [];
    }

    const x = -ref.value / Math.max(group.dilutionFactor, 1e-12);
    const xSd = ref.sd !== null && Number.isFinite(ref.sd)
      ? Math.abs(ref.sd / Math.max(group.dilutionFactor, 1e-12))
      : Number.NaN;
    return Number.isFinite(x)
      ? [x, Number.isFinite(xSd) ? x - xSd : Number.NaN, Number.isFinite(xSd) ? x + xSd : Number.NaN]
      : [];
  }));

  const calibrationSlope = numericRowValue(calibrationFit, 'm');
  const calibrationIntercept = numericRowValue(calibrationFit, 'q');
  const xRange = rangeWithPadding([
    ...calibrationPoints.map((point) => point.x),
    ...stdPoints.map((point) => point.x),
    ...refXValues,
    ...stdFits.flatMap((fit) => {
      const slope = numericRowValue(fit, 'm');
      const intercept = numericRowValue(fit, 'q');
      if (!Number.isFinite(slope) || Math.abs(slope) <= 1e-15 || !Number.isFinite(intercept)) {
        return [];
      }

      return [-intercept / slope];
    }),
  ], 0, 1);
  const yFromFits = [
    Number.isFinite(calibrationSlope) && Number.isFinite(calibrationIntercept)
      ? calibrationSlope * xRange.min + calibrationIntercept
      : Number.NaN,
    Number.isFinite(calibrationSlope) && Number.isFinite(calibrationIntercept)
      ? calibrationSlope * xRange.max + calibrationIntercept
      : Number.NaN,
    ...stdFits.flatMap((fit) => {
      const slope = numericRowValue(fit, 'm');
      const intercept = numericRowValue(fit, 'q');
      return Number.isFinite(slope) && Number.isFinite(intercept)
        ? [slope * xRange.min + intercept, slope * xRange.max + intercept]
        : [];
    }),
  ];
  const yRange = rangeWithPadding([
    ...calibrationPoints.map((point) => point.y),
    ...calibrationPoints.flatMap((point) => Number.isFinite(point.yerr) && point.yerr > 0 ? [point.y - point.yerr, point.y + point.yerr] : []),
    ...stdPoints.map((point) => point.y),
    ...stdPoints.flatMap((point) => Number.isFinite(point.yerr) && point.yerr > 0 ? [point.y - point.yerr, point.y + point.yerr] : []),
    ...yFromFits,
    ...(refXValues.length > 0 ? [0] : []),
  ], 0, 1, 0.10);
  const xToPx = (value: number) => plot.x + ((value - xRange.min) / (xRange.max - xRange.min)) * plot.width;
  const yToPx = (value: number) => plot.y + plot.height - ((value - yRange.min) / (yRange.max - yRange.min)) * plot.height;
  const xTicks = niceTicks(xRange.min, xRange.max, 5);
  const yTicks = niceTicks(yRange.min, yRange.max, 5);

  ctx.save();
  ctx.fillStyle = '#1d2628';
  ctx.font = '700 24px "Courier New", Consolas, monospace';
  ctx.fillText(cielabCompositeDisplayName(channel), bounds.x + 12, bounds.y + 34);
  if (methodRow) {
    const rankText = [
      `Score ${formatFitCell(numericRowValue(methodRow, 'Score'))}`,
      `R2cal ${formatFitCell(numericRowValue(methodRow, 'R2_cal'))}`,
      `R2std ${formatFitCell(numericRowValue(methodRow, 'R2_std_mean'))}`,
      `LOQ ${formatFitCell(numericRowValue(methodRow, 'LOQ'))}`,
    ].join('  ');
    ctx.font = '600 13px "Courier New", Consolas, monospace';
    ctx.fillStyle = '#465255';
    ctx.fillText(rankText, plot.x + Math.max(0, plot.width - ctx.measureText(rankText).width - 4), bounds.y + 34);
  }

  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(plot.x, plot.y);
  ctx.lineTo(plot.x, plot.y + plot.height);
  ctx.lineTo(plot.x + plot.width, plot.y + plot.height);
  ctx.stroke();

  ctx.fillStyle = '#000000';
  ctx.font = '600 13px "Courier New", Consolas, monospace';
  xTicks.forEach((tick) => {
    const px = xToPx(tick);
    ctx.beginPath();
    ctx.moveTo(px, plot.y + plot.height);
    ctx.lineTo(px, plot.y + plot.height + 8);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.fillText(formatFitCell(tick), px - 14, plot.y + plot.height + 24);
  });
  yTicks.forEach((tick) => {
    const py = yToPx(tick);
    ctx.beginPath();
    ctx.moveTo(plot.x - 8, py);
    ctx.lineTo(plot.x, py);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.fillText(formatPAbsCell(tick), bounds.x + 10, py + 5);
  });

  ctx.fillStyle = '#000000';
  ctx.font = '700 16px "Courier New", Consolas, monospace';
  ctx.fillText(`Added concentration (${unitLabel})`, plot.x + plot.width / 2 - 150, bounds.y + bounds.height - 14);
  ctx.save();
  ctx.translate(bounds.x + 20, plot.y + plot.height / 2 + 62);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(cielabCompositeDisplayName(channel), 0, 0);
  ctx.restore();

  if (Number.isFinite(calibrationSlope) && Number.isFinite(calibrationIntercept)) {
    ctx.save();
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(xToPx(xRange.min), yToPx(calibrationSlope * xRange.min + calibrationIntercept));
    ctx.lineTo(xToPx(xRange.max), yToPx(calibrationSlope * xRange.max + calibrationIntercept));
    ctx.stroke();
    ctx.restore();
  }

  calibrationPoints.forEach((point) => {
    const px = xToPx(point.x);
    const py = yToPx(point.y);
    if (Number.isFinite(point.yerr) && point.yerr > 0) {
      drawVerticalErrorBar(ctx, px, yToPx(point.y - point.yerr), yToPx(point.y + point.yerr), 10, color);
    }
    ctx.beginPath();
    ctx.arc(px, py, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.4;
    ctx.stroke();
  });

  standardGroups.forEach((group) => {
    const slope = numericRowValue(group.fit, 'm');
    const intercept = numericRowValue(group.fit, 'q');
    if (Number.isFinite(slope) && Number.isFinite(intercept)) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.8;
      ctx.beginPath();
      ctx.moveTo(xToPx(xRange.min), yToPx(slope * xRange.min + intercept));
      ctx.lineTo(xToPx(xRange.max), yToPx(slope * xRange.max + intercept));
      ctx.stroke();
    }

    group.points.forEach((point) => {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        return;
      }

      const px = xToPx(point.x);
      const py = yToPx(point.y);
      if (Number.isFinite(point.yerr) && point.yerr > 0) {
        drawVerticalErrorBar(ctx, px, yToPx(point.y - point.yerr), yToPx(point.y + point.yerr), 10, color);
      }

      ctx.fillStyle = color;
      ctx.fillRect(px - 5, py - 5, 10, 10);
    });

    expectedRefs.forEach((ref) => {
      if (!referenceMatchesSample(ref, group.sampleId)) {
        return;
      }

      const x = -ref.value / Math.max(group.dilutionFactor, 1e-12);
      if (!Number.isFinite(x)) {
        return;
      }

      const px = xToPx(x);
      const py = yToPx(0);
      const xSd = ref.sd !== null && Number.isFinite(ref.sd)
        ? Math.abs(ref.sd / Math.max(group.dilutionFactor, 1e-12))
        : Number.NaN;
      ctx.save();
      ctx.strokeStyle = '#8a3ffc';
      ctx.lineWidth = 1.9;
      if (Number.isFinite(xSd) && xSd > 0) {
        drawHorizontalErrorBar(ctx, xToPx(x - xSd), xToPx(x + xSd), py, 10, '#8a3ffc');
      }
      ctx.beginPath();
      ctx.moveTo(px, py - 6);
      ctx.lineTo(px + 6, py);
      ctx.lineTo(px, py + 6);
      ctx.lineTo(px - 6, py);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    });
  });

  const legendX = plot.x + 10;
  let legendY = plot.y + 18;
  ctx.fillStyle = '#000000';
  ctx.font = '600 14px "Courier New", Consolas, monospace';
  ctx.fillText('o calibration (dashed)', legendX, legendY);
  legendY += 18;
  ctx.fillText('s standard addition (solid)', legendX, legendY);
  if (expectedRefs.length > 0) {
    legendY += 18;
    ctx.fillStyle = '#6d36c9';
    ctx.fillText('d reference +/- SD', legendX, legendY);
  }

  ctx.restore();
}

function buildPythonStyleCielabDeltaECanvas(
  imageBase: string,
  overlayCanvas: HTMLCanvasElement,
  measurements: WellMeasurement[],
  plateMap: WellConfig[],
  unitLabel: string,
  expectedRefs: ExpectedRef[],
  storedCielabReference?: StoredCielabReference,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const width = 2481;
  const height = 3021;
  const ctx = canvas.getContext('2d');
  canvas.width = width;
  canvas.height = height;

  if (!ctx) {
    throw new Error('Could not create CIELAB/DeltaE diagnostic canvas.');
  }

  const { points } = buildCielabDiagnosticPoints(measurements, plateMap, storedCielabReference);
  const compositeDescriptors = CIELAB_REPORT_DESCRIPTORS.filter((descriptor) =>
    CIELAB_COMPOSITE_CHANNELS.includes(descriptor.channel as CielabCompositeChannel),
  );
  const fitRows = buildCielabFittingRows(points, compositeDescriptors, undefined);
  const comparisonRows = buildMethodComparisonRowsFromFitRows(fitRows, expectedRefs, true);
  const selectedDescriptor = String(comparisonRows[0]?.Method ?? CIELAB_COMPOSITE_CHANNELS[0]);
  const scientificLines = buildCielabCompositeScientificLines({
    unitLabel,
    measurements,
    plateMap,
    expectedRefs,
    fitRows,
    comparisonRows,
    selectedDescriptor,
  });

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  drawImageCover(ctx, overlayCanvas, overlayCanvas.width, overlayCanvas.height, 110, 70, 940, 650);
  ctx.fillStyle = '#172026';
  ctx.font = '700 34px Inter, Arial, sans-serif';
  ctx.fillText(`${imageBase} CIELAB / DeltaE report`, 110, 760);

  ctx.fillStyle = '#253033';
  drawPreformattedLines(
    ctx,
    scientificLines,
    110,
    812,
    24,
    height - 95,
    '18px Consolas, "Courier New", monospace',
    '700 18px Consolas, "Courier New", monospace',
  );

  const comparisonByMethod = new Map(comparisonRows.map((row) => [String(row.Method ?? ''), row]));
  const panelX = 1190;
  const panelWidth = 1160;
  const panelHeight = 520;
  const panelGap = 40;

  CIELAB_COMPOSITE_CHANNELS.forEach((channel, index) => {
    drawPythonStyleCielabCompositePanel(
      ctx,
      { x: panelX, y: 70 + index * (panelHeight + panelGap), width: panelWidth, height: panelHeight },
      channel,
      fitRows.find((row) => row.FitType === 'Calibration' && String(row.Channel) === channel),
      collectCielabCompositeStdGroups(channel, points, fitRows),
      collectCielabCompositeCalibrationPoints(channel, points),
      comparisonByMethod.get(channel),
      unitLabel,
      expectedRefs,
    );
  });

  return canvas;
}

function xlsxNumber(row: XlsxRow, key: string): number {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
}

function xlsxString(row: XlsxRow, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

function methodComparisonRefPayload(ref: ExpectedRef, index: number): { label: string; value: number; sd: number } {
  return {
    label: ref.label.trim() || `Reference ${index + 1}`,
    value: ref.value,
    sd: ref.sd !== null && Number.isFinite(ref.sd) ? ref.sd : Number.NaN,
  };
}

function methodComparisonNearestReference(value: number, expectedRefs: ExpectedRef[]): {
  label: string;
  value: number;
  sd: number;
  delta: number;
  absDelta: number;
} | null {
  if (!Number.isFinite(value)) {
    return null;
  }

  let best: {
    label: string;
    value: number;
    sd: number;
    delta: number;
    absDelta: number;
  } | null = null;

  expectedRefs.forEach((ref, index) => {
    const payload = methodComparisonRefPayload(ref, index);
    if (!Number.isFinite(payload.value)) {
      return;
    }

    const delta = value - payload.value;
    const absDelta = Math.abs(delta);
    if (!best || absDelta < best.absDelta) {
      best = {
        label: payload.label,
        value: payload.value,
        sd: payload.sd,
        delta,
        absDelta,
      };
    }
  });

  return best;
}

function isLowReliabilityMethodComparisonRow(row: XlsxRow, expectedRefs: ExpectedRef[]): boolean {
  const agreement = xlsxNumber(row, 'SlopeAgreement');
  const r2Cal = xlsxNumber(row, 'R2_cal');
  const r2Std = xlsxNumber(row, 'R2_std_mean');
  if (Number.isFinite(agreement) && agreement < 0.5) {
    return true;
  }
  if (Number.isFinite(r2Cal) && r2Cal < 0.8) {
    return true;
  }
  if (Number.isFinite(r2Std) && r2Std < 0.8) {
    return true;
  }

  const estimate = xlsxNumber(row, 'Estimate_value');
  const nearestRef = methodComparisonNearestReference(estimate, expectedRefs);
  if (!nearestRef) {
    return false;
  }

  const sdThreshold = Number.isFinite(nearestRef.sd) && nearestRef.sd > 0 ? 3 * nearestRef.sd : Number.NaN;
  const relativeThreshold = 0.5 * Math.abs(nearestRef.value);
  const threshold = Number.isFinite(sdThreshold)
    ? Math.max(sdThreshold, relativeThreshold)
    : relativeThreshold;
  return Number.isFinite(threshold) && Math.abs(nearestRef.delta) > threshold;
}

function buildPythonStyleMethodComparisonCanvas(
  imageBase: string,
  comparisonRows: XlsxRow[],
  expectedRefs: ExpectedRef[],
  unitLabel: string,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const width = 2160;
  const height = 1420;
  const ctx = canvas.getContext('2d');
  canvas.width = width;
  canvas.height = height;

  if (!ctx) {
    throw new Error('Could not create method-comparison diagnostic canvas.');
  }

  const rows = comparisonRows.filter((row) => Number.isFinite(xlsxNumber(row, 'Estimate_value')) || Number.isFinite(xlsxNumber(row, 'C0_median')));
  const methods = rows.map((row) => String(row.Method ?? ''));
  const xPositions = rows.map((_, index) => index);
  const panelLeft = 165;
  const panelWidth = 1840;
  const panelHeight = 315;
  const panelGap = 95;
  const top = 150;
  const xRange = { min: -0.5, max: Math.max(rows.length - 0.5, 0.5) };

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#172026';
  ctx.font = '700 38px Inter, Arial, sans-serif';
  ctx.fillText(`${imageBase} method comparison`, 100, 72);
  ctx.font = '20px Inter, Arial, sans-serif';
  ctx.fillStyle = '#344044';
  ctx.fillText('Score uses common fit factors only; external references are checks and do not affect ranking.', 100, 108);

  const drawMethodLabels = (plot: { x: number; y: number; width: number; height: number }, xToPx: (value: number) => number) => {
    ctx.save();
    ctx.fillStyle = '#344044';
    ctx.font = '18px Inter, Arial, sans-serif';
    methods.forEach((method, index) => {
      ctx.save();
      ctx.translate(xToPx(index) - 8, plot.y + plot.height + 28);
      ctx.rotate(-Math.PI / 5);
      ctx.fillText(method, 0, 0);
      ctx.restore();
    });
    ctx.restore();
  };

  const agreementValues = rows.flatMap((row) => [xlsxNumber(row, 'SlopeAgreement'), xlsxNumber(row, 'bias_index_mean')]).filter(Number.isFinite);
  const agreementPlot = { x: panelLeft, y: top, width: panelWidth, height: panelHeight };
  const agreementAxis = drawSimpleAxis(ctx, agreementPlot, xRange, rangeWithPadding([...agreementValues, 0, 1], 0, 1, 0.10), 'Method', 'agreement / bias');
  ctx.save();
  ctx.setLineDash([8, 6]);
  ctx.strokeStyle = '#2563c7';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(agreementPlot.x, agreementAxis.yToPx(1));
  ctx.lineTo(agreementPlot.x + agreementPlot.width, agreementAxis.yToPx(1));
  ctx.stroke();
  ctx.strokeStyle = '#cf2e2e';
  ctx.beginPath();
  ctx.moveTo(agreementPlot.x, agreementAxis.yToPx(0));
  ctx.lineTo(agreementPlot.x + agreementPlot.width, agreementAxis.yToPx(0));
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = '#2563c7';
  ctx.lineWidth = 3;
  ctx.beginPath();
  let firstSlopePoint = true;
  rows.forEach((row, index) => {
    const value = xlsxNumber(row, 'SlopeAgreement');
    if (!Number.isFinite(value)) {
      return;
    }
    const x = agreementAxis.xToPx(index);
    const y = agreementAxis.yToPx(value);
    if (firstSlopePoint) {
      ctx.moveTo(x, y);
      firstSlopePoint = false;
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();

  ctx.save();
  ctx.setLineDash([10, 6]);
  ctx.strokeStyle = '#cf2e2e';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  let firstBiasPoint = true;
  rows.forEach((row, index) => {
    const value = xlsxNumber(row, 'bias_index_mean');
    if (!Number.isFinite(value)) {
      return;
    }
    const x = agreementAxis.xToPx(index);
    const y = agreementAxis.yToPx(value);
    if (firstBiasPoint) {
      ctx.moveTo(x, y);
      firstBiasPoint = false;
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();
  ctx.restore();

  rows.forEach((row, index) => {
    const slope = xlsxNumber(row, 'SlopeAgreement');
    const bias = xlsxNumber(row, 'bias_index_mean');
    if (Number.isFinite(slope)) {
      ctx.fillStyle = '#2563c7';
      ctx.beginPath();
      ctx.arc(agreementAxis.xToPx(index), agreementAxis.yToPx(slope), 8, 0, Math.PI * 2);
      ctx.fill();
    }
    if (Number.isFinite(bias)) {
      ctx.fillStyle = '#cf2e2e';
      ctx.fillRect(agreementAxis.xToPx(index) - 7, agreementAxis.yToPx(bias) - 7, 14, 14);
    }
  });

  const estimateValues = rows.map((row) => xlsxNumber(row, 'Estimate_value')).filter(Number.isFinite);
  const refValues = expectedRefs.map((ref) => ref.value).filter(Number.isFinite);
  const referencePlot = { x: panelLeft, y: top + panelHeight + panelGap, width: panelWidth, height: panelHeight };
  let yLo = 0;
  let yHi = 1;
  const refPayloads = expectedRefs
    .map((ref, index) => methodComparisonRefPayload(ref, index))
    .filter((payload) => Number.isFinite(payload.value));
  if (refPayloads.length > 0) {
    const refCenter = medianFinite(refPayloads.map((payload) => payload.value));
    const refRange = Math.max(...refPayloads.map((payload) => payload.value)) - Math.min(...refPayloads.map((payload) => payload.value));
    const maxSd = Math.max(...refPayloads.map((payload) => Number.isFinite(payload.sd) ? payload.sd : Number.NaN).filter(Number.isFinite), Math.max(1, 0.03 * Math.max(Math.abs(refCenter), 1)));
    const robustWindow = Math.max(20, 0.75 * Math.max(Math.abs(refCenter), 1), 6 * maxSd, 2 * refRange);
    const axisValues: number[] = [];
    refPayloads.forEach((payload) => {
      const sd = Number.isFinite(payload.sd) && payload.sd > 0 ? payload.sd : maxSd;
      axisValues.push(payload.value - sd, payload.value, payload.value + sd);
    });
    rows.forEach((row) => {
      const estimate = xlsxNumber(row, 'Estimate_value');
      const estimateSd = xlsxNumber(row, 'Estimate_sd');
      if (!Number.isFinite(estimate) || isLowReliabilityMethodComparisonRow(row, expectedRefs)) {
        return;
      }
      if (Math.abs(estimate - refCenter) <= robustWindow) {
        axisValues.push(estimate - (Number.isFinite(estimateSd) ? estimateSd : 0), estimate, estimate + (Number.isFinite(estimateSd) ? estimateSd : 0));
      }
    });
    const axisRange = rangeWithPadding(axisValues.length >= 2 ? axisValues : [refCenter - robustWindow, refCenter + robustWindow], 0, 1, 0.16);
    yLo = axisRange.min;
    yHi = axisRange.max;
  } else if (estimateValues.length > 0) {
    const estimateRange = rangeWithPadding(estimateValues, 0, 1, 0.25);
    yLo = estimateRange.min;
    yHi = estimateRange.max;
  }
  const referenceAxis = drawSimpleAxis(ctx, referencePlot, xRange, { min: yLo, max: yHi }, 'Method', `Reference value(s) (${unitLabel})`);
  refPayloads.forEach((payload, index) => {
    const color = index === 0 ? '#8a3ffc' : '#0f766e';
    const y = referenceAxis.yToPx(payload.value);
    ctx.save();
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(referencePlot.x, y);
    ctx.lineTo(referencePlot.x + referencePlot.width, y);
    ctx.stroke();
    ctx.restore();
    if (Number.isFinite(payload.sd) && payload.sd > 0) {
      const yTop = referenceAxis.yToPx(payload.value + payload.sd);
      const yBottom = referenceAxis.yToPx(payload.value - payload.sd);
      ctx.fillStyle = index === 0 ? 'rgba(138, 63, 252, 0.10)' : 'rgba(15, 118, 110, 0.10)';
      ctx.fillRect(referencePlot.x, Math.min(yTop, yBottom), referencePlot.width, Math.abs(yBottom - yTop));
    }
  });

  const referenceLegendDrawn = new Set<string>();
  const referenceYRange = Math.max(yHi - yLo, 1);
  rows.forEach((row, index) => {
    const estimate = xlsxNumber(row, 'Estimate_value');
    if (!Number.isFinite(estimate)) {
      return;
    }
    const estimateSd = xlsxNumber(row, 'Estimate_sd');
    const isReliable = !isLowReliabilityMethodComparisonRow(row, expectedRefs);
    const color = isReliable ? '#2563c7' : '#cf2e2e';
    const x = referenceAxis.xToPx(index);
    const clipped = estimate > yHi || estimate < yLo;
    const plotY = referenceAxis.yToPx(Math.min(Math.max(estimate, yLo), yHi));
    if (Number.isFinite(estimateSd) && estimateSd > 0 && !clipped) {
      drawVerticalErrorBar(
        ctx,
        x,
        referenceAxis.yToPx(Math.max(yLo, estimate - estimateSd)),
        referenceAxis.yToPx(Math.min(yHi, estimate + estimateSd)),
        10,
        color,
      );
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, plotY, 8, 0, Math.PI * 2);
    ctx.fill();

    const nearestRef = methodComparisonNearestReference(estimate, expectedRefs);
    if (nearestRef && !clipped) {
      ctx.fillStyle = color;
      ctx.font = '16px Inter, Arial, sans-serif';
      ctx.fillText(
        `${nearestRef.delta >= 0 ? '+' : ''}${nearestRef.delta.toFixed(Math.abs(nearestRef.delta) >= 10 ? 1 : 2)}`,
        x - 18,
        Math.max(referencePlot.y + 18, plotY - 14),
      );
    }

    if (clipped) {
      ctx.fillStyle = color;
      ctx.font = '14px Inter, Arial, sans-serif';
      const edgeY = estimate > yHi ? referenceAxis.yToPx(yHi) + 14 : referenceAxis.yToPx(yLo) - 8;
      const markerY = estimate > yHi ? referenceAxis.yToPx(yHi) + 2 : referenceAxis.yToPx(yLo) - 2;
      ctx.beginPath();
      if (estimate > yHi) {
        ctx.moveTo(x, markerY - 10);
        ctx.lineTo(x + 8, markerY + 2);
        ctx.lineTo(x - 8, markerY + 2);
      } else {
        ctx.moveTo(x, markerY + 10);
        ctx.lineTo(x + 8, markerY - 2);
        ctx.lineTo(x - 8, markerY - 2);
      }
      ctx.closePath();
      ctx.fill();
      ctx.fillText('out of scale', x - 28, estimate > yHi ? edgeY + 12 : edgeY - 8);
    }

    const source = xlsxString(row, 'Estimate_source');
    const sourceLabel = source === 'unknown_from_calibration'
      ? 'unknown'
      : source === 'standard_addition'
        ? 'std add'
        : 'estimated value';
    const legendKey = `${sourceLabel}|${isReliable ? 'reliable scale' : 'low reliability'}`;
    if (!referenceLegendDrawn.has(legendKey)) {
      referenceLegendDrawn.add(legendKey);
    }
  });

  const r2Values = rows.flatMap((row) => [xlsxNumber(row, 'R2_cal'), xlsxNumber(row, 'R2_std_mean')]).filter(Number.isFinite);
  const r2Plot = { x: panelLeft, y: top + 2 * (panelHeight + panelGap), width: panelWidth, height: panelHeight };
  const r2Axis = drawSimpleAxis(ctx, r2Plot, xRange, rangeWithPadding([...r2Values, 0, 1], 0, 1, 0.05), 'Method', 'R2');
  ctx.save();
  ctx.setLineDash([8, 6]);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(r2Plot.x, r2Axis.yToPx(1));
  ctx.lineTo(r2Plot.x + r2Plot.width, r2Axis.yToPx(1));
  ctx.stroke();
  ctx.restore();
  rows.forEach((row, index) => {
    const r2Cal = xlsxNumber(row, 'R2_cal');
    const r2Std = xlsxNumber(row, 'R2_std_mean');
    if (Number.isFinite(r2Cal)) {
      ctx.fillStyle = '#2563c7';
      ctx.beginPath();
      ctx.arc(r2Axis.xToPx(index) - 7, r2Axis.yToPx(r2Cal), 8, 0, Math.PI * 2);
      ctx.fill();
    }
    if (Number.isFinite(r2Std)) {
      ctx.fillStyle = '#1f8a4c';
      ctx.fillRect(r2Axis.xToPx(index) + 1, r2Axis.yToPx(r2Std) - 7, 14, 14);
    }
  });
  drawMethodLabels(r2Plot, r2Axis.xToPx);

  ctx.font = '20px Inter, Arial, sans-serif';
  ctx.fillStyle = '#2563c7';
  ctx.fillText('o slope agreement / reliable estimate / R2 calibration', 170, height - 72);
  ctx.fillStyle = '#cf2e2e';
  ctx.fillText('s bias index / low reliability / out of scale', 780, height - 72);
  ctx.fillStyle = '#1f8a4c';
  ctx.fillText('s R2 standard addition', 1360, height - 72);
  ctx.fillStyle = '#8a3ffc';
  ctx.fillText('dashed line and band: external reference +/- SD when available', 1630, height - 72);

  return canvas;
}

function drawImageCover(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  const sourceAspect = sourceWidth / sourceHeight;
  const destAspect = dw / dh;
  let sx = 0;
  let sy = 0;
  let sw = sourceWidth;
  let sh = sourceHeight;

  if (sourceAspect > destAspect) {
    sw = sourceHeight * destAspect;
    sx = (sourceWidth - sw) / 2;
  } else {
    sh = sourceWidth / destAspect;
    sy = (sourceHeight - sh) / 2;
  }

  ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
}

function buildPythonStylePlateRoiOverlayCanvas(
  imageData: ImageData,
  wells: WellCenter[],
  measurements: WellMeasurement[],
  radiusFactor: number,
  floorRoiRadiusFactor: number,
  floorCircles: FloorCircle[] | null,
): HTMLCanvasElement {
  const source = createDiagnosticCanvas(imageData).canvas;
  const canvas = document.createElement('canvas');
  const width = 1062;
  const height = 708;
  const scale = Math.min(width / imageData.width, height / imageData.height);
  const dx = (width - imageData.width * scale) / 2;
  const dy = (height - imageData.height * scale) / 2;
  const ctx = canvas.getContext('2d');

  canvas.width = width;
  canvas.height = height;

  if (!ctx) {
    throw new Error('Could not create Python-style ROI overlay canvas.');
  }

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, dx, dy, imageData.width * scale, imageData.height * scale);

  const measurementByWell = new Map(measurements.map((measurement) => [measurement.wellId, measurement]));

  ctx.save();
  ctx.translate(dx, dy);
  ctx.scale(scale, scale);
  ctx.lineWidth = Math.max(1, 2 / scale);

  wells.forEach((well) => {
    const measurement = measurementByWell.get(well.wellId);
    const mouthRadius = measurement?.mouthRadiusUsed && measurement.mouthRadiusUsed > 0
      ? measurement.mouthRadiusUsed
      : estimateRoiRadius(wells, well.row, well.col, radiusFactor);
    const floorCircle = floorCircles && floorCircles.length === wells.length
      ? floorCircles[well.row * 12 + well.col]
      : null;
    const floorRadius = floorCircle
      ? measurement?.floorRadiusUsed && measurement.floorRadiusUsed > 0
        ? measurement.floorRadiusUsed
        : Math.max(1, floorCircle.r)
      : 0;

    ctx.beginPath();
    ctx.arc(well.x, well.y, mouthRadius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0, 190, 80, 0.95)';
    ctx.stroke();

    if (floorCircle) {
      ctx.beginPath();
      ctx.arc(floorCircle.x, floorCircle.y, floorRadius, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0, 210, 230, 0.95)';
      ctx.stroke();
    }
  });

  ctx.restore();
  return canvas;
}

function finiteRange(values: number[], fallbackMin = 0, fallbackMax = 1): { min: number; max: number } {
  const finiteValues = values.filter((value) => Number.isFinite(value));

  if (finiteValues.length === 0) {
    return { min: fallbackMin, max: fallbackMax };
  }

  let min = Math.min(...finiteValues);
  let max = Math.max(...finiteValues);

  if (min === max) {
    const padding = Math.max(1, Math.abs(min) * 0.1);
    min -= padding;
    max += padding;
  }

  const padding = (max - min) * 0.08;
  return { min: min - padding, max: max + padding };
}

function channelDisplayName(channel: FitChannel): string {
  return PYTHON_RESULTS_CHANNEL_LABELS[channel];
}

function meanFinite(values: number[]): number {
  const finiteValues = values.filter((value) => Number.isFinite(value));

  return finiteValues.length > 0
    ? finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length
    : Number.NaN;
}

function sampleStandardDeviation(values: number[]): number {
  const finiteValues = values.filter((value) => Number.isFinite(value));

  if (finiteValues.length < 2) {
    return 0;
  }

  const avg = meanFinite(finiteValues);
  const variance = finiteValues.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (finiteValues.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function medianFinite(values: number[]): number {
  const finiteValues = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);

  if (finiteValues.length === 0) {
    return Number.NaN;
  }

  const midpoint = Math.floor(finiteValues.length / 2);
  return finiteValues.length % 2 === 0
    ? (finiteValues[midpoint - 1] + finiteValues[midpoint]) / 2
    : finiteValues[midpoint];
}

function groupedPythonResultsPoints(groups: Map<number, number[]>): PythonResultsPlotPoint[] {
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([x, values]) => ({
      x,
      y: meanFinite(values),
      yerr: sampleStandardDeviation(values),
      n: values.filter((value) => Number.isFinite(value)).length,
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function collectCalibrationPointsForChannel(
  channel: FitChannel,
  measurements: WellMeasurement[],
  plateMap: WellConfig[],
): PythonResultsPlotPoint[] {
  const measurementByWell = new Map(measurements.map((measurement) => [measurement.wellId, measurement]));
  const grouped = new Map<number, number[]>();

  plateMap.forEach((well) => {
    if (well.role !== 'C' || well.concentration === null || !Number.isFinite(well.concentration)) {
      return;
    }

    const measurement = measurementByWell.get(well.wellId);
    const y = measurement ? pabsChannelValue(measurement, channel) : Number.NaN;

    if (!Number.isFinite(y)) {
      return;
    }

    const values = grouped.get(well.concentration) ?? [];
    values.push(y);
    grouped.set(well.concentration, values);
  });

  return groupedPythonResultsPoints(grouped);
}

function collectStandardAdditionPointsForFit(
  fit: StandardAdditionFit,
  channel: FitChannel,
  measurements: WellMeasurement[],
  plateMap: WellConfig[],
): PythonResultsPlotPoint[] {
  const measurementByWell = new Map(measurements.map((measurement) => [measurement.wellId, measurement]));
  const grouped = new Map<number, number[]>();
  const sampleId = fit.sampleId.trim();

  plateMap.forEach((well) => {
    if (
      well.role !== 'A' ||
      well.concentration === null ||
      !Number.isFinite(well.concentration) ||
      well.sampleId.trim() !== sampleId
    ) {
      return;
    }

    const dilutionFactor = Number.isFinite(well.dilutionFactor) ? well.dilutionFactor : 1;
    if (Math.abs(dilutionFactor - fit.dilutionFactor) > 1e-12) {
      return;
    }

    const measurement = measurementByWell.get(well.wellId);
    const y = measurement ? pabsChannelValue(measurement, channel) : Number.NaN;

    if (!Number.isFinite(y)) {
      return;
    }

    const values = grouped.get(well.concentration) ?? [];
    values.push(y);
    grouped.set(well.concentration, values);
  });

  const groupedPoints = groupedPythonResultsPoints(grouped);
  const pointByX = new Map(groupedPoints.map((point) => [point.x, point]));
  const fitX = fit.addedConcentrationsUsed ?? [];
  const fitY = fit.meanSignalValuesUsed ?? [];

  if (fitX.length > 0 && fitY.length > 0) {
    return fitX.flatMap((x, index) => {
      const y = fitY[index];
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return [];
      }

      const groupedPoint = pointByX.get(x);
      return [{
        x,
        y,
        yerr: groupedPoint?.yerr ?? 0,
        n: groupedPoint?.n ?? 1,
      }];
    });
  }

  return groupedPoints;
}

function estimateSigmaForPythonResultsLoq(calibrationPoints: Array<Pick<PythonResultsPlotPoint, 'x' | 'y'> & Partial<Pick<PythonResultsPlotPoint, 'yerr' | 'n'>>>): { sigma: number; source: string } {
  const calibrationSdValues = calibrationPoints
    .map((point) => point.yerr)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  const medianCalibrationSd = medianFinite(calibrationSdValues);

  if (Number.isFinite(medianCalibrationSd) && medianCalibrationSd > 0) {
    return { sigma: medianCalibrationSd, source: 'median_calibration_sd' };
  }

  const zeroSdValues = calibrationPoints
    .filter((point) => Math.abs(point.x) <= 1e-12)
    .map((point) => point.yerr)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const medianZeroSd = medianFinite(zeroSdValues);

  if (Number.isFinite(medianZeroSd)) {
    return { sigma: medianZeroSd, source: 'blank_zero_calibration' };
  }

  return { sigma: Number.NaN, source: 'unavailable' };
}

function computePythonFitBaseScore(
  r2Cal: number,
  r2Std: number,
  slopeAgreement: number,
  loq: number,
): number {
  if (!Number.isFinite(r2Cal) || !Number.isFinite(r2Std) || !Number.isFinite(slopeAgreement)) {
    return Number.NaN;
  }

  const base = (slopeAgreement ** 2) * Math.sqrt(Math.max(r2Cal, 0) * Math.max(r2Std, 0));
  return Number.isFinite(loq) && loq > 0 ? base / loq : base;
}

function computePythonResultsChannelRankings(
  calibrationFits: CalibrationFit[],
  standardAdditionFits: StandardAdditionFit[],
  measurements: WellMeasurement[],
  plateMap: WellConfig[],
): PythonResultsChannelRank[] {
  return PYTHON_RESULTS_CHANNELS.map((channel) => {
    const cal = calibrationFits.find((fit) => fit.channel === channel);
    const std = standardAdditionFits.filter((fit) => fit.channel === channel);
    const calibrationPoints = collectCalibrationPointsForChannel(channel, measurements, plateMap);
    const estimatedSigma = estimateSigmaForPythonResultsLoq(calibrationPoints);
    const sigma = cal?.sigmaCal ?? estimatedSigma.sigma;
    const source = cal?.sigmaSource ?? estimatedSigma.source;
    const r2Cal = cal && Number.isFinite(cal.r2) ? Math.max(0, cal.r2) : Number.NaN;
    const r2StdValues = std
      .map((fit) => fit.r2)
      .filter((value) => Number.isFinite(value))
      .map((value) => Math.max(0, value));
    const r2Std = meanFinite(r2StdValues);
    const slopeAgreementValues = std
      .map((fit) => {
        if (typeof fit.internalSlopeAgreement === 'number' && Number.isFinite(fit.internalSlopeAgreement)) {
          return fit.internalSlopeAgreement;
        }

        if (cal && Number.isFinite(cal.slope) && Number.isFinite(fit.slope)) {
          const denominator = Math.max(Math.abs(cal.slope), Math.abs(fit.slope), 1e-12);
          return Math.min(Math.abs(cal.slope), Math.abs(fit.slope)) / denominator;
        }

        return Number.NaN;
      })
      .filter((value) => Number.isFinite(value))
      .map((value) => Math.max(0, Math.min(1, value)));
    const slopeAgreement = meanFinite(slopeAgreementValues);
    const slope = cal?.slope ?? Number.NaN;
    const lod = cal && Number.isFinite(cal.lod ?? Number.NaN)
      ? cal.lod as number
      : cal && Number.isFinite(sigma) && sigma > 0 && Number.isFinite(slope) && Math.abs(slope) > 1e-15
      ? (3 * sigma) / Math.abs(slope)
      : Number.NaN;
    const loq = cal && Number.isFinite(cal.loq ?? Number.NaN)
      ? cal.loq as number
      : cal && Number.isFinite(sigma) && sigma > 0 && Number.isFinite(slope) && Math.abs(slope) > 1e-15
      ? (10 * sigma) / Math.abs(slope)
      : Number.NaN;
    let score = computePythonFitBaseScore(r2Cal, r2Std, slopeAgreement, loq);
    let scoreFormula = Number.isFinite(loq) && loq > 0
      ? 'slope_agreement^2 * sqrt(R2_cal * R2_std) * (1/LOQ)'
      : 'slope_agreement^2 * sqrt(R2_cal * R2_std)';

    if (!Number.isFinite(score) || score <= 0) {
      if (Number.isFinite(r2Cal)) {
        score = r2Cal;
        scoreFormula = 'R2_cal fallback';
      } else if (Number.isFinite(r2Std)) {
        score = r2Std;
        scoreFormula = 'R2_std fallback';
      } else {
        score = 0;
        scoreFormula = 'unavailable';
      }
    }

    return {
      channel,
      score,
      r2Cal,
      r2Std,
      slopeAgreement,
      sigmaCal: sigma,
      sigmaSource: source,
      lod,
      loq,
      scoreFormula,
    };
  }).sort((a, b) => b.score - a.score || PYTHON_RESULTS_CHANNELS.indexOf(a.channel) - PYTHON_RESULTS_CHANNELS.indexOf(b.channel));
}

function selectBestRgbChannel(
  calibrationFits: CalibrationFit[],
  standardAdditionFits: StandardAdditionFit[],
  measurements: WellMeasurement[],
  plateMap: WellConfig[],
): FitChannel {
  return computePythonResultsChannelRankings(calibrationFits, standardAdditionFits, measurements, plateMap)[0]?.channel ?? 'R';
}

function collectStandardAdditionGroupsForChannel(
  channel: FitChannel,
  standardFits: StandardAdditionFit[],
  measurements: WellMeasurement[],
  plateMap: WellConfig[],
): PythonResultsStandardAdditionGroup[] {
  return standardFits
    .filter((fit) => fit.channel === channel)
    .map((fit) => ({
      fit,
      points: collectStandardAdditionPointsForFit(fit, channel, measurements, plateMap),
    }));
}

function drawVerticalErrorBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  yLow: number,
  yHigh: number,
  capWidth: number,
  color: string,
): void {
  if (!Number.isFinite(x) || !Number.isFinite(yLow) || !Number.isFinite(yHigh) || Math.abs(yHigh - yLow) < 0.01) {
    return;
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x, yLow);
  ctx.lineTo(x, yHigh);
  ctx.moveTo(x - capWidth / 2, yLow);
  ctx.lineTo(x + capWidth / 2, yLow);
  ctx.moveTo(x - capWidth / 2, yHigh);
  ctx.lineTo(x + capWidth / 2, yHigh);
  ctx.stroke();
}

function drawHorizontalErrorBar(
  ctx: CanvasRenderingContext2D,
  xLow: number,
  xHigh: number,
  y: number,
  capHeight: number,
  color: string,
): void {
  if (!Number.isFinite(xLow) || !Number.isFinite(xHigh) || !Number.isFinite(y) || Math.abs(xHigh - xLow) < 0.01) {
    return;
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(xLow, y);
  ctx.lineTo(xHigh, y);
  ctx.moveTo(xLow, y - capHeight / 2);
  ctx.lineTo(xLow, y + capHeight / 2);
  ctx.moveTo(xHigh, y - capHeight / 2);
  ctx.lineTo(xHigh, y + capHeight / 2);
  ctx.stroke();
}

function niceTickStep(span: number, targetTickCount: number): number {
  if (!Number.isFinite(span) || span <= 0) {
    return 1;
  }

  const rawStep = span / Math.max(1, targetTickCount - 1);
  const power = 10 ** Math.floor(Math.log10(rawStep));
  const scaled = rawStep / power;
  const nice = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return nice * power;
}

function niceTicks(min: number, max: number, targetTickCount = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [0, 1];
  }

  let lo = min;
  let hi = max;
  if (lo === hi) {
    const padding = Math.max(1, Math.abs(lo) * 0.1);
    lo -= padding;
    hi += padding;
  }

  const step = niceTickStep(hi - lo, targetTickCount);
  const start = Math.ceil(lo / step) * step;
  const end = Math.floor(hi / step) * step;
  const ticks: number[] = [];

  for (let value = start; value <= end + step * 0.5; value += step) {
    const rounded = Math.abs(value) < step * 1e-10 ? 0 : Number(value.toPrecision(12));
    ticks.push(rounded);
  }

  if (ticks.length < 2) {
    return [lo, hi];
  }

  return ticks;
}

function rangeWithPadding(values: number[], fallbackMin = 0, fallbackMax = 1, fraction = 0.08): { min: number; max: number } {
  const finiteValues = values.filter(Number.isFinite);
  if (finiteValues.length === 0) {
    return { min: fallbackMin, max: fallbackMax };
  }

  let min = Math.min(...finiteValues);
  let max = Math.max(...finiteValues);
  if (min === max) {
    const padding = Math.max(1, Math.abs(min) * 0.1);
    min -= padding;
    max += padding;
  }

  const padding = Math.max(1e-12, (max - min) * fraction);
  return { min: min - padding, max: max + padding };
}


function drawWrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxY: number,
): number {
  const paragraphs = text.split('\n');
  let cursorY = y;

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter((word) => word.length > 0);

    if (words.length === 0) {
      cursorY += lineHeight;
      continue;
    }

    let line = '';
    for (const word of words) {
      const nextLine = line ? `${line} ${word}` : word;

      if (ctx.measureText(nextLine).width > maxWidth && line) {
        if (cursorY > maxY) {
          return cursorY;
        }
        ctx.fillText(line, x, cursorY);
        cursorY += lineHeight;
        line = word;
      } else {
        line = nextLine;
      }
    }

    if (cursorY > maxY) {
      return cursorY;
    }
    ctx.fillText(line, x, cursorY);
    cursorY += lineHeight;
  }

  return cursorY;
}

function drawPreformattedLines(
  ctx: CanvasRenderingContext2D,
  lines: Array<{ text: string; emphasize?: boolean }>,
  x: number,
  y: number,
  lineHeight: number,
  maxY: number,
  baseFont: string,
  emphasizedFont: string,
): number {
  let cursorY = y;
  for (const line of lines) {
    if (cursorY > maxY) {
      return cursorY;
    }
    ctx.font = line.emphasize ? emphasizedFont : baseFont;
    ctx.fillText(line.text, x, cursorY);
    cursorY += lineHeight;
  }
  return cursorY;
}

function formatFigureRgbTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header) => header.length);
  rows.forEach((row) => {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  });

  const formatRow = (row: string[]) => row.map((cell, index) => {
    if (index === 0) {
      return cell.padEnd(widths[index], ' ');
    }
    return cell.padStart(widths[index], ' ');
  }).join('  ');

  const divider = widths.map((width) => '-'.repeat(width));
  return [
    formatRow(headers),
    formatRow(divider),
    ...rows.map((row) => formatRow(row)),
  ];
}

function figureRgbChannelShort(channel: FitChannel): string {
  if (channel === 'R') {
    return 'Red';
  }
  if (channel === 'G') {
    return 'Green';
  }
  return 'Blue';
}

function formatFigureScientificNumber(value: number, fallback = 'NA'): string {
  return Number.isFinite(value) ? Number(value).toPrecision(6) : fallback;
}

function buildFigureRgbScientificLines({
  unitLabel,
  measurements,
  plateMap,
  calibrationFits,
  standardAdditionFits,
  expectedRefs,
  rankingRows,
  roiMode,
  backgroundModel,
  floorGeometryAvailable,
  bestChannel,
}: {
  unitLabel: string;
  measurements: WellMeasurement[];
  plateMap: WellConfig[];
  calibrationFits: CalibrationFit[];
  standardAdditionFits: StandardAdditionFit[];
  expectedRefs: ExpectedRef[];
  rankingRows: PythonResultsChannelRank[];
  roiMode: RoiMode;
  backgroundModel: BackgroundModel;
  floorGeometryAvailable: boolean;
  bestChannel: FitChannel;
}): Array<{ text: string; emphasize?: boolean }> {
  const lines: Array<{ text: string; emphasize?: boolean }> = [];
  const selectedLabel = figureRgbChannelShort(bestChannel);
  const pushText = (text: string, emphasize = false) => {
    lines.push({ text, emphasize });
  };
  const pushTable = (tableLines: string[]) => {
    tableLines.forEach((line, index) => {
      const isDataRow = index >= 2;
      const selectedRow = isDataRow && line.trimStart().startsWith(selectedLabel);
      pushText(line, selectedRow);
    });
  };
  const rankingByChannel = new Map(rankingRows.map((row) => [row.channel, row]));
  const flagged = measurements.filter((measurement) => measurement.warnings.length > 0 || Boolean(measurement.roiStatisticsWarning || measurement.geometryAlignmentWarning)).length;
  const critical = measurements.filter((measurement) => (
    [...measurement.warnings, measurement.roiStatisticsWarning ?? '', measurement.geometryAlignmentWarning ?? '']
      .some((warning) => warning.toLowerCase().includes('critical'))
  )).length;
  const total = measurements.length;
  const plateStatus = critical === 0 && flagged <= Math.max(1, Math.floor(total * 0.2)) ? 'Passed' : 'Warning';
  const modeLabel = calibrationFits.length > 0 && standardAdditionFits.length > 0
    ? 'calibration + standard addition'
    : calibrationFits.length > 0
      ? 'calibration only'
      : standardAdditionFits.length > 0
        ? 'standard addition only'
        : 'no valid analytical fit available';

  pushText('Pseudo-absorbance = log10(I_BG/I_well)');
  pushText('');
  pushText(`Mode: ${modeLabel}`);
  pushText('Fit: robust IRLS for exported fit rows');
  pushText(`Background: ${formatBackgroundModel(backgroundModel)}`);
  pushText(`ROI mode: ${formatRoiMode(roiMode)}`);
  pushText(`Plate: ${plateMap.length}-well | QC: ${plateStatus}`);
  pushText(`Plate QC: wells flagged ${flagged}/${total} | wells critical ${critical}/${total}`);
  pushText(`Floor D QC: ${floorGeometryAvailable ? 'available' : 'missing'}`);
  pushText('');
  pushText('REFERENCE VALUES', true);
  if (expectedRefs.length === 0) {
    pushText('NA');
  } else {
    expectedRefs.forEach((ref, index) => {
      const label = ref.label.trim() || ref.refId.trim() || `Reference ${index + 1}`;
      const valueText = formatFigureScientificNumber(ref.value);
      const sdText = ref.sd !== null && Number.isFinite(ref.sd) ? ` +/- ${formatFigureScientificNumber(ref.sd)}` : '';
      pushText(`${label}: ${valueText}${sdText} ${unitLabel}`);
    });
  }

  const groupedFits = new Map<string, StandardAdditionFit[]>();
  standardAdditionFits.forEach((fit) => {
    const key = `${fit.sampleId}|${fit.dilutionFactor}`;
    const items = groupedFits.get(key) ?? [];
    items.push(fit);
    groupedFits.set(key, items);
  });

  for (const [groupKey, fits] of groupedFits.entries()) {
    const [sampleId, dilutionFactorRaw] = groupKey.split('|');
    const dilutionFactor = Number(dilutionFactorRaw);
    pushText('');
    pushText(`Std Add | ID: ${sampleId} | DF=${formatFigureScientificNumber(dilutionFactor)}`, true);

    const resultRows: string[][] = [];
    for (const channel of PYTHON_RESULTS_CHANNELS) {
      const fit = fits.find((item) => item.channel === channel);
      if (!fit) {
        continue;
      }
      const ranking = rankingByChannel.get(channel);
      const matchedRef = expectedRefs.find((ref) => {
        const refId = ref.refId.trim();
        if (!refId) {
          return true;
        }
        return refId === fit.sampleId.trim();
      });
      const c0 = fit.concentrationInOriginalSample;
      const refValue = matchedRef?.value ?? Number.NaN;
      const delta = Number.isFinite(c0) && Number.isFinite(refValue) ? c0 - refValue : Number.NaN;
      const recovery = Number.isFinite(c0) && Number.isFinite(refValue) && Math.abs(refValue) > 1e-15
        ? (100 * c0) / refValue
        : Number.NaN;
      resultRows.push([
        figureRgbChannelShort(channel),
        formatFigureScientificNumber(c0),
        formatFigureScientificNumber(ranking?.score ?? Number.NaN),
        formatFigureScientificNumber(delta),
        Number.isFinite(recovery) ? recovery.toFixed(1) : 'NA',
      ]);
    }
    pushTable(formatFigureRgbTable(
      ['Channel', `C0 (${unitLabel})`, 'Score', `Delta (${unitLabel})`, 'Recovery (%)'],
      resultRows,
    ));

    pushText('');
    pushText('Calibration', true);
    const calibrationRows = PYTHON_RESULTS_CHANNELS.map((channel) => {
      const fit = calibrationFits.find((item) => item.channel === channel);
      const ranking = rankingByChannel.get(channel);
      return [
        figureRgbChannelShort(channel),
        formatFigureScientificNumber(fit?.slope ?? Number.NaN),
        formatFigureScientificNumber(fit?.intercept ?? Number.NaN),
        formatFigureScientificNumber(fit?.r2 ?? Number.NaN),
        formatFigureScientificNumber(ranking?.lod ?? Number.NaN),
        formatFigureScientificNumber(ranking?.loq ?? Number.NaN),
      ];
    });
    pushTable(formatFigureRgbTable(
      ['Channel', 'Slope', 'Intercept', 'R2', `LOD (${unitLabel})`, `LOQ (${unitLabel})`],
      calibrationRows,
    ));

    pushText('');
    pushText(`Std Add | ID: ${sampleId} | DF=${formatFigureScientificNumber(dilutionFactor)}`, true);
    const stdFitRows = PYTHON_RESULTS_CHANNELS.map((channel) => {
      const fit = fits.find((item) => item.channel === channel);
      return [
        figureRgbChannelShort(channel),
        formatFigureScientificNumber(fit?.slope ?? Number.NaN),
        formatFigureScientificNumber(fit?.intercept ?? Number.NaN),
        formatFigureScientificNumber(fit?.r2 ?? Number.NaN),
      ];
    });
    pushTable(formatFigureRgbTable(
      ['Channel', 'Slope', 'Intercept', 'R2'],
      stdFitRows,
    ));
  }

  return lines;
}

function drawPythonStyleChannelPanel(
  ctx: CanvasRenderingContext2D,
  bounds: { x: number; y: number; width: number; height: number },
  channel: FitChannel,
  calibrationFit: CalibrationFit | undefined,
  standardGroups: PythonResultsStandardAdditionGroup[],
  calibrationPoints: PythonResultsPlotPoint[],
  rankInfo: PythonResultsChannelRank | undefined,
  unitLabel: string,
  expectedRefs: ExpectedRef[],
  monochrome = false,
  pythonFigureStyle = false,
): void {
  const color = monochrome ? '#111111' : FIT_CHANNEL_COLORS[channel];
  const margin = pythonFigureStyle
    ? { left: 84, right: 24, top: 62, bottom: 78 }
    : { left: 76, right: 20, top: 26, bottom: 56 };
  const plot = {
    x: bounds.x + margin.left,
    y: bounds.y + margin.top,
    width: bounds.width - margin.left - margin.right,
    height: bounds.height - margin.top - margin.bottom,
  };
  const standardFits = standardGroups.map((group) => group.fit);
  const stdPoints = standardGroups.flatMap((group) => group.points);
  const referenceX = standardGroups.flatMap(({ fit }) =>
    expectedRefs.flatMap((ref) => {
      if (!referenceMatchesSample(ref, fit.sampleId)) {
        return [];
      }
      const x = -ref.value / Math.max(fit.dilutionFactor, 1e-12);
      const xSd = ref.sd !== null && Number.isFinite(ref.sd)
        ? Math.abs(ref.sd / Math.max(fit.dilutionFactor, 1e-12))
        : Number.NaN;
      return Number.isFinite(x)
        ? [x, Number.isFinite(xSd) ? x - xSd : Number.NaN, Number.isFinite(xSd) ? x + xSd : Number.NaN]
        : [];
    }),
  );
  const allX = [
    ...calibrationPoints.map((point) => point.x),
    ...stdPoints.map((point) => point.x),
    ...referenceX,
    ...standardFits.flatMap((fit) => {
      if (!Number.isFinite(fit.slope) || Math.abs(fit.slope) <= 1e-15 || !Number.isFinite(fit.intercept)) {
        return [];
      }

      const interceptX = -fit.intercept / fit.slope;
      return Number.isFinite(interceptX) ? [interceptX] : [];
    }),
  ];
  const allY = [
    ...(referenceX.length > 0 ? [0] : []),
    ...calibrationPoints.map((point) => point.y),
    ...calibrationPoints.flatMap((point) => (
      typeof point.yerr === 'number' && Number.isFinite(point.yerr) && point.yerr > 0 ? [point.y - point.yerr, point.y + point.yerr] : []
    )),
    ...stdPoints.map((point) => point.y),
    ...stdPoints.flatMap((point) => (
      typeof point.yerr === 'number' && Number.isFinite(point.yerr) && point.yerr > 0 ? [point.y - point.yerr, point.y + point.yerr] : []
    )),
  ];
  const xRange = rangeWithPadding(allX, 0, 1);
  const yFromFits = [
    calibrationFit && Number.isFinite(calibrationFit.slope) && Number.isFinite(calibrationFit.intercept)
      ? calibrationFit.slope * xRange.min + calibrationFit.intercept
      : Number.NaN,
    calibrationFit && Number.isFinite(calibrationFit.slope) && Number.isFinite(calibrationFit.intercept)
      ? calibrationFit.slope * xRange.max + calibrationFit.intercept
      : Number.NaN,
    ...standardFits.flatMap((fit) => (
      Number.isFinite(fit.slope) && Number.isFinite(fit.intercept)
        ? [fit.slope * xRange.min + fit.intercept, fit.slope * xRange.max + fit.intercept]
        : []
    )),
  ];
  const yRange = rangeWithPadding([...allY, ...yFromFits], 0, 1);
  const xToPx = (value: number) => plot.x + ((value - xRange.min) / (xRange.max - xRange.min)) * plot.width;
  const yToPx = (value: number) => plot.y + plot.height - ((value - yRange.min) / (yRange.max - yRange.min)) * plot.height;
  const xTicks = niceTicks(xRange.min, xRange.max, 5);
  const yTicks = niceTicks(yRange.min, yRange.max, 5);

  ctx.save();
  if (!pythonFigureStyle) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
    ctx.strokeStyle = '#d6dedb';
    ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
  }

  ctx.fillStyle = '#1d2628';
  ctx.font = pythonFigureStyle
    ? '700 24px "Courier New", Consolas, monospace'
    : '700 18px Inter, Arial, sans-serif';
  ctx.fillText(channelDisplayName(channel), bounds.x + 12, pythonFigureStyle ? bounds.y + 34 : bounds.y + 20);
  if (rankInfo) {
    const rankText = [
      `Score ${formatFitCell(rankInfo.score)}`,
      `R2cal ${formatFitCell(rankInfo.r2Cal)}`,
      `R2std ${formatFitCell(rankInfo.r2Std)}`,
      `LOQ ${formatFitCell(rankInfo.loq)}`,
    ].join('  ');
    ctx.font = pythonFigureStyle
      ? '600 13px "Courier New", Consolas, monospace'
      : '11px Inter, Arial, sans-serif';
    ctx.fillStyle = '#465255';
    ctx.fillText(rankText, plot.x + Math.max(0, plot.width - ctx.measureText(rankText).width - 4), pythonFigureStyle ? bounds.y + 34 : bounds.y + 20);
  }

  if (!pythonFigureStyle) {
    ctx.strokeStyle = '#dce4e1';
    ctx.lineWidth = 1;
    ctx.font = '12px Inter, Arial, sans-serif';
    ctx.fillStyle = '#465255';
    xTicks.forEach((tick) => {
      const tx = xToPx(tick);
      ctx.beginPath();
      ctx.moveTo(tx, plot.y);
      ctx.lineTo(tx, plot.y + plot.height);
      ctx.stroke();
    });
    yTicks.forEach((tick) => {
      const ty = yToPx(tick);
      ctx.beginPath();
      ctx.moveTo(plot.x, ty);
      ctx.lineTo(plot.x + plot.width, ty);
      ctx.stroke();
    });

    ctx.strokeStyle = '#2b3437';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(plot.x, plot.y, plot.width, plot.height);
  } else {
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(plot.x, plot.y);
    ctx.lineTo(plot.x, plot.y + plot.height);
    ctx.lineTo(plot.x + plot.width, plot.y + plot.height);
    ctx.stroke();
  }

  ctx.fillStyle = pythonFigureStyle ? '#000000' : '#465255';
  ctx.font = pythonFigureStyle
    ? '600 13px "Courier New", Consolas, monospace'
    : '11px Inter, Arial, sans-serif';
  xTicks.forEach((tick) => {
    const tx = xToPx(tick);
    if (pythonFigureStyle) {
      ctx.beginPath();
      ctx.moveTo(tx, plot.y + plot.height);
      ctx.lineTo(tx, plot.y + plot.height + 8);
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    ctx.fillText(formatFitCell(tick), tx - 14, plot.y + plot.height + (pythonFigureStyle ? 24 : 18));
  });
  yTicks.forEach((tick) => {
    const ty = yToPx(tick);
    if (pythonFigureStyle) {
      ctx.beginPath();
      ctx.moveTo(plot.x - 8, ty);
      ctx.lineTo(plot.x, ty);
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    ctx.fillText(formatPAbsCell(tick), bounds.x + 10, ty + 5);
  });

  ctx.fillStyle = pythonFigureStyle ? '#000000' : '#263238';
  ctx.font = pythonFigureStyle
    ? '700 16px "Courier New", Consolas, monospace'
    : '700 12px Inter, Arial, sans-serif';
  ctx.fillText(`Added concentration (${unitLabel})`, plot.x + plot.width / 2 - (pythonFigureStyle ? 150 : 86), bounds.y + bounds.height - 14);
  ctx.save();
  ctx.translate(bounds.x + (pythonFigureStyle ? 20 : 18), plot.y + plot.height / 2 + (pythonFigureStyle ? 62 : 42));
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(channelDisplayName(channel), 0, 0);
  ctx.restore();

  if (calibrationFit && Number.isFinite(calibrationFit.slope) && Number.isFinite(calibrationFit.intercept)) {
    ctx.save();
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = color;
    ctx.lineWidth = pythonFigureStyle ? 2.6 : 2;
    ctx.beginPath();
    ctx.moveTo(xToPx(xRange.min), yToPx(calibrationFit.slope * xRange.min + calibrationFit.intercept));
    ctx.lineTo(xToPx(xRange.max), yToPx(calibrationFit.slope * xRange.max + calibrationFit.intercept));
    ctx.stroke();
    ctx.restore();
  }

  calibrationPoints.forEach((point) => {
    const px = xToPx(point.x);
    const py = yToPx(point.y);
    if (typeof point.yerr === 'number' && Number.isFinite(point.yerr) && point.yerr > 0) {
      drawVerticalErrorBar(ctx, px, yToPx(point.y - point.yerr), yToPx(point.y + point.yerr), 10, color);
    }

    ctx.beginPath();
    ctx.arc(px, py, pythonFigureStyle ? 6 : 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = pythonFigureStyle ? 2.4 : 2;
    ctx.stroke();
  });

  standardGroups.forEach(({ fit, points }) => {

    if (Number.isFinite(fit.slope) && Number.isFinite(fit.intercept)) {
      ctx.strokeStyle = color;
      ctx.lineWidth = pythonFigureStyle ? 2.8 : 2.2;
      ctx.beginPath();
      ctx.moveTo(xToPx(xRange.min), yToPx(fit.slope * xRange.min + fit.intercept));
      ctx.lineTo(xToPx(xRange.max), yToPx(fit.slope * xRange.max + fit.intercept));
      ctx.stroke();
    }

    points.forEach((point) => {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        return;
      }

      const px = xToPx(point.x);
      const py = yToPx(point.y);
      if (typeof point.yerr === 'number' && Number.isFinite(point.yerr) && point.yerr > 0) {
        drawVerticalErrorBar(ctx, px, yToPx(point.y - point.yerr), yToPx(point.y + point.yerr), 10, color);
      }

      ctx.fillStyle = color;
      const markerSize = pythonFigureStyle ? 10 : 9;
      ctx.fillRect(px - markerSize / 2, py - markerSize / 2, markerSize, markerSize);
    });

    expectedRefs.forEach((ref) => {
      if (!referenceMatchesSample(ref, fit.sampleId)) {
        return;
      }

      const x = -ref.value / Math.max(fit.dilutionFactor, 1e-12);
      if (!Number.isFinite(x)) {
        return;
      }

      const px = xToPx(x);
      const py = yToPx(0);
      const xSd = ref.sd !== null && Number.isFinite(ref.sd)
        ? Math.abs(ref.sd / Math.max(fit.dilutionFactor, 1e-12))
        : Number.NaN;
      ctx.save();
      ctx.strokeStyle = '#8a3ffc';
      ctx.lineWidth = pythonFigureStyle ? 1.9 : 1.4;
      if (Number.isFinite(xSd) && xSd > 0) {
        drawHorizontalErrorBar(ctx, xToPx(x - xSd), xToPx(x + xSd), py, 10, '#8a3ffc');
      }
      ctx.beginPath();
      ctx.moveTo(px, py - 6);
      ctx.lineTo(px + 6, py);
      ctx.lineTo(px, py + 6);
      ctx.lineTo(px - 6, py);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    });
  });

  if (!pythonFigureStyle) {
    ctx.fillStyle = '#344044';
    ctx.font = '11px Inter, Arial, sans-serif';
    ctx.fillText('open circles: calibration, dashed fit', plot.x + 4, bounds.y + bounds.height - 36);
    ctx.fillText('filled squares: standard addition, solid fit', plot.x + 4, bounds.y + bounds.height - 22);
    if (expectedRefs.length > 0) {
      ctx.fillStyle = '#6d36c9';
      ctx.fillText('purple open diamonds: reference at -ref/DF with SD', plot.x + 248, bounds.y + bounds.height - 22);
    }
  } else {
    const legendX = plot.x + 10;
    let legendY = plot.y + 18;
    ctx.fillStyle = '#000000';
    ctx.font = '600 14px "Courier New", Consolas, monospace';
    ctx.fillText('o calibration (dashed)', legendX, legendY);
    legendY += 18;
    ctx.fillText('s standard addition (solid)', legendX, legendY);
    if (expectedRefs.length > 0) {
      legendY += 18;
      ctx.fillStyle = '#6d36c9';
      ctx.fillText('d reference +/- SD', legendX, legendY);
    }
  }

  ctx.restore();
}

function buildPythonStyleFigureRgbCanvas({
  imageBase,
  overlayCanvas,
  measurements,
  displayMeasurements,
  plateMap,
  calibrationFits,
  standardAdditionFits,
  expectedRefs,
  unitLabel,
  roiMode,
  backgroundModel,
  floorGeometryAvailable,
  bestChannel,
}: {
  imageBase: string;
  overlayCanvas: HTMLCanvasElement;
  measurements: WellMeasurement[];
  displayMeasurements: WellMeasurement[];
  plateMap: WellConfig[];
  calibrationFits: CalibrationFit[];
  standardAdditionFits: StandardAdditionFit[];
  expectedRefs: ExpectedRef[];
  unitLabel: string;
  roiMode: RoiMode;
  backgroundModel: BackgroundModel;
  floorGeometryAvailable: boolean;
  bestChannel: FitChannel;
}): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const width = 2481;
  const height = 2038;
  const ctx = canvas.getContext('2d');
  const rankingRows = computePythonResultsChannelRankings(
    calibrationFits,
    standardAdditionFits,
    displayMeasurements,
    plateMap,
  );
  const bestRank = rankingRows.find((row) => row.channel === bestChannel);

  canvas.width = width;
  canvas.height = height;

  if (!ctx) {
    throw new Error('Could not create Python-style RGB report canvas.');
  }

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  drawImageCover(ctx, overlayCanvas, overlayCanvas.width, overlayCanvas.height, 110, 70, 940, 626);

  ctx.fillStyle = '#172026';
  ctx.font = '700 34px Inter, Arial, sans-serif';
  ctx.fillText(`${imageBase} RGB/PAbs report`, 110, 760);

  const calSummary = calibrationFits.length > 0
    ? calibrationFits.map((fit) => `${channelDisplayName(fit.channel)} R2=${formatFitCell(fit.r2)}`).join('; ')
    : 'No calibration fits.';
  const stdSummary = standardAdditionFits.length > 0
    ? `${standardAdditionFits.length} standard-addition fits across ${new Set(standardAdditionFits.map((fit) => fit.sampleId)).size} sample IDs.`
    : 'No standard-addition fits.';
  const refSummary = expectedRefs.length > 0
    ? expectedRefs.map((ref) => `${ref.label || ref.refId || 'Reference'}=${formatFitCell(ref.value)} ${unitLabel}`).join('; ')
    : 'No external reference values.';
  const rankingSummary = rankingRows.map((row, index) => (
    `${index + 1}. ${channelDisplayName(row.channel)} score=${formatFitCell(row.score)} `
    + `R2cal=${formatFitCell(row.r2Cal)} R2std=${formatFitCell(row.r2Std)} `
    + `slope=${formatFitCell(row.slopeAgreement)} LOQ=${formatFitCell(row.loq)}`
  )).join('\n');
  const scientificLines = buildFigureRgbScientificLines({
    unitLabel,
    measurements,
    plateMap,
    calibrationFits,
    standardAdditionFits,
    expectedRefs,
    rankingRows,
    roiMode,
    backgroundModel,
    floorGeometryAvailable,
    bestChannel,
  });

  ctx.fillStyle = '#253033';
  drawPreformattedLines(
    ctx,
    scientificLines,
    110,
    812,
    24,
    height - 95,
    '18px Consolas, "Courier New", monospace',
    '700 18px Consolas, "Courier New", monospace',
  );

  const panelX = 1190;
  const panelWidth = 1160;
  const panelHeight = 575;

  PYTHON_RESULTS_CHANNELS.forEach((channel, index) => {
    drawPythonStyleChannelPanel(
      ctx,
      { x: panelX, y: 70 + index * (panelHeight + 42), width: panelWidth, height: panelHeight },
      channel,
      calibrationFits.find((fit) => fit.channel === channel),
      collectStandardAdditionGroupsForChannel(channel, standardAdditionFits, displayMeasurements, plateMap),
      collectCalibrationPointsForChannel(channel, displayMeasurements, plateMap),
      rankingRows.find((row) => row.channel === channel),
      unitLabel,
      expectedRefs,
      false,
      true,
    );
  });

  return canvas;
}

function buildPythonStyleBestChannelCanvas({
  bestChannel,
  displayMeasurements,
  plateMap,
  calibrationFits,
  standardAdditionFits,
  expectedRefs,
  unitLabel,
}: {
  bestChannel: FitChannel;
  displayMeasurements: WellMeasurement[];
  plateMap: WellConfig[];
  calibrationFits: CalibrationFit[];
  standardAdditionFits: StandardAdditionFit[];
  expectedRefs: ExpectedRef[];
  unitLabel: string;
}): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const width = 1062;
  const height = 708;
  const ctx = canvas.getContext('2d');
  const rankingRows = computePythonResultsChannelRankings(
    calibrationFits,
    standardAdditionFits,
    displayMeasurements,
    plateMap,
  );

  canvas.width = width;
  canvas.height = height;

  if (!ctx) {
    throw new Error('Could not create Python-style best-channel canvas.');
  }

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  drawPythonStyleChannelPanel(
    ctx,
    { x: 28, y: 24, width: width - 56, height: height - 48 },
    bestChannel,
    calibrationFits.find((fit) => fit.channel === bestChannel),
    collectStandardAdditionGroupsForChannel(bestChannel, standardAdditionFits, displayMeasurements, plateMap),
    collectCalibrationPointsForChannel(bestChannel, displayMeasurements, plateMap),
    rankingRows.find((row) => row.channel === bestChannel),
    unitLabel,
    expectedRefs,
    true,
  );

  return canvas;
}

function buildStandardAdditionGroupingSummary(fits: StandardAdditionFit[]): string {
  const firstFitByGroup = new Map<string, StandardAdditionFit>();

  fits.forEach((fit) => {
    const key = fit.groupKey ?? `${fit.sampleId}|DF=${fit.dilutionFactor}`;

    if (!firstFitByGroup.has(key)) {
      firstFitByGroup.set(key, fit);
    }
  });

  const groups = [...firstFitByGroup.values()];

  if (groups.length === 0) {
    return 'No standard-addition groups fitted.';
  }

  const sampleIds = [...new Set(groups.map((fit) => fit.sampleId))].join(', ');
  const dilutionFactors = [...new Set(groups.map((fit) => formatFitCell(fit.dilutionFactor)))].join(', ');
  const groupSummaries = groups.map((fit) => {
    const xMin = fit.fitXMin ?? Number.NaN;
    const xMax = fit.fitXMax ?? Number.NaN;
    const wells = fit.wellsUsed?.length ?? fit.n;

    return `${fit.sampleId} DF ${formatFitCell(fit.dilutionFactor)}: ${wells} wells, additions ${formatFitCell(xMin)}-${formatFitCell(xMax)}`;
  });

  return `${groups.length} standard-addition groups; sample IDs: ${sampleIds || MISSING_VALUE}; dilution factors: ${dilutionFactors || MISSING_VALUE}; ${groupSummaries.join('; ')}`;
}

function buildStandardAdditionWarningSummary(fits: StandardAdditionFit[]): string | null {
  const warningItems = fits
    .filter((fit) => (
      (fit.fitDiagnosticWarning && fit.fitDiagnosticWarning.trim() !== '') ||
      (fit.robustDiagnosticWarning && !fit.robustDiagnosticWarning.startsWith('No suspected outlier levels')) ||
      fit.suspectedOutlierAddedConcentrations?.length
    ))
    .map((fit) => {
      const outliers = fit.suspectedOutlierAddedConcentrations && fit.suspectedOutlierAddedConcentrations.length > 0
        ? `outlier additions ${fit.suspectedOutlierAddedConcentrations.map(formatFitCell).join(', ')}`
        : 'no outlier levels';
      const flags = [fit.fitDiagnosticWarning, fit.robustDiagnosticWarning]
        .filter((warning): warning is string => Boolean(warning && warning.trim() !== ''))
        .join('; ');

      return `${fit.sampleId} DF ${formatFitCell(fit.dilutionFactor)} ${fit.channel}: ${outliers}${flags ? `; ${flags}` : ''}`;
    });

  if (warningItems.length === 0) {
    return null;
  }

  return warningItems.join(' | ');
}

interface BackgroundModelDebugSummary {
  selectedModel: BackgroundModel;
  actualModel?: BackgroundModel;
  candidatePixels: number;
  acceptedPixels: number;
  acceptedSamples: number;
  localCount: number;
  expandedCount: number;
  globalCount: number;
  annularCount: number;
  physicalPolynomialCount: number;
  fallbackCount: number;
  candidateRegionX0?: number;
  candidateRegionY0?: number;
  candidateRegionX1?: number;
  candidateRegionY1?: number;
  candidateStride?: number;
  medianPitch?: number;
  wellExclusionRadiusApprox?: number;
  fitSuccess?: boolean;
  backgroundWarning?: string;
  maskAlgorithm?: string;
}

function HelpAboutDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={(event) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    }}>
      <section className="modal-dialog about-dialog" role="dialog" aria-modal="true" aria-labelledby="help-about-heading">
        <div className="section-title-row">
          <h2 id="help-about-heading">Help / About</h2>
          <button type="button" className="secondary-button" onClick={onClose} aria-label="Close help and about dialog">
            Close
          </button>
        </div>

        <section className="about-dialog-section">
          <h3>TIPICA</h3>
          <p>Tool for Image-based Plate-Integrated Colorimetric Analysis.</p>
        </section>

        <section className="about-dialog-section">
          <h3>How to use</h3>
          <ul>
            <li>Fill only wells that contain data. Empty cell = no data (0 is treated as a value).</li>
            <li>Use COPY ROW A or COPY COL 1 to propagate a pattern quickly.</li>
            <li>Type buttons U/C/A apply a tag to the whole row.</li>
          </ul>
        </section>

        <section className="about-dialog-section">
          <h3>Header block</h3>
          <ul>
            <li>Unit and x 10^ define the displayed concentration unit.</li>
          </ul>
        </section>

        <section className="about-dialog-section">
          <h3>Analysis options block</h3>
          <ul>
            <li>All points are always used in fitting.</li>
            <li>Primary RGB calibration and standard-addition fit rows use the Python robust residual-based IRLS port; full fitting parity across every Python path remains under validation.</li>
            <li>RGB signal is fixed to full background normalization. The image is never modified.</li>
            <li>ID/DF priority: chooses whether row defaults or column defaults are applied first.</li>
          </ul>
        </section>

        <section className="about-dialog-section">
          <h3>Reference values block</h3>
          <ul>
            <li>Label / Value / SD define external reference values for comparison.</li>
            <li>+ adds a row, - removes the last row (minimum one row remains).</li>
          </ul>
        </section>

        <section className="about-dialog-section">
          <h3>Cell syntax</h3>
          <ul>
            <li>value type</li>
            <li>value type ID</li>
            <li>value type ID DF</li>
            <li>U ID</li>
            <li>U ID DF</li>
          </ul>
          <p>Examples:</p>
          <p>1.5 C | 1.5 C CRM | 1.5 C CRM 50 | U SampleX | U SampleX 10</p>
          <p>When present, cell overrides take priority over row/column defaults.</p>
        </section>

        <section className="about-dialog-section">
          <h3>Citation / version</h3>
          <p>Version v0.1.5-beta. Author: Pasquale Palladino. License: AGPL-3.0-only. Webapp DOI: https://doi.org/10.5281/zenodo.21218968.</p>
        </section>
      </section>
    </div>
  );
}

function ResultsTable({
  measurements,
  correctedMeasurements,
  correctionApplied,
}: {
  measurements: WellMeasurement[];
  correctedMeasurements: WellMeasurement[];
  correctionApplied: boolean;
}) {
  const correctedByWell = new Map(correctedMeasurements.map((measurement) => [measurement.wellId, measurement]));

  return (
    <div className="results-table-wrap">
      <table className="results-table">
        <thead>
          <tr>
            <th>Well</th>
            <th>Row</th>
            <th>Col</th>
            <th>ROI pixels</th>
            <th>BG pixels</th>
            <th>Background model</th>
            <th>Background actual model</th>
            <th>BG candidates</th>
            <th>BG accepted samples</th>
            <th>Well R</th>
            <th>Well G</th>
            <th>Well B</th>
            <th>BG R</th>
            <th>BG G</th>
            <th>BG B</th>
            <th>PAbs_R raw</th>
            <th>PAbs_G raw</th>
            <th>PAbs_B raw</th>
            <th>PAbs_R corrected</th>
            <th>PAbs_G corrected</th>
            <th>PAbs_B corrected</th>
            <th>Correction applied</th>
            <th>Warnings</th>
          </tr>
        </thead>
        <tbody>
          {measurements.map((measurement) => {
            const correctedMeasurement = correctedByWell.get(measurement.wellId);

            return (
              <tr key={measurement.wellId}>
                <td>{measurement.wellId}</td>
                <td>{measurement.row}</td>
                <td>{measurement.col}</td>
                <td>{measurement.roiPixels}</td>
                <td>{measurement.bgPixels}</td>
                <td>{measurement.backgroundModel}</td>
                <td>{measurement.backgroundActualModel ?? measurement.backgroundModel}</td>
                <td>{measurement.candidatePixels ?? 0}</td>
                <td>{measurement.acceptedSamples ?? measurement.acceptedPixels ?? 0}</td>
                <td>{formatRgbCell(measurement.rgbWell.r)}</td>
                <td>{formatRgbCell(measurement.rgbWell.g)}</td>
                <td>{formatRgbCell(measurement.rgbWell.b)}</td>
                <td>{formatRgbCell(measurement.rgbBackground.r)}</td>
                <td>{formatRgbCell(measurement.rgbBackground.g)}</td>
                <td>{formatRgbCell(measurement.rgbBackground.b)}</td>
                <td>{formatPAbsCell(measurement.pabs.r)}</td>
                <td>{formatPAbsCell(measurement.pabs.g)}</td>
                <td>{formatPAbsCell(measurement.pabs.b)}</td>
                <td>{correctionApplied ? formatPAbsCell(correctedMeasurement?.pabs.r ?? Number.NaN) : MISSING_VALUE}</td>
                <td>{correctionApplied ? formatPAbsCell(correctedMeasurement?.pabs.g ?? Number.NaN) : MISSING_VALUE}</td>
                <td>{correctionApplied ? formatPAbsCell(correctedMeasurement?.pabs.b ?? Number.NaN) : MISSING_VALUE}</td>
                <td>{correctionApplied ? 'yes' : 'no'}</td>
                <td>{formatTextCell(measurement.warnings.join('; '))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CalibrationFitTable({ fits }: { fits: CalibrationFit[] }) {
  return (
    <div className="results-table-wrap compact-table-wrap">
      <table className="results-table fit-table">
        <thead>
          <tr>
            <th>Channel</th>
            <th>Slope</th>
            <th>Intercept</th>
            <th>R2</th>
            <th>N</th>
            <th>Correction applied</th>
            <th>S0</th>
            <th>Mean clip delta</th>
          </tr>
        </thead>
        <tbody>
          {fits.map((fit) => (
            <tr key={fit.channel}>
              <td>{fit.channel}</td>
              <td>{formatFitCell(fit.slope)}</td>
              <td>{formatFitCell(fit.intercept)}</td>
              <td>{formatFitCell(fit.r2)}</td>
              <td>{fit.n}</td>
              <td>{fit.correctionApplied ? 'yes' : 'no'}</td>
              <td>{formatOptionalFitCell(fit.S0)}</td>
              <td>{formatOptionalFitCell(fit.meanClipDelta)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StoredCalibrationTable({ calibration }: { calibration: StoredCalibration }) {
  return (
    <div className="results-table-wrap compact-table-wrap">
      <table className="results-table stored-calibration-table">
        <thead>
          <tr>
            <th>Channel</th>
            <th>Slope</th>
            <th>Intercept</th>
            <th>R2</th>
            <th>N</th>
            <th>Source name</th>
            <th>Created at</th>
          </tr>
        </thead>
        <tbody>
          {calibration.fits.map((fit) => (
            <tr key={fit.channel}>
              <td>{fit.channel}</td>
              <td>{formatFitCell(fit.slope)}</td>
              <td>{formatFitCell(fit.intercept)}</td>
              <td>{formatFitCell(fit.r2)}</td>
              <td>{fit.n}</td>
              <td>{calibration.sourceName}</td>
              <td>{calibration.createdAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StandardAdditionFitTable({ fits }: { fits: StandardAdditionFit[] }) {
  return (
    <div className="results-table-wrap compact-table-wrap">
      <table className="results-table standard-table">
        <thead>
          <tr>
            <th>Sample ID</th>
            <th>Dilution factor</th>
            <th>Channel</th>
            <th>Slope</th>
            <th>Intercept</th>
            <th>R2</th>
            <th>Concentration in original sample</th>
            <th>Internal calibration slope</th>
            <th>Internal slope agreement</th>
            <th>Stored calibration slope</th>
            <th>Stored slope agreement</th>
            <th>Stored-calibration corrected concentration in original sample</th>
            <th>Stored-calibration corrected concentration source</th>
            <th>Stored-calibration corrected concentration warning</th>
            <th>Correction applied</th>
            <th>S0</th>
            <th>Mean clip delta</th>
            <th>Number of wells used</th>
            <th>Wells used</th>
            <th>Added concentrations used</th>
            <th>Mean signal values used for fit</th>
            <th>Replicates per added concentration</th>
            <th>Fit x min</th>
            <th>Fit x max</th>
            <th>Fit y min</th>
            <th>Fit y max</th>
            <th>Fit warning</th>
            <th>Signal source used for fit</th>
            <th>Robust diagnostic available</th>
            <th>Suspected outlier added concentrations</th>
            <th>Suspected outlier wells</th>
            <th>Robust diagnostic levels used</th>
            <th>Robust diagnostic added concentrations used</th>
            <th>Robust diagnostic mean signals used</th>
            <th>Robust diagnostic slope</th>
            <th>Robust diagnostic intercept</th>
            <th>Robust diagnostic R2</th>
            <th>Robust diagnostic concentration in original sample</th>
            <th>Robust diagnostic warning</th>
            <th>Warnings</th>
          </tr>
        </thead>
        <tbody>
          {fits.map((fit) => (
            <tr key={`${fit.sampleId}-${fit.dilutionFactor}-${fit.channel}`}>
              <td>{fit.sampleId}</td>
              <td>{formatFitCell(fit.dilutionFactor)}</td>
              <td>{fit.channel}</td>
              <td>{formatFitCell(fit.slope)}</td>
              <td>{formatFitCell(fit.intercept)}</td>
              <td>{formatFitCell(fit.r2)}</td>
              <td>{formatFitCell(fit.concentrationInOriginalSample)}</td>
              <td>{formatOptionalFitCell(fit.internalCalibrationSlope)}</td>
              <td>{formatOptionalFitCell(fit.internalSlopeAgreement)}</td>
              <td>{formatOptionalFitCell(fit.storedCalibrationSlope)}</td>
              <td>{formatOptionalFitCell(fit.storedSlopeAgreement)}</td>
              <td>{formatOptionalFitCell(fit.storedCalibrationCorrectedConcentrationInOriginalSample)}</td>
              <td>{formatTextCell(fit.storedCalibrationCorrectedConcentrationSource ?? '')}</td>
              <td>{formatTextCell(fit.storedCalibrationCorrectedConcentrationWarning ?? '')}</td>
              <td>{fit.correctionApplied ? 'yes' : 'no'}</td>
              <td>{formatOptionalFitCell(fit.S0)}</td>
              <td>{formatOptionalFitCell(fit.meanClipDelta)}</td>
              <td>{fit.wellsUsed?.length ?? fit.n}</td>
              <td>{formatCompactTextList(fit.wellsUsed)}</td>
              <td>{formatCompactNumberList(fit.addedConcentrationsUsed)}</td>
              <td>{formatCompactNumberList(fit.meanSignalValuesUsed)}</td>
              <td>{formatCompactTextList(fit.replicatesPerAddedConcentration)}</td>
              <td>{formatOptionalFitCell(fit.fitXMin)}</td>
              <td>{formatOptionalFitCell(fit.fitXMax)}</td>
              <td>{formatOptionalFitCell(fit.fitYMin)}</td>
              <td>{formatOptionalFitCell(fit.fitYMax)}</td>
              <td>{formatTextCell(fit.fitDiagnosticWarning ?? '')}</td>
              <td>{formatTextCell(fit.signalSourceUsedForFit ?? '')}</td>
              <td>{fit.robustDiagnosticAvailable ? 'yes' : 'no'}</td>
              <td>{formatCompactNumberList(fit.suspectedOutlierAddedConcentrations)}</td>
              <td>{formatCompactTextList(fit.suspectedOutlierWells)}</td>
              <td>{formatOptionalFitCell(fit.robustDiagnosticLevelsUsed)}</td>
              <td>{formatCompactNumberList(fit.robustDiagnosticAddedConcentrationsUsed)}</td>
              <td>{formatCompactNumberList(fit.robustDiagnosticMeanSignalValuesUsed)}</td>
              <td>{formatOptionalFitCell(fit.robustDiagnosticSlope)}</td>
              <td>{formatOptionalFitCell(fit.robustDiagnosticIntercept)}</td>
              <td>{formatOptionalFitCell(fit.robustDiagnosticR2)}</td>
              <td>{formatOptionalFitCell(fit.robustDiagnosticConcentrationInOriginalSample)}</td>
              <td>{formatTextCell(fit.robustDiagnosticWarning ?? '')}</td>
              <td>{formatTextCell(fit.warnings.join('; '))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UnknownResultsTable({ results }: { results: UnknownConcentrationResult[] }) {
  return (
    <div className="results-table-wrap compact-table-wrap">
      <table className="results-table unknown-table">
        <thead>
          <tr>
            <th>Well</th>
            <th>Sample ID</th>
            <th>Dilution factor</th>
            <th>Channel</th>
            <th>PAbs raw</th>
            <th>PAbs corrected</th>
            <th>Correction applied</th>
            <th>S0</th>
            <th>Clip delta</th>
            <th>Stored calibration slope</th>
            <th>Stored calibration intercept</th>
            <th>Concentration in diluted sample</th>
            <th>Concentration in original sample</th>
            <th>Warnings</th>
          </tr>
        </thead>
        <tbody>
          {results.map((result) => (
            <tr key={`${result.wellId}-${result.channel}`}>
              <td>{result.wellId}</td>
              <td>{result.sampleId}</td>
              <td>{formatFitCell(result.dilutionFactor)}</td>
              <td>{result.channel}</td>
              <td>{formatPAbsCell(result.pabsRaw)}</td>
              <td>{result.correctionApplied ? formatPAbsCell(result.pabsCorrected) : MISSING_VALUE}</td>
              <td>{result.correctionApplied ? 'yes' : 'no'}</td>
              <td>{result.correctionApplied ? formatFitCell(result.S0) : MISSING_VALUE}</td>
              <td>{result.correctionApplied ? formatFitCell(result.clipDelta) : MISSING_VALUE}</td>
              <td>{formatFitCell(result.storedCalibrationSlope)}</td>
              <td>{formatFitCell(result.storedCalibrationIntercept)}</td>
              <td>{formatFitCell(result.concentrationInDilutedSample)}</td>
              <td>{formatFitCell(result.concentrationInOriginalSample)}</td>
              <td>{formatTextCell(result.warnings.join('; '))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


function App() {
  const storedCalibrationFileInputRef = useRef<HTMLInputElement>(null);
  const projectFileInputRef = useRef<HTMLInputElement>(null);
  const sharedGeometryFileInputRef = useRef<HTMLInputElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imageName, setImageName] = useState<string | null>(null);
  const [geometry, setGeometry] = useState<PlateGeometry | null>(null);
  const [geometryName, setGeometryName] = useState<string | null>(null);
  const [geometrySource, setGeometrySource] = useState<'none' | 'json' | 'manual'>('none');
  const [backgroundModel, setBackgroundModel] = useState<BackgroundModel>('physical-interwell-polynomial-v1');
  const [backgroundDebugSummary, setBackgroundDebugSummary] = useState<BackgroundModelDebugSummary | null>(null);
  const [projectLoadedInfo, setProjectLoadedInfo] = useState<{
    imageName: string | null;
    createdAt: string;
    lastExtractionSummary: string;
    lastFittingSummary: string;
    hasMethodMetadata: boolean;
    savedRoiMode?: string;
    savedRoiPixelStatisticsMode?: string;
    savedBackgroundModel?: string;
    savedLowSignalCorrectionEnabled?: boolean;
  } | null>(null);
  const [projectLoadWarning, setProjectLoadWarning] = useState<string | null>(null);
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number } | null>(null);
  const [measurements, setMeasurements] = useState<WellMeasurement[]>([]);
  const [roiStats, setRoiStats] = useState<{ minPixels: number; maxPixels: number; meanPixels: number } | null>(null);
  const [plateMap, setPlateMap] = useState<WellConfig[]>(createEmptyPlateMap);
  const [plateMapUnit, setPlateMapUnit] = useState('mM');
  const [plateEditorSnapshot, setPlateEditorSnapshot] = useState<PlateEditorSnapshot | null>(null);
  const [expectedRefs, setExpectedRefs] = useState<ExpectedRef[]>([]);
  const [calibrationFits, setCalibrationFits] = useState<CalibrationFit[]>([]);
  const [standardAdditionFits, setStandardAdditionFits] = useState<StandardAdditionFit[]>([]);
  const [storedCalibration, setStoredCalibration] = useState<StoredCalibration | null>(null);
  const [useLowSignalCorrection, setUseLowSignalCorrection] = useState(true);
  const [lowSignalCorrectionTouched, setLowSignalCorrectionTouched] = useState(false);
  const [manualPickingActive, setManualPickingActive] = useState(false);
  const [manualPoints, setManualPoints] = useState<Point[]>([]);
  const [manualMouthRadiusPx, setManualMouthRadiusPx] = useState(DEFAULT_MANUAL_MOUTH_RADIUS_PX);
  const [floorCirclePickingActive, setFloorCirclePickingActive] = useState(false);
  const [manualFloorCircles, setManualFloorCircles] = useState<FloorCircle[]>([]);
  const [manualFloorCirclePreviewCenter, setManualFloorCirclePreviewCenter] = useState<Point | null>(null);
  const [manualFloorCircleRadiusDelta, setManualFloorCircleRadiusDelta] = useState(0);
  const [floorGeometrySource, setFloorGeometrySource] = useState<FloorGeometrySource>('none');
  const [floorGeometryNotice, setFloorGeometryNotice] = useState<string | null>(null);
  const [sharedGeometryOverride, setSharedGeometryOverride] = useState<SharedGeometryOverrideState | null>(null);
  const [sharedGeometryOverrideStatus, setSharedGeometryOverrideStatus] = useState('No Python canonical geometry override active.');
  const [radiusFactor, setRadiusFactor] = useState(DEFAULT_RADIUS_FACTOR);
  const [roiMode, setRoiMode] = useState<'simple' | 'floor-aware' | 'mouth-floor-intersection'>('mouth-floor-intersection');
  const [roiPixelStatisticsMode, setRoiPixelStatisticsMode] = useState<RoiPixelStatisticsMode>('robust-trimmed-v1');
  const [floorRoiRadiusFactor, setFloorRoiRadiusFactor] = useState(0.85);
  const [showMouthGrid, setShowMouthGrid] = useState(true);
  const [showFloorCircles, setShowFloorCircles] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('Waiting');
  const [isHelpAboutOpen, setIsHelpAboutOpen] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isFitting, setIsFitting] = useState(false);
  const [isRunningCompleteAnalysis, setIsRunningCompleteAnalysis] = useState(false);
  const [pendingCompleteAnalysisFitting, setPendingCompleteAnalysisFitting] = useState(false);
  const [pendingCompleteAnalysisPackageExport, setPendingCompleteAnalysisPackageExport] = useState(false);
  const isExtractingRef = useRef(false);
  const isFittingRef = useRef(false);

  const wells = useMemo(() => (geometry ? generate96WellGrid(geometry) : []), [geometry]);
  const geometryAlignmentDiagnostics = useMemo(
    () => (geometry && wells.length === 96 ? computeGeometryAlignmentDiagnostics(geometry, wells) : null),
    [geometry, wells],
  );
  const overlayReady = Boolean(image && wells.length === 96);
  const projectImageMismatchBlocksExtraction = Boolean(projectLoadedInfo?.imageName && projectLoadedInfo.imageName !== imageName);
  const loadedProjectMethodMetadataMismatch = Boolean(
    projectLoadedInfo?.hasMethodMetadata && (
      (projectLoadedInfo.savedRoiMode !== undefined && projectLoadedInfo.savedRoiMode !== roiMode) ||
      (projectLoadedInfo.savedRoiPixelStatisticsMode !== undefined && projectLoadedInfo.savedRoiPixelStatisticsMode !== roiPixelStatisticsMode) ||
      (projectLoadedInfo.savedBackgroundModel !== undefined && projectLoadedInfo.savedBackgroundModel !== backgroundModel) ||
      (projectLoadedInfo.savedLowSignalCorrectionEnabled !== undefined && projectLoadedInfo.savedLowSignalCorrectionEnabled !== useLowSignalCorrection)
    ),
  );
  const floorGeometryAvailable = useMemo(
    () => Boolean(geometry && hasFloorGeometry(geometry)),
    [geometry],
  );
  const floorCircles = useMemo(
    () => (geometry ? generate96WellFloorCircles(geometry, wells, radiusFactor) : null),
    [geometry, radiusFactor, wells],
  );
  const effectiveWells = useMemo(() => {
    if (!sharedGeometryOverride) {
      return wells;
    }

    return wells.map((well) => {
      const overrideRecord = sharedGeometryOverride.recordsByWell.get(well.wellId);
      return overrideRecord
        ? { ...well, x: overrideRecord.mouthCx, y: overrideRecord.mouthCy }
        : well;
    });
  }, [sharedGeometryOverride, wells]);
  const effectiveFloorCircles = useMemo(() => {
    if (!sharedGeometryOverride) {
      return floorCircles;
    }

    return wells.map((well) => {
      const overrideRecord = sharedGeometryOverride.recordsByWell.get(well.wellId);
      return {
        x: overrideRecord?.floorCx ?? well.x,
        y: overrideRecord?.floorCy ?? well.y,
        r: overrideRecord?.floorRadius ?? Math.max(1, estimateRoiRadius(wells, well.row, well.col, radiusFactor)),
      };
    });
  }, [floorCircles, radiusFactor, sharedGeometryOverride, wells]);
  const effectiveFloorGeometryAvailable = Boolean(
    sharedGeometryOverride
      ? effectiveFloorCircles && effectiveFloorCircles.length === wells.length && wells.length === 96
      : floorGeometryAvailable,
  );
  const sharedGeometryExclusionRadiiByWell = useMemo<WellExclusionRadiusMap | undefined>(() => {
    if (!sharedGeometryOverride) {
      return undefined;
    }

    const radii = new Map<string, number>();
    sharedGeometryOverride.recordsByWell.forEach((record) => {
      if (record.cylRadiusBg && Number.isFinite(record.cylRadiusBg) && record.cylRadiusBg > 0) {
        radii.set(record.wellId, record.cylRadiusBg);
      }
    });

    return radii.size > 0 ? radii : undefined;
  }, [sharedGeometryOverride]);
  const referenceFloorCircles = useMemo(
    () => (geometry && hasFloorGeometry(geometry) ? getReferenceFloorCircles(geometry) : []),
    [geometry],
  );
  const currentReferenceMouthCircle = useMemo(
    () => getReferenceMouthCircle(wells, manualFloorCircles.length, radiusFactor),
    [manualFloorCircles.length, radiusFactor, wells],
  );
  const manualFloorCirclePreview = useMemo<FloorCircle | null>(() => {
    if (!floorCirclePickingActive || !currentReferenceMouthCircle) {
      return null;
    }

    const center = manualFloorCirclePreviewCenter ?? currentReferenceMouthCircle;

    return {
      x: center.x,
      y: center.y,
      r: Math.max(2, currentReferenceMouthCircle.r + manualFloorCircleRadiusDelta),
    };
  }, [
    currentReferenceMouthCircle,
    floorCirclePickingActive,
    manualFloorCirclePreviewCenter,
    manualFloorCircleRadiusDelta,
  ]);
  const hasCalibrationWellsInMap = useMemo(
    () => plateMap.some((well) => well.role === 'C'),
    [plateMap],
  );
  const hasStandardAdditionWellsInMap = useMemo(
    () => plateMap.some((well) => well.role === 'A'),
    [plateMap],
  );
  const hasUnknownWellsInMap = useMemo(
    () => plateMap.some((well) => well.role === 'U'),
    [plateMap],
  );
  const internalLowSignalCorrections = useMemo(
    () => computeRgbLowSignalCorrections(measurements, plateMap),
    [measurements, plateMap],
  );
  const storedLowSignalCorrections = storedCalibration?.corrections ?? [];
  const activeLowSignalCorrections = internalLowSignalCorrections.length > 0
    ? internalLowSignalCorrections
    : storedLowSignalCorrections;
  const lowSignalCorrectionSource = internalLowSignalCorrections.length > 0
    ? 'current calibration wells'
    : storedLowSignalCorrections.length > 0
      ? 'stored calibration'
      : 'none';
  const lowSignalCorrectionContextAvailable = hasCalibrationWellsInMap || Boolean(storedCalibration);
  const lowSignalCorrectionEffective = useLowSignalCorrection && activeLowSignalCorrections.length > 0;
  const correctionMetadataSummary = useMemo(
    () => summarizeCorrectionMetadata(lowSignalCorrectionEffective, lowSignalCorrectionSource, activeLowSignalCorrections),
    [activeLowSignalCorrections, lowSignalCorrectionEffective, lowSignalCorrectionSource],
  );
  const currentMethodMetadata = useMemo<MethodMetadata>(() => {
    const extractedMeasurement = measurements[0];

    return {
      roiMode: extractedMeasurement?.roiMode ?? roiMode,
      roiPixelStatisticsMode: extractedMeasurement?.roiPixelStatisticsMode ?? roiPixelStatisticsMode,
      backgroundModel,
      backgroundActualModel: extractedMeasurement?.backgroundActualModel,
      backgroundMaskAlgorithm: extractedMeasurement?.backgroundMaskAlgorithm,
      backgroundCandidatePixels: extractedMeasurement?.candidatePixels,
      backgroundAcceptedSamples: extractedMeasurement?.acceptedSamples,
      backgroundWarning: extractedMeasurement?.backgroundWarning,
      correctionApplied: lowSignalCorrectionEffective,
      correctionSource: lowSignalCorrectionEffective ? lowSignalCorrectionSource : 'none',
      correctionMetadata: correctionMetadataSummary,
      appVersion: packageJson.version,
      geometrySource: sharedGeometryOverride ? SHARED_GEOMETRY_OVERRIDE_SOURCE : formatFloorGeometrySource(floorGeometrySource, floorGeometryAvailable),
    };
  }, [
    backgroundModel,
    correctionMetadataSummary,
    floorGeometryAvailable,
    floorGeometrySource,
    lowSignalCorrectionEffective,
    lowSignalCorrectionSource,
    measurements,
    roiMode,
    roiPixelStatisticsMode,
    sharedGeometryOverride,
  ]);
  const methodSummaryPayload = useMemo(() => ({
    appVersion: packageJson.version,
    selected: {
      roiMode,
      roiPixelStatisticsMode,
      backgroundModel,
      lowSignalCorrection: useLowSignalCorrection ? 'on' : 'off',
    },
    actual: {
      backgroundModelUsed: currentMethodMetadata.backgroundActualModel ?? 'pending',
      backgroundCandidatePixels: currentMethodMetadata.backgroundCandidatePixels ?? null,
      backgroundAcceptedSamples: currentMethodMetadata.backgroundAcceptedSamples ?? null,
      backgroundWarnings: currentMethodMetadata.backgroundWarning ?? null,
    },
    correction: {
      applied: currentMethodMetadata.correctionApplied,
      source: currentMethodMetadata.correctionSource ?? 'none',
      metadata: currentMethodMetadata.correctionMetadata ?? null,
    },
    geometry: {
      source: currentMethodMetadata.geometrySource ?? 'unknown',
      sharedGeometryOverrideActive: Boolean(sharedGeometryOverride),
      sharedGeometryOverrideSource: sharedGeometryOverride?.sourceName ?? null,
    },
  }), [backgroundModel, currentMethodMetadata, roiMode, roiPixelStatisticsMode, sharedGeometryOverride, useLowSignalCorrection]);
  const storedCalibrationMetadataWarning = storedCalibration
    ? storedCalibration.methodMetadata
      ? methodMetadataMatches(currentMethodMetadata, storedCalibration.methodMetadata)
        ? null
        : STORED_CALIBRATION_METHOD_MISMATCH_WARNING
      : LIMITED_STORED_CALIBRATION_METADATA_WARNING
    : null;
  const correctedMeasurementSet = useMemo(
    () => applyRgbLowSignalCorrections(
      measurements,
      plateMap,
      activeLowSignalCorrections,
      lowSignalCorrectionEffective,
    ),
    [activeLowSignalCorrections, lowSignalCorrectionEffective, measurements, plateMap],
  );
  const standardAdditionFitsWithSlopeContext = useMemo(
    () => addCalibrationSlopeContextToStandardAddition(
      standardAdditionFits,
      calibrationFits,
      storedCalibration,
    ),
    [calibrationFits, standardAdditionFits, storedCalibration],
  );
  const unknownResults = useMemo(
    () => estimateUnknownConcentrationsFromStoredCalibration(
      measurements,
      plateMap,
      storedCalibration,
      useLowSignalCorrection,
    ),
    [measurements, plateMap, storedCalibration, useLowSignalCorrection],
  );
  const canSaveStoredCalibration = useMemo(
    () => canCreateStoredCalibration(calibrationFits),
    [calibrationFits],
  );

  useEffect(() => {
    if (!isHelpAboutOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsHelpAboutOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isHelpAboutOpen]);

  useEffect(() => {
    if (!lowSignalCorrectionContextAvailable) {
      setUseLowSignalCorrection(false);
      setLowSignalCorrectionTouched(false);
      return;
    }

    if (!lowSignalCorrectionTouched) {
      setUseLowSignalCorrection(true);
    }
  }, [lowSignalCorrectionContextAvailable, lowSignalCorrectionTouched]);

  useEffect(() => {
    if (!projectLoadedInfo) {
      setProjectLoadWarning(null);
      return;
    }

    if (!projectLoadedInfo.imageName) {
      setProjectLoadWarning(null);
      return;
    }

    if (!imageName) {
      setProjectLoadWarning(
        `Loaded project expects image "${projectLoadedInfo.imageName}". Load that image to match the saved geometry.`,
      );
      return;
    }

    if (projectLoadedInfo.imageName !== imageName) {
      setProjectLoadWarning(
        `Loaded project references image "${projectLoadedInfo.imageName}" but current image is "${imageName}". Load the matching image for best results.`,
      );
      return;
    }

    setProjectLoadWarning(null);
  }, [imageName, projectLoadedInfo]);

  const handleCanvasSizeChange = useCallback((nextSize: { width: number; height: number } | null) => {
    setCanvasSize((currentSize) => {
      if (!currentSize && !nextSize) {
        return currentSize;
      }

      if (
        currentSize &&
        nextSize &&
        currentSize.width === nextSize.width &&
        currentSize.height === nextSize.height
      ) {
        return currentSize;
      }

      return nextSize;
    });
  }, []);

  const extractionSummary = measurements.length > 0
    ? `${measurements.length} rows ready (${formatRoiPixelStatisticsMode(measurements[0]?.roiPixelStatisticsMode ?? roiPixelStatisticsMode)})`
    : 'Waiting';
  const configuredWellCount = plateMap.filter((well) => well.role !== 'EMPTY').length;
  const storedCalibrationChannels = storedCalibration
    ? storedCalibration.fits.map((fit) => fit.channel).join(', ')
    : MISSING_VALUE;
  const storedCalibrationExpected = !storedCalibration && (
    hasUnknownWellsInMap ||
    (hasStandardAdditionWellsInMap && !hasCalibrationWellsInMap)
  );
  const fittingWarnings = [
    measurements.length === 0 ? 'Run RGB/PAbs extraction before fitting.' : null,
    configuredWellCount === 0 ? 'Load or edit a plate map before fitting.' : null,
    !hasCalibrationWellsInMap ? 'Calibration has no C wells in the current plate map.' : null,
    !hasStandardAdditionWellsInMap ? 'Standard addition has no A wells in the current plate map.' : null,
    storedCalibrationExpected ? 'Stored calibration is not loaded; external reference columns and unknown projections will be unavailable.' : null,
  ].filter((message): message is string => message !== null);
  const fittingSummary = calibrationFits.length > 0 || standardAdditionFits.length > 0
    ? `${calibrationFits.length} calibration, ${standardAdditionFits.length} standard addition`
    : 'Waiting';
  const standardAdditionGroupingSummary = useMemo(
    () => buildStandardAdditionGroupingSummary(standardAdditionFitsWithSlopeContext),
    [standardAdditionFitsWithSlopeContext],
  );
  const standardAdditionWarningSummary = useMemo(
    () => buildStandardAdditionWarningSummary(standardAdditionFitsWithSlopeContext),
    [standardAdditionFitsWithSlopeContext],
  );
  const manualStatus = manualPickingActive && manualPoints.length < 4
    ? `Click ${MANUAL_CORNER_LABELS[manualPoints.length]} mouth/corner circle (${manualPoints.length + 1}/4)`
    : geometry
      ? '4/4 mouth points'
      : `${manualPoints.length}/4 mouth points`;
  const manualMouthRadiusStatus = manualPickingActive
    ? `Mouse wheel: adjust mouth circle radius (${manualMouthRadiusPx.toFixed(1)} px)`
    : `Mouth circle radius: ${manualMouthRadiusPx.toFixed(1)} px`;
  const activeFloorCircleLabel = FLOOR_CIRCLE_REFERENCES[Math.min(manualFloorCircles.length, FLOOR_CIRCLE_REFERENCES.length - 1)].label;
  const floorCircleStatus = floorCirclePickingActive
    ? `Move circle to ${activeFloorCircleLabel} floor, use mouse wheel to resize, click to confirm`
    : floorGeometryAvailable
      ? '4/4 floor circles'
      : `${manualFloorCircles.length}/4 floor circles`;
  const floorGeometrySourceLabel = formatFloorGeometrySource(floorGeometrySource, floorGeometryAvailable);
  const savedProjectRoiModeLabel = projectLoadedInfo?.savedRoiMode
    ? (
      projectLoadedInfo.savedRoiMode === 'simple' ||
      projectLoadedInfo.savedRoiMode === 'floor-aware' ||
      projectLoadedInfo.savedRoiMode === 'mouth-floor-intersection'
        ? formatRoiMode(projectLoadedInfo.savedRoiMode as RoiMode)
        : projectLoadedInfo.savedRoiMode
    )
    : MISSING_VALUE;
  const savedProjectRoiStatsLabel = projectLoadedInfo?.savedRoiPixelStatisticsMode
    ? (
      projectLoadedInfo.savedRoiPixelStatisticsMode === 'simple-median' ||
      projectLoadedInfo.savedRoiPixelStatisticsMode === 'robust-trimmed-v1'
        ? formatRoiPixelStatisticsMode(projectLoadedInfo.savedRoiPixelStatisticsMode as RoiPixelStatisticsMode)
        : projectLoadedInfo.savedRoiPixelStatisticsMode
    )
    : MISSING_VALUE;
  const savedProjectBackgroundModelLabel = projectLoadedInfo?.savedBackgroundModel
    ? (
      projectLoadedInfo.savedBackgroundModel === 'annular' ||
      projectLoadedInfo.savedBackgroundModel === 'robust-interwell-v1' ||
      projectLoadedInfo.savedBackgroundModel === 'physical-interwell-polynomial-v1'
        ? formatBackgroundModel(projectLoadedInfo.savedBackgroundModel as BackgroundModel)
        : projectLoadedInfo.savedBackgroundModel
    )
    : MISSING_VALUE;
  const savedProjectCorrectionLabel = projectLoadedInfo?.savedLowSignalCorrectionEnabled === undefined
    ? MISSING_VALUE
    : projectLoadedInfo.savedLowSignalCorrectionEnabled
      ? 'Low-signal correction enabled'
      : 'Low-signal correction disabled';
  const analysisStatusLabel = isRunningCompleteAnalysis || isExtracting || isFitting
    ? 'Analysis running'
    : calibrationFits.length > 0 || standardAdditionFits.length > 0 || unknownResults.length > 0
      ? 'Results available'
      : overlayReady && configuredWellCount > 0
        ? 'Analysis ready'
        : 'Analysis waiting';
  const publicStatusItems = [
    image ? 'Image loaded' : 'Image waiting',
    wells.length === 96 ? 'Geometry ready' : 'Geometry waiting',
    configuredWellCount > 0 ? 'Map configured' : 'Map waiting',
    analysisStatusLabel,
    error ? 'Needs attention' : null,
  ].filter((item): item is string => item !== null);
  const compactStatusSummary = publicStatusItems.join(' / ');

  const clearFits = useCallback(() => {
    setCalibrationFits([]);
    setStandardAdditionFits([]);
  }, []);

  const clearMeasurementsAndFits = useCallback(() => {
    setMeasurements([]);
    setRoiStats(null);
    clearFits();
  }, [clearFits]);

  const clearSharedGeometryOverrideState = useCallback((status = 'No Python canonical geometry override active.') => {
    setSharedGeometryOverride(null);
    setSharedGeometryOverrideStatus(status);
  }, []);

  const handleLoadSharedGeometryOverrideClick = useCallback(() => {
    sharedGeometryFileInputRef.current?.click();
  }, []);

  const handleSharedGeometryOverrideFileChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];

    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const requiredWellIds = wells.length === 96
        ? wells.map((well) => well.wellId)
        : defaultSharedGeometryWellIds();
      const override = parseSharedGeometryOverrideJson(text, file.name, requiredWellIds);
      setSharedGeometryOverride(override);
      setSharedGeometryOverrideStatus(
        `Python canonical geometry override active: ${override.wellCount} wells from ${file.name}. Ignored fields: ${override.ignoredFields.length > 0 ? override.ignoredFields.join(', ') : 'none'}.`,
      );
      clearMeasurementsAndFits();
      clearFits();
      setStatusMessage('Developer shared-geometry override loaded; rerun extraction.');
      setError(null);
    } catch (overrideError) {
      const detail = overrideError instanceof Error ? overrideError.message : 'Unknown shared-geometry parse error.';
      if (sharedGeometryOverride) {
        setSharedGeometryOverrideStatus(`Shared geometry override load failed: ${detail}. Existing override preserved.`);
      } else {
        clearSharedGeometryOverrideState(`Shared geometry override load failed: ${detail}`);
      }
      clearMeasurementsAndFits();
      setError(`Could not load Python canonical geometry: ${file.name}. ${detail}`);
    } finally {
      event.currentTarget.value = '';
    }
  }, [clearFits, clearMeasurementsAndFits, clearSharedGeometryOverrideState, sharedGeometryOverride, wells]);

  const handleClearSharedGeometryOverride = useCallback(() => {
    clearSharedGeometryOverrideState();
    clearMeasurementsAndFits();
    setStatusMessage('Developer shared-geometry override cleared; rerun extraction.');
    setError(null);
  }, [clearMeasurementsAndFits, clearSharedGeometryOverrideState]);

  const handlePlateMapChange = useCallback((nextPlateMap: WellConfig[]) => {
    setPlateMap(nextPlateMap);
    clearFits();
  }, [clearFits]);

  const handleClearPlateMap = useCallback(() => {
    setPlateMap(createEmptyPlateMap());
    setPlateMapUnit('mM');
    setPlateEditorSnapshot(null);
    clearFits();
  }, [clearFits]);

  const handleStartManualPicking = useCallback(() => {
    if (!image) {
      setError('Load an image before picking geometry manually.');
      return;
    }

    if (floorGeometryAvailable) {
      setFloorGeometryNotice('Mouth/corner geometry changed; floor circles were cleared and may need to be picked again.');
    } else {
      setFloorGeometryNotice(null);
    }

    setManualMouthRadiusPx(estimateInitialManualMouthRadius(wells, radiusFactor));
    setManualPickingActive(true);
    setManualPoints([]);
    setFloorCirclePickingActive(false);
    setManualFloorCircles([]);
    setManualFloorCirclePreviewCenter(null);
    setManualFloorCircleRadiusDelta(0);
    setFloorGeometrySource('none');
    setGeometry(null);
    setGeometryName(null);
    setGeometrySource('manual');
    clearSharedGeometryOverrideState('Python canonical geometry override cleared because mouth/corner geometry changed.');
    clearMeasurementsAndFits();
    setError(null);
  }, [clearMeasurementsAndFits, clearSharedGeometryOverrideState, floorGeometryAvailable, image, radiusFactor, wells]);

  const handleManualPointPick = useCallback((point: Point) => {
    if (!manualPickingActive || manualPoints.length >= 4) {
      return;
    }

    const nextPoints = [...manualPoints, point];
    setManualPoints(nextPoints);
    clearMeasurementsAndFits();

    if (nextPoints.length === 4) {
      const nextGeometry = geometryFromManualPoints(nextPoints);

      if (nextGeometry) {
        const nextRadiusFactor = manualMouthRadiusToRadiusFactor(nextPoints, manualMouthRadiusPx);
        const geometryWithManualMouthRadius: PlateGeometry = {
          ...nextGeometry,
          mouth_radius_px: manualMouthRadiusPx,
          ...(nextRadiusFactor ? { roi_radius_factor: nextRadiusFactor } : {}),
        };

        if (nextRadiusFactor) {
          setRadiusFactor(nextRadiusFactor);
        }

        setGeometry(geometryWithManualMouthRadius);
        setGeometryName('Manual 4-corner geometry');
        setGeometrySource('manual');
        setManualPickingActive(false);
        setStatusMessage(`Manual geometry complete; mouth radius ${manualMouthRadiusPx.toFixed(1)} px`);
      }
    }

    setError(null);
  }, [clearMeasurementsAndFits, manualMouthRadiusPx, manualPickingActive, manualPoints]);

  const handleManualMouthRadiusAdjust = useCallback((delta: number) => {
    if (!manualPickingActive) {
      return;
    }

    setManualMouthRadiusPx((currentRadius) => clampManualMouthRadiusPx(currentRadius + delta));
  }, [manualPickingActive]);

  const handleUndoManualPoint = useCallback(() => {
    if (manualPoints.length === 0) {
      return;
    }

    const nextPoints = manualPoints.slice(0, -1);
    setManualPoints(nextPoints);
    setManualPickingActive(true);
    clearMeasurementsAndFits();

    if (geometrySource === 'manual') {
      setGeometry(null);
      setGeometryName(null);
      setFloorGeometrySource('none');
      setManualFloorCircles([]);
      setManualFloorCirclePreviewCenter(null);
      setManualFloorCircleRadiusDelta(0);
      setFloorCirclePickingActive(false);
      clearSharedGeometryOverrideState('Python canonical geometry override cleared because mouth/corner geometry changed.');
    }
  }, [clearMeasurementsAndFits, clearSharedGeometryOverrideState, geometrySource, manualPoints]);

  const handleResetManualPoints = useCallback(() => {
    setManualPickingActive(false);
    setManualPoints([]);
    clearMeasurementsAndFits();

    if (geometrySource === 'manual') {
      setGeometry(null);
      setGeometryName(null);
      setGeometrySource('none');
      setFloorGeometrySource('none');
      setManualFloorCircles([]);
      setManualFloorCirclePreviewCenter(null);
      setManualFloorCircleRadiusDelta(0);
      setFloorCirclePickingActive(false);
      clearSharedGeometryOverrideState('Python canonical geometry override cleared because mouth/corner geometry changed.');
    }
  }, [clearMeasurementsAndFits, clearSharedGeometryOverrideState, geometrySource]);

  const handleExportGeometryJson = useCallback(() => {
    if (!geometry) {
      setError('Define mouth/corner geometry before exporting geometry.');
      return;
    }

    downloadGeometryJson(geometry, imageName);

    if (!floorGeometryAvailable) {
      setFloorGeometryNotice('Exported geometry without floor circles.');
      setStatusMessage('Exported geometry without floor circles.');
    } else {
      setFloorGeometryNotice(null);
      setStatusMessage('Geometry JSON exported');
    }

    setError(null);
  }, [floorGeometryAvailable, geometry, imageName]);

  const handleStartFloorCirclePicking = useCallback(() => {
    if (!image) {
      setError('Load an image before picking floor circles manually.');
      return;
    }

    if (!geometry || wells.length !== 96) {
      setError('Load or define mouth/corner geometry before picking floor circles.');
      return;
    }

    setManualPickingActive(false);
    setFloorCirclePickingActive(true);
    setManualFloorCircles([]);
    setManualFloorCirclePreviewCenter(null);
    setManualFloorCircleRadiusDelta(0);
    setFloorGeometrySource('none');
    setFloorGeometryNotice(null);
    setShowFloorCircles(true);
    setGeometry(geometryWithoutFloorCircles(geometry));
    clearSharedGeometryOverrideState('Python canonical geometry override cleared because floor geometry changed.');
    clearMeasurementsAndFits();
    setError(null);
  }, [clearMeasurementsAndFits, clearSharedGeometryOverrideState, geometry, image, wells.length]);

  const handleFloorCirclePointerMove = useCallback((point: Point) => {
    if (!floorCirclePickingActive) {
      return;
    }

    setManualFloorCirclePreviewCenter(point);
  }, [floorCirclePickingActive]);

  const handleFloorCircleRadiusAdjust = useCallback((delta: number) => {
    if (!floorCirclePickingActive) {
      return;
    }

    const baseRadius = currentReferenceMouthCircle?.r ?? 8;

    setManualFloorCircleRadiusDelta((currentDelta) => {
      const nextDelta = Math.max(-200, Math.min(200, currentDelta + delta));
      return Math.max(2 - baseRadius, nextDelta);
    });
  }, [currentReferenceMouthCircle, floorCirclePickingActive]);

  const handleFloorCirclePointPick = useCallback((point: Point) => {
    if (!floorCirclePickingActive || !geometry) {
      return;
    }

    const baseRadius = currentReferenceMouthCircle?.r ?? 8;
    const radius = Math.max(2, baseRadius + manualFloorCircleRadiusDelta);
    const nextCircles = [
      ...manualFloorCircles,
      {
        x: point.x,
        y: point.y,
        r: radius,
      },
    ];

    setManualFloorCircles(nextCircles);
    setManualFloorCirclePreviewCenter(null);
    setManualFloorCircleRadiusDelta(0);
    clearMeasurementsAndFits();

    if (nextCircles.length === FLOOR_CIRCLE_REFERENCES.length) {
      setGeometry(geometryWithFloorCircles(geometry, nextCircles));
      setFloorGeometrySource('manual');
      setFloorCirclePickingActive(false);
      setManualFloorCircles([]);
      setManualFloorCirclePreviewCenter(null);
      setManualFloorCircleRadiusDelta(0);
      setFloorGeometryNotice(null);
      setStatusMessage('Manual floor-circle geometry complete');
      clearSharedGeometryOverrideState('Python canonical geometry override cleared because floor geometry changed.');
    }

    setError(null);
  }, [
    clearMeasurementsAndFits,
    clearSharedGeometryOverrideState,
    currentReferenceMouthCircle,
    floorCirclePickingActive,
    geometry,
    manualFloorCircleRadiusDelta,
    manualFloorCircles,
  ]);

  const handleResetFloorCircles = useCallback(() => {
    setFloorCirclePickingActive(false);
    setManualFloorCircles([]);
    setManualFloorCirclePreviewCenter(null);
    setManualFloorCircleRadiusDelta(0);
    setFloorGeometrySource('none');
    setFloorGeometryNotice(null);

    if (geometry) {
      setGeometry(geometryWithoutFloorCircles(geometry));
      clearSharedGeometryOverrideState('Python canonical geometry override cleared because floor geometry changed.');
      clearMeasurementsAndFits();
    }
  }, [clearMeasurementsAndFits, clearSharedGeometryOverrideState, geometry]);

  const handleExportProjectJson = useCallback(() => {
    try {
      if (!geometry) {
        setError('Load or define plate geometry before saving a project.');
        return;
      }

      const projectPayload = createProjectPayload(
        image,
        imageName,
        geometry,
        radiusFactor,
        plateMap,
        plateMapUnit,
        plateEditorSnapshot,
        expectedRefs,
        storedCalibration,
        useLowSignalCorrection,
        backgroundModel,
        roiMode,
        roiPixelStatisticsMode,
        floorRoiRadiusFactor,
        floorGeometrySource,
        extractionSummary,
        fittingSummary,
      );

      downloadJsonFile(projectPayload, createProjectFileName(imageName));
      setError(null);
    } catch (saveError) {
      const detail = saveError instanceof Error ? saveError.message : 'Unknown project save error.';
      setError(detail);
    }
  }, [backgroundModel, expectedRefs, extractionSummary, fittingSummary, floorGeometrySource, floorRoiRadiusFactor, geometry, image, imageName, plateEditorSnapshot, plateMap, plateMapUnit, radiusFactor, roiMode, roiPixelStatisticsMode, storedCalibration, useLowSignalCorrection]);

  const handleLoadProjectClick = useCallback(() => {
    projectFileInputRef.current?.click();
  }, []);

  const handleProjectFileChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];

    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const raw = JSON.parse(text);
      const project = parseProjectJson(raw);
      const hadFloorGeometry = Boolean(geometry && hasFloorGeometry(geometry));
      const reconciledGeometry = reconcileLoadedGeometryFloor(
        project.geometry,
        project.floorGeometrySource,
        geometry,
        floorGeometrySource,
        {
          allowApproximateMouthGeometryMatch: true,
          preferCurrentFloorGeometry: true,
        },
      );

      setGeometry(reconciledGeometry.geometry);
      setGeometryName('Loaded project geometry');
      setGeometrySource('json');
      setFloorGeometrySource(reconciledGeometry.floorGeometrySource);
      setFloorGeometryNotice(reconciledGeometry.preservedCurrentPlateGeometry
        ? 'Project did not include floor circles; preserved the already-loaded floor-capable geometry and applied project settings.'
        : reconciledGeometry.preservedCurrentFloorGeometry
          ? 'Project did not include floor circles; preserved compatible floor circles already loaded.'
        : !hasFloorGeometry(project.geometry) && hadFloorGeometry
          ? 'Project geometry does not include floor circles; existing floor circles were not preserved because the mouth/corner geometry differs.'
          : null);
      setRadiusFactor(project.roiRadiusFactor);
      setManualMouthRadiusPx(reconciledGeometry.geometry.mouth_radius_px
        ? clampManualMouthRadiusPx(reconciledGeometry.geometry.mouth_radius_px)
        : DEFAULT_MANUAL_MOUTH_RADIUS_PX);
      // Older projects may not carry ROI/background method settings. Missing or
      // invalid settings are treated as "no opinion" so loading a project cannot
      // silently downgrade an already floor/intersection-capable analysis path.
      setRoiMode(project.roiMode ?? roiMode);
      setRoiPixelStatisticsMode(project.roiPixelStatisticsMode ?? roiPixelStatisticsMode);
      setFloorRoiRadiusFactor(project.floorRoiRadiusFactor ?? floorRoiRadiusFactor);
      setPlateMap(project.plateMap);
      setPlateMapUnit(project.plateMapUnit);
      setPlateEditorSnapshot(project.plateEditorSnapshot);
      setExpectedRefs(project.expectedRefs);
      setStoredCalibration(project.storedCalibration);
      setBackgroundModel(project.backgroundModel ?? backgroundModel);
      setUseLowSignalCorrection(project.lowSignalCorrectionEnabled);
      setLowSignalCorrectionTouched(true);
      const loadedMethodMetadata = project.methodMetadata as Record<string, unknown> | null;
      const savedRoiMode = loadedMethodMetadata && typeof loadedMethodMetadata.roiMode === 'string'
        ? loadedMethodMetadata.roiMode
        : project.roiMode ?? undefined;
      const savedRoiPixelStatisticsMode = loadedMethodMetadata && typeof loadedMethodMetadata.roiPixelStatisticsMode === 'string'
        ? loadedMethodMetadata.roiPixelStatisticsMode
        : project.roiPixelStatisticsMode ?? undefined;
      const savedBackgroundModel = loadedMethodMetadata && typeof loadedMethodMetadata.backgroundModel === 'string'
        ? loadedMethodMetadata.backgroundModel
        : project.backgroundModel ?? undefined;
      const savedLowSignalCorrectionEnabled = loadedMethodMetadata && typeof loadedMethodMetadata.lowSignalCorrectionEnabled === 'boolean'
        ? loadedMethodMetadata.lowSignalCorrectionEnabled
        : undefined;
      setProjectLoadedInfo({
        imageName: project.imageName,
        createdAt: project.createdAt,
        lastExtractionSummary: project.lastExtractionSummary,
        lastFittingSummary: project.lastFittingSummary,
        hasMethodMetadata: project.methodMetadata !== null,
        savedRoiMode,
        savedRoiPixelStatisticsMode,
        savedBackgroundModel,
        savedLowSignalCorrectionEnabled,
      });

      clearMeasurementsAndFits();
      setManualPickingActive(false);
      setManualPoints([]);
      setFloorCirclePickingActive(false);
      setManualFloorCircles([]);
      setManualFloorCirclePreviewCenter(null);
      setManualFloorCircleRadiusDelta(0);
      setError(null);
    } catch (loadError) {
      const detail = loadError instanceof Error ? loadError.message : 'Unknown project load error.';
      setError(`Could not load project JSON: ${file.name}. ${detail}`);
    } finally {
      event.currentTarget.value = '';
    }
  }, [
    backgroundModel,
    clearMeasurementsAndFits,
    clearSharedGeometryOverrideState,
    floorGeometrySource,
    floorRoiRadiusFactor,
    geometry,
    roiMode,
    roiPixelStatisticsMode,
  ]);

  const handleClearProject = useCallback(() => {
    setGeometry(null);
    setGeometryName(null);
    setGeometrySource('none');
    setRadiusFactor(DEFAULT_RADIUS_FACTOR);
    setManualMouthRadiusPx(DEFAULT_MANUAL_MOUTH_RADIUS_PX);
    setRoiMode('simple');
    setRoiPixelStatisticsMode('simple-median');
    setFloorRoiRadiusFactor(0.85);
    setShowMouthGrid(true);
    setShowFloorCircles(true);
    setPlateMap(createEmptyPlateMap());
    setPlateMapUnit('mM');
    setPlateEditorSnapshot(null);
    setExpectedRefs([]);
    setStoredCalibration(null);
    setUseLowSignalCorrection(false);
    setLowSignalCorrectionTouched(false);
    setProjectLoadedInfo(null);
    setProjectLoadWarning(null);
    setBackgroundDebugSummary(null);
    setManualPickingActive(false);
    setManualPoints([]);
    setFloorCirclePickingActive(false);
    setManualFloorCircles([]);
    setManualFloorCirclePreviewCenter(null);
    setManualFloorCircleRadiusDelta(0);
    setFloorGeometrySource('none');
    setFloorGeometryNotice(null);
    setRoiStats(null);
    clearSharedGeometryOverrideState();
    clearMeasurementsAndFits();
    setError(null);
  }, [clearMeasurementsAndFits, clearSharedGeometryOverrideState]);

  const runExtractionRoutine = useCallback(async (options?: {
    roiMode?: 'simple' | 'floor-aware' | 'mouth-floor-intersection';
    roiPixelStatisticsMode?: RoiPixelStatisticsMode;
    backgroundModel?: BackgroundModel;
  }): Promise<boolean> => {
    if (isExtractingRef.current) {
      return false;
    }

    if (projectImageMismatchBlocksExtraction) {
      setError('Load the matching project image before extraction.');
      return false;
    }

    if (!image || wells.length !== 96) {
      setError('Load an image and a 96-well geometry before extraction.');
      return false;
    }

    const selectedRoiMode = options?.roiMode ?? roiMode;
    const selectedRoiPixelStatisticsMode = options?.roiPixelStatisticsMode ?? roiPixelStatisticsMode;
    const selectedBackgroundModel = options?.backgroundModel ?? backgroundModel;

    isExtractingRef.current = true;
    setIsExtracting(true);
    setStatusMessage(selectedBackgroundModel === 'physical-interwell-polynomial-v1'
      ? 'Building physical inter-well polynomial background and extracting wells...'
      : selectedRoiPixelStatisticsMode === 'robust-trimmed-v1'
        ? 'Building robust background and extracting wells with robust trimmed ROI v1...'
        : 'Building robust background and extracting wells...');
    setBackgroundDebugSummary(null);
    setMeasurements([]);
    setError(null);

    const success = await new Promise<boolean>((resolve) => {
      window.setTimeout(() => {
        try {
          const extractionWells = sharedGeometryOverride ? effectiveWells : wells;
          const extractionFloorCircles = sharedGeometryOverride ? effectiveFloorCircles : floorCircles;
          const extractionFloorGeometryAvailable = sharedGeometryOverride ? effectiveFloorGeometryAvailable : floorGeometryAvailable;
          const imageData = createAnalysisImageData(image, extractionWells);
          const floorCirclesForBackground = extractionFloorGeometryAvailable && extractionFloorCircles && extractionFloorCircles.length === extractionWells.length
            ? extractionFloorCircles
            : undefined;
          const precomputedPhysicalBackground = selectedBackgroundModel === 'physical-interwell-polynomial-v1'
            ? estimatePhysicalInterwellPolynomialBackgrounds(imageData, extractionWells, floorCirclesForBackground, sharedGeometryExclusionRadiiByWell)
            : null;
          const nextMeasurements = extractionWells.map((well) => {
          const overrideRecord = sharedGeometryOverride?.recordsByWell.get(well.wellId);
          const pitch = overrideRecord?.localPitchPx ?? estimateLocalPitch(extractionWells, well.row, well.col);
          let roiSample;
          let floorRadiusUsed = 0;
          let mouthRadiusUsed = 0;
          let roiModeUsed: 'simple' | 'floor-aware' | 'mouth-floor-intersection' = 'simple';
          const roiWarnings: string[] = [];

          if (selectedRoiMode === 'mouth-floor-intersection' && extractionFloorGeometryAvailable && extractionFloorCircles && extractionFloorCircles.length === extractionWells.length) {
            const projectedFloorCircle = extractionFloorCircles[well.row * 12 + well.col];
            const floorRadius = overrideRecord ? Math.max(1, overrideRecord.floorRadius) : Math.max(1, projectedFloorCircle.r);
            const mouthRadius = overrideRecord ? Math.max(1, overrideRecord.mouthRadius) : estimateRoiRadius(extractionWells, well.row, well.col, radiusFactor);
            floorRadiusUsed = floorRadius;
            mouthRadiusUsed = mouthRadius;
            roiModeUsed = 'mouth-floor-intersection';
            roiSample = sampleCircleIntersectionRoi(imageData, well.x, well.y, mouthRadius, projectedFloorCircle.x, projectedFloorCircle.y, floorRadius, { pixelStatisticsMode: selectedRoiPixelStatisticsMode });
          } else if (selectedRoiMode === 'floor-aware' && extractionFloorGeometryAvailable && extractionFloorCircles && extractionFloorCircles.length === extractionWells.length) {
            const projectedFloorCircle = extractionFloorCircles[well.row * 12 + well.col];
            const radius = overrideRecord ? Math.max(1, overrideRecord.floorRadius) : Math.max(1, projectedFloorCircle.r);
            floorRadiusUsed = radius;
            roiModeUsed = 'floor-aware';
            roiSample = sampleCircularRoi(imageData, projectedFloorCircle.x, projectedFloorCircle.y, radius, { pixelStatisticsMode: selectedRoiPixelStatisticsMode });
          } else {
            if (selectedRoiMode === 'mouth-floor-intersection' || selectedRoiMode === 'floor-aware') {
              roiWarnings.push(`${selectedRoiMode === 'mouth-floor-intersection' ? 'Mouth-floor intersection' : 'Floor-aware'} ROI selected but floor geometry is unavailable; using simple center ROI instead.`);
            }
            const roiRadius = overrideRecord ? Math.max(1, overrideRecord.mouthRadius) : estimateRoiRadius(extractionWells, well.row, well.col, radiusFactor);
            mouthRadiusUsed = roiRadius;
            roiSample = sampleCircularRoi(imageData, well.x, well.y, roiRadius, { pixelStatisticsMode: selectedRoiPixelStatisticsMode });
          }

          const backgroundCx = (selectedRoiMode === 'floor-aware' || selectedRoiMode === 'mouth-floor-intersection') && extractionFloorGeometryAvailable && extractionFloorCircles && extractionFloorCircles.length === extractionWells.length
            ? extractionFloorCircles[well.row * 12 + well.col].x
            : well.x;
          const backgroundCy = (selectedRoiMode === 'floor-aware' || selectedRoiMode === 'mouth-floor-intersection') && extractionFloorGeometryAvailable && extractionFloorCircles && extractionFloorCircles.length === extractionWells.length
            ? extractionFloorCircles[well.row * 12 + well.col].y
            : well.y;
          const backgroundRoiRadius = (selectedRoiMode === 'floor-aware' || selectedRoiMode === 'mouth-floor-intersection') && extractionFloorGeometryAvailable && extractionFloorCircles && extractionFloorCircles.length === extractionWells.length
            ? floorRadiusUsed
            : mouthRadiusUsed || estimateRoiRadius(extractionWells, well.row, well.col, radiusFactor);
          let backgroundSample: BackgroundEstimateWithModel;

          if (selectedBackgroundModel === 'physical-interwell-polynomial-v1') {
            const physicalEstimate = precomputedPhysicalBackground?.estimatesByWell.get(well.wellId);

            if (physicalEstimate) {
              backgroundSample = physicalEstimate;
            } else {
              const fallback = estimateBackground(
                imageData,
                extractionWells,
                geometry!,
                backgroundCx,
                backgroundCy,
                backgroundRoiRadius,
                pitch,
                'robust-interwell-v1',
                (selectedRoiMode === 'floor-aware' || selectedRoiMode === 'mouth-floor-intersection') && extractionFloorGeometryAvailable && extractionFloorCircles ? extractionFloorCircles : undefined,
                sharedGeometryExclusionRadiiByWell,
              );
              const fallbackWarning = precomputedPhysicalBackground?.fallbackWarning
                ?? 'Physical inter-well polynomial background unavailable; falling back to robust inter-well background v1.';
              const diagnostics = precomputedPhysicalBackground?.diagnostics;

              backgroundSample = {
                ...fallback,
                backgroundModel: 'physical-interwell-polynomial-v1',
                actualModel: fallback.actualModel ?? fallback.backgroundModel,
                warnings: [fallbackWarning, ...fallback.warnings],
                backgroundWarning: [fallbackWarning, fallback.backgroundWarning ?? fallback.warnings.join('; ')]
                  .filter((message) => message.trim() !== '')
                  .join('; '),
                candidatePixels: diagnostics?.candidatePixels ?? fallback.candidatePixels ?? 0,
                acceptedPixels: diagnostics?.acceptedPixels ?? fallback.acceptedPixels ?? 0,
                acceptedSamples: diagnostics?.acceptedSamples ?? fallback.acceptedSamples ?? fallback.acceptedPixels ?? 0,
                candidateStride: diagnostics?.candidateStride ?? fallback.candidateStride ?? 1,
                candidateRegionX0: diagnostics?.candidateRegionX0 ?? fallback.candidateRegionX0 ?? 0,
                candidateRegionY0: diagnostics?.candidateRegionY0 ?? fallback.candidateRegionY0 ?? 0,
                candidateRegionX1: diagnostics?.candidateRegionX1 ?? fallback.candidateRegionX1 ?? 0,
                candidateRegionY1: diagnostics?.candidateRegionY1 ?? fallback.candidateRegionY1 ?? 0,
                medianPitch: diagnostics?.medianPitch ?? fallback.medianPitch ?? 0,
                wellExclusionRadiusApprox: diagnostics?.wellExclusionRadiusApprox ?? fallback.wellExclusionRadiusApprox ?? 0,
                maskAlgorithm: diagnostics?.maskAlgorithm ?? fallback.maskAlgorithm,
                backgroundFitSuccess: false,
              };
            }
          } else {
            backgroundSample = estimateBackground(
              imageData,
              extractionWells,
              geometry!,
              backgroundCx,
              backgroundCy,
              backgroundRoiRadius,
              pitch,
              selectedBackgroundModel,
              (selectedRoiMode === 'floor-aware' || selectedRoiMode === 'mouth-floor-intersection') && extractionFloorGeometryAvailable && extractionFloorCircles ? extractionFloorCircles : undefined,
              sharedGeometryExclusionRadiiByWell,
            );
          }
          const pabsResult = computePAbs(roiSample, backgroundSample.rgbBackground);

          return {
            wellId: well.wellId,
            row: well.row + 1,
            col: well.col + 1,
            roiPixels: roiSample.pixels,
            bgPixels: backgroundSample.bgPixels,
            backgroundModel: backgroundSample.backgroundModel,
            backgroundActualModel: backgroundSample.actualModel ?? backgroundSample.backgroundModel,
            rgbWell: rgbFromSample(roiSample),
            rgbBackground: rgbFromSample(backgroundSample.rgbBackground),
            pabs: rgbFromSample(pabsResult),
            warnings: [
              ...roiSample.warnings,
              ...roiWarnings,
              ...backgroundSample.warnings,
              ...pabsResult.warnings,
            ],
            backgroundOutcome: backgroundSample.outcome,
            candidatePixels: backgroundSample.candidatePixels ?? 0,
            acceptedPixels: backgroundSample.acceptedPixels ?? 0,
            acceptedSamples: backgroundSample.acceptedSamples ?? backgroundSample.acceptedPixels ?? 0,
            candidateStride: backgroundSample.candidateStride ?? 1,
            candidateRegionX0: backgroundSample.candidateRegionX0 ?? 0,
            candidateRegionY0: backgroundSample.candidateRegionY0 ?? 0,
            candidateRegionX1: backgroundSample.candidateRegionX1 ?? 0,
            candidateRegionY1: backgroundSample.candidateRegionY1 ?? 0,
            medianPitch: overrideRecord?.localPitchPx ?? backgroundSample.medianPitch ?? 0,
            wellExclusionRadiusApprox: overrideRecord?.cylRadiusBg ?? backgroundSample.wellExclusionRadiusApprox ?? 0,
            backgroundMaskAlgorithm: backgroundSample.maskAlgorithm ?? '',
            backgroundWarning: backgroundSample.backgroundWarning ?? '',
            backgroundFitSuccess: backgroundSample.backgroundFitSuccess,
            roiMode: roiModeUsed,
            roiPixelStatisticsMode: roiSample.roiPixelStatisticsMode ?? selectedRoiPixelStatisticsMode,
            roiFullPixels: roiSample.roiFullPixels ?? roiSample.pixels,
            roiCorePixels: roiSample.roiCorePixels ?? roiSample.pixels,
            roiUsedPixels: roiSample.roiUsedPixels ?? roiSample.pixels,
            roiUsedFraction: roiSample.roiUsedFraction ?? (roiSample.pixels > 0 ? 1 : 0),
            roiTrimDarkQ: roiSample.roiTrimDarkQ ?? null,
            roiTrimBrightQ: roiSample.roiTrimBrightQ ?? null,
            roiStatisticsWarning: (roiSample.roiStatisticsWarnings ?? []).join('; '),
            highlightFractionRoi: roiSample.highlightFractionRoi,
            highlightFractionCore: roiSample.highlightFractionCore,
            brightExcludedFraction: roiSample.brightExcludedFraction,
            brightExcludedMeanGray: roiSample.brightExcludedMeanGray,
            brightExcessMeanGray: roiSample.brightExcessMeanGray,
            highlightIndex: roiSample.highlightIndex,
            floorGeometryAvailable: extractionFloorGeometryAvailable,
            floorRadiusUsed,
            mouthRadiusUsed,
            geometryA1MismatchPx: geometryAlignmentDiagnostics?.a1MismatchPx ?? Number.NaN,
            geometryA12MismatchPx: geometryAlignmentDiagnostics?.a12MismatchPx ?? Number.NaN,
            geometryH12MismatchPx: geometryAlignmentDiagnostics?.h12MismatchPx ?? Number.NaN,
            geometryH1MismatchPx: geometryAlignmentDiagnostics?.h1MismatchPx ?? Number.NaN,
            geometryAlignmentWarning: geometryAlignmentDiagnostics?.warning ?? null,
          };
        });

        const backgroundStats: BackgroundModelDebugSummary = nextMeasurements.reduce((stats, measurement) => {
          if (measurement.backgroundOutcome === 'physical-polynomial') {
            stats.physicalPolynomialCount += 1;
          } else if (measurement.backgroundOutcome === 'local') {
            stats.localCount += 1;
          } else if (measurement.backgroundOutcome === 'expanded') {
            stats.expandedCount += 1;
          } else if (measurement.backgroundOutcome === 'global') {
            stats.globalCount += 1;
          } else if (measurement.backgroundOutcome === 'annular') {
            stats.annularCount += 1;
          }

          if (measurement.backgroundActualModel !== measurement.backgroundModel) {
            stats.fallbackCount += 1;
          }

          return stats;
        }, {
          selectedModel: selectedBackgroundModel,
          actualModel: nextMeasurements[0]?.backgroundActualModel,
          candidatePixels: nextMeasurements[0]?.candidatePixels ?? 0,
          acceptedPixels: nextMeasurements[0]?.acceptedPixels ?? 0,
          acceptedSamples: nextMeasurements[0]?.acceptedSamples ?? 0,
          candidateStride: nextMeasurements[0]?.candidateStride ?? 1,
          candidateRegionX0: nextMeasurements[0]?.candidateRegionX0 ?? 0,
          candidateRegionY0: nextMeasurements[0]?.candidateRegionY0 ?? 0,
          candidateRegionX1: nextMeasurements[0]?.candidateRegionX1 ?? 0,
          candidateRegionY1: nextMeasurements[0]?.candidateRegionY1 ?? 0,
          medianPitch: nextMeasurements[0]?.medianPitch ?? 0,
          wellExclusionRadiusApprox: nextMeasurements[0]?.wellExclusionRadiusApprox ?? 0,
          fitSuccess: nextMeasurements[0]?.backgroundFitSuccess,
          backgroundWarning: nextMeasurements[0]?.backgroundWarning,
          maskAlgorithm: nextMeasurements[0]?.backgroundMaskAlgorithm,
          localCount: 0,
          expandedCount: 0,
          globalCount: 0,
          annularCount: 0,
          physicalPolynomialCount: 0,
          fallbackCount: 0,
        });

        setBackgroundDebugSummary(backgroundStats);

        // Calculate ROI statistics
        const roiPixelCounts = nextMeasurements.map((m) => m.roiPixels);
        const minROIPixels = Math.min(...roiPixelCounts);
        const maxROIPixels = Math.max(...roiPixelCounts);
        const meanROIPixels = roiPixelCounts.length > 0
          ? roiPixelCounts.reduce((a, b) => a + b, 0) / roiPixelCounts.length
          : 0;

        setRoiStats({
          minPixels: minROIPixels,
          maxPixels: maxROIPixels,
          meanPixels: meanROIPixels,
        });

        setMeasurements(nextMeasurements);
        clearFits();
        setStatusMessage('Extraction complete');
        setError(null);
          resolve(true);
      } catch (extractionError) {
        const detail = extractionError instanceof Error ? extractionError.message : 'Unknown extraction error.';
        setMeasurements([]);
        setRoiStats(null);
        clearFits();
        setStatusMessage('Extraction failed');
        setError(detail);
          resolve(false);
      } finally {
        isExtractingRef.current = false;
        setIsExtracting(false);
      }
      }, 0);
    });

    return success;
  }, [
    backgroundModel,
    clearFits,
    effectiveFloorCircles,
    effectiveFloorGeometryAvailable,
    effectiveWells,
    floorCircles,
    floorGeometryAvailable,
    floorRoiRadiusFactor,
    geometry,
    geometryAlignmentDiagnostics,
    image,
    projectImageMismatchBlocksExtraction,
    radiusFactor,
    roiMode,
    roiPixelStatisticsMode,
    sharedGeometryExclusionRadiiByWell,
    sharedGeometryOverride,
    wells,
  ]);

  const runFittingRoutine = useCallback(async (options?: { useLowSignalCorrection?: boolean }): Promise<boolean> => {
    if (isFittingRef.current) {
      return false;
    }

    if (projectImageMismatchBlocksExtraction) {
      setError('Load the matching project image before fitting.');
      return false;
    }

    if (measurements.length === 0) {
      setError('Run RGB/PAbs extraction before fitting.');
      return false;
    }

    if (configuredWellCount === 0) {
      setError('Load or edit a plate map before fitting.');
      return false;
    }

    const effectiveUseLowSignalCorrection = options?.useLowSignalCorrection ?? useLowSignalCorrection;
    const applyCorrection = effectiveUseLowSignalCorrection && activeLowSignalCorrections.length > 0;

    isFittingRef.current = true;
    setIsFitting(true);
    setStatusMessage('Fitting in progress...');
    setError(null);

    const success = await new Promise<boolean>((resolve) => {
      window.setTimeout(() => {
        try {
          const correctionResult = applyCorrection
            ? applyRgbLowSignalCorrections(
              measurements,
              plateMap,
              activeLowSignalCorrections,
              true,
            )
            : null;
          const analysisMeasurements = correctionResult
            ? correctionResult.measurements
            : measurements;
          const applications = correctionResult
            ? correctionResult.applications
            : [];
        const nextCalibrationFits = fitCalibration(analysisMeasurements, plateMap);
        const correctedFitChannels = applyCorrection
          ? activeLowSignalCorrections.map((correction) => correction.channel)
          : [];
        const nextStandardAdditionFits = fitStandardAddition(
          analysisMeasurements,
          plateMap,
          correctedFitChannels,
        );

        setCalibrationFits(addCorrectionMetadataToCalibrationFits(
          nextCalibrationFits,
          applications,
          activeLowSignalCorrections,
        ).map((fit) => ({ ...fit, methodMetadata: currentMethodMetadata })));
        setStandardAdditionFits(addCorrectionMetadataToStandardAdditionFits(
          nextStandardAdditionFits,
          applications,
          activeLowSignalCorrections,
        ).map((fit) => ({ ...fit, methodMetadata: currentMethodMetadata })));
        setStatusMessage('Fitting complete');
        setError(null);
          resolve(true);
      } catch (fittingError) {
        const detail = fittingError instanceof Error ? fittingError.message : 'Unknown fitting error.';
        setStatusMessage('Fitting failed');
        setError(detail);
          resolve(false);
      } finally {
        isFittingRef.current = false;
        setIsFitting(false);
      }
      }, 0);
    });

    return success;
  }, [
    activeLowSignalCorrections,
    measurements,
    plateMap,
    configuredWellCount,
    currentMethodMetadata,
    projectImageMismatchBlocksExtraction,
    useLowSignalCorrection,
  ]);

  const handleSaveStoredCalibration = useCallback(() => {
    try {
      const calibration = createStoredCalibrationFromFits(
        calibrationFits,
        imageName ?? 'current image',
        calibrationFits.some((fit) => fit.correctionApplied) ? activeLowSignalCorrections : [],
        new Date().toISOString(),
        currentMethodMetadata,
      );

      setStoredCalibration(calibration);
      downloadStoredCalibrationJson(calibration);
      setError(null);
    } catch (saveError) {
      const detail = saveError instanceof Error ? saveError.message : 'Unknown stored calibration error.';
      setError(detail);
    }
  }, [activeLowSignalCorrections, calibrationFits, currentMethodMetadata, imageName]);

  const handleLoadStoredCalibrationClick = useCallback(() => {
    storedCalibrationFileInputRef.current?.click();
  }, []);

  const handleStoredCalibrationFileChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];

    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const raw = JSON.parse(text);
      const calibration = parseStoredCalibrationJson(raw);
      setStoredCalibration(calibration);
      clearFits();
      setError(calibration.methodMetadata ? null : LIMITED_STORED_CALIBRATION_METADATA_WARNING);
    } catch (loadError) {
      const detail = loadError instanceof Error ? loadError.message : 'Unknown stored calibration parse error.';
      setError(`Could not load stored calibration JSON: ${file.name}. ${detail}`);
    } finally {
      event.currentTarget.value = '';
    }
  }, [clearFits]);

  const handleClearStoredCalibration = useCallback(() => {
    setStoredCalibration(null);
    clearFits();
    setError(null);
  }, [clearFits]);

  const handleExportCompleteAnalysisPackage = useCallback(async () => {
    if (measurements.length === 0 && calibrationFits.length === 0 && standardAdditionFitsWithSlopeContext.length === 0) {
      setError('Run extraction or fitting before exporting the complete analysis package.');
      return;
    }

    try {
      const files: { name: string; blob: Blob }[] = [];
      const pythonResultsBase = safePythonResultsBaseName(imageName);
      const pythonResultsPrefix = `RESULTS/${pythonResultsBase}`;
      const pythonRawDataDetailsPrefix = `RAW_DATA_DETAILS/${pythonResultsBase}`;
      const addTextFile = (
        name: string,
        text: string,
        type: string,
      ) => {
        files.push({ name, blob: new Blob([text], { type }) });
      };
      const displayMeasurements = lowSignalCorrectionEffective
        ? correctedMeasurementSet.measurements
        : measurements;
      const effectiveCalibrationFits = storedCalibration
        ? calibrationFitsFromStoredCalibration(storedCalibration)
        : calibrationFits;
      const rankings = computePythonResultsChannelRankings(
        effectiveCalibrationFits,
        standardAdditionFitsWithSlopeContext,
        displayMeasurements,
        plateMap,
      );
      const methodComparisonFitRows = [
        ...buildReportFitRows(
          measurements,
          effectiveCalibrationFits,
          standardAdditionFitsWithSlopeContext,
          unknownResults,
          displayMeasurements,
          plateMap,
          rankings,
          activeLowSignalCorrections,
        ),
        ...storedCalibrationDiagnosticFitRows(storedCalibration),
        ...buildCielabFittingRows(buildCielabDiagnosticPoints(measurements, plateMap, storedCalibration?.cielabReference).points, undefined, storedCalibration),
      ];
      const methodComparisonRows = buildMethodComparisonRowsFromFitRows(methodComparisonFitRows, expectedRefs, true);
      const bestChannel = storedCalibration?.selectedChannel ?? rankings[0]?.channel ?? 'R';
      let backgroundVisualDiagnostics: BackgroundVisualDiagnostics | null = null;
      let pythonPlateOverlayCanvas: HTMLCanvasElement | null = null;
      let imageQcInfo: PythonImageQcInfo | undefined;

      if (image && measurements.length > 0 && wells.length === 96) {
        const exportWells = sharedGeometryOverride ? effectiveWells : wells;
        const exportFloorCircles = sharedGeometryOverride ? effectiveFloorCircles : floorCircles;
        const exportFloorGeometryAvailable = sharedGeometryOverride ? effectiveFloorGeometryAvailable : floorGeometryAvailable;
        const imageData = createAnalysisImageData(image, exportWells);
        imageQcInfo = computePythonImageQcInfo(
          imageData,
          exportWells,
          measurements,
          imageName,
          { width: image.naturalWidth, height: image.naturalHeight },
        );
        pythonPlateOverlayCanvas = buildPythonStylePlateRoiOverlayCanvas(
          imageData,
          exportWells,
          measurements,
          radiusFactor,
          floorRoiRadiusFactor,
          exportFloorGeometryAvailable ? exportFloorCircles : null,
        );
        const pythonFigureRgbCanvas = buildPythonStyleFigureRgbCanvas({
          imageBase: pythonResultsBase,
          overlayCanvas: pythonPlateOverlayCanvas,
          measurements,
          displayMeasurements,
          plateMap,
          calibrationFits: effectiveCalibrationFits,
          standardAdditionFits: standardAdditionFitsWithSlopeContext,
          expectedRefs,
          unitLabel: plateMapUnit,
          roiMode: currentMethodMetadata.roiMode,
          backgroundModel,
          floorGeometryAvailable: exportFloorGeometryAvailable,
          bestChannel,
        });
        const pythonBestChannelCanvas = buildPythonStyleBestChannelCanvas({
          bestChannel,
          displayMeasurements,
          plateMap,
          calibrationFits: effectiveCalibrationFits,
          standardAdditionFits: standardAdditionFitsWithSlopeContext,
          expectedRefs,
          unitLabel: plateMapUnit,
        });

        addZipBlob(
          files,
          `${pythonResultsPrefix}_BEST_CHANNEL.png`,
          await canvasToPngBlob(pythonBestChannelCanvas),
        );
        addZipBlob(
          files,
          `${pythonResultsPrefix}_FIGURE_RGB.png`,
          await canvasToPngBlob(pythonFigureRgbCanvas),
        );
        addZipBlob(
          files,
          `${pythonResultsPrefix}_PLATE_ROI_OVERLAY.png`,
          await canvasToPngBlob(pythonPlateOverlayCanvas),
        );

        if (geometry) {
          const diagnosticBackgroundModel = measurements[0]?.backgroundModel ?? backgroundModel;
          const diagnostics = buildBackgroundVisualDiagnostics(
            imageData,
            exportWells,
            geometry,
            diagnosticBackgroundModel,
            exportFloorGeometryAvailable ? exportFloorCircles ?? undefined : undefined,
            sharedGeometryExclusionRadiiByWell,
          );
          backgroundVisualDiagnostics = diagnostics;
          const backgroundMaskCanvas = buildBackgroundMaskDiagnosticCanvas(imageData, exportWells, diagnostics, geometry);

          addZipBlob(
            files,
            `${pythonRawDataDetailsPrefix}_BG_STAT_MASK.png`,
            await canvasToPngBlob(backgroundMaskCanvas),
          );
        }
      }

      addZipBlob(
        files,
        `${pythonResultsPrefix}_REPORT.xlsx`,
        await createPythonReportWorkbookBlob({
          imageBase: pythonResultsBase,
          imageName,
          imageQcInfo,
          unitLabel: plateMapUnit,
          selectedChannel: bestChannel,
          generatedAt: new Date().toISOString(),
          measurements,
          displayMeasurements,
          plateMap,
          calibrationFits: effectiveCalibrationFits,
          standardAdditionFits: standardAdditionFitsWithSlopeContext,
          unknownResults,
          expectedRefs,
          rankings,
          methodMetadata: currentMethodMetadata,
          geometryName,
          geometrySource: currentMethodMetadata.geometrySource ?? 'unknown',
          floorGeometryAvailable: sharedGeometryOverride ? effectiveFloorGeometryAvailable : floorGeometryAvailable,
          correctionApplied: lowSignalCorrectionEffective,
          lowSignalCorrections: activeLowSignalCorrections,
          correctionApplications: correctedMeasurementSet.applications,
          sharedGeometryOverride,
          storedCalibration,
        }),
      );
      addZipBlob(
        files,
        `${pythonRawDataDetailsPrefix}_DIAGNOSTICS.xlsx`,
        await createPythonDiagnosticsWorkbookBlob({
          imageBase: pythonResultsBase,
          imageName,
          unitLabel: plateMapUnit,
          selectedChannel: bestChannel,
          generatedAt: new Date().toISOString(),
          measurements,
          displayMeasurements,
          plateMap,
          calibrationFits: effectiveCalibrationFits,
          standardAdditionFits: standardAdditionFitsWithSlopeContext,
          unknownResults,
          expectedRefs,
          rankings,
          methodMetadata: currentMethodMetadata,
          geometryName,
          geometrySource: currentMethodMetadata.geometrySource ?? 'unknown',
          floorGeometryAvailable: sharedGeometryOverride ? effectiveFloorGeometryAvailable : floorGeometryAvailable,
          correctionApplied: lowSignalCorrectionEffective,
          lowSignalCorrections: activeLowSignalCorrections,
          correctionApplications: correctedMeasurementSet.applications,
          sharedGeometryOverride,
          wells: sharedGeometryOverride ? effectiveWells : wells,
          geometry,
          backgroundDiagnostics: backgroundVisualDiagnostics,
          radiusFactor,
          floorRoiRadiusFactor,
          floorCircles: (sharedGeometryOverride ? effectiveFloorGeometryAvailable : floorGeometryAvailable)
            ? sharedGeometryOverride ? effectiveFloorCircles : floorCircles
            : null,
          storedCalibration,
        }),
      );
      addZipBlob(
        files,
        `${pythonRawDataDetailsPrefix}_WEB_BG_MODEL_PROOF.xlsx`,
        await createWebBgModelProofWorkbookBlob({
          imageBase: pythonResultsBase,
          imageName,
          unitLabel: plateMapUnit,
          selectedChannel: bestChannel,
          generatedAt: new Date().toISOString(),
          measurements,
          displayMeasurements,
          plateMap,
          calibrationFits: effectiveCalibrationFits,
          standardAdditionFits: standardAdditionFitsWithSlopeContext,
          unknownResults,
          expectedRefs,
          rankings,
          methodMetadata: currentMethodMetadata,
          geometryName,
          geometrySource: currentMethodMetadata.geometrySource ?? 'unknown',
          floorGeometryAvailable: sharedGeometryOverride ? effectiveFloorGeometryAvailable : floorGeometryAvailable,
          correctionApplied: lowSignalCorrectionEffective,
          lowSignalCorrections: activeLowSignalCorrections,
          correctionApplications: correctedMeasurementSet.applications,
          sharedGeometryOverride,
          wells: sharedGeometryOverride ? effectiveWells : wells,
          geometry,
          backgroundDiagnostics: backgroundVisualDiagnostics,
          radiusFactor,
          floorRoiRadiusFactor,
          floorCircles: (sharedGeometryOverride ? effectiveFloorGeometryAvailable : floorGeometryAvailable)
            ? sharedGeometryOverride ? effectiveFloorCircles : floorCircles
            : null,
          storedCalibration,
        }),
      );
      if (measurements.length > 0 && pythonPlateOverlayCanvas) {
        addZipBlob(
          files,
          `${pythonRawDataDetailsPrefix}_FIGURE_CIELAB_DELTAE.png`,
          await canvasToPngBlob(buildPythonStyleCielabDeltaECanvas(
            pythonResultsBase,
            pythonPlateOverlayCanvas,
            measurements,
            plateMap,
            plateMapUnit,
            expectedRefs,
            storedCalibration?.cielabReference,
          )),
        );
      }
      if (methodComparisonRows.length > 0) {
        addZipBlob(
          files,
          `${pythonRawDataDetailsPrefix}_METHOD_COMPARISON.png`,
          await canvasToPngBlob(buildPythonStyleMethodComparisonCanvas(
            pythonResultsBase,
            methodComparisonRows,
            expectedRefs,
            plateMapUnit,
          )),
        );
      }

      addTextFile(
        `${pythonResultsPrefix}_RESULTS_CAPTION.txt`,
        createPythonResultsCaptionText(pythonResultsBase, plateMapUnit, expectedRefs),
        'text/plain;charset=utf-8',
      );
      addTextFile(
        `${pythonRawDataDetailsPrefix}_RAW_DATA_DETAILS_CAPTION.txt`,
        createPythonRawDataDetailsCaptionText(pythonResultsBase, plateMapUnit),
        'text/plain;charset=utf-8',
      );

      const analysisRunConfigMetadata = createAnalysisRunConfigMetadata({
        imageName,
        geometryName,
        geometrySource: currentMethodMetadata.geometrySource ?? 'unknown',
        roiMode: currentMethodMetadata.roiMode,
        roiPixelStatisticsMode: currentMethodMetadata.roiPixelStatisticsMode,
        backgroundModel,
        radiusFactor,
        floorRoiRadiusFactor,
        floorGeometryAvailable: sharedGeometryOverride ? effectiveFloorGeometryAvailable : floorGeometryAvailable,
        floorCircles: (sharedGeometryOverride ? effectiveFloorGeometryAvailable : floorGeometryAvailable)
          ? sharedGeometryOverride ? effectiveFloorCircles : floorCircles
          : null,
        geometry,
        wells: sharedGeometryOverride ? effectiveWells : wells,
        plateMap,
        plateMapUnit,
        expectedRefs,
        storedCalibration,
        sharedGeometryOverride,
        appVersion: packageJson.version,
        generatedAt: new Date().toISOString(),
      });
      addTextFile(
        `${pythonRawDataDetailsPrefix}_analysis_run_config.json`,
        JSON.stringify(analysisRunConfigMetadata, null, 2),
        'application/json;charset=utf-8',
      );

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const zipBlob = await createZipBlob(files);

      downloadBlob(zipBlob, `dqcolorimetry_analysis_package_${timestamp}.zip`);
      setStatusMessage('Analysis package exported.');
      setError(null);
    } catch (packageError) {
      const detail = packageError instanceof Error ? packageError.message : 'Unknown package export error.';
      setError(`Could not export analysis package. ${detail}`);
    }
  }, [
    backgroundModel,
    calibrationFits,
    correctedMeasurementSet.measurements,
    currentMethodMetadata,
    effectiveFloorCircles,
    effectiveFloorGeometryAvailable,
    effectiveWells,
    floorCircles,
    floorGeometryAvailable,
    floorRoiRadiusFactor,
    geometry,
    geometryName,
    image,
    imageName,
    lowSignalCorrectionEffective,
    measurements,
    plateMap,
    plateMapUnit,
    expectedRefs,
    radiusFactor,
    sharedGeometryExclusionRadiiByWell,
    sharedGeometryOverride,
    storedCalibration,
    standardAdditionFitsWithSlopeContext,
    unknownResults,
    wells,
  ]);

  const handleRunCompleteValidatedAnalysis = useCallback(async () => {
    if (isRunningCompleteAnalysis || isExtractingRef.current || isFittingRef.current) {
      return;
    }

    if (projectImageMismatchBlocksExtraction) {
      setError('Load the matching project image before running complete analysis.');
      return;
    }

    if (!image || wells.length !== 96) {
      setError('Load an image and a 96-well geometry before running complete analysis.');
      return;
    }

    if (configuredWellCount === 0) {
      setError('Load or edit a plate map before running complete analysis.');
      return;
    }

    const validatedRoiMode: 'simple' | 'floor-aware' | 'mouth-floor-intersection' = 'mouth-floor-intersection';
    const validatedRoiPixelStatisticsMode: RoiPixelStatisticsMode = 'robust-trimmed-v1';
    const validatedBackgroundModel: BackgroundModel = 'physical-interwell-polynomial-v1';
    const validatedUseLowSignalCorrection = lowSignalCorrectionContextAvailable;

    setIsRunningCompleteAnalysis(true);
    setPendingCompleteAnalysisFitting(false);
    setPendingCompleteAnalysisPackageExport(false);
    setStatusMessage('Starting analysis...');
    setError(null);

    try {
      setRoiMode(validatedRoiMode);
      setRoiPixelStatisticsMode(validatedRoiPixelStatisticsMode);
      setBackgroundModel(validatedBackgroundModel);
      setUseLowSignalCorrection(validatedUseLowSignalCorrection);
      setLowSignalCorrectionTouched(true);
      clearMeasurementsAndFits();

      const extractionSucceeded = await runExtractionRoutine({
        roiMode: validatedRoiMode,
        roiPixelStatisticsMode: validatedRoiPixelStatisticsMode,
        backgroundModel: validatedBackgroundModel,
      });

      if (!extractionSucceeded) {
        setIsRunningCompleteAnalysis(false);
        return;
      }

      setStatusMessage('Analysis waiting for extracted measurements...');
      setPendingCompleteAnalysisFitting(true);
    } catch {
      setStatusMessage('Analysis failed');
      setIsRunningCompleteAnalysis(false);
      setPendingCompleteAnalysisFitting(false);
      setPendingCompleteAnalysisPackageExport(false);
    }
  }, [
    clearMeasurementsAndFits,
    configuredWellCount,
    image,
    isRunningCompleteAnalysis,
    lowSignalCorrectionContextAvailable,
    projectImageMismatchBlocksExtraction,
    runExtractionRoutine,
    wells.length,
  ]);

  useEffect(() => {
    if (!pendingCompleteAnalysisFitting) {
      return;
    }

    if (measurements.length === 0) {
      return;
    }

    setPendingCompleteAnalysisFitting(false);
    setStatusMessage('Analysis fitting...');

    void runFittingRoutine({ useLowSignalCorrection }).then((fittingSucceeded) => {
      if (!fittingSucceeded) {
        setIsRunningCompleteAnalysis(false);
        setPendingCompleteAnalysisPackageExport(false);
        return;
      }

      setStatusMessage('Analysis waiting for fitting results...');
      setPendingCompleteAnalysisPackageExport(true);
    });
  }, [
    measurements.length,
    pendingCompleteAnalysisFitting,
    runFittingRoutine,
    useLowSignalCorrection,
  ]);

  useEffect(() => {
    if (!pendingCompleteAnalysisPackageExport) {
      return;
    }

    if (calibrationFits.length === 0 && standardAdditionFitsWithSlopeContext.length === 0) {
      return;
    }

    setPendingCompleteAnalysisPackageExport(false);
    setStatusMessage('Analysis package exporting...');

    void handleExportCompleteAnalysisPackage().finally(() => {
      setIsRunningCompleteAnalysis(false);
    });
  }, [
    calibrationFits.length,
    handleExportCompleteAnalysisPackage,
    pendingCompleteAnalysisPackageExport,
    standardAdditionFitsWithSlopeContext.length,
  ]);

  return (
    <main className="app-shell">
      <aside className="control-panel">
        <header className="app-header">
          <div className="header-title-row">
            <div>
              <p className="eyebrow">BETA</p>
              <h1>TIPICA</h1>
            </div>
            <button
              type="button"
              className="secondary-button header-help-button"
              onClick={() => setIsHelpAboutOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={isHelpAboutOpen}
            >
              Help / About
            </button>
          </div>
          <p className="header-note">Tool for Image-based Plate-Integrated Colorimetric Analysis</p>
        </header>

        {SHOW_PUBLIC_PROJECT_CONTROLS ? <section className="control-section" aria-labelledby="project-heading">
          <h2 id="project-heading">Project</h2>
          <button
            type="button"
            className="primary-button"
            disabled={!geometry}
            onClick={handleExportProjectJson}
          >
            Save project JSON
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={handleLoadProjectClick}
          >
            Load project JSON
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={handleClearProject}
          >
            Clear project
          </button>
          <input
            ref={projectFileInputRef}
            className="visually-hidden"
            type="file"
            accept="application/json,.json"
            onChange={handleProjectFileChange}
          />
          <p className="file-name">
            {projectLoadedInfo
              ? `Project loaded from ${projectLoadedInfo.createdAt}`
              : 'No project loaded'}
          </p>
          {projectLoadedInfo ? (
            <dl className="status-list compact-status-list">
              <div>
                <dt>Project image</dt>
                <dd>{projectLoadedInfo.imageName ?? 'Unknown'}</dd>
              </div>
              <div>
                <dt>Current image</dt>
                <dd>{imageName ?? 'None loaded'}</dd>
              </div>
              <div>
                <dt>Last extraction</dt>
                <dd>{projectLoadedInfo.lastExtractionSummary}</dd>
              </div>
              <div>
                <dt>Last fitting</dt>
                <dd>{projectLoadedInfo.lastFittingSummary}</dd>
              </div>
              <div>
                <dt>Method metadata</dt>
                <dd>{projectLoadedInfo.hasMethodMetadata ? 'Available' : 'Limited / missing'}</dd>
              </div>
              {projectLoadedInfo.hasMethodMetadata ? (
                <>
                  <div>
                    <dt>Saved ROI mode</dt>
                    <dd>{savedProjectRoiModeLabel}</dd>
                  </div>
                  <div>
                    <dt>Saved ROI stats</dt>
                    <dd>{savedProjectRoiStatsLabel}</dd>
                  </div>
                  <div>
                    <dt>Saved background</dt>
                    <dd>{savedProjectBackgroundModelLabel}</dd>
                  </div>
                  <div>
                    <dt>Saved correction</dt>
                    <dd>{savedProjectCorrectionLabel}</dd>
                  </div>
                </>
              ) : null}
              <div>
                <dt>Current method</dt>
                <dd>{`${formatRoiMode(roiMode)} / ${formatRoiPixelStatisticsMode(roiPixelStatisticsMode)} / ${formatBackgroundModel(backgroundModel)} / ${useLowSignalCorrection ? 'low-signal correction on' : 'low-signal correction off'}`}</dd>
              </div>
            </dl>
          ) : null}
          {projectLoadWarning ? <p className="panel-note">{projectLoadWarning}</p> : null}
          {loadedProjectMethodMetadataMismatch ? <p className="panel-note">Current method settings differ from the loaded project metadata.</p> : null}
        </section> : null}

        <ImageGeometryLoader
          imageName={imageName}
          geometryName={geometryName}
          showGeometryUpload={SHOW_PUBLIC_GEOMETRY_JSON_UPLOAD}
          onImageLoaded={(loadedImage, fileName) => {
            setImage(loadedImage);
            setImageName(fileName);
            clearMeasurementsAndFits();
            setError(null);
          }}
          onGeometryLoaded={(loadedGeometry, fileName) => {
            const loadedHasFloorGeometry = hasFloorGeometry(loadedGeometry);
            const hadFloorGeometry = Boolean(geometry && hasFloorGeometry(geometry));
            const reconciledGeometry = reconcileLoadedGeometryFloor(
              loadedGeometry,
              loadedHasFloorGeometry ? 'json' : 'none',
              geometry,
              floorGeometrySource,
            );

            setGeometry(reconciledGeometry.geometry);
            setGeometryName(fileName);
            setGeometrySource('json');
            // Once a project is loaded, its saved analysis ROI factor stays authoritative;
            // otherwise loading geometry after a project could change extraction math.
            if (!projectLoadedInfo && reconciledGeometry.geometry.roi_radius_factor) {
              setRadiusFactor(reconciledGeometry.geometry.roi_radius_factor);
            }
            if (reconciledGeometry.geometry.mouth_radius_px) {
              setManualMouthRadiusPx(clampManualMouthRadiusPx(reconciledGeometry.geometry.mouth_radius_px));
            }
            setFloorGeometrySource(reconciledGeometry.floorGeometrySource);
            setFloorGeometryNotice(loadedHasFloorGeometry
              ? null
              : reconciledGeometry.preservedCurrentFloorGeometry
                ? 'Geometry JSON did not include floor circles; preserved compatible floor circles already loaded.'
                : hadFloorGeometry
                  ? 'Loaded mouth/corner geometry does not include floor circles; existing floor circles were not preserved because the mouth/corner geometry differs.'
                  : null);
            setManualPickingActive(false);
            setManualPoints([]);
            setFloorCirclePickingActive(false);
            setManualFloorCircles([]);
            setManualFloorCirclePreviewCenter(null);
            setManualFloorCircleRadiusDelta(0);
            clearMeasurementsAndFits();
            setError(null);
          }}
          onError={setError}
        />

        <section className="control-section" aria-labelledby="geometry-heading">
          <h2 id="geometry-heading">Geometry</h2>
          <div className="geometry-subsection">
            <h3>Mouth/corner geometry</h3>
            <button
              type="button"
              className="primary-button"
              disabled={!image}
              onClick={handleStartManualPicking}
            >
              Pick 4 mouth/corner circles manually
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={manualPoints.length === 0}
              onClick={handleUndoManualPoint}
            >
              Undo last mouth point
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={manualPoints.length === 0 && !manualPickingActive}
              onClick={handleResetManualPoints}
            >
              Reset mouth geometry
            </button>
            <p className="file-name">{manualStatus}</p>
            <p className="panel-note">{manualMouthRadiusStatus}</p>
          </div>

          <div className="geometry-subsection">
            <h3>Floor-circle geometry</h3>
            <button
              type="button"
              className="primary-button"
              disabled={!image || !geometry}
              onClick={handleStartFloorCirclePicking}
            >
              Pick 4 floor circles manually
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={!floorGeometryAvailable && manualFloorCircles.length === 0 && !floorCirclePickingActive}
              onClick={handleResetFloorCircles}
            >
              Reset floor circles
            </button>
            <p className="file-name">{floorCircleStatus}</p>
          </div>

          <dl className="status-list compact-status-list">
            <div>
              <dt>Floor geometry</dt>
              <dd>{floorGeometryAvailable ? 'Available' : 'Missing'}</dd>
            </div>
            <div>
              <dt>Floor geometry source</dt>
              <dd>{floorGeometrySourceLabel}</dd>
            </div>
            <div>
              <dt>Corner mismatch A1 / A12 / H12 / H1</dt>
              <dd>
                {geometryAlignmentDiagnostics
                  ? `${formatFitCell(geometryAlignmentDiagnostics.a1MismatchPx)} / ${formatFitCell(geometryAlignmentDiagnostics.a12MismatchPx)} / ${formatFitCell(geometryAlignmentDiagnostics.h12MismatchPx)} / ${formatFitCell(geometryAlignmentDiagnostics.h1MismatchPx)} px`
                  : MISSING_VALUE}
              </dd>
            </div>
          </dl>
          {geometryAlignmentDiagnostics?.warning ? <p className="panel-note">{geometryAlignmentDiagnostics.warning}</p> : null}
          {floorGeometryNotice ? <p className="panel-note">{floorGeometryNotice}</p> : null}
          {SHOW_PUBLIC_GEOMETRY_DEVELOPER_CONTROLS ? <button
            type="button"
            className="secondary-button"
            onClick={handleExportGeometryJson}
          >
            Export complete geometry JSON
          </button> : null}
          {SHOW_PUBLIC_GEOMETRY_DEVELOPER_CONTROLS ? <details className="geometry-subsection">
            <summary>Developer diagnostic: shared geometry override</summary>
            <button
              type="button"
              className="secondary-button"
              onClick={handleLoadSharedGeometryOverrideClick}
            >
              Load Python canonical geometry JSON
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={!sharedGeometryOverride}
              onClick={handleClearSharedGeometryOverride}
            >
              Clear Python geometry override
            </button>
            <input
              ref={sharedGeometryFileInputRef}
              className="visually-hidden"
              type="file"
              accept="application/json,.json"
              onChange={handleSharedGeometryOverrideFileChange}
            />
            <dl className="status-list compact-status-list">
              <div>
                <dt>Override</dt>
                <dd>{sharedGeometryOverride ? 'Python canonical geometry override active' : 'No override active'}</dd>
              </div>
              <div>
                <dt>Override wells</dt>
                <dd>{sharedGeometryOverride ? `${sharedGeometryOverride.wellCount} wells` : MISSING_VALUE}</dd>
              </div>
              <div>
                <dt>Override source</dt>
                <dd>{sharedGeometryOverride?.sourceName ?? MISSING_VALUE}</dd>
              </div>
            </dl>
            <p className="panel-note">{sharedGeometryOverrideStatus}</p>
          </details> : null}
        </section>

        <section className="control-section" aria-labelledby="complete-workflow-heading">
          <h2 id="complete-workflow-heading">Analysis</h2>
          <button
            type="button"
            className="primary-button"
            disabled={!overlayReady || configuredWellCount === 0 || isExtracting || isFitting || isRunningCompleteAnalysis || projectImageMismatchBlocksExtraction}
            onClick={handleRunCompleteValidatedAnalysis}
          >
            {isRunningCompleteAnalysis ? 'Running TIPICA analysis...' : 'Run TIPICA analysis'}
          </button>
        </section>

        <section className="control-section" aria-labelledby="stored-calibration-heading">
          <h2 id="stored-calibration-heading">Stored calibration</h2>
          <button
            type="button"
            className="primary-button"
            disabled={!canSaveStoredCalibration}
            onClick={handleSaveStoredCalibration}
          >
            Save current calibration JSON
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={handleLoadStoredCalibrationClick}
          >
            Load stored calibration JSON
          </button>
          <input
            ref={storedCalibrationFileInputRef}
            className="visually-hidden"
            type="file"
            accept="application/json,.json"
            onChange={handleStoredCalibrationFileChange}
          />
          <button
            type="button"
            className="secondary-button"
            disabled={!storedCalibration}
            onClick={handleClearStoredCalibration}
          >
            Clear stored calibration
          </button>
          <p className="file-name">
            {storedCalibration ? 'Loaded' : 'Not loaded'}
          </p>
          <dl className="status-list compact-status-list">
            <div>
              <dt>Source</dt>
              <dd>{storedCalibration?.sourceName ?? MISSING_VALUE}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{storedCalibration?.createdAt ?? MISSING_VALUE}</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>{storedCalibration?.version ?? MISSING_VALUE}</dd>
            </div>
            <div>
              <dt>Channels</dt>
              <dd>{storedCalibrationChannels}</dd>
            </div>
            <div>
              <dt>Method metadata</dt>
              <dd>{storedCalibration?.methodMetadata ? 'Available' : storedCalibration ? 'Limited' : MISSING_VALUE}</dd>
            </div>
          </dl>
          {storedCalibrationMetadataWarning ? <p className="panel-note">{storedCalibrationMetadataWarning}</p> : null}
        </section>

        <details className="control-section compact-status-section">
          <summary id="status-heading">
            <span>Status - {compactStatusSummary}</span>
          </summary>
          <dl className="status-list">
            <div>
              <dt>Image</dt>
              <dd>{image ? 'Loaded' : 'Waiting'}</dd>
            </div>
            <div>
              <dt>Geometry</dt>
              <dd>{wells.length === 96 ? 'Ready' : 'Waiting'}</dd>
            </div>
            <div>
              <dt>Map</dt>
              <dd>{configuredWellCount > 0 ? 'Configured' : 'Waiting'}</dd>
            </div>
            <div>
              <dt>Analysis</dt>
              <dd>{analysisStatusLabel}</dd>
            </div>
            <div>
              <dt>Results</dt>
              <dd>{measurements.length > 0 ? 'Available' : 'Waiting'}</dd>
            </div>
          </dl>
          {error ? <p className="error-message">{error}</p> : null}
        </details>

      </aside>

      <section className="canvas-panel" aria-label="Plate canvas">
        <PlateCanvas
          image={image}
          wells={wells}
          radiusFactor={radiusFactor}
          onCanvasSizeChange={handleCanvasSizeChange}
          manualPoints={manualPoints}
          manualPickingActive={manualPickingActive}
          manualMouthRadiusPx={manualMouthRadiusPx}
          onManualPointPick={handleManualPointPick}
          onManualMouthRadiusAdjust={handleManualMouthRadiusAdjust}
          floorCirclePickingActive={floorCirclePickingActive}
          manualFloorCircles={manualFloorCircles}
          manualFloorCirclePreview={manualFloorCirclePreview}
          referenceFloorCircles={referenceFloorCircles}
          onFloorCirclePointerMove={handleFloorCirclePointerMove}
          onFloorCirclePointPick={handleFloorCirclePointPick}
          onFloorCircleRadiusAdjust={handleFloorCircleRadiusAdjust}
          showMouthGrid={showMouthGrid}
          showFloorCircles={showFloorCircles}
          floorCircles={floorCircles}
        />
        <PlateMapEditor
          plateMap={plateMap}
          unitLabel={plateMapUnit}
          expectedRefs={expectedRefs}
          editorSnapshot={plateEditorSnapshot}
          storedCalibrationLoaded={Boolean(storedCalibration)}
          onChange={handlePlateMapChange}
          onClear={handleClearPlateMap}
          onExpectedRefsChange={setExpectedRefs}
          onUnitLabelChange={setPlateMapUnit}
          onEditorSnapshotChange={setPlateEditorSnapshot}
        />
        <ResultSection
          title="Stored Calibration"
          summary={storedCalibration ? `${storedCalibration.fits.length} channels loaded` : 'No stored calibration loaded'}
          hasData={Boolean(storedCalibration)}
        >
          {storedCalibration ? <StoredCalibrationTable calibration={storedCalibration} /> : null}
        </ResultSection>
        <ResultSection
          title="Calibration Fits"
          summary={calibrationFits.length > 0 ? `${calibrationFits.length} fits` : 'No calibration fits yet'}
          hasData={calibrationFits.length > 0}
        >
          <CalibrationFitTable fits={calibrationFits} />
        </ResultSection>
        <ResultSection
          title="Standard Addition Fits"
          summary={standardAdditionFitsWithSlopeContext.length > 0 ? `${standardAdditionFitsWithSlopeContext.length} fits` : 'No standard-addition fits yet'}
          hasData={standardAdditionFitsWithSlopeContext.length > 0}
          note="For plates with internal calibration wells, Internal slope agreement is populated. Stored slope agreement and stored-calibration corrected concentration are populated only when an external stored calibration JSON is loaded."
        >
          <StandardAdditionFitTable fits={standardAdditionFitsWithSlopeContext} />
        </ResultSection>
        <ResultSection
          title="Unknown Results"
          summary={unknownResults.length > 0 ? `${unknownResults.length} rows` : 'No unknown results from stored calibration'}
          hasData={unknownResults.length > 0}
        >
          <UnknownResultsTable results={unknownResults} />
        </ResultSection>
        <ResultSection
          title="RGB/PAbs Results"
          summary={measurements.length > 0 ? `${measurements.length} wells` : 'No RGB/PAbs results yet'}
          hasData={measurements.length > 0}
        >
          <ResultsTable
            measurements={measurements}
            correctedMeasurements={correctedMeasurementSet.measurements}
            correctionApplied={lowSignalCorrectionEffective}
          />
        </ResultSection>
      </section>
      {isHelpAboutOpen ? <HelpAboutDialog onClose={() => setIsHelpAboutOpen(false)} /> : null}
    </main>
  );
}

export default App;
