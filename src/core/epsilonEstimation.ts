import type { FlatBottomPlateGeometryPreset } from './physicalPlateGeometry';
import type { CalibrationFit, FitChannel } from '../types/plateMap';

export interface EstimatedEpsilonRow extends Record<string, string | number> {
  Channel: string;
  CalibrationSlope: number;
  ConcentrationUnit: string;
  MolarPerUnit: number;
  Volume_uL: number;
  WellBottomArea_mm2: number;
  EstimatedPathLength_cm: number;
  EstimatedEpsilon_M_1_cm_1: number;
  GeometryName: string;
  GeometrySource: string;
  PathLengthSource: 'user_volume_plus_nominal_plate_geometry';
  CalculationStatus: 'estimated_from_pabs_calibration_slope';
  ValidationStatus: 'estimated_not_validated';
  Assumption: 'nominal_flat_bottom_area_and_uniform_liquid_height';
}

export interface EstimatedEpsilonOptions {
  unitLabel: string;
  liquidVolumeUl: number | null;
  nominalPlatePreset: FlatBottomPlateGeometryPreset | null;
  calibrationFits: CalibrationFit[];
}

const MOLAR_FACTOR_BY_BASE: Record<string, number> = {
  M: 1,
  mM: 1e-3,
  uM: 1e-6,
  nM: 1e-9,
};

const CHANNEL_LABEL: Record<FitChannel, string> = {
  R: 'PAbs_Red',
  G: 'PAbs_Green',
  B: 'PAbs_Blue',
};

export function molarPerDisplayedUnit(unitLabel: string): number | null {
  const match = unitLabel.trim().match(/^(M|mM|uM|nM)(?:\s+10\^([+-]?\d+))?$/);
  if (!match) {
    return null;
  }

  const baseFactor = MOLAR_FACTOR_BY_BASE[match[1]];
  const exponent = match[2] == null ? 0 : Number(match[2]);

  if (!Number.isInteger(exponent)) {
    return null;
  }

  const factor = baseFactor * (10 ** exponent);
  return Number.isFinite(factor) && factor > 0 ? factor : null;
}

export function buildEstimatedEpsilonRows(options: EstimatedEpsilonOptions): EstimatedEpsilonRow[] {
  const volumeUl = options.liquidVolumeUl;
  const preset = options.nominalPlatePreset;
  const molarFactor = molarPerDisplayedUnit(options.unitLabel);

  if (
    volumeUl == null
    || !Number.isFinite(volumeUl)
    || volumeUl <= 0
    || preset == null
    || !Number.isFinite(preset.bottomAreaMm2)
    || preset.bottomAreaMm2 <= 0
    || molarFactor == null
  ) {
    return [];
  }

  const pathLengthCm = volumeUl / preset.bottomAreaMm2 / 10;

  if (!Number.isFinite(pathLengthCm) || pathLengthCm <= 0) {
    return [];
  }

  const geometrySource = `${preset.sourceManufacturer}: ${preset.sourceDocument} (${preset.sourceProfile})`;

  return options.calibrationFits
    .filter((fit) => Number.isFinite(fit.slope) && fit.slope > 0)
    .map((fit): EstimatedEpsilonRow => {
      const slopePerM = fit.slope / molarFactor;
      const epsilon = slopePerM / pathLengthCm;

      return {
        Channel: CHANNEL_LABEL[fit.channel],
        CalibrationSlope: fit.slope,
        ConcentrationUnit: options.unitLabel,
        MolarPerUnit: molarFactor,
        Volume_uL: volumeUl,
        WellBottomArea_mm2: preset.bottomAreaMm2,
        EstimatedPathLength_cm: pathLengthCm,
        EstimatedEpsilon_M_1_cm_1: epsilon,
        GeometryName: preset.displayName,
        GeometrySource: geometrySource,
        PathLengthSource: 'user_volume_plus_nominal_plate_geometry',
        CalculationStatus: 'estimated_from_pabs_calibration_slope',
        ValidationStatus: 'estimated_not_validated',
        Assumption: 'nominal_flat_bottom_area_and_uniform_liquid_height',
      };
    })
    .filter((row) => Number.isFinite(row.EstimatedEpsilon_M_1_cm_1) && row.EstimatedEpsilon_M_1_cm_1 > 0);
}
