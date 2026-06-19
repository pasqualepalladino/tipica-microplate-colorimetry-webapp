import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { ImageGeometryLoader } from './components/ImageGeometryLoader';
import { PlateCanvas } from './components/PlateCanvas';
import { PlateMapEditor } from './components/PlateMapEditor';
import packageJson from '../package.json';
import {
  calibrationFitsToCsv,
  standardAdditionFitsToCsv,
  unknownResultsToCsv,
  wellMeasurementsToCsv,
} from './core/exportCsv';
import { fitCalibration, fitStandardAddition } from './core/fitting';
import {
  addCorrectionMetadataToCalibrationFits,
  addCorrectionMetadataToStandardAdditionFits,
  applyRgbLowSignalCorrections,
  computeRgbLowSignalCorrections,
} from './core/lowSignalCorrection';
import { computePAbs } from './core/pabs';
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
import type { ExpectedRef } from './core/plateConfigurator';
import { estimateLocalBackground, sampleCircularRoi, sampleCircleIntersectionRoi } from './core/sampling';
import {
  backgroundCellDiagnosticsToCsv,
  buildBackgroundVisualDiagnostics,
  estimateBackground,
  estimatePhysicalInterwellPolynomialBackgrounds,
  type BackgroundEstimateWithModel,
  type BackgroundVisualDiagnostics,
  type BackgroundModel,
} from './core/backgroundModels';
import {
  addCalibrationSlopeContextToStandardAddition,
  canCreateStoredCalibration,
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

function createReferenceValuesDiagnosticPayload(expectedRefs: ExpectedRef[]) {
  return {
    schemaVersion: 1,
    purpose: 'Diagnostic export of expected reference values used by the plate configurator. These values are not used to change fitted concentrations in this export.',
    expectedRefs: expectedRefs.map((ref) => ({
      refId: ref.refId,
      label: ref.label,
      value: ref.value,
      sd: ref.sd ?? null,
    })),
  };
}

interface ExportManifestFileEntry {
  path: string;
  kind: string;
  mediaType: string;
  required: boolean;
  condition?: string;
}

function createExportManifestPayload(generatedAt: string, files: ExportManifestFileEntry[]) {
  return {
    schemaVersion: 1,
    exportType: 'complete_analysis_zip',
    generatedAt,
    application: {
      name: 'TIPICA',
      stage: 'beta',
    },
    files,
    notes: [
      'This manifest describes files generated by the browser ZIP export.',
      'It does not change calculations or fitted concentrations.',
    ],
  };
}

function createAnalysisReportPayload({
  generatedAt,
  imageName,
  roiMode,
  backgroundModel,
  wellsDetected,
  measurements,
  plateMapEntries,
  expectedReferenceValues,
  calibrationFits,
  standardAdditionFits,
  unknownResults,
  files,
}: {
  generatedAt: string;
  imageName: string | null;
  roiMode: RoiMode;
  backgroundModel: BackgroundModel;
  wellsDetected: number;
  measurements: number;
  plateMapEntries: number;
  expectedReferenceValues: number;
  calibrationFits: number;
  standardAdditionFits: number;
  unknownResults: number;
  files: ExportManifestFileEntry[];
}) {
  return {
    schemaVersion: 1,
    reportType: 'complete_analysis_report',
    generatedAt,
    application: {
      name: 'TIPICA',
      stage: 'beta',
    },
    summary: {
      imageName,
      roiMode,
      backgroundModel,
      wellsDetected,
      measurements,
      plateMapEntries,
      expectedReferenceValues,
      calibrationFits,
      standardAdditionFits,
      unknownResults,
    },
    outputs: {
      results: files
        .filter((file) => file.path.startsWith('results/'))
        .map((file) => file.path),
      diagnostics: files
        .filter((file) => file.path.startsWith('diagnostics/'))
        .map((file) => file.path),
    },
    notes: [
      'This report is informational and does not affect calculations.',
      'CSV files remain the authoritative quantitative outputs.',
    ],
  };
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

function drawMouthAndFloorDiagnosticCircles(
  ctx: CanvasRenderingContext2D,
  wells: WellCenter[],
  radiusFactor: number,
  floorCircles: FloorCircle[] | null,
): void {
  ctx.save();
  ctx.lineWidth = 1.5;

  wells.forEach((well) => {
    const radius = estimateRoiRadius(wells, well.row, well.col, radiusFactor);

    ctx.beginPath();
    ctx.arc(well.x, well.y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0, 150, 92, 0.9)';
    ctx.stroke();
  });

  if (floorCircles && floorCircles.length === wells.length) {
    floorCircles.forEach((circle) => {
      ctx.beginPath();
      ctx.arc(circle.x, circle.y, circle.r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 128, 0, 0.9)';
      ctx.stroke();
    });
  }

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

function buildRoiDiagnosticCanvas(
  imageData: ImageData,
  wells: WellCenter[],
  measurements: WellMeasurement[],
  radiusFactor: number,
  floorRoiRadiusFactor: number,
  floorCircles: FloorCircle[] | null,
  geometry: PlateGeometry | null,
): HTMLCanvasElement {
  const { canvas, ctx } = createDiagnosticCanvas(imageData);
  const measurementByWell = new Map(measurements.map((measurement) => [measurement.wellId, measurement]));

  wells.forEach((well) => {
    const measurement = measurementByWell.get(well.wellId);
    const mode = measurement?.roiMode ?? 'simple';
    const pixelStatisticsMode = measurement?.roiPixelStatisticsMode ?? 'simple-median';
    const floorCircle = floorCircles && floorCircles.length === wells.length
      ? floorCircles[well.row * 12 + well.col]
      : null;
    const mouthRadius = measurement?.mouthRadiusUsed && measurement.mouthRadiusUsed > 0
      ? measurement.mouthRadiusUsed
      : estimateRoiRadius(wells, well.row, well.col, radiusFactor);
    let sample;

    if (mode === 'mouth-floor-intersection' && floorCircle) {
      const floorRadius = measurement?.floorRadiusUsed && measurement.floorRadiusUsed > 0
        ? measurement.floorRadiusUsed
        : Math.max(1, floorCircle.r * floorRoiRadiusFactor);

      sample = sampleCircleIntersectionRoi(
        imageData,
        well.x,
        well.y,
        mouthRadius,
        floorCircle.x,
        floorCircle.y,
        floorRadius,
        { pixelStatisticsMode, includeDiagnosticPixels: true },
      );
    } else if (mode === 'floor-aware' && floorCircle) {
      const floorRadius = measurement?.floorRadiusUsed && measurement.floorRadiusUsed > 0
        ? measurement.floorRadiusUsed
        : Math.max(1, floorCircle.r * floorRoiRadiusFactor);

      sample = sampleCircularRoi(
        imageData,
        floorCircle.x,
        floorCircle.y,
        floorRadius,
        { pixelStatisticsMode, includeDiagnosticPixels: true },
      );
    } else {
      sample = sampleCircularRoi(
        imageData,
        well.x,
        well.y,
        mouthRadius,
        { pixelStatisticsMode, includeDiagnosticPixels: true },
      );
    }

    drawDiagnosticPixels(ctx, sample.roiFullPixelCoordinates, 'rgba(0, 128, 255, 0.18)');
    drawDiagnosticPixels(ctx, sample.roiCorePixelCoordinates, 'rgba(255, 190, 0, 0.28)');
    drawDiagnosticPixels(ctx, sample.roiUsedPixelCoordinates, 'rgba(0, 255, 120, 0.58)');
  });

  drawMouthAndFloorDiagnosticCircles(ctx, wells, radiusFactor, floorCircles);
  drawGeometryCornerDiagnosticMarkers(ctx, geometry, wells);
  drawCornerWellLabels(ctx, wells);
  drawDiagnosticLabel(ctx, 'ROI mask diagnostic: full blue, core amber, used green');

  return canvas;
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

function buildBackgroundCellRawMasksDiagnosticCanvas(
  imageData: ImageData,
  wells: WellCenter[],
  diagnostics: BackgroundVisualDiagnostics,
  geometry: PlateGeometry | null,
): HTMLCanvasElement {
  const { canvas, ctx } = createDiagnosticCanvas(imageData);
  const stride = Math.max(1, diagnostics.diagnostics.candidateStride);

  drawDiagnosticPixels(ctx, diagnostics.rawCandidatePixels, 'rgba(255, 255, 255, 0.76)', Math.max(1, Math.floor(stride / 2)));

  ctx.save();
  ctx.strokeStyle = 'rgba(0, 190, 255, 0.65)';
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  for (let row = 0; row < 7; row += 1) {
    for (let col = 0; col < 11; col += 1) {
      const topLeft = wells.find((well) => well.row === row && well.col === col);
      const topRight = wells.find((well) => well.row === row && well.col === col + 1);
      const bottomRight = wells.find((well) => well.row === row + 1 && well.col === col + 1);
      const bottomLeft = wells.find((well) => well.row === row + 1 && well.col === col);

      if (!topLeft || !topRight || !bottomRight || !bottomLeft) {
        continue;
      }

      ctx.beginPath();
      ctx.moveTo(topLeft.x, topLeft.y);
      ctx.lineTo(topRight.x, topRight.y);
      ctx.lineTo(bottomRight.x, bottomRight.y);
      ctx.lineTo(bottomLeft.x, bottomLeft.y);
      ctx.closePath();
      ctx.stroke();
    }
  }
  ctx.restore();

  ctx.save();
  ctx.fillStyle = 'rgba(255, 0, 255, 0.9)';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
  ctx.lineWidth = 1;
  wells.forEach((well) => {
    ctx.beginPath();
    ctx.arc(well.x, well.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });
  ctx.restore();

  drawCornerWellLabels(ctx, wells);
  drawGeometryCornerDiagnosticMarkers(ctx, geometry, wells);
  drawDiagnosticLabel(
    ctx,
    `Raw physical cell masks: raw pixels ${diagnostics.rawCandidatePixels.length}, refined candidates ${diagnostics.candidatePixels.length}`,
  );

  return canvas;
}

function buildBackgroundRgbMapDiagnosticCanvas(
  imageData: ImageData,
  wells: WellCenter[],
  diagnostics: BackgroundVisualDiagnostics,
  geometry: PlateGeometry | null,
): HTMLCanvasElement {
  const { canvas, ctx } = createDiagnosticCanvas(imageData);

  if (!diagnostics.predictedRgbMap || diagnostics.predictedRgbMap.length === 0) {
    drawDiagnosticLabel(ctx, 'Background RGB map unavailable for current background model');
    return canvas;
  }

  ctx.save();
  ctx.globalAlpha = 0.72;
  diagnostics.predictedRgbMap.forEach((cell) => {
    ctx.fillStyle = `rgb(${cell.rgb.r.toFixed(0)} ${cell.rgb.g.toFixed(0)} ${cell.rgb.b.toFixed(0)})`;
    ctx.fillRect(cell.x, cell.y, cell.size, cell.size);
  });
  ctx.restore();

  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.78)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.lineWidth = 1.5;
  wells.forEach((well) => {
    ctx.beginPath();
    ctx.arc(well.x, well.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });
  ctx.restore();

  drawCornerWellLabels(ctx, wells);
  drawGeometryCornerDiagnosticMarkers(ctx, geometry, wells);
  drawDiagnosticLabel(ctx, 'Predicted background RGB map');

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

type FitFigureSeries = {
  label: string;
  channel: FitChannel;
  slope: number;
  intercept: number;
  points: { x: number; y: number }[];
};

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
  yerr: number;
  n: number;
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

function addManifestedBlob(
  files: { name: string; blob: Blob }[],
  addManifestFile: (
    path: string,
    kind: string,
    mediaType: string,
    required: boolean,
    condition?: string,
  ) => void,
  name: string,
  blob: Blob,
  kind: string,
  required: boolean,
  condition?: string,
): void {
  files.push({ name, blob });
  addManifestFile(name, kind, blob.type || 'application/octet-stream', required, condition);
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
where I_well is the median intensity from the well ROI and I_BG is the local inter-well background predicted for that well. This is an image-derived pseudo-absorbance and is not assumed to be a spectrophotometric absorbance.

Fitting and quantification
Calibration and standard-addition fits use the current TIPICA webapp fitting results. Python desktop uses robust residual-based IRLS linear regression; web parity of the fitting implementation is tracked separately and no formulas are changed by this export. For standard addition, the original-sample concentration is C0 = DF x q/m, where y = m x + q and x is the added concentration.

Ranking score
For methods with both calibration and standard addition, the Python desktop global score is:
    GlobalScore = slope_agreement^2 x sqrt(R2_cal x R2_std) x (1/LOQ)
with slope_agreement = min(|m_cal|, |m_std|) / max(|m_cal|, |m_std|). This web export computes LOQ for PNG channel selection from the median calibration replicate SD when that SD is available, matching the Python RESULTS ranking rule. If LOQ is unavailable, the Python-compatible fallback uses the fit-only common factors. Robust IRLS fitting parity, full REPORT.xlsx parity and RAW_DATA_DETAILS parity are not complete yet. Expected/reference values, recovery, SNR and clipping are external checks and are not used to choose the ranked RGB method.

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
    const mode = measurement?.roiMode ?? 'simple';
    const mouthRadius = measurement?.mouthRadiusUsed && measurement.mouthRadiusUsed > 0
      ? measurement.mouthRadiusUsed
      : estimateRoiRadius(wells, well.row, well.col, radiusFactor);
    const floorCircle = floorCircles && floorCircles.length === wells.length
      ? floorCircles[well.row * 12 + well.col]
      : null;
    const floorRadius = floorCircle
      ? measurement?.floorRadiusUsed && measurement.floorRadiusUsed > 0
        ? measurement.floorRadiusUsed
        : Math.max(1, floorCircle.r * floorRoiRadiusFactor)
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

      if (mode === 'floor-aware' || mode === 'mouth-floor-intersection') {
        ctx.beginPath();
        ctx.arc(floorCircle.x, floorCircle.y, floorRadius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 230, 40, 0.10)';
        ctx.fill();
      }
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

function buildFitFigureCanvas(
  title: string,
  xLabel: string,
  yLabel: string,
  series: FitFigureSeries[],
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const width = 1200;
  const height = 760;
  const margin = { left: 88, right: 260, top: 74, bottom: 86 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const ctx = canvas.getContext('2d');

  canvas.width = width;
  canvas.height = height;

  if (!ctx) {
    throw new Error('Could not create fitting figure canvas.');
  }

  const xValues = series.flatMap((item) => item.points.map((point) => point.x));
  const xRange = finiteRange(xValues, 0, 1);
  const yValues = series.flatMap((item) => [
    ...item.points.map((point) => point.y),
    item.slope * xRange.min + item.intercept,
    item.slope * xRange.max + item.intercept,
  ]);
  const yRange = finiteRange(yValues, 0, 1);
  const xToPx = (x: number) => margin.left + ((x - xRange.min) / (xRange.max - xRange.min)) * plotWidth;
  const yToPx = (y: number) => margin.top + plotHeight - ((y - yRange.min) / (yRange.max - yRange.min)) * plotHeight;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#172026';
  ctx.font = '700 26px Inter, Arial, sans-serif';
  ctx.fillText(title, margin.left, 42);

  ctx.strokeStyle = '#d5dde0';
  ctx.lineWidth = 1;
  ctx.font = '13px Inter, Arial, sans-serif';
  ctx.fillStyle = '#4a5559';

  for (let tick = 0; tick <= 5; tick += 1) {
    const x = margin.left + (plotWidth * tick) / 5;
    const value = xRange.min + ((xRange.max - xRange.min) * tick) / 5;
    ctx.beginPath();
    ctx.moveTo(x, margin.top);
    ctx.lineTo(x, margin.top + plotHeight);
    ctx.stroke();
    ctx.fillText(formatFitCell(value), x - 18, margin.top + plotHeight + 24);
  }

  for (let tick = 0; tick <= 5; tick += 1) {
    const y = margin.top + plotHeight - (plotHeight * tick) / 5;
    const value = yRange.min + ((yRange.max - yRange.min) * tick) / 5;
    ctx.beginPath();
    ctx.moveTo(margin.left, y);
    ctx.lineTo(margin.left + plotWidth, y);
    ctx.stroke();
    ctx.fillText(formatFitCell(value), 12, y + 4);
  }

  ctx.strokeStyle = '#263238';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(margin.left, margin.top);
  ctx.lineTo(margin.left, margin.top + plotHeight);
  ctx.lineTo(margin.left + plotWidth, margin.top + plotHeight);
  ctx.stroke();

  ctx.fillStyle = '#263238';
  ctx.font = '700 15px Inter, Arial, sans-serif';
  ctx.fillText(xLabel, margin.left + plotWidth / 2 - 48, height - 28);
  ctx.save();
  ctx.translate(26, margin.top + plotHeight / 2 + 60);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();

  series.forEach((item) => {
    const color = FIT_CHANNEL_COLORS[item.channel];

    if (Number.isFinite(item.slope) && Number.isFinite(item.intercept)) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(xToPx(xRange.min), yToPx(item.slope * xRange.min + item.intercept));
      ctx.lineTo(xToPx(xRange.max), yToPx(item.slope * xRange.max + item.intercept));
      ctx.stroke();
    }

    ctx.fillStyle = color;
    item.points.forEach((point) => {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        return;
      }

      ctx.beginPath();
      ctx.arc(xToPx(point.x), yToPx(point.y), 4.5, 0, Math.PI * 2);
      ctx.fill();
    });
  });

  ctx.font = '13px Inter, Arial, sans-serif';
  series.slice(0, 24).forEach((item, index) => {
    const x = margin.left + plotWidth + 28;
    const y = margin.top + 22 + index * 24;

    ctx.fillStyle = FIT_CHANNEL_COLORS[item.channel];
    ctx.fillRect(x, y - 10, 14, 4);
    ctx.beginPath();
    ctx.arc(x + 7, y - 8, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#263238';
    ctx.fillText(item.label, x + 22, y - 4);
  });

  if (series.length > 24) {
    ctx.fillStyle = '#667176';
    ctx.fillText(`+ ${series.length - 24} more fits`, margin.left + plotWidth + 28, margin.top + 22 + 24 * 24);
  }

  return canvas;
}

function buildRgbCalibrationFitCanvas(
  fits: CalibrationFit[],
  measurements: WellMeasurement[],
  plateMap: WellConfig[],
): HTMLCanvasElement {
  const measurementByWell = new Map(measurements.map((measurement) => [measurement.wellId, measurement]));
  const calibrationWells = plateMap.filter((well) => (
    well.role === 'C' &&
    well.concentration !== null &&
    Number.isFinite(well.concentration)
  ));
  const series = fits.map((fit) => ({
    label: `${fit.channel}: y=${formatFitCell(fit.slope)}x+${formatFitCell(fit.intercept)}; R2=${formatFitCell(fit.r2)}`,
    channel: fit.channel,
    slope: fit.slope,
    intercept: fit.intercept,
    points: calibrationWells.flatMap((well) => {
      const measurement = measurementByWell.get(well.wellId);

      return measurement && well.concentration !== null
        ? [{ x: well.concentration, y: pabsChannelValue(measurement, fit.channel) }]
        : [];
    }),
  }));

  return buildFitFigureCanvas('RGB calibration fits', 'Concentration', 'PAbs', series);
}

function buildRgbStandardAdditionFitCanvas(fits: StandardAdditionFit[]): HTMLCanvasElement {
  const series = fits.map((fit) => {
    const xValues = fit.addedConcentrationsUsed ?? [];
    const yValues = fit.meanSignalValuesUsed ?? [];

    return {
      label: `${fit.sampleId} DF ${formatFitCell(fit.dilutionFactor)} ${fit.channel}: R2=${formatFitCell(fit.r2)}`,
      channel: fit.channel,
      slope: fit.slope,
      intercept: fit.intercept,
      points: xValues.flatMap((x, index) => {
        const y = yValues[index];
        return Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : [];
      }),
    };
  });

  return buildFitFigureCanvas('RGB standard-addition fits', 'Added concentration', 'PAbs', series);
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

function estimateSigmaForPythonResultsLoq(calibrationPoints: PythonResultsPlotPoint[]): { sigma: number; source: string } {
  const calibrationSdValues = calibrationPoints
    .map((point) => point.yerr)
    .filter((value) => Number.isFinite(value) && value > 0);
  const medianCalibrationSd = medianFinite(calibrationSdValues);

  if (Number.isFinite(medianCalibrationSd) && medianCalibrationSd > 0) {
    return { sigma: medianCalibrationSd, source: 'median_calibration_sd' };
  }

  const zeroSdValues = calibrationPoints
    .filter((point) => Math.abs(point.x) <= 1e-12)
    .map((point) => point.yerr)
    .filter((value) => Number.isFinite(value));
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
    const { sigma, source } = estimateSigmaForPythonResultsLoq(calibrationPoints);
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
    const lod = cal && Number.isFinite(sigma) && sigma > 0 && Number.isFinite(slope) && Math.abs(slope) > 1e-15
      ? (3 * sigma) / Math.abs(slope)
      : Number.NaN;
    const loq = cal && Number.isFinite(sigma) && sigma > 0 && Number.isFinite(slope) && Math.abs(slope) > 1e-15
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
): void {
  const color = monochrome ? '#111111' : FIT_CHANNEL_COLORS[channel];
  const margin = { left: 76, right: 20, top: 26, bottom: 56 };
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
      if (ref.refId && fit.sampleId && ref.refId !== fit.sampleId) {
        return [];
      }
      const x = ref.value / Math.max(fit.dilutionFactor, 1e-12);
      return Number.isFinite(x) ? [x] : [];
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
    ...calibrationPoints.map((point) => point.y),
    ...calibrationPoints.flatMap((point) => (
      Number.isFinite(point.yerr) && point.yerr > 0 ? [point.y - point.yerr, point.y + point.yerr] : []
    )),
    ...stdPoints.map((point) => point.y),
    ...stdPoints.flatMap((point) => (
      Number.isFinite(point.yerr) && point.yerr > 0 ? [point.y - point.yerr, point.y + point.yerr] : []
    )),
  ];
  const xRange = finiteRange(allX, 0, 1);
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
  const yRange = finiteRange([...allY, ...yFromFits], 0, 1);
  const xToPx = (value: number) => plot.x + ((value - xRange.min) / (xRange.max - xRange.min)) * plot.width;
  const yToPx = (value: number) => plot.y + plot.height - ((value - yRange.min) / (yRange.max - yRange.min)) * plot.height;

  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.strokeStyle = '#d6dedb';
  ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);

  ctx.fillStyle = '#1d2628';
  ctx.font = '700 18px Inter, Arial, sans-serif';
  ctx.fillText(channelDisplayName(channel), bounds.x + 12, bounds.y + 20);
  if (rankInfo) {
    const rankText = [
      `Score ${formatFitCell(rankInfo.score)}`,
      `R2cal ${formatFitCell(rankInfo.r2Cal)}`,
      `R2std ${formatFitCell(rankInfo.r2Std)}`,
      `LOQ ${formatFitCell(rankInfo.loq)}`,
    ].join('  ');
    ctx.font = '11px Inter, Arial, sans-serif';
    ctx.fillStyle = '#465255';
    ctx.fillText(rankText, plot.x + Math.max(0, plot.width - ctx.measureText(rankText).width - 4), bounds.y + 20);
  }

  ctx.strokeStyle = '#dce4e1';
  ctx.lineWidth = 1;
  ctx.font = '12px Inter, Arial, sans-serif';
  ctx.fillStyle = '#465255';
  for (let tick = 0; tick <= 4; tick += 1) {
    const tx = plot.x + (plot.width * tick) / 4;
    const ty = plot.y + (plot.height * tick) / 4;
    ctx.beginPath();
    ctx.moveTo(tx, plot.y);
    ctx.lineTo(tx, plot.y + plot.height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(plot.x, ty);
    ctx.lineTo(plot.x + plot.width, ty);
    ctx.stroke();
  }

  ctx.strokeStyle = '#2b3437';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(plot.x, plot.y, plot.width, plot.height);

  ctx.fillStyle = '#465255';
  ctx.font = '11px Inter, Arial, sans-serif';
  for (let tick = 0; tick <= 4; tick += 1) {
    const xValue = xRange.min + ((xRange.max - xRange.min) * tick) / 4;
    const yValue = yRange.min + ((yRange.max - yRange.min) * (4 - tick)) / 4;
    ctx.fillText(formatFitCell(xValue), plot.x + (plot.width * tick) / 4 - 14, plot.y + plot.height + 18);
    ctx.fillText(formatPAbsCell(yValue), bounds.x + 8, plot.y + (plot.height * tick) / 4 + 4);
  }

  ctx.fillStyle = '#263238';
  ctx.font = '700 12px Inter, Arial, sans-serif';
  ctx.fillText(`Added concentration (${unitLabel})`, plot.x + plot.width / 2 - 86, bounds.y + bounds.height - 14);
  ctx.save();
  ctx.translate(bounds.x + 18, plot.y + plot.height / 2 + 42);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(channelDisplayName(channel), 0, 0);
  ctx.restore();

  if (calibrationFit && Number.isFinite(calibrationFit.slope) && Number.isFinite(calibrationFit.intercept)) {
    ctx.save();
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(xToPx(xRange.min), yToPx(calibrationFit.slope * xRange.min + calibrationFit.intercept));
    ctx.lineTo(xToPx(xRange.max), yToPx(calibrationFit.slope * xRange.max + calibrationFit.intercept));
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
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  });

  standardGroups.forEach(({ fit, points }) => {

    if (Number.isFinite(fit.slope) && Number.isFinite(fit.intercept)) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.2;
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
      if (Number.isFinite(point.yerr) && point.yerr > 0) {
        drawVerticalErrorBar(ctx, px, yToPx(point.y - point.yerr), yToPx(point.y + point.yerr), 10, color);
      }

      ctx.fillStyle = color;
      ctx.fillRect(px - 4.5, py - 4.5, 9, 9);
    });

    expectedRefs.forEach((ref) => {
      if (ref.refId && fit.sampleId && ref.refId !== fit.sampleId) {
        return;
      }

      const x = ref.value / Math.max(fit.dilutionFactor, 1e-12);
      if (!Number.isFinite(x)) {
        return;
      }

      const px = xToPx(x);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#8a3ffc';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(px, plot.y);
      ctx.lineTo(px, plot.y + plot.height);
      ctx.stroke();
      ctx.restore();
    });
  });

  ctx.fillStyle = '#344044';
  ctx.font = '11px Inter, Arial, sans-serif';
  ctx.fillText('open circles: calibration, dashed fit', plot.x + 4, bounds.y + bounds.height - 36);
  ctx.fillText('filled squares: standard addition, solid fit', plot.x + 4, bounds.y + bounds.height - 22);
  if (expectedRefs.length > 0) {
    ctx.fillStyle = '#6d36c9';
    ctx.fillText('purple dashed: external reference check', plot.x + 248, bounds.y + bounds.height - 22);
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
  const summaryText = [
    `Mode: ${formatRoiMode(roiMode)}`,
    `Background: ${formatBackgroundModel(backgroundModel)}`,
    `Measurements: ${measurements.length} wells`,
    `Floor geometry: ${floorGeometryAvailable ? 'available' : 'missing'}`,
    `Selected display channel: ${channelDisplayName(bestChannel)}`,
    `Ranking formula: ${bestRank?.scoreFormula ?? 'unavailable'}`,
    `Sigma source: ${bestRank?.sigmaSource ?? 'unavailable'}`,
    '',
    'Calibration',
    calSummary,
    '',
    'Standard addition',
    stdSummary,
    'C0 = DF x q/m from current webapp fit results.',
    '',
    'Reference values',
    refSummary,
    '',
    'Method ranking',
    rankingSummary || 'No ranked RGB method.',
    '',
    'Notes',
    'PAbs = log10(I_BG / I_well).',
    'PNG channel ranking uses Python GlobalScore when LOQ is available.',
    'Robust IRLS fitting parity, REPORT.xlsx parity and RAW_DATA_DETAILS parity remain later work.',
  ].join('\n');

  ctx.fillStyle = '#253033';
  ctx.font = '23px Consolas, "Courier New", monospace';
  drawWrappedText(ctx, summaryText, 110, 812, 940, 34, height - 95);

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
            <li>Fitting uses robust residual-based IRLS linear regression; all finite points are retained.</li>
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
          <p>Citation, license, and version information will be finalized with the release documentation.</p>
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
    () => (geometry ? generate96WellFloorCircles(geometry) : null),
    [geometry],
  );
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
      geometrySource: formatFloorGeometrySource(floorGeometrySource, floorGeometryAvailable),
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
    },
  }), [backgroundModel, currentMethodMetadata, roiMode, roiPixelStatisticsMode, useLowSignalCorrection]);
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
  const compactStatusSummary = [
    image ? 'Image ready' : 'Image waiting',
    wells.length === 96 ? 'Geometry ready' : 'Geometry waiting',
    measurements.length > 0 ? 'Results ready' : 'Results waiting',
    error ? 'Error' : null,
  ].filter((item): item is string => item !== null).join(' · ');

  const clearFits = useCallback(() => {
    setCalibrationFits([]);
    setStandardAdditionFits([]);
  }, []);

  const clearMeasurementsAndFits = useCallback(() => {
    setMeasurements([]);
    setRoiStats(null);
    clearFits();
  }, [clearFits]);

  const handlePlateMapChange = useCallback((nextPlateMap: WellConfig[]) => {
    setPlateMap(nextPlateMap);
    clearFits();
  }, [clearFits]);

  const handleClearPlateMap = useCallback(() => {
    setPlateMap(createEmptyPlateMap());
    setPlateMapUnit('mM');
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
    clearMeasurementsAndFits();
    setError(null);
  }, [clearMeasurementsAndFits, floorGeometryAvailable, image, radiusFactor, wells]);

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
    }
  }, [clearMeasurementsAndFits, geometrySource, manualPoints]);

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
    }
  }, [clearMeasurementsAndFits, geometrySource]);

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
    clearMeasurementsAndFits();
    setError(null);
  }, [clearMeasurementsAndFits, geometry, image, wells.length]);

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
    }

    setError(null);
  }, [
    clearMeasurementsAndFits,
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
      clearMeasurementsAndFits();
    }
  }, [clearMeasurementsAndFits, geometry]);

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
  }, [backgroundModel, expectedRefs, extractionSummary, fittingSummary, floorGeometrySource, floorRoiRadiusFactor, geometry, image, imageName, plateMap, radiusFactor, roiMode, roiPixelStatisticsMode, storedCalibration, useLowSignalCorrection]);

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
    clearMeasurementsAndFits();
    setError(null);
  }, [clearMeasurementsAndFits]);

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
          const imageData = createAnalysisImageData(image, wells);
          const floorCirclesForBackground = floorGeometryAvailable && floorCircles && floorCircles.length === wells.length
            ? floorCircles
            : undefined;
          const precomputedPhysicalBackground = selectedBackgroundModel === 'physical-interwell-polynomial-v1'
            ? estimatePhysicalInterwellPolynomialBackgrounds(imageData, wells, floorCirclesForBackground)
            : null;
          const nextMeasurements = wells.map((well) => {
          const pitch = estimateLocalPitch(wells, well.row, well.col);
          let roiSample;
          let floorRadiusUsed = 0;
          let mouthRadiusUsed = 0;
          let roiModeUsed: 'simple' | 'floor-aware' | 'mouth-floor-intersection' = 'simple';
          const roiWarnings: string[] = [];

          if (selectedRoiMode === 'mouth-floor-intersection' && floorGeometryAvailable && floorCircles && floorCircles.length === wells.length) {
            const projectedFloorCircle = floorCircles[well.row * 12 + well.col];
            const floorRadius = Math.max(1, projectedFloorCircle.r * floorRoiRadiusFactor);
            const mouthRadius = estimateRoiRadius(wells, well.row, well.col, radiusFactor);
            floorRadiusUsed = floorRadius;
            mouthRadiusUsed = mouthRadius;
            roiModeUsed = 'mouth-floor-intersection';
            roiSample = sampleCircleIntersectionRoi(imageData, well.x, well.y, mouthRadius, projectedFloorCircle.x, projectedFloorCircle.y, floorRadius, { pixelStatisticsMode: selectedRoiPixelStatisticsMode });
          } else if (selectedRoiMode === 'floor-aware' && floorGeometryAvailable && floorCircles && floorCircles.length === wells.length) {
            const projectedFloorCircle = floorCircles[well.row * 12 + well.col];
            const radius = Math.max(1, projectedFloorCircle.r * floorRoiRadiusFactor);
            floorRadiusUsed = radius;
            roiModeUsed = 'floor-aware';
            roiSample = sampleCircularRoi(imageData, projectedFloorCircle.x, projectedFloorCircle.y, radius, { pixelStatisticsMode: selectedRoiPixelStatisticsMode });
          } else {
            if (selectedRoiMode === 'mouth-floor-intersection' || selectedRoiMode === 'floor-aware') {
              roiWarnings.push(`${selectedRoiMode === 'mouth-floor-intersection' ? 'Mouth-floor intersection' : 'Floor-aware'} ROI selected but floor geometry is unavailable; using simple center ROI instead.`);
            }
            const roiRadius = estimateRoiRadius(wells, well.row, well.col, radiusFactor);
            mouthRadiusUsed = roiRadius;
            roiSample = sampleCircularRoi(imageData, well.x, well.y, roiRadius, { pixelStatisticsMode: selectedRoiPixelStatisticsMode });
          }

          const backgroundCx = (selectedRoiMode === 'floor-aware' || selectedRoiMode === 'mouth-floor-intersection') && floorGeometryAvailable && floorCircles && floorCircles.length === wells.length
            ? floorCircles[well.row * 12 + well.col].x
            : well.x;
          const backgroundCy = (selectedRoiMode === 'floor-aware' || selectedRoiMode === 'mouth-floor-intersection') && floorGeometryAvailable && floorCircles && floorCircles.length === wells.length
            ? floorCircles[well.row * 12 + well.col].y
            : well.y;
          const backgroundRoiRadius = (selectedRoiMode === 'floor-aware' || selectedRoiMode === 'mouth-floor-intersection') && floorGeometryAvailable && floorCircles && floorCircles.length === wells.length
            ? floorRadiusUsed
            : estimateRoiRadius(wells, well.row, well.col, radiusFactor);
          let backgroundSample: BackgroundEstimateWithModel;

          if (selectedBackgroundModel === 'physical-interwell-polynomial-v1') {
            const physicalEstimate = precomputedPhysicalBackground?.estimatesByWell.get(well.wellId);

            if (physicalEstimate) {
              backgroundSample = physicalEstimate;
            } else {
              const fallback = estimateBackground(
                imageData,
                wells,
                geometry!,
                backgroundCx,
                backgroundCy,
                backgroundRoiRadius,
                pitch,
                'robust-interwell-v1',
                (selectedRoiMode === 'floor-aware' || selectedRoiMode === 'mouth-floor-intersection') && floorGeometryAvailable && floorCircles ? floorCircles : undefined,
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
              wells,
              geometry!,
              backgroundCx,
              backgroundCy,
              backgroundRoiRadius,
              pitch,
              selectedBackgroundModel,
              (selectedRoiMode === 'floor-aware' || selectedRoiMode === 'mouth-floor-intersection') && floorGeometryAvailable && floorCircles ? floorCircles : undefined,
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
            medianPitch: backgroundSample.medianPitch ?? 0,
            wellExclusionRadiusApprox: backgroundSample.wellExclusionRadiusApprox ?? 0,
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
            floorGeometryAvailable,
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
  }, [backgroundModel, clearFits, floorCircles, floorGeometryAvailable, floorRoiRadiusFactor, geometry, geometryAlignmentDiagnostics, image, projectImageMismatchBlocksExtraction, radiusFactor, roiMode, roiPixelStatisticsMode, wells]);

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
      const manifestFiles: ExportManifestFileEntry[] = [];
      const generatedAt = new Date().toISOString();
      const pythonResultsBase = safePythonResultsBaseName(imageName);
      const pythonResultsPrefix = `RESULTS/${pythonResultsBase}`;
      const addManifestFile = (
        path: string,
        kind: string,
        mediaType: string,
        required: boolean,
        condition?: string,
      ) => {
        manifestFiles.push({
          path,
          kind,
          mediaType,
          required,
          ...(condition ? { condition } : {}),
        });
      };
      const addTextFile = (
        name: string,
        text: string,
        type: string,
        kind: string,
        required: boolean,
        condition?: string,
      ) => {
        files.push({ name, blob: new Blob([text], { type }) });
        addManifestFile(name, kind, type.split(';')[0], required, condition);
      };

      if (measurements.length > 0) {
        addTextFile(
          'results/well_results.csv',
          wellMeasurementsToCsv(
            measurements,
            correctedMeasurementSet.measurements,
            lowSignalCorrectionEffective,
            plateMap,
            correctionMetadataSummary,
          ),
          'text/csv;charset=utf-8',
          'quantitative_results',
          true,
        );
      }

      if (calibrationFits.length > 0) {
        addTextFile(
          'results/calibration_results.csv',
          calibrationFitsToCsv(calibrationFits),
          'text/csv;charset=utf-8',
          'quantitative_results',
          false,
          'included when calibration results exist',
        );
        files.push({
          name: 'results/rgb_calibration_fits.png',
          blob: await canvasToPngBlob(buildRgbCalibrationFitCanvas(
            calibrationFits,
            lowSignalCorrectionEffective ? correctedMeasurementSet.measurements : measurements,
            plateMap,
          )),
        });
        addManifestFile(
          'results/rgb_calibration_fits.png',
          'fitting_figure',
          'image/png',
          false,
          'included when calibration fits are available',
        );
      }

      if (standardAdditionFitsWithSlopeContext.length > 0) {
        addTextFile(
          'results/standard_addition_results.csv',
          standardAdditionFitsToCsv(
            standardAdditionFitsWithSlopeContext,
            currentMethodMetadata,
            storedCalibration?.methodMetadata,
            storedCalibration?.sourceName,
          ),
          'text/csv;charset=utf-8',
          'quantitative_results',
          false,
          'included when standard-addition results exist',
        );
        files.push({
          name: 'results/rgb_standard_addition_fits.png',
          blob: await canvasToPngBlob(buildRgbStandardAdditionFitCanvas(standardAdditionFitsWithSlopeContext)),
        });
        addManifestFile(
          'results/rgb_standard_addition_fits.png',
          'fitting_figure',
          'image/png',
          false,
          'included when standard addition fits are available',
        );
      }

      if (unknownResults.length > 0) {
        addTextFile(
          'results/unknown_results.csv',
          unknownResultsToCsv(unknownResults),
          'text/csv;charset=utf-8',
          'quantitative_results',
          false,
          'included when unknown results exist',
        );
      }

      addTextFile(
        'method_summary.json',
        `${JSON.stringify(methodSummaryPayload, null, 2)}\n`,
        'application/json;charset=utf-8',
        'method_summary',
        true,
      );
      addTextFile(
        'diagnostics/reference_values.json',
        `${JSON.stringify(createReferenceValuesDiagnosticPayload(expectedRefs), null, 2)}\n`,
        'application/json;charset=utf-8',
        'diagnostic_reference_values',
        true,
      );
      addTextFile(
        'README_export.txt',
        [
          'TIPICA complete analysis ZIP export',
          '',
          'RESULTS/ contains Python-style primary RGB output filenames added for parity work.',
          'results/ contains quantitative CSV outputs.',
          'diagnostics/ contains diagnostic images, diagnostic CSV files, reference values, and export_manifest.json.',
          'method_summary.json summarizes analysis settings and method metadata.',
          'project_state.json stores reloadable project state when geometry is available.',
          'README_export.txt is informational only and does not affect calculations.',
          '',
        ].join('\n'),
        'text/plain;charset=utf-8',
        'readme',
        true,
      );
      addTextFile(
        `${pythonResultsPrefix}_RESULTS_CAPTION.txt`,
        createPythonResultsCaptionText(pythonResultsBase, plateMapUnit, expectedRefs),
        'text/plain;charset=utf-8',
        'python_parity_results_caption',
        false,
      );

      if (geometry) {
        const projectPayload = createProjectPayload(
          image,
          imageName,
          geometry,
          radiusFactor,
          plateMap,
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

        addTextFile(
          'project_state.json',
          `${JSON.stringify(projectPayload, null, 2)}\n`,
          'application/json;charset=utf-8',
          'project_state',
          false,
          'included when geometry is available',
        );
      }

      if (image && measurements.length > 0 && wells.length === 96) {
        const imageData = createAnalysisImageData(image, wells);
        const displayMeasurements = lowSignalCorrectionEffective
          ? correctedMeasurementSet.measurements
          : measurements;
        const pythonPlateOverlayCanvas = buildPythonStylePlateRoiOverlayCanvas(
          imageData,
          wells,
          measurements,
          radiusFactor,
          floorRoiRadiusFactor,
          floorGeometryAvailable ? floorCircles : null,
        );
        const bestChannel = selectBestRgbChannel(
          calibrationFits,
          standardAdditionFitsWithSlopeContext,
          displayMeasurements,
          plateMap,
        );
        const pythonFigureRgbCanvas = buildPythonStyleFigureRgbCanvas({
          imageBase: pythonResultsBase,
          overlayCanvas: pythonPlateOverlayCanvas,
          measurements,
          displayMeasurements,
          plateMap,
          calibrationFits,
          standardAdditionFits: standardAdditionFitsWithSlopeContext,
          expectedRefs,
          unitLabel: plateMapUnit,
          roiMode: currentMethodMetadata.roiMode,
          backgroundModel,
          floorGeometryAvailable,
          bestChannel,
        });
        const pythonBestChannelCanvas = buildPythonStyleBestChannelCanvas({
          bestChannel,
          displayMeasurements,
          plateMap,
          calibrationFits,
          standardAdditionFits: standardAdditionFitsWithSlopeContext,
          expectedRefs,
          unitLabel: plateMapUnit,
        });

        addManifestedBlob(
          files,
          addManifestFile,
          `${pythonResultsPrefix}_PLATE_ROI_OVERLAY.png`,
          await canvasToPngBlob(pythonPlateOverlayCanvas),
          'python_parity_plate_roi_overlay',
          false,
          'included when extraction results and image are available',
        );
        addManifestedBlob(
          files,
          addManifestFile,
          `${pythonResultsPrefix}_FIGURE_RGB.png`,
          await canvasToPngBlob(pythonFigureRgbCanvas),
          'python_parity_figure_rgb',
          false,
          'included when extraction results and image are available',
        );
        addManifestedBlob(
          files,
          addManifestFile,
          `${pythonResultsPrefix}_BEST_CHANNEL.png`,
          await canvasToPngBlob(pythonBestChannelCanvas),
          'python_parity_best_channel',
          false,
          'included when extraction results and image are available',
        );

        const roiCanvas = buildRoiDiagnosticCanvas(
          imageData,
          wells,
          measurements,
          radiusFactor,
          floorRoiRadiusFactor,
          floorGeometryAvailable ? floorCircles : null,
          geometry,
        );

        files.push({ name: 'diagnostics/roi_mask_diagnostic.png', blob: await canvasToPngBlob(roiCanvas) });
        addManifestFile(
          'diagnostics/roi_mask_diagnostic.png',
          'diagnostic_image',
          'image/png',
          false,
          'included when extraction results exist',
        );

        if (geometry) {
          const diagnosticBackgroundModel = measurements[0]?.backgroundModel ?? backgroundModel;
          const diagnostics = buildBackgroundVisualDiagnostics(
            imageData,
            wells,
            geometry,
            diagnosticBackgroundModel,
            floorGeometryAvailable ? floorCircles ?? undefined : undefined,
          );
          const backgroundMaskCanvas = buildBackgroundMaskDiagnosticCanvas(imageData, wells, diagnostics, geometry);
          const rawMaskCanvas = buildBackgroundCellRawMasksDiagnosticCanvas(imageData, wells, diagnostics, geometry);
          const cellDiagnosticsCsv = backgroundCellDiagnosticsToCsv(diagnostics.diagnostics.cellDiagnostics ?? []);

          files.push({ name: 'diagnostics/background_mask_diagnostic.png', blob: await canvasToPngBlob(backgroundMaskCanvas) });
          addManifestFile(
            'diagnostics/background_mask_diagnostic.png',
            'diagnostic_image',
            'image/png',
            false,
            'included when extraction results and geometry are available',
          );
          files.push({ name: 'diagnostics/background_cell_raw_masks_diagnostic.png', blob: await canvasToPngBlob(rawMaskCanvas) });
          addManifestFile(
            'diagnostics/background_cell_raw_masks_diagnostic.png',
            'diagnostic_image',
            'image/png',
            false,
            'included when extraction results and geometry are available',
          );
          addTextFile(
            'diagnostics/background_cell_diagnostics.csv',
            cellDiagnosticsCsv,
            'text/csv;charset=utf-8',
            'diagnostic_data',
            false,
            'included when extraction results and geometry are available',
          );

          if (diagnostics.predictedRgbMap && diagnostics.predictedRgbMap.length > 0) {
            const rgbMapCanvas = buildBackgroundRgbMapDiagnosticCanvas(imageData, wells, diagnostics, geometry);
            files.push({ name: 'diagnostics/background_rgb_map_diagnostic.png', blob: await canvasToPngBlob(rgbMapCanvas) });
            addManifestFile(
              'diagnostics/background_rgb_map_diagnostic.png',
              'diagnostic_image',
              'image/png',
              false,
              'included when a predicted background RGB map is available',
            );
          }
        }
      }

      const analysisReportManifestEntry: ExportManifestFileEntry = {
        path: 'results/analysis_report.json',
        kind: 'analysis_report',
        mediaType: 'application/json',
        required: true,
      };
      const exportManifestEntry: ExportManifestFileEntry = {
        path: 'diagnostics/export_manifest.json',
        kind: 'export_manifest',
        mediaType: 'application/json',
        required: true,
      };
      addTextFile(
        analysisReportManifestEntry.path,
        `${JSON.stringify(createAnalysisReportPayload({
          generatedAt,
          imageName,
          roiMode: currentMethodMetadata.roiMode,
          backgroundModel,
          wellsDetected: wells.length,
          measurements: measurements.length,
          plateMapEntries: plateMap.length,
          expectedReferenceValues: expectedRefs.length,
          calibrationFits: calibrationFits.length,
          standardAdditionFits: standardAdditionFitsWithSlopeContext.length,
          unknownResults: unknownResults.length,
          files: [
            ...manifestFiles,
            analysisReportManifestEntry,
            exportManifestEntry,
          ],
        }), null, 2)}\n`,
        'application/json;charset=utf-8',
        analysisReportManifestEntry.kind,
        analysisReportManifestEntry.required,
      );

      addTextFile(
        exportManifestEntry.path,
        `${JSON.stringify(createExportManifestPayload(generatedAt, [
          ...manifestFiles,
          exportManifestEntry,
        ]), null, 2)}\n`,
        'application/json;charset=utf-8',
        exportManifestEntry.kind,
        exportManifestEntry.required,
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
    correctionMetadataSummary,
    currentMethodMetadata,
    extractionSummary,
    fittingSummary,
    floorCircles,
    floorGeometryAvailable,
    floorGeometrySource,
    floorRoiRadiusFactor,
    geometry,
    image,
    imageName,
    lowSignalCorrectionEffective,
    methodSummaryPayload,
    measurements,
    plateMap,
    expectedRefs,
    radiusFactor,
    roiMode,
    roiPixelStatisticsMode,
    standardAdditionFitsWithSlopeContext,
    storedCalibration,
    unknownResults,
    useLowSignalCorrection,
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
    setStatusMessage('Starting a new complete validated analysis...');
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

      setStatusMessage('Complete validated analysis: waiting for extracted measurements...');
      setPendingCompleteAnalysisFitting(true);
    } catch {
      setStatusMessage('Complete validated analysis failed');
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
    setStatusMessage('Complete validated analysis: fitting...');

    void runFittingRoutine({ useLowSignalCorrection }).then((fittingSucceeded) => {
      if (!fittingSucceeded) {
        setIsRunningCompleteAnalysis(false);
        setPendingCompleteAnalysisPackageExport(false);
        return;
      }

      setStatusMessage('Complete validated analysis: waiting for fitting results...');
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
    setStatusMessage('Complete validated analysis: exporting package...');

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

        <section className="control-section" aria-labelledby="project-heading">
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
        </section>

        <ImageGeometryLoader
          imageName={imageName}
          geometryName={geometryName}
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
          <button
            type="button"
            className="secondary-button"
            onClick={handleExportGeometryJson}
          >
            Export complete geometry JSON
          </button>
        </section>

        <section className="control-section" aria-labelledby="complete-workflow-heading">
          <h2 id="complete-workflow-heading">Complete validated workflow</h2>
          <button
            type="button"
            className="primary-button"
            disabled={!overlayReady || configuredWellCount === 0 || isExtracting || isFitting || isRunningCompleteAnalysis || projectImageMismatchBlocksExtraction}
            onClick={handleRunCompleteValidatedAnalysis}
          >
            {isRunningCompleteAnalysis ? 'Running complete analysisâ€¦' : 'Run complete validated analysis'}
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
            <span>Status — {compactStatusSummary}</span>
          </summary>
          <dl className="status-list">
            <div>
              <dt>Image</dt>
              <dd>{image ? `${image.naturalWidth} x ${image.naturalHeight}px` : 'Waiting'}</dd>
            </div>
            <div>
              <dt>Geometry</dt>
              <dd>{wells.length === 96 ? '96 wells generated' : 'Waiting'}</dd>
            </div>
            <div>
              <dt>Overlay</dt>
              <dd>{overlayReady ? 'Ready' : 'Waiting'}</dd>
            </div>
            <div>
              <dt>Selected ROI mode</dt>
              <dd>{formatRoiMode(roiMode)}</dd>
            </div>
            <div>
              <dt>ROI pixel statistics</dt>
              <dd>{formatRoiPixelStatisticsMode(roiPixelStatisticsMode)}</dd>
            </div>
            <div>
              <dt>Floor geometry</dt>
              <dd>{floorGeometryAvailable ? 'Available' : 'Missing'}</dd>
            </div>
            <div>
              <dt>Floor geometry source</dt>
              <dd>{floorGeometrySourceLabel}</dd>
            </div>
            {roiStats ? (
              <>
                <div>
                  <dt>ROI pixels (min/mean/max)</dt>
                  <dd>{roiStats.minPixels.toFixed(0)} / {roiStats.meanPixels.toFixed(0)} / {roiStats.maxPixels.toFixed(0)}</dd>
                </div>
              </>
            ) : null}
            <div>
              <dt>Results</dt>
              <dd>{measurements.length > 0 ? `${measurements.length} wells` : 'Waiting'}</dd>
            </div>
            <div>
              <dt>Map</dt>
              <dd>{configuredWellCount} configured wells</dd>
            </div>
            <div>
              <dt>Fits</dt>
              <dd>{fittingSummary}</dd>
            </div>
            <div>
              <dt>Stored cal</dt>
              <dd>{storedCalibration ? storedCalibration.sourceName : 'Waiting'}</dd>
            </div>
            <div>
              <dt>Correction</dt>
              <dd>{useLowSignalCorrection ? lowSignalCorrectionSource : 'Off'}</dd>
            </div>
            <div>
              <dt>Unknowns</dt>
              <dd>{unknownResults.length > 0 ? `${unknownResults.length} rows` : 'Waiting'}</dd>
            </div>
            <div>
              <dt>Process</dt>
              <dd>{statusMessage}</dd>
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
          storedCalibrationLoaded={Boolean(storedCalibration)}
          onChange={handlePlateMapChange}
          onClear={handleClearPlateMap}
          onExpectedRefsChange={setExpectedRefs}
          onUnitLabelChange={setPlateMapUnit}
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
