import type { Rgb, RoiPixelStatisticsMode } from '../types/results';

const MIN_BACKGROUND_PIXELS = 32;
const ROBUST_TRIM_DARK_Q = 8;
const ROBUST_TRIM_BRIGHT_Q = 88;
const ROBUST_EROSION_PX = 4;
const MIN_ROBUST_CORE_PIXELS = 16;
const MIN_ROBUST_USED_PIXELS = 20;
const MIN_ROBUST_USED_FRACTION = 0.35;
const LOW_USED_FRACTION_WARNING_THRESHOLD = 0.55;
const HIGHLIGHT_GRAY_THRESHOLD = 245;
const HIGHLIGHT_FRACTION_WARNING_THRESHOLD = 0.05;

export interface RgbSampleStats extends Rgb {
  pixels: number;
  warnings: string[];
  roiPixelStatisticsMode?: RoiPixelStatisticsMode;
  roiFullPixels?: number;
  roiCorePixels?: number;
  roiUsedPixels?: number;
  roiUsedFraction?: number;
  roiTrimDarkQ?: number | null;
  roiTrimBrightQ?: number | null;
  roiStatisticsWarnings?: string[];
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

function grayscale(rgb: Rgb): number {
  return 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
}

function pixelKey(x: number, y: number, width: number): number {
  return y * width + x;
}

function erosionOffsets(radius: number): { dx: number; dy: number }[] {
  const offsets: { dx: number; dy: number }[] = [];
  const radiusSquared = radius * radius;

  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx * dx + dy * dy <= radiusSquared) {
        offsets.push({ dx, dy });
      }
    }
  }

  return offsets;
}

const ROBUST_EROSION_OFFSETS = erosionOffsets(ROBUST_EROSION_PX);

function medianRgbFromPixels(pixels: SampledPixel[]): Rgb {
  return {
    r: median(pixels.map((pixel) => pixel.r)),
    g: median(pixels.map((pixel) => pixel.g)),
    b: median(pixels.map((pixel) => pixel.b)),
  };
}

function erodeRoiPixels(pixels: SampledPixel[], imageWidth: number): SampledPixel[] {
  const pixelKeys = new Set(pixels.map((pixel) => pixelKey(pixel.x, pixel.y, imageWidth)));

  return pixels.filter((pixel) => ROBUST_EROSION_OFFSETS.every(({ dx, dy }) => (
    pixelKeys.has(pixelKey(pixel.x + dx, pixel.y + dy, imageWidth))
  )));
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
  let corePixels = erodeRoiPixels(pixels, imageWidth);
  const minimumCorePixels = Math.max(MIN_ROBUST_CORE_PIXELS, Math.floor(MIN_ROBUST_USED_FRACTION * pixels.length));

  if (corePixels.length < minimumCorePixels) {
    statisticsWarnings.push('Robust ROI erosion left too few pixels; using full ROI as core.');
    corePixels = pixels;
  }

  const highlightFraction = pixels.filter((pixel) => pixel.gray >= HIGHLIGHT_GRAY_THRESHOLD).length / pixels.length;

  if (highlightFraction > HIGHLIGHT_FRACTION_WARNING_THRESHOLD) {
    statisticsWarnings.push('Frequent highlight-like pixels detected in ROI.');
  }

  const grayValues = corePixels.map((pixel) => pixel.gray);
  const darkThreshold = percentile(grayValues, ROBUST_TRIM_DARK_Q);
  const brightThreshold = percentile(grayValues, ROBUST_TRIM_BRIGHT_Q);
  const minimumUsedPixels = Math.max(MIN_ROBUST_USED_PIXELS, Math.floor(MIN_ROBUST_USED_FRACTION * corePixels.length));
  let usedPixels = corePixels.filter((pixel) => pixel.gray >= darkThreshold && pixel.gray <= brightThreshold);

  if (usedPixels.length < minimumUsedPixels) {
    statisticsWarnings.push('Robust ROI trimming left too few pixels; relaxing dark trim.');
    usedPixels = corePixels.filter((pixel) => pixel.gray <= brightThreshold);
  }

  if (usedPixels.length < minimumUsedPixels) {
    statisticsWarnings.push('Robust ROI trimming left too few pixels; using core ROI.');
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

  // TODO: add Python-like contiguous/fuzzy liquid-region masking after this trimmed path is validated.
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
  emptyWarning: string,
  options: RoiSampleOptions = {},
): RgbSampleStats {
  if (options.pixelStatisticsMode === 'robust-trimmed-v1') {
    return robustTrimmedRoiStats(pixels, imageWidth, emptyWarning, Boolean(options.includeDiagnosticPixels));
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
        });
      }
    }

    return roiStatsFromPixels(pixels, width, 'ROI contains no sampled pixels', options);
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
      });
    }
  }

  return roiStatsFromPixels(pixels, width, 'Intersection ROI contains no sampled pixels', options);
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
