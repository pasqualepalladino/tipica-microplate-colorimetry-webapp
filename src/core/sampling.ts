import { rgbToLab } from './cielab';
import type { Rgb, RoiPixelStatisticsMode, WellRobustChannelStats, WellRobustPixelStats } from '../types/results';

const MIN_BACKGROUND_PIXELS = 32;
const ROBUST_TRIM_DARK_Q = 8;
const ROBUST_TRIM_BRIGHT_Q = 88;
const ROBUST_EROSION_PX = 4;
const MIN_ROBUST_CORE_PIXELS = 16;
const MIN_ROBUST_USED_PIXELS = 20;
const MIN_ROBUST_RESET_TO_CORE_PIXELS = 12;
const MIN_ROBUST_USED_FRACTION = 0.35;
const ROBUST_FUZZY_TOL_GRAY = 10;
const ROBUST_FUZZY_TOL_SAT = 20;
const ROBUST_FUZZY_MIN_COMPONENT_PIXELS = 20;
const ROBUST_FUZZY_MIN_CORE_PIXELS = 30;
const LOW_USED_FRACTION_WARNING_THRESHOLD = 0.55;
const HIGHLIGHT_GRAY_THRESHOLD = 245;
const HIGHLIGHT_FRACTION_WARNING_THRESHOLD = 0.05;

export interface RgbSampleStats extends Rgb {
  pixels: number;
  wellRobustPixelStats?: WellRobustPixelStats;
  warnings: string[];
  roiPixelStatisticsMode?: RoiPixelStatisticsMode;
  roiFullPixels?: number;
  roiCorePixels?: number;
  roiUsedPixels?: number;
  roiUsedFraction?: number;
  roiTrimDarkQ?: number | null;
  roiTrimBrightQ?: number | null;
  roiStatisticsWarnings?: string[];
  highlightFractionRoi?: number;
  highlightFractionCore?: number;
  brightExcludedFraction?: number;
  brightExcludedMeanGray?: number | null;
  brightExcessMeanGray?: number;
  highlightIndex?: number;
  roiFullPixelCoordinates?: DiagnosticPixel[];
  roiCorePixelCoordinates?: DiagnosticPixel[];
  roiUsedPixelCoordinates?: DiagnosticPixel[];
}

export interface DiagnosticPixel {
  x: number;
  y: number;
}

interface RoiSampleOptions {
  pixelStatisticsMode?: RoiPixelStatisticsMode;
  includeDiagnosticPixels?: boolean;
}

interface SampledPixel extends Rgb {
  x: number;
  y: number;
  gray: number;
  sat: number;
}

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

function sampleSd(values: number[]): number {
  if (values.length <= 1) {
    return 0;
  }

  const center = mean(values);
  const variance = values.reduce((sum, value) => sum + ((value - center) ** 2), 0) / (values.length - 1);
  return Math.sqrt(Math.max(variance, 0));
}

function channelSummary(values: number[]): WellRobustChannelStats {
  const p25 = percentile(values, 25);
  const p75 = percentile(values, 75);

  return {
    mean: mean(values),
    median: median(values),
    sd: sampleSd(values),
    p10: percentile(values, 10),
    p25,
    p50: percentile(values, 50),
    p75,
    p90: percentile(values, 90),
    iqr: p75 - p25,
  };
}

function buildWellRobustPixelStats(pixels: SampledPixel[]): WellRobustPixelStats {
  const labValues = pixels.map((pixel) => rgbToLab(pixel));

  return {
    red: channelSummary(pixels.map((pixel) => pixel.r)),
    green: channelSummary(pixels.map((pixel) => pixel.g)),
    blue: channelSummary(pixels.map((pixel) => pixel.b)),
    gray: channelSummary(pixels.map((pixel) => pixel.gray)),
    purple: channelSummary(pixels.map((pixel) => 0.5 * (pixel.r + pixel.b) - pixel.g)),
    l: channelSummary(labValues.map((value) => value.l)),
    a: channelSummary(labValues.map((value) => value.a)),
    b: channelSummary(labValues.map((value) => value.b)),
  };
}

