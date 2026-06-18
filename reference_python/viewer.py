# -*- coding: utf-8 -*-
"""
OpenCV alignment viewer with a side help panel.

P mode:
- click the four outer well centers in this order:
  top-left, top-right, bottom-right, bottom-left

D mode:
- place the apparent floor circle in the same four-corner order

The blue floor circle always uses the same local radius as the corresponding
projected green mouth circle. Only the center is manually positioned.

This module saves and loads geometry in geometry_config.json via config_io.
"""

from __future__ import annotations

from typing import Optional, Tuple, Dict, Any, List

import cv2
import numpy as np

from .config_io import load_all_config, save_all_config


MOUTH_TO_PITCH = 6.90 / 9.0


def _row_label_from_index(idx: int) -> str:
    idx = int(idx)
    label = ""
    while True:
        idx, rem = divmod(idx, 26)
        label = chr(ord("A") + rem) + label
        if idx == 0:
            return label
        idx -= 1


def _corner_labels(nrow: int, ncol: int):
    last_row = _row_label_from_index(int(nrow) - 1)
    return ["A1", f"A{int(ncol)}", f"{last_row}{int(ncol)}", f"{last_row}1"]


def _corner_indexes(nrow: int, ncol: int):
    return [(0, 0), (0, int(ncol) - 1), (int(nrow) - 1, int(ncol) - 1), (int(nrow) - 1, 0)]



def _clamp(v: float, lo: float, hi: float) -> float:
    return float(max(lo, min(hi, v)))


def _local_pitch_px_from_centers(centers, r, c):
    nrow, ncol = centers.shape[:2]
    c0 = centers[r, c]
    ds = []
    if c > 0:
        ds.append(float(np.linalg.norm(c0 - centers[r, c - 1])))
    if c < ncol - 1:
        ds.append(float(np.linalg.norm(centers[r, c + 1] - c0)))
    if r > 0:
        ds.append(float(np.linalg.norm(c0 - centers[r - 1, c])))
    if r < nrow - 1:
        ds.append(float(np.linalg.norm(centers[r + 1, c] - c0)))
    return float(np.median(ds)) if ds else 1.0


def _perspective_grid_from_four_corners(a1, a12, h12, h1, nrow, ncol):
    src = np.array([
        [0.0, 0.0],
        [float(int(ncol) - 1), 0.0],
        [float(int(ncol) - 1), float(int(nrow) - 1)],
        [0.0, float(int(nrow) - 1)],
    ], dtype=np.float32)
    dst = np.asarray([a1, a12, h12, h1], dtype=np.float32)
    H = cv2.getPerspectiveTransform(src, dst)
    pts = np.zeros((int(nrow) * int(ncol), 1, 2), dtype=np.float32)
    idx = 0
    for r in range(int(nrow)):
        for c in range(int(ncol)):
            pts[idx, 0, 0] = float(c)
            pts[idx, 0, 1] = float(r)
            idx += 1
    mapped = cv2.perspectiveTransform(pts, H).reshape(int(nrow), int(ncol), 2)
    return mapped.astype(np.float32)


def _projected_mouth_radius_px(centers, r, c, mouth_to_pitch=MOUTH_TO_PITCH):
    lp = _local_pitch_px_from_centers(centers, r, c)
    return max(2.0, 0.5 * float(mouth_to_pitch) * float(lp))


def _draw_projected_mouth_circles(img, centers, scale, color=(0, 255, 0), thickness=1, mouth_to_pitch=MOUTH_TO_PITCH):
    nrow, ncol = centers.shape[:2]
    for r in range(nrow):
        for c in range(ncol):
            cx, cy = centers[r, c]
            rad = max(2, int(round(_projected_mouth_radius_px(centers, r, c, mouth_to_pitch) * scale)))
            xd = int(round(cx * scale))
            yd = int(round(cy * scale))
            cv2.circle(img, (xd, yd), rad, color, thickness, cv2.LINE_AA)


