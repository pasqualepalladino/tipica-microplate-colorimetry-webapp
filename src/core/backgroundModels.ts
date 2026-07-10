import type { FloorCircle, PlateGeometry } from '../types/geometry';
import type { Rgb } from '../types/results';
import type { WellCenter } from '../types/plate';
import { estimateLocalBackground } from './sampling';
import { estimateLocalPitch } from './plate';

const MIN_BACKGROUND_PIXELS = 32;
const LABELED_PIXEL_PERCENTILE = 0.05;
const HIGHLIGHT_PIXEL_PERCENTILE = 0.95;
const CHROMA_THRESHOLD = 64;
const DEFAULT_CANDIDATE_SAMPLE_STRIDE = 4;
const MAX_CANDIDATE_SAMPLE_STRIDE = 4;
const MAX_CANDIDATE_PIXEL_BUDGET = 250_000;
const PHYSICAL_PITCH_MM = 9.0;
const PHYSICAL_INNER_DIAM_MM = 6.90;
const PHYSICAL_OUTER_DIAM_MM = 7.75;
const PHYSICAL_BRIDGE_WIDTH_MM = 0.60;
const PHYSICAL_EXTRA_OPTICAL_MARGIN_MM = 0.20;
const PHYSICAL_MOUTH_RADIUS_FACTOR_OF_PITCH = 0.34;
const PHYSICAL_EXCLUSION_RADIUS_FACTOR = (0.5 * PHYSICAL_OUTER_DIAM_MM + PHYSICAL_EXTRA_OPTICAL_MARGIN_MM) / (0.5 * PHYSICAL_INNER_DIAM_MM);
const PHYSICAL_FLOOR_EXCLUSION_FACTOR = 1.08;
const PHYSICAL_MIN_CANDIDATE_PIXELS = 1000;
const PHYSICAL_MIN_ACCEPTED_PIXELS = 240;
const PHYSICAL_MIN_CELL_PIXELS = 30;
const PHYSICAL_MIN_POLY_SAMPLES = 40;
const PHYSICAL_MASK_ALGORITHM = 'python-like inter-well cell mask';
const PHYSICAL_POLY_COEFFICIENTS = 6;
const PHYSICAL_POLY_MAX_ITERATIONS = 6;
const PHYSICAL_POLY_CLIP_K = 2.5;
const RGB_MIN = 1;
const RGB_MAX = 255;

export type BackgroundModel = 'annular' | 'robust-interwell-v1' | 'physical-interwell-polynomial-v1';
export type BackgroundOutcome = 'local' | 'expanded' | 'global' | 'annular' | 'physical-polynomial';

interface CandidatePixel {
  x: number;
  y: number;
  rgb: Rgb;
  luminance: number;
  cellRow?: number;
  cellCol?: number;
  canonicalU?: number;
  canonicalV?: number;
}

interface CandidateCollection {
  pixels: CandidatePixel[];
  rawPixels: CandidatePixel[];
  stride: number;
}

export interface BackgroundEstimate {
  rgbBackground: Rgb;
  bgPixels: number;
  warnings: string[];
  outcome?: BackgroundOutcome;
  candidatePixels?: number;
  acceptedPixels?: number;
  acceptedSamples?: number;
  candidateStride?: number;
  candidateRegionX0?: number;
  candidateRegionY0?: number;
  candidateRegionX1?: number;
  candidateRegionY1?: number;
  medianPitch?: number;
  wellExclusionRadiusApprox?: number;
  maskAlgorithm?: string;
  actualModel?: BackgroundModel;
  backgroundWarning?: string;
  backgroundFitSuccess?: boolean;
}

export type BackgroundEstimateWithModel = BackgroundEstimate & { backgroundModel: BackgroundModel };

interface BackgroundDiagnostics {
  candidatePixels: number;
  acceptedPixels: number;
  acceptedSamples: number;
  candidateStride: number;
  candidateRegionX0: number;
  candidateRegionY0: number;
  candidateRegionX1: number;
  candidateRegionY1: number;
  medianPitch: number;
  wellExclusionRadiusApprox: number;
  fitSuccess: boolean;
  maskAlgorithm?: string;
  cellDiagnostics?: BackgroundCellDiagnostic[];
}

export interface BackgroundCellDiagnostic {
  cellRow: number;
  cellColumn: number;
  projectedPolygonAreaPx: number;
  rawCanonicalMaskPixels: number;
  pixelsAfterWarpProjectToImage: number;
  pixelsAfterCellPolygonIntersection: number;
  pixelsAfterWellDiskExclusion: number;
  pixelsAfterLuminanceChromaFiltering: number;
  finalAcceptedPixels: number;
  sampledFinalAcceptedPixels?: number;
  fullResolutionPixelsAfterWellDiskExclusion?: number;
  fullResolutionRefinedBeforeMadPixels?: number;
  fullResolutionFinalAcceptedPixels?: number;
  acceptedCentroidX?: number;
  acceptedCentroidY?: number;
  redMedianRaw?: number;
  greenMedianRaw?: number;
  blueMedianRaw?: number;
  zeroReason: string;
}

export interface PhysicalPolynomialBackgroundResult {
  estimatesByWell: Map<string, BackgroundEstimateWithModel>;
  diagnostics: BackgroundDiagnostics;
  fallbackWarning?: string;
  filterWarning?: string;
}

export interface BackgroundDiagnosticPoint {
  x: number;
  y: number;
}

export interface BackgroundRgbMapCell {
  x: number;
  y: number;
  size: number;
  rgb: Rgb;
}

export interface BackgroundVisualDiagnostics {
  selectedModel: BackgroundModel;
  actualModel?: BackgroundModel;
  rawCandidatePixels: BackgroundDiagnosticPoint[];
  candidatePixels: BackgroundDiagnosticPoint[];
  acceptedPixels: BackgroundDiagnosticPoint[];
  samplePixels: BackgroundDiagnosticPoint[];
  diagnostics: BackgroundDiagnostics;
  warning?: string;
  predictedRgbMap?: BackgroundRgbMapCell[];
  physicalModelProof?: PhysicalModelProofDiagnostics;
}

export type WellExclusionRadiusMap = Map<string, number>;

const BACKGROUND_CELL_DIAGNOSTIC_HEADERS = [
  'cell row',
  'cell column',
  'projected polygon area in pixels',
  'raw canonical mask pixels before filtering',
  'pixels after warp/project-to-image',
  'pixels after cell polygon intersection',
  'pixels after well disk exclusion',
  'pixels after luminance/chroma filtering',
  'final accepted pixels',
  'zero reason if empty',
];

function csvCell(value: string | number): string {
  const text = String(value);

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

export function backgroundCellDiagnosticsToCsv(diagnostics: BackgroundCellDiagnostic[]): string {
  const rows = diagnostics.map((diagnostic) => [
    diagnostic.cellRow,
    diagnostic.cellColumn,
    diagnostic.projectedPolygonAreaPx.toFixed(2),
    diagnostic.rawCanonicalMaskPixels,
    diagnostic.pixelsAfterWarpProjectToImage,
    diagnostic.pixelsAfterCellPolygonIntersection,
    diagnostic.pixelsAfterWellDiskExclusion,
    diagnostic.pixelsAfterLuminanceChromaFiltering,
    diagnostic.finalAcceptedPixels,
    diagnostic.zeroReason,
  ]);

  return [
    BACKGROUND_CELL_DIAGNOSTIC_HEADERS.map(csvCell).join(','),
    ...rows.map((row) => row.map(csvCell).join(',')),
  ].join('\n');
}

interface PhysicalCellSample {
  cellRow: number;
  cellColumn: number;
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  area: number;
}

export interface PhysicalModelFitInputRow {
  cellRow: number;
  cellColumn: number;
  x: number;
  y: number;
  area: number;
  redMedianRaw: number;
  greenMedianRaw: number;
  blueMedianRaw: number;
}

export interface PhysicalModelChannelFitDiagnostic {
  channel: 'red' | 'green' | 'blue';
  basisOrder: string;
  x0: number;
  y0: number;
  sx: number;
  sy: number;
  coefficients: number[];
  samplesTotal: number;
  samplesRetained: number;
  samplesRejected: number;
  residualMedian: number;
  residualMad: number;
  residualSigma: number;
  residualMaxAbs: number;
}

export interface PhysicalModelWellPredictionRow {
  row: number;
  col: number;
  wellId: string;
  x: number;
  y: number;
  bgRedRawModel: number;
  bgGreenRawModel: number;
  bgBlueRawModel: number;
}

export interface PhysicalModelProofDiagnostics {
  basisOrder: string;
  fitInputs: PhysicalModelFitInputRow[];
  channelFits: PhysicalModelChannelFitDiagnostic[];
  wellPredictions: PhysicalModelWellPredictionRow[];
}

interface Poly2Model {
  coef: number[];
  x0: number;
  y0: number;
  sx: number;
  sy: number;
}

interface Poly2FitTrace {
  model: Poly2Model | null;
  samplesTotal: number;
  samplesRetained: number;
  samplesRejected: number;
  residualMedian: number;
  residualMad: number;
  residualSigma: number;
  residualMaxAbs: number;
}

const PHYSICAL_POLY_BASIS_ORDER = '1, x, y, x^2, x*y, y^2';

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }

  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const rank = (Math.min(100, Math.max(0, q)) / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);

  if (lower === upper) {
    return sorted[lower];
  }

  const fraction = rank - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]): number {
  if (values.length === 0) {
    return 1;
  }

  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
  return Math.sqrt(Math.max(0, variance)) || 1;
}

function medianRgb(pixels: CandidatePixel[]): Rgb {
  return {
    r: median(pixels.map((pixel) => pixel.rgb.r)),
    g: median(pixels.map((pixel) => pixel.rgb.g)),
    b: median(pixels.map((pixel) => pixel.rgb.b)),
  };
}

function luminance(rgb: Rgb): number {
  return 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
}

function clampRgb(value: number): number {
  if (!Number.isFinite(value)) {
    return Number.NaN;
  }

  return Math.min(RGB_MAX, Math.max(RGB_MIN, value));
}

function isFiniteRgb(rgb: Rgb): boolean {
  return Number.isFinite(rgb.r) && Number.isFinite(rgb.g) && Number.isFinite(rgb.b);
}

