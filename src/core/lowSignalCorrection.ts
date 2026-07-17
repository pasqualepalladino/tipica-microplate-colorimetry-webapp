import type { CalibrationFit, FitChannel, StandardAdditionFit, WellConfig } from '../types/plateMap';
import type { Rgb, WellMeasurement } from '../types/results';
import type { RgbLowSignalCorrection } from '../types/storedCalibration';

const CHANNELS: FitChannel[] = ['R', 'G', 'B'];
const EPSILON = 1e-12;

export interface WellChannelCorrectionApplication {
  wellId: string;
  role: WellConfig['role'];
  sampleId: string;
  dilutionFactor: number;
  concentration: number | null;
  channel: FitChannel;
  correctionApplied: boolean;
  S0: number;
  clipDelta: number;
  totalDelta: number;
  pabsRaw: number;
  pabsCorrected: number;
}

export interface CorrectedMeasurementSet {
  measurements: WellMeasurement[];
  applications: WellChannelCorrectionApplication[];
}

interface CalibrationPoint {
  concentration: number;
  yRaw: number;
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

function setChannelValue(rgb: Rgb, channel: FitChannel, value: number): Rgb {
  if (channel === 'R') {
    return { ...rgb, r: value };
  }

  if (channel === 'G') {
    return { ...rgb, g: value };
  }

  return { ...rgb, b: value };
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleSd(values: number[]): number | null {
  if (values.length < 2) {
    return null;
  }

  const valueMean = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - valueMean) ** 2, 0) / (values.length - 1);
  const sd = Math.sqrt(Math.max(0, variance));

  return Number.isFinite(sd) ? sd : null;
}

function groupedByConcentration(points: CalibrationPoint[]): CalibrationPoint[][] {
  const groups = new Map<string, CalibrationPoint[]>();

  for (const point of points) {
    const key = String(point.concentration);
    const group = groups.get(key);

    if (group) {
      group.push(point);
    } else {
      groups.set(key, [point]);
    }
  }

  return [...groups.values()].sort((a, b) => a[0].concentration - b[0].concentration);
}

function fitForcedZeroSlope(points: CalibrationPoint[], S0: number): number {
  let numerator = 0;
  let denominator = 0;

  for (const point of points) {
    const yShifted = point.yRaw + S0;
    numerator += point.concentration * yShifted;
    denominator += point.concentration * point.concentration;
  }

  if (Math.abs(denominator) <= EPSILON) {
    return Number.NaN;
  }

  return numerator / denominator;
}

function finiteCalibrationPoints(
  measurements: WellMeasurement[],
  plateMap: WellConfig[],
  channel: FitChannel,
): CalibrationPoint[] {
  const measurementByWell = new Map(measurements.map((measurement) => [measurement.wellId, measurement]));
  const points: CalibrationPoint[] = [];

  for (const well of plateMap) {
    if (well.role !== 'C' || well.concentration === null || !Number.isFinite(well.concentration)) {
      continue;
    }

    const measurement = measurementByWell.get(well.wellId);

    if (!measurement) {
      continue;
    }

    const yRaw = channelValue(measurement.pabs, channel);

    if (!Number.isFinite(yRaw)) {
      continue;
    }

    points.push({
      concentration: well.concentration,
      yRaw,
    });
  }

  return points;
}

export function computeRgbLowSignalCorrections(
  measurements: WellMeasurement[],
  plateMap: WellConfig[],
): RgbLowSignalCorrection[] {
  return CHANNELS.flatMap((channel) => {
    const points = finiteCalibrationPoints(measurements, plateMap, channel);

    if (points.length < 3) {
      return [];
    }

    const minRaw = Math.min(...points.map((point) => point.yRaw));
    const S0 = Math.max(0, -minRaw);
    const forcedZeroSlope = fitForcedZeroSlope(points, S0);
    const clipPoints = groupedByConcentration(points).map((group) => {
      const concentration = group[0].concentration;
      const yRaw = mean(group.map((point) => point.yRaw));
      const shiftedValues = group.map((point) => point.yRaw + S0);
      const yShifted = mean(shiftedValues);
      const yExpected = Number.isFinite(forcedZeroSlope) ? forcedZeroSlope * concentration : Number.NaN;
      const threshold = sampleSd(shiftedValues) ?? 0;
      const deficit = yExpected - yShifted;
      const clipDelta = Number.isFinite(deficit) && deficit > threshold ? Math.max(0, deficit) : 0;

      return {
        concentration,
        yRaw,
        yShifted,
        yExpected,
        threshold,
        clipDelta,
      };
    });

    return [{
      channel,
      S0,
      forcedZeroSlope,
      nCalibrationPoints: points.length,
      nClipPoints: clipPoints.filter((point) => point.clipDelta > 0).length,
      clipPoints,
    }];
  });
}

