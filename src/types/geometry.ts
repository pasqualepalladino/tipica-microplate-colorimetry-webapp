export interface Point {
  x: number;
  y: number;
}

export interface FloorCircle {
  x: number;
  y: number;
  r: number;
}

export interface PlateGeometry {
  corner_a1: Point;
  corner_a12: Point;
  corner_h12: Point;
  corner_h1: Point;
  mouth_radius_px?: number;
  roi_radius_factor?: number;
  floor_a1_circle_img?: FloorCircle;
  floor_a12_circle_img?: FloorCircle;
  floor_h12_circle_img?: FloorCircle;
  floor_h1_circle_img?: FloorCircle;
}