function wellAt(wells: WellCenter[], row: number, col: number): WellCenter | undefined {
  return wells.find((well) => well.row === row && well.col === col);
}

function attachBackgroundDiagnostics<T extends BackgroundEstimate>(
  estimate: T,
  diagnostics: Partial<BackgroundDiagnostics>,
): T {
  return {
    ...estimate,
    candidatePixels: diagnostics.candidatePixels ?? estimate.candidatePixels,
    acceptedPixels: diagnostics.acceptedPixels ?? estimate.acceptedPixels,
    acceptedSamples: diagnostics.acceptedSamples ?? estimate.acceptedSamples,
    candidateStride: diagnostics.candidateStride ?? estimate.candidateStride,
    candidateRegionX0: diagnostics.candidateRegionX0 ?? estimate.candidateRegionX0,
    candidateRegionY0: diagnostics.candidateRegionY0 ?? estimate.candidateRegionY0,
    candidateRegionX1: diagnostics.candidateRegionX1 ?? estimate.candidateRegionX1,
    candidateRegionY1: diagnostics.candidateRegionY1 ?? estimate.candidateRegionY1,
    medianPitch: diagnostics.medianPitch ?? estimate.medianPitch,
    wellExclusionRadiusApprox: diagnostics.wellExclusionRadiusApprox ?? estimate.wellExclusionRadiusApprox,
    backgroundFitSuccess: diagnostics.fitSuccess ?? estimate.backgroundFitSuccess,
    maskAlgorithm: diagnostics.maskAlgorithm ?? estimate.maskAlgorithm,
  };
}

function isPointInPolygon(pointX: number, pointY: number, polygon: { x: number; y: number }[]): boolean {
  let inside = false;
  const count = polygon.length;

  for (let i = 0, j = count - 1; i < count; j = i, i += 1) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect = ((yi > pointY) !== (yj > pointY))
      && (pointX < ((xj - xi) * (pointY - yi)) / (yj - yi + Number.EPSILON) + xi);

    if (intersect) {
      inside = !inside;
    }
  }

  return inside;
}

function polygonArea(polygon: { x: number; y: number }[]): number {
  if (polygon.length < 3) {
    return 0;
  }

  let twiceArea = 0;

  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    twiceArea += current.x * next.y - next.x * current.y;
  }

  return Math.abs(twiceArea) / 2;
}

function describeCellZeroReason(diagnostic: BackgroundCellDiagnostic): string {
  if (diagnostic.finalAcceptedPixels > 0) {
    return '';
  }

  if (diagnostic.projectedPolygonAreaPx <= 0) {
    return 'cell polygon has zero area';
  }

  if (diagnostic.rawCanonicalMaskPixels === 0) {
    return 'canonical mask empty';
  }

  if (diagnostic.pixelsAfterWarpProjectToImage === 0) {
    return 'cells projected outside image';
  }

  if (diagnostic.pixelsAfterCellPolygonIntersection === 0) {
    return 'cell polygon intersection removed all pixels';
  }

  if (diagnostic.pixelsAfterWellDiskExclusion === 0) {
    return 'well disk exclusion removed all pixels';
  }

  if (diagnostic.pixelsAfterLuminanceChromaFiltering === 0) {
    return 'filtering removed all pixels';
  }

  return 'final cell filter removed all pixels';
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.min(maxValue, Math.max(minValue, value));
}

function computeHomographyToUnitSquare(points: Array<{ x: number; y: number }>): number[] | null {
  const dst = [
    { u: 0, v: 0 },
    { u: 1, v: 0 },
    { u: 1, v: 1 },
    { u: 0, v: 1 },
  ];
  const matrix: number[][] = [];
  const vector: number[] = [];

  points.forEach((point, index) => {
    const { u, v } = dst[index];

    matrix.push([point.x, point.y, 1, 0, 0, 0, -u * point.x, -u * point.y]);
    vector.push(u);
    matrix.push([0, 0, 0, point.x, point.y, 1, -v * point.x, -v * point.y]);
    vector.push(v);
  });

  const solution = solveLinearSystem(matrix, vector);

  return solution ? [...solution, 1] : null;
}

function computeHomographyFromUnitSquare(points: Array<{ x: number; y: number }>): number[] | null {
  const src = [
    { u: 0, v: 0 },
    { u: 1, v: 0 },
    { u: 1, v: 1 },
    { u: 0, v: 1 },
  ];
  const matrix: number[][] = [];
  const vector: number[] = [];

  points.forEach((point, index) => {
    const { u, v } = src[index];

    matrix.push([u, v, 1, 0, 0, 0, -point.x * u, -point.x * v]);
    vector.push(point.x);
    matrix.push([0, 0, 0, u, v, 1, -point.y * u, -point.y * v]);
    vector.push(point.y);
  });

  const solution = solveLinearSystem(matrix, vector);

  return solution ? [...solution, 1] : null;
}

function applyHomography(homography: number[], x: number, y: number): { u: number; v: number } | null {
  const denominator = homography[6] * x + homography[7] * y + homography[8];

  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12) {
    return null;
  }

  return {
    u: (homography[0] * x + homography[1] * y + homography[2]) / denominator,
    v: (homography[3] * x + homography[4] * y + homography[5]) / denominator,
  };
}

function canonicalModelAllowsBackground(
  u: number,
  v: number,
  rForbiddenX: number,
  rForbiddenY: number,
  bridgeHalfW: number,
  bridgeHalfH: number,
): boolean {
  if (u < 0 || u > 1 || v < 0 || v > 1) {
    return false;
  }

  const centralGuard = 0.05;

  if (Math.abs(u - 0.5) <= centralGuard && Math.abs(v - 0.5) <= centralGuard) {
    return true;
  }

  const corners = [
    { u: 0, v: 0 },
    { u: 1, v: 0 },
    { u: 1, v: 1 },
    { u: 0, v: 1 },
  ];

  if (corners.some((corner) => (
    ((u - corner.u) / rForbiddenX) ** 2 + ((v - corner.v) / rForbiddenY) ** 2 <= 1
  ))) {
    return false;
  }

  if (Math.abs(u - 0.5) <= rForbiddenX && (v <= bridgeHalfH || v >= 1 - bridgeHalfH)) {
    return false;
  }

  if (Math.abs(v - 0.5) <= rForbiddenY && (u <= bridgeHalfW || u >= 1 - bridgeHalfW)) {
    return false;
  }

  const textExclusionX = 0.16;
  const textExclusionY = 0.09;

  if (Math.abs(u - 0.5) <= textExclusionX && (Math.abs(v - 0.15) <= textExclusionY || Math.abs(v - 0.85) <= textExclusionY)) {
    return false;
  }

  if (Math.abs(v - 0.5) <= textExclusionX && (Math.abs(u - 0.15) <= textExclusionY || Math.abs(u - 0.85) <= textExclusionY)) {
    return false;
  }

  return true;
}

function otsuThreshold(values: number[]): number {
  if (values.length < 2) {
    return values[0] ?? 255;
  }

  const histogram = Array(256).fill(0);
  values.forEach((value) => {
    histogram[clamp(Math.round(value), 0, 255)] += 1;
  });

  const total = values.length;
  let sumAll = 0;

  histogram.forEach((count, index) => {
    sumAll += count * index;
  });

  let weightBackground = 0;
  let sumBackground = 0;
  let bestThreshold = Math.round(median(values));
  let bestVariance = -1;

  for (let threshold = 0; threshold < 256; threshold += 1) {
    weightBackground += histogram[threshold];

    if (weightBackground === 0) {
      continue;
    }

    const weightForeground = total - weightBackground;

    if (weightForeground === 0) {
      break;
    }

    sumBackground += threshold * histogram[threshold];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sumAll - sumBackground) / weightForeground;
    const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;

    if (variance > bestVariance) {
      bestVariance = variance;
      bestThreshold = threshold;
    }
  }

  return bestThreshold;
}

function keepCanonicalComponentNearCenter(pixels: CandidatePixel[]): CandidatePixel[] {
  if (pixels.length < PHYSICAL_MIN_CELL_PIXELS) {
    return pixels;
  }

  const visited = new Set<number>();
  const components: CandidatePixel[][] = [];
  const adjacencyDistance = DEFAULT_CANDIDATE_SAMPLE_STRIDE * 1.8;
  const adjacencyDistanceSq = adjacencyDistance * adjacencyDistance;

  pixels.forEach((_, startIndex) => {
    if (visited.has(startIndex)) {
      return;
    }

    const component: CandidatePixel[] = [];
    const stack = [startIndex];
    visited.add(startIndex);

    while (stack.length > 0) {
      const index = stack.pop() as number;
      const pixel = pixels[index];
      component.push(pixel);

      pixels.forEach((candidate, candidateIndex) => {
        if (visited.has(candidateIndex)) {
          return;
        }

        const dx = candidate.x - pixel.x;
        const dy = candidate.y - pixel.y;

        if (dx * dx + dy * dy <= adjacencyDistanceSq) {
          visited.add(candidateIndex);
          stack.push(candidateIndex);
        }
      });
    }

    components.push(component);
  });

  if (components.length === 0) {
    return pixels;
  }

  const scored = components.map((component) => {
    const centerU = mean(component.map((pixel) => pixel.canonicalU ?? 0.5));
    const centerV = mean(component.map((pixel) => pixel.canonicalV ?? 0.5));
    const d2 = (centerU - 0.5) ** 2 + (centerV - 0.5) ** 2;
    return {
      component,
      score: component.length - 30 * d2,
    };
  }).sort((a, b) => b.score - a.score);

  return scored[0].component.length >= 8 ? scored[0].component : pixels;
}

function refinePhysicalCellCandidates(modelPixels: CandidatePixel[]): CandidatePixel[] {
  if (modelPixels.length < PHYSICAL_MIN_CELL_PIXELS) {
    return modelPixels;
  }

  const grayValues = modelPixels.map((pixel) => pixel.luminance);
  const thresholdOtsu = otsuThreshold(grayValues);
  const thresholdP55 = percentile(grayValues, 55);
  const thresholdP60 = percentile(grayValues, 60);
  const threshold = Math.min(Math.max(thresholdOtsu, thresholdP55), thresholdP60 + 6);
  const darkThreshold = percentile(grayValues, 30);
  const brightThreshold = percentile(grayValues, 95);
  const selected = modelPixels.filter((pixel) => (
    pixel.luminance >= threshold &&
    pixel.luminance >= darkThreshold &&
    pixel.luminance <= brightThreshold
  ));

  if (selected.length < 20) {
    return modelPixels;
  }

  const centralComponent = keepCanonicalComponentNearCenter(selected);
  return centralComponent.length >= 20 ? centralComponent : modelPixels;
}

