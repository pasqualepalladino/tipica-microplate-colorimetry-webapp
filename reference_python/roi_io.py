# -*- coding: utf-8 -*-

import json
from pathlib import Path
import numpy as np

def _fourcorner_sidecar_path(image_path):
    p = Path(image_path)
    return str(p.with_name(p.stem + '_4corner_wells.json'))

def _load_fourcorner_geometry(image_path, cfg=None):
    cfg = cfg or {}
    # priority: explicit cfg corners, then sidecar json, then None
    keys = ['corner_a1', 'corner_a12', 'corner_h12', 'corner_h1']
    if all(k in cfg and cfg.get(k) is not None for k in keys):
        try:
            return {k: np.asarray(cfg.get(k), dtype=np.float32) for k in keys}
        except Exception:
            pass
    sidecar = cfg.get('fourcorner_geometry_path') or _fourcorner_sidecar_path(image_path)
    p = Path(sidecar)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding='utf-8'))
    except Exception:
        return None
    out = {}
    for k in keys:
        v = data.get(k)
        if not isinstance(v, (list, tuple)) or len(v) != 2:
            return None
        out[k] = np.asarray([float(v[0]), float(v[1])], dtype=np.float32)
    return out

def _bilinear_grid_from_four_corners(corner_a1, corner_a12, corner_h12, corner_h1, nrow, ncol):
    a1 = np.asarray(corner_a1, dtype=np.float32)
    a12 = np.asarray(corner_a12, dtype=np.float32)
    h12 = np.asarray(corner_h12, dtype=np.float32)
    h1 = np.asarray(corner_h1, dtype=np.float32)
    centers = np.zeros((int(nrow), int(ncol), 2), dtype=np.float32)
    for r in range(int(nrow)):
        tr = 0.0 if int(nrow) <= 1 else float(r) / float(int(nrow) - 1)
        left = (1.0 - tr) * a1 + tr * h1
        right = (1.0 - tr) * a12 + tr * h12
        for c in range(int(ncol)):
            tc = 0.0 if int(ncol) <= 1 else float(c) / float(int(ncol) - 1)
            centers[r, c] = (1.0 - tc) * left + tc * right
    return centers