function grayscale(rgb: Rgb): number {
  return 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
}

function hsvSaturation(rgb: Rgb): number {
  const maxChannel = Math.max(rgb.r, rgb.g, rgb.b);
  const minChannel = Math.min(rgb.r, rgb.g, rgb.b);

  if (maxChannel <= 0) {
    return 0;
  }

  return ((maxChannel - minChannel) / maxChannel) * 255;
}

function pixelKey(x: number, y: number, width: number): number {
  return y * width + x;
}

function ellipseOffsets(radiusX: number, radiusY = radiusX): { dx: number; dy: number }[] {
  const offsets: { dx: number; dy: number }[] = [];
  const rx = Math.max(1, Math.floor(radiusX));
  const ry = Math.max(1, Math.floor(radiusY));

  for (let dy = -ry; dy <= ry; dy += 1) {
    for (let dx = -rx; dx <= rx; dx += 1) {
      const ellipseValue = ((dx * dx) / (rx * rx)) + ((dy * dy) / (ry * ry));

      if (ellipseValue <= 1 + 1e-9) {
        offsets.push({ dx, dy });
      }
    }
  }

  return offsets;
}

const ROBUST_EROSION_OFFSETS = ellipseOffsets(ROBUST_EROSION_PX);
const MORPH_ELLIPSE_3X3_OFFSETS = ellipseOffsets(1);
const CONNECTIVITY_8_OFFSETS = [
  { dx: -1, dy: -1 },
  { dx: 0, dy: -1 },
  { dx: 1, dy: -1 },
  { dx: -1, dy: 0 },
  { dx: 1, dy: 0 },
  { dx: -1, dy: 1 },
  { dx: 0, dy: 1 },
  { dx: 1, dy: 1 },
];

function medianRgbFromPixels(pixels: SampledPixel[]): Rgb {
  return {
    r: median(pixels.map((pixel) => pixel.r)),
    g: median(pixels.map((pixel) => pixel.g)),
    b: median(pixels.map((pixel) => pixel.b)),
  };
}

function keyToX(key: number, imageWidth: number): number {
  return key % imageWidth;
}

function keyToY(key: number, imageWidth: number): number {
  return Math.floor(key / imageWidth);
}

function erodeMask(maskKeys: Set<number>, offsets: { dx: number; dy: number }[], imageWidth: number, imageHeight: number): Set<number> {
  const output = new Set<number>();

  for (const key of maskKeys) {
    const x = keyToX(key, imageWidth);
    const y = keyToY(key, imageWidth);
    let keep = true;

    for (const { dx, dy } of offsets) {
      const nx = x + dx;
      const ny = y + dy;

      if (nx < 0 || nx >= imageWidth || ny < 0 || ny >= imageHeight || !maskKeys.has(pixelKey(nx, ny, imageWidth))) {
        keep = false;
        break;
      }
    }

    if (keep) {
      output.add(key);
    }
  }

  return output;
}

function dilateMask(maskKeys: Set<number>, offsets: { dx: number; dy: number }[], imageWidth: number, imageHeight: number): Set<number> {
  const output = new Set<number>();

  for (const key of maskKeys) {
    const x = keyToX(key, imageWidth);
    const y = keyToY(key, imageWidth);

    for (const { dx, dy } of offsets) {
      const nx = x + dx;
      const ny = y + dy;

      if (nx < 0 || nx >= imageWidth || ny < 0 || ny >= imageHeight) {
        continue;
      }

      output.add(pixelKey(nx, ny, imageWidth));
    }
  }

  return output;
}

function morphologicalOpenClose(maskKeys: Set<number>, imageWidth: number, imageHeight: number): Set<number> {
  const opened = dilateMask(
    erodeMask(maskKeys, MORPH_ELLIPSE_3X3_OFFSETS, imageWidth, imageHeight),
    MORPH_ELLIPSE_3X3_OFFSETS,
    imageWidth,
    imageHeight,
  );
  return erodeMask(
    dilateMask(opened, MORPH_ELLIPSE_3X3_OFFSETS, imageWidth, imageHeight),
    MORPH_ELLIPSE_3X3_OFFSETS,
    imageWidth,
    imageHeight,
  );
}