export function correctionForChannel(
  corrections: RgbLowSignalCorrection[],
  channel: FitChannel,
): RgbLowSignalCorrection | null {
  return corrections.find((correction) => correction.channel === channel) ?? null;
}

export function nearestClipDelta(
  correction: RgbLowSignalCorrection,
  concentration: number | null,
): number {
  if (concentration === null || !Number.isFinite(concentration) || correction.clipPoints.length === 0) {
    return 0;
  }

  let nearest = correction.clipPoints[0];
  let nearestDistance = Math.abs(nearest.concentration - concentration);

  for (const point of correction.clipPoints.slice(1)) {
    const distance = Math.abs(point.concentration - concentration);

    if (distance < nearestDistance) {
      nearest = point;
      nearestDistance = distance;
    }
  }

  return Number.isFinite(nearest.clipDelta) ? nearest.clipDelta : 0;
}

export function applyRgbLowSignalCorrections(
  measurements: WellMeasurement[],
  plateMap: WellConfig[],
  corrections: RgbLowSignalCorrection[],
  enabled: boolean,
): CorrectedMeasurementSet {
  if (!enabled || corrections.length === 0) {
    return {
      measurements,
      applications: [],
    };
  }

  const wellById = new Map(plateMap.map((well) => [well.wellId, well]));
  const applications: WellChannelCorrectionApplication[] = [];
  const correctedMeasurements = measurements.map((measurement) => {
    const well = wellById.get(measurement.wellId);

    if (!well || well.role === 'EMPTY') {
      return measurement;
    }

    let correctedPAbs = { ...measurement.pabs };

    for (const channel of CHANNELS) {
      const correction = correctionForChannel(corrections, channel);

      if (!correction) {
        continue;
      }

      const pabsRaw = channelValue(measurement.pabs, channel);
      const clipDelta = well.role === 'C' || well.role === 'A'
        ? nearestClipDelta(correction, well.concentration)
        : 0;
      const totalDelta = correction.S0 + clipDelta;
      const pabsCorrected = pabsRaw + totalDelta;

      correctedPAbs = setChannelValue(correctedPAbs, channel, pabsCorrected);
      applications.push({
        wellId: measurement.wellId,
        role: well.role,
        sampleId: well.sampleId.trim(),
        dilutionFactor: Number.isFinite(well.dilutionFactor) ? well.dilutionFactor : 1,
        concentration: well.concentration,
        channel,
        correctionApplied: true,
        S0: correction.S0,
        clipDelta,
        totalDelta,
        pabsRaw,
        pabsCorrected,
      });
    }

    return {
      ...measurement,
      pabs: correctedPAbs,
    };
  });

  return {
    measurements: correctedMeasurements,
    applications,
  };
}

function meanClipDelta(applications: WellChannelCorrectionApplication[]): number | null {
  if (applications.length === 0) {
    return null;
  }

  return mean(applications.map((application) => application.clipDelta));
}

export function addCorrectionMetadataToCalibrationFits(
  fits: CalibrationFit[],
  applications: WellChannelCorrectionApplication[],
  corrections: RgbLowSignalCorrection[],
): CalibrationFit[] {
  return fits.map((fit) => {
    const correction = correctionForChannel(corrections, fit.channel);
    const fitApplications = applications.filter((application) => (
      application.channel === fit.channel &&
      application.role === 'C'
    ));
    const correctionApplied = fitApplications.length > 0;

    return {
      ...fit,
      correctionApplied,
      S0: correctionApplied ? correction?.S0 ?? null : null,
      meanClipDelta: meanClipDelta(fitApplications),
    };
  });
}

export function addCorrectionMetadataToStandardAdditionFits(
  fits: StandardAdditionFit[],
  applications: WellChannelCorrectionApplication[],
  corrections: RgbLowSignalCorrection[],
): StandardAdditionFit[] {
  return fits.map((fit) => {
    const correction = correctionForChannel(corrections, fit.channel);
    const fitApplications = applications.filter((application) => (
      application.channel === fit.channel &&
      application.role === 'A' &&
      application.sampleId === fit.sampleId &&
      application.dilutionFactor === fit.dilutionFactor
    ));
    const correctionApplied = fitApplications.length > 0;

    return {
      ...fit,
      correctionApplied,
      S0: correctionApplied ? correction?.S0 ?? null : null,
      meanClipDelta: meanClipDelta(fitApplications),
    };
  });
}