function computeCandidateSampleStride(regionWidth: number, regionHeight: number): number {
  let stride = DEFAULT_CANDIDATE_SAMPLE_STRIDE;

  while (
    stride < MAX_CANDIDATE_SAMPLE_STRIDE &&
    Math.ceil(regionWidth / stride) * Math.ceil(regionHeight / stride) > MAX_CANDIDATE_PIXEL_BUDGET
  ) {
    stride += 2;
  }

  return stride;
}

function createInterwellCandidates(
  imageData: ImageData,
  wells: WellCenter[],
  geometry: PlateGeometry,
  floorCircles?: FloorCircle[],
  wellExclusionRadiiByWell?: WellExclusionRadiusMap,
): CandidateCollection {
  // Build a candidate region from well centers bounding box expanded outward
  const { data, width, height } = imageData;

  if (wells.length === 0) {
    return { pixels: [], rawPixels: [], stride: DEFAULT_CANDIDATE_SAMPLE_STRIDE };
  }

  // compute pitches per well and median pitch
  const pitches = wells.map((well) => estimateLocalPitch(wells, well.row, well.col));
  const medianPitch = median(pitches);

  // bounding box of well centers
  let xMin = Math.max(0, Math.floor(Math.min(...wells.map((w) => w.x))));
  let xMax = Math.min(width - 1, Math.ceil(Math.max(...wells.map((w) => w.x))));
  let yMin = Math.max(0, Math.floor(Math.min(...wells.map((w) => w.y))));
  let yMax = Math.min(height - 1, Math.ceil(Math.max(...wells.map((w) => w.y))));

  // expand bounding box by 0.75 * medianPitch
  const expand = 0.75 * medianPitch;
  xMin = Math.max(0, Math.floor(xMin - expand));
  xMax = Math.min(width - 1, Math.ceil(xMax + expand));
  yMin = Math.max(0, Math.floor(yMin - expand));
  yMax = Math.min(height - 1, Math.ceil(yMax + expand));

  // well exclusion radii per well (0.35 * local pitch) unless floor-aware exclusion is requested.
  const radii = wells.map((well) => 0.35 * estimateLocalPitch(wells, well.row, well.col));

  const regionWidth = xMax - xMin + 1;
  const regionHeight = yMax - yMin + 1;
  const sampleStride = computeCandidateSampleStride(regionWidth, regionHeight);
  const pixels: CandidatePixel[] = [];

  for (let y = yMin; y <= yMax; y += sampleStride) {
    for (let x = xMin; x <= xMax; x += sampleStride) {
      const px = x + 0.5;
      const py = y + 0.5;

      // exclude pixels that fall inside any well exclusion circle
      let inAnyWell = false;

      for (let w = 0; w < wells.length; w += 1) {
        const well = wells[w];
        const dx = px - well.x;
        const dy = py - well.y;
        const overrideRadius = wellExclusionRadiiByWell?.get(well.wellId);
        const radius = overrideRadius && Number.isFinite(overrideRadius) && overrideRadius > 0
          ? overrideRadius
          : floorCircles && floorCircles.length === wells.length
            ? floorCircles[w].r * 1.15
            : radii[w];

        if (dx * dx + dy * dy <= radius * radius) {
          inAnyWell = true;
          break;
        }
      }

      if (inAnyWell) {
        continue;
      }

      const offset = (y * width + x) * 4;
      const rgb = {
        r: data[offset],
        g: data[offset + 1],
        b: data[offset + 2],
      };

      pixels.push({ x: px, y: py, rgb, luminance: luminance(rgb) });
    }
  }

  return { pixels, rawPixels: pixels, stride: sampleStride };
}

function createEmptyDiagnostics(): BackgroundDiagnostics {
  return {
    candidatePixels: 0,
    acceptedPixels: 0,
    acceptedSamples: 0,
    candidateStride: DEFAULT_CANDIDATE_SAMPLE_STRIDE,
    candidateRegionX0: 0,
    candidateRegionY0: 0,
    candidateRegionX1: 0,
    candidateRegionY1: 0,
    medianPitch: 0,
    wellExclusionRadiusApprox: 0,
    fitSuccess: false,
    cellDiagnostics: [],
  };
}

