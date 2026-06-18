import type { CalibrationFit, FitChannel, StandardAdditionFit, WellConfig } from '../types/plateMap';
import type { Rgb, WellMeasurement } from '../types/results';

const CHANNELS: FitChannel[] = ['R', 'G', 'B'];
const EPSILON = 1e-12;

interface LinearRegressionFit {
  slope: number;
  intercept: number;
  r2: number;
  n: number;
  warnings: string[];
}

interface StandardAdditionPoint {
  wellId: string;
  x: number;
  y: number;
}

interface StandardAdditionLevel {
  x: number;
  meanY: number;
  wells: string[];
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

function fitSignalSourceLabel(channel: FitChannel, correctedChannels: FitChannel[]): string {
  return `PAbs_${channel}${correctedChannels.includes(channel) ? '_corrected' : ''}`;
}

function invalidRegression(n: number, warning: string): LinearRegressionFit {
  return {
    slope: Number.NaN,
    intercept: Number.NaN,
    r2: Number.NaN,
    n,
    warnings: [warning],
  };
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }

  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function groupedStandardAdditionPoints(points: StandardAdditionPoint[]): Array<{ x: number; points: StandardAdditionPoint[] }> {
  const groups = new Map<string, { x: number; points: StandardAdditionPoint[] }>();

  for (const point of points) {
    const key = String(point.x);
    const group = groups.get(key);

    if (group) {
      group.points.push(point);
    } else {
      groups.set(key, { x: point.x, points: [point] });
    }
  }

  return [...groups.values()].sort((a, b) => a.x - b.x);
}

function standardAdditionDiagnosticWarnings(
  points: StandardAdditionPoint[],
  fit: LinearRegressionFit,
): string[] {
  const warnings: string[] = [];
  const groups = groupedStandardAdditionPoints(points);

  if (groups.length < 3) {
    warnings.push('Fewer than 3 added-concentration levels used for standard-addition fit.');
  }

  if (groups.some((group) => group.points.length > 1)) {
    warnings.push('Duplicated added-concentration levels present; verify replicate grouping.');
  }

  if (points.length === 0) {
    warnings.push('No finite standard-addition points were available.');
  }

  const meanSignals = groups.map((group) => mean(group.points.map((point) => point.y)));

  for (let index = 1; index < meanSignals.length; index += 1) {
    if (Number.isFinite(meanSignals[index - 1]) && Number.isFinite(meanSignals[index]) && meanSignals[index] < meanSignals[index - 1]) {
      warnings.push('Mean signal is non-monotonic with increasing additions.');
      break;
    }
  }

  const finiteY = points.map((point) => point.y).filter(Number.isFinite);

  if (finiteY.length > 0) {
    if (finiteY.some((value) => Math.abs(value) > 3)) {
      warnings.push('Unusually large PAbs signal; check descriptor source');
    }

    const yRange = Math.max(...finiteY) - Math.min(...finiteY);
    const yScale = Math.max(1e-12, Math.max(...finiteY.map((value) => Math.abs(value))));

    if (yRange <= 0.02 || yRange / yScale < 0.05) {
      warnings.push('Very low standard-addition signal dynamic range.');
    }
  }

  if (Number.isFinite(fit.intercept) && fit.intercept < 0) {
    warnings.push('Standard-addition intercept is negative.');
  }

  return [...new Set(warnings)];
}

function standardAdditionDiagnostics(
  sampleId: string,
  dilutionFactor: number,
  points: StandardAdditionPoint[],
  fit: LinearRegressionFit,
) {
  const groups = groupedStandardAdditionPoints(points);
  const finiteX = points.map((point) => point.x).filter(Number.isFinite);
  const finiteY = points.map((point) => point.y).filter(Number.isFinite);
  const warnings = standardAdditionDiagnosticWarnings(points, fit);

  return {
    groupKey: `${sampleId}|DF=${dilutionFactor}`,
    wellsUsed: points.map((point) => point.wellId),
    addedConcentrationsUsed: groups.map((group) => group.x),
    meanSignalValuesUsed: groups.map((group) => mean(group.points.map((point) => point.y))),
    replicatesPerAddedConcentration: groups.map((group) => `${group.x}:${group.points.length}`),
    fitXMin: finiteX.length > 0 ? Math.min(...finiteX) : null,
    fitXMax: finiteX.length > 0 ? Math.max(...finiteX) : null,
    fitYMin: finiteY.length > 0 ? Math.min(...finiteY) : null,
    fitYMax: finiteY.length > 0 ? Math.max(...finiteY) : null,
    fitDiagnosticWarning: warnings.join('; ') || null,
  };
}

function robustStandardAdditionDiagnostics(
  dilutionFactor: number,
  points: StandardAdditionPoint[],
) {
  const levels: StandardAdditionLevel[] = groupedStandardAdditionPoints(points).map((group) => ({
    x: group.x,
    meanY: mean(group.points.map((point) => point.y)),
    wells: group.points.map((point) => point.wellId),
  }));
  const warnings: string[] = [];

  if (levels.length < 5) {
    return {
      robustDiagnosticAvailable: false,
      suspectedOutlierAddedConcentrations: [],
      suspectedOutlierWells: [],
      robustDiagnosticLevelsUsed: null,
      robustDiagnosticAddedConcentrationsUsed: [],
      robustDiagnosticMeanSignalValuesUsed: [],
      robustDiagnosticSlope: null,
      robustDiagnosticIntercept: null,
      robustDiagnosticR2: null,
      robustDiagnosticConcentrationInOriginalSample: null,
      robustDiagnosticWarning: 'Robust diagnostic unavailable: fewer than 5 added-concentration levels.',
    };
  }

  const levelX = levels.map((level) => level.x);
  const levelY = levels.map((level) => level.meanY);
  const allLevelFit = fitLinearRegression(levelX, levelY);
  const finiteY = levelY.filter(Number.isFinite);
  const dynamicRange = finiteY.length > 0 ? Math.max(...finiteY) - Math.min(...finiteY) : Number.NaN;

  if (!Number.isFinite(dynamicRange) || dynamicRange <= EPSILON) {
    warnings.push('Robust diagnostic dynamic range is very low or unavailable.');
  } else {
    const yScale = Math.max(EPSILON, Math.max(...finiteY.map((value) => Math.abs(value))));

    if (dynamicRange <= 0.02 || dynamicRange / yScale < 0.05) {
      warnings.push('Robust diagnostic dynamic range is very low.');
    }
  }

  const residuals = levels.map((level) => (
    Number.isFinite(allLevelFit.slope) && Number.isFinite(allLevelFit.intercept)
      ? level.meanY - (allLevelFit.slope * level.x + allLevelFit.intercept)
      : Number.NaN
  ));
  const finiteResiduals = residuals.filter(Number.isFinite);
  const residualMedian = median(finiteResiduals);
  const residualMad = median(finiteResiduals.map((residual) => Math.abs(residual - residualMedian)));
  const residualScale = Number.isFinite(residualMad) ? 1.4826 * residualMad : Number.NaN;
  const smallEpsilon = Math.max(1e-6, Number.isFinite(dynamicRange) ? dynamicRange * 0.05 : 1e-6);
  const residualThreshold = Math.max(Number.isFinite(residualScale) ? 3 * residualScale : 0, smallEpsilon);
  const dropThreshold = Math.max(0.01, Number.isFinite(dynamicRange) ? dynamicRange * 0.15 : 0.01);
  const candidates = new Map<number, number>();

  residuals.forEach((residual, index) => {
    if (Number.isFinite(residual) && Math.abs(residual - residualMedian) > residualThreshold) {
      candidates.set(index, Math.max(candidates.get(index) ?? 0, Math.abs(residual - residualMedian)));
    }
  });

  for (let index = 1; index < levels.length; index += 1) {
    const drop = levels[index - 1].meanY - levels[index].meanY;

    if (Number.isFinite(drop) && drop > dropThreshold) {
      const score = drop + (index === levels.length - 1 ? dropThreshold : 0);
      candidates.set(index, Math.max(candidates.get(index) ?? 0, score));

      if (index === levels.length - 1) {
        warnings.push('Highest added-concentration level is a suspected terminal outlier.');
      }
    }
  }

  const maxOutlierLevels = Math.min(2, Math.max(0, levels.length - 4));
  const outlierIndexes = [...candidates.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxOutlierLevels)
    .map(([index]) => index)
    .sort((a, b) => a - b);
  const usedLevels = levels.filter((_, index) => !outlierIndexes.includes(index));
  const robustFit = usedLevels.length >= 4
    ? fitLinearRegression(usedLevels.map((level) => level.x), usedLevels.map((level) => level.meanY))
    : invalidRegression(usedLevels.length, 'Robust diagnostic fit requires at least 4 remaining levels.');
  let robustConcentrationInOriginalSample = Number.NaN;

  if (!Number.isFinite(robustFit.slope) || Math.abs(robustFit.slope) <= EPSILON || !Number.isFinite(robustFit.intercept)) {
    warnings.push('Robust diagnostic concentration unavailable because slope is invalid or zero.');
  } else {
    robustConcentrationInOriginalSample = dilutionFactor * (robustFit.intercept / robustFit.slope);
  }

  if (outlierIndexes.length === 0) {
    warnings.push('No suspected outlier levels detected; robust diagnostic fit uses all levels.');
  } else {
    warnings.push(`Suspected outlier levels removed for diagnostic fit: ${outlierIndexes.map((index) => levels[index].x).join(', ')}.`);
  }

  if (Number.isFinite(robustFit.intercept) && robustFit.intercept < 0) {
    warnings.push('Robust diagnostic intercept is negative.');
  }

  return {
    robustDiagnosticAvailable: true,
    suspectedOutlierAddedConcentrations: outlierIndexes.map((index) => levels[index].x),
    suspectedOutlierWells: outlierIndexes.flatMap((index) => levels[index].wells),
    robustDiagnosticLevelsUsed: usedLevels.length,
    robustDiagnosticAddedConcentrationsUsed: usedLevels.map((level) => level.x),
    robustDiagnosticMeanSignalValuesUsed: usedLevels.map((level) => level.meanY),
    robustDiagnosticSlope: robustFit.slope,
    robustDiagnosticIntercept: robustFit.intercept,
    robustDiagnosticR2: robustFit.r2,
    robustDiagnosticConcentrationInOriginalSample: robustConcentrationInOriginalSample,
    robustDiagnosticWarning: [...new Set(warnings)].join('; '),
  };
}

export function fitLinearRegression(x: number[], y: number[]): LinearRegressionFit {
  const points = x
    .map((xValue, index) => ({ x: xValue, y: y[index] }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  const n = points.length;

  if (n < 2) {
    return invalidRegression(n, 'At least 2 finite points are required');
  }

  const meanX = points.reduce((sum, point) => sum + point.x, 0) / n;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / n;
  let ssXX = 0;
  let ssXY = 0;
  let ssYY = 0;

  for (const point of points) {
    const dx = point.x - meanX;
    const dy = point.y - meanY;
    ssXX += dx * dx;
    ssXY += dx * dy;
    ssYY += dy * dy;
  }

  if (Math.abs(ssXX) <= EPSILON) {
    return invalidRegression(n, 'X values have zero variance');
  }

  const slope = ssXY / ssXX;
  const intercept = meanY - slope * meanX;
  let sse = 0;

  for (const point of points) {
    const predicted = slope * point.x + intercept;
    const residual = point.y - predicted;
    sse += residual * residual;
  }

  const r2 = Math.abs(ssYY) <= EPSILON ? (sse <= EPSILON ? 1 : Number.NaN) : 1 - sse / ssYY;

  return {
    slope,
    intercept,
    r2,
    n,
    warnings: [],
  };
}

export function fitCalibration(
  measurements: WellMeasurement[],
  plateMap: WellConfig[],
): CalibrationFit[] {
  const measurementByWell = new Map(measurements.map((measurement) => [measurement.wellId, measurement]));
  const calibrationWells = plateMap.filter((well) => (
    well.role === 'C' &&
    well.concentration !== null &&
    Number.isFinite(well.concentration)
  ));

  if (calibrationWells.length === 0) {
    return [];
  }

  return CHANNELS.map((channel) => {
    const x: number[] = [];
    const y: number[] = [];

    for (const well of calibrationWells) {
      const measurement = measurementByWell.get(well.wellId);

      if (!measurement || well.concentration === null) {
        continue;
      }

      x.push(well.concentration);
      y.push(channelValue(measurement.pabs, channel));
    }

    const fit = fitLinearRegression(x, y);

    return {
      channel,
      slope: fit.slope,
      intercept: fit.intercept,
      r2: fit.r2,
      n: fit.n,
    };
  });
}

export function fitStandardAddition(
  measurements: WellMeasurement[],
  plateMap: WellConfig[],
  correctedChannels: FitChannel[] = [],
): StandardAdditionFit[] {
  const measurementByWell = new Map(measurements.map((measurement) => [measurement.wellId, measurement]));
  const groups = new Map<string, { sampleId: string; dilutionFactor: number; wells: WellConfig[] }>();

  for (const well of plateMap) {
    if (
      well.role !== 'A' ||
      well.concentration === null ||
      !Number.isFinite(well.concentration) ||
      well.sampleId.trim() === ''
    ) {
      continue;
    }

    const dilutionFactor = Number.isFinite(well.dilutionFactor) ? well.dilutionFactor : 1;
    const sampleId = well.sampleId.trim();
    const key = `${sampleId}\u0000${dilutionFactor}`;
    const group = groups.get(key);

    if (group) {
      group.wells.push(well);
    } else {
      groups.set(key, {
        sampleId,
        dilutionFactor,
        wells: [well],
      });
    }
  }

  return [...groups.values()].flatMap((group) => CHANNELS.map((channel) => {
    const x: number[] = [];
    const y: number[] = [];
    const points: StandardAdditionPoint[] = [];
    const signalSourceUsedForFit = fitSignalSourceLabel(channel, correctedChannels);

    for (const well of group.wells) {
      const measurement = measurementByWell.get(well.wellId);

      if (!measurement || well.concentration === null) {
        continue;
      }

      x.push(well.concentration);
      const signal = channelValue(measurement.pabs, channel);
      y.push(signal);
      points.push({
        wellId: well.wellId,
        x: well.concentration,
        y: signal,
      });
    }

    const fit = fitLinearRegression(x, y);
    const diagnostics = standardAdditionDiagnostics(group.sampleId, group.dilutionFactor, points, fit);
    const robustDiagnostics = robustStandardAdditionDiagnostics(group.dilutionFactor, points);
    const warnings = [...fit.warnings, ...(diagnostics.fitDiagnosticWarning ? [diagnostics.fitDiagnosticWarning] : [])];
    let concentrationInDilutedSample = Number.NaN;
    let concentrationInOriginalSample = Number.NaN;

    if (!Number.isFinite(fit.slope) || Math.abs(fit.slope) <= EPSILON || !Number.isFinite(fit.intercept)) {
      warnings.push('Standard-addition concentration is undefined because slope is invalid or zero');
    } else {
      concentrationInDilutedSample = fit.intercept / fit.slope;
      concentrationInOriginalSample = group.dilutionFactor * concentrationInDilutedSample;
    }

    return {
      sampleId: group.sampleId,
      dilutionFactor: group.dilutionFactor,
      channel,
      slope: fit.slope,
      intercept: fit.intercept,
      r2: fit.r2,
      n: fit.n,
      concentrationInDilutedSample,
      concentrationInOriginalSample,
      signalSourceUsedForFit,
      ...diagnostics,
      ...robustDiagnostics,
      warnings,
    };
  }));
}
