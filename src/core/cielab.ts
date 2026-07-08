import type { WellConfig } from '../types/plateMap';
import type { Rgb, WellMeasurement } from '../types/results';
import type { StoredCalibration, StoredCielabReference } from '../types/storedCalibration';

export interface LabValue {
  l: number;
  a: number;
  b: number;
}

export interface CielabDiagnosticPoint extends LabValue {
  wellId: string;
  type: string;
  id: string;
  df: number;
  conc: number | '';
  deltaL: number | '';
  deltaA: number | '';
  deltaB: number | '';
  deltaE: number | '';
  deltaEChroma: number | '';
}

function srgbToLinearChannel(value: number): number {
  const normalized = Math.max(0, Math.min(1, value / 255));
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function medianFinite(values: number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[midpoint - 1] + sorted[midpoint]) / 2;
  }

  return sorted[midpoint];
}

export function rgbToLab(rgb: Rgb): LabValue {
  const r = srgbToLinearChannel(rgb.r);
  const g = srgbToLinearChannel(rgb.g);
  const b = srgbToLinearChannel(rgb.b);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = (0.2126729 * r + 0.7151522 * g + 0.0721750 * b);
  const z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
  const f = (value: number) => (value > 216 / 24389 ? Math.cbrt(value) : (841 / 108) * value + 4 / 29);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);

  return {
    l: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

function medianLab(values: LabValue[]): LabValue | null {
  if (values.length === 0) {
    return null;
  }

  return {
    l: medianFinite(values.map((value) => value.l)),
    a: medianFinite(values.map((value) => value.a)),
    b: medianFinite(values.map((value) => value.b)),
  };
}

export function resolveStoredCalibrationSlopeForCielabDescriptor(
  descriptorChannel: string,
  storedCalibration: StoredCalibration | null | undefined,
): number | null {
  const channelNames = descriptorChannel === 'DeltaE_ab' || descriptorChannel === 'DeltaE'
    ? ['DeltaE_ab', 'DeltaE']
    : descriptorChannel === 'DeltaE_ab_chroma' || descriptorChannel === 'DeltaE_chroma'
      ? ['DeltaE_ab_chroma', 'DeltaE_chroma']
      : [descriptorChannel];
  const pythonChannel = storedCalibration?.pythonChannels?.find((channel) => channelNames.includes(channel.channel));

  if (!pythonChannel || !Number.isFinite(pythonChannel.slope)) {
    return null;
  }

  return pythonChannel.slope;
}

export function computeCielabStdAddBetaBias(
  stdSlope: number,
  calibrationSlope: number | null | undefined,
  storedSlope: number | null | undefined,
): { beta: number | null; biasIndex: number | null } {
  const resolvedSlope = Number.isFinite(calibrationSlope) && calibrationSlope !== null && calibrationSlope !== undefined
    ? calibrationSlope
    : Number.isFinite(storedSlope) && storedSlope !== null && storedSlope !== undefined
      ? storedSlope
      : null;

  if (!Number.isFinite(stdSlope) || resolvedSlope === null || Math.abs(resolvedSlope) <= 1e-15) {
    return { beta: null, biasIndex: null };
  }

  const beta = stdSlope / resolvedSlope;
  return {
    beta: Number.isFinite(beta) ? beta : null,
    biasIndex: Number.isFinite(beta) ? Math.abs(beta - 1) : null,
  };
}

export function buildCielabDiagnosticPoints(
  measurements: WellMeasurement[],
  plateMap: WellConfig[],
  storedCielabReference?: StoredCielabReference,
): { points: CielabDiagnosticPoint[]; reference: LabValue | null; referenceSource: string } {
  const configByWell = new Map(plateMap.map((well) => [well.wellId, well]));
  const labByWell = new Map(measurements.map((measurement) => [measurement.wellId, rgbToLab(measurement.rgbWell)]));
  const calibrationConfigs = plateMap.filter((well) => (
    well.role === 'C' &&
    well.concentration !== null &&
    Number.isFinite(well.concentration) &&
    labByWell.has(well.wellId)
  ));
  const zeroCalibration = calibrationConfigs.filter((well) => Math.abs(well.concentration ?? Number.NaN) <= 1e-12);
  const referenceCandidates = zeroCalibration.length > 0
    ? zeroCalibration
    : calibrationConfigs.filter((well) => well.concentration === Math.min(...calibrationConfigs.map((candidate) => candidate.concentration ?? Number.POSITIVE_INFINITY)));
  const localReference = medianLab(referenceCandidates.map((well) => labByWell.get(well.wellId)).filter((value): value is LabValue => Boolean(value)));
  const storedReference = storedCielabReference
    ? {
        l: storedCielabReference.l,
        a: storedCielabReference.a,
        b: storedCielabReference.b,
      }
    : null;
  const reference = localReference ?? storedReference;
  const referenceSource = localReference
    ? zeroCalibration.length > 0
      ? 'plate_zero_calibration'
      : 'lowest_calibration'
    : storedReference
      ? storedCielabReference?.source || 'stored_calibration'
      : 'unavailable';

  const points = measurements.map((measurement) => {
    const config = configByWell.get(measurement.wellId);
    const lab = labByWell.get(measurement.wellId) ?? rgbToLab(measurement.rgbWell);
    const deltaL = reference ? lab.l - reference.l : Number.NaN;
    const deltaA = reference ? lab.a - reference.a : Number.NaN;
    const deltaB = reference ? lab.b - reference.b : Number.NaN;
    const deltaE = reference ? Math.sqrt(deltaL ** 2 + deltaA ** 2 + deltaB ** 2) : Number.NaN;
    const deltaEChroma = reference ? Math.sqrt(deltaA ** 2 + deltaB ** 2) : Number.NaN;
    const conc: number | '' = typeof config?.concentration === 'number' && Number.isFinite(config.concentration)
      ? config.concentration
      : '';
    const maybeNumber = (value: number): number | '' => (Number.isFinite(value) ? value : '');

    return {
      wellId: measurement.wellId,
      type: config?.role ?? '',
      id: config?.sampleId ?? '',
      df: config?.dilutionFactor ?? 1,
      conc,
      l: lab.l,
      a: lab.a,
      b: lab.b,
      deltaL: maybeNumber(deltaL),
      deltaA: maybeNumber(deltaA),
      deltaB: maybeNumber(deltaB),
      deltaE: maybeNumber(deltaE),
      deltaEChroma: maybeNumber(deltaEChroma),
    };
  });

  return { points, reference, referenceSource };
}
