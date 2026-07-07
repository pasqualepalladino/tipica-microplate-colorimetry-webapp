export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export type BackgroundModel = 'annular' | 'robust-interwell-v1' | 'physical-interwell-polynomial-v1';
export type RoiPixelStatisticsMode = 'simple-median' | 'robust-trimmed-v1';
export type BackgroundOutcome = 'local' | 'expanded' | 'global' | 'annular' | 'physical-polynomial';
export type RoiMode = 'simple' | 'floor-aware' | 'mouth-floor-intersection';

export interface MethodMetadata {
  roiMode: RoiMode;
  roiPixelStatisticsMode: RoiPixelStatisticsMode;
  backgroundModel: BackgroundModel;
  backgroundActualModel?: BackgroundModel;
  backgroundMaskAlgorithm?: string;
  backgroundCandidatePixels?: number;
  backgroundAcceptedSamples?: number;
  backgroundWarning?: string;
  correctionApplied: boolean;
  correctionSource?: string;
  correctionMetadata?: string;
  appVersion?: string;
  createdAt?: string;
  geometrySource?: string;
}

export interface WellMeasurement {
  wellId: string;
  row: number;
  col: number;
  roiPixels: number;
  bgPixels: number;
  backgroundModel: BackgroundModel;
  backgroundActualModel?: BackgroundModel;
  rgbWell: Rgb;
  rgbBackground: Rgb;
  pabs: Rgb;
  warnings: string[];
  backgroundOutcome?: BackgroundOutcome;
  candidatePixels?: number;
  acceptedPixels?: number;
  acceptedSamples?: number;
  candidateStride?: number;
  candidateRegionX0?: number;
  candidateRegionY0?: number;
  candidateRegionX1?: number;
  candidateRegionY1?: number;
  medianPitch?: number;
  wellExclusionRadiusApprox?: number;
  backgroundMaskAlgorithm?: string;
  backgroundWarning?: string;
  backgroundFitSuccess?: boolean;
  roiMode?: RoiMode;
  roiPixelStatisticsMode?: RoiPixelStatisticsMode;
  roiFullPixels?: number;
  roiCorePixels?: number;
  roiUsedPixels?: number;
  roiUsedFraction?: number;
  roiTrimDarkQ?: number | null;
  roiTrimBrightQ?: number | null;
  roiStatisticsWarning?: string;
  highlightFractionRoi?: number;
  highlightFractionCore?: number;
  brightExcludedFraction?: number;
  brightExcludedMeanGray?: number | null;
  brightExcessMeanGray?: number;
  highlightIndex?: number;
  floorGeometryAvailable?: boolean;
  floorRadiusUsed?: number;
  mouthRadiusUsed?: number;
  geometryA1MismatchPx?: number;
  geometryA12MismatchPx?: number;
  geometryH12MismatchPx?: number;
  geometryH1MismatchPx?: number;
  geometryAlignmentWarning?: string | null;
}
