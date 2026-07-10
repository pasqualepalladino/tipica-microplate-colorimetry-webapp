import type { FloorCircle, PlateGeometry, Point } from '../types/geometry';
import type { WellCenter } from '../types/plate';

const ROW_COUNT = 8;
const COL_COUNT = 12;
const ROW_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const REFERENCE_ANALYSIS_MAX_SIDE = 2000;

export interface ImageSize {
  width: number;
  height: number;
}

function lerp(a: number, b: number, t: number): number {
  return (1 - t) * a + t * b;
}

function lerpPoint(a: Point, b: Point, t: number): Point {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
  };
}

function solveLinearSystem(matrix: number[][], vector: number[]): number[] | null {
  const size = matrix.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);

  for (let pivot = 0; pivot < size; pivot += 1) {
    let pivotRow = pivot;

    while (pivotRow < size && Math.abs(augmented[pivotRow][pivot]) < 1e-12) {
      pivotRow += 1;
    }

    if (pivotRow === size) {
      return null;
    }

    if (pivotRow !== pivot) {
      [augmented[pivot], augmented[pivotRow]] = [augmented[pivotRow], augmented[pivot]];
    }

    const pivotValue = augmented[pivot][pivot];

    for (let col = pivot; col <= size; col += 1) {
      augmented[pivot][col] /= pivotValue;
    }

    for (let row = 0; row < size; row += 1) {
      if (row === pivot) {
        continue;
      }

      const factor = augmented[row][pivot];
      if (Math.abs(factor) < 1e-12) {
        continue;
      }

      for (let col = pivot; col <= size; col += 1) {
        augmented[row][col] -= factor * augmented[pivot][col];
      }
    }
  }

  return augmented.map((row) => row[size]);
}

function computePerspectiveTransform(src: Point[], dst: Point[]): number[] | null {
  const matrix: number[][] = [];
  const vector: number[] = [];

  src.forEach((sourcePoint, index) => {
    const targetPoint = dst[index];
    const { x: u, y: v } = sourcePoint;
    const { x: x, y: y } = targetPoint;

    matrix.push([u, v, 1, 0, 0, 0, -x * u, -x * v]);
    vector.push(x);
    matrix.push([0, 0, 0, u, v, 1, -y * u, -y * v]);
    vector.push(y);
  });

  const solution = solveLinearSystem(matrix, vector);
  return solution ? [...solution, 1] : null;
}

function applyPerspectiveTransform(homography: number[], x: number, y: number): Point | null {
  const denominator = homography[6] * x + homography[7] * y + homography[8];

  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12) {
    return null;
  }

  return {
    x: (homography[0] * x + homography[1] * y + homography[2]) / denominator,
    y: (homography[3] * x + homography[4] * y + homography[5]) / denominator,
  };
}

function distance(a: WellCenter, b: WellCenter): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 1;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }

  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function wellAt(wells: WellCenter[], row: number, col: number): WellCenter | undefined {
  return wells.find((well) => well.row === row && well.col === col);
}

export function getImageNaturalSize(image: HTMLImageElement): ImageSize {
  return {
    width: Math.max(1, Math.round(image.naturalWidth || image.width)),
    height: Math.max(1, Math.round(image.naturalHeight || image.height)),
  };
}

function getReferenceAnalysisSize(naturalSize: ImageSize): ImageSize {
  const maxSide = Math.max(naturalSize.width, naturalSize.height);
  const scale = Math.min(1, REFERENCE_ANALYSIS_MAX_SIDE / maxSide);

  return {
    width: Math.max(1, Math.round(naturalSize.width * scale)),
    height: Math.max(1, Math.round(naturalSize.height * scale)),
  };
}

export function getImageAnalysisSize(image: HTMLImageElement): ImageSize {
  return getReferenceAnalysisSize(getImageNaturalSize(image));
}

function appearsToUseReferenceAnalysisSize(
  wells: WellCenter[],
  naturalSize: ImageSize,
  referenceSize: ImageSize,
): boolean {
  if (wells.length !== ROW_COUNT * COL_COUNT) {
    return false;
  }

  const a1 = wellAt(wells, 0, 0);
  const a12 = wellAt(wells, 0, COL_COUNT - 1);
  const h12 = wellAt(wells, ROW_COUNT - 1, COL_COUNT - 1);
  const h1 = wellAt(wells, ROW_COUNT - 1, 0);

  if (!a1 || !a12 || !h12 || !h1) {
    return false;
  }

  const maxX = Math.max(...wells.map((well) => well.x));
  const maxY = Math.max(...wells.map((well) => well.y));

  if (maxX > referenceSize.width + 1 || maxY > referenceSize.height + 1) {
    return false;
  }

  const minX = Math.min(...wells.map((well) => well.x));
  const minY = Math.min(...wells.map((well) => well.y));

  if (minX < -1 || minY < -1) {
    return false;
  }

  const gridWidth = median([distance(a1, a12), distance(h1, h12)]);
  const gridHeight = median([distance(a1, h1), distance(a12, h12)]);
  const naturalWidthRatio = gridWidth / naturalSize.width;
  const naturalHeightRatio = gridHeight / naturalSize.height;
  const referenceWidthRatio = gridWidth / referenceSize.width;
  const referenceHeightRatio = gridHeight / referenceSize.height;

  if (
    referenceWidthRatio >= 0.4 &&
    referenceWidthRatio <= 0.98 &&
    referenceHeightRatio >= 0.35 &&
    referenceHeightRatio <= 0.98 &&
    (naturalWidthRatio < referenceWidthRatio * 0.92 || naturalHeightRatio < referenceHeightRatio * 0.92)
  ) {
    return true;
  }

  return (
    (naturalWidthRatio < 0.5 || naturalHeightRatio < 0.5) &&
    referenceWidthRatio >= 0.4 &&
    referenceWidthRatio <= 0.95 &&
    referenceHeightRatio >= 0.35 &&
    referenceHeightRatio <= 0.95
  );
}

