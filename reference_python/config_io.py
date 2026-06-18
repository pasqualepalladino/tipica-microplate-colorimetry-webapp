# -*- coding: utf-8 -*-
"""
Configuration I/O utilities.

Stores and loads persistent configuration (geometry, UI defaults, etc.)
from a JSON file in the working directory.
"""

import json
import os
import math



def _remove_simplified_deprecated_keys(obj):
    deprecated = {
        "exclude" + "_qc", "weight" + "ing", "use_" + "weight" + "ing", "weight" + "ing_" + "mode",
        "auto_image_" + "correction", "image_" + "correction_" + "enabled",
        "rgb_signal_" + "mode", "rgb_bg_" + "mode",
        "eps" + "ilon", "path" + "_length", "liquid" + "_volume_ul", "path" + "_length_mm", "path" + "_length_cm",
        "well_bottom_diam_mm_for_path" + "length", "well_bottom_area_mm2_for_path" + "length",
        "path" + "_length_source", "path" + "_length_warning",
    }
    if isinstance(obj, dict):
        return {
            k: _remove_simplified_deprecated_keys(v)
            for k, v in obj.items()
            if k not in deprecated
        }
    if isinstance(obj, list):
        return [_remove_simplified_deprecated_keys(v) for v in obj]
    return obj

CONFIG_FILE = "geometry_config.json"


def _to_float_or_nan(value):
    try:
        v = float(value)
        return v if math.isfinite(v) else float("nan")
    except Exception:
        return float("nan")


def _normalize_expected_refs(data):
    if not isinstance(data, dict):
        return data

    out = {}
    for key, value in dict(data).items():
        if isinstance(value, dict):
            out[key] = _normalize_expected_refs(value)
        elif isinstance(value, list):
            out[key] = [
                _normalize_expected_refs(item) if isinstance(item, dict) else item
                for item in value
            ]
        else:
            out[key] = value

    refs = out.get("expected_refs", None)
    norm_refs = []
    seen = set()

    if isinstance(refs, list):
        for item in refs:
            if not isinstance(item, dict):
                continue
            ref_id = str(item.get("id", item.get("ref_id", ""))).strip()
            label = str(item.get("label", "")).strip()
            value = _to_float_or_nan(item.get("value", float("nan")))
            sd = _to_float_or_nan(item.get("sd", float("nan")))
            if not math.isfinite(value):
                continue
            key = (ref_id, label, value, sd if math.isfinite(sd) else None)
            if key in seen:
                continue
            seen.add(key)
            norm_refs.append({
                "id": ref_id,
                "label": label,
                "value": value,
                "sd": sd if math.isfinite(sd) else float("nan"),
            })

    legacy_candidates = [
        ("ICP-MS", out.get("expected_icpms_value", out.get("expected_icpms", float("nan"))), out.get("expected_icpms_sd", float("nan"))),
        ("Colorimetry", out.get("expected_colorimetry_value", out.get("expected_colorimetry", float("nan"))), out.get("expected_colorimetry_sd", float("nan"))),
        (str(out.get("expected_label", "")).strip(), out.get("expected_value", float("nan")), out.get("expected_sd", float("nan"))),
    ]
    for label, value_raw, sd_raw in legacy_candidates:
        value = _to_float_or_nan(value_raw)
        sd = _to_float_or_nan(sd_raw)
        if not math.isfinite(value):
            continue
        key = ("", label, value, sd if math.isfinite(sd) else None)
        if key in seen:
            continue
        seen.add(key)
        norm_refs.append({
            "id": "",
            "label": label,
            "value": value,
            "sd": sd if math.isfinite(sd) else float("nan"),
        })

    out["expected_refs"] = norm_refs

    if "save_raw_data_details" not in out and "save_diagnostics" in out:
        out["save_raw_data_details"] = bool(out.get("save_diagnostics", False))
    if "save_diagnostics" not in out and "save_raw_data_details" in out:
        out["save_diagnostics"] = bool(out.get("save_raw_data_details", False))

    return out


CONFIG_FILE = "geometry_config.json"


def load_all_config(config_path: str = CONFIG_FILE):
    """Load JSON config dictionary. Returns None if missing/corrupted."""
    if os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                return _remove_simplified_deprecated_keys(_normalize_expected_refs(json.load(f)))
        except Exception:
            return None
    return None


def save_all_config(data: dict, config_path: str = CONFIG_FILE) -> None:
    """
    Merge and save config dictionary.
    Existing keys are updated, others preserved.
    """
    try:
        current = load_all_config(config_path) or {}
        current.update(data)
        current = _remove_simplified_deprecated_keys(_normalize_expected_refs(current))
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(current, f, indent=4)
    except Exception:
        # Fail silently to avoid crashing interactive sessions
        pass