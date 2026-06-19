import type { FloorCircle, PlateGeometry, Point } from '../types/geometry';
import { hasFloorGeometry } from './plate.js';

export type FloorGeometrySource = 'none' | 'json' | 'manual' | 'project';
export type FloorCircleKey = 'floor_a1_circle_img' | 'floor_a12_circle_img' | 'floor_h12_circle_img' | 'floor_h1_circle_img';

export const FLOOR_CIRCLE_REFERENCES: { label: string; key: FloorCircleKey; row: number; col: number }[] = [
  { label: 'A1', key: 'floor_a1_circle_img', row: 0, col: 0 },
  { label: 'A12', key: 'floor_a12_circle_img', row: 0, col: 11 },
  { label: 'H12', key: 'floor_h12_circle_img', row: 7, col: 11 },
  { label: 'H1', key: 'floor_h1_circle_img', row: 7, col: 0 },
];

export interface ReconciledLoadedGeometry {
  geometry: PlateGeometry;
  floorGeometrySource: FloorGeometrySource;
  preservedCurrentFloorGeometry: boolean;
  preservedCurrentPlateGeometry: boolean;
}

export interface ReconcileLoadedGeometryFloorOptions {
  preferCurrentFloorGeometry?: boolean;
  allowApproximateMouthGeometryMatch?: boolean;
}

function pointDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function medianNumber(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }

  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function estimateCornerPitch(geometry: PlateGeometry): number | null {
  return medianNumber([
    pointDistance(geometry.corner_a1, geometry.corner_a12) / 11,
    pointDistance(geometry.corner_h1, geometry.corner_h12) / 11,
    pointDistance(geometry.corner_a1, geometry.corner_h1) / 7,
    pointDistance(geometry.corner_a12, geometry.corner_h12) / 7,
  ].filter((pitch) => Number.isFinite(pitch) && pitch > 0));
}

function mouthGeometryMatches(a: PlateGeometry, b: PlateGeometry, tolerancePx = 2): boolean {
  return pointDistance(a.corner_a1, b.corner_a1) <= tolerancePx &&
    pointDistance(a.corner_a12, b.corner_a12) <= tolerancePx &&
    pointDistance(a.corner_h12, b.corner_h12) <= tolerancePx &&
    pointDistance(a.corner_h1, b.corner_h1) <= tolerancePx;
}

function mouthGeometryCompatibilityTolerance(
  loadedGeometry: PlateGeometry,
  currentGeometry: PlateGeometry,
  allowApproximateMouthGeometryMatch: boolean,
): number {
  if (!allowApproximateMouthGeometryMatch) {
    return 2;
  }

  const pitch = medianNumber([
    estimateCornerPitch(loadedGeometry),
    estimateCornerPitch(currentGeometry),
  ].filter((value): value is number => value !== null));

  return pitch ? Math.max(2, Math.min(24, pitch * 0.12)) : 2;
}

export function geometryWithFloorCircles(geometry: PlateGeometry, circles: FloorCircle[]): PlateGeometry {
  return {
    ...geometry,
    floor_a1_circle_img: { ...circles[0] },
    floor_a12_circle_img: { ...circles[1] },
    floor_h12_circle_img: { ...circles[2] },
    floor_h1_circle_img: { ...circles[3] },
  };
}

export function geometryWithoutFloorCircles(geometry: PlateGeometry): PlateGeometry {
  return {
    corner_a1: geometry.corner_a1,
    corner_a12: geometry.corner_a12,
    corner_h12: geometry.corner_h12,
    corner_h1: geometry.corner_h1,
    ...(geometry.mouth_radius_px ? { mouth_radius_px: geometry.mouth_radius_px } : {}),
    ...(geometry.roi_radius_factor ? { roi_radius_factor: geometry.roi_radius_factor } : {}),
  };
}

export function getReferenceFloorCircles(geometry: PlateGeometry | null): FloorCircle[] {
  if (!geometry) {
    return [];
  }

  return FLOOR_CIRCLE_REFERENCES
    .map(({ key }) => geometry[key])
    .filter((circle): circle is FloorCircle => Boolean(circle));
}

export function reconcileLoadedGeometryFloor(
  loadedGeometry: PlateGeometry,
  loadedFloorGeometrySource: FloorGeometrySource,
  currentGeometry: PlateGeometry | null,
  currentFloorGeometrySource: FloorGeometrySource,
  options: ReconcileLoadedGeometryFloorOptions = {},
): ReconciledLoadedGeometry {
  if (hasFloorGeometry(loadedGeometry)) {
    return {
      geometry: loadedGeometry,
      floorGeometrySource: loadedFloorGeometrySource,
      preservedCurrentFloorGeometry: false,
      preservedCurrentPlateGeometry: false,
    };
  }

  const currentReferenceFloorCircles = getReferenceFloorCircles(currentGeometry);
  const tolerancePx = currentGeometry
    ? mouthGeometryCompatibilityTolerance(
      loadedGeometry,
      currentGeometry,
      options.allowApproximateMouthGeometryMatch === true,
    )
    : 2;

  if (
    currentGeometry &&
    currentReferenceFloorCircles.length === FLOOR_CIRCLE_REFERENCES.length &&
    mouthGeometryMatches(loadedGeometry, currentGeometry, tolerancePx)
  ) {
    const floorGeometrySource = currentFloorGeometrySource === 'none' ? 'json' : currentFloorGeometrySource;

    if (options.preferCurrentFloorGeometry) {
      // A complete floor-capable geometry JSON is authoritative over an older
      // mouth-only project geometry. Keeping its mouth and floor coordinates
      // together makes project->geometry and geometry->project converge on the
      // same extraction geometry; the project still supplies plate map and
      // explicit analysis settings.
      return {
        geometry: currentGeometry,
        floorGeometrySource,
        preservedCurrentFloorGeometry: true,
        preservedCurrentPlateGeometry: true,
      };
    }

    // Project and geometry files can be loaded in either order. If the newly
    // loaded file is mouth-only, keep compatible floor circles already loaded
    // from the companion project/geometry file so derived floorCircles and
    // extraction math do not depend on load order.
    return {
      geometry: geometryWithFloorCircles(loadedGeometry, currentReferenceFloorCircles),
      floorGeometrySource,
      preservedCurrentFloorGeometry: true,
      preservedCurrentPlateGeometry: false,
    };
  }

  return {
    geometry: loadedGeometry,
    floorGeometrySource: 'none',
    preservedCurrentFloorGeometry: false,
    preservedCurrentPlateGeometry: false,
  };
}
