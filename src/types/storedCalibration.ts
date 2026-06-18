import type { FitChannel } from './plateMap';
import type { MethodMetadata } from './results';

export interface StoredCalibrationFit {
  channel: FitChannel;
  slope: number;
  intercept: number;
  r2: number;
  n: number;
}

export interface RgbLowSignalClipPoint {
  concentration: number;
  yRaw: number;
  yShifted: number;
  yExpected: number;
  threshold: number;
  clipDelta: number;
}

export interface RgbLowSignalCorrection {
  channel: FitChannel;
  S0: number;
  forcedZeroSlope: number;
  nCalibrationPoints: number;
  nClipPoints: number;
  clipPoints: RgbLowSignalClipPoint[];
}

export interface StoredCalibration {
  version: 1 | 2;
  sourceName: string;
  createdAt: string;
  unit: 'mM';
  fits: StoredCalibrationFit[];
  corrections?: RgbLowSignalCorrection[];
  methodMetadata?: MethodMetadata;
}

export interface UnknownConcentrationResult {
  wellId: string;
  row: number;
  col: number;
  sampleId: string;
  dilutionFactor: number;
  channel: FitChannel;
  pabs: number;
  pabsRaw: number;
  pabsCorrected: number;
  correctionApplied: boolean;
  S0: number;
  clipDelta: number;
  storedCalibrationSlope: number;
  storedCalibrationIntercept: number;
  concentrationInDilutedSample: number;
  concentrationInOriginalSample: number;
  warnings: string[];
}
