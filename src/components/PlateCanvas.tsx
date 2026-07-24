import type { MouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { drawOverlay, estimateRoiRadius, getCanvasCoordinateSize, getImageAnalysisSize } from '../core/plate';
import type { FloorCircle, Point } from '../types/geometry';
import type { WellCenter } from '../types/plate';

interface PlateCanvasProps {
  image: HTMLImageElement | null;
  wells: WellCenter[];
  cornerLabels: string[];
  radiusFactor: number;
  onCanvasSizeChange: (size: { width: number; height: number } | null) => void;
  manualPoints: Point[];
  manualPickingActive: boolean;
  manualMouthRadiusPx: number;
  onManualPointPick: (point: Point) => void;
  onManualMouthPreviewMove?: (point: Point | null) => void;
  manualMouthConfirmAvailable?: boolean;
  onManualMouthConfirm?: () => void;
  onManualMouthRadiusAdjust: (delta: number) => void;
  floorCirclePickingActive: boolean;
  manualFloorCircles: FloorCircle[];
  manualFloorCirclePreview: FloorCircle | null;
  referenceFloorCircles: FloorCircle[];
  onFloorCirclePointerMove: (point: Point) => void;
  onFloorCirclePointPick: (point: Point) => void;
  floorCircleConfirmAvailable?: boolean;
  onFloorCircleConfirm?: () => void;
  onFloorCircleRadiusAdjust: (delta: number) => void;
  showMouthGrid: boolean;
  showFloorCircles: boolean;
  floorCircles: FloorCircle[] | null;
  enableCornerMagnifier: boolean;
}

const MANUAL_MOUTH_REFERENCES = [
  { label: 'A1', row: 0, col: 0 },
  { label: 'A12', row: 0, col: 11 },
  { label: 'H12', row: 7, col: 11 },
  { label: 'H1', row: 7, col: 0 },
] as const;
const DEFAULT_MANUAL_MOUTH_RADIUS = 28;

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function median(values: number[]): number | null {
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

function clampMouthRadius(radius: number): number {
  if (!Number.isFinite(radius)) {
    return DEFAULT_MANUAL_MOUTH_RADIUS;
  }

  return Math.max(8, Math.min(160, radius));
}

function estimateManualPitch(
  points: Point[],
  previewPoint: Point | null = null,
  previewIndex = -1,
): number | null {
  const referencePoints = [...points] as Array<Point | undefined>;

  if (previewPoint && previewIndex >= 0 && previewIndex < MANUAL_MOUTH_REFERENCES.length) {
    referencePoints[previewIndex] = previewPoint;
  }

  const pitches: number[] = [];
  const a1 = referencePoints[0];
  const a12 = referencePoints[1];
  const h12 = referencePoints[2];
  const h1 = referencePoints[3];

  if (a1 && a12) {
    pitches.push(distance(a1, a12) / 11);
  }

  if (h1 && h12) {
    pitches.push(distance(h1, h12) / 11);
  }

  if (a1 && h1) {
    pitches.push(distance(a1, h1) / 7);
  }

  if (a12 && h12) {
    pitches.push(distance(a12, h12) / 7);
  }

  return median(pitches.filter((pitch) => Number.isFinite(pitch) && pitch > 0));
}

function findReferenceRadius(wells: WellCenter[], referenceIndex: number, radiusFactor: number): number | null {
  const reference = MANUAL_MOUTH_REFERENCES[referenceIndex];

  if (!reference || wells.length === 0) {
    return null;
  }

  const radius = estimateRoiRadius(wells, reference.row, reference.col, radiusFactor);
  return Number.isFinite(radius) && radius > 1 ? radius : null;
}

function estimateManualMouthRadius(
  points: Point[],
  wells: WellCenter[],
  radiusFactor: number,
  referenceIndex: number,
  previewPoint: Point | null = null,
): number {
  const projectedRadius = points.length >= MANUAL_MOUTH_REFERENCES.length
    ? findReferenceRadius(wells, referenceIndex, radiusFactor)
    : null;

  if (projectedRadius) {
    return clampMouthRadius(projectedRadius);
  }

  const previewIndex = previewPoint ? referenceIndex : -1;
  const pitch = estimateManualPitch(points, previewPoint, previewIndex);

  if (pitch) {
    return clampMouthRadius(pitch * (Number.isFinite(radiusFactor) ? radiusFactor : 0.3));
  }

  return DEFAULT_MANUAL_MOUTH_RADIUS;
}

function drawMouthCircleLabel(
  ctx: CanvasRenderingContext2D,
  point: Point,
  label: string,
  radius: number,
  showCross = false,
): void {
  const lineWidth = Math.max(2.5, radius * 0.055);
  const centerRadius = Math.max(3, Math.min(7, radius * 0.16));
  const fontSize = Math.max(11, Math.min(24, radius * 0.42));

  ctx.save();

  ctx.setLineDash([Math.max(6, radius * 0.18), Math.max(5, radius * 0.14)]);
  ctx.fillStyle = 'rgba(255, 193, 7, 0.08)';
  ctx.strokeStyle = 'rgba(255, 193, 7, 0.98)';

  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.arc(point.x, point.y, centerRadius, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.82)';
  ctx.lineWidth = Math.max(1.5, centerRadius * 0.35);
  ctx.fill();
  ctx.stroke();

  if (showCross) {
    const crossRadius = Math.max(centerRadius * 2.2, radius * 0.18);
    ctx.beginPath();
    ctx.moveTo(point.x - crossRadius, point.y);
    ctx.lineTo(point.x + crossRadius, point.y);
    ctx.moveTo(point.x, point.y - crossRadius);
    ctx.lineTo(point.x, point.y + crossRadius);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.92)';
    ctx.lineWidth = Math.max(1.5, centerRadius * 0.28);
    ctx.stroke();
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `800 ${fontSize}px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.lineWidth = Math.max(2, fontSize * 0.22);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.72)';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.98)';
  ctx.strokeText(label, point.x, point.y - radius - fontSize * 0.55);
  ctx.fillText(label, point.x, point.y - radius - fontSize * 0.55);

  ctx.restore();
}

function drawManualMouthMarkers(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  previewPoint: Point | null,
  wells: WellCenter[],
  cornerLabels: string[],
  radiusFactor: number,
  manualMouthRadiusPx: number | null = null,
): void {
  if (points.length === 0 && !previewPoint) {
    return;
  }

  ctx.save();

  points.forEach((point, index) => {
    const radius = manualMouthRadiusPx ?? estimateManualMouthRadius(points, wells, radiusFactor, index);
    drawMouthCircleLabel(ctx, point, cornerLabels[index] ?? String(index + 1), radius);
  });

  if (previewPoint && points.length < MANUAL_MOUTH_REFERENCES.length) {
    const previewIndex = points.length;
    const radius = manualMouthRadiusPx ?? estimateManualMouthRadius(points, wells, radiusFactor, previewIndex, previewPoint);
    drawMouthCircleLabel(ctx, previewPoint, cornerLabels[previewIndex] ?? String(previewIndex + 1), radius, true);
  }

  ctx.restore();
}

function drawFloorCircleMarkers(
  ctx: CanvasRenderingContext2D,
  circles: FloorCircle[],
  previewCircle: FloorCircle | null,
  cornerLabels: string[],
): void {
  if (circles.length === 0 && !previewCircle) {
    return;
  }

  const canvas = ctx.canvas;
  const markerRadius = Math.max(9, Math.min(20, Math.max(canvas.width, canvas.height) * 0.006));
  const fontSize = Math.max(12, markerRadius);

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `800 ${fontSize}px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;

  circles.forEach((circle, index) => {
    ctx.beginPath();
    ctx.arc(circle.x, circle.y, circle.r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 193, 7, 0.08)';
    ctx.strokeStyle = 'rgba(255, 193, 7, 0.98)';
    ctx.lineWidth = Math.max(2, markerRadius * 0.16);
    ctx.setLineDash([Math.max(5, markerRadius * 0.8), Math.max(4, markerRadius * 0.5)]);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(circle.x, circle.y, markerRadius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.82)';
    ctx.lineWidth = Math.max(2, markerRadius * 0.14);
    ctx.fill();
    ctx.stroke();

    const label = cornerLabels[index] ?? String(index + 1);
    ctx.lineWidth = Math.max(2, fontSize * 0.18);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.82)';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.98)';
    ctx.strokeText(label, circle.x, circle.y + 0.5);
    ctx.fillText(label, circle.x, circle.y + 0.5);
  });

  if (previewCircle) {
    ctx.beginPath();
    ctx.arc(previewCircle.x, previewCircle.y, previewCircle.r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 193, 7, 0.08)';
    ctx.strokeStyle = 'rgba(255, 193, 7, 0.98)';
    ctx.lineWidth = Math.max(2, markerRadius * 0.18);
    ctx.setLineDash([Math.max(5, markerRadius * 0.8), Math.max(4, markerRadius * 0.5)]);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(previewCircle.x, previewCircle.y, markerRadius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.82)';
    ctx.lineWidth = Math.max(2, markerRadius * 0.14);
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(previewCircle.x - markerRadius * 1.6, previewCircle.y);
    ctx.lineTo(previewCircle.x + markerRadius * 1.6, previewCircle.y);
    ctx.moveTo(previewCircle.x, previewCircle.y - markerRadius * 1.6);
    ctx.lineTo(previewCircle.x, previewCircle.y + markerRadius * 1.6);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.82)';
    ctx.lineWidth = Math.max(1.5, markerRadius * 0.1);
    ctx.stroke();
  }

  ctx.restore();
}

