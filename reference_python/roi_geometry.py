# -*- coding: utf-8 -*-

import cv2
import numpy as np

def _local_pitch_px(centers, r, c):
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
    if len(ds) == 0:
        return 1.0
    return float(np.median(ds))

def _estimate_bg_cylinder_distance(union_mask_stat):
    # BG mask convention: white = inter-well background, black = wells/exterior.
    # The distance transform provides a local apparent cylinder radius around each well center.
    non_bg = np.zeros_like(union_mask_stat, dtype=np.uint8)
    non_bg[union_mask_stat == 0] = 255
    dist = cv2.distanceTransform(non_bg, cv2.DIST_L2, 5)
    return dist

def _ring_score(score_img, cx, cy, r, band=1.25):
    h, w = score_img.shape[:2]
    x0 = max(0, int(np.floor(cx - r - band - 2)))
    x1 = min(w, int(np.ceil(cx + r + band + 3)))
    y0 = max(0, int(np.floor(cy - r - band - 2)))
    y1 = min(h, int(np.ceil(cy + r + band + 3)))
    if x1 <= x0 or y1 <= y0:
        return -1e12
    yy, xx = np.mgrid[y0:y1, x0:x1]
    rr = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    ring = np.abs(rr - r) <= band
    n = int(np.count_nonzero(ring))
    if n < 10:
        return -1e12
    return float(np.mean(score_img[y0:y1, x0:x1][ring]))

def _refine_circle_fast(score_img, cx0, cy0, r0, max_shift=2, dr_values=(-2, -1, 0, 1, 2), band=1.25, r_lo=None, r_hi=None):
    best = (float(cx0), float(cy0), float(r0), -1e12)
    for dr in dr_values:
        r = float(r0 + dr)
        if r_lo is not None and r < r_lo:
            continue
        if r_hi is not None and r > r_hi:
            continue
        if r < 2.0:
            continue
        for dy in range(-max_shift, max_shift + 1):
            for dx in range(-max_shift, max_shift + 1):
                cx = float(cx0 + dx)
                cy = float(cy0 + dy)
                sc = _ring_score(score_img, cx, cy, r, band=band)
                if sc > best[3]:
                    best = (cx, cy, r, sc)
    return best

def _parse_circle_payload(payload):
    if not isinstance(payload, (list, tuple)) or len(payload) != 3:
        return None
    try:
        out = np.asarray([float(payload[0]), float(payload[1]), float(payload[2])], dtype=np.float32)
    except Exception:
        return None
    return out if np.isfinite(out).all() else None

def _project_grid_from_four_corner_circles(circles, nrow, ncol):
    keys = ["floor_a1_circle_img", "floor_a12_circle_img", "floor_h12_circle_img", "floor_h1_circle_img"]
    parsed = [_parse_circle_payload((circles or {}).get(k)) for k in keys]
    if any(v is None for v in parsed):
        return None, None
    src = np.array([
        [0.0, 0.0],
        [float(int(ncol) - 1), 0.0],
        [float(int(ncol) - 1), float(int(nrow) - 1)],
        [0.0, float(int(nrow) - 1)],
    ], dtype=np.float32)
    dst = np.asarray([[float(v[0]), float(v[1])] for v in parsed], dtype=np.float32)
    H = cv2.getPerspectiveTransform(src, dst)
    pts = np.zeros((int(nrow) * int(ncol), 1, 2), dtype=np.float32)
    idx = 0
    for rr in range(int(nrow)):
        for cc in range(int(ncol)):
            pts[idx, 0, 0] = float(cc)
            pts[idx, 0, 1] = float(rr)
            idx += 1
    mapped = cv2.perspectiveTransform(pts, H).reshape(int(nrow), int(ncol), 2).astype(np.float32)

    corner_r = np.asarray([float(v[2]) for v in parsed], dtype=np.float32)
    radii = np.zeros((int(nrow), int(ncol)), dtype=np.float32)
    for rr in range(int(nrow)):
        tr = 0.0 if int(nrow) <= 1 else float(rr) / float(int(nrow) - 1)
        left_r = (1.0 - tr) * corner_r[0] + tr * corner_r[3]
        right_r = (1.0 - tr) * corner_r[1] + tr * corner_r[2]
        for cc in range(int(ncol)):
            tc = 0.0 if int(ncol) <= 1 else float(cc) / float(int(ncol) - 1)
            radii[rr, cc] = (1.0 - tc) * left_r + tc * right_r
    return mapped, radii