function createPhysicalInterwellCandidates(
  imageData: ImageData,
  wells: WellCenter[],
  floorCircles?: FloorCircle[],
  wellExclusionRadiiByWell?: WellExclusionRadiusMap,
): { collection: CandidateCollection; diagnostics: BackgroundDiagnostics } {
  const { data, width, height } = imageData;

  if (wells.length === 0) {
    return { collection: { pixels: [], rawPixels: [], stride: DEFAULT_CANDIDATE_SAMPLE_STRIDE }, diagnostics: createEmptyDiagnostics() };
  }

  const pitches = wells.map((well) => estimateLocalPitch(wells, well.row, well.col));
  const medianPitch = median(pitches);
  const exclusionRadii = wells.map((well, index) => {
    const overrideRadius = wellExclusionRadiiByWell?.get(well.wellId);
    if (overrideRadius && Number.isFinite(overrideRadius) && overrideRadius > 0) {
      return overrideRadius;
    }

    const mouthRadius = PHYSICAL_MOUTH_RADIUS_FACTOR_OF_PITCH * estimateLocalPitch(wells, well.row, well.col);
    const mouthExclusion = PHYSICAL_EXCLUSION_RADIUS_FACTOR * mouthRadius;
    const floorExclusion = floorCircles && floorCircles.length === wells.length
      ? floorCircles[index].r * PHYSICAL_FLOOR_EXCLUSION_FACTOR
      : 0;

    return Math.max(1, mouthExclusion, floorExclusion);
  });
  const wellExclusionRadiusApprox = wellExclusionRadiiByWell && exclusionRadii.length > 0
    ? median(exclusionRadii)
    : PHYSICAL_EXCLUSION_RADIUS_FACTOR * PHYSICAL_MOUTH_RADIUS_FACTOR_OF_PITCH * medianPitch;
  const pixels: CandidatePixel[] = [];
  const rawPixels: CandidatePixel[] = [];
  const cellDiagnostics: BackgroundCellDiagnostic[] = [];
  const regionExpand = medianPitch * 0.5;
  const regionX0 = Math.max(0, Math.floor(Math.min(...wells.map((w) => w.x)) - regionExpand));
  const regionX1 = Math.min(width - 1, Math.ceil(Math.max(...wells.map((w) => w.x)) + regionExpand));
  const regionY0 = Math.max(0, Math.floor(Math.min(...wells.map((w) => w.y)) - regionExpand));
  const regionY1 = Math.min(height - 1, Math.ceil(Math.max(...wells.map((w) => w.y)) + regionExpand));
  const sampleStride = DEFAULT_CANDIDATE_SAMPLE_STRIDE;

  for (let row = 0; row < 7; row += 1) {
    for (let col = 0; col < 11; col += 1) {
      const topLeft = wellAt(wells, row, col);
      const topRight = wellAt(wells, row, col + 1);
      const bottomLeft = wellAt(wells, row + 1, col);
      const bottomRight = wellAt(wells, row + 1, col + 1);

      if (!topLeft || !topRight || !bottomLeft || !bottomRight) {
        continue;
      }

      const quad = [topLeft, topRight, bottomRight, bottomLeft];
      const projectedPolygonAreaPx = polygonArea(quad);
      const cellDiagnostic: BackgroundCellDiagnostic = {
        cellRow: row,
        cellColumn: col,
        projectedPolygonAreaPx,
        rawCanonicalMaskPixels: 0,
        pixelsAfterWarpProjectToImage: 0,
        pixelsAfterCellPolygonIntersection: 0,
        pixelsAfterWellDiskExclusion: 0,
        pixelsAfterLuminanceChromaFiltering: 0,
        finalAcceptedPixels: 0,
        zeroReason: '',
      };
      const homography = computeHomographyFromUnitSquare(quad);
      const inverseHomography = computeHomographyToUnitSquare(quad);

      if (!homography || !inverseHomography) {
        cellDiagnostic.zeroReason = 'homography failed';
        cellDiagnostics.push(cellDiagnostic);
        continue;
      }

      const sxPx = Math.max(1e-6, Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y));
      const syPx = Math.max(1e-6, Math.hypot(bottomLeft.x - topLeft.x, bottomLeft.y - topLeft.y));
      const pxPerMmX = sxPx / PHYSICAL_PITCH_MM;
      const pxPerMmY = syPx / PHYSICAL_PITCH_MM;
      const forbiddenRadiusMm = 0.5 * PHYSICAL_OUTER_DIAM_MM + PHYSICAL_EXTRA_OPTICAL_MARGIN_MM;
      const rForbiddenX = clamp((forbiddenRadiusMm * pxPerMmX) / sxPx, 0.18, 0.42);
      const rForbiddenY = clamp((forbiddenRadiusMm * pxPerMmY) / syPx, 0.18, 0.42);
      const bridgeHalfW = clamp((0.5 * PHYSICAL_BRIDGE_WIDTH_MM * pxPerMmX) / sxPx, 0.01, 0.06);
      const bridgeHalfH = clamp((0.5 * PHYSICAL_BRIDGE_WIDTH_MM * pxPerMmY) / syPx, 0.01, 0.06);
      const modelPixels: CandidatePixel[] = [];
      const seenPixels = new Set<string>();
      const canonicalSize = 220;
      const averageCellScale = Math.max(1, 0.5 * (sxPx + syPx));
      const canonicalStep = Math.max(2, Math.round((sampleStride * canonicalSize) / averageCellScale));
      const cornerWells = [topLeft, topRight, bottomRight, bottomLeft];
      const cornerExclusions = cornerWells.map((well) => {
        const index = wells.indexOf(well);

        return {
          well,
          radius: index >= 0 ? exclusionRadii[index] : PHYSICAL_EXCLUSION_RADIUS_FACTOR * PHYSICAL_MOUTH_RADIUS_FACTOR_OF_PITCH * medianPitch,
        };
      });

      for (let canonicalY = 0; canonicalY < canonicalSize; canonicalY += canonicalStep) {
        for (let canonicalX = 0; canonicalX < canonicalSize; canonicalX += canonicalStep) {
          const canonical = {
            u: canonicalX / (canonicalSize - 1),
            v: canonicalY / (canonicalSize - 1),
          };

          if (!canonicalModelAllowsBackground(
            canonical.u,
            canonical.v,
            rForbiddenX,
            rForbiddenY,
            bridgeHalfW,
            bridgeHalfH,
          )) {
            continue;
          }

          cellDiagnostic.rawCanonicalMaskPixels += 1;

          const projected = applyHomography(homography, canonical.u, canonical.v);

          if (!projected) {
            continue;
          }

          const px = projected.u;
          const py = projected.v;
          cellDiagnostic.pixelsAfterWarpProjectToImage += 1;

          if (!isPointInPolygon(px, py, quad)) {
            continue;
          }
          cellDiagnostic.pixelsAfterCellPolygonIntersection += 1;

          const x = Math.round(px);
          const y = Math.round(py);

          if (x < 0 || x >= width || y < 0 || y >= height) {
            continue;
          }

          const pixelKey = `${x}:${y}`;

          if (seenPixels.has(pixelKey)) {
            continue;
          }

          let tooCloseToWell = false;

          for (let w = 0; w < wells.length; w += 1) {
            const well = wells[w];
            const dx = px - well.x;
            const dy = py - well.y;
            const radius = exclusionRadii[w];

            if (dx * dx + dy * dy <= radius * radius) {
              tooCloseToWell = true;
              break;
            }
          }

          if (tooCloseToWell) {
            continue;
          }

          seenPixels.add(pixelKey);
          const offset = (y * width + x) * 4;
          const rgb = {
            r: data[offset],
            g: data[offset + 1],
            b: data[offset + 2],
          };

          modelPixels.push({
            x: px,
            y: py,
            rgb,
            luminance: luminance(rgb),
            cellRow: row,
            cellCol: col,
            canonicalU: canonical.u,
            canonicalV: canonical.v,
          });
        }
      }

      const fullResolutionModelPixels: CandidatePixel[] = [];
      const fullX0 = Math.max(0, Math.floor(Math.min(...quad.map((point) => point.x))));
      const fullX1 = Math.min(width - 1, Math.ceil(Math.max(...quad.map((point) => point.x))));
      const fullY0 = Math.max(0, Math.floor(Math.min(...quad.map((point) => point.y))));
      const fullY1 = Math.min(height - 1, Math.ceil(Math.max(...quad.map((point) => point.y))));

      for (let y = fullY0; y <= fullY1; y += 1) {
        for (let x = fullX0; x <= fullX1; x += 1) {
          const px = x + 0.5;
          const py = y + 0.5;

          if (!isPointInPolygon(px, py, quad)) {
            continue;
          }

          const canonical = applyHomography(inverseHomography, px, py);

          if (!canonical) {
            continue;
          }

          if (!canonicalModelAllowsBackground(
            canonical.u,
            canonical.v,
            rForbiddenX,
            rForbiddenY,
            bridgeHalfW,
            bridgeHalfH,
          )) {
            continue;
          }

          let tooCloseToWell = false;

          for (const exclusion of cornerExclusions) {
            const dx = px - exclusion.well.x;
            const dy = py - exclusion.well.y;

            if (dx * dx + dy * dy <= exclusion.radius * exclusion.radius) {
              tooCloseToWell = true;
              break;
            }
          }

          if (tooCloseToWell) {
            continue;
          }

          const offset = (y * width + x) * 4;
          const rgb = {
            r: data[offset],
            g: data[offset + 1],
            b: data[offset + 2],
          };

          fullResolutionModelPixels.push({
            x: px,
            y: py,
            rgb,
            luminance: luminance(rgb),
            cellRow: row,
            cellCol: col,
            canonicalU: canonical.u,
            canonicalV: canonical.v,
          });
        }
      }

      cellDiagnostic.pixelsAfterWellDiskExclusion = modelPixels.length;
      rawPixels.push(...modelPixels);
      const refinedPixels = refinePhysicalCellCandidates(modelPixels);
      const fullResolutionRefinedPixels = refinePhysicalCellCandidates(fullResolutionModelPixels);
      const fullResolutionAcceptedPixels = robustFilterPhysicalCell(fullResolutionRefinedPixels);
      const fullResolutionStatsPixels = fullResolutionAcceptedPixels.length >= PHYSICAL_MIN_CELL_PIXELS
        ? fullResolutionAcceptedPixels
        : refinedPixels;
      pixels.push(...fullResolutionStatsPixels);
      cellDiagnostic.sampledFinalAcceptedPixels = refinedPixels.length;
      cellDiagnostic.fullResolutionPixelsAfterWellDiskExclusion = fullResolutionModelPixels.length;
      cellDiagnostic.fullResolutionRefinedBeforeMadPixels = fullResolutionRefinedPixels.length;
      cellDiagnostic.fullResolutionFinalAcceptedPixels = fullResolutionStatsPixels.length;
      cellDiagnostic.finalAcceptedPixels = fullResolutionStatsPixels.length;
      if (fullResolutionStatsPixels.length > 0) {
        cellDiagnostic.acceptedCentroidX = mean(fullResolutionStatsPixels.map((pixel) => pixel.x));
        cellDiagnostic.acceptedCentroidY = mean(fullResolutionStatsPixels.map((pixel) => pixel.y));
        cellDiagnostic.redMedianRaw = median(fullResolutionStatsPixels.map((pixel) => pixel.rgb.r));
        cellDiagnostic.greenMedianRaw = median(fullResolutionStatsPixels.map((pixel) => pixel.rgb.g));
        cellDiagnostic.blueMedianRaw = median(fullResolutionStatsPixels.map((pixel) => pixel.rgb.b));
      }
      cellDiagnostic.zeroReason = describeCellZeroReason(cellDiagnostic);
      cellDiagnostics.push(cellDiagnostic);
    }
  }

  return {
    collection: { pixels, rawPixels, stride: sampleStride },
    diagnostics: {
      candidatePixels: pixels.length,
      acceptedPixels: 0,
      acceptedSamples: 0,
      candidateStride: sampleStride,
      candidateRegionX0: regionX0,
      candidateRegionY0: regionY0,
      candidateRegionX1: regionX1,
      candidateRegionY1: regionY1,
      medianPitch,
      wellExclusionRadiusApprox,
      fitSuccess: false,
      maskAlgorithm: PHYSICAL_MASK_ALGORITHM,
      cellDiagnostics,
    },
  };
}

function filterCandidatePixels(pixels: CandidatePixel[]): CandidatePixel[] {
  if (pixels.length === 0) {
    return [];
  }

  const sortedLuminance = [...pixels].map((pixel) => pixel.luminance).sort((a, b) => a - b);
  const lowIndex = Math.floor(LABELED_PIXEL_PERCENTILE * (sortedLuminance.length - 1));
  const highIndex = Math.floor(HIGHLIGHT_PIXEL_PERCENTILE * (sortedLuminance.length - 1));
  const lowThreshold = sortedLuminance[Math.max(0, lowIndex)];
  const highThreshold = sortedLuminance[Math.min(sortedLuminance.length - 1, highIndex)];

  const medianRgbValue = medianRgb(pixels);

  return pixels.filter((pixel) => {
    if (pixel.luminance < lowThreshold || pixel.luminance > highThreshold) {
      return false;
    }

    if (
      Math.abs(pixel.rgb.r - medianRgbValue.r) > CHROMA_THRESHOLD ||
      Math.abs(pixel.rgb.g - medianRgbValue.g) > CHROMA_THRESHOLD ||
      Math.abs(pixel.rgb.b - medianRgbValue.b) > CHROMA_THRESHOLD
    ) {
      return false;
    }

    return true;
  });
}

function filterPhysicalCandidatePixels(
  pixels: CandidatePixel[],
): { pixels: CandidatePixel[]; warning?: string } {
  if (pixels.length === 0) {
    return { pixels: [] };
  }

  const medianRgbValue = medianRgb(pixels);
  const filterPasses = [
    { darkQ: 2, brightQ: 98, chroma: 96, warning: undefined },
    { darkQ: 1, brightQ: 99, chroma: 128, warning: 'Physical inter-well polynomial filters were relaxed to retain enough samples.' },
    { darkQ: 0.5, brightQ: 99.5, chroma: 192, warning: 'Physical inter-well polynomial filters were strongly relaxed to retain enough samples.' },
  ];

  for (const pass of filterPasses) {
    const luminanceValues = pixels.map((pixel) => pixel.luminance);
    const lowThreshold = percentile(luminanceValues, pass.darkQ);
    const highThreshold = percentile(luminanceValues, pass.brightQ);
    const selected = pixels.filter((pixel) => {
      if (pixel.luminance < lowThreshold || pixel.luminance > highThreshold) {
        return false;
      }

      return (
        Math.abs(pixel.rgb.r - medianRgbValue.r) <= pass.chroma &&
        Math.abs(pixel.rgb.g - medianRgbValue.g) <= pass.chroma &&
        Math.abs(pixel.rgb.b - medianRgbValue.b) <= pass.chroma
      );
    });

    if (selected.length >= PHYSICAL_MIN_ACCEPTED_PIXELS) {
      return { pixels: selected, warning: pass.warning };
    }
  }

  const luminanceValues = pixels.map((pixel) => pixel.luminance);
  const lowThreshold = percentile(luminanceValues, 0.5);
  const highThreshold = percentile(luminanceValues, 99.5);
  const luminanceOnly = pixels.filter((pixel) => pixel.luminance >= lowThreshold && pixel.luminance <= highThreshold);

  if (luminanceOnly.length >= PHYSICAL_MIN_ACCEPTED_PIXELS) {
    return {
      pixels: luminanceOnly,
      warning: 'Physical inter-well polynomial chroma filtering was disabled to retain enough samples.',
    };
  }

  return {
    pixels: luminanceOnly.length > 0 ? luminanceOnly : pixels,
    warning: 'Physical inter-well polynomial filters could not retain the preferred sample count.',
  };
}