function connectedComponents8(maskKeys: Set<number>, imageWidth: number, imageHeight: number): number[][] {
  const unvisited = new Set(maskKeys);
  const components: number[][] = [];

  while (unvisited.size > 0) {
    const iter = unvisited.values().next();
    const start = iter.value as number;
    const queue: number[] = [start];
    const component: number[] = [];
    unvisited.delete(start);

    while (queue.length > 0) {
      const current = queue.pop() as number;
      component.push(current);
      const x = keyToX(current, imageWidth);
      const y = keyToY(current, imageWidth);

      for (const { dx, dy } of CONNECTIVITY_8_OFFSETS) {
        const nx = x + dx;
        const ny = y + dy;

        if (nx < 0 || nx >= imageWidth || ny < 0 || ny >= imageHeight) {
          continue;
        }

        const neighbor = pixelKey(nx, ny, imageWidth);

        if (!unvisited.has(neighbor)) {
          continue;
        }

        unvisited.delete(neighbor);
        queue.push(neighbor);
      }
    }

    components.push(component);
  }

  return components;
}

function centroidFromPixels(pixels: SampledPixel[]): { x: number; y: number } | null {
  if (pixels.length === 0) {
    return null;
  }

  const sum = pixels.reduce((acc, pixel) => ({
    x: acc.x + pixel.x,
    y: acc.y + pixel.y,
  }), { x: 0, y: 0 });

  return {
    x: sum.x / pixels.length,
    y: sum.y / pixels.length,
  };
}

function robustInnerPixels(pixels: SampledPixel[], imageWidth: number, imageHeight: number): SampledPixel[] {
  if (pixels.length === 0) {
    return [];
  }

  const fullMaskKeys = new Set(pixels.map((pixel) => pixelKey(pixel.x, pixel.y, imageWidth)));
  const eroded = erodeMask(fullMaskKeys, ROBUST_EROSION_OFFSETS, imageWidth, imageHeight);

  if (eroded.size < MIN_ROBUST_CORE_PIXELS) {
    return pixels;
  }

  return pixels.filter((pixel) => eroded.has(pixelKey(pixel.x, pixel.y, imageWidth)));
}

function fuzzyLiquidMaskWithinRoi(
  roiPixels: SampledPixel[],
  imageWidth: number,
  imageHeight: number,
  center: { x: number; y: number } | null,
): SampledPixel[] {
  if (roiPixels.length === 0) {
    return [];
  }

  const seedGray = median(roiPixels.map((pixel) => pixel.gray));
  const seedSat = median(roiPixels.map((pixel) => pixel.sat));
  const roiByKey = new Map<number, SampledPixel>();

  for (const pixel of roiPixels) {
    roiByKey.set(pixelKey(pixel.x, pixel.y, imageWidth), pixel);
  }

  const candidateKeys = new Set<number>();

  for (const pixel of roiPixels) {
    if (Math.abs(pixel.gray - seedGray) <= ROBUST_FUZZY_TOL_GRAY && Math.abs(pixel.sat - seedSat) <= ROBUST_FUZZY_TOL_SAT) {
      candidateKeys.add(pixelKey(pixel.x, pixel.y, imageWidth));
    }
  }

  const filteredCandidates = morphologicalOpenClose(candidateKeys, imageWidth, imageHeight);
  const constrainedCandidates = new Set<number>(
    Array.from(filteredCandidates).filter((key) => roiByKey.has(key)),
  );
  const components = connectedComponents8(constrainedCandidates, imageWidth, imageHeight);

  if (components.length === 0) {
    return roiPixels;
  }

  const roiCentroid = centroidFromPixels(roiPixels);
  const centerX = center ? Math.round(Math.min(imageWidth - 1, Math.max(0, center.x))) : (roiCentroid ? Math.round(roiCentroid.x) : 0);
  const centerY = center ? Math.round(Math.min(imageHeight - 1, Math.max(0, center.y))) : (roiCentroid ? Math.round(roiCentroid.y) : 0);
  const seedKey = pixelKey(centerX, centerY, imageWidth);
  let selectedComponent = components.find((component) => component.includes(seedKey));

  if (!selectedComponent && roiCentroid) {
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const component of components) {
      if (component.length < ROBUST_FUZZY_MIN_COMPONENT_PIXELS) {
        continue;
      }

      let sumX = 0;
      let sumY = 0;
      for (const key of component) {
        sumX += keyToX(key, imageWidth);
        sumY += keyToY(key, imageWidth);
      }

      const centroidX = sumX / component.length;
      const centroidY = sumY / component.length;
      const distance = ((centroidX - roiCentroid.x) ** 2) + ((centroidY - roiCentroid.y) ** 2);

      if (distance < bestDistance) {
        bestDistance = distance;
        selectedComponent = component;
      }
    }
  }

  if (!selectedComponent) {
    return roiPixels;
  }

  const minimumSelected = Math.max(ROBUST_FUZZY_MIN_COMPONENT_PIXELS, Math.floor(0.2 * roiPixels.length));
  if (selectedComponent.length < minimumSelected) {
    return roiPixels;
  }

  return selectedComponent
    .map((key) => roiByKey.get(key))
    .filter((pixel): pixel is SampledPixel => pixel !== undefined);
}