export function PlateCanvas({
  image,
  wells,
  cornerLabels,
  radiusFactor,
  onCanvasSizeChange,
  manualPoints,
  manualPickingActive,
  manualMouthRadiusPx,
  onManualPointPick,
  onManualMouthPreviewMove,
  manualMouthConfirmAvailable = false,
  onManualMouthConfirm,
  onManualMouthRadiusAdjust,
  floorCirclePickingActive,
  manualFloorCircles,
  manualFloorCirclePreview,
  referenceFloorCircles,
  onFloorCirclePointerMove,
  onFloorCirclePointPick,
  floorCircleConfirmAvailable = false,
  onFloorCircleConfirm,
  onFloorCircleRadiusAdjust,
  showMouthGrid,
  showFloorCircles,
  floorCircles,
  enableCornerMagnifier,
}: PlateCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const magnifierCanvasRef = useRef<HTMLCanvasElement>(null);
  const activePointersRef = useRef<Map<number, Point>>(new Map());
  const lastPinchDistanceRef = useRef<number | null>(null);
  const suppressNextTouchClickRef = useRef(false);
  const [manualPreviewPoint, setManualPreviewPoint] = useState<Point | null>(null);
  const [magnifierPoint, setMagnifierPoint] = useState<Point | null>(null);
  const [magnifierSide, setMagnifierSide] = useState<'left' | 'right'>('right');

  useEffect(() => {
    if (!manualPickingActive) {
      setManualPreviewPoint(null);
      onManualMouthPreviewMove?.(null);
    }

  }, [floorCirclePickingActive, manualPickingActive, onManualMouthPreviewMove]);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const handleNativeWheel = (event: WheelEvent) => {
      if (floorCirclePickingActive) {
        event.preventDefault();
        onFloorCircleRadiusAdjust(event.deltaY < 0 ? 1.5 : -1.5);
        return;
      }

      if (manualPickingActive && manualPoints.length < MANUAL_MOUTH_REFERENCES.length) {
        event.preventDefault();
        onManualMouthRadiusAdjust(event.deltaY < 0 ? 1.5 : -1.5);
      }
    };

    canvas.addEventListener('wheel', handleNativeWheel, { passive: false });

    return () => {
      canvas.removeEventListener('wheel', handleNativeWheel);
    };
  }, [
    floorCirclePickingActive,
    manualPickingActive,
    manualPoints.length,
    onFloorCircleRadiusAdjust,
    onManualMouthRadiusAdjust,
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const activePointers = activePointersRef.current;
    const isRadiusGestureActive = () =>
      floorCirclePickingActive || (manualPickingActive && manualPoints.length < MANUAL_MOUTH_REFERENCES.length);

    const clearPinch = () => {
      activePointers.clear();
      lastPinchDistanceRef.current = null;
    };

    const getPinchDistance = () => {
      const pointers = Array.from(activePointers.values());

      if (pointers.length < 2) {
        return null;
      }

      return distance(pointers[0], pointers[1]);
    };

    const cssDeltaToCanvasDelta = (cssDelta: number) => {
      const rect = canvas.getBoundingClientRect();

      if (rect.width <= 0 || rect.height <= 0) {
        return cssDelta;
      }

      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const meanScale = (scaleX + scaleY) / 2;

      return cssDelta * meanScale * 0.45;
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (!isRadiusGestureActive() || event.pointerType === 'mouse') {
        return;
      }

      activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (activePointers.size >= 2) {
        event.preventDefault();
        lastPinchDistanceRef.current = getPinchDistance();
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch {
          // Ignore pointer-capture failures on older mobile browsers.
        }
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!isRadiusGestureActive() || event.pointerType === 'mouse' || !activePointers.has(event.pointerId)) {
        return;
      }

      activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (activePointers.size < 2) {
        return;
      }

      event.preventDefault();

      const nextDistance = getPinchDistance();
      const previousDistance = lastPinchDistanceRef.current;

      if (nextDistance === null || previousDistance === null) {
        lastPinchDistanceRef.current = nextDistance;
        return;
      }

      const delta = cssDeltaToCanvasDelta(nextDistance - previousDistance);

      if (Math.abs(delta) >= 0.25) {
        if (floorCirclePickingActive) {
          onFloorCircleRadiusAdjust(delta);
        } else {
          onManualMouthRadiusAdjust(delta);
        }

        lastPinchDistanceRef.current = nextDistance;
      }
    };

    const handlePointerEnd = (event: PointerEvent) => {
      if (activePointers.has(event.pointerId)) {
        activePointers.delete(event.pointerId);
      }

      lastPinchDistanceRef.current = activePointers.size >= 2 ? getPinchDistance() : null;
    };

    canvas.addEventListener('pointerdown', handlePointerDown, { passive: false });
    canvas.addEventListener('pointermove', handlePointerMove, { passive: false });
    canvas.addEventListener('pointerup', handlePointerEnd);
    canvas.addEventListener('pointercancel', handlePointerEnd);
    canvas.addEventListener('pointerleave', handlePointerEnd);

    return () => {
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', handlePointerEnd);
      canvas.removeEventListener('pointercancel', handlePointerEnd);
      canvas.removeEventListener('pointerleave', handlePointerEnd);
      clearPinch();
    };
  }, [
    floorCirclePickingActive,
    manualPickingActive,
    manualPoints.length,
    onFloorCircleRadiusAdjust,
    onManualMouthRadiusAdjust,
  ]);
  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas || !image) {
      onCanvasSizeChange(null);
      return;
    }

    const coordinateSize = manualPickingActive || manualPoints.length > 0
      ? getImageAnalysisSize(image)
      : getCanvasCoordinateSize(image, wells);

    if (canvas.width !== coordinateSize.width || canvas.height !== coordinateSize.height) {
      canvas.width = coordinateSize.width;
      canvas.height = coordinateSize.height;
    }

    onCanvasSizeChange({
      width: canvas.width,
      height: canvas.height,
    });

    const ctx = canvas.getContext('2d');

    if (!ctx) {
      return;
    }

    drawOverlay(ctx, image, wells, radiusFactor, coordinateSize, showMouthGrid, floorCircles, showFloorCircles);
    drawManualMouthMarkers(
      ctx,
      manualPoints,
      manualPickingActive && manualPoints.length < MANUAL_MOUTH_REFERENCES.length ? manualPreviewPoint : null,
      wells,
      cornerLabels,
      radiusFactor,
      manualPickingActive || manualPoints.length > 0 ? manualMouthRadiusPx : null,
    );
    drawFloorCircleMarkers(
      ctx,
      manualFloorCircles.length > 0 || floorCirclePickingActive
        ? manualFloorCircles
        : showFloorCircles
          ? referenceFloorCircles
          : [],
      manualFloorCirclePreview,
      cornerLabels,
    );
  }, [
    floorCirclePickingActive,
    floorCircles,
    image,
    manualFloorCirclePreview,
    manualFloorCircles,
    manualMouthRadiusPx,
    manualPickingActive,
    manualPoints,
    manualPreviewPoint,
    onCanvasSizeChange,
    radiusFactor,
    referenceFloorCircles,
    showFloorCircles,
    showMouthGrid,
    wells,
    cornerLabels,
  ]);

  useEffect(() => {
    const sourceCanvas = canvasRef.current;
    const magnifierCanvas = magnifierCanvasRef.current;

    if (!sourceCanvas || !magnifierCanvas || !magnifierPoint || !enableCornerMagnifier) {
      return;
    }

    const ctx = magnifierCanvas.getContext('2d');
    if (!ctx) {
      return;
    }

    const outputSize = 220;
    const sourceSize = Math.max(72, Math.min(132, Math.min(sourceCanvas.width, sourceCanvas.height) * 0.09));
    const halfSource = sourceSize / 2;
    const sourceX = Math.max(0, Math.min(sourceCanvas.width - sourceSize, magnifierPoint.x - halfSource));
    const sourceY = Math.max(0, Math.min(sourceCanvas.height - sourceSize, magnifierPoint.y - halfSource));

    if (magnifierCanvas.width !== outputSize || magnifierCanvas.height !== outputSize) {
      magnifierCanvas.width = outputSize;
      magnifierCanvas.height = outputSize;
    }

    ctx.clearRect(0, 0, outputSize, outputSize);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      sourceCanvas,
      sourceX,
      sourceY,
      sourceSize,
      sourceSize,
      0,
      0,
      outputSize,
      outputSize,
    );

    const center = outputSize / 2;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.98)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(center - 28, center);
    ctx.lineTo(center + 28, center);
    ctx.moveTo(center, center - 28);
    ctx.lineTo(center, center + 28);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.92)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(center - 28, center);
    ctx.lineTo(center + 28, center);
    ctx.moveTo(center, center - 28);
    ctx.lineTo(center, center + 28);
    ctx.stroke();
    ctx.restore();
  }, [enableCornerMagnifier, magnifierPoint, manualPreviewPoint, manualFloorCirclePreview]);

  const getCanvasPoint = (event: MouseEvent<HTMLCanvasElement> | ReactPointerEvent<HTMLCanvasElement>): Point | null => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    };
  };

  const isNearAnyCorner = (point: Point): boolean => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return false;
    }

    const horizontalLimit = canvas.width * 0.45;
    const verticalLimit = canvas.height * 0.45;
    const nearLeft = point.x <= horizontalLimit;
    const nearRight = point.x >= canvas.width - horizontalLimit;
    const nearTop = point.y <= verticalLimit;
    const nearBottom = point.y >= canvas.height - verticalLimit;

    return (nearLeft || nearRight) && (nearTop || nearBottom);
  };

  const updateMagnifier = (point: Point, forceForTouch = false) => {
    if (!enableCornerMagnifier) {
      setMagnifierPoint(null);
      return;
    }

    // Diagnostic V9 behavior:
    // for enabled plate formats, keep the magnifier active anywhere on the canvas.
    void forceForTouch;

    const canvas = canvasRef.current;
    if (canvas) {
      setMagnifierSide(point.x < canvas.width / 2 ? 'right' : 'left');
    }
    setMagnifierPoint(point);
  };

  const updatePickingPreview = (point: Point) => {
    if (floorCirclePickingActive) {
      onFloorCirclePointerMove(point);
      return;
    }

    if (manualPickingActive && manualPoints.length < MANUAL_MOUTH_REFERENCES.length) {
      setManualPreviewPoint(point);
      onManualMouthPreviewMove?.(point);
    }
  };

  const clearManualMouthPreview = () => {
    setManualPreviewPoint(null);
    onManualMouthPreviewMove?.(null);
  };

  const handleCanvasPointerPreview = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = getCanvasPoint(event);

    if (!point) {
      return;
    }

    if (event.pointerType === 'mouse') {
      updatePickingPreview(point);
      updateMagnifier(point);
      return;
    }

    suppressNextTouchClickRef.current = true;

    // Touch/pen workflow:
    // - one-finger press/drag moves the preview point and drives the side magnifier;
    // - two-finger pinch changes radius only.
    if (!event.isPrimary || activePointersRef.current.size >= 2) {
      return;
    }

    if (event.type === 'pointermove' && event.pressure <= 0) {
      return;
    }

    updatePickingPreview(point);
    updateMagnifier(point, true);
  };

  const clearMagnifier = () => {
    setMagnifierPoint(null);
  };

  const handleCanvasClick = (event: MouseEvent<HTMLCanvasElement>) => {
    if (suppressNextTouchClickRef.current) {
      suppressNextTouchClickRef.current = false;
      event.preventDefault();
      return;
    }

    const point = getCanvasPoint(event);

    if (!point) {
      return;
    }

    if (manualPickingActive && manualPoints.length < 4) {
      clearManualMouthPreview();
      onManualPointPick(point);
      return;
    }

    if (floorCirclePickingActive) {
      onFloorCirclePointPick(point);
    }
  };

  if (!image) {
    return (
      <div className="empty-canvas" role="status">
        No image selected
      </div>
    );
  }

  const floatingConfirmLabel = manualPickingActive && manualMouthConfirmAvailable
    ? 'CONFIRM MOUTH POINT'
    : floorCirclePickingActive && floorCircleConfirmAvailable
      ? 'CONFIRM FLOOR POINT'
      : '';

  const handleFloatingConfirm = () => {
    if (manualPickingActive && manualMouthConfirmAvailable) {
      onManualMouthConfirm?.();
      return;
    }

    if (floorCirclePickingActive && floorCircleConfirmAvailable) {
      onFloorCircleConfirm?.();
    }
  };

  return (
    <div className="canvas-stage">
      <canvas
        ref={canvasRef}
        className={`plate-canvas${manualPickingActive || floorCirclePickingActive ? ' is-picking' : ''}`}
        aria-label="96-well plate ROI overlay"
        onPointerDown={handleCanvasPointerPreview}
        onPointerMove={handleCanvasPointerPreview}
        onPointerUp={clearMagnifier}
        onPointerCancel={clearMagnifier}
        onMouseLeave={() => {
          clearManualMouthPreview();
          clearMagnifier();
        }}
        onClick={handleCanvasClick}
      />
      {enableCornerMagnifier && magnifierPoint ? (
        <aside
          className={`canvas-corner-magnifier is-${magnifierSide}`}
          aria-label="Magnified corner detail"
        >
          <canvas ref={magnifierCanvasRef} aria-hidden="true" />
          <span>Corner detail</span>
        </aside>
      ) : null}
      {floatingConfirmLabel ? (
        <button
          type="button"
          className="canvas-floating-confirm-button"
          onClick={handleFloatingConfirm}
        >
          {floatingConfirmLabel}
        </button>
      ) : null}
    </div>
  );
}
