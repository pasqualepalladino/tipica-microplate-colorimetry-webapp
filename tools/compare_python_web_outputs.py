#!/usr/bin/env python3
"""Compare Python and web TIPICA output ZIPs without third-party dependencies."""

from __future__ import annotations

import argparse
import math
import re
import statistics
import zipfile
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


@dataclass
class Workbook:
    name: str
    sheets: dict[str, list[list[str]]]
    order: list[str]


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
        "- Method-comparison `BaseScore`/ranking/name differences: **D/B depending on fresh export**. Header/name/reporting differences are D; residual score differences after a fresh export may indicate B or input-data differences.",
        "- CIELAB fitting extra or differently named rows in web ZIP: **D** for naming/reporting; residual numerical differences after row-name parity may be **A/B**.",
        "- `BG_STAT_MASK` overlay vs Python binary mask: **E/F** unless the web output intentionally remains documented as an overlay.",
        "- TXT caption differences: **F**, with some intentional beta transparency where web semantics are not yet Python-identical.",
    ])


def append_next_blocks(report: list[str]) -> None:
    report.extend([
        "",
        "## Next-block Recommendations",
        "- **Block B:** run a shared-geometry/background-mask test using identical manual geometry and the new web full-resolution area/sampled-count diagnostics.",
        "- **Block C:** implement shared geometry import/export or a geometry equivalence test.",
        "- **Block D:** add a process-parity test from a shared extracted intermediate table.",
        "- **Block E:** perform graphical/TXT parity cleanup after data structures are correct.",
    ])


def compare(python_zip: Path, web_zip: Path) -> str:
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

        append_cause_classification(report)
        append_next_blocks(report)

    return "\n".join(report) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python-zip", type=Path, default=DEFAULT_PYTHON_ZIP)
    parser.add_argument("--web-zip", type=Path, default=DEFAULT_WEB_ZIP)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    args = parser.parse_args()
    text = compare(args.python_zip, args.web_zip)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(text, encoding="utf-8")
    print(text)
    print(f"Wrote {args.report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
