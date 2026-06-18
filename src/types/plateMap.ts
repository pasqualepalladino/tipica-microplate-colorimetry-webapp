import type { MethodMetadata } from './results';

export type WellRole = 'EMPTY' | 'C' | 'A' | 'U';
export type FitChannel = 'R' | 'G' | 'B';

export interface WellConfig {
  wellId: string;
  row: number;
  col: number;
  role: WellRole;
  concentration: number | null;
  sampleId: string;
  dilutionFactor: number;
}

export interface CalibrationFit {
  channel: FitChannel;
  slope: number;
  intercept: number;
  r2: number;
  n: number;
  correctionApplied?: boolean;
  S0?: number | null;
  meanClipDelta?: number | null;
  methodMetadata?: MethodMetadata;
}

export interface StandardAdditionFit {
  sampleId: string;
  dilutionFactor: number;
  channel: FitChannel;
  slope: number;
  intercept: number;
  r2: number;
  n: number;
  concentrationInDilutedSample: number;
  concentrationInOriginalSample: number;
  correctionApplied?: boolean;
  S0?: number | null;
  meanClipDelta?: number | null;
  internalCalibrationSlope?: number | null;
  internalSlopeAgreement?: number | null;
  storedCalibrationSlope?: number | null;
  storedSlopeAgreement?: number | null;
  storedCalibrationCorrectedConcentrationInOriginalSample?: number | null;
  storedCalibrationCorrectedConcentrationSource?: string | null;
  storedCalibrationCorrectedConcentrationWarning?: string | null;
  signalSourceUsedForFit?: string;
  groupKey?: string;
  wellsUsed?: string[];
  addedConcentrationsUsed?: number[];
  meanSignalValuesUsed?: number[];
  replicatesPerAddedConcentration?: string[];
  fitXMin?: number | null;
  fitXMax?: number | null;
  fitYMin?: number | null;
  fitYMax?: number | null;
  fitDiagnosticWarning?: string | null;
  robustDiagnosticAvailable?: boolean;
  suspectedOutlierAddedConcentrations?: number[];
  suspectedOutlierWells?: string[];
  robustDiagnosticLevelsUsed?: number | null;
  robustDiagnosticAddedConcentrationsUsed?: number[];
  robustDiagnosticMeanSignalValuesUsed?: number[];
  robustDiagnosticSlope?: number | null;
  robustDiagnosticIntercept?: number | null;
  robustDiagnosticR2?: number | null;
  robustDiagnosticConcentrationInOriginalSample?: number | null;
  robustDiagnosticWarning?: string | null;
  methodMetadata?: MethodMetadata;
  warnings: string[];
}
