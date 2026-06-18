import type {
  CalibrationFit,
  FitChannel,
  StandardAdditionFit,
  WellConfig,
} from '../types/plateMap';
import type {
  StoredCalibration,
  StoredCalibrationFit,
  RgbLowSignalClipPoint,
  RgbLowSignalCorrection,
  UnknownConcentrationResult,
} from '../types/storedCalibration';
import type { BackgroundModel, MethodMetadata, Rgb, RoiMode, RoiPixelStatisticsMode, WellMeasurement } from '../types/results';

const CHANNELS: FitChannel[] = ['R', 'G', 'B'];
const EPSILON = 1e-12;
const NEGATIVE_STORED_CORRECTED_CONCENTRATION_WARNING = 'Negative stored-calibration corrected concentration; check standard-addition intercept and extraction quality.';
const INVALID_STORED_CALIBRATION_SLOPE_WARNING = 'invalid stored calibration slope';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Stored calibration ${label} must be a finite number.`);
  }

  return value;
}

function parsePositiveInteger(value: unknown, label: string): number {
  const parsed = parseFiniteNumber(value, label);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Stored calibration ${label} must be a positive integer.`);
  }

  return parsed;
}

function parseNonNegativeInteger(value: unknown, label: string): number {
  const parsed = parseFiniteNumber(value, label);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Stored calibration ${label} must be a non-negative integer.`);
  }

  return parsed;
}

function parseNonNegativeNumber(value: unknown, label: string): number {
  const parsed = parseFiniteNumber(value, label);

  if (parsed < 0) {
    throw new Error(`Stored calibration ${label} must be non-negative.`);
  }

  return parsed;
}

function parseChannel(value: unknown): FitChannel {
  if (value === 'R' || value === 'G' || value === 'B') {
    return value;
  }

  throw new Error('Stored calibration fit channel must be R, G, or B.');
}

function parseLowSignalClipPoint(rawClipPoint: unknown): RgbLowSignalClipPoint {
  if (!isRecord(rawClipPoint)) {
    throw new Error('Each stored calibration correction clip point must be an object.');
  }

  return {
    concentration: parseFiniteNumber(rawClipPoint.concentration, 'correction concentration'),
    yRaw: parseFiniteNumber(rawClipPoint.yRaw, 'correction yRaw'),
    yShifted: parseFiniteNumber(rawClipPoint.yShifted, 'correction yShifted'),
    yExpected: parseFiniteNumber(rawClipPoint.yExpected, 'correction yExpected'),
    threshold: parseNonNegativeNumber(rawClipPoint.threshold, 'correction threshold'),
    clipDelta: parseNonNegativeNumber(rawClipPoint.clipDelta, 'correction clipDelta'),
  };
}

function parseLowSignalCorrection(rawCorrection: unknown): RgbLowSignalCorrection {
  if (!isRecord(rawCorrection)) {
    throw new Error('Each stored calibration correction must be an object.');
  }

  if (!Array.isArray(rawCorrection.clipPoints)) {
    throw new Error('Stored calibration correction clipPoints must be an array.');
  }

  const clipPoints = rawCorrection.clipPoints.map(parseLowSignalClipPoint);

  return {
    channel: parseChannel(rawCorrection.channel),
    S0: parseNonNegativeNumber(rawCorrection.S0, 'correction S0'),
    forcedZeroSlope: parseFiniteNumber(rawCorrection.forcedZeroSlope, 'correction forcedZeroSlope'),
    nCalibrationPoints: parseNonNegativeInteger(rawCorrection.nCalibrationPoints, 'correction nCalibrationPoints'),
    nClipPoints: parseNonNegativeInteger(rawCorrection.nClipPoints, 'correction nClipPoints'),
    clipPoints,
  };
}

function channelValue(rgb: Rgb, channel: FitChannel): number {
  if (channel === 'R') {
    return rgb.r;
  }

  if (channel === 'G') {
    return rgb.g;
  }

  return rgb.b;
}

function parseStoredCalibrationFit(rawFit: unknown): StoredCalibrationFit {
  if (!isRecord(rawFit)) {
    throw new Error('Each stored calibration fit must be an object.');
  }

  return {
    channel: parseChannel(rawFit.channel),
    slope: parseFiniteNumber(rawFit.slope, 'slope'),
    intercept: parseFiniteNumber(rawFit.intercept, 'intercept'),
    r2: parseFiniteNumber(rawFit.r2, 'r2'),
    n: parsePositiveInteger(rawFit.n, 'n'),
  };
}

function parseRoiMode(value: unknown): RoiMode | null {
  return value === 'simple' || value === 'floor-aware' || value === 'mouth-floor-intersection' ? value : null;
}

function parseRoiPixelStatisticsMode(value: unknown): RoiPixelStatisticsMode | null {
  return value === 'simple-median' || value === 'robust-trimmed-v1' ? value : null;
}

function parseBackgroundModel(value: unknown): BackgroundModel | null {
  return value === 'annular' || value === 'robust-interwell-v1' || value === 'physical-interwell-polynomial-v1'
    ? value
    : null;
}

function parseOptionalMethodMetadata(rawMetadata: unknown): MethodMetadata | undefined {
  if (!isRecord(rawMetadata)) {
    return undefined;
  }

  const roiMode = parseRoiMode(rawMetadata.roiMode);
  const roiPixelStatisticsMode = parseRoiPixelStatisticsMode(rawMetadata.roiPixelStatisticsMode);
  const backgroundModel = parseBackgroundModel(rawMetadata.backgroundModel);

  if (!roiMode || !roiPixelStatisticsMode || !backgroundModel) {
    return undefined;
  }

  const backgroundActualModel = parseBackgroundModel(rawMetadata.backgroundActualModel);
  const backgroundCandidatePixels = typeof rawMetadata.backgroundCandidatePixels === 'number' && Number.isFinite(rawMetadata.backgroundCandidatePixels)
    ? rawMetadata.backgroundCandidatePixels
    : undefined;
  const backgroundAcceptedSamples = typeof rawMetadata.backgroundAcceptedSamples === 'number' && Number.isFinite(rawMetadata.backgroundAcceptedSamples)
    ? rawMetadata.backgroundAcceptedSamples
    : undefined;

  return {
    roiMode,
    roiPixelStatisticsMode,
    backgroundModel,
    ...(backgroundActualModel ? { backgroundActualModel } : {}),
    ...(typeof rawMetadata.backgroundMaskAlgorithm === 'string' ? { backgroundMaskAlgorithm: rawMetadata.backgroundMaskAlgorithm } : {}),
    ...(backgroundCandidatePixels !== undefined ? { backgroundCandidatePixels } : {}),
    ...(backgroundAcceptedSamples !== undefined ? { backgroundAcceptedSamples } : {}),
    ...(typeof rawMetadata.backgroundWarning === 'string' ? { backgroundWarning: rawMetadata.backgroundWarning } : {}),
    correctionApplied: rawMetadata.correctionApplied === true,
    ...(typeof rawMetadata.correctionSource === 'string' ? { correctionSource: rawMetadata.correctionSource } : {}),
    ...(typeof rawMetadata.correctionMetadata === 'string' ? { correctionMetadata: rawMetadata.correctionMetadata } : {}),
    ...(typeof rawMetadata.appVersion === 'string' ? { appVersion: rawMetadata.appVersion } : {}),
    ...(typeof rawMetadata.createdAt === 'string' ? { createdAt: rawMetadata.createdAt } : {}),
    ...(typeof rawMetadata.geometrySource === 'string' ? { geometrySource: rawMetadata.geometrySource } : {}),
  };
}

function normalizeCalibrationFits(fits: CalibrationFit[]): StoredCalibrationFit[] {
  const fitByChannel = new Map<FitChannel, CalibrationFit>();

  for (const fit of fits) {
    fitByChannel.set(fit.channel, fit);
  }

  return CHANNELS.map((channel) => {
    const fit = fitByChannel.get(channel);

    if (!fit) {
      throw new Error(`Current calibration is missing the ${channel} fit.`);
    }

    return {
      channel,
      slope: parseFiniteNumber(fit.slope, `${channel} slope`),
      intercept: parseFiniteNumber(fit.intercept, `${channel} intercept`),
      r2: parseFiniteNumber(fit.r2, `${channel} r2`),
      n: parsePositiveInteger(fit.n, `${channel} n`),
    };
  });
}

export function canCreateStoredCalibration(fits: CalibrationFit[]): boolean {
  try {
    normalizeCalibrationFits(fits);
    return true;
  } catch {
    return false;
  }
}

export function createStoredCalibrationFromFits(
  fits: CalibrationFit[],
  sourceName: string,
  corrections: RgbLowSignalCorrection[] = [],
  createdAt = new Date().toISOString(),
  methodMetadata?: MethodMetadata,
): StoredCalibration {
  const normalizedSourceName = sourceName.trim() || 'current image';

  return {
    version: 2,
    sourceName: normalizedSourceName,
    createdAt,
    unit: 'mM',
    fits: normalizeCalibrationFits(fits),
    corrections,
    ...(methodMetadata ? { methodMetadata: { ...methodMetadata, createdAt } } : {}),
  };
}

export function parseStoredCalibrationJson(raw: unknown): StoredCalibration {
  if (!isRecord(raw)) {
    throw new Error('Stored calibration JSON must be an object.');
  }

  const version = raw.version;

  if (version !== 1 && version !== 2) {
    throw new Error('Stored calibration version must be 1 or 2.');
  }

  if (raw.unit !== 'mM') {
    throw new Error('Stored calibration unit must be mM.');
  }

  if (typeof raw.sourceName !== 'string' || raw.sourceName.trim() === '') {
    throw new Error('Stored calibration sourceName must be a non-empty string.');
  }

  if (
    typeof raw.createdAt !== 'string' ||
    raw.createdAt.trim() === '' ||
    Number.isNaN(Date.parse(raw.createdAt))
  ) {
    throw new Error('Stored calibration createdAt must be a valid date string.');
  }

  if (!Array.isArray(raw.fits)) {
    throw new Error('Stored calibration fits must be an array.');
  }

  const fitByChannel = new Map<FitChannel, StoredCalibrationFit>();

  for (const rawFit of raw.fits) {
    const fit = parseStoredCalibrationFit(rawFit);

    if (fitByChannel.has(fit.channel)) {
      throw new Error(`Stored calibration has duplicate ${fit.channel} fits.`);
    }

    fitByChannel.set(fit.channel, fit);
  }

  const fits = CHANNELS.map((channel) => {
    const fit = fitByChannel.get(channel);

    if (!fit) {
      throw new Error(`Stored calibration is missing the ${channel} fit.`);
    }

    return fit;
  });
  let corrections: RgbLowSignalCorrection[] | undefined;

  if (Array.isArray(raw.corrections)) {
    const correctionByChannel = new Map<FitChannel, RgbLowSignalCorrection>();

    for (const rawCorrection of raw.corrections) {
      const correction = parseLowSignalCorrection(rawCorrection);

      if (correctionByChannel.has(correction.channel)) {
        throw new Error(`Stored calibration has duplicate ${correction.channel} corrections.`);
      }

      correctionByChannel.set(correction.channel, correction);
    }

    corrections = CHANNELS.flatMap((channel) => {
      const correction = correctionByChannel.get(channel);
      return correction ? [correction] : [];
    });
  }

  return {
    version,
    sourceName: raw.sourceName.trim(),
    createdAt: raw.createdAt,
    unit: 'mM',
    fits,
    corrections,
    methodMetadata: parseOptionalMethodMetadata(raw.methodMetadata),
  };
}

export function storedCalibrationToJson(calibration: StoredCalibration): string {
  return `${JSON.stringify(calibration, null, 2)}\n`;
}

export function downloadStoredCalibrationJson(
  calibration: StoredCalibration,
  fileName = 'stored_calibration.json',
): void {
  const blob = new Blob([storedCalibrationToJson(calibration)], { type: 'application/json;charset=utf-8' });
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

export function storedCalibrationFitForChannel(
  calibration: StoredCalibration,
  channel: FitChannel,
): StoredCalibrationFit | null {
  return calibration.fits.find((fit) => fit.channel === channel) ?? null;
}

export function storedCalibrationCorrectionForChannel(
  calibration: StoredCalibration,
  channel: FitChannel,
): RgbLowSignalCorrection | null {
  return calibration.corrections?.find((correction) => correction.channel === channel) ?? null;
}

function calculateSlopeAgreement(standardAdditionSlope: number, referenceSlope: number): number | null {
  if (!Number.isFinite(standardAdditionSlope) || !Number.isFinite(referenceSlope)) {
    return null;
  }

  const standardAbs = Math.abs(standardAdditionSlope);
  const referenceAbs = Math.abs(referenceSlope);
  const largest = Math.max(standardAbs, referenceAbs);

  if (largest <= EPSILON) {
    return null;
  }

  return Math.min(standardAbs, referenceAbs) / largest;
}

function storedCalibrationCorrectedStandardAdditionContext(
  fit: StandardAdditionFit,
  calibration: StoredCalibration | null,
  storedFit: StoredCalibrationFit | null,
): Pick<
  StandardAdditionFit,
  | 'storedCalibrationCorrectedConcentrationInOriginalSample'
  | 'storedCalibrationCorrectedConcentrationSource'
  | 'storedCalibrationCorrectedConcentrationWarning'
> {
  if (!calibration) {
    return {
      storedCalibrationCorrectedConcentrationInOriginalSample: null,
      storedCalibrationCorrectedConcentrationSource: 'stored calibration not loaded',
      storedCalibrationCorrectedConcentrationWarning: null,
    };
  }

  if (!storedFit) {
    return {
      storedCalibrationCorrectedConcentrationInOriginalSample: null,
      storedCalibrationCorrectedConcentrationSource: 'stored calibration slope unavailable',
      storedCalibrationCorrectedConcentrationWarning: null,
    };
  }

  if (!Number.isFinite(storedFit.slope) || Math.abs(storedFit.slope) <= EPSILON) {
    return {
      storedCalibrationCorrectedConcentrationInOriginalSample: null,
      storedCalibrationCorrectedConcentrationSource: 'stored calibration slope invalid',
      storedCalibrationCorrectedConcentrationWarning: INVALID_STORED_CALIBRATION_SLOPE_WARNING,
    };
  }

  if (!Number.isFinite(fit.intercept) || !Number.isFinite(fit.dilutionFactor)) {
    return {
      storedCalibrationCorrectedConcentrationInOriginalSample: null,
      storedCalibrationCorrectedConcentrationSource: 'stored calibration slope',
      storedCalibrationCorrectedConcentrationWarning: 'standard-addition intercept or dilution factor unavailable',
    };
  }

  const concentration = (fit.dilutionFactor * fit.intercept) / storedFit.slope;

  return {
    storedCalibrationCorrectedConcentrationInOriginalSample: concentration,
    storedCalibrationCorrectedConcentrationSource: 'stored calibration slope',
    storedCalibrationCorrectedConcentrationWarning: concentration < 0
      ? NEGATIVE_STORED_CORRECTED_CONCENTRATION_WARNING
      : null,
  };
}

export function addCalibrationSlopeContextToStandardAddition(
  fits: StandardAdditionFit[],
  internalCalibrationFits: CalibrationFit[],
  calibration: StoredCalibration | null,
): StandardAdditionFit[] {
  const internalFitByChannel = new Map(internalCalibrationFits.map((fit) => [fit.channel, fit]));

  return fits.map((fit) => {
    const internalFit = internalFitByChannel.get(fit.channel) ?? null;
    const storedFit = calibration ? storedCalibrationFitForChannel(calibration, fit.channel) : null;
    const internalCalibrationSlope = internalFit?.slope ?? null;
    const storedCalibrationSlope = storedFit?.slope ?? null;
    const storedCorrectedContext = storedCalibrationCorrectedStandardAdditionContext(fit, calibration, storedFit);

    return {
      ...fit,
      internalCalibrationSlope,
      internalSlopeAgreement: internalCalibrationSlope === null
        ? null
        : calculateSlopeAgreement(fit.slope, internalCalibrationSlope),
      storedCalibrationSlope,
      storedSlopeAgreement: storedCalibrationSlope === null
        ? null
        : calculateSlopeAgreement(fit.slope, storedCalibrationSlope),
      ...storedCorrectedContext,
    };
  });
}

export function estimateUnknownConcentrationsFromStoredCalibration(
  measurements: WellMeasurement[],
  plateMap: WellConfig[],
  calibration: StoredCalibration | null,
  useLowSignalCorrection = false,
): UnknownConcentrationResult[] {
  if (!calibration) {
    return [];
  }

  const measurementByWell = new Map(measurements.map((measurement) => [measurement.wellId, measurement]));
  const unknownWells = plateMap.filter((well) => well.role === 'U');
  const results: UnknownConcentrationResult[] = [];

  for (const well of unknownWells) {
    const measurement = measurementByWell.get(well.wellId);

    if (!measurement) {
      continue;
    }

    const dilutionFactor = Number.isFinite(well.dilutionFactor) ? well.dilutionFactor : 1;
    const sampleId = well.sampleId.trim() || well.wellId;

    for (const channel of CHANNELS) {
      const fit = storedCalibrationFitForChannel(calibration, channel);
      const correction = useLowSignalCorrection
        ? storedCalibrationCorrectionForChannel(calibration, channel)
        : null;
      const pabsRaw = channelValue(measurement.pabs, channel);
      const S0 = correction?.S0 ?? 0;
      const clipDelta = 0;
      const correctionApplied = Boolean(correction);
      const pabsCorrected = pabsRaw + S0 + clipDelta;
      const pabs = correctionApplied ? pabsCorrected : pabsRaw;
      const warnings: string[] = [];
      let concentrationInDilutedSample = Number.NaN;
      let concentrationInOriginalSample = Number.NaN;

      if (!fit || !Number.isFinite(fit.slope) || Math.abs(fit.slope) <= EPSILON) {
        warnings.push('Stored calibration slope is invalid or zero');
      } else if (!Number.isFinite(pabs)) {
        warnings.push('PAbs is not finite');
      } else {
        concentrationInDilutedSample = (pabs - fit.intercept) / fit.slope;
        concentrationInOriginalSample = concentrationInDilutedSample * dilutionFactor;
      }

      results.push({
        wellId: well.wellId,
        row: well.row,
        col: well.col,
        sampleId,
        dilutionFactor,
        channel,
        pabs,
        pabsRaw,
        pabsCorrected,
        correctionApplied,
        S0,
        clipDelta,
        storedCalibrationSlope: fit?.slope ?? Number.NaN,
        storedCalibrationIntercept: fit?.intercept ?? Number.NaN,
        concentrationInDilutedSample,
        concentrationInOriginalSample,
        warnings,
      });
    }
  }

  return results;
}