function simpleRoiStats(
  pixels: SampledPixel[],
  emptyWarning: string,
  includeDiagnosticPixels = false,
): RgbSampleStats {
  const warnings = pixels.length === 0 ? [emptyWarning] : [];
  const rgb = medianRgbFromPixels(pixels);
  const diagnosticPixels = includeDiagnosticPixels ? pixels.map(({ x, y }) => ({ x, y })) : undefined;

  return {
    ...rgb,
    pixels: pixels.length,
    warnings,
    roiPixelStatisticsMode: 'simple-median',
    roiFullPixels: pixels.length,
    roiCorePixels: pixels.length,
    roiUsedPixels: pixels.length,
    roiUsedFraction: pixels.length > 0 ? 1 : 0,
    wellRobustPixelStats: buildWellRobustPixelStats(pixels),
    roiTrimDarkQ: null,
    roiTrimBrightQ: null,
    roiStatisticsWarnings: warnings,
    ...(diagnosticPixels ? {
      roiFullPixelCoordinates: diagnosticPixels,
      roiCorePixelCoordinates: diagnosticPixels,
      roiUsedPixelCoordinates: diagnosticPixels,
    } : {}),
  };
}

function robustTrimmedRoiStats(
  pixels: SampledPixel[],
  imageWidth: number,
  imageHeight: number,
  emptyWarning: string,
  includeDiagnosticPixels = false,
): RgbSampleStats {
  if (pixels.length === 0) {
    return {
      ...simpleRoiStats(pixels, emptyWarning, includeDiagnosticPixels),
      roiPixelStatisticsMode: 'robust-trimmed-v1',
      roiTrimDarkQ: ROBUST_TRIM_DARK_Q,
      roiTrimBrightQ: ROBUST_TRIM_BRIGHT_Q,
    };
  }

  const statisticsWarnings: string[] = [];
  const innerPixels = robustInnerPixels(pixels, imageWidth, imageHeight);
  let corePixels = innerPixels.length > 0 ? innerPixels : pixels;

  const fuzzyCenter = centroidFromPixels(innerPixels);
  const fuzzyPixels = fuzzyLiquidMaskWithinRoi(innerPixels, imageWidth, imageHeight, fuzzyCenter);

  if (fuzzyPixels.length > ROBUST_FUZZY_MIN_CORE_PIXELS) {
    corePixels = fuzzyPixels;
  }

  const highlightFractionRoi = pixels.filter((pixel) => pixel.gray >= HIGHLIGHT_GRAY_THRESHOLD).length / pixels.length;
  const highlightFractionCore = corePixels.length > 0
    ? corePixels.filter((pixel) => pixel.gray >= HIGHLIGHT_GRAY_THRESHOLD).length / corePixels.length
    : 0;

  if (highlightFractionRoi > HIGHLIGHT_FRACTION_WARNING_THRESHOLD) {
    statisticsWarnings.push('Frequent highlight-like pixels detected in ROI.');
  }

  const grayValues = corePixels.map((pixel) => pixel.gray);
  const brightThreshold = grayValues.length > 0 ? percentile(grayValues, ROBUST_TRIM_BRIGHT_Q) : 255;
  const darkThreshold = grayValues.length > 0 ? percentile(grayValues, ROBUST_TRIM_DARK_Q) : 0;
  const brightExcludedPixels = corePixels.filter((pixel) => pixel.gray > brightThreshold);
  const brightExcludedFraction = brightExcludedPixels.length / Math.max(1, corePixels.length);
  const brightExcludedMeanGray = brightExcludedPixels.length > 0
    ? brightExcludedPixels.reduce((acc, pixel) => acc + pixel.gray, 0) / brightExcludedPixels.length
    : null;
  const brightExcessMeanGray = brightExcludedPixels.length > 0
    ? brightExcludedPixels.reduce((acc, pixel) => acc + Math.max(pixel.gray - brightThreshold, 0), 0) / brightExcludedPixels.length
    : 0;
  const highlightIndex = brightExcludedFraction * brightExcessMeanGray;
  void darkThreshold;
  const minimumUsedPixels = Math.max(MIN_ROBUST_USED_PIXELS, Math.floor(MIN_ROBUST_USED_FRACTION * corePixels.length));
  let usedPixels = [...corePixels];

  if (usedPixels.length < minimumUsedPixels) {
    statisticsWarnings.push('Python-like robust fallback removed bright-tail pixels due to low usable count.');
    usedPixels = corePixels.filter((pixel) => pixel.gray <= brightThreshold);
  }

  if (usedPixels.length < MIN_ROBUST_RESET_TO_CORE_PIXELS) {
    statisticsWarnings.push('Python-like robust fallback restored full core after low usable count.');
    usedPixels = corePixels;
  }

  if (usedPixels.length === 0) {
    statisticsWarnings.push('Robust ROI trimming produced no usable pixels; using full ROI.');
    usedPixels = pixels;
    corePixels = pixels;
  }

  const usedFraction = usedPixels.length / Math.max(1, corePixels.length);

  if (usedFraction < LOW_USED_FRACTION_WARNING_THRESHOLD) {
    statisticsWarnings.push('ROI used fraction below 0.55 after robust trimming.');
  }

  const rgb = medianRgbFromPixels(usedPixels);
  const fullDiagnosticPixels = includeDiagnosticPixels ? pixels.map(({ x, y }) => ({ x, y })) : undefined;
  const coreDiagnosticPixels = includeDiagnosticPixels ? corePixels.map(({ x, y }) => ({ x, y })) : undefined;
  const usedDiagnosticPixels = includeDiagnosticPixels ? usedPixels.map(({ x, y }) => ({ x, y })) : undefined;

  return {
    ...rgb,
    pixels: pixels.length,
    warnings: statisticsWarnings,
    roiPixelStatisticsMode: 'robust-trimmed-v1',
    roiFullPixels: pixels.length,
    roiCorePixels: corePixels.length,
    roiUsedPixels: usedPixels.length,
    roiUsedFraction: usedFraction,
    roiTrimDarkQ: ROBUST_TRIM_DARK_Q,
    roiTrimBrightQ: ROBUST_TRIM_BRIGHT_Q,
    roiStatisticsWarnings: statisticsWarnings,
    highlightFractionRoi,
    highlightFractionCore,
    brightExcludedFraction,
    brightExcludedMeanGray,
    brightExcessMeanGray,
    highlightIndex,
    wellRobustPixelStats: buildWellRobustPixelStats(usedPixels),
    ...(includeDiagnosticPixels ? {
      roiFullPixelCoordinates: fullDiagnosticPixels,
      roiCorePixelCoordinates: coreDiagnosticPixels,
      roiUsedPixelCoordinates: usedDiagnosticPixels,
    } : {}),
  };
}

