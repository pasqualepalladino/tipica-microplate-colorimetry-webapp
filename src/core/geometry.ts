import type { PlateGeometry, Point } from '../types/geometry';

const GEOMETRY_KEYS = ['corner_a1', 'corner_a12', 'corner_h12', 'corner_h1'] as const;

type GeometryKey = (typeof GEOMETRY_KEYS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function parsePoint(value: unknown, key: GeometryKey): Point {
  let x: number | null = null;
  let y: number | null = null;

  if (Array.isArray(value) && value.length === 2) {
    x = toFiniteNumber(value[0]);
    y = toFiniteNumber(value[1]);
  } else if (isRecord(value)) {
    x = toFiniteNumber(value.x);
    y = toFiniteNumber(value.y);
  }

  if (x === null || y === null) {
    throw new Error(`Invalid geometry: ${key} must be [x, y] or { x, y } with finite numeric values.`);
  }

  return { x, y };
}

function parseFloorCircle(value: unknown, key: string) {
  let x: number | null = null;
  let y: number | null = null;
  let r: number | null = null;

  if (Array.isArray(value) && value.length === 3) {
    x = toFiniteNumber(value[0]);
    y = toFiniteNumber(value[1]);
    r = toFiniteNumber(value[2]);
  } else if (isRecord(value)) {
    x = toFiniteNumber(value.x);
    y = toFiniteNumber(value.y);
    r = toFiniteNumber(value.r);
  }

  if (x === null || y === null || r === null || r <= 0) {
    throw new Error(`Invalid geometry: ${key} must be [x, y, r] or { x, y, r } with finite numeric values.`);
  }

  return { x, y, r };
}

export function parseGeometryJson(raw: unknown): PlateGeometry {
  if (!isRecord(raw)) {
    throw new Error('Invalid geometry: expected a JSON object.');
  }

  const geometry: PlateGeometry = {
    corner_a1: parsePoint(raw.corner_a1, 'corner_a1'),
    corner_a12: parsePoint(raw.corner_a12, 'corner_a12'),
    corner_h12: parsePoint(raw.corner_h12, 'corner_h12'),
    corner_h1: parsePoint(raw.corner_h1, 'corner_h1'),
  };

  if (raw.mouth_radius_px !== undefined) {
    const mouthRadiusPx = toFiniteNumber(raw.mouth_radius_px);

    if (mouthRadiusPx === null || mouthRadiusPx <= 0) {
      throw new Error('Invalid geometry: mouth_radius_px must be a positive finite number.');
    }

    geometry.mouth_radius_px = mouthRadiusPx;
  }

  if (raw.roi_radius_factor !== undefined) {
    const roiRadiusFactor = toFiniteNumber(raw.roi_radius_factor);

    if (roiRadiusFactor === null || roiRadiusFactor <= 0) {
      throw new Error('Invalid geometry: roi_radius_factor must be a positive finite number.');
    }

    geometry.roi_radius_factor = roiRadiusFactor;
  }

  if (raw.floor_a1_circle_img !== undefined) {
    geometry.floor_a1_circle_img = parseFloorCircle(raw.floor_a1_circle_img, 'floor_a1_circle_img');
  }

  if (raw.floor_a12_circle_img !== undefined) {
    geometry.floor_a12_circle_img = parseFloorCircle(raw.floor_a12_circle_img, 'floor_a12_circle_img');
  }

  if (raw.floor_h12_circle_img !== undefined) {
    geometry.floor_h12_circle_img = parseFloorCircle(raw.floor_h12_circle_img, 'floor_h12_circle_img');
  }

  if (raw.floor_h1_circle_img !== undefined) {
    geometry.floor_h1_circle_img = parseFloorCircle(raw.floor_h1_circle_img, 'floor_h1_circle_img');
  }

  return geometry;
}