class PlateAlignViewer4Point:
    def __init__(self, img_bgr: np.ndarray, nrow: int = 8, ncol: int = 12, win: str = "Alignment"):
        self.img_bgr = img_bgr
        self.nrow = int(nrow)
        self.ncol = int(ncol)
        self.WIN = win

        g = load_all_config() or {}
        self.zoom = float(g.get("zoom", 1.0))

        self.corner_a1 = np.array(g["fourpt_a1_img"], dtype=np.float32) if g.get("fourpt_a1_img") is not None else None
        self.corner_a12 = np.array(g["fourpt_a12_img"], dtype=np.float32) if g.get("fourpt_a12_img") is not None else None
        self.corner_h12 = np.array(g["fourpt_h12_img"], dtype=np.float32) if g.get("fourpt_h12_img") is not None else None
        self.corner_h1 = np.array(g["fourpt_h1_img"], dtype=np.float32) if g.get("fourpt_h1_img") is not None else None

        self.floor_a1 = self._load_circle(g, "floor_a1_circle_img")
        self.floor_a12 = self._load_circle(g, "floor_a12_circle_img")
        self.floor_h12 = self._load_circle(g, "floor_h12_circle_img")
        self.floor_h1 = self._load_circle(g, "floor_h1_circle_img")

        self._pick_active = False
        self._pick_mode = "P"
        self._picked: List[Tuple[float, float]] = []
        self._mouse_x_img = None
        self._mouse_y_img = None
        self._last_display_scale = 1.0
        self.panel_w = 560
        self._preview_radius_delta = 0.0
        self._picked_radii: List[float] = []

    @staticmethod
    def _load_circle(cfg: Dict[str, Any], key: str):
        val = cfg.get(key)
        if not isinstance(val, (list, tuple)) or len(val) != 3:
            return None
        try:
            return np.array([float(val[0]), float(val[1]), float(val[2])], dtype=np.float32)
        except Exception:
            return None

    def _has_geometry(self):
        return (
            self.corner_a1 is not None and
            self.corner_a12 is not None and
            self.corner_h12 is not None and
            self.corner_h1 is not None
        )

    def _has_floor_geometry(self):
        return (
            self.floor_a1 is not None and
            self.floor_a12 is not None and
            self.floor_h12 is not None and
            self.floor_h1 is not None
        )

    def _get_centers(self):
        if not self._has_geometry():
            return None
        return _perspective_grid_from_four_corners(
            self.corner_a1, self.corner_a12, self.corner_h12, self.corner_h1, self.nrow, self.ncol
        )

    def _get_corner_mouth_circle(self, idx: int):
        centers = self._get_centers()
        if centers is None:
            return None
        rr, cc = _corner_indexes(self.nrow, self.ncol)[idx]
        cx = float(centers[rr, cc, 0])
        cy = float(centers[rr, cc, 1])
        rad = float(_projected_mouth_radius_px(centers, rr, cc))
        return np.array([cx, cy, rad], dtype=np.float32)

    def _start_pick_p(self):
        self._pick_active = True
        self._pick_mode = "P"
        self._picked = []
        self._picked_radii = []
        self._preview_radius_delta = 0.0

    def _start_pick_d(self):
        if not self._has_geometry():
            return
        self._pick_active = True
        self._pick_mode = "D"
        self._picked = []
        self._picked_radii = []
        self._preview_radius_delta = 0.0
        self.floor_a1 = None
        self.floor_a12 = None
        self.floor_h12 = None
        self.floor_h1 = None

    def _current_mouse_mouth_circle(self):
        if not self._pick_active or self._pick_mode != "P":
            return None
        if self._mouse_x_img is None or self._mouse_y_img is None:
            return None
        idx = len(self._picked)
        if idx > 3 or not self._has_geometry():
            return None
        ref = self._get_corner_mouth_circle(idx)
        if ref is None:
            return None
        rad = max(2.0, float(ref[2]) + float(self._preview_radius_delta))
        return np.array([float(self._mouse_x_img), float(self._mouse_y_img), rad], dtype=np.float32)

    def _current_mouse_floor_circle(self):
        if not self._pick_active or self._pick_mode != "D":
            return None
        if self._mouse_x_img is None or self._mouse_y_img is None:
            return None
        idx = len(self._picked)
        if idx > 3:
            return None
        ref = self._get_corner_mouth_circle(idx)
        if ref is None:
            return None
        rad = max(2.0, float(ref[2]) + float(self._preview_radius_delta))
        return np.array([float(self._mouse_x_img), float(self._mouse_y_img), rad], dtype=np.float32)

    def _draw_help_panel(self, panel: np.ndarray):
        panel[:] = (0, 0, 0)
        lines = [
            "Plate alignment",
            "",
            f"Plate format: {self.nrow} x {self.ncol}",
            "",
            "P: Place 4 outer green circles",
            f"  1) {_corner_labels(self.nrow, self.ncol)[0]}   2) {_corner_labels(self.nrow, self.ncol)[1]}   3) {_corner_labels(self.nrow, self.ncol)[2]}   4) {_corner_labels(self.nrow, self.ncol)[3]}",
            "",
            "D: Place 4 floor blue circles",
            f"  1) {_corner_labels(self.nrow, self.ncol)[0]}   2) {_corner_labels(self.nrow, self.ncol)[1]}   3) {_corner_labels(self.nrow, self.ncol)[2]}   4) {_corner_labels(self.nrow, self.ncol)[3]}",
            "  wheel = change green/blue radius",
            "",
            "ENTER: accept and save",
            "ESC:   exit without saving",
            "+ / -: zoom in/out",
        ]
        y = 30
        for s in lines:
            cv2.putText(panel, s, (15, y), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 1, cv2.LINE_AA)
            y += 26

        mode_text = f"Mode: {self._pick_mode}{' (active)' if self._pick_active else ''}"
        cv2.putText(panel, mode_text, (15, y + 10), cv2.FONT_HERSHEY_SIMPLEX, 0.75, (0, 255, 255), 2, cv2.LINE_AA)
        y += 44
        if self._pick_active:
            idx = min(len(self._picked), 3)
            msg = f"Picking {_corner_labels(self.nrow, self.ncol)[idx]} ({len(self._picked) + 1}/4)"
            cv2.putText(panel, msg, (15, y), cv2.FONT_HERSHEY_SIMPLEX, 0.72, (0, 255, 255), 2, cv2.LINE_AA)

    def _mouse_cb(self, event, x, y, flags, param):
        sc = self._last_display_scale
        xi = float(x) / max(1e-9, sc)
        yi = float(y) / max(1e-9, sc)

        if event == cv2.EVENT_MOUSEMOVE:
            self._mouse_x_img = xi
            self._mouse_y_img = yi
            return

        if event == cv2.EVENT_MOUSEWHEEL:
            if not self._pick_active:
                return
            delta = 1.5 if flags > 0 else -1.5
            self._preview_radius_delta = max(-200.0, min(200.0, self._preview_radius_delta + delta))
            return

        if event != cv2.EVENT_LBUTTONDOWN:
            return
        if not self._pick_active:
            return
        if len(self._picked) >= 4:
            return

        self._picked.append((xi, yi))
        if self._pick_mode == "P":
            ref = self._get_corner_mouth_circle(len(self._picked) - 1)
            base_r = float(ref[2]) if ref is not None else 8.0
        else:
            ref = self._get_corner_mouth_circle(len(self._picked) - 1)
            base_r = float(ref[2]) if ref is not None else 8.0
        self._picked_radii.append(max(2.0, base_r + float(self._preview_radius_delta)))
        self._preview_radius_delta = 0.0

        if len(self._picked) == 4:
            if self._pick_mode == "P":
                self.corner_a1 = np.array(self._picked[0], dtype=np.float32)
                self.corner_a12 = np.array(self._picked[1], dtype=np.float32)
                self.corner_h12 = np.array(self._picked[2], dtype=np.float32)
                self.corner_h1 = np.array(self._picked[3], dtype=np.float32)
            else:
                circles = []
                for i, pt in enumerate(self._picked):
                    rad = self._picked_radii[i] if i < len(self._picked_radii) else 8.0
                    circles.append(np.array([float(pt[0]), float(pt[1]), float(rad)], dtype=np.float32))
                self.floor_a1, self.floor_a12, self.floor_h12, self.floor_h1 = circles
            self._pick_active = False
            self._picked = []
            self._picked_radii = []
            self._preview_radius_delta = 0.0

    def _draw_circle(self, img, circle, sc, color, thickness=2):
        if circle is None:
            return
        x = int(round(float(circle[0]) * sc))
        y = int(round(float(circle[1]) * sc))
        r = max(2, int(round(float(circle[2]) * sc)))
        cv2.circle(img, (x, y), r, color, thickness, cv2.LINE_AA)

    def _draw_floor_corner_circles(self, plate, sc):
        for circle in [self.floor_a1, self.floor_a12, self.floor_h12, self.floor_h1]:
            self._draw_circle(plate, circle, sc, color=(255, 255, 0), thickness=2)

    def _compose_view(self):
        h, w = self.img_bgr.shape[:2]
        base_sc = 900.0 / max(1, h)
        sc = _clamp(base_sc * self.zoom, 0.05, 8.0)
        self._last_display_scale = sc

        plate = cv2.resize(self.img_bgr, (0, 0), fx=sc, fy=sc, interpolation=cv2.INTER_AREA)

        centers = self._get_centers()
        if centers is not None:
            _draw_projected_mouth_circles(plate, centers, sc, color=(0, 255, 0), thickness=1)

        self._draw_floor_corner_circles(plate, sc)

        if self._pick_active and self._pick_mode == "P":
            preview = self._current_mouse_mouth_circle()
            if preview is not None:
                self._draw_circle(plate, preview, sc, color=(0, 255, 0), thickness=2)

        if self._pick_active and self._pick_mode == "D":
            preview = self._current_mouse_floor_circle()
            if preview is not None:
                self._draw_circle(plate, preview, sc, color=(255, 255, 0), thickness=2)

        if self._pick_active and self._picked:
            if self._pick_mode == "P":
                for i, (xi, yi) in enumerate(self._picked):
                    rad = self._picked_radii[i] if i < len(self._picked_radii) else 8.0
                    circle = np.array([float(xi), float(yi), float(rad)], dtype=np.float32)
                    self._draw_circle(plate, circle, sc, color=(0, 255, 255), thickness=2)
            else:
                for i, (xi, yi) in enumerate(self._picked):
                    rad = self._picked_radii[i] if i < len(self._picked_radii) else 8.0
                    circle = np.array([float(xi), float(yi), float(rad)], dtype=np.float32)
                    self._draw_circle(plate, circle, sc, color=(255, 255, 0), thickness=2)

        panel = np.zeros((plate.shape[0], self.panel_w, 3), dtype=np.uint8)
        self._draw_help_panel(panel)
        return np.hstack([plate, panel])

    def run(self) -> Optional[Dict[str, Any]]:
        cv2.namedWindow(self.WIN, cv2.WINDOW_NORMAL)
        cv2.setMouseCallback(self.WIN, self._mouse_cb)

        while True:
            view = self._compose_view()
            cv2.imshow(self.WIN, view)

            k = cv2.waitKeyEx(20)
            if k == -1:
                continue

            if k == 27:
                cv2.destroyAllWindows()
                return None

            if k == 13:
                if not self._has_geometry():
                    continue
                out = {
                    "fourpt_a1_img": [float(self.corner_a1[0]), float(self.corner_a1[1])],
                    "fourpt_a12_img": [float(self.corner_a12[0]), float(self.corner_a12[1])],
                    "fourpt_h12_img": [float(self.corner_h12[0]), float(self.corner_h12[1])],
                    "fourpt_h1_img": [float(self.corner_h1[0]), float(self.corner_h1[1])],
                    "corner_a1": [float(self.corner_a1[0]), float(self.corner_a1[1])],
                    "corner_a12": [float(self.corner_a12[0]), float(self.corner_a12[1])],
                    "corner_h12": [float(self.corner_h12[0]), float(self.corner_h12[1])],
                    "corner_h1": [float(self.corner_h1[0]), float(self.corner_h1[1])],
                    "zoom": float(self.zoom),
                }
                if self._has_floor_geometry():
                    out.update({
                        "floor_a1_circle_img": [float(self.floor_a1[0]), float(self.floor_a1[1]), float(self.floor_a1[2])],
                        "floor_a12_circle_img": [float(self.floor_a12[0]), float(self.floor_a12[1]), float(self.floor_a12[2])],
                        "floor_h12_circle_img": [float(self.floor_h12[0]), float(self.floor_h12[1]), float(self.floor_h12[2])],
                        "floor_h1_circle_img": [float(self.floor_h1[0]), float(self.floor_h1[1]), float(self.floor_h1[2])],
                    })
                save_all_config(out)
                cv2.destroyAllWindows()
                return out

            ck = k & 0xFF
            if ck in (ord("p"), ord("P")):
                self._start_pick_p()
                continue
            if ck in (ord("d"), ord("D")):
                self._start_pick_d()
                continue
            if ck in (ord("+"), ord("=")):
                self.zoom = min(8.0, self.zoom * 1.12)
                continue
            if ck in (ord("-"), ord("_")):
                self.zoom = max(0.2, self.zoom / 1.12)
                continue


PlateAlignViewer = PlateAlignViewer4Point
