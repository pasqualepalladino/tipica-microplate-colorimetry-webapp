import type { WellCenter } from '../types/plate';
import type { WellMeasurement } from '../types/results';

export interface PythonImageQcInfo {
  analysis_image_source: string;
  original_image_path: string;
  original_image_size: string;
  analysis_image_size: string;
  resize_scale: number;
  approx_well_pitch_px: number | null;
  approx_roi_pixels_per_well: number | null;
  blur_score: number | null;
  saturation_fraction: number | null;
  saturation_all_channels_fraction: number | null;
  clip_low_fraction: number | null;
  specular_fraction: number | null;
  dead_channel: number | null;
  flatfield_span: number | null;
  initial_image_qc: string;
  image_qc_class: string;
  image_qc_messages: string;
}

interface ImageSize {
  width: number;
  height: number;
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

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) {
    return Number.NaN;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const rank = (percentileValue / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);

  if (lower === upper) {
    return sorted[lower];
  }

  const weight = rank - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

function formatImageSize(size: ImageSize): string {
  return `${Math.round(size.width)} x ${Math.round(size.height)} px`;
}

function computeApproxWellPitchPx(wells: WellCenter[]): number | null {
  if (wells.length === 0) {
    return null;
  }

  const pitches: number[] = [];
  const wellsByRow = new Map<number, WellCenter[]>();
  const wellsByCol = new Map<number, WellCenter[]>();

  wells.forEach((well) => {
    const rowWells = wellsByRow.get(well.row) ?? [];
    rowWells.push(well);
    wellsByRow.set(well.row, rowWells);

    const colWells = wellsByCol.get(well.col) ?? [];
    colWells.push(well);
    wellsByCol.set(well.col, colWells);
  });

  Array.from(wellsByRow.values()).forEach((rowWells) => {
    rowWells.sort((a, b) => a.col - b.col);
    for (let index = 1; index < rowWells.length; index += 1) {
      pitches.push(Math.hypot(rowWells[index].x - rowWells[index - 1].x, rowWells[index].y - rowWells[index - 1].y));
    }
  });

  Array.from(wellsByCol.values()).forEach((colWells) => {
    colWells.sort((a, b) => a.row - b.row);
    for (let index = 1; index < colWells.length; index += 1) {
      pitches.push(Math.hypot(colWells[index].x - colWells[index - 1].x, colWells[index].y - colWells[index - 1].y));
    }
  });

  return medianNumber(pitches);
}

function computeApproxRoiPixelsPerWell(measurements: WellMeasurement[]): number | null {
  const counts = measurements
    .map((measurement) => measurement.roiFullPixels ?? measurement.roiCorePixels ?? measurement.roiUsedPixels ?? measurement.roiPixels)
    .filter((value): value is number => Number.isFinite(value));

  return medianNumber(counts);
}

function computeLaplacianVariance(grayValues: number[], width: number, height: number): number {
  const laplacianValues: number[] = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const center = grayValues[index];
      const up = y > 0 ? grayValues[(y - 1) * width + x] : center;
      const down = y + 1 < height ? grayValues[(y + 1) * width + x] : center;
      const left = x > 0 ? grayValues[y * width + x - 1] : center;
      const right = x + 1 < width ? grayValues[y * width + x + 1] : center;
      laplacianValues.push(4 * center - up - down - left - right);
    }
  }

  const mean = laplacianValues.reduce((sum, value) => sum + value, 0) / laplacianValues.length;
  const variance = laplacianValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) / laplacianValues.length;
  return variance;
}

function computeBoxBlur(grayValues: number[], width: number, height: number, kernelSize: number): number[] {
  const radius = Math.floor(kernelSize / 2);
  const integral = new Float32Array((width + 1) * (height + 1));

  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    const rowOffset = (y + 1) * (width + 1);
    const previousRowOffset = y * (width + 1);
    for (let x = 0; x < width; x += 1) {
      rowSum += grayValues[y * width + x];
      integral[rowOffset + x + 1] = integral[previousRowOffset + x + 1] + rowSum;
    }
  }

  const blurredValues = new Array<number>(width * height);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = (
        integral[(y1 + 1) * (width + 1) + x1 + 1]
        - integral[(y0) * (width + 1) + x1 + 1]
        - integral[(y1 + 1) * (width + 1) + x0]
        + integral[(y0) * (width + 1) + x0]
      );
      blurredValues[y * width + x] = sum / count;
    }
  }

  return blurredValues;
}

function computeFlatfieldSpan(grayValues: number[], width: number, height: number): number {
  const kernelHint = Math.min(width, height) / 5.0;
  let kernelSize = Math.round(kernelHint);
  kernelSize = Math.max(151, Math.min(601, kernelSize));
  if (kernelSize % 2 === 0) {
    kernelSize += 1;
  }

  const blurred = computeBoxBlur(grayValues, width, height, kernelSize);
  const sorted = [...blurred].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const p05 = percentile(sorted, 5);
  const p95 = percentile(sorted, 95);
  return (p95 - p05) / Math.max(median, 1e-6);
}

function computeHsvSaturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  if (max === 0) {
    return 0;
  }

  return (255 * (max - Math.min(r, g, b))) / max;
}