function robustFilterPhysicalCell(pixels: CandidatePixel[]): CandidatePixel[] {
  if (pixels.length < PHYSICAL_MIN_CELL_PIXELS) {
    return [];
  }

  const luminanceValues = pixels.map((pixel) => pixel.luminance);
  const medianLuminance = median(luminanceValues);
  const mad = median(luminanceValues.map((value) => Math.abs(value - medianLuminance)));

  if (mad <= 1e-6) {
    return pixels;
  }

  const sigma = Math.max(1.4826 * mad, 1e-6);
  const low = medianLuminance - PHYSICAL_POLY_CLIP_K * sigma;
  const high = medianLuminance + PHYSICAL_POLY_CLIP_K * sigma;
  const filtered = pixels.filter((pixel) => pixel.luminance >= low && pixel.luminance <= high);

  return filtered.length >= PHYSICAL_MIN_CELL_PIXELS ? filtered : pixels;
}

function buildPhysicalCellSamples(pixels: CandidatePixel[]): PhysicalCellSample[] {
  if (pixels.some((pixel) => pixel.cellRow === undefined || pixel.cellCol === undefined)) {
    return pixels.map((pixel) => ({
      cellRow: pixel.cellRow ?? -1,
      cellColumn: pixel.cellCol ?? -1,
      x: pixel.x,
      y: pixel.y,
      r: pixel.rgb.r,
      g: pixel.rgb.g,
      b: pixel.rgb.b,
      area: 1,
    }));
  }

  const groups = new Map<string, CandidatePixel[]>();

  pixels.forEach((pixel) => {
    if (pixel.cellRow === undefined || pixel.cellCol === undefined) {
      return;
    }

    const key = `${pixel.cellRow}:${pixel.cellCol}`;
    const group = groups.get(key);

    if (group) {
      group.push(pixel);
    } else {
      groups.set(key, [pixel]);
    }
  });

  const samples: PhysicalCellSample[] = [];

  groups.forEach((group) => {
    const selected = robustFilterPhysicalCell(group);

    if (selected.length < PHYSICAL_MIN_CELL_PIXELS) {
      return;
    }

    samples.push({
      cellRow: group[0].cellRow as number,
      cellColumn: group[0].cellCol as number,
      x: mean(selected.map((pixel) => pixel.x)),
      y: mean(selected.map((pixel) => pixel.y)),
      r: median(selected.map((pixel) => pixel.rgb.r)),
      g: median(selected.map((pixel) => pixel.rgb.g)),
      b: median(selected.map((pixel) => pixel.rgb.b)),
      area: selected.length,
    });
  });

  return samples;
}

function updateCellDiagnosticsWithSamples(
  diagnostics: BackgroundCellDiagnostic[] | undefined,
  samples: PhysicalCellSample[],
): BackgroundCellDiagnostic[] {
  const sampleByCell = new Map(samples.map((sample) => [cellKey(sample.cellRow, sample.cellColumn), sample]));

  return (diagnostics ?? []).map((diagnostic) => {
    const key = cellKey(diagnostic.cellRow, diagnostic.cellColumn);
    const sample = sampleByCell.get(key);

    if (!sample) {
      return diagnostic;
    }

    const nextDiagnostic = {
      ...diagnostic,
      sampledFinalAcceptedPixels: sample.area,
      finalAcceptedPixels: diagnostic.fullResolutionFinalAcceptedPixels ?? diagnostic.finalAcceptedPixels ?? sample.area,
      acceptedCentroidX: diagnostic.acceptedCentroidX ?? sample.x,
      acceptedCentroidY: diagnostic.acceptedCentroidY ?? sample.y,
      redMedianRaw: diagnostic.redMedianRaw ?? sample.r,
      greenMedianRaw: diagnostic.greenMedianRaw ?? sample.g,
      blueMedianRaw: diagnostic.blueMedianRaw ?? sample.b,
    };

    return {
      ...nextDiagnostic,
      zeroReason: describeCellZeroReason(nextDiagnostic),
    };
  });
}

function poly2Design(xn: number, yn: number): number[] {
  return [1, xn, yn, xn * xn, xn * yn, yn * yn];
}

function solveLinearSystem(matrix: number[][], vector: number[]): number[] | null {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);

  for (let col = 0; col < size; col += 1) {
    let pivotRow = col;
    let pivotAbs = Math.abs(augmented[col][col]);

    for (let row = col + 1; row < size; row += 1) {
      const valueAbs = Math.abs(augmented[row][col]);

      if (valueAbs > pivotAbs) {
        pivotAbs = valueAbs;
        pivotRow = row;
      }
    }

    if (pivotAbs < 1e-10) {
      return null;
    }

    if (pivotRow !== col) {
      [augmented[col], augmented[pivotRow]] = [augmented[pivotRow], augmented[col]];
    }

    const pivot = augmented[col][col];

    for (let entry = col; entry <= size; entry += 1) {
      augmented[col][entry] /= pivot;
    }

    for (let row = 0; row < size; row += 1) {
      if (row === col) {
        continue;
      }

      const factor = augmented[row][col];

      for (let entry = col; entry <= size; entry += 1) {
        augmented[row][entry] -= factor * augmented[col][entry];
      }
    }
  }

  return augmented.map((row) => row[size]);
}

function fitLeastSquares(samples: PhysicalCellSample[], channel: 'r' | 'g' | 'b', modelSeed: Omit<Poly2Model, 'coef'>): number[] | null {
  if (samples.length < PHYSICAL_POLY_COEFFICIENTS) {
    return null;
  }

  const ata = Array.from({ length: PHYSICAL_POLY_COEFFICIENTS }, () => Array(PHYSICAL_POLY_COEFFICIENTS).fill(0));
  const atb = Array(PHYSICAL_POLY_COEFFICIENTS).fill(0);

  samples.forEach((sample) => {
    const xn = (sample.x - modelSeed.x0) / modelSeed.sx;
    const yn = (sample.y - modelSeed.y0) / modelSeed.sy;
    const design = poly2Design(xn, yn);
    const value = sample[channel];

    for (let row = 0; row < PHYSICAL_POLY_COEFFICIENTS; row += 1) {
      atb[row] += design[row] * value;

      for (let col = 0; col < PHYSICAL_POLY_COEFFICIENTS; col += 1) {
        ata[row][col] += design[row] * design[col];
      }
    }
  });

  for (let diagonal = 0; diagonal < PHYSICAL_POLY_COEFFICIENTS; diagonal += 1) {
    ata[diagonal][diagonal] += 1e-8;
  }

  return solveLinearSystem(ata, atb);
}

function evaluatePoly2(model: Poly2Model, x: number, y: number): number {
  const xn = (x - model.x0) / model.sx;
  const yn = (y - model.y0) / model.sy;
  const design = poly2Design(xn, yn);

  return design.reduce((sum, value, index) => sum + value * model.coef[index], 0);
}

function fitPoly2Robust(samples: PhysicalCellSample[], channel: 'r' | 'g' | 'b'): Poly2Model | null {
  const finiteSamples = samples.filter((sample) => Number.isFinite(sample[channel]));

  if (finiteSamples.length < PHYSICAL_MIN_POLY_SAMPLES) {
    return null;
  }

  const seed = {
    x0: mean(finiteSamples.map((sample) => sample.x)),
    y0: mean(finiteSamples.map((sample) => sample.y)),
    sx: standardDeviation(finiteSamples.map((sample) => sample.x)),
    sy: standardDeviation(finiteSamples.map((sample) => sample.y)),
  };

  let keep = finiteSamples.map(() => true);
  let coef: number[] | null = null;

  for (let iteration = 0; iteration < PHYSICAL_POLY_MAX_ITERATIONS; iteration += 1) {
    const selected = finiteSamples.filter((_, index) => keep[index]);

    if (selected.length < PHYSICAL_POLY_COEFFICIENTS) {
      break;
    }

    const nextCoef = fitLeastSquares(selected, channel, seed);

    if (!nextCoef) {
      return null;
    }

    coef = nextCoef;

    const model = { ...seed, coef };
    const residuals = selected.map((sample) => sample[channel] - evaluatePoly2(model, sample.x, sample.y));
    const residualMedian = median(residuals);
    const residualMad = median(residuals.map((residual) => Math.abs(residual - residualMedian)));

    if (residualMad <= 1e-6) {
      break;
    }

    const sigma = Math.max(1.4826 * residualMad, 1e-6);
    const selectedIndexes = keep
      .map((isKept, index) => (isKept ? index : -1))
      .filter((index) => index >= 0);
    const nextKeep = [...keep];

    selectedIndexes.forEach((sampleIndex, residualIndex) => {
      nextKeep[sampleIndex] = Math.abs(residuals[residualIndex] - residualMedian) <= PHYSICAL_POLY_CLIP_K * sigma;
    });

    if (nextKeep.filter(Boolean).length < PHYSICAL_POLY_COEFFICIENTS) {
      break;
    }

    if (nextKeep.every((value, index) => value === keep[index])) {
      break;
    }

    keep = nextKeep;
  }

  return coef ? { ...seed, coef } : null;
}

