import type { FitChannel } from './plateMap';
import type { MethodMetadata } from './results';

export interface StoredCalibrationFit {
  channel: FitChannel;
  slope: number;
  intercept: number;
  r2: number;
  n: number;
  rmse?: number;
  sigmaCal?: number;
  sigmaSource?: string;
  snr?: number;
  lod?: number;
  loq?: number;
  S0?: number | null;
  nClipPoints?: number | null;
  clipX?: string;
  clipDelta?: string;
}

export interface PythonStoredCalibrationChannel {
  channel: string;
  n: number;
  slope: number;
  intercept: number;
  r2: number;
  rmse?: number;
  sigmaCal?: number;
  sigmaSource?: string;
  snr?: number;
  lod?: number;
  loq?: number;
  S0?: number | null;
  nClipPoints?: number | null;
  clipX?: string;
  clipDelta?: string;
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

export interface StoredCielabReference {
  l: number;
  a: number;
  b: number;
  source: string;
}

export interface StoredEmptyWellChannel {
  n: number;
  mean?: number;
  median?: number;
  sd?: number;
  robust_sd?: number;
  mad?: number;
}

export interface StoredEmptyWellPayload {
  Red?: StoredEmptyWellChannel;
  Green?: StoredEmptyWellChannel;
  Blue?: StoredEmptyWellChannel;
}

export interface StoredEmptyWellRow {
  Row: string;
  Col: number;
  Well: string;
  Signal_Red?: number;
  Signal_Green?: number;
  Signal_Blue?: number;
  UsedFraction?: number;
  [key: string]: unknown;
}

export interface EmptyWellQcPayload {
  status: 'warning' | 'watch' | 'ok' | 'not_available';
  empty_drift_score: number;
  empty_robust_sd_median: number;
  n_empty_channels: number;
}

export interface StoredCalibration {
  version: 1 | 2;
  sourceName: string;
  createdAt: string;
  unit: 'mM';
  fits: StoredCalibrationFit[];
  selectedChannel?: FitChannel;
  pythonChannels?: PythonStoredCalibrationChannel[];
  corrections?: RgbLowSignalCorrection[];
  methodMetadata?: MethodMetadata;
  cielabReference?: StoredCielabReference;
  emptyWellPayload?: StoredEmptyWellPayload;
  emptyWellRows?: StoredEmptyWellRow[];
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