export function getCanvasCoordinateSize(image: HTMLImageElement, wells: WellCenter[]): ImageSize {
  const naturalSize = getImageNaturalSize(image);
  const referenceSize = getReferenceAnalysisSize(naturalSize);

  if (
    referenceSize.width !== naturalSize.width &&
    appearsToUseReferenceAnalysisSize(wells, naturalSize, referenceSize)
  ) {
    return referenceSize;
  }

  return naturalSize;
}

export function generate96WellGrid(geometry: PlateGeometry): WellCenter[] {
  const wells: WellCenter[] = [];

  for (let row = 0; row < ROW_COUNT; row += 1) {
    const rowT = row / (ROW_COUNT - 1);
    const leftEdge = lerpPoint(geometry.corner_a1, geometry.corner_h1, rowT);
    const rightEdge = lerpPoint(geometry.corner_a12, geometry.corner_h12, rowT);

    for (let col = 0; col < COL_COUNT; col += 1) {
      const colT = col / (COL_COUNT - 1);
      const center = lerpPoint(leftEdge, rightEdge, colT);

      wells.push({
        wellId: `${ROW_LABELS[row]}${col + 1}`,
        row,
        col,
        x: center.x,
        y: center.y,
      });
    }
  }

  return wells;
}

export interface GeometryAlignmentDiagnostics {
  a1MismatchPx: number;
  a12MismatchPx: number;
  h12MismatchPx: number;
  h1MismatchPx: number;
  warning: string | null;
}

export function computeGeometryAlignmentDiagnostics(
  geometry: PlateGeometry,
  wells: WellCenter[],
  tolerancePx = 2,
): GeometryAlignmentDiagnostics {
  const a1 = wellAt(wells, 0, 0);
  const a12 = wellAt(wells, 0, COL_COUNT - 1);
  const h12 = wellAt(wells, ROW_COUNT - 1, COL_COUNT - 1);
  const h1 = wellAt(wells, ROW_COUNT - 1, 0);
  const a1MismatchPx = a1 ? pointDistance(geometry.corner_a1, a1) : Number.NaN;
  const a12MismatchPx = a12 ? pointDistance(geometry.corner_a12, a12) : Number.NaN;
  const h12MismatchPx = h12 ? pointDistance(geometry.corner_h12, h12) : Number.NaN;
  const h1MismatchPx = h1 ? pointDistance(geometry.corner_h1, h1) : Number.NaN;
  const mismatches = [
    ['A1', a1MismatchPx],
    ['A12', a12MismatchPx],
    ['H12', h12MismatchPx],
    ['H1', h1MismatchPx],
  ] as const;
  const badCorners = mismatches
    .filter(([, value]) => !Number.isFinite(value) || value > tolerancePx)
    .map(([label]) => label);

  return {
    a1MismatchPx,
    a12MismatchPx,
    h12MismatchPx,
    h1MismatchPx,
    warning: badCorners.length > 0
      ? `Generated grid corner mismatch > ${tolerancePx}px: ${badCorners.join(', ')}.`
      : null,
  };
}

export function hasFloorGeometry(geometry: PlateGeometry): boolean {
  return Boolean(
    geometry.floor_a1_circle_img &&
    geometry.floor_a12_circle_img &&
    geometry.floor_h12_circle_img &&
    geometry.floor_h1_circle_img,
  );
}

