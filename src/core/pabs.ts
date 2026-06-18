import type { Rgb } from '../types/results';

const GAMMA = 2.2;
const EPSILON = 1e-9;
const CHANNELS = ['r', 'g', 'b'] as const;

export interface PAbsResult extends Rgb {
  warnings: string[];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return EPSILON;
  }

  return Math.min(1, Math.max(EPSILON, value));
}

export function linearizeRgb(rgb: Rgb): Rgb {
  return {
    r: Math.pow(clamp01(rgb.r / 255), GAMMA),
    g: Math.pow(clamp01(rgb.g / 255), GAMMA),
    b: Math.pow(clamp01(rgb.b / 255), GAMMA),
  };
}

export function computePAbs(wellRgb: Rgb, bgRgb: Rgb): PAbsResult {
  const wellLinear = linearizeRgb(wellRgb);
  const bgLinear = linearizeRgb(bgRgb);
  const warnings: string[] = [];
  const pabs = {
    r: 0,
    g: 0,
    b: 0,
  };

  for (const channel of CHANNELS) {
    if (!Number.isFinite(wellRgb[channel]) || wellRgb[channel] <= 0) {
      warnings.push(`${channel.toUpperCase()} well intensity clamped for PAbs`);
    }

    if (!Number.isFinite(bgRgb[channel]) || bgRgb[channel] <= 0) {
      warnings.push(`${channel.toUpperCase()} background intensity clamped for PAbs`);
    }

    const wellValue = Math.max(EPSILON, wellLinear[channel]);
    const bgValue = Math.max(EPSILON, bgLinear[channel]);
    pabs[channel] = Math.log10(bgValue / wellValue);
  }

  return {
    ...pabs,
    warnings,
  };
}