function fitPoly2RobustTrace(samples: PhysicalCellSample[], channel: 'r' | 'g' | 'b'): Poly2FitTrace {
  const finiteSamples = samples.filter((sample) => Number.isFinite(sample[channel]));

  if (finiteSamples.length < PHYSICAL_MIN_POLY_SAMPLES) {
    return {
      model: null,
      samplesTotal: finiteSamples.length,
      samplesRetained: 0,
      samplesRejected: finiteSamples.length,
      residualMedian: Number.NaN,
      residualMad: Number.NaN,
      residualSigma: Number.NaN,
      residualMaxAbs: Number.NaN,
    };
  }

  const seed = {
    x0: mean(finiteSamples.map((sample) => sample.x)),
    y0: mean(finiteSamples.map((sample) => sample.y)),
    sx: standardDeviation(finiteSamples.map((sample) => sample.x)),
    sy: standardDeviation(finiteSamples.map((sample) => sample.y)),
  };

  let keep = finiteSamples.map(() => true);
  let coef: number[] | null = null;

  for (let iteration = 0; iteration < PHYSICAL_POLY_MAX_ITERATIONS; iteration += 1) {
    const selected = finiteSamples.filter((_, index) => keep[index]);

    if (selected.length < PHYSICAL_POLY_COEFFICIENTS) {
      break;
    }

    const nextCoef = fitLeastSquares(selected, channel, seed);

    if (!nextCoef) {
      return {
        model: null,
        samplesTotal: finiteSamples.length,
        samplesRetained: 0,
        samplesRejected: finiteSamples.length,
        residualMedian: Number.NaN,
        residualMad: Number.NaN,
        residualSigma: Number.NaN,
        residualMaxAbs: Number.NaN,
      };
    }

    coef = nextCoef;

    const model = { ...seed, coef };
    const residuals = selected.map((sample) => sample[channel] - evaluatePoly2(model, sample.x, sample.y));
    const residualMedian = median(residuals);
    const residualMad = median(residuals.map((residual) => Math.abs(residual - residualMedian)));

    if (residualMad <= 1e-6) {
      break;
    }

    const sigma = Math.max(1.4826 * residualMad, 1e-6);
    const selectedIndexes = keep
      .map((isKept, index) => (isKept ? index : -1))
      .filter((index) => index >= 0);
    const nextKeep = [...keep];

    selectedIndexes.forEach((sampleIndex, residualIndex) => {
      nextKeep[sampleIndex] = Math.abs(residuals[residualIndex] - residualMedian) <= PHYSICAL_POLY_CLIP_K * sigma;
    });

    if (nextKeep.filter(Boolean).length < PHYSICAL_POLY_COEFFICIENTS) {
      break;
    }

    if (nextKeep.every((value, index) => value === keep[index])) {
      break;
    }

    keep = nextKeep;
  }

  if (!coef) {
    return {
      model: null,
      samplesTotal: finiteSamples.length,
      samplesRetained: 0,
      samplesRejected: finiteSamples.length,
      residualMedian: Number.NaN,
      residualMad: Number.NaN,
      residualSigma: Number.NaN,
      residualMaxAbs: Number.NaN,
    };
  }

  const model = { ...seed, coef };
  const selected = finiteSamples.filter((_, index) => keep[index]);
  const residuals = selected.map((sample) => sample[channel] - evaluatePoly2(model, sample.x, sample.y));
  const residualMedian = residuals.length > 0 ? median(residuals) : Number.NaN;
  const residualMad = residuals.length > 0 ? median(residuals.map((residual) => Math.abs(residual - residualMedian))) : Number.NaN;
  const residualSigma = Number.isFinite(residualMad) ? Math.max(1.4826 * residualMad, 1e-6) : Number.NaN;
  const residualMaxAbs = residuals.length > 0 ? Math.max(...residuals.map((residual) => Math.abs(residual))) : Number.NaN;

  return {
    model,
    samplesTotal: finiteSamples.length,
    samplesRetained: selected.length,
    samplesRejected: finiteSamples.length - selected.length,
    residualMedian,
    residualMad,
    residualSigma,
    residualMaxAbs,
  };
}

function buildPhysicalModelProofDiagnostics(
  wells: WellCenter[],
  samples: PhysicalCellSample[],
  modelR: Poly2Model,
  modelG: Poly2Model,
  modelB: Poly2Model,
): PhysicalModelProofDiagnostics {
  const traceR = fitPoly2RobustTrace(samples, 'r');
  const traceG = fitPoly2RobustTrace(samples, 'g');
  const traceB = fitPoly2RobustTrace(samples, 'b');
  const fitInputs: PhysicalModelFitInputRow[] = samples.map((sample) => ({
    cellRow: sample.cellRow,
    cellColumn: sample.cellColumn,
    x: sample.x,
    y: sample.y,
    area: sample.area,
    redMedianRaw: sample.r,
    greenMedianRaw: sample.g,
    blueMedianRaw: sample.b,
  }));

  const channelFits: PhysicalModelChannelFitDiagnostic[] = [
    {
      channel: 'red',
      basisOrder: PHYSICAL_POLY_BASIS_ORDER,
      x0: modelR.x0,
      y0: modelR.y0,
      sx: modelR.sx,
      sy: modelR.sy,
      coefficients: [...modelR.coef],
      samplesTotal: traceR.samplesTotal,
      samplesRetained: traceR.samplesRetained,
      samplesRejected: traceR.samplesRejected,
      residualMedian: traceR.residualMedian,
      residualMad: traceR.residualMad,
      residualSigma: traceR.residualSigma,
      residualMaxAbs: traceR.residualMaxAbs,
    },
    {
      channel: 'green',
      basisOrder: PHYSICAL_POLY_BASIS_ORDER,
      x0: modelG.x0,
      y0: modelG.y0,
      sx: modelG.sx,
      sy: modelG.sy,
      coefficients: [...modelG.coef],
      samplesTotal: traceG.samplesTotal,
      samplesRetained: traceG.samplesRetained,
      samplesRejected: traceG.samplesRejected,
      residualMedian: traceG.residualMedian,
      residualMad: traceG.residualMad,
      residualSigma: traceG.residualSigma,
      residualMaxAbs: traceG.residualMaxAbs,
    },
    {
      channel: 'blue',
      basisOrder: PHYSICAL_POLY_BASIS_ORDER,
      x0: modelB.x0,
      y0: modelB.y0,
      sx: modelB.sx,
      sy: modelB.sy,
      coefficients: [...modelB.coef],
      samplesTotal: traceB.samplesTotal,
      samplesRetained: traceB.samplesRetained,
      samplesRejected: traceB.samplesRejected,
      residualMedian: traceB.residualMedian,
      residualMad: traceB.residualMad,
      residualSigma: traceB.residualSigma,
      residualMaxAbs: traceB.residualMaxAbs,
    },
  ];

  const wellPredictions: PhysicalModelWellPredictionRow[] = wells.map((well) => ({
    row: well.row,
    col: well.col,
    wellId: well.wellId,
    x: well.x,
    y: well.y,
    bgRedRawModel: evaluatePoly2(modelR, well.x, well.y),
    bgGreenRawModel: evaluatePoly2(modelG, well.x, well.y),
    bgBlueRawModel: evaluatePoly2(modelB, well.x, well.y),
  }));

  return {
    basisOrder: PHYSICAL_POLY_BASIS_ORDER,
    fitInputs,
    channelFits,
    wellPredictions,
  };
}

function diagnosticPointsFromCandidates(pixels: CandidatePixel[]): BackgroundDiagnosticPoint[] {
  return pixels.map((pixel) => ({ x: pixel.x, y: pixel.y }));
}

function diagnosticPointsFromSamples(samples: PhysicalCellSample[]): BackgroundDiagnosticPoint[] {
  return samples.map((sample) => ({ x: sample.x, y: sample.y }));
}

function cellKey(row: number, col: number): string {
  return `${row}:${col}`;
}

function countPixelsByCell(pixels: CandidatePixel[]): Map<string, number> {
  const counts = new Map<string, number>();

  pixels.forEach((pixel) => {
    if (pixel.cellRow === undefined || pixel.cellCol === undefined) {
      return;
    }

    const key = cellKey(pixel.cellRow, pixel.cellCol);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });

  return counts;
}

function finalAcceptedPixelsByCell(pixels: CandidatePixel[]): Map<string, number> {
  const groups = new Map<string, CandidatePixel[]>();

  pixels.forEach((pixel) => {
    if (pixel.cellRow === undefined || pixel.cellCol === undefined) {
      return;
    }

    const key = cellKey(pixel.cellRow, pixel.cellCol);
    const group = groups.get(key);

    if (group) {
      group.push(pixel);
    } else {
      groups.set(key, [pixel]);
    }
  });

  const counts = new Map<string, number>();

  groups.forEach((group, key) => {
    const selected = robustFilterPhysicalCell(group);
    counts.set(key, selected.length >= PHYSICAL_MIN_CELL_PIXELS ? selected.length : 0);
  });

  return counts;
}

function updateCellDiagnosticsAfterFiltering(
  diagnostics: BackgroundCellDiagnostic[] | undefined,
  filteredPixels: CandidatePixel[],
): BackgroundCellDiagnostic[] {
  const luminanceChromaCounts = countPixelsByCell(filteredPixels);
  const finalCounts = finalAcceptedPixelsByCell(filteredPixels);

  return (diagnostics ?? []).map((diagnostic) => {
    const key = cellKey(diagnostic.cellRow, diagnostic.cellColumn);
    const sampledFinalAcceptedPixels = finalCounts.get(key) ?? 0;
    const nextDiagnostic = {
      ...diagnostic,
      pixelsAfterLuminanceChromaFiltering: luminanceChromaCounts.get(key) ?? 0,
      sampledFinalAcceptedPixels,
      finalAcceptedPixels: diagnostic.fullResolutionFinalAcceptedPixels ?? diagnostic.finalAcceptedPixels ?? sampledFinalAcceptedPixels,
    };

    return {
      ...nextDiagnostic,
      zeroReason: describeCellZeroReason(nextDiagnostic),
    };
  });
}

