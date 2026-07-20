import type { FitChannel } from './plateMap';
import type { MethodMetadata } from './results';

export interface StoredCalibrationPoint {
  x: number;
  y: number;
  yerr: number;
  n: number;
  excluded?: boolean;
}

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
  points?: StoredCalibrationPoint[];
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
  points?: StoredCalibrationPoint[];
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

export interface ReliabilityPayload {
  reliability_score: number;
  confidence_class: 'HIGH' | 'MEDIUM' | 'LOW' | 'NOT QUANTIFIABLE';
  quantification_available: boolean;
  quantification_status: 'available' | 'not available';
  notes: string[];
  reason: string;
  empty_drift_score: number;
  empty_qc_status: string;
  epsilon: number;
  path_length: number;
  liquid_volume_ul: number;
  path_length_mm: number;
  path_length_source: string;
  well_bottom_diam_mm: number;
  well_bottom_area_mm2: number;
  plate_geometry_name: string;
  plate_geometry_assumption: string;
  epsilon_valid: boolean;
  path_length_valid: boolean;
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
