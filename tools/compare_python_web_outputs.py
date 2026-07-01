#!/usr/bin/env python3
"""Compare Python and web TIPICA output ZIPs without third-party dependencies."""

from __future__ import annotations

import argparse
import difflib
import json
import math
import re
import statistics
import sys
import zipfile
import zlib
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Iterable
from xml.etree import ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DIR = ROOT / "test_data" / "manual_comparison"
DEFAULT_PYTHON_ZIP = DEFAULT_DIR / "python_RUN_20260529_122854.zip"
DEFAULT_WEB_ZIP = DEFAULT_DIR / "web_after_36U.zip"
DEFAULT_REPORT = DEFAULT_DIR / "comparison_report_after_36V.md"
DEFAULT_VISUAL_DIR = DEFAULT_DIR / "visual_audit_after_36W"
DEFAULT_SHARED_GEOMETRY_DIR = DEFAULT_DIR / "shared_geometry_after_36W"
NS = {
    "a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}


KEY_SHEETS = {
    "REPORT": [
        "01_CONTENTS",
        "02_METADATA",
        "03_OVERVIEW",
        "04_RAW",
        "05_REPLICATES_MEAN",
        "06_FITTING",
        "07_METHOD_COMPARISON",
        "08_LEGENDS",
    ],
    "DIAGNOSTICS": [
        "01_CONTENTS",
        "02_BG_SAMPLES",
        "03_BG_WELL_FIT",
        "04_WELL_ROBUST_STATS",
        "05_GEOMETRY_QC",
        "06_WELL_BOTTOM",
        "07_PLATE_GEOMETRY",
        "08_EMPTY_WELLS",
        "09_SPATIAL_DIAGNOSTICS",
        "10_METHOD_COMPARISON",
        "11_CIELAB_FITTING",
        "12_LEGENDS",
    ],
}

NUMERIC_CHECKS = {
    ("REPORT", "04_RAW"): ["PAbs_Red", "PAbs_Green", "PAbs_Blue", "L", "a", "b", "DeltaE_ab", "DeltaE_ab_chroma"],
    ("REPORT", "06_FITTING"): ["n_points", "m", "q", "R2", "C0", "C0_sd", "LOD", "LOQ"],
    ("REPORT", "07_METHOD_COMPARISON"): ["Score", "BaseScore", "R2_cal", "R2_std_mean", "C0_median", "Estimate_value"],
    ("DIAGNOSTICS", "02_BG_SAMPLES"): ["x", "y", "area", "Red_median_raw", "Green_median_raw", "Blue_median_raw"],
    ("DIAGNOSTICS", "05_GEOMETRY_QC"): ["mouth_r", "floor_r", "shift_px", "floor_to_mouth_r_ratio"],
    ("DIAGNOSTICS", "06_WELL_BOTTOM"): ["local_pitch_px", "cyl_r_bg", "mouth_r_geom", "floor_r_geom", "mouth_r", "floor_r"],
    ("DIAGNOSTICS", "10_METHOD_COMPARISON"): ["Score", "BaseScore", "R2_cal", "R2_std_mean", "C0_median", "Estimate_value"],
    ("DIAGNOSTICS", "11_CIELAB_FITTING"): ["n_points", "m", "q", "R2", "C0", "C0_sd", "LOD", "LOQ"],
}

WEB_VALIDATION_EXTENSION_COLUMNS = {
    ("DIAGNOSTICS", "02_BG_SAMPLES"): [
        "Web_Sampled_Final_Accepted_Pixels",
        "Web_FullRes_After_Well_Exclusion",
        "Web_FullRes_Final_Accepted_Pixels",
        "Web_Projected_Cell_Area_Px",
        "Web_Raw_Canonical_Mask_Samples",
        "Web_Sampled_After_Well_Exclusion",
        "Web_Sampled_After_Luminance_Chroma_Filtering",
        "Web_Zero_Reason",
        "Web_Geometry_Source",
    ],
}

CHANNEL_LABELS = ["Red", "Green", "Blue"]
PABS_FORMULA_TOLERANCE = 1e-9
SCORE_TOLERANCE = 1e-9
METHOD_ALIASES = {
    "DeltaE": "DeltaE_ab",
    "DeltaE_ab": "DeltaE_ab",
    "DeltaE_chroma": "DeltaE_ab_chroma",
    "DeltaE_ab_chroma": "DeltaE_ab_chroma",
}
SCORE_COMPARE_FIELDS = [
    "Method",
    "Family",
    "ComparableGroup",
    "Rank",
    "Selected",
    "Score",
    "BaseScore",
    "ScoreFormula",
    "RankMode",
    "R2_cal",
    "R2_std_mean",
    "m_cal",
    "m_std_mean",
    "SlopeAgreement",
    "beta_mean",
    "bias_index_mean",
    "SNR",
    "LOD",
    "LOQ",
    "n_stdadd",
    "n_unknown",
    "C0_mean",
    "C0_median",
    "C0_sd_median",
    "Estimate_value",
    "Estimate_sd",
    "Estimate_source",
]

AUDIT_36W_O_RAW_COLUMNS = [
    "PAbs_Red_raw",
    "PAbs_Red_exported",
    "PAbs_Red_correction_delta",
    "S0_Red_applied",
    "ClipDelta_Red_applied",
    "TotalDelta_Red_applied",
    "PAbs_Green_raw",
    "PAbs_Green_exported",
    "PAbs_Green_correction_delta",
    "S0_Green_applied",
    "ClipDelta_Green_applied",
    "TotalDelta_Green_applied",
    "PAbs_Blue_raw",
    "PAbs_Blue_exported",
    "PAbs_Blue_correction_delta",
    "S0_Blue_applied",
    "ClipDelta_Blue_applied",
    "TotalDelta_Blue_applied",
]

AUDIT_36W_O_REPLICATE_COLUMNS = [
    "PAbs_Red_raw_median",
    "PAbs_Red_raw_sd",
    "PAbs_Red_fit_input_median",
    "PAbs_Red_fit_input_sd",
    "PAbs_Red_fit_input_delta",
    "S0_Red_fit_input",
    "ClipDelta_Red_fit_input",
    "TotalDelta_Red_fit_input",
    "PAbs_Green_raw_median",
    "PAbs_Green_raw_sd",
    "PAbs_Green_fit_input_median",
    "PAbs_Green_fit_input_sd",
    "PAbs_Green_fit_input_delta",
    "S0_Green_fit_input",
    "ClipDelta_Green_fit_input",
    "TotalDelta_Green_fit_input",
    "PAbs_Blue_raw_median",
    "PAbs_Blue_raw_sd",
    "PAbs_Blue_fit_input_median",
    "PAbs_Blue_fit_input_sd",
    "PAbs_Blue_fit_input_delta",
    "S0_Blue_fit_input",
    "ClipDelta_Blue_fit_input",
    "TotalDelta_Blue_fit_input",
]

AUDIT_36W_O_FIT_COLUMNS = [
    "FitSignalSource",
    "FitX_points",
    "FitY_raw_points",
    "FitY_input_points",
    "FitY_input_delta_points",
    "ClipDelta_points",
    "ClipY_observed_points",
    "ClipY_shifted_points",
    "ClipY_expected_points",
    "ClipY_corrected_points",
    "ClipSDThreshold_points",
]

AUDIT_36W_O_COLUMNS = {
    "04_RAW": AUDIT_36W_O_RAW_COLUMNS,
    "05_REPLICATES_MEAN": AUDIT_36W_O_REPLICATE_COLUMNS,
    "06_FITTING": AUDIT_36W_O_FIT_COLUMNS,
}

AUDIT_MATERIAL_THRESHOLD = 1e-6
AUDIT_DOMINANCE_RATIO = 3.0

PY_BG_BASIS_FALLBACK = ["constant", "x", "y", "x*y", "x^2", "y^2"]
WEB_BG_BASIS_FALLBACK = ["constant", "x", "y", "x^2", "x*y", "y^2"]
BG_COEF_TERM_ORDER = ["constant", "x", "y", "x^2", "x*y", "y^2"]
BG_COEF_TERM_LABELS = {
    "constant": "constant",
    "x": "x",
    "y": "y",
    "x^2": "x^2",
    "x*y": "x*y",
    "y^2": "y^2",
}


@dataclass
class Workbook:
    name: str
    sheets: dict[str, list[list[str]]]
    order: list[str]


@dataclass
class PngImage:
    width: int
    height: int
    mode: str
    bit_depth: int
    color_type: int
    rgba: bytes | None
    error: str = ""


@dataclass
class PngAuditResult:
    path: str
    status: str
    python_dimensions: tuple[int, int] | None
    web_dimensions: tuple[int, int] | None
    python_mode: str
    web_mode: str
    exact_pixels: bool | None
    mean_abs_diff: float | None
    max_abs_diff: int | None
    percent_nonidentical_pixels: float | None
    side_by_side: str


@dataclass
class PAbsFormulaSummary:
    label: str
    status: str
    source: str
    meanw_field: str
    meanbg_field: str
    finite_inputs: int
    mean_abs_residual: float
    max_abs_residual: float
    signed_mean_residual: float
    residual_sd: float
    residual_pattern: str
    role_counts: dict[str, int]
    warn_role_counts: dict[str, int]
    worst_rows: list[dict[str, str]]


def canonical_zip_name(name: str) -> str:
    parts = [part for part in name.replace("\\", "/").split("/") if part]
    if len(parts) < 2:
        return name
    if len(parts) >= 3 and parts[0] not in {"RESULTS", "RAW_DATA_DETAILS"} and parts[1] in {"RESULTS", "RAW_DATA_DETAILS"}:
        parts = parts[1:]
    folder = parts[0]
    filename = parts[-1]
    suffix_match = re.search(r"_(BEST_CHANNEL|FIGURE_RGB|PLATE_ROI_OVERLAY|REPORT|RESULTS_CAPTION|BG_STAT_MASK|DIAGNOSTICS|FIGURE_CIELAB_DELTAE|METHOD_COMPARISON|RAW_DATA_DETAILS_CAPTION)\.(png|xlsx|txt)$", filename)
    if suffix_match:
        return f"{folder}/{filename}"
    return "/".join(parts)


def read_png_size(data: bytes) -> tuple[int, int] | None:
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        return None
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def png_chunks(data: bytes) -> Iterable[tuple[str, bytes]]:
    if len(data) < 8 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return
    offset = 8
    while offset + 12 <= len(data):
        length = int.from_bytes(data[offset:offset + 4], "big")
        chunk_type = data[offset + 4:offset + 8].decode("ascii", errors="replace")
        chunk_data = data[offset + 8:offset + 8 + length]
        yield chunk_type, chunk_data
        offset += 12 + length
        if chunk_type == "IEND":
            break


def paeth_predictor(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa = abs(p - a)
    pb = abs(p - b)
    pc = abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def unfilter_png_scanlines(raw: bytes, width: int, height: int, stride: int, bpp: int) -> bytes:
    rows = bytearray()
    offset = 0
    previous = bytearray(stride)
    for _ in range(height):
        if offset >= len(raw):
            raise ValueError("truncated PNG scanline data")
        filter_type = raw[offset]
        offset += 1
        row = bytearray(raw[offset:offset + stride])
        offset += stride
        if len(row) != stride:
            raise ValueError("truncated PNG row")
        for index in range(stride):
            left = row[index - bpp] if index >= bpp else 0
            up = previous[index]
            up_left = previous[index - bpp] if index >= bpp else 0
            if filter_type == 1:
                row[index] = (row[index] + left) & 0xFF
            elif filter_type == 2:
                row[index] = (row[index] + up) & 0xFF
            elif filter_type == 3:
                row[index] = (row[index] + ((left + up) // 2)) & 0xFF
            elif filter_type == 4:
                row[index] = (row[index] + paeth_predictor(left, up, up_left)) & 0xFF
            elif filter_type != 0:
                raise ValueError(f"unsupported PNG filter {filter_type}")
        rows.extend(row)
        previous = row
    return bytes(rows)


def decode_png_image(data: bytes) -> PngImage:
    size = read_png_size(data)
    if size is None:
        return PngImage(0, 0, "invalid", 0, -1, None, "not a PNG")
    width, height = size
    bit_depth = data[24]
    color_type = data[25]
    compression = data[26]
    filter_method = data[27]
    interlace = data[28]
    mode_by_type = {0: "L", 2: "RGB", 3: "P", 4: "LA", 6: "RGBA"}
    mode = mode_by_type.get(color_type, f"type-{color_type}")
    idat = bytearray()
    palette: list[tuple[int, int, int]] = []
    transparency = b""
    for chunk_type, chunk_data in png_chunks(data):
        if chunk_type == "IDAT":
            idat.extend(chunk_data)
        elif chunk_type == "PLTE":
            palette = [
                (chunk_data[index], chunk_data[index + 1], chunk_data[index + 2])
                for index in range(0, len(chunk_data) - 2, 3)
            ]
        elif chunk_type == "tRNS":
            transparency = chunk_data
    if bit_depth != 8:
        return PngImage(width, height, mode, bit_depth, color_type, None, f"unsupported bit depth {bit_depth}")
    if compression != 0 or filter_method != 0 or interlace != 0:
        return PngImage(width, height, mode, bit_depth, color_type, None, "unsupported PNG compression/filter/interlace")
    channels_by_type = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}
    channels = channels_by_type.get(color_type)
    if channels is None:
        return PngImage(width, height, mode, bit_depth, color_type, None, f"unsupported color type {color_type}")
    try:
        decompressed = zlib.decompress(bytes(idat))
        pixels = unfilter_png_scanlines(decompressed, width, height, width * channels, channels)
    except Exception as exc:
        return PngImage(width, height, mode, bit_depth, color_type, None, str(exc))

    rgba = bytearray(width * height * 4)
    if color_type == 0:
        for index, value in enumerate(pixels):
            out = index * 4
            rgba[out:out + 4] = bytes((value, value, value, 255))
    elif color_type == 2:
        for index in range(width * height):
            src = index * 3
            out = index * 4
            rgba[out:out + 4] = bytes((pixels[src], pixels[src + 1], pixels[src + 2], 255))
    elif color_type == 3:
        for index, palette_index in enumerate(pixels):
            rgb = palette[palette_index] if palette_index < len(palette) else (0, 0, 0)
            alpha = transparency[palette_index] if palette_index < len(transparency) else 255
            out = index * 4
            rgba[out:out + 4] = bytes((*rgb, alpha))
    elif color_type == 4:
        for index in range(width * height):
            src = index * 2
            out = index * 4
            value = pixels[src]
            rgba[out:out + 4] = bytes((value, value, value, pixels[src + 1]))
    elif color_type == 6:
        rgba[:] = pixels
    return PngImage(width, height, mode, bit_depth, color_type, bytes(rgba))


def png_chunk(chunk_type: bytes, payload: bytes) -> bytes:
    crc = zlib.crc32(chunk_type)
    crc = zlib.crc32(payload, crc) & 0xFFFFFFFF
    return len(payload).to_bytes(4, "big") + chunk_type + payload + crc.to_bytes(4, "big")


def encode_png_rgba(width: int, height: int, rgba: bytes) -> bytes:
    ihdr = (
        width.to_bytes(4, "big")
        + height.to_bytes(4, "big")
        + bytes((8, 6, 0, 0, 0))
    )
    stride = width * 4
    raw = bytearray()
    for row in range(height):
        raw.append(0)
        start = row * stride
        raw.extend(rgba[start:start + stride])
    return b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", ihdr) + png_chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + png_chunk(b"IEND", b"")


def paste_rgba(canvas: bytearray, canvas_width: int, image: PngImage, x_offset: int) -> None:
    if image.rgba is None:
        return
    for row in range(image.height):
        dst = (row * canvas_width + x_offset) * 4
        src = row * image.width * 4
        canvas[dst:dst + image.width * 4] = image.rgba[src:src + image.width * 4]


def make_side_by_side_png(py_image: PngImage, web_image: PngImage) -> bytes | None:
    if py_image.rgba is None or web_image.rgba is None:
        return None
    gutter = 16
    width = py_image.width + gutter + web_image.width
    height = max(py_image.height, web_image.height)
    canvas = bytearray([255] * width * height * 4)
    paste_rgba(canvas, width, py_image, 0)
    paste_rgba(canvas, width, web_image, py_image.width + gutter)
    return encode_png_rgba(width, height, bytes(canvas))


def png_pixel_stats(py_image: PngImage, web_image: PngImage) -> tuple[bool | None, float | None, int | None, float | None]:
    if py_image.rgba is None or web_image.rgba is None:
        return None, None, None, None
    exact = py_image.width == web_image.width and py_image.height == web_image.height and py_image.rgba == web_image.rgba
    common_width = min(py_image.width, web_image.width)
    common_height = min(py_image.height, web_image.height)
    if common_width == 0 or common_height == 0:
        return exact, None, None, None
    diff_sum = 0
    diff_count = 0
    max_diff = 0
    nonidentical = 0
    for y in range(common_height):
        py_row = y * py_image.width * 4
        web_row = y * web_image.width * 4
        for x in range(common_width):
            py_offset = py_row + x * 4
            web_offset = web_row + x * 4
            pixel_different = False
            for channel in range(4):
                delta = abs(py_image.rgba[py_offset + channel] - web_image.rgba[web_offset + channel])
                diff_sum += delta
                diff_count += 1
                max_diff = max(max_diff, delta)
                pixel_different = pixel_different or delta != 0
            nonidentical += int(pixel_different)
    mean_abs = diff_sum / diff_count if diff_count else None
    percent_nonidentical = 100.0 * nonidentical / (common_width * common_height)
    return exact, mean_abs, max_diff, percent_nonidentical


def col_index(cell_ref: str) -> int:
    letters = "".join(ch for ch in cell_ref if ch.isalpha())
    value = 0
    for ch in letters:
        value = value * 26 + (ord(ch.upper()) - 64)
    return value - 1


def shared_strings(zf: zipfile.ZipFile, prefix: str) -> list[str]:
    path = f"{prefix}xl/sharedStrings.xml"
    if path not in zf.namelist():
        return []
    root = ET.fromstring(zf.read(path))
    strings: list[str] = []
    for si in root.findall("a:si", NS):
        texts = [node.text or "" for node in si.findall(".//a:t", NS)]
        strings.append("".join(texts))
    return strings


def rel_targets(zf: zipfile.ZipFile, prefix: str) -> dict[str, str]:
    path = f"{prefix}xl/_rels/workbook.xml.rels"
    root = ET.fromstring(zf.read(path))
    rels: dict[str, str] = {}
    for rel in root.findall("rel:Relationship", NS):
        rid = rel.attrib.get("Id", "")
        target = rel.attrib.get("Target", "")
        if not target.startswith("/"):
            target = f"xl/{target}"
        else:
            target = target.lstrip("/")
        rels[rid] = f"{prefix}{target}"
    return rels


def worksheet_rows(zf: zipfile.ZipFile, path: str, strings: list[str]) -> list[list[str]]:
    root = ET.fromstring(zf.read(path))
    rows: list[list[str]] = []
    for row in root.findall(".//a:sheetData/a:row", NS):
        values: list[str] = []
        for cell in row.findall("a:c", NS):
            index = col_index(cell.attrib.get("r", "A1"))
            while len(values) <= index:
                values.append("")
            cell_type = cell.attrib.get("t", "")
            if cell_type == "inlineStr":
                values[index] = "".join(node.text or "" for node in cell.findall(".//a:t", NS))
            else:
                value = cell.find("a:v", NS)
                raw = value.text if value is not None and value.text is not None else ""
                if cell_type == "s" and raw:
                    values[index] = strings[int(raw)] if int(raw) < len(strings) else raw
                else:
                    values[index] = raw
        while values and values[-1] == "":
            values.pop()
        rows.append(values)
    return rows


def read_workbook(zf: zipfile.ZipFile, name: str) -> Workbook:
    with zipfile.ZipFile(BytesIO(zf.read(name))) as xlsx:
        root = ET.fromstring(xlsx.read("xl/workbook.xml"))
        strings = shared_strings(xlsx, "")
        rels = rel_targets(xlsx, "")
        order: list[str] = []
        sheets: dict[str, list[list[str]]] = {}
        for sheet in root.findall(".//a:sheets/a:sheet", NS):
            sheet_name = sheet.attrib["name"]
            rid = sheet.attrib[f"{{{NS['r']}}}id"]
            order.append(sheet_name)
            sheets[sheet_name] = worksheet_rows(xlsx, rels[rid], strings)
        return Workbook(name=name, sheets=sheets, order=order)


def find_by_suffix(names: Iterable[str], suffix: str) -> str | None:
    matches = [name for name in names if canonical_zip_name(name).endswith(suffix)]
    return matches[0] if matches else None


def workbook_kind(name: str) -> str | None:
    canon = canonical_zip_name(name)
    if canon.endswith("_REPORT.xlsx"):
        return "REPORT"
    if canon.endswith("_DIAGNOSTICS.xlsx"):
        return "DIAGNOSTICS"
    return None


def as_float(value: str) -> float:
    if value in {"", "NA", "nan", "NaN", "None"}:
        return math.nan
    try:
        return float(value)
    except ValueError:
        return math.nan


def parse_well_position(well: str) -> tuple[int, int] | None:
    match = re.fullmatch(r"\s*([A-Ha-h])(\d{1,2})\s*", str(well))
    if not match:
        return None
    row = ord(match.group(1).upper()) - ord("A")
    col = int(match.group(2)) - 1
    if 0 <= row <= 7 and 0 <= col <= 11:
        return row, col
    return None


def bg_cell_keys_for_well(row: int, col: int) -> list[str]:
    keys: list[str] = []
    for dr in (-1, 0):
        for dc in (-1, 0):
            rr = row + dr
            cc = col + dc
            if 0 <= rr <= 6 and 0 <= cc <= 10:
                keys.append(f"{rr}|{cc}")
    return keys


def mean_finite(values: list[float]) -> float:
    finite = [value for value in values if math.isfinite(value)]
    if not finite:
        return math.nan
    return statistics.fmean(finite)


def pearson_correlation(xs: list[float], ys: list[float]) -> float:
    pairs = [(x, y) for x, y in zip(xs, ys) if math.isfinite(x) and math.isfinite(y)]
    if len(pairs) < 3:
        return math.nan
    x_vals = [pair[0] for pair in pairs]
    y_vals = [pair[1] for pair in pairs]
    x_mean = statistics.fmean(x_vals)
    y_mean = statistics.fmean(y_vals)
    num = sum((x - x_mean) * (y - y_mean) for x, y in pairs)
    den_x = math.sqrt(sum((x - x_mean) ** 2 for x in x_vals))
    den_y = math.sqrt(sum((y - y_mean) ** 2 for y in y_vals))
    if den_x <= 0 or den_y <= 0:
        return math.nan
    return num / (den_x * den_y)


def parse_number_list(value: str) -> list[float]:
    text = str(value).strip()
    if not text:
        return []
    out: list[float] = []
    for item in text.split(","):
        parsed = as_float(item.strip())
        if math.isfinite(parsed):
            out.append(parsed)
    return out


def normalize_bg_basis_term(term: str) -> str | None:
    token = str(term).strip().lower().replace(" ", "")
    if not token:
        return None
    if token in {"1", "const", "constant", "c0", "bias", "intercept"}:
        return "constant"
    if token in {"x", "xn", "xnorm"}:
        return "x"
    if token in {"y", "yn", "ynorm"}:
        return "y"
    if token in {"x2", "x^2", "xx", "x*x", "xn2", "xn^2"}:
        return "x^2"
    if token in {"y2", "y^2", "yy", "y*y", "yn2", "yn^2"}:
        return "y^2"
    if token in {"xy", "x*y", "y*x", "xyn", "ynx", "xn*yn", "yn*xn"}:
        return "x*y"
    return None


def parse_bg_basis_order(value: str, fallback_terms: list[str]) -> list[str]:
    text = str(value).strip()
    if not text:
        return list(fallback_terms)
    stripped = text.strip("[]")
    parts = [part.strip() for part in stripped.split(",") if part.strip()]
    if not parts:
        return list(fallback_terms)
    parsed: list[str] = []
    for part in parts:
        norm = normalize_bg_basis_term(part)
        if norm is None:
            return list(fallback_terms)
        parsed.append(norm)
    if len(parsed) < 6:
        return list(fallback_terms)
    return parsed[:6]


def pretty_bg_basis_order(terms: list[str]) -> str:
    shown = ["1" if term == "constant" else term for term in terms]
    return "[" + ", ".join(shown) + "]"


def basis_order_summary(rows: list[dict[str, str]], fallback_terms: list[str]) -> str:
    orders = {
        pretty_bg_basis_order(parse_bg_basis_order(str(row.get("Basis_Order", "")), fallback_terms))
        for row in rows
    }
    if not orders:
        return pretty_bg_basis_order(fallback_terms) + " (fallback)"
    if len(orders) == 1:
        return next(iter(orders))
    return " | ".join(sorted(orders))


def coefficient_rows_by_semantic_term(rows: list[dict[str, str]], fallback_terms: list[str]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for row in rows:
        mapped = dict(row)
        terms = parse_bg_basis_order(str(row.get("Basis_Order", "")), fallback_terms)
        for idx, term in enumerate(terms):
            coef_key = f"coef_{idx}"
            if coef_key in row:
                mapped[f"coef_term_{term}"] = row.get(coef_key, "")
        out.append(mapped)
    return out


def recompute_pabs(row: dict[str, str], label: str) -> float:
    meanw = as_float(row.get(f"MeanW_{label}", ""))
    meanbg = as_float(row.get(f"MeanBG_{label}", ""))
    if not (math.isfinite(meanw) and math.isfinite(meanbg) and meanw > 0 and meanbg > 0):
        return math.nan
    return math.log10(meanbg / meanw)


def finite_deltas(values: Iterable[float]) -> list[float]:
    return [value for value in values if math.isfinite(value)]


def delta_summary(values: Iterable[float]) -> dict[str, float | int]:
    deltas = finite_deltas(values)
    if not deltas:
        return {
            "paired": 0,
            "mean_abs": math.nan,
            "median_abs": math.nan,
            "max_abs": math.nan,
            "signed_mean": math.nan,
        }
    abs_values = [abs(value) for value in deltas]
    return {
        "paired": len(deltas),
        "mean_abs": statistics.fmean(abs_values),
        "median_abs": statistics.median(abs_values),
        "max_abs": max(abs_values),
        "signed_mean": statistics.fmean(deltas),
    }


def fmt_number(value: float | int | None) -> str:
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float) and math.isfinite(value):
        return f"{value:.8g}"
    return "NA"


def max_or_nan(current: float, candidate: float) -> float:
    if math.isfinite(current) and math.isfinite(candidate):
        return max(current, candidate)
    if math.isfinite(candidate):
        return candidate
    return current


def markdown_cell_text(value: str) -> str:
    return str(value).replace("|", " / ")


def sheet_headers(workbook: Workbook, sheet: str) -> list[str]:
    rows = workbook.sheets.get(sheet, [])
    return rows[0] if rows else []


def available_columns(headers: list[str], expected: list[str]) -> dict[str, list[str]]:
    present = [column for column in expected if column in headers]
    missing = [column for column in expected if column not in headers]
    return {"present": present, "missing": missing}


def first_present_column(headers: list[str], candidates: list[str]) -> str | None:
    for candidate in candidates:
        if candidate in headers:
            return candidate
    return None


def numeric_stats(py_rows: list[list[str]], web_rows: list[list[str]], headers: list[str]) -> list[str]:
    if not py_rows or not web_rows:
        return ["missing rows"]
    py_header = py_rows[0]
    web_header = web_rows[0]
    lines: list[str] = []
    row_count = min(len(py_rows), len(web_rows)) - 1
    for header in headers:
        if header not in py_header or header not in web_header:
            lines.append(f"{header}: missing header")
            continue
        py_i = py_header.index(header)
        web_i = web_header.index(header)
        diffs: list[float] = []
        py_finite = 0
        web_finite = 0
        for row_index in range(1, row_count + 1):
            py_val = as_float(py_rows[row_index][py_i] if py_i < len(py_rows[row_index]) else "")
            web_val = as_float(web_rows[row_index][web_i] if web_i < len(web_rows[row_index]) else "")
            py_finite += int(math.isfinite(py_val))
            web_finite += int(math.isfinite(web_val))
            if math.isfinite(py_val) and math.isfinite(web_val):
                diffs.append(abs(py_val - web_val))
        if diffs:
            lines.append(f"{header}: n={len(diffs)}, mean_abs={statistics.fmean(diffs):.8g}, max_abs={max(diffs):.8g}, py_finite={py_finite}, web_finite={web_finite}")
        else:
            lines.append(f"{header}: no paired finite values, py_finite={py_finite}, web_finite={web_finite}")
    return lines


def artifact_category(canon: str) -> str:
    suffix = Path(canon).suffix.lower()
    if suffix == ".xlsx":
        return "workbook"
    if suffix == ".png":
        return "PNG"
    if suffix == ".txt":
        return "TXT"
    return "other"


def append_full_artifact_inventory(
    report: list[str],
    py_zf: zipfile.ZipFile,
    web_zf: zipfile.ZipFile,
    py_canon: dict[str, str],
    web_canon: dict[str, str],
) -> dict[str, dict[str, str]]:
    summary: dict[str, dict[str, str]] = {}
    report.extend([
        "## Full Artifact Inventory",
        "| Relative path | Category | Python | Web | Python bytes | Web bytes | Size ratio | Status |",
        "|---|---|---:|---:|---:|---:|---:|---|",
    ])
    for canon in sorted(set(py_canon) | set(web_canon)):
        py_present = canon in py_canon
        web_present = canon in web_canon
        py_size = py_zf.getinfo(py_canon[canon]).file_size if py_present else None
        web_size = web_zf.getinfo(web_canon[canon]).file_size if web_present else None
        if py_size and web_size is not None:
            ratio = f"{web_size / py_size:.6g}"
        elif py_size == 0 and web_size == 0:
            ratio = "1"
        else:
            ratio = ""
        status = "PRESENT_BOTH" if py_present and web_present else ("MISSING_IN_WEB" if py_present else "EXTRA_IN_WEB")
        category = artifact_category(canon)
        summary[canon] = {
            "category": category,
            "file": status,
            "structure": "",
            "numeric": "",
            "text": "",
            "visual": "",
            "blocker": "",
            "next": "",
        }
        report.append(
            f"| `{canon}` | {category} | {'yes' if py_present else 'no'} | {'yes' if web_present else 'no'} | "
            f"{py_size if py_size is not None else ''} | {web_size if web_size is not None else ''} | {ratio} | {status} |"
        )
    report.append("")
    return summary


def sheet_shape(rows: list[list[str]]) -> tuple[int, int]:
    return len(rows), max((len(row) for row in rows), default=0)


def compare_text(py_text: str, web_text: str) -> list[str]:
    py_lines = py_text.splitlines()
    web_lines = web_text.splitlines()
    lines = [f"python_lines={len(py_lines)}, web_lines={len(web_lines)}"]
    first_diff = None
    for index in range(min(len(py_lines), len(web_lines))):
        if py_lines[index] != web_lines[index]:
            first_diff = index + 1
            lines.append(f"first_diff_line={first_diff}")
            lines.append(f"python: {py_lines[index][:160]}")
            lines.append(f"web:    {web_lines[index][:160]}")
            break
    if first_diff is None and len(py_lines) != len(web_lines):
        lines.append(f"first_diff_line={min(len(py_lines), len(web_lines)) + 1}")
    return lines


def classify_text_difference(py_text: str, web_text: str, present_both: bool) -> str:
    if not present_both:
        return "MISSING"
    if py_text == web_text:
        return "MATCH"
    combined = f"{py_text}\n{web_text}".lower()
    if any(token in combined for token in ["beta", "webapp", "not yet", "not python", "python-identical", "parity"]):
        return "INTENTIONAL_BETA_DIFFERENCE"
    if any(token in combined for token in ["formula", "semantics", "calibration", "diagnostic", "mask", "overlay"]):
        return "SCIENTIFIC_SEMANTIC_DIFFERENCE"
    normalized_py = re.sub(r"\W+", "", py_text.lower())
    normalized_web = re.sub(r"\W+", "", web_text.lower())
    if normalized_py == normalized_web:
        return "WORDING_ONLY_DIFFERENCE"
    return "UNKNOWN"


def text_diff_excerpt(py_text: str, web_text: str, max_lines: int = 80) -> list[str]:
    diff = list(difflib.unified_diff(
        py_text.splitlines(),
        web_text.splitlines(),
        fromfile="python",
        tofile="web",
        lineterm="",
        n=3,
    ))
    return diff[:max_lines]


def append_txt_caption_audit(
    report: list[str],
    py_zf: zipfile.ZipFile,
    web_zf: zipfile.ZipFile,
    py_canon: dict[str, str],
    web_canon: dict[str, str],
    artifact_summary: dict[str, dict[str, str]],
) -> dict[str, str]:
    text_status: dict[str, str] = {}
    report.extend(["", "## TXT Caption/Text Audit"])
    for canon in sorted(name for name in set(py_canon) | set(web_canon) if name.lower().endswith(".txt")):
        py_present = canon in py_canon
        web_present = canon in web_canon
        py_text = py_zf.read(py_canon[canon]).decode("utf-8", errors="replace") if py_present else ""
        web_text = web_zf.read(web_canon[canon]).decode("utf-8", errors="replace") if web_present else ""
        py_lines = py_text.splitlines()
        web_lines = web_text.splitlines()
        max_len = max(len(py_lines), len(web_lines))
        differing_lines = sum(
            1 for index in range(max_len)
            if (py_lines[index] if index < len(py_lines) else "") != (web_lines[index] if index < len(web_lines) else "")
        )
        first_diff = next((
            index + 1 for index in range(max_len)
            if (py_lines[index] if index < len(py_lines) else "") != (web_lines[index] if index < len(web_lines) else "")
        ), None)
        classification = classify_text_difference(py_text, web_text, py_present and web_present)
        text_status[canon] = classification
        if canon in artifact_summary:
            artifact_summary[canon]["text"] = classification
            artifact_summary[canon]["blocker"] = "" if classification == "MATCH" else "caption/text content differs"
            artifact_summary[canon]["next"] = "decide whether caption semantics are intentional" if classification != "MATCH" else ""
        report.append(f"### {canon}")
        report.append(f"- presence: python={py_present}, web={web_present}")
        report.append(f"- char_count: python={len(py_text)}, web={len(web_text)}")
        report.append(f"- line_count: python={len(py_lines)}, web={len(web_lines)}")
        report.append(f"- first_differing_line={first_diff}")
        report.append(f"- differing_line_count={differing_lines}")
        report.append(f"- classification={classification}")
        if first_diff is not None:
            py_line = py_lines[first_diff - 1] if first_diff - 1 < len(py_lines) else ""
            web_line = web_lines[first_diff - 1] if first_diff - 1 < len(web_lines) else ""
            report.append(f"- python_line={py_line[:200]}")
            report.append(f"- web_line={web_line[:200]}")
        excerpt = text_diff_excerpt(py_text, web_text)
        if excerpt:
            report.append("- unified_diff_excerpt:")
            report.append("```diff")
            report.extend(excerpt)
            report.append("```")
    if not text_status:
        report.append("- no TXT files found")
    return text_status


def side_by_side_filename(canon: str) -> str | None:
    suffixes = {
        ("RESULTS", "FIGURE_RGB"): "RESULTS_FIGURE_RGB_side_by_side.png",
        ("RESULTS", "BEST_CHANNEL"): "RESULTS_BEST_CHANNEL_side_by_side.png",
        ("RESULTS", "PLATE_ROI_OVERLAY"): "RESULTS_PLATE_ROI_OVERLAY_side_by_side.png",
        ("RAW_DATA_DETAILS", "BG_STAT_MASK"): "RAW_BG_STAT_MASK_side_by_side.png",
        ("RAW_DATA_DETAILS", "FIGURE_CIELAB_DELTAE"): "RAW_FIGURE_CIELAB_DELTAE_side_by_side.png",
        ("RAW_DATA_DETAILS", "METHOD_COMPARISON"): "RAW_METHOD_COMPARISON_side_by_side.png",
    }
    folder = canon.split("/", 1)[0] if "/" in canon else ""
    for (expected_folder, token), filename in suffixes.items():
        if folder == expected_folder and canon.endswith(f"_{token}.png"):
            return filename
    return None


def append_png_visual_audit(
    report: list[str],
    py_zf: zipfile.ZipFile,
    web_zf: zipfile.ZipFile,
    py_canon: dict[str, str],
    web_canon: dict[str, str],
    visual_dir: Path,
    artifact_summary: dict[str, dict[str, str]],
) -> dict[str, PngAuditResult]:
    visual_dir.mkdir(parents=True, exist_ok=True)
    png_results: dict[str, PngAuditResult] = {}
    generated: list[str] = []
    report.extend(["", "## PNG Visual Audit"])
    for canon in sorted(name for name in set(py_canon) | set(web_canon) if name.lower().endswith(".png")):
        py_present = canon in py_canon
        web_present = canon in web_canon
        py_image = decode_png_image(py_zf.read(py_canon[canon])) if py_present else PngImage(0, 0, "missing", 0, -1, None, "missing")
        web_image = decode_png_image(web_zf.read(web_canon[canon])) if web_present else PngImage(0, 0, "missing", 0, -1, None, "missing")
        exact, mean_abs, max_abs, pct_nonidentical = png_pixel_stats(py_image, web_image)
        dimensions_match = (py_image.width, py_image.height) == (web_image.width, web_image.height) if py_present and web_present else False
        if not py_present or not web_present:
            status = "MISSING"
        elif py_image.rgba is None or web_image.rgba is None:
            status = "UNSUPPORTED_OR_DECODE_ERROR"
        elif exact:
            status = "PIXEL_IDENTICAL"
        elif dimensions_match:
            status = "DIMENSIONS_MATCH_PIXEL_DIFFERENT"
        else:
            status = "DIMENSIONS_DIFFER"
        side_name = side_by_side_filename(canon) or ""
        if side_name and py_image.rgba is not None and web_image.rgba is not None:
            composite = make_side_by_side_png(py_image, web_image)
            if composite is not None:
                (visual_dir / side_name).write_bytes(composite)
                generated.append(side_name)
        result = PngAuditResult(
            path=canon,
            status=status,
            python_dimensions=(py_image.width, py_image.height) if py_present else None,
            web_dimensions=(web_image.width, web_image.height) if web_present else None,
            python_mode=py_image.mode,
            web_mode=web_image.mode,
            exact_pixels=exact,
            mean_abs_diff=mean_abs,
            max_abs_diff=max_abs,
            percent_nonidentical_pixels=pct_nonidentical,
            side_by_side=side_name,
        )
        png_results[canon] = result
        if canon in artifact_summary:
            artifact_summary[canon]["visual"] = status
            artifact_summary[canon]["blocker"] = "" if status == "PIXEL_IDENTICAL" else "PNG pixels differ or image missing"
            artifact_summary[canon]["next"] = "inspect visual audit side-by-side" if status != "PIXEL_IDENTICAL" else ""
        report.append(f"### {canon}")
        report.append(f"- presence: python={py_present}, web={web_present}")
        report.append(f"- dimensions: python={result.python_dimensions}, web={result.web_dimensions}, match={dimensions_match}")
        report.append(f"- mode: python={result.python_mode}, web={result.web_mode}")
        if py_image.error or web_image.error:
            report.append(f"- decode_errors: python=`{py_image.error}`, web=`{web_image.error}`")
        report.append(f"- exact_pixel_equality={result.exact_pixels}")
        report.append(f"- mean_abs_diff={'' if result.mean_abs_diff is None else f'{result.mean_abs_diff:.8g}'}")
        report.append(f"- max_abs_diff={'' if result.max_abs_diff is None else result.max_abs_diff}")
        report.append(f"- percent_nonidentical_pixels={'' if result.percent_nonidentical_pixels is None else f'{result.percent_nonidentical_pixels:.6g}'}")
        report.append(f"- structural_notes=status {status}; side_by_side={side_name or 'not generated'}")
    readme = [
        "# Visual audit after 36W",
        "",
        "Generated by `python tools/compare_python_web_outputs.py`.",
        "",
        "Each side-by-side PNG places the Python artifact on the left and the web artifact on the right with a white gutter.",
        "The images are comparison aids only; numerical pixel metrics are in `comparison_report_after_36V.md`.",
        "",
        "Generated files:",
        *[f"- `{name}`" for name in sorted(generated)],
        "",
    ]
    (visual_dir / "README.md").write_text("\n".join(readme), encoding="utf-8")
    report.append(f"- visual audit folder: `{visual_dir}`")
    report.append(f"- generated side-by-side PNGs: {sorted(generated)}")
    report.append("- generated README: `README.md`")
    return png_results


def append_artifact_parity_summary(
    report: list[str],
    artifact_summary: dict[str, dict[str, str]],
    png_results: dict[str, PngAuditResult],
    text_status: dict[str, str],
    workbook_status: dict[str, str],
) -> None:
    report.extend([
        "",
        "## Artifact Parity Summary",
        "| Artifact | Category | File | Structure/Numeric/Text/Visual | First blocking issue | Recommended next action |",
        "|---|---|---|---|---|---|",
    ])
    for canon, status in sorted(artifact_summary.items()):
        category = status["category"]
        details = ""
        if category == "workbook":
            kind = workbook_kind(canon) or "workbook"
            details = f"workbook={workbook_status.get(kind, '')}, numeric={status.get('numeric', '')}"
        elif category == "PNG":
            details = f"visual={png_results.get(canon).status if canon in png_results else ''}"
        elif category == "TXT":
            details = f"text={text_status.get(canon, '')}"
        else:
            details = "not audited deeply"
        blocker = status.get("blocker") or ("missing/extra artifact" if status.get("file") != "PRESENT_BOTH" else "")
        next_action = status.get("next") or ("restore matching artifact set" if status.get("file") != "PRESENT_BOTH" else "")
        report.append(f"| `{canon}` | {category} | {status.get('file', '')} | {details} | {blocker} | {next_action} |")


def append_full_artifact_audit_conclusion(
    report: list[str],
    py_canon: dict[str, str],
    web_canon: dict[str, str],
    png_results: dict[str, PngAuditResult],
    text_status: dict[str, str],
    workbook_status: dict[str, str],
    py_report: Workbook,
    web_report: Workbook,
) -> None:
    png_dimensions_match = all(
        result.python_dimensions == result.web_dimensions
        for result in png_results.values()
        if result.python_dimensions is not None and result.web_dimensions is not None
    )
    png_pixels_match = all(result.exact_pixels is True for result in png_results.values())
    py_methods = rows_as_dicts(py_report.sheets.get("07_METHOD_COMPARISON", []))
    web_methods = rows_as_dicts(web_report.sheets.get("07_METHOD_COMPARISON", []))
    py_selected = [row.get("Method", "") for row in py_methods if row.get("Selected", "").strip().upper() in {"YES", "TRUE", "1"}]
    web_selected = [row.get("Method", "") for row in web_methods if row.get("Selected", "").strip().upper() in {"YES", "TRUE", "1"}]
    if not py_selected and py_methods:
        py_selected = [py_methods[0].get("Method", "")]
    if not web_selected and web_methods:
        web_selected = [web_methods[0].get("Method", "")]
    visual_priority = [
        result.path for result in sorted(
            png_results.values(),
            key=lambda item: (
                item.exact_pixels is True,
                -(item.percent_nonidentical_pixels or 0),
                item.path,
            ),
        ) if result.exact_pixels is not True
    ][:3]
    report.extend([
        "",
        "## Full Artifact Audit Conclusion",
        f"- file_list_status={'MATCH' if set(py_canon) == set(web_canon) else 'DIFFER'}",
        f"- workbook_status={workbook_status}",
        f"- txt_classifications={text_status}",
        f"- png_dimensions_match={png_dimensions_match}",
        f"- png_pixel_contents_match={png_pixels_match}",
        f"- selected_method_python={py_selected}",
        f"- selected_method_web={web_selected}",
        f"- selected_method_differs={py_selected != web_selected}",
        f"- first_pngs_for_human_inspection={visual_priority}",
        "- visual_policy_note: PNG visual differences should be judged by scientific visual parity, not pixel identity alone. A PNG can be acceptable if it conveys all scientific information correctly and does not omit, hallucinate, or mislabel information; BG_STAT_MASK may remain visually different if the web version intentionally and clearly shows selected pixels more readably.",
        "- first_scientific_blocker: resolve workbook numeric/input parity before treating plot and caption differences as final artifact mismatches.",
    ])


def rows_as_dicts(rows: list[list[str]]) -> list[dict[str, str]]:
    if not rows:
        return []
    headers = rows[0]
    out: list[dict[str, str]] = []
    for row in rows[1:]:
        out.append({header: row[index] if index < len(row) else "" for index, header in enumerate(headers)})
    return out


def row_value(row: dict[str, str], *keys: str) -> str:
    for key in keys:
        if key in row:
            return row.get(key, "")
    return ""


def pearson_correlation(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 3 or len(xs) != len(ys):
        return None
    mean_x = statistics.fmean(xs)
    mean_y = statistics.fmean(ys)
    centered_x = [value - mean_x for value in xs]
    centered_y = [value - mean_y for value in ys]
    denom_x = sum(value * value for value in centered_x)
    denom_y = sum(value * value for value in centered_y)
    if denom_x <= 0 or denom_y <= 0:
        return None
    return sum(x * y for x, y in zip(centered_x, centered_y)) / math.sqrt(denom_x * denom_y)


def empty_counts_by_header(rows: list[list[str]]) -> dict[str, int]:
    if not rows:
        return {}
    headers = rows[0]
    counts = {header: 0 for header in headers}
    for row in rows[1:]:
        for index, header in enumerate(headers):
            if index >= len(row) or str(row[index]).strip() == "":
                counts[header] += 1
    return counts


def finite_counts_by_header(rows: list[list[str]]) -> dict[str, int]:
    if not rows:
        return {}
    headers = rows[0]
    counts = {header: 0 for header in headers}
    for row in rows[1:]:
        for index, header in enumerate(headers):
            value = row[index] if index < len(row) else ""
            counts[header] += int(math.isfinite(as_float(value)))
    return {header: count for header, count in counts.items() if count > 0}


def compact_count_diff(py_counts: dict[str, int], web_counts: dict[str, int]) -> dict[str, tuple[int, int]]:
    diff: dict[str, tuple[int, int]] = {}
    for header in sorted(set(py_counts) | set(web_counts)):
        py_count = py_counts.get(header, 0)
        web_count = web_counts.get(header, 0)
        if py_count != web_count:
            diff[header] = (py_count, web_count)
    return diff


def common_stable_key_fields(py_header: list[str], web_header: list[str]) -> list[str]:
    candidates = [
        ["Well"],
        ["BG_Cell_Row", "BG_Cell_Col"],
        ["Method"],
        ["Channel", "FitType", "ID", "DF"],
        ["Channel", "FitType"],
        ["Sheet"],
        ["Field"],
        ["Key"],
    ]
    for fields in candidates:
        if all(field in py_header and field in web_header for field in fields):
            return fields
    return []


def canonical_key_part(field: str, value: str) -> str:
    text = str(value).strip()
    if field == "Method":
        return canonical_method_name(text)
    if field in {"Well", "Channel", "FitType", "ID", "DF"}:
        return text.upper()
    return text


def keyed_rows(rows: list[list[str]], key_fields: list[str]) -> tuple[dict[tuple[str, ...], dict[str, str]], list[tuple[str, ...]], bool]:
    dicts = rows_as_dicts(rows)
    out: dict[tuple[str, ...], dict[str, str]] = {}
    order: list[tuple[str, ...]] = []
    unique = True
    for index, row in enumerate(dicts):
        key = tuple(canonical_key_part(field, row.get(field, "")) for field in key_fields)
        if not any(key):
            key = (f"row:{index + 1}",)
            unique = False
        if key in out:
            unique = False
            key = (*key, f"duplicate:{index + 1}")
        out[key] = row
        order.append(key)
    return out, order, unique


def paired_workbook_rows(py_rows: list[list[str]], web_rows: list[list[str]]) -> tuple[str, list[tuple[dict[str, str], dict[str, str]]], list[str]]:
    if not py_rows or not web_rows:
        return "missing rows", [], []
    py_header = py_rows[0]
    web_header = web_rows[0]
    key_fields = common_stable_key_fields(py_header, web_header)
    if key_fields:
        py_by_key, py_order, py_unique = keyed_rows(py_rows, key_fields)
        web_by_key, web_order, web_unique = keyed_rows(web_rows, key_fields)
        if py_unique and web_unique:
            common_keys = [key for key in py_order if key in web_by_key]
            pairs = [(py_by_key[key], web_by_key[key]) for key in common_keys]
            row_order = "MATCH" if py_order == web_order else "DIFFER"
            mode = f"key-based ({'+'.join(key_fields)}), common={len(common_keys)}, row_order={row_order}"
            return mode, pairs, ["|".join(key) for key in common_keys[:5]]
    row_count = min(len(py_rows), len(web_rows)) - 1
    py_dicts = rows_as_dicts(py_rows)
    web_dicts = rows_as_dicts(web_rows)
    return "row-order comparison only (no stable unique key)", list(zip(py_dicts[:row_count], web_dicts[:row_count])), [str(index + 1) for index in range(min(5, row_count))]


def paired_numeric_column_stats(
    pairs: list[tuple[dict[str, str], dict[str, str]]],
    shared_headers: list[str],
) -> list[str]:
    lines: list[str] = []
    for header in shared_headers:
        py_values: list[float] = []
        web_values: list[float] = []
        diffs: list[float] = []
        signed: list[float] = []
        for py_row, web_row in pairs:
            py_value = as_float(py_row.get(header, ""))
            web_value = as_float(web_row.get(header, ""))
            if math.isfinite(py_value) and math.isfinite(web_value):
                py_values.append(py_value)
                web_values.append(web_value)
                diffs.append(abs(web_value - py_value))
                signed.append(web_value - py_value)
        if not diffs:
            continue
        corr = pearson_correlation(py_values, web_values)
        corr_text = f"{corr:.8g}" if corr is not None else "NA"
        lines.append(
            f"- `{header}`: paired={len(diffs)}, mean_abs={statistics.fmean(diffs):.8g}, "
            f"median_abs={statistics.median(diffs):.8g}, max_abs={max(diffs):.8g}, "
            f"signed_mean={statistics.fmean(signed):.8g}, pearson={corr_text}"
        )
    return lines


def numeric_lines_have_nonzero_delta(lines: list[str]) -> bool:
    for line in lines:
        match = re.search(r"max_abs=([-+0-9.eE]+)", line)
        if match and abs(float(match.group(1))) > 1e-12:
            return True
    return False


def classify_sheet_audit(
    py_rows: list[list[str]],
    web_rows: list[list[str]],
    header_status: str,
    row_mode: str,
    numeric_lines: list[str],
    empty_diff: dict[str, tuple[int, int]],
) -> str:
    if not py_rows or not web_rows:
        return "MISSING_SHEET_OR_ROWS"
    if header_status == "WEB_VALIDATION_EXTENSION":
        return "WEB_VALIDATION_EXTENSION"
    if header_status != "MATCH":
        return "HEADER_DIFFERENCE"
    if numeric_lines_have_nonzero_delta(numeric_lines):
        return "NUMERIC_DIFFERENCE"
    if empty_diff:
        return "EMPTY_CELL_DIFFERENCE"
    if "row_order=DIFFER" in row_mode:
        return "ROW_ORDER_DIFFERENCE"
    return "STRUCTURE_MATCH"


def append_workbook_deep_audit(
    report: list[str],
    workbooks: dict[tuple[str, str], Workbook],
    artifact_summary: dict[str, dict[str, str]],
) -> dict[str, str]:
    workbook_status: dict[str, str] = {}
    report.extend(["", "## Workbook Deep Audit"])
    for kind in ["REPORT", "DIAGNOSTICS"]:
        py_wb = workbooks.get(("python", kind))
        web_wb = workbooks.get(("web", kind))
        if not py_wb or not web_wb:
            report.append(f"### {kind}")
            report.append("- workbook missing on one side")
            workbook_status[kind] = "MISSING"
            continue
        artifact_key = canonical_zip_name(py_wb.name)
        report.append(f"### {kind}")
        report.append(f"- sheet_order_status={'MATCH' if py_wb.order == web_wb.order else 'DIFFER'}")
        sheet_statuses: list[str] = []
        for sheet in sorted(set(py_wb.sheets) | set(web_wb.sheets), key=lambda name: (KEY_SHEETS.get(kind, []).index(name) if name in KEY_SHEETS.get(kind, []) else 999, name)):
            py_rows = py_wb.sheets.get(sheet, [])
            web_rows = web_wb.sheets.get(sheet, [])
            py_header = py_rows[0] if py_rows else []
            web_header = web_rows[0] if web_rows else []
            extension_columns = WEB_VALIDATION_EXTENSION_COLUMNS.get((kind, sheet), [])
            web_without_extensions = [header for header in web_header if header not in extension_columns]
            intentional_extension = bool(extension_columns) and py_header == web_without_extensions
            header_match = py_header == web_header
            missing_cols = [header for header in py_header if header not in web_header]
            extra_cols = [header for header in web_header if header not in py_header]
            header_status = "MATCH" if header_match else ("WEB_VALIDATION_EXTENSION" if intentional_extension else "DIFFER")
            row_mode, pairs, first_keys = paired_workbook_rows(py_rows, web_rows)
            shared_headers = [header for header in py_header if header in web_header]
            numeric_lines = paired_numeric_column_stats(pairs, shared_headers)
            py_empty = empty_counts_by_header(py_rows)
            web_empty = empty_counts_by_header(web_rows)
            empty_diff = compact_count_diff(py_empty, web_empty)
            py_finite = finite_counts_by_header(py_rows)
            web_finite = finite_counts_by_header(web_rows)
            finite_diff = compact_count_diff(py_finite, web_finite)
            classification = classify_sheet_audit(py_rows, web_rows, header_status, row_mode, numeric_lines, empty_diff)
            sheet_statuses.append(classification)
            report.append(f"#### {sheet}")
            report.append(f"- exists: python={bool(py_rows)}, web={bool(web_rows)}")
            report.append(f"- shape: python={sheet_shape(py_rows)}, web={sheet_shape(web_rows)}")
            report.append(f"- header_status={header_status}")
            report.append(f"- missing_columns={missing_cols}")
            report.append(f"- extra_columns={extra_cols}")
            if intentional_extension:
                report.append(f"- accepted_web_validation_columns={[header for header in extension_columns if header in web_header]}")
            report.append(f"- matching_mode={row_mode}")
            report.append(f"- first_5_key_values={first_keys}")
            report.append(f"- row_order_status={'DIFFER' if 'row_order=DIFFER' in row_mode else ('ROW_ORDER_ONLY' if 'row-order comparison only' in row_mode else 'MATCH')}")
            report.append(f"- empty_count_differences={empty_diff}")
            report.append(f"- numeric_finite_count_differences={finite_diff}")
            report.append("- shared_numeric_stats:")
            report.extend(numeric_lines[:60] if numeric_lines else ["  - none"])
            if len(numeric_lines) > 60:
                report.append(f"  - ... {len(numeric_lines) - 60} additional numeric columns omitted from display")
            report.append(f"- classification={classification}")
        overall = "MATCH" if all(status == "STRUCTURE_MATCH" for status in sheet_statuses) else "DIFFER"
        workbook_status[kind] = overall
        if artifact_key in artifact_summary:
            artifact_summary[artifact_key]["structure"] = overall
            artifact_summary[artifact_key]["numeric"] = "DIFFER" if any("NUMERIC" in status for status in sheet_statuses) else overall
            artifact_summary[artifact_key]["blocker"] = "workbook sheet/header/numeric differences" if overall == "DIFFER" else ""
            artifact_summary[artifact_key]["next"] = "inspect Workbook Deep Audit" if overall == "DIFFER" else ""
    return workbook_status


def numeric_delta_summary(py_rows: list[dict[str, str]], web_rows: list[dict[str, str]], fields: list[tuple[str, str]]) -> list[str]:
    lines: list[str] = []
    row_count = min(len(py_rows), len(web_rows))
    for label, field in fields:
        diffs: list[float] = []
        py_finite = 0
        web_finite = 0
        py_blank = 0
        web_blank = 0
        for index in range(row_count):
            py_raw = py_rows[index].get(field, "")
            web_raw = web_rows[index].get(field, "")
            py_blank += int(str(py_raw).strip() == "")
            web_blank += int(str(web_raw).strip() == "")
            py_val = as_float(py_raw)
            web_val = as_float(web_raw)
            py_finite += int(math.isfinite(py_val))
            web_finite += int(math.isfinite(web_val))
            if math.isfinite(py_val) and math.isfinite(web_val):
                diffs.append(abs(py_val - web_val))
        if diffs:
            lines.append(f"- {label}: paired={len(diffs)}, mean_abs={statistics.fmean(diffs):.8g}, max_abs={max(diffs):.8g}, python_finite={py_finite}, web_finite={web_finite}, web_blank={web_blank}")
        else:
            lines.append(f"- {label}: no paired finite values, python_finite={py_finite}, web_finite={web_finite}, python_blank={py_blank}, web_blank={web_blank}")
    return lines


def first_row_comparison(py_rows: list[dict[str, str]], web_rows: list[dict[str, str]], fields: list[tuple[str, str]]) -> list[str]:
    if not py_rows or not web_rows:
        return ["- first data row unavailable"]
    py_row = py_rows[0]
    web_row = web_rows[0]
    lines: list[str] = []
    for label, field in fields:
        py_value = py_row.get(field, "")
        web_value = web_row.get(field, "")
        suffix = " (web blank)" if str(web_value).strip() == "" else ""
        lines.append(f"- {label}: python=`{py_value}`, web=`{web_value}`{suffix}")
    return lines


def method_order(rows: list[dict[str, str]]) -> list[str]:
    return [row.get("Method", "") for row in rows if row.get("Method", "")]


def canonical_method_name(name: str) -> str:
    return METHOD_ALIASES.get(str(name).strip(), str(name).strip())


def method_rows_by_canonical_key(rows: list[dict[str, str]]) -> dict[str, dict[str, str]]:
    out: dict[str, dict[str, str]] = {}
    for index, row in enumerate(rows):
        method = canonical_method_name(row.get("Method", ""))
        if not method:
            method = f"row:{index + 1}"
        out[method] = row
    return out


def has_method_alias_difference(py_row: dict[str, str], web_row: dict[str, str]) -> bool:
    py_method = str(py_row.get("Method", "")).strip()
    web_method = str(web_row.get("Method", "")).strip()
    return py_method != web_method and canonical_method_name(py_method) == canonical_method_name(web_method)


def finite_or_none(value: str) -> float | None:
    parsed = as_float(value)
    return parsed if math.isfinite(parsed) else None


def recompute_method_score(row: dict[str, str]) -> tuple[float, str, list[str]]:
    r2_cal = finite_or_none(row.get("R2_cal", ""))
    r2_std = finite_or_none(row.get("R2_std_mean", row.get("R2_std", "")))
    slope = finite_or_none(row.get("SlopeAgreement", ""))
    loq = finite_or_none(row.get("LOQ", ""))
    missing: list[str] = []

    if r2_cal is not None and r2_std is not None and slope is not None:
        base = (slope ** 2) * math.sqrt(max(r2_cal, 0.0) * max(r2_std, 0.0))
        if loq is not None and loq > 0:
            return base / loq, "slope_agreement^2 * sqrt(R2_cal * R2_std) * (1/LOQ)", []
        return base, "slope_agreement^2 * sqrt(R2_cal * R2_std)", ["LOQ"]

    if r2_cal is not None:
        return max(r2_cal, 0.0), "R2_cal", []

    if r2_std is not None:
        return max(r2_std, 0.0), "R2_std_mean", []

    for field, value in [("R2_cal", r2_cal), ("R2_std_mean", r2_std), ("SlopeAgreement", slope)]:
        if value is None:
            missing.append(field)
    return math.nan, "not_recomputable", missing


def score_reconstruction_status(row: dict[str, str], field: str) -> tuple[str, float, str, list[str]]:
    recomputed, formula, missing = recompute_method_score(row)
    workbook_value = as_float(row.get(field, ""))
    if not math.isfinite(workbook_value):
        return "NO_WORKBOOK_VALUE", math.nan, formula, missing
    if not math.isfinite(recomputed):
        return "NOT_RECOMPUTABLE", math.nan, formula, missing
    residual = workbook_value - recomputed
    return ("PASS" if abs(residual) <= SCORE_TOLERANCE else "WARN"), residual, formula, missing


def score_formula_consistent(row: dict[str, str]) -> bool:
    recomputed, formula, _missing = recompute_method_score(row)
    workbook_score = as_float(row.get("Score", ""))
    if not math.isfinite(recomputed) or not math.isfinite(workbook_score):
        return False
    return abs(workbook_score - recomputed) <= SCORE_TOLERANCE and (
        not str(row.get("ScoreFormula", "")).strip() or str(row.get("ScoreFormula", "")).strip() == formula
    )


def numeric_field_diffs(py_row: dict[str, str], web_row: dict[str, str], fields: list[str], tolerance: float = SCORE_TOLERANCE) -> list[str]:
    diffs: list[str] = []
    for field in fields:
        py_val = as_float(py_row.get(field, ""))
        web_val = as_float(web_row.get(field, ""))
        if math.isfinite(py_val) and math.isfinite(web_val) and abs(py_val - web_val) > tolerance:
            diffs.append(field)
    return diffs


def text_field_diffs(py_row: dict[str, str], web_row: dict[str, str], fields: list[str]) -> list[str]:
    diffs: list[str] = []
    for field in fields:
        if str(py_row.get(field, "")).strip() != str(web_row.get(field, "")).strip():
            diffs.append(field)
    return diffs


def classify_method_difference(py_row: dict[str, str] | None, web_row: dict[str, str] | None) -> str:
    if py_row is None or web_row is None:
        return "A missing/extra method due to naming mismatch or availability"
    if has_method_alias_difference(py_row, web_row):
        return "A equivalent method alias used for comparison key"
    input_diffs = numeric_field_diffs(py_row, web_row, [
        "R2_cal",
        "R2_std_mean",
        "m_cal",
        "m_std_mean",
        "SlopeAgreement",
        "beta_mean",
        "bias_index_mean",
        "SNR",
        "LOD",
        "LOQ",
        "C0_mean",
        "C0_median",
        "C0_sd_median",
        "Estimate_value",
        "Estimate_sd",
    ], tolerance=1e-8)
    if input_diffs:
        return f"B same method but different upstream fit inputs ({', '.join(input_diffs[:6])})"
    py_score_ok = score_formula_consistent(py_row)
    web_score_ok = score_formula_consistent(web_row)
    if not py_score_ok or not web_score_ok:
        return "C same method/input fields but Score does not reconstruct from inferred formula"
    score_diffs = numeric_field_diffs(py_row, web_row, ["Score", "BaseScore"], tolerance=1e-8)
    rank_diffs = text_field_diffs(py_row, web_row, ["Rank", "Selected"])
    if not score_diffs and rank_diffs:
        return "D same score but different ranking/tie-break or selected group"
    reference_diffs = [
        field for field in set(py_row) | set(web_row)
        if field.startswith(("expected_", "estimate_for_expected_", "delta_expected_", "recovery_pct_", "rel_error_"))
        and str(py_row.get(field, "")).strip() != str(web_row.get(field, "")).strip()
    ]
    if reference_diffs:
        return "F expected-reference/bias/reporting metric difference"
    reporting_diffs = text_field_diffs(py_row, web_row, ["Family", "ComparableGroup", "ScoreFormula", "RankMode"])
    if reporting_diffs:
        return f"E reporting/grouping label difference ({', '.join(reporting_diffs)})"
    return "G unknown or below threshold"


def key_rows(rows: list[dict[str, str]], fields: list[str]) -> dict[str, dict[str, str]]:
    out: dict[str, dict[str, str]] = {}
    for index, row in enumerate(rows):
        parts = [str(row.get(field, "")).strip() for field in fields]
        key = "|".join(parts)
        if not key.strip("|"):
            key = f"row:{index + 1}"
        out[key] = row
    return out


def keyed_numeric_summary(
    py_rows: list[dict[str, str]],
    web_rows: list[dict[str, str]],
    key_fields: list[str],
    fields: list[tuple[str, str]],
) -> list[str]:
    py_by_key = key_rows(py_rows, key_fields)
    web_by_key = key_rows(web_rows, key_fields)
    common_keys = sorted(set(py_by_key) & set(web_by_key))
    lines = [
        f"- keys: python={len(py_by_key)}, web={len(web_by_key)}, common={len(common_keys)}, missing_in_web={len(set(py_by_key) - set(web_by_key))}, extra_in_web={len(set(web_by_key) - set(py_by_key))}",
    ]
    for label, field in fields:
        diffs: list[float] = []
        py_finite = 0
        web_finite = 0
        for key in common_keys:
            py_val = as_float(py_by_key[key].get(field, ""))
            web_val = as_float(web_by_key[key].get(field, ""))
            py_finite += int(math.isfinite(py_val))
            web_finite += int(math.isfinite(web_val))
            if math.isfinite(py_val) and math.isfinite(web_val):
                diffs.append(abs(py_val - web_val))
        if diffs:
            lines.append(f"- {label}: paired={len(diffs)}, mean_abs={statistics.fmean(diffs):.8g}, max_abs={max(diffs):.8g}, python_finite={py_finite}, web_finite={web_finite}")
        else:
            lines.append(f"- {label}: no paired finite values, python_finite={py_finite}, web_finite={web_finite}")
    return lines


def paired_by_keys(
    py_rows: list[dict[str, str]],
    web_rows: list[dict[str, str]],
    key_fields: list[str],
) -> tuple[dict[str, dict[str, str]], dict[str, dict[str, str]], list[str]]:
    py_by_key = key_rows(py_rows, key_fields)
    web_by_key = key_rows(web_rows, key_fields)
    return py_by_key, web_by_key, sorted(set(py_by_key) & set(web_by_key))


def classify_pabs_channel(raw_mismatch_max: float, correction_max: float, py_formula_max: float, web_formula_max: float) -> tuple[str, str]:
    if not math.isfinite(raw_mismatch_max):
        return "UNRESOLVED", "required raw audit values are missing"
    raw_material = math.isfinite(raw_mismatch_max) and raw_mismatch_max > AUDIT_MATERIAL_THRESHOLD
    correction_material = math.isfinite(correction_max) and correction_max > AUDIT_MATERIAL_THRESHOLD
    py_formula_ok = math.isfinite(py_formula_max) and py_formula_max <= AUDIT_MATERIAL_THRESHOLD
    web_formula_ok = math.isfinite(web_formula_max) and web_formula_max <= AUDIT_MATERIAL_THRESHOLD

    if not raw_material and not correction_material and py_formula_ok and web_formula_ok:
        return "NO_FORMULA_MISMATCH", (
            f"raw_max={fmt_number(raw_mismatch_max)}, correction_max={fmt_number(correction_max)}, "
            f"py_formula_max={fmt_number(py_formula_max)}, web_formula_max={fmt_number(web_formula_max)}"
        )
    if raw_material and (not correction_material or raw_mismatch_max >= AUDIT_DOMINANCE_RATIO * max(correction_max, AUDIT_MATERIAL_THRESHOLD)):
        return "RAW_EXTRACTION_DOMINANT", (
            f"raw_max={fmt_number(raw_mismatch_max)} is >= {AUDIT_DOMINANCE_RATIO}x correction_max={fmt_number(correction_max)}"
        )
    if correction_material and (not raw_material or correction_max >= AUDIT_DOMINANCE_RATIO * max(raw_mismatch_max, AUDIT_MATERIAL_THRESHOLD)):
        return "CORRECTION_MAPPING_DOMINANT", (
            f"correction_max={fmt_number(correction_max)} is >= {AUDIT_DOMINANCE_RATIO}x raw_max={fmt_number(raw_mismatch_max)}"
        )
    if raw_material and correction_material:
        return "MIXED_RAW_AND_CORRECTION", (
            f"raw_max={fmt_number(raw_mismatch_max)}, correction_max={fmt_number(correction_max)}, "
            f"dominance ratio < {AUDIT_DOMINANCE_RATIO}"
        )
    return "UNRESOLVED", (
        f"raw_max={fmt_number(raw_mismatch_max)}, correction_max={fmt_number(correction_max)}, "
        f"py_formula_max={fmt_number(py_formula_max)}, web_formula_max={fmt_number(web_formula_max)}"
    )


def append_delta_summary_table(report: list[str], summaries: list[tuple[str, dict[str, float | int]]]) -> None:
    report.append("| comparison | paired | mean_abs | median_abs | max_abs | signed_mean |")
    report.append("|---|---:|---:|---:|---:|---:|")
    for label, summary in summaries:
        report.append(
            f"| {label} | {fmt_number(summary['paired'])} | {fmt_number(summary['mean_abs'])} | "
            f"{fmt_number(summary['median_abs'])} | {fmt_number(summary['max_abs'])} | {fmt_number(summary['signed_mean'])} |"
        )


def append_36w_o_column_availability(report: list[str], py_report: Workbook, web_report: Workbook) -> None:
    report.extend(["### 1. Column availability", "- 36W-O audit columns are expected to be web-only unless Python exports equivalent fields."])
    for sheet, expected in AUDIT_36W_O_COLUMNS.items():
        py_headers = sheet_headers(py_report, sheet)
        web_headers = sheet_headers(web_report, sheet)
        py = available_columns(py_headers, expected)
        web = available_columns(web_headers, expected)
        missing = [column for column in expected if column not in py_headers and column not in web_headers]
        web_only = [column for column in expected if column in web_headers and column not in py_headers]
        py_only = [column for column in expected if column in py_headers and column not in web_headers]
        report.append(f"#### {sheet}")
        report.append(f"- expected columns checked: {expected}")
        report.append(f"- present in Python: {py['present']}")
        report.append(f"- present in web: {web['present']}")
        report.append(f"- missing: {missing}")
        report.append(f"- web-only: {web_only}")
        report.append(f"- Python-only: {py_only}")


def append_36w_o_raw_trace(report: list[str], py_report: Workbook, web_report: Workbook) -> dict[str, dict[str, float | int | str]]:
    py_raw = rows_as_dicts(py_report.sheets.get("04_RAW", []))
    web_raw = rows_as_dicts(web_report.sheets.get("04_RAW", []))
    py_by_key, web_by_key, common = paired_by_keys(py_raw, web_raw, ["Well"])
    classifications: dict[str, dict[str, float | int | str]] = {}
    report.extend(["### 2. RAW row-level PAbs trace", f"- rows paired by `Well`: common={len(common)}"])
    for label in CHANNEL_LABELS:
        rows: list[dict[str, object]] = []
        for key in common:
            py_row = py_by_key[key]
            web_row = web_by_key[key]
            py_exported = as_float(py_row.get(f"PAbs_{label}", ""))
            py_raw_reconstructed = recompute_pabs(py_row, label)
            web_exported = as_float(web_row.get(f"PAbs_{label}_exported", web_row.get(f"PAbs_{label}", "")))
            web_raw_audit = as_float(web_row.get(f"PAbs_{label}_raw", ""))
            web_raw_reconstructed = recompute_pabs(web_row, label)
            web_correction_delta = as_float(web_row.get(f"PAbs_{label}_correction_delta", ""))
            web_s0 = as_float(web_row.get(f"S0_{label}_applied", ""))
            web_clip = as_float(web_row.get(f"ClipDelta_{label}_applied", ""))
            web_total = as_float(web_row.get(f"TotalDelta_{label}_applied", ""))
            rows.append({
                "Well": key,
                "py_exported": py_exported,
                "py_raw_reconstructed": py_raw_reconstructed,
                "web_exported": web_exported,
                "web_raw_audit": web_raw_audit,
                "web_raw_reconstructed": web_raw_reconstructed,
                "web_correction_delta": web_correction_delta,
                "web_s0": web_s0,
                "web_clip": web_clip,
                "web_total": web_total,
                "web_exported_minus_raw": web_exported - web_raw_audit if math.isfinite(web_exported) and math.isfinite(web_raw_audit) else math.nan,
                "py_exported_minus_raw": py_exported - py_raw_reconstructed if math.isfinite(py_exported) and math.isfinite(py_raw_reconstructed) else math.nan,
                "py_exported_minus_web_raw": py_exported - web_raw_audit if math.isfinite(py_exported) and math.isfinite(web_raw_audit) else math.nan,
                "py_exported_minus_web_exported": py_exported - web_exported if math.isfinite(py_exported) and math.isfinite(web_exported) else math.nan,
                "web_raw_audit_minus_reconstructed": web_raw_audit - web_raw_reconstructed if math.isfinite(web_raw_audit) and math.isfinite(web_raw_reconstructed) else math.nan,
            })

        py_formula = delta_summary(row["py_exported_minus_raw"] for row in rows if isinstance(row, dict))
        web_formula = delta_summary(row["web_exported_minus_raw"] for row in rows if isinstance(row, dict))
        raw_vs_web_raw = delta_summary(row["py_exported_minus_web_raw"] for row in rows if isinstance(row, dict))
        exported_vs_exported = delta_summary(row["py_exported_minus_web_exported"] for row in rows if isinstance(row, dict))
        web_raw_formula = delta_summary(row["web_raw_audit_minus_reconstructed"] for row in rows if isinstance(row, dict))
        correction_delta_stats = delta_summary(row["web_correction_delta"] for row in rows if isinstance(row, dict))
        total_delta_stats = delta_summary(row["web_total"] for row in rows if isinstance(row, dict))
        correction_max = max(
            [value for value in [float(correction_delta_stats["max_abs"]), float(total_delta_stats["max_abs"]), float(web_formula["max_abs"])] if math.isfinite(value)],
            default=math.nan,
        )
        raw_max = max(
            [value for value in [float(raw_vs_web_raw["max_abs"]), float(web_raw_formula["max_abs"])] if math.isfinite(value)],
            default=math.nan,
        )
        classification, evidence = classify_pabs_channel(raw_max, correction_max, float(py_formula["max_abs"]), float(web_formula["max_abs"]))
        nonzero_corrections = sum(1 for row in rows if math.isfinite(float(row["web_total"])) and abs(float(row["web_total"])) > AUDIT_MATERIAL_THRESHOLD)
        classifications[label] = {
            "classification": classification,
            "evidence": evidence,
            "raw_max": raw_max,
            "correction_max": correction_max,
            "py_formula_max": float(py_formula["max_abs"]),
            "web_formula_max": float(web_formula["max_abs"]),
            "nonzero_corrections": nonzero_corrections,
            "paired_rows": len(common),
        }
        worst = sorted(
            rows,
            key=lambda row: abs(float(row["py_exported_minus_web_exported"])) if math.isfinite(float(row["py_exported_minus_web_exported"])) else -1.0,
            reverse=True,
        )[:5]

        report.append(f"#### {label}")
        append_delta_summary_table(report, [
            ("Python exported - Python reconstructed raw", py_formula),
            ("Web exported - Web raw audit", web_formula),
            ("Web raw audit - Web reconstructed raw", web_raw_formula),
            ("Python exported - Web raw audit", raw_vs_web_raw),
            ("Python exported - Web exported", exported_vs_exported),
            ("Web correction delta", correction_delta_stats),
            ("Web total delta", total_delta_stats),
        ])
        report.append(f"- nonzero correction rows: {nonzero_corrections}")
        report.append(f"- classification: {classification}")
        report.append(f"- evidence: {evidence}; thresholds: material>{AUDIT_MATERIAL_THRESHOLD}, dominance>={AUDIT_DOMINANCE_RATIO}x")
        report.append("| Well | Python exported | Python reconstructed raw | Web exported | Web raw audit | Web reconstructed raw | Web correction delta | Web S0 | Web ClipDelta | Web TotalDelta | Python exported - Web raw | Python exported - Web exported |")
        report.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
        for row in worst:
            report.append(
                f"| {markdown_cell_text(str(row['Well']))} | {fmt_number(float(row['py_exported']))} | {fmt_number(float(row['py_raw_reconstructed']))} | "
                f"{fmt_number(float(row['web_exported']))} | {fmt_number(float(row['web_raw_audit']))} | {fmt_number(float(row['web_raw_reconstructed']))} | "
                f"{fmt_number(float(row['web_correction_delta']))} | {fmt_number(float(row['web_s0']))} | {fmt_number(float(row['web_clip']))} | "
                f"{fmt_number(float(row['web_total']))} | {fmt_number(float(row['py_exported_minus_web_raw']))} | "
                f"{fmt_number(float(row['py_exported_minus_web_exported']))} |"
            )
    return classifications


def append_36w_o_classification_section(report: list[str], raw_summary: dict[str, dict[str, float | int | str]]) -> None:
    report.extend(["### 3. Classification per channel"])
    report.append("| channel | classification | paired rows | raw mismatch max_abs | correction max_abs | Python exported-minus-raw max_abs | Web exported-minus-raw max_abs | nonzero correction rows | evidence |")
    report.append("|---|---|---:|---:|---:|---:|---:|---:|---|")
    for label in CHANNEL_LABELS:
        summary = raw_summary.get(label, {})
        report.append(
            f"| {label} | {summary.get('classification', 'UNRESOLVED')} | {fmt_number(summary.get('paired_rows'))} | "
            f"{fmt_number(summary.get('raw_max'))} | {fmt_number(summary.get('correction_max'))} | "
            f"{fmt_number(summary.get('py_formula_max'))} | {fmt_number(summary.get('web_formula_max'))} | "
            f"{fmt_number(summary.get('nonzero_corrections'))} | {summary.get('evidence', '')} |"
        )


def append_36w_o_replicate_trace(report: list[str], py_report: Workbook, web_report: Workbook) -> dict[str, dict[str, float]]:
    py_rep = rows_as_dicts(py_report.sheets.get("05_REPLICATES_MEAN", []))
    web_rep = rows_as_dicts(web_report.sheets.get("05_REPLICATES_MEAN", []))
    py_by_key, web_by_key, common = paired_by_keys(py_rep, web_rep, ["ID", "DF", "Type", "Conc"])
    summary: dict[str, dict[str, float]] = {}
    report.extend(["### 4. Replicate-level propagation", f"- replicate groups paired by `ID|DF|Type|Conc`: common={len(common)}"])
    for label in CHANNEL_LABELS:
        raw_field = f"PAbs_{label}_raw_median"
        fit_field = f"PAbs_{label}_fit_input_median"
        if not common or raw_field not in sheet_headers(web_report, "05_REPLICATES_MEAN") or fit_field not in sheet_headers(web_report, "05_REPLICATES_MEAN"):
            report.append(f"#### {label}")
            report.append(f"- UNRESOLVED: missing web replicate audit columns `{raw_field}` and/or `{fit_field}`")
            summary[label] = {"py_vs_web_raw_max": math.nan, "py_vs_web_fit_max": math.nan, "web_fit_minus_raw_max": math.nan}
            continue
        rows = []
        for key in common:
            py_row = py_by_key[key]
            web_row = web_by_key[key]
            py_median = as_float(py_row.get(f"PAbs_{label}_median", ""))
            web_raw = as_float(web_row.get(raw_field, ""))
            web_fit = as_float(web_row.get(fit_field, ""))
            rows.append({
                "key": key,
                "py_median": py_median,
                "web_raw": web_raw,
                "web_fit": web_fit,
                "py_minus_web_raw": py_median - web_raw if math.isfinite(py_median) and math.isfinite(web_raw) else math.nan,
                "py_minus_web_fit": py_median - web_fit if math.isfinite(py_median) and math.isfinite(web_fit) else math.nan,
                "web_fit_minus_raw": web_fit - web_raw if math.isfinite(web_fit) and math.isfinite(web_raw) else math.nan,
            })
        py_vs_web_raw = delta_summary(row["py_minus_web_raw"] for row in rows)
        py_vs_web_fit = delta_summary(row["py_minus_web_fit"] for row in rows)
        web_fit_minus_raw = delta_summary(row["web_fit_minus_raw"] for row in rows)
        summary[label] = {
            "py_vs_web_raw_max": float(py_vs_web_raw["max_abs"]),
            "py_vs_web_fit_max": float(py_vs_web_fit["max_abs"]),
            "web_fit_minus_raw_max": float(web_fit_minus_raw["max_abs"]),
        }
        worst = sorted(rows, key=lambda row: abs(float(row["py_minus_web_fit"])) if math.isfinite(float(row["py_minus_web_fit"])) else -1.0, reverse=True)[:5]
        report.append(f"#### {label}")
        append_delta_summary_table(report, [
            ("Python median - Web raw median", py_vs_web_raw),
            ("Python median - Web fit-input median", py_vs_web_fit),
            ("Web fit-input median - Web raw median", web_fit_minus_raw),
        ])
        report.append("| ID|DF|Type|Conc | Python median | Web raw median | Web fit-input median | Python-Web raw | Python-Web fit-input | Web fit-input-raw |")
        report.append("|---|---:|---:|---:|---:|---:|---:|")
        for row in worst:
            report.append(
                f"| {row['key']} | {fmt_number(float(row['py_median']))} | {fmt_number(float(row['web_raw']))} | "
                f"{fmt_number(float(row['web_fit']))} | {fmt_number(float(row['py_minus_web_raw']))} | "
                f"{fmt_number(float(row['py_minus_web_fit']))} | {fmt_number(float(row['web_fit_minus_raw']))} |"
            )
    return summary


def append_36w_o_fit_input_trace(report: list[str], py_report: Workbook, web_report: Workbook) -> dict[str, dict[str, float]]:
    py_rep = rows_as_dicts(py_report.sheets.get("05_REPLICATES_MEAN", []))
    py_fit = rows_as_dicts(py_report.sheets.get("06_FITTING", []))
    web_fit = rows_as_dicts(web_report.sheets.get("06_FITTING", []))
    web_headers = sheet_headers(web_report, "06_FITTING")
    final_y_col = first_present_column(web_headers, ["FitY_input_points", "FitY_final_points"])
    delta_col = first_present_column(web_headers, ["FitY_input_delta_points", "FitY_delta_points"])
    threshold_col = first_present_column(web_headers, ["ClipSDThreshold_points", "ClipThreshold_points"])
    py_by_fit = {fit_key(row): row for row in py_fit if canonical_method_name(row.get("Channel", "")).startswith("PAbs_")}
    web_by_fit = {fit_key(row): row for row in web_fit if canonical_method_name(row.get("Channel", "")).startswith("PAbs_")}
    common = sorted(set(py_by_fit) & set(web_by_fit))
    summary: dict[str, dict[str, float]] = {label: {"py_vs_web_raw_max": math.nan, "py_vs_web_final_max": math.nan, "web_final_minus_raw_max": math.nan} for label in CHANNEL_LABELS}
    report.extend([
        "### 5. Fit-input array trace",
        "- Python fit-input point arrays are not exported directly; they are reconstructed cautiously from REPORT/05_REPLICATES_MEAN.",
        f"- resolved web columns: FitY_final={final_y_col or 'missing'}, FitY_delta={delta_col or 'missing'}, ClipThreshold={threshold_col or 'missing'}",
    ])
    report.append("| fit key | channel | FitType | ID | DF | x_match | n_py_reconstructed | n_web_raw | n_web_final | py-vs-web raw max_abs | py-vs-web final max_abs | web final-minus-raw max_abs | note |")
    report.append("|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|")
    for key in common:
        py_row = py_by_fit[key]
        web_row = web_by_fit[key]
        channel = canonical_method_name(py_row.get("Channel", "")).replace("PAbs_", "")
        fit_type = py_row.get("FitType", "")
        sample_id = py_row.get("ID", "")
        df = py_row.get("DF", "")
        py_points = replicate_fit_points(py_rep, py_row)
        py_x = [x for x, _y in py_points]
        py_y = [y for _x, y in py_points]
        web_x = parse_number_list(web_row.get("FitX_points", ""))
        web_raw_y = parse_number_list(web_row.get("FitY_raw_points", ""))
        web_final_y = parse_number_list(web_row.get(final_y_col or "", "")) if final_y_col else []
        x_match = bool(py_x and web_x and len(py_x) == len(web_x) and all(abs(px - wx) <= 1e-12 for px, wx in zip(py_x, web_x)))
        raw_diffs = [pyv - webv for pyv, webv in zip(py_y, web_raw_y)] if x_match and len(py_y) == len(web_raw_y) else []
        final_diffs = [pyv - webv for pyv, webv in zip(py_y, web_final_y)] if x_match and len(py_y) == len(web_final_y) else []
        web_delta = [final - raw for final, raw in zip(web_final_y, web_raw_y)] if len(web_final_y) == len(web_raw_y) and web_final_y and web_raw_y else []
        raw_summary = delta_summary(raw_diffs)
        final_summary = delta_summary(final_diffs)
        web_delta_summary = delta_summary(web_delta)
        if channel in summary:
            summary[channel]["py_vs_web_raw_max"] = max_or_nan(summary[channel]["py_vs_web_raw_max"], float(raw_summary["max_abs"]))
            summary[channel]["py_vs_web_final_max"] = max_or_nan(summary[channel]["py_vs_web_final_max"], float(final_summary["max_abs"]))
            summary[channel]["web_final_minus_raw_max"] = max_or_nan(summary[channel]["web_final_minus_raw_max"], float(web_delta_summary["max_abs"]))
        note = "python points reconstructed from replicate means"
        if not py_points:
            note = "Python point array not reconstructible from replicate sheet"
        elif not web_x or not web_raw_y or not web_final_y:
            note = "web fit-input audit arrays missing"
        elif not x_match:
            note = "x arrays differ; point-level parity not claimed"
        report.append(
            f"| {markdown_cell_text(key)} | {channel} | {fit_type} | {markdown_cell_text(sample_id)} | {markdown_cell_text(df)} | {x_match} | {len(py_y)} | {len(web_raw_y)} | {len(web_final_y)} | "
            f"{fmt_number(raw_summary['max_abs'])} | {fmt_number(final_summary['max_abs'])} | {fmt_number(web_delta_summary['max_abs'])} | {note} |"
        )
    return summary


def append_36w_o_decision_summary(
    report: list[str],
    raw_summary: dict[str, dict[str, float | int | str]],
    replicate_summary: dict[str, dict[str, float]],
    fit_summary: dict[str, dict[str, float]],
) -> None:
    report.extend(["### 6. Decision summary"])
    for label in CHANNEL_LABELS:
        raw_info = raw_summary.get(label, {})
        replicate_fit = replicate_summary.get(label, {})
        fit_input = fit_summary.get(label, {})
        report.append(
            f"- {label}: raw/exported classification={raw_info.get('classification', 'UNRESOLVED')}; "
            f"replicate py-vs-web raw max_abs={fmt_number(replicate_fit.get('py_vs_web_raw_max'))}, "
            f"replicate py-vs-web fit-input max_abs={fmt_number(replicate_fit.get('py_vs_web_fit_max'))}, "
            f"fit-array py-vs-web raw max_abs={fmt_number(fit_input.get('py_vs_web_raw_max'))}, "
            f"fit-array py-vs-web final max_abs={fmt_number(fit_input.get('py_vs_web_final_max'))}, "
            f"web final-minus-raw max_abs={fmt_number(fit_input.get('web_final_minus_raw_max'))}"
        )
    classes = [str(info.get('classification', 'UNRESOLVED')) for info in raw_summary.values()]
    if any(value == "CORRECTION_MAPPING_DOMINANT" for value in classes):
        overall = "correction/display mapping"
        next_target = "PAbs correction mapping parity"
    elif any(value == "MIXED_RAW_AND_CORRECTION" for value in classes):
        overall = "mixed raw extraction and correction mapping"
        next_target = "PAbs correction mapping parity only after confirming BG/MeanBG parity remains close"
    elif any(value == "RAW_EXTRACTION_DOMINANT" for value in classes):
        overall = "raw extraction/BG"
        next_target = "BG/MeanBG parity"
    elif all(value == "NO_FORMULA_MISMATCH" for value in classes if value):
        overall = "no formula mismatch detected from exported PAbs columns"
        next_target = "final fit-input y construction or CIELAB conversion/reference parity"
    else:
        overall = "unresolved"
        next_target = "smallest missing export addition needed to classify raw vs fit-input deltas"
    report.append(f"- Overall residual bucket from 36W-O audit columns: {overall}")
    report.append(f"- Recommended next runtime target, if any: {next_target}")


def append_36w_o_pabs_audit_trace(report: list[str], py_report: Workbook, web_report: Workbook) -> None:
    report.extend(["", "## 36W-O PAbs Audit Column Trace"])
    append_36w_o_column_availability(report, py_report, web_report)
    raw_summary = append_36w_o_raw_trace(report, py_report, web_report)
    append_36w_o_classification_section(report, raw_summary)
    replicate_summary = append_36w_o_replicate_trace(report, py_report, web_report)
    fit_summary = append_36w_o_fit_input_trace(report, py_report, web_report)
    append_36w_o_decision_summary(report, raw_summary, replicate_summary, fit_summary)


def field_diff_stats(
    py_rows: list[dict[str, str]],
    web_rows: list[dict[str, str]],
    key_fields: list[str],
    field: str,
) -> dict[str, float | int]:
    py_by_key, web_by_key, common = paired_by_keys(py_rows, web_rows, key_fields)
    diffs: list[float] = []
    signed: list[float] = []
    for key in common:
        py_val = as_float(py_by_key[key].get(field, ""))
        web_val = as_float(web_by_key[key].get(field, ""))
        if math.isfinite(py_val) and math.isfinite(web_val):
            delta = web_val - py_val
            signed.append(delta)
            diffs.append(abs(delta))
    return {
        "paired": len(diffs),
        "mean_abs": statistics.fmean(diffs) if diffs else math.nan,
        "median_abs": statistics.median(diffs) if diffs else math.nan,
        "max_abs": max(diffs) if diffs else math.nan,
        "signed_mean": statistics.fmean(signed) if signed else math.nan,
    }


def stats_cell(value: float | int) -> str:
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float) and math.isfinite(value):
        return f"{value:.8g}"
    return "NA"


def first_common_values(
    py_rows: list[dict[str, str]],
    web_rows: list[dict[str, str]],
    key_fields: list[str],
    field: str,
) -> tuple[str, str]:
    py_by_key, web_by_key, common = paired_by_keys(py_rows, web_rows, key_fields)
    if not common:
        return "", ""
    key = common[0]
    return py_by_key[key].get(field, ""), web_by_key[key].get(field, "")


def top_numeric_differences(
    py_rows: list[dict[str, str]],
    web_rows: list[dict[str, str]],
    key_fields: list[str],
    field: str,
    limit: int = 10,
) -> list[tuple[str, float, str, str]]:
    py_by_key, web_by_key, common = paired_by_keys(py_rows, web_rows, key_fields)
    rows: list[tuple[str, float, str, str]] = []
    for key in common:
        py_raw = py_by_key[key].get(field, "")
        web_raw = web_by_key[key].get(field, "")
        py_val = as_float(py_raw)
        web_val = as_float(web_raw)
        if math.isfinite(py_val) and math.isfinite(web_val):
            rows.append((key, abs(web_val - py_val), py_raw, web_raw))
    return sorted(rows, key=lambda item: item[1], reverse=True)[:limit]


def append_top_differences_table(
    report: list[str],
    title: str,
    rows: list[tuple[str, float, str, str]],
) -> None:
    report.append(title)
    if not rows:
        report.append("- no paired finite differences available")
        return
    report.append("| key | abs_diff | Python | Web |")
    report.append("|---|---:|---:|---:|")
    for key, diff, py_value, web_value in rows:
        report.append(f"| `{key}` | {diff:.8g} | `{py_value}` | `{web_value}` |")


def geometry_likely_consequence(field: str) -> str:
    if field in {"floor_source"}:
        return "geometry provenance differs before ROI/BG masks are built"
    if field in {"mouth_r", "floor_r", "cyl_r_bg", "mouth_r_geom", "floor_r_geom"}:
        return "sufficient to change ROI size, ROI pixel count, and inter-well BG exclusion"
    if field in {"mouth_cx", "mouth_cy", "floor_cx", "floor_cy", "shift_px"}:
        return "can shift selected ROI/BG pixels even if medians remain close"
    if field in {"local_pitch_px", "pitch_px"}:
        return "changes derived radius and background-cell projection"
    return "diagnostic/provenance field"


GEOMETRY_RECORD_FIELDS = [
    "mouth_cx",
    "mouth_cy",
    "floor_cx",
    "floor_cy",
    "mouth_r",
    "floor_r",
    "mouth_r_geom",
    "floor_r_geom",
    "cyl_r_bg",
    "local_pitch_px",
    "shift_px",
    "floor_source",
    "floor_shift_x",
    "floor_shift_y",
]


def json_value(value: str) -> float | str | None:
    text = str(value).strip()
    if text == "" or text.upper() in {"NA", "NAN", "NONE"}:
        return None
    numeric = as_float(text)
    if math.isfinite(numeric):
        return numeric
    return text


def json_numeric(value: str) -> float | None:
    numeric = as_float(str(value).strip())
    return numeric if math.isfinite(numeric) else None


def plate_geometry_key_values(rows: list[dict[str, str]]) -> dict[str, float | str | None]:
    out: dict[str, float | str | None] = {}
    for row in rows:
        key = row.get("key", row.get("Key", row.get("Field", ""))).strip()
        if not key:
            continue
        out[key] = json_value(row.get("value", row.get("Value", "")))
    return out


def geometry_fields_present(records: list[dict[str, object]]) -> list[str]:
    present: set[str] = set()
    for record in records:
        for field in GEOMETRY_RECORD_FIELDS:
            value = record.get(field)
            if value is not None and value != "":
                present.add(field)
    return [field for field in GEOMETRY_RECORD_FIELDS if field in present]


def canonical_geometry_from_diagnostics(label: str, source_zip: Path, diagnostics: Workbook) -> dict[str, object]:
    qc_rows = rows_as_dicts(diagnostics.sheets.get("05_GEOMETRY_QC", []))
    bottom_rows = rows_as_dicts(diagnostics.sheets.get("06_WELL_BOTTOM", []))
    plate_rows = rows_as_dicts(diagnostics.sheets.get("07_PLATE_GEOMETRY", []))
    qc_by_well = key_rows(qc_rows, ["Well"])
    bottom_by_well = key_rows(bottom_rows, ["Well"])
    wells = sorted(set(qc_by_well) | set(bottom_by_well))
    records: list[dict[str, object]] = []
    for well in wells:
        qc = qc_by_well.get(well, {})
        bottom = bottom_by_well.get(well, {})
        mouth_cx = json_numeric(bottom.get("mouth_cx", ""))
        mouth_cy = json_numeric(bottom.get("mouth_cy", ""))
        floor_cx = json_numeric(bottom.get("floor_cx", ""))
        floor_cy = json_numeric(bottom.get("floor_cy", ""))
        record: dict[str, object] = {
            "Well": well,
            "mouth_cx": mouth_cx,
            "mouth_cy": mouth_cy,
            "floor_cx": floor_cx,
            "floor_cy": floor_cy,
            "mouth_r": json_numeric(bottom.get("mouth_r", qc.get("mouth_r", ""))),
            "floor_r": json_numeric(bottom.get("floor_r", qc.get("floor_r", ""))),
            "mouth_r_geom": json_numeric(bottom.get("mouth_r_geom", "")),
            "floor_r_geom": json_numeric(bottom.get("floor_r_geom", "")),
            "cyl_r_bg": json_numeric(bottom.get("cyl_r_bg", "")),
            "local_pitch_px": json_numeric(bottom.get("local_pitch_px", qc.get("local_pitch_px", ""))),
            "shift_px": json_numeric(bottom.get("shift_px", qc.get("shift_px", ""))),
            "floor_source": json_value(qc.get("floor_source", bottom.get("floor_source", ""))),
        }
        if mouth_cx is not None and floor_cx is not None:
            record["floor_shift_x"] = floor_cx - mouth_cx
        else:
            record["floor_shift_x"] = None
        if mouth_cy is not None and floor_cy is not None:
            record["floor_shift_y"] = floor_cy - mouth_cy
        else:
            record["floor_shift_y"] = None
        record["source_fields_available"] = {
            "05_GEOMETRY_QC": sorted([key for key, value in qc.items() if str(value).strip() != ""]),
            "06_WELL_BOTTOM": sorted([key for key, value in bottom.items() if str(value).strip() != ""]),
        }
        records.append(record)
    return {
        "schema": "tipica-shared-geometry-canonical-v1",
        "source": label,
        "source_zip": str(source_zip),
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "source_sheets": ["05_GEOMETRY_QC", "06_WELL_BOTTOM", "07_PLATE_GEOMETRY"],
        "record_count": len(records),
        "fields_present": geometry_fields_present(records),
        "plate_geometry": plate_geometry_key_values(plate_rows),
        "records": records,
    }


def geometry_record_by_well(geometry: dict[str, object]) -> dict[str, dict[str, object]]:
    records = geometry.get("records", [])
    out: dict[str, dict[str, object]] = {}
    if not isinstance(records, list):
        return out
    for record in records:
        if not isinstance(record, dict):
            continue
        well = str(record.get("Well", "")).strip()
        if well:
            out[well] = record
    return out


def geometry_numeric_stat(py_records: dict[str, dict[str, object]], web_records: dict[str, dict[str, object]], field: str) -> dict[str, float | int]:
    diffs: list[float] = []
    signed: list[float] = []
    for well in sorted(set(py_records) & set(web_records)):
        py_value = py_records[well].get(field)
        web_value = web_records[well].get(field)
        if isinstance(py_value, (int, float)) and isinstance(web_value, (int, float)):
            delta = float(web_value) - float(py_value)
            diffs.append(abs(delta))
            signed.append(delta)
    return {
        "paired": len(diffs),
        "mean_abs": statistics.fmean(diffs) if diffs else math.nan,
        "median_abs": statistics.median(diffs) if diffs else math.nan,
        "max_abs": max(diffs) if diffs else math.nan,
        "signed_mean": statistics.fmean(signed) if signed else math.nan,
    }


def geometry_text_match(py_records: dict[str, dict[str, object]], web_records: dict[str, dict[str, object]], field: str) -> dict[str, int]:
    common = sorted(set(py_records) & set(web_records))
    matches = 0
    diffs = 0
    for well in common:
        if py_records[well].get(field) == web_records[well].get(field):
            matches += 1
        else:
            diffs += 1
    return {"paired": len(common), "matches": matches, "diffs": diffs}


def geometry_center_stats(py_records: dict[str, dict[str, object]], web_records: dict[str, dict[str, object]], prefix: str) -> dict[str, float | int]:
    distances: list[float] = []
    for well in sorted(set(py_records) & set(web_records)):
        py_x = py_records[well].get(f"{prefix}_cx")
        py_y = py_records[well].get(f"{prefix}_cy")
        web_x = web_records[well].get(f"{prefix}_cx")
        web_y = web_records[well].get(f"{prefix}_cy")
        if all(isinstance(value, (int, float)) for value in [py_x, py_y, web_x, web_y]):
            distances.append(math.hypot(float(web_x) - float(py_x), float(web_y) - float(py_y)))
    return {
        "paired": len(distances),
        "mean_distance": statistics.fmean(distances) if distances else math.nan,
        "max_distance": max(distances) if distances else math.nan,
    }


def geometry_stats_bundle(py_geometry: dict[str, object], web_geometry: dict[str, object]) -> dict[str, object]:
    py_records = geometry_record_by_well(py_geometry)
    web_records = geometry_record_by_well(web_geometry)
    common = sorted(set(py_records) & set(web_records))
    numeric_fields = [
        "mouth_r",
        "floor_r",
        "mouth_r_geom",
        "floor_r_geom",
        "cyl_r_bg",
        "local_pitch_px",
        "shift_px",
        "floor_shift_x",
        "floor_shift_y",
    ]
    return {
        "python_count": len(py_records),
        "web_count": len(web_records),
        "common_count": len(common),
        "missing_in_web": sorted(set(py_records) - set(web_records)),
        "extra_in_web": sorted(set(web_records) - set(py_records)),
        "mouth_center": geometry_center_stats(py_records, web_records, "mouth"),
        "floor_center": geometry_center_stats(py_records, web_records, "floor"),
        "numeric": {field: geometry_numeric_stat(py_records, web_records, field) for field in numeric_fields},
        "floor_source": geometry_text_match(py_records, web_records, "floor_source"),
    }


def top_geometry_differences(
    py_records: dict[str, dict[str, object]],
    web_records: dict[str, dict[str, object]],
    field: str,
    limit: int = 8,
) -> list[tuple[str, float, object, object]]:
    rows: list[tuple[str, float, object, object]] = []
    for well in sorted(set(py_records) & set(web_records)):
        py_value = py_records[well].get(field)
        web_value = web_records[well].get(field)
        if isinstance(py_value, (int, float)) and isinstance(web_value, (int, float)):
            rows.append((well, abs(float(web_value) - float(py_value)), py_value, web_value))
    return sorted(rows, key=lambda row: row[1], reverse=True)[:limit]


def shared_geometry_delta_report(py_geometry: dict[str, object], web_geometry: dict[str, object]) -> str:
    stats = geometry_stats_bundle(py_geometry, web_geometry)
    py_records = geometry_record_by_well(py_geometry)
    web_records = geometry_record_by_well(web_geometry)
    lines = [
        "# Shared Geometry Delta Report",
        "",
        f"Python source ZIP: `{py_geometry.get('source_zip', '')}`",
        f"Web source ZIP: `{web_geometry.get('source_zip', '')}`",
        "",
        "## Field Availability",
        f"- Python fields present: {py_geometry.get('fields_present', [])}",
        f"- Web fields present: {web_geometry.get('fields_present', [])}",
        f"- records: python={stats['python_count']}, web={stats['web_count']}, common={stats['common_count']}",
        f"- missing_in_web={stats['missing_in_web']}",
        f"- extra_in_web={stats['extra_in_web']}",
        "",
        "## Center Agreement",
    ]
    for label in ["mouth_center", "floor_center"]:
        center = stats[label]
        lines.append(
            f"- {label}: paired={center['paired']}, mean_distance={stats_cell(float(center['mean_distance']))}, max_distance={stats_cell(float(center['max_distance']))}"
        )
    lines.extend(["", "## Radius and Background Geometry"])
    for field in ["mouth_r", "floor_r", "mouth_r_geom", "floor_r_geom", "cyl_r_bg", "local_pitch_px", "shift_px"]:
        item = stats["numeric"][field]
        lines.append(
            f"- {field}: paired={item['paired']}, mean_abs={stats_cell(float(item['mean_abs']))}, max_abs={stats_cell(float(item['max_abs']))}, signed_mean={stats_cell(float(item['signed_mean']))}"
        )
    floor_source = stats["floor_source"]
    lines.append(f"- floor_source: paired={floor_source['paired']}, matches={floor_source['matches']}, diffs={floor_source['diffs']}")
    if "A1" in py_records and "A1" in web_records:
        lines.extend(["", "## A1 Snapshot", "| field | Python | Web |", "|---|---:|---:|"])
        for field in ["mouth_cx", "mouth_cy", "floor_cx", "floor_cy", "mouth_r", "floor_r", "cyl_r_bg", "floor_source"]:
            lines.append(f"| {field} | `{py_records['A1'].get(field)}` | `{web_records['A1'].get(field)}` |")
    lines.extend(["", "## Largest Differences"])
    for field in ["mouth_r", "floor_r", "cyl_r_bg"]:
        lines.append(f"### {field}")
        rows = top_geometry_differences(py_records, web_records, field)
        if not rows:
            lines.append("- no paired finite differences")
            continue
        lines.extend(["| Well | abs_diff | Python | Web |", "|---|---:|---:|---:|"])
        for well, diff, py_value, web_value in rows:
            lines.append(f"| {well} | {diff:.8g} | `{py_value}` | `{web_value}` |")
    lines.extend([
        "",
        "## Interpretation",
        "- Centers are evaluated independently from radii so the next milestone can separate placement parity from mask-size parity.",
        "- Radius and `cyl_r_bg` mismatches are sufficient to change ROI pixel counts and inter-well background exclusion before PAbs, fitting, or ranking code runs.",
        "- This report is diagnostic only; it does not modify extraction, calibration, fitting, ranking, C0, dilution, or load-order logic.",
    ])
    return "\n".join(lines) + "\n"


def write_shared_geometry_diagnostics(
    py_geometry: dict[str, object],
    web_geometry: dict[str, object],
    output_dir: Path,
) -> dict[str, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    py_path = output_dir / "python_geometry_canonical.json"
    web_path = output_dir / "web_geometry_current.json"
    report_path = output_dir / "geometry_delta_report.md"
    py_path.write_text(json.dumps(py_geometry, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    web_path.write_text(json.dumps(web_geometry, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    report_path.write_text(shared_geometry_delta_report(py_geometry, web_geometry), encoding="utf-8")
    return {"python": py_path, "web": web_path, "report": report_path}


def append_shared_geometry_parity_section(
    report: list[str],
    py_geometry: dict[str, object],
    web_geometry: dict[str, object],
    files: dict[str, Path],
) -> dict[str, object]:
    stats = geometry_stats_bundle(py_geometry, web_geometry)
    mouth_center = stats["mouth_center"]
    floor_center = stats["floor_center"]
    numeric = stats["numeric"]
    floor_source = stats["floor_source"]
    mouth_centers_match = float(mouth_center["max_distance"]) <= 1.0 if math.isfinite(float(mouth_center["max_distance"])) else False
    floor_centers_match = float(floor_center["max_distance"]) <= 1.0 if math.isfinite(float(floor_center["max_distance"])) else False
    mouth_r_matches = float(numeric["mouth_r"]["max_abs"]) <= 1e-6 if math.isfinite(float(numeric["mouth_r"]["max_abs"])) else False
    floor_r_matches = float(numeric["floor_r"]["max_abs"]) <= 1e-6 if math.isfinite(float(numeric["floor_r"]["max_abs"])) else False
    cyl_r_bg_matches = float(numeric["cyl_r_bg"]["max_abs"]) <= 1e-6 if math.isfinite(float(numeric["cyl_r_bg"]["max_abs"])) else False
    source_matches = int(floor_source["diffs"]) == 0
    web_plate_geometry = web_geometry.get("plate_geometry", {})
    web_override_active = False
    web_override_source = ""
    if isinstance(web_plate_geometry, dict):
        web_override_active = str(web_plate_geometry.get("shared_geometry_override_active", "")).strip() in {"1", "1.0", "true", "True", "TRUE"}
        web_override_source = str(web_plate_geometry.get("shared_geometry_override_source", "") or "")
    report.extend([
        "",
        "## Shared Geometry Parity Test",
        "- scope: diagnostic import/export comparison from DIAGNOSTICS workbook geometry sheets; no application runtime logic is changed by this helper.",
        f"- web shared-geometry override active: {web_override_active}",
        f"- web shared-geometry override source: `{web_override_source}`",
        f"- generated Python canonical geometry: `{files['python']}`",
        f"- generated web current geometry: `{files['web']}`",
        f"- generated geometry delta report: `{files['report']}`",
        f"- records: python={stats['python_count']}, web={stats['web_count']}, common={stats['common_count']}, missing_in_web={len(stats['missing_in_web'])}, extra_in_web={len(stats['extra_in_web'])}",
        f"- Python geometry fields available: {py_geometry.get('fields_present', [])}",
        f"- Web geometry fields available: {web_geometry.get('fields_present', [])}",
        f"- mouth centers: paired={mouth_center['paired']}, mean_distance={stats_cell(float(mouth_center['mean_distance']))}, max_distance={stats_cell(float(mouth_center['max_distance']))}, effective_match={mouth_centers_match}",
        f"- floor centers: paired={floor_center['paired']}, mean_distance={stats_cell(float(floor_center['mean_distance']))}, max_distance={stats_cell(float(floor_center['max_distance']))}, effective_match={floor_centers_match}",
        f"- mouth_r: mean_abs={stats_cell(float(numeric['mouth_r']['mean_abs']))}, max_abs={stats_cell(float(numeric['mouth_r']['max_abs']))}, match={mouth_r_matches}",
        f"- floor_r: mean_abs={stats_cell(float(numeric['floor_r']['mean_abs']))}, max_abs={stats_cell(float(numeric['floor_r']['max_abs']))}, match={floor_r_matches}",
        f"- cyl_r_bg: mean_abs={stats_cell(float(numeric['cyl_r_bg']['mean_abs']))}, max_abs={stats_cell(float(numeric['cyl_r_bg']['max_abs']))}, match={cyl_r_bg_matches}",
        f"- floor_source: paired={floor_source['paired']}, matches={floor_source['matches']}, diffs={floor_source['diffs']}, match={source_matches}",
        "- interpretation: center placement is much closer than radius/background geometry. The radius and `cyl_r_bg` deltas are large enough to explain ROI `n_used` differences and can plausibly drive MeanW/MeanBG drift before PAbs/fitting/ranking.",
        "- source semantics inspected: Python `roi_geometry.py` projects manual floor circles and reports `manual_D_projection`; web diagnostics currently report JSON-derived floor geometry and derive mouth/floor/background radii through web geometry/background helpers.",
    ])
    if not web_override_active:
        report.extend([
            "",
            "## Shared Geometry Next Step",
            "- implement a developer-only shared-geometry import/override path, using `python_geometry_canonical.json` as the source, so the web extraction can be rerun with Python centers/radii/background exclusion geometry before changing any scoring, fitting, PAbs, C0, dilution, or marker logic.",
            "- current limitation: the existing exported web project/geometry path cannot by itself force Python-equivalent per-well `mouth_r`, `floor_r`, `floor_r_geom`, and `cyl_r_bg` values, so a true shared-geometry run is not yet available without code support.",
        ])
    return stats


def shared_geometry_override_active(geometry: dict[str, object]) -> bool:
    plate_geometry = geometry.get("plate_geometry", {})
    if not isinstance(plate_geometry, dict):
        return False
    raw_value = plate_geometry.get("shared_geometry_override_active", plate_geometry.get("SharedGeometryOverrideActive", plate_geometry.get("shared_geometry_override", "")))
    if raw_value is None:
        return False
    return str(raw_value).strip().lower() in {"1", "1.0", "true", "yes", "y"}


def shared_geometry_override_source(geometry: dict[str, object]) -> str:
    plate_geometry = geometry.get("plate_geometry", {})
    if not isinstance(plate_geometry, dict):
        return ""
    return str(plate_geometry.get("shared_geometry_override_source", plate_geometry.get("SharedGeometryOverrideSource", "")) or "").strip()


def shared_geometry_fit_input_summary(py_report: Workbook, web_report: Workbook) -> dict[str, object]:
    py_rep = rows_as_dicts(py_report.sheets.get("05_REPLICATES_MEAN", []))
    web_rep = rows_as_dicts(web_report.sheets.get("05_REPLICATES_MEAN", []))
    py_fit = rows_as_dicts(py_report.sheets.get("06_FITTING", []))
    web_fit = rows_as_dicts(web_report.sheets.get("06_FITTING", []))
    py_by_fit = {fit_key(row): row for row in py_fit}
    web_by_fit = {fit_key(row): row for row in web_fit}
    common = sorted(set(py_by_fit) & set(web_by_fit))
    x_match_count = 0
    y_diff_max: list[float] = []
    for key in common:
        py_points = replicate_fit_points(py_rep, py_by_fit[key])
        web_points = replicate_fit_points(web_rep, web_by_fit[key])
        if py_points and web_points and len(py_points) == len(web_points) and [x for x, _ in py_points] == [x for x, _ in web_points]:
            x_match_count += 1
        y_diffs = [abs(py_points[index][1] - web_points[index][1]) for index in range(min(len(py_points), len(web_points))) if py_points[index][0] == web_points[index][0]]
        if y_diffs:
            y_diff_max.append(max(y_diffs))
    return {
        "common_fit_rows": len(common),
        "missing_in_web": len(set(py_by_fit) - set(web_by_fit)),
        "extra_in_web": len(set(web_by_fit) - set(py_by_fit)),
        "x_match_count": x_match_count,
        "y_diff_max_abs": max(y_diff_max) if y_diff_max else math.nan,
        "y_diff_mean_abs": statistics.fmean(y_diff_max) if y_diff_max else math.nan,
    }


def shared_geometry_override_wells(geometry: dict[str, object]) -> str:
    plate_geometry = geometry.get("plate_geometry", {})
    if not isinstance(plate_geometry, dict):
        return ""
    raw_value = plate_geometry.get("shared_geometry_override_wells", plate_geometry.get("SharedGeometryOverrideWells", ""))
    if raw_value is None:
        return ""
    if isinstance(raw_value, (int, float)) and float(raw_value).is_integer():
        return str(int(raw_value))
    return str(raw_value).strip()


def append_roi_mask_inclusion_parity_audit(
    report: list[str],
    py_diag: Workbook,
    web_diag: Workbook,
) -> None:
    py_stats = rows_as_dicts(py_diag.sheets.get("04_WELL_ROBUST_STATS", []))
    web_stats = rows_as_dicts(web_diag.sheets.get("04_WELL_ROBUST_STATS", []))

    report.extend(["", "## ROI Mask/Inclusion Parity Audit"])
    report.append("- scope: inspect ROI inclusion semantics using the exported robust-stat rows only; no runtime logic is changed by this diagnostic section.")
    report.append("- objective: separate whether remaining residuals come from full-mask inclusion, core-pixel erosion, or used-pixel trimming after shared geometry is already matched.")

    for label, field in [
        ("n_roi", "n_roi"),
        ("n_core", "n_core"),
        ("n_used", "n_used"),
        ("used_fraction", "used_fraction"),
        ("highlight_fraction_roi", "highlight_fraction_roi"),
        ("highlight_fraction_core", "highlight_fraction_core"),
    ]:
        stats = field_diff_stats(py_stats, web_stats, ["Well"], field)
        report.append(f"- {label}: paired={stats['paired']}, mean_abs={stats_cell(stats['mean_abs'])}, max_abs={stats_cell(stats['max_abs'])}, signed_mean={stats_cell(stats['signed_mean'])}")

    report.append("- interpretation: nonzero `n_roi`/`n_core`/`n_used` deltas point to mask construction or inclusion-filtering differences; nonzero `used_fraction` deltas suggest different trimming or robust-pixel selection even when the mask footprint is similar.")
    append_top_differences_table(report, "- worst ROI wells by `n_used` difference:", top_numeric_differences(py_stats, web_stats, ["Well"], "n_used", 5))
    append_top_differences_table(report, "- worst ROI wells by `used_fraction` difference:", top_numeric_differences(py_stats, web_stats, ["Well"], "used_fraction", 5))
    report.append("- source-code note: the current web ROI path samples circular or mouth/floor-intersection masks and then applies robust trimming/erosion heuristics before producing the exported statistics; this can change `n_used` and `used_fraction` without altering sheet geometry centers/radii.")
    report.append("- next action if this audit is confirmed: compare the exact pixel-coordinate lists exported by the web path with the Python ROI mask semantics, then decide whether the mismatch is a benign reporting difference or a low-risk inclusion fix.")


def append_shared_geometry_residual_source_audit(
    report: list[str],
    py_report: Workbook,
    web_report: Workbook,
    py_diag: Workbook,
    web_diag: Workbook,
) -> None:
    py_stats = rows_as_dicts(py_diag.sheets.get("04_WELL_ROBUST_STATS", []))
    web_stats = rows_as_dicts(web_diag.sheets.get("04_WELL_ROBUST_STATS", []))
    py_bg = rows_as_dicts(py_diag.sheets.get("02_BG_SAMPLES", []))
    web_bg = rows_as_dicts(web_diag.sheets.get("02_BG_SAMPLES", []))
    py_raw = rows_as_dicts(py_report.sheets.get("04_RAW", []))
    web_raw = rows_as_dicts(web_report.sheets.get("04_RAW", []))
    py_cielab = rows_as_dicts(py_report.sheets.get("04_RAW", []))
    web_cielab = rows_as_dicts(web_report.sheets.get("04_RAW", []))
    py_fit = rows_as_dicts(py_report.sheets.get("06_FITTING", []))
    web_fit = rows_as_dicts(web_report.sheets.get("06_FITTING", []))

    report.extend(["", "## Shared-Geometry Residual Source Audit"])
    report.append("- goal: separate which residual family remains after geometry override parity is already active, using the exported workbook rows instead of inventing new values.")

    report.extend(["### ROI mask residuals under matched geometry"])
    roi_n_used = field_diff_stats(py_stats, web_stats, ["Well"], "n_used")
    roi_used_fraction = field_diff_stats(py_stats, web_stats, ["Well"], "used_fraction")
    roi_rgb = [field_diff_stats(py_stats, web_stats, ["Well"], field) for field in ["Red_median", "Green_median", "Blue_median"]]
    max_rgb = max((float(item["max_abs"]) for item in roi_rgb if math.isfinite(float(item["max_abs"]))), default=math.nan)
    report.append(f"- ROI summary: n_used max_abs={stats_cell(roi_n_used['max_abs'])}, used_fraction max_abs={stats_cell(roi_used_fraction['max_abs'])}, RGB_median max_abs={stats_cell(max_rgb)}")
    append_top_differences_table(report, "- worst ROI wells by `n_used` difference:", top_numeric_differences(py_stats, web_stats, ["Well"], "n_used", 5))
    report.append("- interpretation: once shared geometry is matched, nonzero ROI counts and retained-fraction deltas still point to mask-selection or filtering differences rather than geometric placement itself.")

    report.extend(["### BG mask/model residuals under matched geometry"])
    bg_area = field_diff_stats(py_bg, web_bg, ["BG_Cell_Row", "BG_Cell_Col"], "area")
    bg_rgb = [field_diff_stats(py_bg, web_bg, ["BG_Cell_Row", "BG_Cell_Col"], field) for field in ["Red_median_raw", "Green_median_raw", "Blue_median_raw"]]
    max_bg_rgb = max((float(item["max_abs"]) for item in bg_rgb if math.isfinite(float(item["max_abs"]))), default=math.nan)
    report.append(f"- BG summary: area max_abs={stats_cell(bg_area['max_abs'])}, RGB_median max_abs={stats_cell(max_bg_rgb)}")
    append_top_differences_table(report, "- worst BG samples by area difference:", top_numeric_differences(py_bg, web_bg, ["BG_Cell_Row", "BG_Cell_Col"], "area", 5))
    report.append("- interpretation: the remaining BG residuals are consistent with mask-area or sampled-pixel selection differences rather than a shared-geometry placement issue.")

    report.extend(["### MeanW / MeanBG / PAbs causality bridge"])
    for label in CHANNEL_LABELS:
        meanw_stats = field_diff_stats(py_raw, web_raw, ["Well"], f"MeanW_{label}")
        meanbg_stats = field_diff_stats(py_raw, web_raw, ["Well"], f"MeanBG_{label}")
        pabs_stats = field_diff_stats(py_raw, web_raw, ["Well"], f"PAbs_{label}")
        report.append(f"- {label}: MeanW max_abs={stats_cell(meanw_stats['max_abs'])}, MeanBG max_abs={stats_cell(meanbg_stats['max_abs'])}, PAbs max_abs={stats_cell(pabs_stats['max_abs'])}")
    py_pabs_summaries = {label: pabs_formula_summary(py_raw, label) for label in CHANNEL_LABELS}
    web_pabs_summaries = {label: pabs_formula_summary(web_raw, label) for label in CHANNEL_LABELS}
    for label in CHANNEL_LABELS:
        report.append(f"- PAbs_{label}: python_formula={py_pabs_summaries[label].status}, web_formula={web_pabs_summaries[label].status}, max_abs_residual={stats_cell(web_pabs_summaries[label].max_abs_residual)}")
    report.append("- interpretation: when MeanW/MeanBG differ and PAbs residuals remain, the residual chain is upstream extraction -> PAbs reconstruction -> fit-input y, not a pure geometry parity issue.")

    report.extend(["### PAbs correction traceability"])
    correction_values = {"S0_applied": [], "ClipDelta": []}
    for row in web_fit:
        if row.get("Channel", "") in {pabs_method_name(label) for label in CHANNEL_LABELS}:
            for field in correction_values:
                value = as_float(row.get(field, ""))
                if math.isfinite(value) and abs(value) > 1e-12:
                    correction_values[field].append(value)
    report.append(f"- low-signal correction evidence in web fit rows: S0_applied count={len(correction_values['S0_applied'])}, ClipDelta count={len(correction_values['ClipDelta'])}; examples={correction_values['S0_applied'][:3]} / {correction_values['ClipDelta'][:3]}")
    report.append("- interpretation: exported raw MeanW/MeanBG are insufficient to prove corrected PAbs values end-to-end, so the remaining residual can be a correction-traceability gap as well as a raw-input mismatch.")

    report.extend(["### CIELAB residual interpretation"])
    for field in ["L", "a", "b", "DeltaE_ab", "DeltaE_ab_chroma"]:
        stats = field_diff_stats(py_cielab, web_cielab, ["Well"], field)
        report.append(f"- {field}: paired={stats['paired']}, mean_abs={stats_cell(stats['mean_abs'])}, max_abs={stats_cell(stats['max_abs'])}")
    report.append("- interpretation: CIELAB residuals remain downstream of extraction and conversion semantics; current workbook data do not isolate whether the residual is RGB extraction, reference conversion, or naming/reporting.")

    report.extend(["### Fit-input residual chain"])
    fit_summary = shared_geometry_fit_input_summary(py_report, web_report)
    report.append(f"- fit rows common={fit_summary['common_fit_rows']}, missing_in_web={fit_summary['missing_in_web']}, extra_in_web={fit_summary['extra_in_web']}, x_match_count={fit_summary['x_match_count']}, y_diff_max_abs={stats_cell(float(fit_summary['y_diff_max_abs']))}, y_diff_mean_abs={stats_cell(float(fit_summary['y_diff_mean_abs']))}")
    report.append("- interpretation: fit-input y-values still differ even when row keys match, so the remaining ranking residual is plausibly downstream of upstream extracted values rather than a regression-formula mismatch.")

    report.extend(["### Source-Code Residual Hypotheses"])
    report.append("- Python source hypothesis: `_compute_well_robust_statistics`/`_extract_bg_samples` and `_build_raw_report_rows` establish the ROI/BG/PAbs pipeline, while the web path uses display/corrected values and low-signal correction metadata before fitting and ranking.")
    report.append("- web source hypothesis: `buildReportRawRows` and `buildCielabDiagnosticPoints` can diverge from Python semantics in ROI filtering, BG sampling, PAbs correction traceability, and CIELAB reference selection even when geometry override is active.")
    report.append("- practical next step: compare the exported intermediate rows for ROI pixels, BG samples, raw PAbs inputs, corrected PAbs intermediates, and fit-input y values side by side; the current report only exposes the residual symptoms, not the exact source rows.")


def append_next_corrective_target_decision(
    report: list[str],
    py_report: Workbook,
    web_report: Workbook,
    py_diag: Workbook,
    web_diag: Workbook,
) -> None:
    py_stats = rows_as_dicts(py_diag.sheets.get("04_WELL_ROBUST_STATS", []))
    web_stats = rows_as_dicts(web_diag.sheets.get("04_WELL_ROBUST_STATS", []))
    py_bg = rows_as_dicts(py_diag.sheets.get("02_BG_SAMPLES", []))
    web_bg = rows_as_dicts(web_diag.sheets.get("02_BG_SAMPLES", []))
    py_raw = rows_as_dicts(py_report.sheets.get("04_RAW", []))
    web_raw = rows_as_dicts(web_report.sheets.get("04_RAW", []))
    py_cielab = rows_as_dicts(py_report.sheets.get("04_RAW", []))
    web_cielab = rows_as_dicts(web_report.sheets.get("04_RAW", []))
    fit_summary = shared_geometry_fit_input_summary(py_report, web_report)

    roi_n_used = field_diff_stats(py_stats, web_stats, ["Well"], "n_used")
    roi_used_fraction = field_diff_stats(py_stats, web_stats, ["Well"], "used_fraction")
    roi_rgb = [field_diff_stats(py_stats, web_stats, ["Well"], field) for field in ["Red_median", "Green_median", "Blue_median"]]
    roi_rgb_max = max((float(item["max_abs"]) for item in roi_rgb if math.isfinite(float(item["max_abs"]))), default=math.nan)
    bg_area = field_diff_stats(py_bg, web_bg, ["BG_Cell_Row", "BG_Cell_Col"], "area")
    bg_rgb = [field_diff_stats(py_bg, web_bg, ["BG_Cell_Row", "BG_Cell_Col"], field) for field in ["Red_median_raw", "Green_median_raw", "Blue_median_raw"]]
    bg_rgb_max = max((float(item["max_abs"]) for item in bg_rgb if math.isfinite(float(item["max_abs"]))), default=math.nan)
    pabs_summaries = {label: pabs_formula_summary(web_raw, label) for label in CHANNEL_LABELS}
    pabs_warn_count = sum(1 for summary in pabs_summaries.values() if summary.status == "WARN")
    pabs_pass_count = sum(1 for summary in pabs_summaries.values() if summary.status == "PASS")

    report.extend(["", "## Next Corrective Target Decision"])
    report.append("- first corrective target: ROI mask/inclusion parity under shared geometry.")
    report.append("- second corrective target: BG mask/model parity under shared geometry.")
    report.append("- diagnostic-only target: PAbs correction traceability/export and CIELAB conversion/reference parity.")
    report.append("- not currently first cause: fit regression/score formula, geometry/radii override behavior, and selected-method naming.")
    report.append("- reason: shared-geometry geometry/radii now match exactly, so the next scientific correction should attack the pixel-inclusion path that still changes ROI/BG inputs before MeanW/MeanBG/PAbs/fit-input y-values are formed.")
    report.append(f"- evidence: ROI n_used max_abs={stats_cell(roi_n_used['max_abs'])}, used_fraction max_abs={stats_cell(roi_used_fraction['max_abs'])}, RGB_median max_abs={stats_cell(roi_rgb_max)}; BG area max_abs={stats_cell(bg_area['max_abs'])}, RGB_median max_abs={stats_cell(bg_rgb_max)}")
    report.append("- evidence: MeanW/MeanBG/PAbs remain nonzero after shared geometry, and the current report shows PAbs reconstruction PASS/WARN rather than a clean pass across all channels.")
    report.append(f"- evidence: fit-input y residuals remain present with common rows={fit_summary['common_fit_rows']}, x_match_count={fit_summary['x_match_count']}, y_diff_max_abs={stats_cell(float(fit_summary['y_diff_max_abs']))}, y_diff_mean_abs={stats_cell(float(fit_summary['y_diff_mean_abs']))}")
    report.append(f"- evidence: PAbs reconstruction status counts are pass={pabs_pass_count}, warn={pabs_warn_count}; CIELAB residuals remain downstream of extraction/conversion and are not the first target.")
    report.append("- what not to change yet: no runtime app logic, no score/fitting/PAbs formula/C0/dilution/geometry override/workbook schema changes.")
    report.extend(["### Proposed Next Milestone"])
    report.append("- 36W-N — ROI mask/inclusion parity under shared geometry")
    report.append("- follow-up: 36W-O — BG mask/model parity under shared geometry")


def append_shared_geometry_override_residual_audit(
    report: list[str],
    py_report: Workbook,
    web_report: Workbook,
    py_diag: Workbook,
    web_diag: Workbook,
    py_geometry: dict[str, object],
    web_geometry: dict[str, object],
) -> None:
    if not (shared_geometry_override_active(py_geometry) or shared_geometry_override_active(web_geometry)):
        return

    py_override = shared_geometry_override_active(py_geometry)
    web_override = shared_geometry_override_active(web_geometry)
    source = shared_geometry_override_source(web_geometry) or shared_geometry_override_source(py_geometry)
    wells = shared_geometry_override_wells(web_geometry) or shared_geometry_override_wells(py_geometry)

    report.extend(["", "## Shared-Geometry Override Residual Audit"])
    report.append(f"- shared-geometry override active: python={py_override}, web={web_override}")
    report.append(f"- shared-geometry override source: `{source}`")
    if wells:
        report.append(f"- shared-geometry override wells: {wells}")
    report.append("- scope: compare residual extraction and downstream numeric fields after shared-geometry override geometry is active.")
    append_shared_geometry_residual_source_audit(report, py_report, web_report, py_diag, web_diag)
    append_roi_mask_inclusion_parity_audit(report, py_diag, web_diag)
    append_next_corrective_target_decision(report, py_report, web_report, py_diag, web_diag)

    py_stats = rows_as_dicts(py_diag.sheets.get("04_WELL_ROBUST_STATS", []))
    web_stats = rows_as_dicts(web_diag.sheets.get("04_WELL_ROBUST_STATS", []))
    py_bg = rows_as_dicts(py_diag.sheets.get("02_BG_SAMPLES", []))
    web_bg = rows_as_dicts(web_diag.sheets.get("02_BG_SAMPLES", []))
    py_raw = rows_as_dicts(py_report.sheets.get("04_RAW", []))
    web_raw = rows_as_dicts(web_report.sheets.get("04_RAW", []))
    py_cielab = rows_as_dicts(py_diag.sheets.get("11_CIELAB_FITTING", []))
    web_cielab = rows_as_dicts(web_diag.sheets.get("11_CIELAB_FITTING", []))
    py_cmp = rows_as_dicts(py_report.sheets.get("07_METHOD_COMPARISON", []))
    web_cmp = rows_as_dicts(web_report.sheets.get("07_METHOD_COMPARISON", []))
    web_fit = rows_as_dicts(web_report.sheets.get("06_FITTING", []))

    py_roi_by_key = key_rows(py_stats, ["Well"])
    web_roi_by_key = key_rows(web_stats, ["Well"])
    common_roi = sorted(set(py_roi_by_key) & set(web_roi_by_key))
    report.append(
        f"- ROI stats keys: python={len(py_roi_by_key)}, web={len(web_roi_by_key)}, common={len(common_roi)}, "
        f"missing_in_web={len(set(py_roi_by_key) - set(web_roi_by_key))}, extra_in_web={len(set(web_roi_by_key) - set(py_roi_by_key))}"
    )
    for label, field in [
        ("ROI n_used", "n_used"),
        ("ROI used_fraction", "used_fraction"),
        ("ROI Red median", "Red_median"),
        ("ROI Green median", "Green_median"),
        ("ROI Blue median", "Blue_median"),
    ]:
        stats = field_diff_stats(py_stats, web_stats, ["Well"], field)
        report.append(f"- {label}: paired={stats['paired']}, mean_abs={stats_cell(stats['mean_abs'])}, max_abs={stats_cell(stats['max_abs'])}")

    py_bg_by_key = key_rows(py_bg, ["BG_Cell_Row", "BG_Cell_Col"])
    web_bg_by_key = key_rows(web_bg, ["BG_Cell_Row", "BG_Cell_Col"])
    common_bg = sorted(set(py_bg_by_key) & set(web_bg_by_key))
    report.append(
        f"- BG sample keys: python={len(py_bg_by_key)}, web={len(web_bg_by_key)}, common={len(common_bg)}, "
        f"missing_in_web={len(set(py_bg_by_key) - set(web_bg_by_key))}, extra_in_web={len(set(web_bg_by_key) - set(py_bg_by_key))}"
    )
    for label, field in [
        ("BG Red median raw", "Red_median_raw"),
        ("BG Green median raw", "Green_median_raw"),
        ("BG Blue median raw", "Blue_median_raw"),
        ("BG area", "area"),
    ]:
        stats = field_diff_stats(py_bg, web_bg, ["BG_Cell_Row", "BG_Cell_Col"], field)
        report.append(f"- {label}: paired={stats['paired']}, mean_abs={stats_cell(stats['mean_abs'])}, max_abs={stats_cell(stats['max_abs'])}")

    report.append("- BG sample count diagnostics are especially useful when web `Web_Sampled_Final_Accepted_Pixels` is present, because it separates mask area from sampled model pixels.")
    if any("Web_Sampled_Final_Accepted_Pixels" in row for row in web_bg):
        report.append("- web BG sampled-pixel counters exist; compare these to Python `area` and web full-resolution area to distinguish mask-area mismatch from sample-selection mismatch.")

    report.extend(["", "## Shared-Geometry Selection Result"])
    for label in CHANNEL_LABELS:
        meanw_stats = field_diff_stats(py_raw, web_raw, ["Well"], f"MeanW_{label}")
        meanbg_stats = field_diff_stats(py_raw, web_raw, ["Well"], f"MeanBG_{label}")
        pabs_stats = field_diff_stats(py_raw, web_raw, ["Well"], f"PAbs_{label}")
        report.append(
            f"- {label}: MeanW max_abs={stats_cell(meanw_stats['max_abs'])}, "
            f"MeanBG max_abs={stats_cell(meanbg_stats['max_abs'])}, "
            f"PAbs max_abs={stats_cell(pabs_stats['max_abs'])}"
        )
    py_pabs_summaries = {label: pabs_formula_summary(py_raw, label) for label in CHANNEL_LABELS}
    web_pabs_summaries = {label: pabs_formula_summary(web_raw, label) for label in CHANNEL_LABELS}
    for label in CHANNEL_LABELS:
        py_status = py_pabs_summaries[label].status
        web_status = web_pabs_summaries[label].status
        report.append(
            f"- PAbs_{label}: python_formula={py_status}, web_formula={web_status}, "
            f"web_source={web_pabs_summaries[label].source}, "
            f"max_abs_residual={stats_cell(web_pabs_summaries[label].max_abs_residual)}"
        )

    correction_values = {
        "S0_applied": [],
        "ClipDelta": [],
    }
    for row in web_fit:
        if row.get("Channel", "") in {pabs_method_name(label) for label in CHANNEL_LABELS}:
            for field in correction_values:
                value = as_float(row.get(field, ""))
                if math.isfinite(value) and abs(value) > 1e-12:
                    correction_values[field].append(value)
    report.append(
        f"- low-signal correction evidence: S0_applied count={len(correction_values['S0_applied'])}, "
        f"ClipDelta count={len(correction_values['ClipDelta'])}, "
        f"examples S0={correction_values['S0_applied'][:3]}, ClipDelta={correction_values['ClipDelta'][:3]}"
    )

    report.extend(["", "## Residual Blocker After Shared Geometry"])
    py_red_stats = field_diff_stats(py_stats, web_stats, ["Well"], "Red_median")
    py_green_stats = field_diff_stats(py_stats, web_stats, ["Well"], "Green_median")
    py_blue_stats = field_diff_stats(py_stats, web_stats, ["Well"], "Blue_median")
    max_rgb_median = max(py_red_stats["max_abs"], py_green_stats["max_abs"], py_blue_stats["max_abs"])
    n_used_stats = field_diff_stats(py_stats, web_stats, ["Well"], "n_used")
    used_fraction_stats = field_diff_stats(py_stats, web_stats, ["Well"], "used_fraction")
    report.append(f"- ROI residuals: n_used max_abs={stats_cell(n_used_stats['max_abs'])}, used_fraction max_abs={stats_cell(used_fraction_stats['max_abs'])}, RGB max_abs={stats_cell(max_rgb_median)}")

    for label in ["L", "a", "b", "DeltaE_ab", "DeltaE_ab_chroma"]:
        stats = field_diff_stats(py_cielab, web_cielab, ["Channel", "FitType", "ID", "DF"], label)
        report.append(f"- CIELAB {label}: paired={stats['paired']}, mean_abs={stats_cell(stats['mean_abs'])}, max_abs={stats_cell(stats['max_abs'])}")

    selected_py = next((row.get("Method", "") for row in py_cmp if str(row.get("Selected", "")).strip().lower() in {"1", "1.0", "true", "yes"}), "")
    selected_web = next((row.get("Method", "") for row in web_cmp if str(row.get("Selected", "")).strip().lower() in {"1", "1.0", "true", "yes"}), "")
    report.append(f"- selected method: Python=`{selected_py}`, Web=`{selected_web}`, canonical_match={canonical_method_name(selected_py) == canonical_method_name(selected_web)}")

    if all(math.isfinite(float(stats["max_abs"])) and float(stats["max_abs"]) == 0 for stats in [
        field_diff_stats(py_stats, web_stats, ["Well"], "n_used"),
        field_diff_stats(py_stats, web_stats, ["Well"], "used_fraction"),
        field_diff_stats(py_raw, web_raw, ["Well"], "MeanW_Red"),
        field_diff_stats(py_raw, web_raw, ["Well"], "MeanW_Green"),
        field_diff_stats(py_raw, web_raw, ["Well"], "MeanW_Blue"),
    ]):
        report.append("- first residual blocker after shared geometry: multiparameter downstream fit-input or PAbs/CieLab residual parity, not geometry/radii.")
    else:
        report.append("- first residual blocker after shared geometry: upstream ROI/BG/fitting input parity (mask selection, filtering, or PAbs correction traceability).")

    fit_summary = shared_geometry_fit_input_summary(py_report, web_report)
    report.append(
        f"- fit input rows common={fit_summary['common_fit_rows']}, "
        f"missing_in_web={fit_summary['missing_in_web']}, extra_in_web={fit_summary['extra_in_web']}, "
        f"x_match_count={fit_summary['x_match_count']}, "
        f"y_diff_max_abs={stats_cell(float(fit_summary['y_diff_max_abs']))}, "
        f"y_diff_mean_abs={stats_cell(float(fit_summary['y_diff_mean_abs']))}"
    )

    py_cmp_by_method = method_rows_by_canonical_key(py_cmp)
    web_cmp_by_method = method_rows_by_canonical_key(web_cmp)
    common_methods = sorted(set(py_cmp_by_method) & set(web_cmp_by_method))
    missing_methods = sorted(set(py_cmp_by_method) - set(web_cmp_by_method))
    extra_methods = sorted(set(web_cmp_by_method) - set(py_cmp_by_method))
    alias_pairs = [
        (py_cmp_by_method[key].get("Method", ""), web_cmp_by_method[key].get("Method", ""))
        for key in common_methods
        if has_method_alias_difference(py_cmp_by_method[key], web_cmp_by_method[key])
    ]
    score_diff_rows: list[tuple[str, list[str]]] = []
    for key in common_methods:
        py_row = py_cmp_by_method[key]
        web_row = web_cmp_by_method[key]
        score_fields = numeric_field_diffs(py_row, web_row, ["Score", "BaseScore"], tolerance=1e-8)
        if score_fields:
            score_diff_rows.append((key, score_fields))
    report.append(f"- score/base score mismatches: count={len(score_diff_rows)}")
    for key, fields in score_diff_rows[:5]:
        report.append(f"  - `{key}` score fields differ: {fields}")
    report.append("- interpretation: under active shared-geometry override, remaining ROI/BG/MeanW/MeanBG/PAbs/CIELAB/fit-input residuals indicate whether the override application was complete or whether downstream correction/selection semantics still differ.")


def append_geometry_provenance_audit(report: list[str], py_diag: Workbook, web_diag: Workbook) -> dict[str, float]:
    py_qc = rows_as_dicts(py_diag.sheets.get("05_GEOMETRY_QC", []))
    web_qc = rows_as_dicts(web_diag.sheets.get("05_GEOMETRY_QC", []))
    py_bottom = rows_as_dicts(py_diag.sheets.get("06_WELL_BOTTOM", []))
    web_bottom = rows_as_dicts(web_diag.sheets.get("06_WELL_BOTTOM", []))
    py_plate = rows_as_dicts(py_diag.sheets.get("07_PLATE_GEOMETRY", []))
    web_plate = rows_as_dicts(web_diag.sheets.get("07_PLATE_GEOMETRY", []))
    report.extend(["### 1. Geometry"])
    report.append("- keys compared: `Well` for 05_GEOMETRY_QC and 06_WELL_BOTTOM; reported key/value rows for 07_PLATE_GEOMETRY when present.")
    report.append("- source audit: Python `reference_python/roi_geometry.py` computes `floor_source='manual_D_projection'` when manual D floor circles are provided, with mouth/floor masks from mouth-floor intersection; web current ZIP reports JSON-derived geometry provenance.")
    report.append("| field | mean_abs | max_abs | first-row Python | first-row Web | likely consequence |")
    report.append("|---|---:|---:|---|---|---|")
    fields = [
        ("floor_source", "floor_source", py_qc, web_qc),
        ("pitch_px", "local_pitch_px", py_qc, web_qc),
        ("mouth_r", "mouth_r", py_qc, web_qc),
        ("floor_r", "floor_r", py_qc, web_qc),
        ("shift_px", "shift_px", py_qc, web_qc),
        ("mouth_to_floor_ratio", "shift_frac_of_mouth_r", py_qc, web_qc),
        ("floor_to_mouth_ratio", "floor_to_mouth_r_ratio", py_qc, web_qc),
        ("local_pitch_px", "local_pitch_px", py_bottom, web_bottom),
        ("cyl_r_bg", "cyl_r_bg", py_bottom, web_bottom),
        ("mouth_cx", "mouth_cx", py_bottom, web_bottom),
        ("mouth_cy", "mouth_cy", py_bottom, web_bottom),
        ("floor_cx", "floor_cx", py_bottom, web_bottom),
        ("floor_cy", "floor_cy", py_bottom, web_bottom),
        ("mouth_r_geom", "mouth_r_geom", py_bottom, web_bottom),
        ("floor_r_geom", "floor_r_geom", py_bottom, web_bottom),
    ]
    metrics: dict[str, float] = {}
    for label, field, py_rows, web_rows in fields:
        py_first, web_first = first_common_values(py_rows, web_rows, ["Well"], field)
        if field == "floor_source":
            mean_abs = math.nan
            max_abs = math.nan
        else:
            stats = field_diff_stats(py_rows, web_rows, ["Well"], field)
            mean_abs = float(stats["mean_abs"])
            max_abs = float(stats["max_abs"])
            metrics[label] = max_abs
        report.append(
            f"| {label} | {stats_cell(mean_abs)} | {stats_cell(max_abs)} | `{py_first}` | `{web_first}` | {geometry_likely_consequence(field)} |"
        )
    if py_plate or web_plate:
        report.append("- 07_PLATE_GEOMETRY global parameters:")
        report.extend(keyed_numeric_summary(py_plate, web_plate, ["key"], [("value", "value")]))
    report.append("- Known issue highlight: Python first-row `floor_source` is expected to be `manual_D_projection`; web first-row `floor_source` in the current comparison ZIP is `JSON`/JSON-derived. Strong mouth/floor/background-radius differences are enough by themselves to explain ROI count differences and can plausibly explain MeanW/MeanBG drift.")
    report.append("- stage classification: A geometry/provenance, with downstream B ROI pixel selection and C BG model consequences.")
    return metrics


def append_roi_robust_stat_audit(report: list[str], py_diag: Workbook, web_diag: Workbook) -> dict[str, float]:
    py_stats = rows_as_dicts(py_diag.sheets.get("04_WELL_ROBUST_STATS", []))
    web_stats = rows_as_dicts(web_diag.sheets.get("04_WELL_ROBUST_STATS", []))
    report.extend(["### 2. Well ROI robust statistics"])
    report.append("- keys compared: `Well`; fields compared include ROI counts, retained fraction, raw RGB medians/means, and clipping/highlight diagnostics when exported.")
    py_by_key, web_by_key, common = paired_by_keys(py_stats, web_stats, ["Well"])
    report.append(f"- matched/common/missing/extra: python={len(py_by_key)}, web={len(web_by_key)}, common={len(common)}, missing_in_web={len(set(py_by_key)-set(web_by_key))}, extra_in_web={len(set(web_by_key)-set(py_by_key))}")
    for label, field in [
        ("n_total/n_roi", "n_roi"),
        ("n_core", "n_core"),
        ("n_used", "n_used"),
        ("used_fraction", "used_fraction"),
        ("Red_median", "Red_median"),
        ("Green_median", "Green_median"),
        ("Blue_median", "Blue_median"),
        ("Red_mean", "Red_mean"),
        ("Green_mean", "Green_mean"),
        ("Blue_mean", "Blue_mean"),
    ]:
        stats = field_diff_stats(py_stats, web_stats, ["Well"], field)
        report.append(f"- {label}: paired={stats_cell(stats['paired'])}, mean_abs={stats_cell(stats['mean_abs'])}, max_abs={stats_cell(stats['max_abs'])}, signed_mean={stats_cell(stats['signed_mean'])}")
    append_top_differences_table(report, "- first 10 worst wells by `n_used` difference:", top_numeric_differences(py_stats, web_stats, ["Well"], "n_used"))
    rgb_worst: list[tuple[str, float, str, str]] = []
    for field in ["Red_median", "Green_median", "Blue_median"]:
        rgb_worst.extend([(f"{key} {field}", diff, py_v, web_v) for key, diff, py_v, web_v in top_numeric_differences(py_stats, web_stats, ["Well"], field, 10)])
    append_top_differences_table(report, "- first 10 worst wells by raw RGB median difference:", sorted(rgb_worst, key=lambda item: item[1], reverse=True)[:10])
    n_used_stats = field_diff_stats(py_stats, web_stats, ["Well"], "n_used")
    rgb_stats = [field_diff_stats(py_stats, web_stats, ["Well"], field) for field in ["Red_median", "Green_median", "Blue_median"]]
    max_rgb = max((float(item["max_abs"]) for item in rgb_stats if math.isfinite(float(item["max_abs"]))), default=math.nan)
    max_n_used = float(n_used_stats["max_abs"])
    if math.isfinite(max_rgb) and max_rgb <= 1 and math.isfinite(max_n_used) and max_n_used > 100:
        classification = "B geometry/ROI selection difference with currently low median impact"
    elif math.isfinite(max_rgb) and max_rgb > 1 and math.isfinite(max_n_used) and max_n_used > 0:
        classification = "B geometry/ROI selection difference with numeric color impact"
    elif math.isfinite(max_rgb) and max_rgb > 1:
        classification = "D possible color extraction/raw conversion issue because medians differ without large n_used evidence"
    else:
        classification = "F/G low measured ROI color impact or missing diagnostics"
    report.append(f"- stage classification: {classification}.")
    return {"max_rgb_median_abs": max_rgb, "max_n_used_abs": max_n_used}


def append_bg_pixel_stat_audit(report: list[str], py_diag: Workbook, web_diag: Workbook) -> dict[str, float]:
    py_bg = rows_as_dicts(py_diag.sheets.get("02_BG_SAMPLES", []))
    web_bg = rows_as_dicts(web_diag.sheets.get("02_BG_SAMPLES", []))
    py_fit = rows_as_dicts(py_diag.sheets.get("03_BG_WELL_FIT", []))
    web_fit = rows_as_dicts(web_diag.sheets.get("03_BG_WELL_FIT", []))
    report.extend(["### 3. Background samples and background model"])
    report.append("- keys compared: BG samples by `BG_Cell_Row + BG_Cell_Col`; well-level BG fit by `Well`.")
    report.append("- source audit: Python `_extract_bg_samples` reports accepted-mask centroid, accepted pixel count, and raw B/G/R medians; web includes full-resolution and sampled validation counters to distinguish mask area from sampled model points.")
    for label, field in [
        ("BG sample x centroid", "x"),
        ("BG sample y centroid", "y"),
        ("BG full-res area", "area"),
        ("BG sampled final accepted pixels", "Web_Sampled_Final_Accepted_Pixels"),
        ("BG full-res final accepted pixels", "Web_FullRes_Final_Accepted_Pixels"),
        ("BG Red median raw", "Red_median_raw"),
        ("BG Green median raw", "Green_median_raw"),
        ("BG Blue median raw", "Blue_median_raw"),
    ]:
        stats = field_diff_stats(py_bg, web_bg, ["BG_Cell_Row", "BG_Cell_Col"], field)
        report.append(f"- {label}: paired={stats_cell(stats['paired'])}, mean_abs={stats_cell(stats['mean_abs'])}, max_abs={stats_cell(stats['max_abs'])}")
    append_top_differences_table(report, "- first 10 worst BG samples by RGB median difference:", sorted([
        (f"{key} {field}", diff, py_v, web_v)
        for field in ["Red_median_raw", "Green_median_raw", "Blue_median_raw"]
        for key, diff, py_v, web_v in top_numeric_differences(py_bg, web_bg, ["BG_Cell_Row", "BG_Cell_Col"], field, 10)
    ], key=lambda item: item[1], reverse=True)[:10])
    append_top_differences_table(report, "- first 10 worst BG samples by area difference:", top_numeric_differences(py_bg, web_bg, ["BG_Cell_Row", "BG_Cell_Col"], "area"))
    report.append("- per-well fitted BG values:")
    report.extend(keyed_numeric_summary(py_fit, web_fit, ["Well"], [
        ("BG_Red_raw", "BG_Red_raw"),
        ("BG_Green_raw", "BG_Green_raw"),
        ("BG_Blue_raw", "BG_Blue_raw"),
        ("x", "x"),
        ("y", "y"),
    ]))
    bg_rgb_stats = [field_diff_stats(py_bg, web_bg, ["BG_Cell_Row", "BG_Cell_Col"], field) for field in ["Red_median_raw", "Green_median_raw", "Blue_median_raw"]]
    max_bg_rgb = max((float(item["max_abs"]) for item in bg_rgb_stats if math.isfinite(float(item["max_abs"]))), default=math.nan)
    report.append("- BG_STAT_MASK policy: visual pixel identity is low priority if selected-pixel diagnostics and per-well BG estimates are scientifically close; current audit treats it as a visual diagnostic difference unless captions/legends misstate semantics.")
    report.append("- stage classification: C BG pixel/model selection, with A geometry provenance as an upstream contributor where cell areas/centroids differ.")
    return {"max_bg_rgb_abs": max_bg_rgb}


def append_bg_model_proof_audit(report: list[str], py_diag: Workbook, web_diag: Workbook) -> None:
    py_bg_samples = rows_as_dicts(py_diag.sheets.get("02_BG_SAMPLES", []))
    py_bg_fit = rows_as_dicts(py_diag.sheets.get("03_BG_WELL_FIT", []))
    py_bg_inputs = rows_as_dicts(py_diag.sheets.get("13_BG_MODEL_INPUTS", []))
    py_bg_coefs = rows_as_dicts(py_diag.sheets.get("14_BG_MODEL_COEFFICIENTS", []))
    py_bg_model_preds = rows_as_dicts(py_diag.sheets.get("15_BG_MODEL_PREDICTIONS", []))

    web_bg_inputs = rows_as_dicts(web_diag.sheets.get("13_BG_MODEL_INPUTS", []))
    web_bg_coefs = rows_as_dicts(web_diag.sheets.get("14_BG_MODEL_COEFFICIENTS", []))
    web_bg_model_preds = rows_as_dicts(web_diag.sheets.get("15_BG_MODEL_PREDICTIONS", []))
    web_bg_fit = rows_as_dicts(web_diag.sheets.get("03_BG_WELL_FIT", []))

    report.extend(["### 3B. BG model proof audit (inputs, coefficients, predictions)"])
    report.append("- objective: identify the first proven divergence in BG model/interpolation via exported numerical state, without changing runtime behavior.")

    py_inputs_ref = py_bg_inputs if py_bg_inputs else py_bg_samples
    if py_bg_inputs:
        report.append("- Python proof sheet `13_BG_MODEL_INPUTS` present.")
    else:
        report.append("- Python proof sheet `13_BG_MODEL_INPUTS` missing; fallback comparison uses Python `02_BG_SAMPLES`.")

    input_fields = [
        ("fit-input x", "x"),
        ("fit-input y", "y"),
        ("fit-input area", "area"),
        ("fit-input Red median raw", "Red_median_raw"),
        ("fit-input Green median raw", "Green_median_raw"),
        ("fit-input Blue median raw", "Blue_median_raw"),
    ]
    input_max_abs_values: list[float] = []
    if not web_bg_inputs:
        report.append("- web proof sheet `13_BG_MODEL_INPUTS` missing; fit-input parity is unprovable for this ZIP pair.")
    else:
        for label, field in input_fields:
            stats = field_diff_stats(py_inputs_ref, web_bg_inputs, ["BG_Cell_Row", "BG_Cell_Col"], field)
            max_abs = float(stats["max_abs"])
            if math.isfinite(max_abs):
                input_max_abs_values.append(max_abs)
            report.append(
                f"- {label}: paired={stats_cell(stats['paired'])}, mean_abs={stats_cell(stats['mean_abs'])}, "
                f"max_abs={stats_cell(stats['max_abs'])}, signed_mean={stats_cell(stats['signed_mean'])}"
            )

    py_coefs_available = bool(py_bg_coefs)
    web_coefs_available = bool(web_bg_coefs)
    if not py_coefs_available:
        report.append("- Python proof sheet `14_BG_MODEL_COEFFICIENTS` missing; coefficient and robust-trace parity cannot be proven from this Python ZIP.")
    if not web_coefs_available:
        report.append("- web proof sheet `14_BG_MODEL_COEFFICIENTS` missing; coefficient and robust-trace parity cannot be proven from this web ZIP.")

    norm_max_abs_values: list[float] = []
    coef_max_abs_values: list[float] = []
    trace_max_abs_values: list[float] = []
    trace_ids_mismatch = 0
    if py_coefs_available and web_coefs_available:
        report.append("- coefficient audit by `Channel` (Python 14 vs web 14):")
        report.append(f"- Python basis order: {basis_order_summary(py_bg_coefs, PY_BG_BASIS_FALLBACK)}")
        report.append(f"- web basis order: {basis_order_summary(web_bg_coefs, WEB_BG_BASIS_FALLBACK)}")
        report.append("- coefficient comparison mode: term-aligned semantic comparison (constant, x, y, x^2, x*y, y^2), not raw index-to-index.")

        py_bg_coefs_term = coefficient_rows_by_semantic_term(py_bg_coefs, PY_BG_BASIS_FALLBACK)
        web_bg_coefs_term = coefficient_rows_by_semantic_term(web_bg_coefs, WEB_BG_BASIS_FALLBACK)

        for label, field in [
            ("normalization x0", "x0"),
            ("normalization y0", "y0"),
            ("normalization sx", "sx"),
            ("normalization sy", "sy"),
        ]:
            stats = field_diff_stats(py_bg_coefs, web_bg_coefs, ["Channel"], field)
            max_abs = float(stats["max_abs"])
            if math.isfinite(max_abs):
                norm_max_abs_values.append(max_abs)
            report.append(f"- {label}: paired={stats_cell(stats['paired'])}, mean_abs={stats_cell(stats['mean_abs'])}, max_abs={stats_cell(stats['max_abs'])}")

        for term in BG_COEF_TERM_ORDER:
            field = f"coef_term_{term}"
            stats = field_diff_stats(py_bg_coefs_term, web_bg_coefs_term, ["Channel"], field)
            max_abs = float(stats["max_abs"])
            if math.isfinite(max_abs):
                coef_max_abs_values.append(max_abs)
            report.append(
                f"- coefficient term {BG_COEF_TERM_LABELS.get(term, term)}: "
                f"paired={stats_cell(stats['paired'])}, mean_abs={stats_cell(stats['mean_abs'])}, max_abs={stats_cell(stats['max_abs'])}"
            )

        for label, field in [
            ("trace samples_total", "samples_total"),
            ("trace samples_retained", "samples_retained"),
            ("trace samples_rejected", "samples_rejected"),
            ("trace residual_median", "residual_median"),
            ("trace residual_mad", "residual_mad"),
            ("trace residual_sigma", "residual_sigma"),
            ("trace residual_max_abs", "residual_max_abs"),
        ]:
            stats = field_diff_stats(py_bg_coefs, web_bg_coefs, ["Channel"], field)
            max_abs = float(stats["max_abs"])
            if math.isfinite(max_abs):
                trace_max_abs_values.append(max_abs)
            report.append(f"- {label}: paired={stats_cell(stats['paired'])}, mean_abs={stats_cell(stats['mean_abs'])}, max_abs={stats_cell(stats['max_abs'])}")

        py_by_key, web_by_key, common_channels = paired_by_keys(py_bg_coefs, web_bg_coefs, ["Channel"])
        for key in common_channels:
            py_row = py_by_key.get(key, {})
            web_row = web_by_key.get(key, {})
            if str(py_row.get("retained_ids", "")).strip() != str(web_row.get("retained_ids", "")).strip():
                trace_ids_mismatch += 1
            if str(py_row.get("rejected_ids", "")).strip() != str(web_row.get("rejected_ids", "")).strip():
                trace_ids_mismatch += 1
        report.append(f"- robust-trace id parity mismatches (retained_ids/rejected_ids by channel): {trace_ids_mismatch}")

    py_preds_ref = py_bg_model_preds if py_bg_model_preds else py_bg_fit
    if py_bg_model_preds:
        report.append("- Python proof sheet `15_BG_MODEL_PREDICTIONS` present.")
    else:
        report.append("- Python proof sheet `15_BG_MODEL_PREDICTIONS` missing; fallback comparison uses Python `03_BG_WELL_FIT`.")

    pred_max_abs_values: list[float] = []
    if not web_bg_model_preds:
        report.append("- web proof sheet `15_BG_MODEL_PREDICTIONS` missing; model-evaluation parity is unprovable for this ZIP pair.")
    else:
        web_bg_model_preds_mapped = []
        for row in web_bg_model_preds:
            mapped = dict(row)
            mapped["BG_Red_raw"] = row.get("BG_Red_raw_model", "")
            mapped["BG_Green_raw"] = row.get("BG_Green_raw_model", "")
            mapped["BG_Blue_raw"] = row.get("BG_Blue_raw_model", "")
            web_bg_model_preds_mapped.append(mapped)

        for label, field in [
            ("model Red prediction", "BG_Red_raw"),
            ("model Green prediction", "BG_Green_raw"),
            ("model Blue prediction", "BG_Blue_raw"),
        ]:
            stats_py_vs_web_model = field_diff_stats(py_preds_ref, web_bg_model_preds_mapped, ["Well"], field)
            stats_web_fit_vs_model = field_diff_stats(web_bg_fit, web_bg_model_preds_mapped, ["Well"], field)
            max_abs = float(stats_py_vs_web_model["max_abs"])
            if math.isfinite(max_abs):
                pred_max_abs_values.append(max_abs)
            report.append(
                f"- {label}: python-vs-web15 paired={stats_cell(stats_py_vs_web_model['paired'])}, "
                f"mean_abs={stats_cell(stats_py_vs_web_model['mean_abs'])}, max_abs={stats_cell(stats_py_vs_web_model['max_abs'])}; "
                f"web03-vs-web15 mean_abs={stats_cell(stats_web_fit_vs_model['mean_abs'])}, max_abs={stats_cell(stats_web_fit_vs_model['max_abs'])}"
            )

        append_top_differences_table(
            report,
            "- top 10 wells by absolute BG_Red_raw model prediction difference (python vs web15):",
            top_numeric_differences(py_preds_ref, web_bg_model_preds_mapped, ["Well"], "BG_Red_raw", 10),
        )

    input_div = max(input_max_abs_values) if input_max_abs_values else math.nan
    norm_div = max(norm_max_abs_values) if norm_max_abs_values else math.nan
    coef_div = max(coef_max_abs_values) if coef_max_abs_values else math.nan
    trace_div = max(trace_max_abs_values) if trace_max_abs_values else math.nan
    pred_div = max(pred_max_abs_values) if pred_max_abs_values else math.nan

    first_divergence = "unprovable_from_available_sheets"
    if math.isfinite(input_div) and input_div > 0:
        first_divergence = "fit input coordinates/areas/medians"
    elif math.isfinite(norm_div) and norm_div > 0:
        first_divergence = "coefficient normalization x0/y0/sx/sy"
    elif math.isfinite(coef_div) and coef_div > 0:
        first_divergence = "polynomial coefficients"
    elif (math.isfinite(trace_div) and trace_div > 0) or trace_ids_mismatch > 0:
        first_divergence = "robust sample retention/rejection"
    elif math.isfinite(pred_div) and pred_div > 0:
        first_divergence = "model evaluation/prediction"
    else:
        first_divergence = "no BG-model divergence proven in exported proof sheets; check downstream MeanBG/PAbs audit sections"

    report.append(
        "- first proven divergence classification: "
        f"{first_divergence}. "
        f"(input_max_abs={stats_cell(input_div)}, norm_max_abs={stats_cell(norm_div)}, "
        f"coef_max_abs={stats_cell(coef_div)}, trace_max_abs={stats_cell(trace_div)}, "
        f"trace_id_mismatch={trace_ids_mismatch}, pred_max_abs={stats_cell(pred_div)})"
    )


def approximate_pabs_contributions(py_row: dict[str, str], web_row: dict[str, str], label: str) -> tuple[float, float]:
    py_w = as_float(py_row.get(f"MeanW_{label}", ""))
    web_w = as_float(web_row.get(f"MeanW_{label}", ""))
    py_bg = as_float(py_row.get(f"MeanBG_{label}", ""))
    web_bg = as_float(web_row.get(f"MeanBG_{label}", ""))
    well_term = abs((web_w - py_w) / (py_w * math.log(10))) if math.isfinite(py_w) and math.isfinite(web_w) and py_w > 0 else math.nan
    bg_term = abs((web_bg - py_bg) / (py_bg * math.log(10))) if math.isfinite(py_bg) and math.isfinite(web_bg) and py_bg > 0 else math.nan
    return well_term, bg_term


def append_meanw_meanbg_bridge_audit(
    report: list[str],
    py_report: Workbook,
    web_report: Workbook,
    py_diag: Workbook,
    web_diag: Workbook,
) -> dict[str, float]:
    py_raw = rows_as_dicts(py_report.sheets.get("04_RAW", []))
    web_raw = rows_as_dicts(web_report.sheets.get("04_RAW", []))
    py_bg = rows_as_dicts(py_diag.sheets.get("02_BG_SAMPLES", []))
    web_bg = rows_as_dicts(web_diag.sheets.get("02_BG_SAMPLES", []))
    py_bg_fit = rows_as_dicts(py_diag.sheets.get("03_BG_WELL_FIT", []))
    web_bg_fit = rows_as_dicts(web_diag.sheets.get("03_BG_WELL_FIT", []))
    py_by_key, web_by_key, common = paired_by_keys(py_raw, web_raw, ["Well"])
    py_bg_by_cell = key_rows(py_bg, ["BG_Cell_Row", "BG_Cell_Col"])
    web_bg_by_cell = key_rows(web_bg, ["BG_Cell_Row", "BG_Cell_Col"])
    py_bg_fit_by_well = key_rows(py_bg_fit, ["Well"])
    web_bg_fit_by_well = key_rows(web_bg_fit, ["Well"])
    report.extend(["### 4. MeanW / MeanBG extraction"])
    report.append("- keys compared: `Well`; fields compared: `MeanW_*`, `MeanBG_*`, `PAbs_*`.")
    report.append(f"- matched/common/missing/extra: python={len(py_by_key)}, web={len(web_by_key)}, common={len(common)}, missing_in_web={len(set(py_by_key)-set(web_by_key))}, extra_in_web={len(set(web_by_key)-set(py_by_key))}")
    pabs_max: dict[str, float] = {}
    for label in CHANNEL_LABELS:
        meanw_stats = field_diff_stats(py_raw, web_raw, ["Well"], f"MeanW_{label}")
        meanbg_stats = field_diff_stats(py_raw, web_raw, ["Well"], f"MeanBG_{label}")
        pabs_stats = field_diff_stats(py_raw, web_raw, ["Well"], f"PAbs_{label}")
        pabs_max[label] = float(pabs_stats["max_abs"])
        well_terms: list[float] = []
        bg_terms: list[float] = []
        for key in common:
            well_term, bg_term = approximate_pabs_contributions(py_by_key[key], web_by_key[key], label)
            if math.isfinite(well_term):
                well_terms.append(well_term)
            if math.isfinite(bg_term):
                bg_terms.append(bg_term)
        report.append(
            f"- {label}: mean_abs MeanW={stats_cell(meanw_stats['mean_abs'])}, "
            f"MeanBG={stats_cell(meanbg_stats['mean_abs'])}, PAbs={stats_cell(pabs_stats['mean_abs'])}; "
            f"MeanBG signed_bias(web-py)={stats_cell(meanbg_stats['signed_mean'])}; "
            f"approx_contribution MeanW={stats_cell(statistics.fmean(well_terms) if well_terms else math.nan)}, "
            f"MeanBG={stats_cell(statistics.fmean(bg_terms) if bg_terms else math.nan)}; "
            f"dominant={'MeanW' if well_terms and bg_terms and statistics.fmean(well_terms) > statistics.fmean(bg_terms) else 'MeanBG or mixed'}"
        )
        append_top_differences_table(
            report,
            f"- top 10 wells by absolute MeanBG_{label} difference:",
            top_numeric_differences(py_raw, web_raw, ["Well"], f"MeanBG_{label}", 10),
        )
        top_rows = []
        for key, diff, py_v, web_v in top_numeric_differences(py_raw, web_raw, ["Well"], f"PAbs_{label}", 10):
            py_row = py_by_key[key]
            web_row = web_by_key[key]
            top_rows.append((
                key,
                diff,
                f"PAbs={py_v}; W={py_row.get(f'MeanW_{label}', '')}; BG={py_row.get(f'MeanBG_{label}', '')}",
                f"PAbs={web_v}; W={web_row.get(f'MeanW_{label}', '')}; BG={web_row.get(f'MeanBG_{label}', '')}",
            ))
        append_top_differences_table(report, f"- top 10 wells by absolute PAbs_{label} difference:", top_rows)

        sample_field = f"{label}_median_raw"
        model_field = f"BG_{label}_raw"
        tracking_rows: list[dict[str, float | str]] = []
        for key in common:
            py_meanbg = as_float(py_by_key[key].get(f"MeanBG_{label}", ""))
            web_meanbg = as_float(web_by_key[key].get(f"MeanBG_{label}", ""))
            if not (math.isfinite(py_meanbg) and math.isfinite(web_meanbg)):
                continue
            well_position = parse_well_position(key)
            if well_position is None:
                continue
            row, col = well_position
            nearby_cells = bg_cell_keys_for_well(row, col)
            sample_diffs: list[float] = []
            centroid_diffs: list[float] = []
            for cell_key in nearby_cells:
                py_cell = py_bg_by_cell.get(cell_key)
                web_cell = web_bg_by_cell.get(cell_key)
                if py_cell is None or web_cell is None:
                    continue
                py_sample = as_float(py_cell.get(sample_field, ""))
                web_sample = as_float(web_cell.get(sample_field, ""))
                if math.isfinite(py_sample) and math.isfinite(web_sample):
                    sample_diffs.append(abs(web_sample - py_sample))
                py_x = as_float(py_cell.get("x", ""))
                py_y = as_float(py_cell.get("y", ""))
                web_x = as_float(web_cell.get("x", ""))
                web_y = as_float(web_cell.get("y", ""))
                if all(math.isfinite(value) for value in [py_x, py_y, web_x, web_y]):
                    centroid_diffs.append(math.hypot(web_x - py_x, web_y - py_y))

            py_model = as_float(py_bg_fit_by_well.get(key, {}).get(model_field, ""))
            web_model = as_float(web_bg_fit_by_well.get(key, {}).get(model_field, ""))
            model_diff = abs(web_model - py_model) if math.isfinite(py_model) and math.isfinite(web_model) else math.nan

            tracking_rows.append({
                "well": key,
                "meanbg_abs": abs(web_meanbg - py_meanbg),
                "meanbg_signed": web_meanbg - py_meanbg,
                "sample_abs": mean_finite(sample_diffs),
                "centroid_abs": mean_finite(centroid_diffs),
                "model_abs": model_diff,
            })

        meanbg_abs_vals = [float(row["meanbg_abs"]) for row in tracking_rows]
        sample_vals = [float(row["sample_abs"]) for row in tracking_rows]
        centroid_vals = [float(row["centroid_abs"]) for row in tracking_rows]
        model_vals = [float(row["model_abs"]) for row in tracking_rows]
        corr_sample = pearson_correlation(meanbg_abs_vals, sample_vals)
        corr_centroid = pearson_correlation(meanbg_abs_vals, centroid_vals)
        corr_model = pearson_correlation(meanbg_abs_vals, model_vals)
        corr_candidates = {
            "BG sample median mismatch": corr_sample,
            "BG sample centroid mismatch": corr_centroid,
            "BG model interpolation mismatch": corr_model,
        }
        finite_corr = {name: value for name, value in corr_candidates.items() if math.isfinite(value)}
        dominant_tracking = max(finite_corr, key=lambda name: abs(finite_corr[name])) if finite_corr else "insufficient paired finite data"
        report.append(
            f"- MeanBG_{label} tracking correlations (abs deltas): "
            f"sample_median={stats_cell(corr_sample)}, centroid={stats_cell(corr_centroid)}, model={stats_cell(corr_model)}; "
            f"dominant_tracker={dominant_tracking}"
        )

        worst_tracking = sorted(
            tracking_rows,
            key=lambda row: float(row["meanbg_abs"]) if math.isfinite(float(row["meanbg_abs"])) else -1.0,
            reverse=True,
        )[:10]
        report.append(f"- top 10 wells by absolute MeanBG_{label} with source-tracking fields:")
        report.append("| Well | abs MeanBG diff | signed MeanBG bias (web-py) | nearby BG median diff | nearby BG centroid diff | well BG model diff |")
        report.append("|---|---:|---:|---:|---:|---:|")
        for row in worst_tracking:
            report.append(
                f"| {markdown_cell_text(str(row['well']))} | {fmt_number(float(row['meanbg_abs']))} | {fmt_number(float(row['meanbg_signed']))} | "
                f"{fmt_number(float(row['sample_abs']))} | {fmt_number(float(row['centroid_abs']))} | {fmt_number(float(row['model_abs']))} |"
            )
    report.append("- stage classification: E corrected/intermediate mapping where PAbs does not reconstruct from exported MeanW/MeanBG; otherwise B/C extraction and BG differences dominate.")
    return pabs_max


def append_corrected_pabs_intermediate_audit(report: list[str], py_report: Workbook, web_report: Workbook) -> None:
    py_raw = rows_as_dicts(py_report.sheets.get("04_RAW", []))
    web_raw = rows_as_dicts(web_report.sheets.get("04_RAW", []))
    web_fit = rows_as_dicts(web_report.sheets.get("06_FITTING", []))
    py_summaries = {label: pabs_formula_summary(py_raw, label) for label in CHANNEL_LABELS}
    web_summaries = {label: pabs_formula_summary(web_raw, label) for label in CHANNEL_LABELS}
    report.extend(["### 5. PAbs reconstruction/correction trace"])
    report.append("- source audit: web `buildReportRawRows` writes `MeanW/MeanBG` from raw `measurements`, but writes `PAbs_*` from `displayMeasurements`; `buildReportReplicateRows`, fitting rows, and method comparison are also built from display/corrected measurements. Web `lowSignalCorrection.ts` adds S0 and clip deltas to PAbs without changing raw MeanW/MeanBG.")
    report.append("- Python source audit: `_build_raw_report_rows` computes `PAbs = log10(MeanBG / MeanW)` from the same exported MeanW/MeanBG fields; low-signal correction exists in Python source but is not indicated as an exported per-row replacement in these workbook fields.")
    for label in CHANNEL_LABELS:
        correction_values = nonzero_fit_values(web_fit, pabs_method_name(label), ["S0_applied", "ClipDelta"])
        evidence = any(correction_values.values())
        report.append(
            f"- PAbs_{label}: python_formula={py_summaries[label].status}, web_formula={web_summaries[label].status}, "
            f"web_source={web_summaries[label].source}, correction_metadata_present={evidence}, "
            f"S0_examples={correction_values['S0_applied'][:3]}, ClipDelta_examples={correction_values['ClipDelta'][:3]}"
        )
    report.append("- interpretation: current web replicate/fitting/method ranking uses display/corrected PAbs when corrections are enabled; exported raw MeanW/MeanBG alone are insufficient to reconstruct corrected Red/Green PAbs. Future diagnostics should export per-row raw PAbs, corrected PAbs, S0, clip delta, and final fit-input y.")
    report.append("- stage classification: E correction/intermediate mapping plus C missing retained diagnostic quantity for per-row corrected inputs.")


def append_cielab_source_audit(report: list[str], py_report: Workbook, web_report: Workbook) -> None:
    py_raw = rows_as_dicts(py_report.sheets.get("04_RAW", []))
    web_raw = rows_as_dicts(web_report.sheets.get("04_RAW", []))
    report.extend(["### 6. CIELAB conversion and Delta descriptors"])
    report.append("- Python source audit: `_compute_well_robust_statistics` uses OpenCV `cv2.COLOR_BGR2LAB` over retained ROI pixels, then scales L and centers a/b; `_augment_raw_rows_with_deltae` selects blank, zero-calibration, lowest-calibration, or global-median reference depending on available rows.")
    report.append("- Web source audit: `rgbToLab` implements explicit sRGB linearization, sRGB-to-XYZ with D65 reference white, and CIE Lab formula from extracted well RGB; `buildCielabDiagnosticPoints` uses zero calibration when available, otherwise lowest calibration.")
    report.append("- naming audit: Python `DeltaE`/`DeltaE_chroma` and web `DeltaE_ab`/`DeltaE_ab_chroma` are treated as semantic aliases for comparison.")
    for field in ["L", "a", "b", "DeltaL", "Deltaa", "Deltab", "DeltaE_ab", "DeltaE_ab_chroma"]:
        stats = field_diff_stats(py_raw, web_raw, ["Well"], field)
        report.append(f"- {field}: paired={stats_cell(stats['paired'])}, mean_abs={stats_cell(stats['mean_abs'])}, max_abs={stats_cell(stats['max_abs'])}")
    rgb_meanw = [field_diff_stats(py_raw, web_raw, ["Well"], f"MeanW_{label}") for label in CHANNEL_LABELS]
    lab_max = max(float(field_diff_stats(py_raw, web_raw, ["Well"], field)["max_abs"]) for field in ["L", "a", "b"])
    rgb_has_diff = any(math.isfinite(float(item["max_abs"])) and float(item["max_abs"]) > 1e-6 for item in rgb_meanw)
    report.append(f"- interpretation: RGB extraction differences are present={rgb_has_diff}; L/a/b max_abs={stats_cell(lab_max)}. CIELAB differences are therefore consistent with upstream RGB extraction and possible independent conversion/reference differences; a shared RGB-to-Lab unit test is the safest next discriminator.")
    report.append("- stage classification: D color conversion/reference remains unresolved, downstream of A/B/C extracted RGB differences.")


def replicate_y_field_for_channel(channel: str) -> str | None:
    canonical = canonical_method_name(channel)
    if canonical.startswith("PAbs_"):
        return f"{canonical}_median"
    if canonical in {"L", "a", "b", "DeltaL", "Deltaa", "Deltab"}:
        return f"{canonical}_median"
    if canonical in {"DeltaE_ab", "DeltaE_ab_chroma"}:
        return f"{canonical}_median"
    return None


def fit_key(row: dict[str, str]) -> str:
    return "|".join([
        canonical_method_name(row.get("Channel", "")),
        str(row.get("FitType", "")).strip().upper(),
        str(row.get("ID", "")).strip(),
        str(row.get("DF", "")).strip(),
    ])


def replicate_fit_points(rep_rows: list[dict[str, str]], fit_row: dict[str, str]) -> list[tuple[float, float]]:
    field = replicate_y_field_for_channel(fit_row.get("Channel", ""))
    if field is None:
        return []
    fit_type = str(fit_row.get("FitType", "")).strip().upper()
    sample_id = str(fit_row.get("ID", "")).strip()
    df = str(fit_row.get("DF", "")).strip()
    points: list[tuple[float, float]] = []
    for row in rep_rows:
        typ = str(row.get("Type", "")).strip().upper()
        if fit_type == "CALIBRATION":
            if typ not in {"C", "CAL", "CALIBRATION", "STD", "STANDARD"}:
                continue
        elif fit_type in {"STDADD", "STANDARD_ADDITION"}:
            if typ not in {"A", "SA", "STDADD", "STANDARD_ADDITION", "ADDITION"}:
                continue
            if sample_id and str(row.get("ID", "")).strip() != sample_id:
                continue
            if df and str(row.get("DF", "")).strip() != df:
                continue
        else:
            continue
        x = as_float(row.get("Conc", ""))
        y = as_float(row.get(field, ""))
        if math.isfinite(x) and math.isfinite(y):
            points.append((x, y))
    points.sort(key=lambda item: item[0])
    return points


def append_fit_input_trace_audit(report: list[str], py_report: Workbook, web_report: Workbook) -> None:
    py_rep = rows_as_dicts(py_report.sheets.get("05_REPLICATES_MEAN", []))
    web_rep = rows_as_dicts(web_report.sheets.get("05_REPLICATES_MEAN", []))
    py_fit = rows_as_dicts(py_report.sheets.get("06_FITTING", []))
    web_fit = rows_as_dicts(web_report.sheets.get("06_FITTING", []))
    py_by_fit = {fit_key(row): row for row in py_fit}
    web_by_fit = {fit_key(row): row for row in web_fit}
    common = sorted(set(py_by_fit) & set(web_by_fit))
    report.extend(["### 8. Fit inputs"])
    report.append("- fit inputs reconstructed from REPORT/05_REPLICATES_MEAN where possible; point-level raw replicate values are not available in the workbooks.")
    report.append("| fit key | n_points py/web | x_match | paired_y | median_abs_y | max_abs_y | explains fit-row differences |")
    report.append("|---|---:|---|---:|---:|---:|---|")
    for key in common:
        py_row = py_by_fit[key]
        web_row = web_by_fit[key]
        py_points = replicate_fit_points(py_rep, py_row)
        web_points = replicate_fit_points(web_rep, web_row)
        paired = min(len(py_points), len(web_points))
        x_match = paired > 0 and [x for x, _ in py_points[:paired]] == [x for x, _ in web_points[:paired]]
        y_diffs = [abs(py_points[index][1] - web_points[index][1]) for index in range(paired) if py_points[index][0] == web_points[index][0]]
        median_abs = statistics.median(y_diffs) if y_diffs else math.nan
        max_abs = max(y_diffs) if y_diffs else math.nan
        n_py = py_row.get("n_points", "")
        n_web = web_row.get("n_points", "")
        fit_diffs = numeric_field_diffs(py_row, web_row, ["m", "q", "R2", "C0", "C0_sd"], tolerance=1e-8)
        explains = "yes: x matches but y differs" if x_match and y_diffs and max_abs > 1e-8 and fit_diffs else ("not enough exported points" if not py_points or not web_points else "unclear")
        report.append(f"| `{key}` | `{n_py}`/`{n_web}` | {x_match} | {len(y_diffs)} | {stats_cell(median_abs)} | {stats_cell(max_abs)} | {explains} |")
    report.append("- missing data: full point-level fit arrays, per-row robust weights, and per-row corrected PAbs intermediates are not exported; this limits separation of fit regression effects from upstream y-value effects.")
    report.append("- stage classification: fit n_points generally match for common rows, while reconstructed y summaries differ, so regression is not the first detected cause.")


def append_upstream_cause_chain(
    report: list[str],
    roi_metrics: dict[str, float],
    bg_metrics: dict[str, float],
    pabs_metrics: dict[str, float],
    py_report: Workbook,
    web_report: Workbook,
) -> None:
    py_cmp = rows_as_dicts(py_report.sheets.get("07_METHOD_COMPARISON", []))
    web_cmp = rows_as_dicts(web_report.sheets.get("07_METHOD_COMPARISON", []))
    py_best = next((row.get("Method", "") for row in py_cmp if str(row.get("Selected", "")).strip() in {"1", "1.0", "TRUE", "true"}), py_cmp[0].get("Method", "") if py_cmp else "")
    web_best = next((row.get("Method", "") for row in web_cmp if str(row.get("Selected", "")).strip() in {"1", "1.0", "TRUE", "true"}), web_cmp[0].get("Method", "") if web_cmp else "")
    report.extend(["### 9. Score/ranking impact"])
    report.append(f"- selected/best method: Python=`{py_best}`, Web=`{web_best}`, canonical_match={canonical_method_name(py_best) == canonical_method_name(web_best)}")
    report.append("- score formula status: already reconstructs internally where required inputs are finite; the ranking difference is therefore treated as downstream of fit-input y differences, not a score-formula mismatch.")
    report.append(f"- largest PAbs well-level differences by channel: { {key: stats_cell(value) for key, value in pabs_metrics.items()} }")
    report.append("- impact classification: upstream fit inputs are large enough to change slope/intercept/R2/C0 and therefore method ranking.")
    report.extend(["", "## Upstream Cause Chain"])
    report.append("1. First detected structural mismatch: geometry provenance/reporting (`floor_source` manual_D_projection versus JSON/JSON-derived), plus workbook/reporting differences in diagnostic details.")
    report.append("2. First detected numeric mismatch: geometry radius/background-radius fields before ROI/BG extraction.")
    report.append(f"3. First mismatch likely large enough to affect PAbs/CIELAB: ROI/BG pixel selection. Current maxima include ROI n_used abs diff {stats_cell(roi_metrics.get('max_n_used_abs', math.nan))}, ROI RGB median abs diff {stats_cell(roi_metrics.get('max_rgb_median_abs', math.nan))}, BG RGB median abs diff {stats_cell(bg_metrics.get('max_bg_rgb_abs', math.nan))}.")
    report.append(f"4. First mismatch likely large enough to affect ranking: fit-input y differences from PAbs/CIELAB replicate medians; max PAbs diffs by channel are { {key: stats_cell(value) for key, value in pabs_metrics.items()} }.")
    report.append("5. Cause assignment: geometry provenance A is earliest; ROI selection B and BG model C are downstream and scientifically meaningful; CIELAB conversion/reference D is unresolved but downstream of extracted RGB differences; PAbs correction mapping E affects reconstruction/export interpretation; fit regression and score formula are not first causes in the current ZIPs; PNG pixel identity is visual/reporting only.")
    report.append("6. Recommended next milestone: shared-geometry import/export parity test that runs Python and web from identical well centers, mouth/floor radii, and floor-circle provenance, followed by a shared extracted-intermediate table for ROI/BG pixels and fit-input y values.")


def append_upstream_fit_input_parity_audit(report: list[str], py_report: Workbook, web_report: Workbook, py_diag: Workbook, web_diag: Workbook) -> None:
    report.extend([
        "",
        "## Upstream Fit-Input Parity Audit",
        "- Pipeline audited: geometry -> well ROI robust statistics -> background samples/model -> MeanW/MeanBG extraction -> PAbs reconstruction/correction trace -> CIELAB conversion/delta descriptors -> replicate means/SDs -> fit inputs -> score/ranking impact.",
        "- Cause classes: A geometry/provenance; B ROI pixel selection; C BG pixel/model selection; D color conversion/reference; E correction/intermediate mapping; F reporting-only; G unknown.",
    ])
    geometry_metrics = append_geometry_provenance_audit(report, py_diag, web_diag)
    roi_metrics = append_roi_robust_stat_audit(report, py_diag, web_diag)
    bg_metrics = append_bg_pixel_stat_audit(report, py_diag, web_diag)
    append_bg_model_proof_audit(report, py_diag, web_diag)
    pabs_metrics = append_meanw_meanbg_bridge_audit(report, py_report, web_report, py_diag, web_diag)
    append_corrected_pabs_intermediate_audit(report, py_report, web_report)
    append_cielab_source_audit(report, py_report, web_report)
    report.extend(["### 7. Replicate means/SDs"])
    py_rep = rows_as_dicts(py_report.sheets.get("05_REPLICATES_MEAN", []))
    web_rep = rows_as_dicts(web_report.sheets.get("05_REPLICATES_MEAN", []))
    report.extend(keyed_numeric_summary(py_rep, web_rep, ["ID", "DF", "Type", "Conc"], [
        ("NReplicates", "NReplicates"),
        ("PAbs_Red_median", "PAbs_Red_median"),
        ("PAbs_Green_median", "PAbs_Green_median"),
        ("PAbs_Blue_median", "PAbs_Blue_median"),
        ("DeltaE_ab_median", "DeltaE_ab_median"),
        ("DeltaE_ab_chroma_median", "DeltaE_ab_chroma_median"),
    ]))
    report.append("- stage classification: grouping keys mostly align, so nonzero replicate mean/SD differences propagate extracted-value differences into fits.")
    append_fit_input_trace_audit(report, py_report, web_report)
    append_upstream_cause_chain(report, roi_metrics | geometry_metrics, bg_metrics, pabs_metrics, py_report, web_report)


def pabs_method_name(label: str) -> str:
    return f"PAbs_{label}"


def pabs_role(row: dict[str, str]) -> str:
    value = str(row.get("Type", "")).strip().upper()
    if value in {"CAL", "STD", "STANDARD", "CALIBRATION", "C"}:
        return "calibration"
    if value in {"A", "SA", "STDADD", "STANDARD_ADDITION", "ADDITION"}:
        return "standard_addition"
    if value in {"UNK", "UNKNOWN", "U"}:
        return "unknown"
    if value in {"BLK", "BLANK", "EMPTY", "E"}:
        return "blank_empty"
    return value.lower() if value else "unclassified"


def increment_count(counts: dict[str, int], key: str) -> None:
    counts[key] = counts.get(key, 0) + 1


def role_counts_text(counts: dict[str, int]) -> str:
    if not counts:
        return "none"
    return ", ".join(f"{key}={counts[key]}" for key in sorted(counts))


def residual_pattern(residuals: list[float]) -> str:
    if not residuals:
        return "unavailable"
    max_abs = max(abs(value) for value in residuals)
    if max_abs <= PABS_FORMULA_TOLERANCE:
        return "none/pass"
    signed_mean = statistics.fmean(residuals)
    sd = statistics.pstdev(residuals) if len(residuals) > 1 else 0.0
    signs = {
        1 if value > PABS_FORMULA_TOLERANCE else -1
        for value in residuals
        if abs(value) > PABS_FORMULA_TOLERANCE
    }
    if len(signs) <= 1 and sd <= max(1e-8, abs(signed_mean) * 0.10):
        return "systematic"
    return "well-dependent"


def pabs_formula_summary(rows: list[dict[str, str]], label: str) -> PAbsFormulaSummary:
    validation_meanw = f"Web_PAbs_Input_MeanW_{label}"
    validation_meanbg = f"Web_PAbs_Input_MeanBG_{label}"
    has_validation_inputs = any(validation_meanw in row or validation_meanbg in row for row in rows)
    meanw_field = validation_meanw if has_validation_inputs else f"MeanW_{label}"
    meanbg_field = validation_meanbg if has_validation_inputs else f"MeanBG_{label}"
    source = "web validation input columns" if has_validation_inputs else "exported MeanW/MeanBG"
    residuals: list[float] = []
    role_counts: dict[str, int] = {}
    warn_role_counts: dict[str, int] = {}
    worst_rows: list[dict[str, str]] = []
    finite_inputs = 0

    for index, row in enumerate(rows):
        well = as_float(row.get(meanw_field, ""))
        bg = as_float(row.get(meanbg_field, ""))
        pabs = as_float(row.get(f"PAbs_{label}", ""))
        if not (math.isfinite(well) and math.isfinite(bg) and math.isfinite(pabs) and well > 0 and bg > 0):
            continue
        finite_inputs += 1
        recomputed = math.log10(bg / well)
        residual = pabs - recomputed
        residuals.append(residual)
        role = pabs_role(row)
        increment_count(role_counts, role)
        if abs(residual) > PABS_FORMULA_TOLERANCE:
            increment_count(warn_role_counts, role)
        worst_rows.append({
            "row_index": str(index + 1),
            "Well": row.get("Well", ""),
            "ID": row.get("ID", ""),
            "Type": row.get("Type", ""),
            "Conc": row.get("Conc", ""),
            "DF": row.get("DF", ""),
            "MeanW": f"{well:.12g}",
            "MeanBG": f"{bg:.12g}",
            "PAbs": f"{pabs:.12g}",
            "Recomputed": f"{recomputed:.12g}",
            "Residual": f"{residual:.12g}",
            "AbsResidual": f"{abs(residual):.12g}",
        })

    abs_residuals = [abs(value) for value in residuals]
    max_abs = max(abs_residuals) if abs_residuals else math.nan
    status = "PASS" if abs_residuals and max_abs <= PABS_FORMULA_TOLERANCE else ("WARN" if abs_residuals else "NO_DATA")
    return PAbsFormulaSummary(
        label=label,
        status=status,
        source=source,
        meanw_field=meanw_field,
        meanbg_field=meanbg_field,
        finite_inputs=finite_inputs,
        mean_abs_residual=statistics.fmean(abs_residuals) if abs_residuals else math.nan,
        max_abs_residual=max_abs,
        signed_mean_residual=statistics.fmean(residuals) if residuals else math.nan,
        residual_sd=statistics.pstdev(residuals) if len(residuals) > 1 else (0.0 if residuals else math.nan),
        residual_pattern=residual_pattern(residuals),
        role_counts=role_counts,
        warn_role_counts=warn_role_counts,
        worst_rows=sorted(worst_rows, key=lambda item: as_float(item["AbsResidual"]), reverse=True)[:5],
    )


def append_pabs_formula_report(report: list[str], title: str, rows: list[dict[str, str]]) -> dict[str, PAbsFormulaSummary]:
    report.append(title)
    summaries: dict[str, PAbsFormulaSummary] = {}
    for label in CHANNEL_LABELS:
        summary = pabs_formula_summary(rows, label)
        summaries[label] = summary
        if summary.status == "NO_DATA":
            report.append(f"- PAbs_{label}: no finite formula-check rows")
            continue
        report.append(
            f"- PAbs_{label}: status={summary.status}, source={summary.source}, "
            f"MeanW_field=`{summary.meanw_field}`, MeanBG_field=`{summary.meanbg_field}`, "
            f"formula_rows={summary.finite_inputs}, mean_abs_residual={summary.mean_abs_residual:.8g}, "
            f"max_abs_residual={summary.max_abs_residual:.8g}, signed_mean_residual={summary.signed_mean_residual:.8g}, "
            f"residual_sd={summary.residual_sd:.8g}, pattern={summary.residual_pattern}, "
            f"roles_checked=({role_counts_text(summary.role_counts)}), roles_warn=({role_counts_text(summary.warn_role_counts)})"
        )
        for row in summary.worst_rows[:3]:
            report.append(
                "  - worst: "
                f"row={row['row_index']}, Well=`{row['Well']}`, ID=`{row['ID']}`, Type=`{row['Type']}`, "
                f"Conc=`{row['Conc']}`, DF=`{row['DF']}`, exported_MeanW={row['MeanW']}, "
                f"exported_MeanBG={row['MeanBG']}, exported_PAbs={row['PAbs']}, "
                f"recomputed_log10_BG_over_W={row['Recomputed']}, residual_PAbs_minus_recomputed={row['Residual']}"
            )
    return summaries


def nonzero_fit_values(rows: list[dict[str, str]], method: str, fields: list[str]) -> dict[str, list[float]]:
    out = {field: [] for field in fields}
    for row in rows:
        if row.get("Channel", "") != method:
            continue
        for field in fields:
            value = as_float(row.get(field, ""))
            if math.isfinite(value) and abs(value) > PABS_FORMULA_TOLERANCE:
                out[field].append(value)
    return out


def append_pabs_cause_lines(
    report: list[str],
    py_summaries: dict[str, PAbsFormulaSummary],
    web_summaries: dict[str, PAbsFormulaSummary],
    web_fit: list[dict[str, str]],
) -> None:
    report.append("- Cause classification detail:")
    for label in CHANNEL_LABELS:
        method = pabs_method_name(label)
        py_status = py_summaries.get(label, PAbsFormulaSummary(label, "NO_DATA", "", "", "", 0, math.nan, math.nan, math.nan, math.nan, "", {}, {}, [])).status
        web_summary = web_summaries.get(label)
        correction_values = nonzero_fit_values(web_fit, method, ["S0_applied", "ClipDelta"])
        correction_evidence = any(values for values in correction_values.values())
        if not web_summary or web_summary.status == "NO_DATA":
            report.append(f"  - {method}: no web formula evidence; class G.")
        elif web_summary.status == "PASS":
            report.append(f"  - {method}: workbook fields reconstruct PAbs directly; no formula mismatch detected.")
        elif py_status == "PASS" and correction_evidence:
            report.append(
                f"  - {method}: class B/D/E with C for missing per-row correction intermediate. "
                "Python fields reconstruct directly, but web fit rows contain nonzero correction metadata "
                f"(S0_applied={correction_values['S0_applied'][:3]}, ClipDelta={correction_values['ClipDelta'][:3]}). "
                "The web PAbs field is a corrected/display signal while exported MeanW/MeanBG remain extraction inputs."
            )
        elif py_status == "PASS":
            report.append(
                f"  - {method}: class B/D/E. Python reconstructs directly but web does not; inspect whether PAbs is corrected "
                "or whether validation input columns are missing before treating this as mathematical processing mismatch."
            )
        else:
            report.append(f"  - {method}: class G. Both sides need inspection before assigning cause.")


def finite_count(rows: list[dict[str, str]], field: str) -> int:
    return sum(1 for row in rows if math.isfinite(as_float(row.get(field, ""))))


def append_score_impact_trace(
    report: list[str],
    web_rep: list[dict[str, str]],
    web_fit: list[dict[str, str]],
    web_cmp: list[dict[str, str]],
    web_summaries: dict[str, PAbsFormulaSummary],
) -> None:
    report.extend(["### Score impact trace"])
    method_rank = {row.get("Method", ""): index + 1 for index, row in enumerate(web_cmp)}
    cmp_by_method = {row.get("Method", ""): row for row in web_cmp}
    for label in CHANNEL_LABELS:
        method = pabs_method_name(label)
        summary = web_summaries.get(label)
        rep_median_field = f"PAbs_{label}_median"
        rep_sd_field = f"PAbs_{label}_sd"
        fit_rows = [row for row in web_fit if row.get("Channel", "") == method]
        cmp = cmp_by_method.get(method, {})
        report.append(
            f"- {method}: raw_formula_status={summary.status if summary else 'NO_DATA'}, "
            f"warn_roles=({role_counts_text(summary.warn_role_counts) if summary else 'none'}), "
            f"replicate_median_finite={finite_count(web_rep, rep_median_field)}, "
            f"replicate_sd_finite={finite_count(web_rep, rep_sd_field)}, "
            f"fit_rows={len(fit_rows)}, method_rank={method_rank.get(method, 'missing')}, "
            f"Score=`{cmp.get('Score', '')}`, BaseScore=`{cmp.get('BaseScore', '')}`, "
            f"C0_median=`{cmp.get('C0_median', '')}`"
        )
        for row in fit_rows[:3]:
            report.append(
                f"  - fit: FitType=`{row.get('FitType', '')}`, ID=`{row.get('ID', '')}`, DF=`{row.get('DF', '')}`, "
                f"n_points=`{row.get('n_points', '')}`, m=`{row.get('m', '')}`, q=`{row.get('q', '')}`, "
                f"R2=`{row.get('R2', '')}`, C0=`{row.get('C0', '')}`, C0_sd=`{row.get('C0_sd', '')}`"
            )
    report.append(
        "- Interpretation: this trace identifies where corrected or mismatched PAbs values are consumed. "
        "It does not prove score causality until a fresh web ZIP exposes or compares the exact per-row corrected PAbs intermediates."
    )


def method_header_order_status(py_rows: list[list[str]], web_rows: list[list[str]]) -> str:
    py_header = py_rows[0] if py_rows else []
    web_header = web_rows[0] if web_rows else []
    if py_header == web_header:
        return "MATCH"
    if set(py_header) == set(web_header):
        return "SAME_COLUMNS_DIFFERENT_ORDER"
    return "DIFFERENT_COLUMNS"


def append_score_reconstruction_lines(report: list[str], label: str, rows: list[dict[str, str]]) -> dict[str, dict[str, int]]:
    report.append(f"### {label} score reconstruction")
    totals = {"Score": {"PASS": 0, "WARN": 0, "NOT_RECOMPUTABLE": 0, "NO_WORKBOOK_VALUE": 0}, "BaseScore": {"PASS": 0, "WARN": 0, "NOT_RECOMPUTABLE": 0, "NO_WORKBOOK_VALUE": 0}}
    for row in rows:
        method = row.get("Method", "")
        line_parts = [f"- `{method}`"]
        for field in ["Score", "BaseScore"]:
            status, residual, formula, missing = score_reconstruction_status(row, field)
            totals[field][status] = totals[field].get(status, 0) + 1
            residual_text = f"{residual:.8g}" if math.isfinite(residual) else "nan"
            missing_text = ",".join(missing) if missing else "none"
            line_parts.append(f"{field}: {status} residual={residual_text} formula=`{formula}` missing={missing_text}")
        report.append("; ".join(line_parts))
    return totals


def expected_reference_fields(rows: list[dict[str, str]]) -> list[str]:
    fields = sorted({
        key
        for row in rows
        for key in row
        if key.startswith(("expected_", "estimate_for_expected_", "delta_expected_", "recovery_pct_", "rel_error_"))
    })
    return fields


def append_method_field_comparison(report: list[str], py_row: dict[str, str] | None, web_row: dict[str, str] | None) -> None:
    fields = SCORE_COMPARE_FIELDS + sorted(set(expected_reference_fields([py_row or {}, web_row or {}])))
    for field in fields:
        py_value = py_row.get(field, "") if py_row else ""
        web_value = web_row.get(field, "") if web_row else ""
        if str(py_value).strip() == "" and str(web_value).strip() == "":
            continue
        if field == "Method" and py_row and web_row and canonical_method_name(str(py_value)) == canonical_method_name(str(web_value)):
            status = "ALIAS" if str(py_value) != str(web_value) else "MATCH"
        else:
            py_num = as_float(str(py_value))
            web_num = as_float(str(web_value))
            if math.isfinite(py_num) and math.isfinite(web_num):
                status = "MATCH" if abs(py_num - web_num) <= 1e-8 else f"DIFF abs={abs(py_num - web_num):.8g}"
            else:
                status = "MATCH" if str(py_value).strip() == str(web_value).strip() else "DIFF"
        report.append(f"  - {field}: python=`{py_value}`, web=`{web_value}`, status={status}")


def append_score_method_parity_section(
    report: list[str],
    py_cmp_rows: list[list[str]],
    web_cmp_rows: list[list[str]],
) -> None:
    py_rows = rows_as_dicts(py_cmp_rows)
    web_rows = rows_as_dicts(web_cmp_rows)
    py_by_method = method_rows_by_canonical_key(py_rows)
    web_by_method = method_rows_by_canonical_key(web_rows)
    common = sorted(set(py_by_method) & set(web_by_method))
    missing = sorted(set(py_by_method) - set(web_by_method))
    extra = sorted(set(web_by_method) - set(py_by_method))
    alias_pairs = [
        (py_by_method[key].get("Method", ""), web_by_method[key].get("Method", ""))
        for key in common
        if has_method_alias_difference(py_by_method[key], web_by_method[key])
    ]

    report.extend(["", "## Score / Method-Comparison Parity"])
    report.append(f"- header order status: {method_header_order_status(py_cmp_rows, web_cmp_rows)}")
    report.append(f"- python methods: {method_order(py_rows)}")
    report.append(f"- web methods: {method_order(web_rows)}")
    report.append(f"- canonical common methods={len(common)}, missing_in_web={missing}, extra_in_web={extra}")
    report.append(f"- comparison aliases used: {alias_pairs if alias_pairs else 'none'}")
    report.append("- Formula audited from source: `Score = BaseScore = slope_agreement^2 * sqrt(R2_cal * R2_std_mean) * (1/LOQ)` for calibration-plus-standard-addition rows with finite positive LOQ; fallback comparable groups use `R2_cal`, `R2_std_mean`, or not-ranked score 0. Expected/reference, recovery, SNR, and clipping fields are diagnostics and are not score inputs.")

    py_totals = append_score_reconstruction_lines(report, "Python", py_rows)
    web_totals = append_score_reconstruction_lines(report, "Web", web_rows)

    report.extend(["### Method-by-method comparison"])
    for key in sorted(set(py_by_method) | set(web_by_method)):
        py_row = py_by_method.get(key)
        web_row = web_by_method.get(key)
        classification = classify_method_difference(py_row, web_row)
        report.append(f"- canonical_method=`{key}` classification={classification}")
        append_method_field_comparison(report, py_row, web_row)

    report.extend(["### Ranking and selection"])
    py_selected = [row.get("Method", "") for row in py_rows if str(row.get("Selected", "")).strip() in {"1", "1.0", "TRUE", "true"}]
    web_selected = [row.get("Method", "") for row in web_rows if str(row.get("Selected", "")).strip() in {"1", "1.0", "TRUE", "true"}]
    py_best = py_selected[0] if py_selected else (py_rows[0].get("Method", "") if py_rows else "")
    web_best = web_selected[0] if web_selected else (web_rows[0].get("Method", "") if web_rows else "")
    report.append(f"- python selected/best: `{py_best}`")
    report.append(f"- web selected/best: `{web_best}`")
    report.append(f"- selected canonical match: {canonical_method_name(py_best) == canonical_method_name(web_best)}")
    report.append(f"- Python reconstruction totals: {py_totals}")
    report.append(f"- Web reconstruction totals: {web_totals}")


def append_score_centered_summary(
    report: list[str],
    py_cmp_rows: list[list[str]],
    web_cmp_rows: list[list[str]],
) -> None:
    py_rows = rows_as_dicts(py_cmp_rows)
    web_rows = rows_as_dicts(web_cmp_rows)
    py_by_method = method_rows_by_canonical_key(py_rows)
    web_by_method = method_rows_by_canonical_key(web_rows)
    common = sorted(set(py_by_method) & set(web_by_method))
    missing = sorted(set(py_by_method) - set(web_by_method))
    extra = sorted(set(web_by_method) - set(py_by_method))
    aliases = [
        (py_by_method[key].get("Method", ""), web_by_method[key].get("Method", ""))
        for key in common
        if has_method_alias_difference(py_by_method[key], web_by_method[key])
    ]
    classifications = [classify_method_difference(py_by_method.get(key), web_by_method.get(key)) for key in sorted(set(py_by_method) | set(web_by_method))]
    input_dominated = sum(1 for item in classifications if item.startswith("B "))
    formula_dominated = sum(1 for item in classifications if item.startswith("C "))
    naming_dominated = sum(1 for item in classifications if item.startswith("A "))
    py_best = next((row.get("Method", "") for row in py_rows if str(row.get("Selected", "")).strip() in {"1", "1.0", "TRUE", "true"}), py_rows[0].get("Method", "") if py_rows else "")
    web_best = next((row.get("Method", "") for row in web_rows if str(row.get("Selected", "")).strip() in {"1", "1.0", "TRUE", "true"}), web_rows[0].get("Method", "") if web_rows else "")

    report.extend(["", "## Score-Centered Summary"])
    report.append(f"- Same methods compared after aliases: {not missing and not extra}; missing={missing}; extra={extra}")
    report.append(f"- Method aliases needed: {aliases if aliases else 'none'}")
    report.append("- Score/BaseScore internally reconstruct from workbook fields when required fields are finite; see reconstruction statuses above.")
    if formula_dominated:
        dominant = "formula reconstruction differences"
    elif input_dominated:
        dominant = "upstream numeric input differences"
    elif naming_dominated:
        dominant = "method naming/grouping differences"
    else:
        dominant = "ranking/reporting differences or below-threshold residuals"
    report.append(f"- Score differences are currently dominated by: {dominant}")
    report.append(f"- Python selected/best method: `{py_best}`")
    report.append(f"- Web selected/best method: `{web_best}`")
    report.append(f"- Selected/best canonical match: {canonical_method_name(py_best) == canonical_method_name(web_best)}")
    if missing or extra:
        first_blocker = "method naming/availability alignment"
    elif input_dominated:
        first_blocker = "upstream fit-input parity"
    elif formula_dominated:
        first_blocker = "score formula reconstruction parity"
    elif canonical_method_name(py_best) != canonical_method_name(web_best):
        first_blocker = "ranking/selection parity"
    else:
        first_blocker = "no score blocker identified from existing comparison ZIPs"
    report.append(f"- First blocking cause: {first_blocker}")


def append_process_parity_section(
    report: list[str],
    py_report: Workbook,
    web_report: Workbook,
    py_diag: Workbook,
    web_diag: Workbook,
) -> None:
    py_raw = rows_as_dicts(py_report.sheets.get("04_RAW", []))
    web_raw = rows_as_dicts(web_report.sheets.get("04_RAW", []))
    py_rep = rows_as_dicts(py_report.sheets.get("05_REPLICATES_MEAN", []))
    web_rep = rows_as_dicts(web_report.sheets.get("05_REPLICATES_MEAN", []))
    py_fit = rows_as_dicts(py_report.sheets.get("06_FITTING", []))
    web_fit = rows_as_dicts(web_report.sheets.get("06_FITTING", []))
    py_cmp_rows = py_report.sheets.get("07_METHOD_COMPARISON", [])
    web_cmp_rows = web_report.sheets.get("07_METHOD_COMPARISON", [])
    py_cmp = rows_as_dicts(py_cmp_rows)
    web_cmp = rows_as_dicts(web_cmp_rows)
    py_stats = rows_as_dicts(py_diag.sheets.get("04_WELL_ROBUST_STATS", []))
    web_stats = rows_as_dicts(web_diag.sheets.get("04_WELL_ROBUST_STATS", []))

    report.extend(["", "## Process-Parity Checks"])
    report.extend(["### 1. RAW extraction parity"])
    report.append("- REPORT/04_RAW MeanW values are the linearized well intensities used for PAbs, not raw 8-bit medians.")
    report.extend(keyed_numeric_summary(py_raw, web_raw, ["Well"], [
        ("MeanW_Red", "MeanW_Red"),
        ("MeanW_Green", "MeanW_Green"),
        ("MeanW_Blue", "MeanW_Blue"),
        ("MeanBG_Red", "MeanBG_Red"),
        ("MeanBG_Green", "MeanBG_Green"),
        ("MeanBG_Blue", "MeanBG_Blue"),
    ]))
    report.append("- DIAGNOSTICS/04_WELL_ROBUST_STATS raw medians and ROI counts:")
    report.extend(keyed_numeric_summary(py_stats, web_stats, ["Well"], [
        ("Red_median", "Red_median"),
        ("Green_median", "Green_median"),
        ("Blue_median", "Blue_median"),
        ("n_used", "n_used"),
        ("used_fraction", "used_fraction"),
    ]))
    report.append("- Classification: nonzero MeanW/MeanBG or ROI-count differences point to geometry/ROI/BG input mismatch before PAbs math.")

    report.extend(["### 2. PAbs formula parity"])
    py_pabs_summaries = append_pabs_formula_report(report, "- Python workbook internal formula residuals:", py_raw)
    web_pabs_summaries = append_pabs_formula_report(report, "- Web workbook internal formula residuals:", web_raw)
    report.append("- Formula convention checked here: `PAbs = log10(MeanBG / MeanW)` using the named exported input columns.")
    report.append("- Classification: PASS means the workbook fields reconstruct the exported PAbs directly. WARN means the exported PAbs is not reconstructible from those fields alone; if correction metadata is present, classify as corrected-output/intermediate-mapping until per-row corrected inputs are available.")
    append_pabs_cause_lines(report, py_pabs_summaries, web_pabs_summaries, web_fit)
    append_score_impact_trace(report, web_rep, web_fit, web_cmp, web_pabs_summaries)

    report.extend(["### 3. CIELAB / Delta descriptor parity"])
    report.extend(keyed_numeric_summary(py_raw, web_raw, ["Well"], [
        ("L", "L"),
        ("a", "a"),
        ("b", "b"),
        ("DeltaL", "DeltaL"),
        ("Deltaa", "Deltaa"),
        ("Deltab", "Deltab"),
        ("DeltaE_ab", "DeltaE_ab"),
        ("DeltaE_ab_chroma", "DeltaE_ab_chroma"),
    ]))
    report.append("- Classification: if L/a/b differ in line with raw RGB differences, this is upstream extraction/input; if L/a/b are close but Delta fields differ, inspect reference selection/naming.")

    report.extend(["### 4. Replicate/grouping parity"])
    report.extend(keyed_numeric_summary(py_rep, web_rep, ["ID", "DF", "Type", "Conc"], [
        ("NReplicates", "NReplicates"),
        ("PAbs_Red_median", "PAbs_Red_median"),
        ("PAbs_Red_sd", "PAbs_Red_sd"),
        ("PAbs_Green_median", "PAbs_Green_median"),
        ("PAbs_Green_sd", "PAbs_Green_sd"),
        ("PAbs_Blue_median", "PAbs_Blue_median"),
        ("PAbs_Blue_sd", "PAbs_Blue_sd"),
        ("DeltaE_ab_median", "DeltaE_ab_median"),
        ("DeltaE_ab_sd", "DeltaE_ab_sd"),
    ]))
    report.append("- Classification: matching keys/counts with differing medians/SDs means grouping agrees and upstream extracted values differ.")

    report.extend(["### 5. Fitting-input / fit-row parity"])
    report.extend(keyed_numeric_summary(py_fit, web_fit, ["Channel", "FitType", "ID", "DF"], [
        ("n_points", "n_points"),
        ("slope", "m"),
        ("intercept", "q"),
        ("R2", "R2"),
        ("C0", "C0"),
        ("C0_sd", "C0_sd"),
        ("LOD", "LOD"),
        ("LOQ", "LOQ"),
    ]))
    report.append("- Classification: matching n_points with differing replicate means points to upstream numeric inputs; matching replicate means with differing fit rows would point to regression/uncertainty math.")

    report.extend(["### 6. Method comparison parity"])
    report.append(f"- REPORT/07_METHOD_COMPARISON header order: {method_header_order_status(py_cmp_rows, web_cmp_rows)}")
    report.append(f"- python method order: {method_order(py_cmp)}")
    report.append(f"- web method order: {method_order(web_cmp)}")
    report.extend(keyed_numeric_summary(py_cmp, web_cmp, ["Method"], [
        ("Score", "Score"),
        ("BaseScore", "BaseScore"),
        ("R2_cal", "R2_cal"),
        ("R2_std_mean", "R2_std_mean"),
        ("C0_median", "C0_median"),
        ("Estimate_value", "Estimate_value"),
    ]))
    report.append("- Classification: header-order-only differences are reporting; method order/name/score differences are downstream of fitting inputs and ranking/naming semantics.")


def text_presence_lines(py_canon: dict[str, str], web_canon: dict[str, str]) -> list[str]:
    text_names = sorted((set(py_canon) | set(web_canon)))
    lines = []
    for name in text_names:
        if name.lower().endswith(".txt"):
            lines.append(f"- `{name}`: python={name in py_canon}, web={name in web_canon}")
    return lines or ["- no TXT files found"]


def append_cause_classification(report: list[str]) -> None:
    report.extend([
        "",
        "## Cause Classification",
        "- BG sample x/y/RGB medians blank in web: **resolved in current web exports if populated**. Remaining differences should be interpreted numerically, not as missing diagnostics.",
        "- BG sample area mismatch: compare Python `area` to web `area`, then compare web `Web_Sampled_Final_Accepted_Pixels`. If the sampled count is far smaller than both area values, the previous mismatch was an **area meaning mismatch**; residual web-area differences are **A/B/C**, usually geometry or mask-construction differences.",
        "- `floor_source` JSON vs `manual_D_projection`: **A/D unresolved**. Likely different geometry provenance or reporting semantics; requires shared-geometry import/export comparison.",
        "- `mouth_r`, `floor_r`, `cyl_r_bg` differences: **A/B unresolved**. Treat as geometry/input-pixel mismatch unless a shared-geometry test proves web interpretation differs.",
        "- `C0_sd` blank in web ZIP: **D or stale artifact**. Recent code addressed this, but this report compares `web_after_36U.zip`; regenerate the web ZIP before deciding if mismatch remains.",
        "- PAbs Red/Green formula WARN with Python PASS and web Blue PASS: **B/D/E with possible C** when web low-signal correction metadata is present. The likely cause is corrected/display PAbs compared against raw extraction `MeanW`/`MeanBG`; per-row corrected PAbs input/intermediate columns are needed before calling this a mathematical formula mismatch.",
        "- Method-comparison `BaseScore`/ranking/name differences: **D/B depending on fresh export**. Header/name/reporting differences are D; residual score differences after a fresh export may indicate B or input-data differences.",
        "- CIELAB fitting extra or differently named rows in web ZIP: **D** for naming/reporting; residual numerical differences after row-name parity may be **A/B**.",
        "- `BG_STAT_MASK` overlay vs Python binary mask: **visual/reporting difference, low scientific priority** if the web selected-pixel visualization is clear and its caption/legend states the semantics accurately.",
        "- PNG visual differences generally: judge scientific visual parity, not pixel identity alone. Pixel differences are acceptable for beta parity when all scientific information is present, correctly labeled, and not misleading.",
        "- TXT caption differences: **F**, with some intentional beta transparency where web semantics are not yet Python-identical.",
    ])


def append_next_blocks(report: list[str]) -> None:
    report.extend([
        "",
        "## Next-block Recommendations",
        "- **Block B:** run a shared-geometry/background-mask test using identical manual geometry and the new web full-resolution area/sampled-count diagnostics.",
        "- **Block C:** implement shared geometry import/export or a geometry equivalence test.",
        "- **Block D:** use the process-parity section to decide whether remaining fitting differences are upstream-input differences or regression/uncertainty differences.",
        "- **Block E:** perform graphical/TXT parity cleanup after data structures are correct.",
    ])


def compare(
    python_zip: Path,
    web_zip: Path,
    visual_dir: Path = DEFAULT_VISUAL_DIR,
    shared_geometry_dir: Path = DEFAULT_SHARED_GEOMETRY_DIR,
) -> str:
    report: list[str] = [
        "# TIPICA Python/Web Output Comparison",
        "",
        f"Python ZIP: `{python_zip}`",
        f"Web ZIP: `{web_zip}`",
        "",
    ]
    with zipfile.ZipFile(python_zip) as py_zf, zipfile.ZipFile(web_zip) as web_zf:
        py_names = [name for name in py_zf.namelist() if not name.endswith("/")]
        web_names = [name for name in web_zf.namelist() if not name.endswith("/")]
        py_canon = {canonical_zip_name(name): name for name in py_names}
        web_canon = {canonical_zip_name(name): name for name in web_names}
        artifact_summary = append_full_artifact_inventory(report, py_zf, web_zf, py_canon, web_canon)
        report.extend([
            "## File/package Parity",
            f"Python files: {len(py_names)}",
            f"Web files: {len(web_names)}",
            f"Missing in web: {sorted(set(py_canon) - set(web_canon))}",
            f"Extra in web: {sorted(set(web_canon) - set(py_canon))}",
            f"File list status: {'MATCH' if set(py_canon) == set(web_canon) else 'DIFFER'}",
            "",
            "### PNG dimensions",
        ])
        png_dimension_mismatches = 0
        for canon in sorted(set(py_canon) & set(web_canon)):
            if not canon.lower().endswith(".png"):
                continue
            py_size = read_png_size(py_zf.read(py_canon[canon]))
            web_size = read_png_size(web_zf.read(web_canon[canon]))
            png_dimension_mismatches += int(py_size != web_size)
            report.append(f"- `{canon}`: python={py_size}, web={web_size}, match={py_size == web_size}")
        report.append(f"PNG dimensions status: {'MATCH' if png_dimension_mismatches == 0 else 'DIFFER'}")
        report.extend(["", "### TXT presence", *text_presence_lines(py_canon, web_canon)])

        workbooks: dict[tuple[str, str], Workbook] = {}
        sheet_order_mismatches = 0
        report.extend(["", "### Workbook sheet order"])
        for canon in sorted(set(py_canon) & set(web_canon)):
            if not canon.lower().endswith(".xlsx"):
                continue
            kind = workbook_kind(canon)
            if not kind:
                continue
            py_wb = read_workbook(py_zf, py_canon[canon])
            web_wb = read_workbook(web_zf, web_canon[canon])
            workbooks[("python", kind)] = py_wb
            workbooks[("web", kind)] = web_wb
            sheet_order_mismatches += int(py_wb.order != web_wb.order)
            report.append(f"#### {kind}")
            report.append(f"sheet_order_match={py_wb.order == web_wb.order}")
            report.append(f"python_order={py_wb.order}")
            report.append(f"web_order={web_wb.order}")
        report.append(f"Workbook sheet-order status: {'MATCH' if sheet_order_mismatches == 0 else 'DIFFER'}")

        workbook_status = append_workbook_deep_audit(report, workbooks, artifact_summary)

        report.extend(["", "## Workbook Shape/Header/Numeric Overview"])
        for kind in ["DIAGNOSTICS", "REPORT"]:
            py_wb = workbooks.get(("python", kind))
            web_wb = workbooks.get(("web", kind))
            if not py_wb or not web_wb:
                continue
            report.append(f"### {kind}")
            for sheet in KEY_SHEETS[kind]:
                py_rows = py_wb.sheets.get(sheet, [])
                web_rows = web_wb.sheets.get(sheet, [])
                py_header = py_rows[0] if py_rows else []
                web_header = web_rows[0] if web_rows else []
                extension_columns = WEB_VALIDATION_EXTENSION_COLUMNS.get((kind, sheet), [])
                web_without_extensions = [header for header in web_header if header not in extension_columns]
                intentional_extension = bool(extension_columns) and py_header == web_without_extensions
                header_match = py_header == web_header
                header_status = "MATCH" if header_match else ("WEB_VALIDATION_EXTENSION" if intentional_extension else "DIFFER")
                report.append(f"- `{sheet}`: shape python={sheet_shape(py_rows)}, web={sheet_shape(web_rows)}, header_status={header_status}")
                if py_header != web_header:
                    report.append(f"  - python_header={py_header}")
                    report.append(f"  - web_header={web_header}")
                    if intentional_extension:
                        present_extensions = [header for header in extension_columns if header in web_header]
                        report.append(f"  - intentional_web_validation_columns={present_extensions}")
                checks = NUMERIC_CHECKS.get((kind, sheet))
                if checks:
                    for line in numeric_stats(py_rows, web_rows, checks):
                        report.append(f"  - {line}")

        py_diag = workbooks.get(("python", "DIAGNOSTICS"), Workbook("", {}, []))
        web_diag = workbooks.get(("web", "DIAGNOSTICS"), Workbook("", {}, []))
        py_report = workbooks.get(("python", "REPORT"), Workbook("", {}, []))
        web_report = workbooks.get(("web", "REPORT"), Workbook("", {}, []))

        report.extend(["", "## Geometry Comparison"])
        py_qc = rows_as_dicts(py_diag.sheets.get("05_GEOMETRY_QC", []))
        web_qc = rows_as_dicts(web_diag.sheets.get("05_GEOMETRY_QC", []))
        py_bottom = rows_as_dicts(py_diag.sheets.get("06_WELL_BOTTOM", []))
        web_bottom = rows_as_dicts(web_diag.sheets.get("06_WELL_BOTTOM", []))
        report.extend(["### 05_GEOMETRY_QC first row"])
        report.extend(first_row_comparison(py_qc, web_qc, [
            ("well", "Well"),
            ("floor_source", "floor_source"),
            ("pitch_px", "local_pitch_px"),
            ("mouth_r", "mouth_r"),
            ("floor_r", "floor_r"),
            ("mouth_to_floor_ratio", "shift_frac_of_mouth_r"),
            ("floor_to_mouth_ratio", "floor_to_mouth_r_ratio"),
        ]))
        report.extend(["### 05_GEOMETRY_QC numeric summary"])
        report.extend(numeric_delta_summary(py_qc, web_qc, [
            ("pitch_px", "local_pitch_px"),
            ("mouth_r", "mouth_r"),
            ("floor_r", "floor_r"),
            ("shift_px", "shift_px"),
            ("mouth_to_floor_ratio", "shift_frac_of_mouth_r"),
            ("floor_to_mouth_ratio", "floor_to_mouth_r_ratio"),
        ]))
        report.extend(["### 06_WELL_BOTTOM first row"])
        report.extend(first_row_comparison(py_bottom, web_bottom, [
            ("well", "Well"),
            ("pitch_px", "local_pitch_px"),
            ("cyl_r_bg", "cyl_r_bg"),
            ("mouth_r_geom", "mouth_r_geom"),
            ("floor_r_geom", "floor_r_geom"),
            ("mouth_cx", "mouth_cx"),
            ("mouth_cy", "mouth_cy"),
            ("floor_cx", "floor_cx"),
            ("floor_cy", "floor_cy"),
            ("floor_r", "floor_r"),
            ("shift_px", "shift_px"),
        ]))
        report.extend(["### 06_WELL_BOTTOM numeric summary"])
        report.extend(numeric_delta_summary(py_bottom, web_bottom, [
            ("pitch_px", "local_pitch_px"),
            ("cyl_r_bg", "cyl_r_bg"),
            ("mouth_r_geom", "mouth_r_geom"),
            ("floor_r_geom", "floor_r_geom"),
            ("mouth_r", "mouth_r"),
            ("floor_r", "floor_r"),
            ("shift_px", "shift_px"),
        ]))
        if py_bottom and web_bottom:
            py_shift_x = as_float(py_bottom[0].get("floor_cx", "")) - as_float(py_bottom[0].get("mouth_cx", ""))
            py_shift_y = as_float(py_bottom[0].get("floor_cy", "")) - as_float(py_bottom[0].get("mouth_cy", ""))
            web_shift_x = as_float(web_bottom[0].get("floor_cx", "")) - as_float(web_bottom[0].get("mouth_cx", ""))
            web_shift_y = as_float(web_bottom[0].get("floor_cy", "")) - as_float(web_bottom[0].get("mouth_cy", ""))
            report.append(f"- first-row floor_shift_x: python=`{py_shift_x}`, web=`{web_shift_x}`")
            report.append(f"- first-row floor_shift_y: python=`{py_shift_y}`, web=`{web_shift_y}`")

        py_geometry = canonical_geometry_from_diagnostics("python", python_zip, py_diag)
        web_geometry = canonical_geometry_from_diagnostics("web", web_zip, web_diag)
        shared_geometry_files = write_shared_geometry_diagnostics(py_geometry, web_geometry, shared_geometry_dir)
        append_shared_geometry_parity_section(report, py_geometry, web_geometry, shared_geometry_files)
        append_shared_geometry_override_residual_audit(report, py_report, web_report, py_diag, web_diag, py_geometry, web_geometry)

        report.extend(["", "## BG Sample Comparison"])
        py_bg = rows_as_dicts(py_diag.sheets.get("02_BG_SAMPLES", []))
        web_bg = rows_as_dicts(web_diag.sheets.get("02_BG_SAMPLES", []))
        for index in range(min(5, len(py_bg), len(web_bg))):
            py_row = py_bg[index]
            web_row = web_bg[index]
            cell_id = f"{row_value(py_row, 'BG_Cell_Row')}:{row_value(py_row, 'BG_Cell_Col')}"
            blank_fields = [field for field in ["x", "y", "Red_median_raw", "Green_median_raw", "Blue_median_raw"] if str(web_row.get(field, "")).strip() == ""]
            report.append(f"- sample {index + 1}, cell {cell_id}, associated={row_value(py_row, 'Associated_Wells')}")
            for label, field in [("x centroid", "x"), ("y centroid", "y"), ("area", "area"), ("Red_median_raw", "Red_median_raw"), ("Green_median_raw", "Green_median_raw"), ("Blue_median_raw", "Blue_median_raw")]:
                report.append(f"  - {label}: python=`{py_row.get(field, '')}`, web=`{web_row.get(field, '')}`")
            for label, field in [
                ("web sampled final accepted points", "Web_Sampled_Final_Accepted_Pixels"),
                ("web full-res after well exclusion", "Web_FullRes_After_Well_Exclusion"),
                ("web full-res final accepted pixels", "Web_FullRes_Final_Accepted_Pixels"),
                ("web projected cell area px", "Web_Projected_Cell_Area_Px"),
            ]:
                if field in web_row:
                    report.append(f"  - {label}: web=`{web_row.get(field, '')}`")
            rgb_diffs = [
                abs(as_float(py_row.get(field, "")) - as_float(web_row.get(field, "")))
                for field in ["Red_median_raw", "Green_median_raw", "Blue_median_raw"]
                if math.isfinite(as_float(py_row.get(field, ""))) and math.isfinite(as_float(web_row.get(field, "")))
            ]
            area_py = as_float(py_row.get("area", ""))
            area_web = as_float(web_row.get("area", ""))
            sampled_web = as_float(web_row.get("Web_Sampled_Final_Accepted_Pixels", ""))
            if rgb_diffs and math.isfinite(area_py) and math.isfinite(area_web):
                report.append(
                    "  - classification: "
                    f"rgb_mean_abs_diff={statistics.fmean(rgb_diffs):.4g}; "
                    f"area_abs_diff={abs(area_py - area_web):.4g}; "
                    f"area_ratio_web_over_python={(area_web / area_py) if abs(area_py) > 1e-12 else math.nan:.4g}; "
                    f"sampled_count_ratio_web_over_python={(sampled_web / area_py) if math.isfinite(sampled_web) and abs(area_py) > 1e-12 else math.nan:.4g}"
                )
            report.append(f"  - web blank fields: {blank_fields}")
        report.extend(["### BG sample numeric summary"])
        report.extend(numeric_delta_summary(py_bg, web_bg, [
            ("x centroid", "x"),
            ("y centroid", "y"),
            ("area", "area"),
            ("Red_median_raw", "Red_median_raw"),
            ("Green_median_raw", "Green_median_raw"),
            ("Blue_median_raw", "Blue_median_raw"),
        ]))

        append_upstream_fit_input_parity_audit(report, py_report, web_report, py_diag, web_diag)
        append_process_parity_section(report, py_report, web_report, py_diag, web_diag)
        append_36w_o_pabs_audit_trace(report, py_report, web_report)
        append_score_method_parity_section(
            report,
            py_report.sheets.get("07_METHOD_COMPARISON", []),
            web_report.sheets.get("07_METHOD_COMPARISON", []),
        )

        report.extend(["", "## Extraction/Numeric Comparison"])
        py_raw = rows_as_dicts(py_report.sheets.get("04_RAW", []))
        web_raw = rows_as_dicts(web_report.sheets.get("04_RAW", []))
        py_fit = rows_as_dicts(py_report.sheets.get("06_FITTING", []))
        web_fit = rows_as_dicts(web_report.sheets.get("06_FITTING", []))
        py_cmp = rows_as_dicts(py_report.sheets.get("07_METHOD_COMPARISON", []))
        web_cmp = rows_as_dicts(web_report.sheets.get("07_METHOD_COMPARISON", []))
        py_cielab = rows_as_dicts(py_diag.sheets.get("11_CIELAB_FITTING", []))
        web_cielab = rows_as_dicts(web_diag.sheets.get("11_CIELAB_FITTING", []))
        report.extend(["### REPORT / 04_RAW PAbs"])
        report.extend(numeric_delta_summary(py_raw, web_raw, [
            ("PAbs_Red", "PAbs_Red"),
            ("PAbs_Green", "PAbs_Green"),
            ("PAbs_Blue", "PAbs_Blue"),
        ]))
        report.extend(["### REPORT / 06_FITTING"])
        report.extend(numeric_delta_summary(py_fit, web_fit, [
            ("n_points", "n_points"),
            ("slope", "m"),
            ("intercept", "q"),
            ("R2", "R2"),
            ("C0", "C0"),
            ("C0_sd", "C0_sd"),
        ]))
        report.extend(["### REPORT / 07_METHOD_COMPARISON"])
        report.append(f"- python method order: {method_order(py_cmp)}")
        report.append(f"- web method order: {method_order(web_cmp)}")
        report.extend(numeric_delta_summary(py_cmp, web_cmp, [
            ("Score", "Score"),
            ("BaseScore", "BaseScore"),
        ]))
        report.extend(["### DIAGNOSTICS / 11_CIELAB_FITTING first rows"])
        for index in range(min(5, len(py_cielab), len(web_cielab))):
            report.append(f"- row {index + 1}: python Channel=`{py_cielab[index].get('Channel', '')}`, FitType=`{py_cielab[index].get('FitType', '')}`; web Channel=`{web_cielab[index].get('Channel', '')}`, FitType=`{web_cielab[index].get('FitType', '')}`")
        report.extend(numeric_delta_summary(py_cielab, web_cielab, [
            ("n_points", "n_points"),
            ("slope", "m"),
            ("intercept", "q"),
            ("R2", "R2"),
            ("C0", "C0"),
            ("C0_sd", "C0_sd"),
        ]))

        report.extend(["", "## Text Files"])
        for canon in sorted(set(py_canon) & set(web_canon)):
            if not canon.lower().endswith(".txt"):
                continue
            py_text = py_zf.read(py_canon[canon]).decode("utf-8", errors="replace")
            web_text = web_zf.read(web_canon[canon]).decode("utf-8", errors="replace")
            report.append(f"### {canon}")
            for line in compare_text(py_text, web_text):
                report.append(f"- {line}")

        text_status = append_txt_caption_audit(report, py_zf, web_zf, py_canon, web_canon, artifact_summary)
        png_results = append_png_visual_audit(report, py_zf, web_zf, py_canon, web_canon, visual_dir, artifact_summary)
        append_artifact_parity_summary(report, artifact_summary, png_results, text_status, workbook_status)

        append_score_centered_summary(
            report,
            py_report.sheets.get("07_METHOD_COMPARISON", []),
            web_report.sheets.get("07_METHOD_COMPARISON", []),
        )
        append_full_artifact_audit_conclusion(
            report,
            py_canon,
            web_canon,
            png_results,
            text_status,
            workbook_status,
            py_report,
            web_report,
        )
        append_cause_classification(report)
        append_next_blocks(report)

    return "\n".join(report) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python-zip", type=Path, default=DEFAULT_PYTHON_ZIP)
    parser.add_argument("--web-zip", type=Path, default=DEFAULT_WEB_ZIP)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--visual-dir", type=Path, default=DEFAULT_VISUAL_DIR)
    parser.add_argument("--shared-geometry-dir", type=Path, default=DEFAULT_SHARED_GEOMETRY_DIR)
    args = parser.parse_args()
    text = compare(args.python_zip, args.web_zip, args.visual_dir, args.shared_geometry_dir)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(text, encoding="utf-8")
    output_encoding = sys.stdout.encoding or "utf-8"
    print(text.encode(output_encoding, errors="replace").decode(output_encoding, errors="replace"))
    print(f"Wrote {args.report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