function summarizeCellDiagnosticsFailure(diagnostics: BackgroundCellDiagnostic[] | undefined): string {
  const cells = diagnostics ?? [];

  if (cells.length === 0) {
    return 'no physical inter-well cell diagnostics were generated';
  }

  const zeroReasonCounts = new Map<string, number>();

  cells.forEach((cell) => {
    if (cell.zeroReason.trim() === '') {
      return;
    }

    zeroReasonCounts.set(cell.zeroReason, (zeroReasonCounts.get(cell.zeroReason) ?? 0) + 1);
  });

  if (zeroReasonCounts.size === 0) {
    const finalCells = cells.filter((cell) => cell.finalAcceptedPixels >= PHYSICAL_MIN_CELL_PIXELS).length;
    return `${finalCells}/${cells.length} cells retained at least ${PHYSICAL_MIN_CELL_PIXELS} final pixels`;
  }

  const dominant = [...zeroReasonCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  return `${dominant[1]}/${cells.length} cells report: ${dominant[0]}`;
}

function buildPredictedRgbMap(
  diagnostics: BackgroundDiagnostics,
  modelR: Poly2Model,
  modelG: Poly2Model,
  modelB: Poly2Model,
): BackgroundRgbMapCell[] {
  const regionX0 = diagnostics.candidateRegionX0;
  const regionY0 = diagnostics.candidateRegionY0;
  const regionX1 = diagnostics.candidateRegionX1;
  const regionY1 = diagnostics.candidateRegionY1;

  if (regionX1 <= regionX0 || regionY1 <= regionY0) {
    return [];
  }

  const step = Math.max(8, diagnostics.candidateStride * 4);
  const cells: BackgroundRgbMapCell[] = [];

  for (let y = regionY0; y <= regionY1; y += step) {
    for (let x = regionX0; x <= regionX1; x += step) {
      cells.push({
        x,
        y,
        size: step,
        rgb: {
          r: clampRgb(evaluatePoly2(modelR, x, y)),
          g: clampRgb(evaluatePoly2(modelG, x, y)),
          b: clampRgb(evaluatePoly2(modelB, x, y)),
        },
      });
    }
  }

  return cells;
}

function estimateLocalInterwellBackground(
  candidates: CandidatePixel[],
  well: WellCenter,
  pitch: number,
): { pixels: CandidatePixel[]; usedRadius: number } {
  const searchRadius = 2.0 * pitch;
  const expandedRadius = 3.5 * pitch;

  const withinRadius = (radius: number): CandidatePixel[] => {
    const radiusSquared = radius * radius;
    return candidates.filter((pixel) => {
      const dx = pixel.x - well.x;
      const dy = pixel.y - well.y;
      return dx * dx + dy * dy <= radiusSquared;
    });
  };

  let selected = withinRadius(searchRadius);

  if (selected.length >= MIN_BACKGROUND_PIXELS) {
    return { pixels: selected, usedRadius: searchRadius };
  }

  selected = withinRadius(expandedRadius);

  return { pixels: selected, usedRadius: expandedRadius };
}

export function estimateRobustInterwellBackground(
  imageData: ImageData,
  wells: WellCenter[],
  geometry: PlateGeometry,
  cx: number,
  cy: number,
  roiRadius: number,
  pitch: number,
  floorCircles?: FloorCircle[],
  wellExclusionRadiiByWell?: WellExclusionRadiusMap,
): BackgroundEstimate {
  // compute median pitch and expanded bounding box used for candidate region
  const pitches = wells.map((well) => estimateLocalPitch(wells, well.row, well.col));
  const medianPitch = median(pitches);

  let regionX0 = Math.max(0, Math.floor(Math.min(...wells.map((w) => w.x))));
  let regionX1 = Math.min(imageData.width - 1, Math.ceil(Math.max(...wells.map((w) => w.x))));
  let regionY0 = Math.max(0, Math.floor(Math.min(...wells.map((w) => w.y))));
  let regionY1 = Math.min(imageData.height - 1, Math.ceil(Math.max(...wells.map((w) => w.y))));

  const expand = 0.75 * medianPitch;
  regionX0 = Math.max(0, Math.floor(regionX0 - expand));
  regionX1 = Math.min(imageData.width - 1, Math.ceil(regionX1 + expand));
  regionY0 = Math.max(0, Math.floor(regionY0 - expand));
  regionY1 = Math.min(imageData.height - 1, Math.ceil(regionY1 + expand));

  const overrideExclusionRadii = wells
    .map((well) => wellExclusionRadiiByWell?.get(well.wellId) ?? Number.NaN)
    .filter((radius) => Number.isFinite(radius) && radius > 0);
  const wellExclusionRadiusApprox = overrideExclusionRadii.length > 0
    ? median(overrideExclusionRadii)
    : 0.35 * medianPitch;

  const candidatesCollection = createInterwellCandidates(imageData, wells, geometry, floorCircles, wellExclusionRadiiByWell);
  const totalCandidatePixels = candidatesCollection.pixels.length;
  const candidateStride = candidatesCollection.stride;
  const candidates = candidatesCollection.pixels;

  if (candidates.length < MIN_BACKGROUND_PIXELS) {
    const annular = estimateLocalBackground(imageData, cx, cy, roiRadius, pitch);
    return {
      rgbBackground: {
        r: annular.r,
        g: annular.g,
        b: annular.b,
      },
      bgPixels: annular.pixels,
      warnings: [
        'Annular fallback used because robust inter-well background could not find enough inter-well pixels.',
        ...annular.warnings,
      ],
      outcome: 'annular',
      candidatePixels: totalCandidatePixels,
      acceptedPixels: 0,
      candidateStride,
      candidateRegionX0: regionX0,
      candidateRegionY0: regionY0,
      candidateRegionX1: regionX1,
      candidateRegionY1: regionY1,
      medianPitch,
      wellExclusionRadiusApprox,
    };
  }

  const filtered = filterCandidatePixels(candidates);
  const acceptedPixels = filtered.length;

  if (filtered.length < MIN_BACKGROUND_PIXELS) {
    const annular = estimateLocalBackground(imageData, cx, cy, roiRadius, pitch);
    return {
      rgbBackground: {
        r: annular.r,
        g: annular.g,
        b: annular.b,
      },
      bgPixels: annular.pixels,
      warnings: [
        'Robust inter-well background found too few accepted pixels; annular fallback may dominate.',
        'Annular fallback used due to overly aggressive inter-well candidate filtering.',
        ...annular.warnings,
      ],
      outcome: 'annular',
      candidatePixels: totalCandidatePixels,
      acceptedPixels: acceptedPixels,
      candidateStride,
      candidateRegionX0: regionX0,
      candidateRegionY0: regionY0,
      candidateRegionX1: regionX1,
      candidateRegionY1: regionY1,
      medianPitch,
      wellExclusionRadiusApprox,
    };
  }

  const globalMedian = medianRgb(filtered);

  const local = estimateLocalInterwellBackground(filtered, { x: cx, y: cy, row: 0, col: 0, wellId: '' }, pitch);

  if (local.pixels.length >= MIN_BACKGROUND_PIXELS) {
    const outcome = local.usedRadius <= 2.0 * pitch ? 'local' : 'expanded';
    return {
      rgbBackground: medianRgb(local.pixels),
      bgPixels: local.pixels.length,
      warnings: [
        outcome === 'local' ? 'Robust local background used.' : 'Robust expanded background used.',
      ],
      outcome,
      candidatePixels: totalCandidatePixels,
      acceptedPixels: acceptedPixels,
      candidateStride,
      candidateRegionX0: regionX0,
      candidateRegionY0: regionY0,
      candidateRegionX1: regionX1,
      candidateRegionY1: regionY1,
      medianPitch,
      wellExclusionRadiusApprox,
    };
  }

  if (filtered.length >= MIN_BACKGROUND_PIXELS) {
    return {
      rgbBackground: globalMedian,
      bgPixels: filtered.length,
      warnings: [
        `Robust global fallback used after too few local pixels (${local.pixels.length}).`,
      ],
      outcome: 'global',
      candidatePixels: totalCandidatePixels,
      acceptedPixels: acceptedPixels,
      candidateStride,
      candidateRegionX0: regionX0,
      candidateRegionY0: regionY0,
      candidateRegionX1: regionX1,
      candidateRegionY1: regionY1,
      medianPitch,
      wellExclusionRadiusApprox,
    };
  }

  const annular = estimateLocalBackground(imageData, cx, cy, roiRadius, pitch);
  return {
    rgbBackground: {
      r: annular.r,
      g: annular.g,
      b: annular.b,
    },
    bgPixels: annular.pixels,
    warnings: [
      'Robust inter-well background fallback to annular background due to insufficient pixels.',
      ...annular.warnings,
    ],
    outcome: 'annular',
    candidatePixels: totalCandidatePixels,
    acceptedPixels: acceptedPixels,
    candidateStride,
    candidateRegionX0: regionX0,
    candidateRegionY0: regionY0,
    candidateRegionX1: regionX1,
    candidateRegionY1: regionY1,
    medianPitch,
    wellExclusionRadiusApprox,
  };
}

function physicalFallbackResult(diagnostics: BackgroundDiagnostics, fallbackWarning: string): PhysicalPolynomialBackgroundResult {
  return {
    estimatesByWell: new Map(),
    diagnostics: {
      ...diagnostics,
      fitSuccess: false,
    },
    fallbackWarning,
  };
}

export function estimatePhysicalInterwellPolynomialBackgrounds(
  imageData: ImageData,
  wells: WellCenter[],
  floorCircles?: FloorCircle[],
  wellExclusionRadiiByWell?: WellExclusionRadiusMap,
): PhysicalPolynomialBackgroundResult {
  const { collection, diagnostics } = createPhysicalInterwellCandidates(imageData, wells, floorCircles, wellExclusionRadiiByWell);

  if (collection.pixels.length < PHYSICAL_MIN_CANDIDATE_PIXELS) {
    return physicalFallbackResult(
      diagnostics,
      `Physical inter-well polynomial background found too few candidate pixels; ${summarizeCellDiagnosticsFailure(diagnostics.cellDiagnostics)}; falling back to robust inter-well background v1.`,
    );
  }

  const filteredResult = filterPhysicalCandidatePixels(collection.pixels);
  const filtered = filteredResult.pixels;
  const cellDiagnosticsAfterFiltering = updateCellDiagnosticsAfterFiltering(diagnostics.cellDiagnostics, filtered);
  const diagnosticsWithAccepted = {
    ...diagnostics,
    acceptedPixels: filtered.length,
    cellDiagnostics: cellDiagnosticsAfterFiltering,
  };

  if (filtered.length < PHYSICAL_MIN_ACCEPTED_PIXELS) {
    return physicalFallbackResult(
      diagnosticsWithAccepted,
      `Physical inter-well polynomial background found too few accepted pixels after robust filtering; ${summarizeCellDiagnosticsFailure(diagnosticsWithAccepted.cellDiagnostics)}; falling back to robust inter-well background v1.`,
    );
  }

  const samples = buildPhysicalCellSamples(filtered);
  const cellDiagnosticsWithSamples = updateCellDiagnosticsWithSamples(cellDiagnosticsAfterFiltering, samples);
  const diagnosticsWithSamples = {
    ...diagnosticsWithAccepted,
    acceptedSamples: samples.length,
    cellDiagnostics: cellDiagnosticsWithSamples,
  };

  if (samples.length < PHYSICAL_MIN_POLY_SAMPLES) {
    return physicalFallbackResult(
      diagnosticsWithSamples,
      `Physical inter-well polynomial background found too few inter-well samples for a quadratic fit; ${summarizeCellDiagnosticsFailure(diagnosticsWithSamples.cellDiagnostics)}; falling back to robust inter-well background v1.`,
    );
  }

  const modelR = fitPoly2Robust(samples, 'r');
  const modelG = fitPoly2Robust(samples, 'g');
  const modelB = fitPoly2Robust(samples, 'b');

  if (!modelR || !modelG || !modelB) {
    return physicalFallbackResult(
      diagnosticsWithSamples,
      'Physical inter-well polynomial background fit failed; falling back to robust inter-well background v1.',
    );
  }

  const estimatesByWell = new Map<string, BackgroundEstimateWithModel>();
  const fitDiagnostics = {
    ...diagnosticsWithSamples,
    fitSuccess: true,
  };

  wells.forEach((well) => {
    const rgbBackground = {
      r: clampRgb(evaluatePoly2(modelR, well.x, well.y)),
      g: clampRgb(evaluatePoly2(modelG, well.x, well.y)),
      b: clampRgb(evaluatePoly2(modelB, well.x, well.y)),
    };

    if (!isFiniteRgb(rgbBackground)) {
      return;
    }

    estimatesByWell.set(well.wellId, {
      rgbBackground,
      bgPixels: samples.length,
      warnings: filteredResult.warning ? [filteredResult.warning] : [],
      outcome: 'physical-polynomial',
      backgroundModel: 'physical-interwell-polynomial-v1',
      actualModel: 'physical-interwell-polynomial-v1',
      backgroundWarning: filteredResult.warning ?? '',
      ...fitDiagnostics,
      backgroundFitSuccess: true,
    });
  });

  if (estimatesByWell.size !== wells.length) {
    return physicalFallbackResult(
      fitDiagnostics,
      'Physical inter-well polynomial background produced invalid RGB predictions; falling back to robust inter-well background v1.',
    );
  }

  return {
    estimatesByWell,
    diagnostics: fitDiagnostics,
    filterWarning: filteredResult.warning,
  };
}

export function buildBackgroundVisualDiagnostics(
  imageData: ImageData,
  wells: WellCenter[],
  geometry: PlateGeometry,
  backgroundModel: BackgroundModel,
  floorCircles?: FloorCircle[],
  wellExclusionRadiiByWell?: WellExclusionRadiusMap,
): BackgroundVisualDiagnostics {
  if (backgroundModel === 'physical-interwell-polynomial-v1') {
    const { collection, diagnostics } = createPhysicalInterwellCandidates(imageData, wells, floorCircles, wellExclusionRadiiByWell);
    const filteredResult = filterPhysicalCandidatePixels(collection.pixels);
    const samples = buildPhysicalCellSamples(filteredResult.pixels);
    const cellDiagnosticsAfterFiltering = updateCellDiagnosticsAfterFiltering(diagnostics.cellDiagnostics, filteredResult.pixels);
    const cellDiagnosticsWithSamples = updateCellDiagnosticsWithSamples(cellDiagnosticsAfterFiltering, samples);
    const diagnosticsWithSamples = {
      ...diagnostics,
      acceptedPixels: filteredResult.pixels.length,
      acceptedSamples: samples.length,
      cellDiagnostics: cellDiagnosticsWithSamples,
    };
    const modelR = samples.length >= PHYSICAL_MIN_POLY_SAMPLES ? fitPoly2Robust(samples, 'r') : null;
    const modelG = samples.length >= PHYSICAL_MIN_POLY_SAMPLES ? fitPoly2Robust(samples, 'g') : null;
    const modelB = samples.length >= PHYSICAL_MIN_POLY_SAMPLES ? fitPoly2Robust(samples, 'b') : null;
    const fitSuccess = Boolean(
      collection.pixels.length >= PHYSICAL_MIN_CANDIDATE_PIXELS &&
      filteredResult.pixels.length >= PHYSICAL_MIN_ACCEPTED_PIXELS &&
      samples.length >= PHYSICAL_MIN_POLY_SAMPLES &&
      modelR &&
      modelG &&
      modelB,
    );
    const finalDiagnostics = {
      ...diagnosticsWithSamples,
      fitSuccess,
    };
    const warning = !fitSuccess
      ? `Physical inter-well polynomial background visual diagnostic could not fit an RGB surface; ${summarizeCellDiagnosticsFailure(finalDiagnostics.cellDiagnostics)}.`
      : filteredResult.warning;
    const physicalModelProof = modelR && modelG && modelB
      ? buildPhysicalModelProofDiagnostics(wells, samples, modelR, modelG, modelB)
      : undefined;

    return {
      selectedModel: backgroundModel,
      actualModel: fitSuccess ? 'physical-interwell-polynomial-v1' : undefined,
      rawCandidatePixels: diagnosticPointsFromCandidates(collection.rawPixels),
      candidatePixels: diagnosticPointsFromCandidates(collection.pixels),
      acceptedPixels: diagnosticPointsFromCandidates(filteredResult.pixels),
      samplePixels: diagnosticPointsFromSamples(samples),
      diagnostics: finalDiagnostics,
      warning,
      predictedRgbMap: modelR && modelG && modelB
        ? buildPredictedRgbMap(finalDiagnostics, modelR, modelG, modelB)
        : undefined,
      physicalModelProof,
    };
  }

  if (backgroundModel === 'robust-interwell-v1') {
    const collection = createInterwellCandidates(imageData, wells, geometry, floorCircles, wellExclusionRadiiByWell);
    const accepted = filterCandidatePixels(collection.pixels);
    const pitches = wells.map((well) => estimateLocalPitch(wells, well.row, well.col));
    const medianPitch = median(pitches);
    const candidateXs = collection.pixels.map((pixel) => pixel.x);
    const candidateYs = collection.pixels.map((pixel) => pixel.y);
    const overrideExclusionRadii = wells
      .map((well) => wellExclusionRadiiByWell?.get(well.wellId) ?? Number.NaN)
      .filter((radius) => Number.isFinite(radius) && radius > 0);
    const diagnostics: BackgroundDiagnostics = {
      candidatePixels: collection.pixels.length,
      acceptedPixels: accepted.length,
      acceptedSamples: accepted.length,
      candidateStride: collection.stride,
      candidateRegionX0: candidateXs.length > 0 ? Math.floor(Math.min(...candidateXs)) : 0,
      candidateRegionY0: candidateYs.length > 0 ? Math.floor(Math.min(...candidateYs)) : 0,
      candidateRegionX1: candidateXs.length > 0 ? Math.ceil(Math.max(...candidateXs)) : 0,
      candidateRegionY1: candidateYs.length > 0 ? Math.ceil(Math.max(...candidateYs)) : 0,
      medianPitch,
      wellExclusionRadiusApprox: overrideExclusionRadii.length > 0 ? median(overrideExclusionRadii) : 0.35 * medianPitch,
      fitSuccess: false,
    };

    return {
      selectedModel: backgroundModel,
      actualModel: 'robust-interwell-v1',
      rawCandidatePixels: diagnosticPointsFromCandidates(collection.rawPixels),
      candidatePixels: diagnosticPointsFromCandidates(collection.pixels),
      acceptedPixels: diagnosticPointsFromCandidates(accepted),
      samplePixels: [],
      diagnostics,
    };
  }

  return {
    selectedModel: backgroundModel,
    actualModel: 'annular',
    rawCandidatePixels: [],
    candidatePixels: [],
    acceptedPixels: [],
    samplePixels: [],
    diagnostics: createEmptyDiagnostics(),
    warning: 'Annular background diagnostic shows annuli from well geometry rather than inter-well candidate pixels.',
  };
}

export function estimateBackground(
  imageData: ImageData,
  wells: WellCenter[],
  geometry: PlateGeometry,
  cx: number,
  cy: number,
  roiRadius: number,
  pitch: number,
  backgroundModel: BackgroundModel,
  floorCircles?: FloorCircle[],
  wellExclusionRadiiByWell?: WellExclusionRadiusMap,
): BackgroundEstimateWithModel {
  if (backgroundModel === 'annular') {
    const stats = estimateLocalBackground(imageData, cx, cy, roiRadius, pitch);
    return {
      rgbBackground: {
        r: stats.r,
        g: stats.g,
        b: stats.b,
      },
      bgPixels: stats.pixels,
      warnings: stats.warnings,
      backgroundModel: 'annular',
      actualModel: 'annular',
      outcome: 'annular',
      acceptedSamples: stats.pixels,
      backgroundWarning: stats.warnings.join('; '),
    };
  }

  if (backgroundModel === 'physical-interwell-polynomial-v1') {
    const fallback = estimateRobustInterwellBackground(imageData, wells, geometry, cx, cy, roiRadius, pitch, floorCircles, wellExclusionRadiiByWell);
    const fallbackWarning = 'Physical inter-well polynomial background was not precomputed; robust inter-well background v1 fallback used.';

    return {
      ...fallback,
      backgroundModel: 'physical-interwell-polynomial-v1',
      actualModel: fallback.outcome === 'annular' ? 'annular' : 'robust-interwell-v1',
      warnings: [fallbackWarning, ...fallback.warnings],
      acceptedSamples: fallback.acceptedSamples ?? fallback.acceptedPixels,
      backgroundWarning: [fallbackWarning, fallback.backgroundWarning ?? fallback.warnings.join('; ')]
        .filter((message) => message.trim() !== '')
        .join('; '),
      backgroundFitSuccess: false,
    };
  }

  const robust = estimateRobustInterwellBackground(imageData, wells, geometry, cx, cy, roiRadius, pitch, floorCircles, wellExclusionRadiiByWell);
  return {
    ...robust,
    backgroundModel: 'robust-interwell-v1',
    actualModel: robust.outcome === 'annular' ? 'annular' : 'robust-interwell-v1',
    acceptedSamples: robust.acceptedSamples ?? robust.acceptedPixels,
    backgroundWarning: robust.warnings.join('; '),
  };
}
