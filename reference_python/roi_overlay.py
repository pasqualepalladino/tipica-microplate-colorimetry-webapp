# -*- coding: utf-8 -*-

import cv2
import numpy as np


def _row_label_from_index(idx):
    idx = int(idx)
    label = ""
    while True:
        idx, rem = divmod(idx, 26)
        label = chr(ord("A") + rem) + label
        if idx == 0:
            return label
        idx -= 1


def _draw_dashed_polyline(img, pts, color=(0, 0, 0), thickness=1, dash_len=10, gap_len=6):
    """Draw a dashed closed polyline using OpenCV primitives."""
    arr = np.asarray(pts, dtype=np.float32).reshape(-1, 2)
    if arr.shape[0] < 2:
        return
    closed = np.vstack([arr, arr[0]])
    for p0, p1 in zip(closed[:-1], closed[1:]):
        vec = p1 - p0
        seg_len = float(np.linalg.norm(vec))
        if seg_len <= 1e-6:
            continue
        direction = vec / seg_len
        pos = 0.0
        while pos < seg_len:
            start = p0 + direction * pos
            end = p0 + direction * min(seg_len, pos + dash_len)
            cv2.line(
                img,
                (int(round(start[0])), int(round(start[1]))),
                (int(round(end[0])), int(round(end[1]))),
                color,
                int(thickness),
                cv2.LINE_AA,
            )
            pos += float(dash_len + gap_len)


def _put_label_with_outline(img, text, org, font, scale, color, thickness=1):
    x, y = int(org[0]), int(org[1])
    cv2.putText(img, str(text), (x, y), font, scale, (255, 255, 255), thickness + 2, cv2.LINE_AA)
    cv2.putText(img, str(text), (x, y), font, scale, color, thickness, cv2.LINE_AA)


def _build_plate_overlay(img_bgr, well_bottom_masks, well_stats_rows, centers):
    vis = img_bgr.copy()
    stats_map = {(int(r["well_r"]), int(r["well_c"])): r for r in well_stats_rows}
    nrow, ncol = centers.shape[:2]
    for r in range(len(well_bottom_masks)):
        for c in range(len(well_bottom_masks[r])):
            m = well_bottom_masks[r][c]
            if m is None or np.count_nonzero(m) == 0:
                continue
            stat = stats_map.get((r, c), {})
            problematic = int(stat.get("is_image_quality_warning", 0)) == 1 or float(stat.get("used_fraction", 1.0)) < 0.55
            cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            if cnts:
                cnt = max(cnts, key=lambda z: cv2.contourArea(z))
                color = (0, 0, 255) if problematic else (0, 0, 0)
                _draw_dashed_polyline(vis, cnt[:, 0, :], color=color, thickness=2)
            if problematic:
                cx, cy = centers[r, c]
                cv2.circle(vis, (int(round(cx)), int(round(cy))), 3, (0, 0, 255), -1)

    # Add dynamic row/column labels to make the overlay readable for all supported plate formats.
    font = cv2.FONT_HERSHEY_SIMPLEX
    font_scale = 0.45 if max(nrow, ncol) > 24 else 0.55
    for c in range(ncol):
        x = int(round(centers[0, c, 0]))
        y = int(round(max(18, np.min(centers[:, c, 1]) - 18)))
        _put_label_with_outline(vis, str(c + 1), (x - 6, y), font, font_scale, (0, 0, 0), thickness=1)
    for r in range(nrow):
        x = int(round(max(8, np.min(centers[r, :, 0]) - 26)))
        y = int(round(centers[r, 0, 1] + 5))
        _put_label_with_outline(vis, _row_label_from_index(r), (x, y), font, font_scale, (0, 0, 0), thickness=1)
    return vis