function roiStatsFromPixels(
  pixels: SampledPixel[],
  imageWidth: number,
  imageHeight: number,
  emptyWarning: string,
  options: RoiSampleOptions = {},
): RgbSampleStats {
  if (options.pixelStatisticsMode === 'robust-trimmed-v1') {
    return robustTrimmedRoiStats(pixels, imageWidth, imageHeight, emptyWarning, Boolean(options.includeDiagnosticPixels));
  }

  return simpleRoiStats(pixels, emptyWarning, Boolean(options.includeDiagnosticPixels));
}

function emptyStats(warnings: string[]): RgbSampleStats {
  return {
    r: 0,
    g: 0,
    b: 0,
    pixels: 0,
    warnings,
  };
}

function sampleAnnulus(
  imageData: ImageData,
  cx: number,
  cy: number,
  innerRadius: number,
  outerRadius: number,
): RgbSampleStats {
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(outerRadius) || outerRadius <= 0) {
    return emptyStats(['Invalid sampling geometry']);
  }

  if (innerRadius < 0 || innerRadius >= outerRadius) {
    return emptyStats(['Invalid annular background geometry']);
  }

  const { data, width, height } = imageData;
  const innerRadiusSquared = innerRadius * innerRadius;
  const outerRadiusSquared = outerRadius * outerRadius;
  const xStart = Math.max(0, Math.floor(cx - outerRadius));
  const xEnd = Math.min(width - 1, Math.ceil(cx + outerRadius));
  const yStart = Math.max(0, Math.floor(cy - outerRadius));
  const yEnd = Math.min(height - 1, Math.ceil(cy + outerRadius));
  const rValues: number[] = [];
  const gValues: number[] = [];
  const bValues: number[] = [];

  for (let y = yStart; y <= yEnd; y += 1) {
    for (let x = xStart; x <= xEnd; x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const distanceSquared = dx * dx + dy * dy;

      if ((innerRadius > 0 && distanceSquared <= innerRadiusSquared) || distanceSquared > outerRadiusSquared) {
        continue;
      }

      const offset = (y * width + x) * 4;
      rValues.push(data[offset]);
      gValues.push(data[offset + 1]);
      bValues.push(data[offset + 2]);
    }
  }

  return {
    r: median(rValues),
    g: median(gValues),
    b: median(bValues),
    pixels: rValues.length,
    warnings: [],
  };
}