def _build_well_bottom_masks_v12(
    centers,
    img_bgr,
    union_mask_stat,
    pitch_mm,
    mouth_diam_mm,
    floor_diam_mm,
    well_depth_mm,
    interface_rel_to_mouth=0.885,
    floor_rel_to_interface=0.905,
    max_shift_frac_of_interface_r=0.12,
    roi_mode="circle",
    floor_corner_circles=None,
):
    h, w = img_bgr.shape[:2]
    nrow, ncol = centers.shape[:2]

    imgf = img_bgr.astype(np.float32)
    b = imgf[:, :, 0]
    g = imgf[:, :, 1]
    r = imgf[:, :, 2]
    purple = 0.5 * (r + b) - g
    purple = cv2.GaussianBlur(purple, (5, 5), 0)

    gx = cv2.Sobel(purple, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(purple, cv2.CV_32F, 0, 1, ksize=3)
    grad_mag = cv2.magnitude(gx, gy)

    plate_center = np.mean(centers.reshape(-1, 2), axis=0).astype(np.float32)

    dmax = 1e-6
    for r_i in range(nrow):
        for c_i in range(ncol):
            dmax = max(dmax, float(np.linalg.norm(centers[r_i, c_i] - plate_center)))

    bg_cyl_dist = _estimate_bg_cylinder_distance(union_mask_stat)

    masks = [[None for _ in range(ncol)] for _ in range(nrow)]
    shapes = [[None for _ in range(ncol)] for _ in range(nrow)]
    manual_floor_centers, manual_floor_radii = _project_grid_from_four_corner_circles(floor_corner_circles, nrow, ncol)

    for r_i in range(nrow):
        for c_i in range(ncol):
            C = centers[r_i, c_i].astype(np.float32)
            cx0 = float(C[0])
            cy0 = float(C[1])

            local_pitch = _local_pitch_px(centers, r_i, c_i)
            px_per_mm = local_pitch / float(pitch_mm)

            mouth_r_geom = 0.5 * float(mouth_diam_mm) * px_per_mm
            floor_r_geom = 0.5 * float(floor_diam_mm) * px_per_mm

            iy = int(round(np.clip(cy0, 0, h - 1)))
            ix = int(round(np.clip(cx0, 0, w - 1)))
            cyl_r_bg = float(bg_cyl_dist[iy, ix])

            interface_r0 = float(interface_rel_to_mouth * mouth_r_geom)
            if cyl_r_bg > 2.0:
                interface_r0 = min(interface_r0, 0.84 * cyl_r_bg)
            interface_r0 = float(np.clip(interface_r0, 0.76 * mouth_r_geom, 0.91 * mouth_r_geom))

            iface_cx, iface_cy, iface_r, iface_score = _refine_circle_fast(
                score_img=grad_mag,
                cx0=cx0,
                cy0=cy0,
                r0=interface_r0,
                max_shift=2,
                dr_values=(-2, -1, 0, 1, 2),
                band=1.10,
                r_lo=0.74 * mouth_r_geom,
                r_hi=0.92 * mouth_r_geom,
            )

            floor_r0 = min(0.90 * floor_r_geom, floor_rel_to_interface * iface_r)
            floor_r0 = float(np.clip(floor_r0, 0.76 * iface_r, 0.90 * iface_r))

            v = C - plate_center
            d = float(np.linalg.norm(v))
            if d < 1e-9:
                u = np.array([0.0, 0.0], dtype=np.float32)
            else:
                u = v / d

            radial = (d / dmax) ** 1.30
            depth_factor = float(well_depth_mm) / max(1.0, float(well_depth_mm))
            shift_px_auto = max_shift_frac_of_interface_r * depth_factor * radial * iface_r
            shift_px_auto = float(np.clip(shift_px_auto, 0.0, 0.13 * iface_r))

            if manual_floor_centers is not None and manual_floor_radii is not None:
                floor_cx = float(manual_floor_centers[r_i, c_i, 0])
                floor_cy = float(manual_floor_centers[r_i, c_i, 1])
                floor_r_manual = float(manual_floor_radii[r_i, c_i])
                floor_r = float(np.clip(floor_r_manual, 0.50 * mouth_r_geom, 1.05 * mouth_r_geom))
                floor_score = np.nan
                shift_px_used = float(np.hypot(floor_cx - cx0, floor_cy - cy0))
                floor_source = 'manual_D_projection'
            else:
                floor_cx0 = iface_cx - shift_px_auto * float(u[0])
                floor_cy0 = iface_cy - shift_px_auto * float(u[1])
                floor_cx, floor_cy, floor_r, floor_score = _refine_circle_fast(
                    score_img=grad_mag,
                    cx0=floor_cx0,
                    cy0=floor_cy0,
                    r0=floor_r0,
                    max_shift=2,
                    dr_values=(-2, -1, 0, 1),
                    band=1.05,
                    r_lo=0.72 * iface_r,
                    r_hi=0.91 * iface_r,
                )
                shift_px_used = float(np.hypot(floor_cx - cx0, floor_cy - cy0))
                floor_source = 'auto_refined'

            m = np.zeros((h, w), dtype=np.uint8)
            x0 = max(0, int(np.floor(min(cx0 - mouth_r_geom, floor_cx - floor_r) - 3.0)))
            x1 = min(w, int(np.ceil(max(cx0 + mouth_r_geom, floor_cx + floor_r) + 4.0)))
            y0 = max(0, int(np.floor(min(cy0 - mouth_r_geom, floor_cy - floor_r) - 3.0)))
            y1 = min(h, int(np.ceil(max(cy0 + mouth_r_geom, floor_cy + floor_r) + 4.0)))
            yy, xx = np.mgrid[y0:y1, x0:x1]
            mask_mouth = ((xx - cx0) ** 2 + (yy - cy0) ** 2) <= (mouth_r_geom ** 2)
            mask_floor = ((xx - floor_cx) ** 2 + (yy - floor_cy) ** 2) <= (floor_r ** 2)
            m[y0:y1, x0:x1][mask_mouth & mask_floor] = 255

            m = _clean_roi_mask(m, min_keep_frac=0.60)

            masks[r_i][c_i] = m
            shapes[r_i][c_i] = {
                'cx': cx0,
                'cy': cy0,
                'local_pitch_px': float(local_pitch),
                'px_per_mm': float(px_per_mm),
                'cyl_r_bg': float(cyl_r_bg),
                'mouth_r_geom': float(mouth_r_geom),
                'floor_r_geom': float(floor_r_geom),
                'mouth_cx': float(cx0),
                'mouth_cy': float(cy0),
                'mouth_r': float(mouth_r_geom),
                'mouth_score': float(iface_score),
                'interface_cx': float(iface_cx),
                'interface_cy': float(iface_cy),
                'interface_r': float(iface_r),
                'floor_cx': float(floor_cx),
                'floor_cy': float(floor_cy),
                'floor_r': float(floor_r),
                'floor_score': float(floor_score) if np.isfinite(floor_score) else np.nan,
                'shift_px': float(shift_px_used),
                'shift_px_auto': float(shift_px_auto),
                'floor_source': floor_source,
            }

    return masks, shapes, bg_cyl_dist

def _clean_roi_mask(mask_u8, min_keep_frac=0.60):
    if mask_u8 is None:
        return mask_u8
    area0 = int(np.count_nonzero(mask_u8))
    if area0 <= 0:
        return mask_u8
    m = mask_u8.copy()
    k3 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k3, iterations=1)
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if cnts:
        cnt = max(cnts, key=cv2.contourArea)
        fill = np.zeros_like(m)
        cv2.drawContours(fill, [cnt], -1, 255, thickness=-1)
        if int(np.count_nonzero(fill)) >= max(24, int(min_keep_frac * area0)):
            m = fill
    if int(np.count_nonzero(m)) < max(24, int(min_keep_frac * area0)):
        return mask_u8
    return m

def _overlay_projected_mouth_circles(img_bgr, centers, mouth_diam_mm=6.90, pitch_mm=9.0, color=(0, 255, 0), thickness=1):
    vis = img_bgr.copy()
    nrow, ncol = centers.shape[:2]
    ratio = float(mouth_diam_mm) / max(1e-9, float(pitch_mm))
    for r in range(nrow):
        for c in range(ncol):
            lp = _local_pitch_px(centers, r, c)
            rr = max(2, int(round(0.5 * ratio * lp)))
            cx = int(round(float(centers[r, c, 0])))
            cy = int(round(float(centers[r, c, 1])))
            cv2.circle(vis, (cx, cy), rr, color, thickness, cv2.LINE_AA)
    return vis