export function computePythonImageQcInfo(
  imageData: ImageData,
  wells: WellCenter[],
  measurements: WellMeasurement[],
  imageName: string | null,
  originalImageSize?: ImageSize,
): PythonImageQcInfo {
  const width = imageData.width;
  const height = imageData.height;
  const grayscaleValues: number[] = [];
  const pixels = imageData.data;
  let saturationCount = 0;
  let saturationAllCount = 0;
  let clipLowCount = 0;
  let specularCount = 0;
  const channelValues = [0, 0, 0];
  const channelSquares = [0, 0, 0];

  for (let index = 0; index < pixels.length; index += 4) {
    const r = pixels[index];
    const g = pixels[index + 1];
    const b = pixels[index + 2];
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    grayscaleValues.push(gray);

    if (r >= 250 || g >= 250 || b >= 250) {
      saturationCount += 1;
    }
    if (r >= 250 && g >= 250 && b >= 250) {
      saturationAllCount += 1;
    }
    if (r <= 3 || g <= 3 || b <= 3) {
      clipLowCount += 1;
    }

    const saturation = computeHsvSaturation(r, g, b);
    if (gray >= 245 && saturation <= 35) {
      specularCount += 1;
    }

    channelValues[0] += r;
    channelValues[1] += g;
    channelValues[2] += b;
    channelSquares[0] += r * r;
    channelSquares[1] += g * g;
    channelSquares[2] += b * b;
  }

  const pixelCount = Math.max(1, grayscaleValues.length);
  const channelMean = channelValues.map((value) => value / pixelCount);
  const channelStd = channelMean.map((mean, channelIndex) => {
    const variance = channelSquares[channelIndex] / pixelCount - mean * mean;
    return Math.sqrt(Math.max(variance, 0));
  });
  const deadChannel = Number(
    channelMean.some((mean, index) => mean < 8.0 || channelStd[index] < 1.5),
  );

  const blurScore = computeLaplacianVariance(grayscaleValues, width, height);
  const saturationFraction = saturationCount / pixelCount;
  const saturationAllChannelsFraction = saturationAllCount / pixelCount;
  const clipLowFraction = clipLowCount / pixelCount;
  const specularFraction = specularCount / pixelCount;
  const approxWellPitchPx = computeApproxWellPitchPx(wells);
  const approxRoiPixelsPerWell = computeApproxRoiPixelsPerWell(measurements);
  const flatfieldSpan = computeFlatfieldSpan(grayscaleValues, width, height);
  const maxSide = Math.max(width, height);
  const analysisImageSource = (() => {
    if (!originalImageSize || !Number.isFinite(originalImageSize.width) || !Number.isFinite(originalImageSize.height) || originalImageSize.width <= 0 || originalImageSize.height <= 0) {
      return 'original';
    }

    const resizeScale = width / originalImageSize.width;
    return Math.abs(resizeScale - 1.0) > 1e-3 ? 'in-memory resized from original' : 'original';
  })();
  const resizeScale = (() => {
    if (!originalImageSize || !Number.isFinite(originalImageSize.width) || !Number.isFinite(originalImageSize.height) || originalImageSize.width <= 0 || originalImageSize.height <= 0) {
      return Number.NaN;
    }
    return width / originalImageSize.width;
  })();

  const messages: string[] = [];
  let destructive = false;
  let borderline = false;
  let qualityWarning = false;

  if (deadChannel) {
    destructive = true;
    messages.push('dead channel');
  }
  if (saturationFraction > 0.003 || saturationAllChannelsFraction > 0.0008) {
    destructive = true;
    messages.push('saturation');
  } else if (saturationFraction > 0.0005) {
    borderline = true;
    messages.push('borderline saturation');
  }
  if (specularFraction > 0.003) {
    destructive = true;
    messages.push('specular reflections');
  } else if (specularFraction > 0.0005) {
    borderline = true;
    messages.push('borderline specular reflections');
  }
  if (Number.isFinite(flatfieldSpan) && flatfieldSpan > 0.18) {
    qualityWarning = true;
    messages.push('slow illumination/background gradient');
  }
  if (Number.isFinite(blurScore) && blurScore < 35.0) {
    borderline = true;
    messages.push('borderline blur');
  }
  if (maxSide < 900 || (approxRoiPixelsPerWell !== null && Number.isFinite(approxRoiPixelsPerWell) && approxRoiPixelsPerWell < 120)) {
    destructive = true;
    messages.push('resolution too low');
  }

  let initialImageQc = 'OK';
  let imageQcClass = 'good';
  if (destructive) {
    initialImageQc = 'FAIL';
    imageQcClass = 'non_correctable';
  } else if (qualityWarning) {
    initialImageQc = 'WARNING';
    imageQcClass = 'quality_warning';
  } else if (borderline) {
    initialImageQc = 'WARNING';
    imageQcClass = 'usable_with_warnings';
  }

  return {
    analysis_image_source: analysisImageSource,
    original_image_path: imageName ?? '',
    original_image_size: originalImageSize ? formatImageSize(originalImageSize) : '',
    analysis_image_size: formatImageSize({ width, height }),
    resize_scale: Number.isFinite(resizeScale) ? resizeScale : Number.NaN,
    approx_well_pitch_px: approxWellPitchPx,
    approx_roi_pixels_per_well: approxRoiPixelsPerWell,
    blur_score: Number.isFinite(blurScore) ? blurScore : Number.NaN,
    saturation_fraction: saturationFraction,
    saturation_all_channels_fraction: saturationAllChannelsFraction,
    clip_low_fraction: clipLowFraction,
    specular_fraction: specularFraction,
    dead_channel: deadChannel,
    flatfield_span: Number.isFinite(flatfieldSpan) ? flatfieldSpan : Number.NaN,
    initial_image_qc: initialImageQc,
    image_qc_class: imageQcClass,
    image_qc_messages: messages.join('; '),
  };
}