export function sampleCircularRoi(
  imageData: ImageData,
  cx: number,
  cy: number,
  radius: number,
  options: RoiSampleOptions = {},
): RgbSampleStats {
  if (options.pixelStatisticsMode === 'robust-trimmed-v1') {
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(radius) || radius <= 0) {
      return emptyStats(['Invalid sampling geometry']);
    }

    const { data, width, height } = imageData;
    const radiusSquared = radius * radius;
    const xStart = Math.max(0, Math.floor(cx - radius));
    const xEnd = Math.min(width - 1, Math.ceil(cx + radius));
    const yStart = Math.max(0, Math.floor(cy - radius));
    const yEnd = Math.min(height - 1, Math.ceil(cy + radius));
    const pixels: SampledPixel[] = [];

    for (let y = yStart; y <= yEnd; y += 1) {
      for (let x = xStart; x <= xEnd; x += 1) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;

        if (dx * dx + dy * dy > radiusSquared) {
          continue;
        }

        const offset = (y * width + x) * 4;
        const pixel = {
          x,
          y,
          r: data[offset],
          g: data[offset + 1],
          b: data[offset + 2],
        };

        pixels.push({
          ...pixel,
          gray: grayscale(pixel),
          sat: hsvSaturation(pixel),
        });
      }
    }

    return roiStatsFromPixels(pixels, width, height, 'ROI contains no sampled pixels', options);
  }

  const stats = sampleAnnulus(imageData, cx, cy, 0, radius);

  if (stats.pixels === 0) {
    const warnings = [...stats.warnings, 'ROI contains no sampled pixels'];

    return {
      ...stats,
      warnings,
      roiPixelStatisticsMode: 'simple-median',
      roiFullPixels: 0,
      roiCorePixels: 0,
      roiUsedPixels: 0,
      roiUsedFraction: 0,
      roiTrimDarkQ: null,
      roiTrimBrightQ: null,
      roiStatisticsWarnings: warnings,
    };
  }

  return {
    ...stats,
    roiPixelStatisticsMode: 'simple-median',
    roiFullPixels: stats.pixels,
    roiCorePixels: stats.pixels,
    roiUsedPixels: stats.pixels,
    roiUsedFraction: stats.pixels > 0 ? 1 : 0,
    roiTrimDarkQ: null,
    roiTrimBrightQ: null,
    roiStatisticsWarnings: stats.warnings,
  };
}