export function generate96WellFloorCircles(
  geometry: PlateGeometry,
  wells: WellCenter[] | null = null,
  _radiusFactor: number | null = null,
): FloorCircle[] | null {
  if (!hasFloorGeometry(geometry)) {
    return null;
  }

  const floorA1 = geometry.floor_a1_circle_img as FloorCircle;
  const floorA12 = geometry.floor_a12_circle_img as FloorCircle;
  const floorH12 = geometry.floor_h12_circle_img as FloorCircle;
  const floorH1 = geometry.floor_h1_circle_img as FloorCircle;
  const floorCircles: FloorCircle[] = [];
  const sourceCorners: Point[] = [
    { x: 0, y: 0 },
    { x: COL_COUNT - 1, y: 0 },
    { x: COL_COUNT - 1, y: ROW_COUNT - 1 },
    { x: 0, y: ROW_COUNT - 1 },
  ];
  const targetCorners: Point[] = [floorA1, floorA12, floorH12, floorH1];
  const perspectiveTransform = computePerspectiveTransform(sourceCorners, targetCorners);

  for (let row = 0; row < ROW_COUNT; row += 1) {
    const rowT = row / (ROW_COUNT - 1);
    const leftEdge = lerpPoint(floorA1, floorH1, rowT);
    const rightEdge = lerpPoint(floorA12, floorH12, rowT);
    const leftRadius = lerp(floorA1.r, floorH1.r, rowT);
    const rightRadius = lerp(floorA12.r, floorH12.r, rowT);

    for (let col = 0; col < COL_COUNT; col += 1) {
      const colT = col / (COL_COUNT - 1);
      const projectedCenter = perspectiveTransform
        ? applyPerspectiveTransform(perspectiveTransform, col, row)
        : null;
      const center = projectedCenter ?? lerpPoint(leftEdge, rightEdge, colT);
      const interpolatedRadius = Math.max(1, lerp(leftRadius, rightRadius, colT));
      const mouthRadius = wells
        ? estimateStandardMouthRadius(wells, row, col)
        : Number.NaN;
      const radius = Number.isFinite(mouthRadius)
        ? Math.min(Math.max(interpolatedRadius, 0.50 * mouthRadius), 1.05 * mouthRadius)
        : interpolatedRadius;

      floorCircles.push({
        x: center.x,
        y: center.y,
        r: radius,
      });
    }
  }

  return floorCircles;
}

export function estimateLocalPitch(wells: WellCenter[], row: number, col: number): number {
  const center = wellAt(wells, row, col);

  if (!center) {
    return 1;
  }

  const distances: number[] = [];
  const neighborOffsets = [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ] as const;

  for (const [rowOffset, colOffset] of neighborOffsets) {
    const neighbor = wellAt(wells, row + rowOffset, col + colOffset);

    if (neighbor) {
      distances.push(distance(center, neighbor));
    }
  }

  return median(distances);
}

export function estimateRoiRadius(
  wells: WellCenter[],
  row: number,
  col: number,
  radiusFactor: number,
): number {
  const safeRadiusFactor = Number.isFinite(radiusFactor) ? radiusFactor : 0.3;
  return Math.max(1, estimateLocalPitch(wells, row, col) * safeRadiusFactor);
}

const STANDARD_96_WELL_PITCH_MM = 9.0;
const STANDARD_96_WELL_MOUTH_DIAMETER_MM = 6.90;
const STANDARD_96_WELL_MOUTH_RADIUS_FACTOR = 0.5 * STANDARD_96_WELL_MOUTH_DIAMETER_MM / STANDARD_96_WELL_PITCH_MM;

export function estimateStandardMouthRadius(
  wells: WellCenter[],
  row: number,
  col: number,
): number {
  return Math.max(1, estimateLocalPitch(wells, row, col) * STANDARD_96_WELL_MOUTH_RADIUS_FACTOR);
}

export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  wells: WellCenter[],
  radiusFactor: number,
  coordinateSize = getCanvasCoordinateSize(image, wells),
  showMouthGrid = true,
  floorCircles: FloorCircle[] | null = null,
  showFloorCircles = false,
): void {
  const canvas = ctx.canvas;
  const { width, height } = coordinateSize;

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  ctx.clearRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, width, height);

  if (wells.length === 0) {
    return;
  }

  if (showFloorCircles && floorCircles && floorCircles.length === wells.length) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 156, 0, 0.9)';
    ctx.fillStyle = 'rgba(255, 156, 0, 0.12)';
    ctx.lineWidth = 2;

    for (const floorCircle of floorCircles) {
      ctx.beginPath();
      ctx.arc(floorCircle.x, floorCircle.y, floorCircle.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    ctx.restore();
  }

  if (!showMouthGrid) {
    return;
  }

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const well of wells) {
    const radius = estimateRoiRadius(wells, well.row, well.col, radiusFactor);
    const localPitch = estimateLocalPitch(wells, well.row, well.col);
    const lineWidth = Math.max(2, localPitch * 0.018);
    const fontSize = Math.max(12, Math.min(28, localPitch * 0.16));

    ctx.beginPath();
    ctx.arc(well.x, well.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 122, 90, 0.16)';
    ctx.strokeStyle = 'rgba(0, 122, 90, 0.96)';
    ctx.lineWidth = lineWidth;
    ctx.fill();
    ctx.stroke();

    ctx.font = `700 ${fontSize}px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.lineWidth = Math.max(2, fontSize * 0.18);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.72)';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
    ctx.strokeText(well.wellId, well.x, well.y);
    ctx.fillText(well.wellId, well.x, well.y);
  }

  ctx.restore();
}
