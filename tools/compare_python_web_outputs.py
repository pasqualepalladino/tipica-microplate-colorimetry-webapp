#!/usr/bin/env python3
"""Compare Python and web TIPICA output ZIPs without third-party dependencies."""

from __future__ import annotations

import argparse
import difflib
import math
import re
import statistics
import sys
import zipfile
import zlib
from dataclasses import dataclass
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


def approximate_pabs_contributions(py_row: dict[str, str], web_row: dict[str, str], label: str) -> tuple[float, float]:
    py_w = as_float(py_row.get(f"MeanW_{label}", ""))
    web_w = as_float(web_row.get(f"MeanW_{label}", ""))
    py_bg = as_float(py_row.get(f"MeanBG_{label}", ""))
    web_bg = as_float(web_row.get(f"MeanBG_{label}", ""))
    well_term = abs((web_w - py_w) / (py_w * math.log(10))) if math.isfinite(py_w) and math.isfinite(web_w) and py_w > 0 else math.nan
    bg_term = abs((web_bg - py_bg) / (py_bg * math.log(10))) if math.isfinite(py_bg) and math.isfinite(web_bg) and py_bg > 0 else math.nan
    return well_term, bg_term


def append_meanw_meanbg_bridge_audit(report: list[str], py_report: Workbook, web_report: Workbook) -> dict[str, float]:
    py_raw = rows_as_dicts(py_report.sheets.get("04_RAW", []))
    web_raw = rows_as_dicts(web_report.sheets.get("04_RAW", []))
    py_by_key, web_by_key, common = paired_by_keys(py_raw, web_raw, ["Well"])
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
            f"approx_contribution MeanW={stats_cell(statistics.fmean(well_terms) if well_terms else math.nan)}, "
            f"MeanBG={stats_cell(statistics.fmean(bg_terms) if bg_terms else math.nan)}; "
            f"dominant={'MeanW' if well_terms and bg_terms and statistics.fmean(well_terms) > statistics.fmean(bg_terms) else 'MeanBG or mixed'}"
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
    pabs_metrics = append_meanw_meanbg_bridge_audit(report, py_report, web_report)
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


def compare(python_zip: Path, web_zip: Path, visual_dir: Path = DEFAULT_VISUAL_DIR) -> str:
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
    args = parser.parse_args()
    text = compare(args.python_zip, args.web_zip, args.visual_dir)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(text, encoding="utf-8")
    output_encoding = sys.stdout.encoding or "utf-8"
    print(text.encode(output_encoding, errors="replace").decode(output_encoding, errors="replace"))
    print(f"Wrote {args.report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