export function sampleCircleIntersectionRoi(
  imageData: ImageData,
  mouthCx: number,
  mouthCy: number,
  mouthRadius: number,
  floorCx: number,
  floorCy: number,
  floorRadius: number,
  options: RoiSampleOptions = {},
): RgbSampleStats {
  if (!Number.isFinite(mouthCx) || !Number.isFinite(mouthCy) || !Number.isFinite(mouthRadius) || mouthRadius <= 0) {
    return emptyStats(['Invalid mouth circle geometry']);
  }

  if (!Number.isFinite(floorCx) || !Number.isFinite(floorCy) || !Number.isFinite(floorRadius) || floorRadius <= 0) {
    return emptyStats(['Invalid floor circle geometry']);
  }

  const { data, width, height } = imageData;
  const mouthRadiusSquared = mouthRadius * mouthRadius;
  const floorRadiusSquared = floorRadius * floorRadius;

  // Calculate bounding box for potential intersection
  const xStart = Math.max(0, Math.floor(Math.min(mouthCx - mouthRadius, floorCx - floorRadius)));
  const xEnd = Math.min(width - 1, Math.ceil(Math.max(mouthCx + mouthRadius, floorCx + floorRadius)));
  const yStart = Math.max(0, Math.floor(Math.min(mouthCy - mouthRadius, floorCy - floorRadius)));
  const yEnd = Math.min(height - 1, Math.ceil(Math.max(mouthCy + mouthRadius, floorCy + floorRadius)));

  const pixels: SampledPixel[] = [];

  for (let y = yStart; y <= yEnd; y += 1) {
    for (let x = xStart; x <= xEnd; x += 1) {
      const dx = x + 0.5 - mouthCx;
      const dy = y + 0.5 - mouthCy;
      const mouthDistanceSquared = dx * dx + dy * dy;

      // Check if inside mouth circle
      if (mouthDistanceSquared > mouthRadiusSquared) {
        continue;
      }

      const dfx = x + 0.5 - floorCx;
      const dfy = y + 0.5 - floorCy;
      const floorDistanceSquared = dfx * dfx + dfy * dfy;

      // Check if inside floor circle
      if (floorDistanceSquared > floorRadiusSquared) {
        continue;
      }

      const offset = (y * width + x) * 4;
      const pixel = {
        x,
        y,
        r: data[offset],
        g: data[offset + 1],
        b: data[offset + 2],
      };

      pixels.push({
        ...pixel,
        gray: grayscale(pixel),
        sat: hsvSaturation(pixel),
      });
    }
  }

  return roiStatsFromPixels(pixels, width, height, 'Intersection ROI contains no sampled pixels', options);
}

export function estimateLocalBackground(
  imageData: ImageData,
  cx: number,
  cy: number,
  roiRadius: number,
  pitch: number,
): RgbSampleStats {
  const innerRadius = roiRadius * 1.25;
  const outerRadius = Math.min(pitch * 0.48, roiRadius * 2.2);
  const stats = sampleAnnulus(imageData, cx, cy, innerRadius, outerRadius);

  if (stats.pixels < MIN_BACKGROUND_PIXELS) {
    return {
      ...stats,
      warnings: [
        ...stats.warnings,
        `Background sample has only ${stats.pixels} pixels`,
      ],
    };
  }

  return stats;
}
