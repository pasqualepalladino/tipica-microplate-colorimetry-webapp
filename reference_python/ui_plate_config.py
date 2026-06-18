# -*- coding: utf-8 -*-
"""
Tkinter UI to define plate layouts for supported microplate formats.

This UI collects:
- Concentration value per well
- Type tag per well: C (Calibration), A (Standard additions), U (Unknown)
- Optional per-well ID override inside the cell text
- Dilution factor (DF) per row
- Sample ID per row
- Unit label

The UI returns a config dict:
{
  "unit": "<unit label>",
  "data": {(r,c): (conc, type, df, id), ...}
}
"""

import tkinter as tk
from tkinter import ttk, simpledialog, messagebox, filedialog
import math
import re
import csv
import time
from pathlib import Path
try:
    from .config_io import load_all_config, save_all_config
except Exception:
    from config_io import load_all_config, save_all_config


PLATE_FORMATS = {
    "6-well (2 x 3)": (2, 3),
    "12-well (3 x 4)": (3, 4),
    "24-well (4 x 6)": (4, 6),
    "48-well (6 x 8)": (6, 8),
    "96-well (8 x 12)": (8, 12),
    "384-well (16 x 24)": (16, 24),
    "1536-well (32 x 48)": (32, 48),
}


def _plate_label_from_dims(nrow, ncol):
    dims = (int(nrow), int(ncol))
    for label, pair in PLATE_FORMATS.items():
        if pair == dims:
            return label
    return "96-well (8 x 12)"


def _row_label_from_index(idx):
    idx = int(idx)
    label = ""
    while True:
        idx, rem = divmod(idx, 26)
        label = chr(ord("A") + rem) + label
        if idx == 0:
            return label
        idx -= 1


def _row_index_from_label(label):
    s = ''.join(ch for ch in str(label).strip().upper() if ch.isalpha())
    if not s:
        raise ValueError("invalid row label")
    out = 0
    for ch in s:
        out = out * 26 + (ord(ch) - ord("A") + 1)
    return out - 1


class PlateLayoutUI:
    def __init__(self):
        self.root = tk.Tk()
        # Keep the window hidden until the Tk event loop has started and the
        # final content-based geometry has been computed. Calling deiconify()
        # only from run() avoids the visible create-resize-replace effect.
        self.root.withdraw()
        self._initial_show_done = False
        self._layout_update_suspended = False
        self.root.title("Plate configuration")
        # Keep the configurator at the optimized content size; prevent the
        # window manager maximize button from expanding empty space.
        self.root.resizable(False, False)
        self.result = None
        self.saved_config = load_all_config() or {}

        self.nrow = int(self.saved_config.get("nrow", 8))
        self.ncol = int(self.saved_config.get("ncol", 12))
        if (self.nrow, self.ncol) not in set(PLATE_FORMATS.values()):
            self.nrow, self.ncol = 8, 12
        last_plate = self.saved_config.get("last_plate", {}) or {}
        self.root.title(f"Plate configuration ({self.nrow} x {self.ncol})")

        # 1) Experiment setup: define the plate and configuration first.
        self.setup_box = ttk.LabelFrame(self.root, text="Experiment setup")
        self.setup_box.pack(anchor="w", padx=8, pady=(6, 2))

        self.plate_tools = ttk.Frame(self.setup_box)
        self.plate_tools.pack(anchor="w", padx=5, pady=(2, 1))

        self.extended_view_var = tk.BooleanVar(value=bool(self.saved_config.get("extended_view", True)))
        ttk.Checkbutton(self.plate_tools, text="Extended view", variable=self.extended_view_var, command=self._update_extended_view).pack(side="left", padx=(0, 12))

        self.unit_var = tk.StringVar(value=self.saved_config.get("unit", "mM"))
        ttk.Label(self.plate_tools, text="Unit").pack(side="left")
        self.unit_label_widget = self.plate_tools.winfo_children()[-1]
        self.unit_combo = ttk.Combobox(
            self.plate_tools, textvariable=self.unit_var, values=["M", "mM", "µM", "nM"], width=6, state="readonly"
        )
        self.unit_combo.pack(side="left", padx=6)

        self.exp_var = tk.StringVar(value=self.saved_config.get("exp", "0"))
        self.exp_label_widget = ttk.Label(self.plate_tools, text=" x 10^")
        self.exp_label_widget.pack(side="left")
        self.exp_entry_widget = ttk.Entry(self.plate_tools, textvariable=self.exp_var, width=5)
        self.exp_entry_widget.pack(side="left", padx=(0, 16))

        self.plate_format_var = tk.StringVar(value=_plate_label_from_dims(self.nrow, self.ncol))
        ttk.Label(self.plate_tools, text="Plate format").pack(side="left")
        self.plate_format_combo = ttk.Combobox(
            self.plate_tools, textvariable=self.plate_format_var, values=list(PLATE_FORMATS.keys()),
            width=20, state="readonly"
        )
        self.plate_format_combo.pack(side="left", padx=6)
        self.plate_format_combo.bind("<<ComboboxSelected>>", self._on_plate_format_changed)
        self.help_button = ttk.Button(self.plate_tools, text="?", width=3, command=self.show_about_and_help)
        self.help_button.pack(side="left", padx=(2, 0))

        self.config_tools = ttk.Frame(self.setup_box)
        self.config_tools.pack(anchor="w", padx=6, pady=(1, 3))
        self.save_config_button = ttk.Button(self.config_tools, text="SAVE CONFIG", command=self.save_config_named)
        self.save_config_button.pack(side="left", padx=(0, 5))
        self.saved_config_names = self._get_saved_config_names()
        self.selected_preset_var = tk.StringVar(value=self.saved_config_names[0] if self.saved_config_names else "")
        self.saved_config_label = ttk.Label(self.config_tools, text="Saved config")
        self.saved_config_label.pack(side="left", padx=(10, 4))
        self.saved_config_combo = ttk.Combobox(self.config_tools, textvariable=self.selected_preset_var, values=self.saved_config_names, width=22, state="readonly")
        self.saved_config_combo.pack(side="left", padx=4)
        self.load_selected_button = ttk.Button(self.config_tools, text="LOAD SELECTED CONFIG", command=self.load_selected_config)
        self.load_selected_button.pack(side="left", padx=5)
        self.export_template_button = ttk.Button(self.config_tools, text="EXPORT CSV TEMPLATE", command=self.export_plate_map_template_csv)
        self.export_template_button.pack(side="left", padx=(12, 5))
        self.import_csv_button = ttk.Button(self.config_tools, text="IMPORT CSV", command=self.import_plate_map_csv)
        self.import_csv_button.pack(side="left", padx=5)

        # Keep a non-UI compatibility flag for old saved configurations.
        # Window size is always naturally limited to 85% of the screen.
        self.full_page_var = tk.BooleanVar(value=False)

        # 2) Analysis options: define how the plate map will be interpreted.
        self.options = ttk.LabelFrame(self.root, text="Analysis options")
        self.options.pack(anchor="w", padx=8, pady=(0, 2))

        self.use_stored_cal_var = tk.BooleanVar(value=bool(self.saved_config.get("use_stored_calibration", False)))
        self.save_raw_data_details_var = tk.BooleanVar(value=bool(self.saved_config.get("save_raw_data_details", self.saved_config.get("save_diagnostics", False))))
        self.initial_image_qc_var = tk.BooleanVar(value=True)
        self.id_df_priority_var = tk.StringVar(value=str(self.saved_config.get("id_df_priority", "row")).lower())
        if self.id_df_priority_var.get() not in {"row", "col"}:
            self.id_df_priority_var.set("row")

        self.use_stored_cal_check = ttk.Checkbutton(self.options, text="Use stored calibration", variable=self.use_stored_cal_var, command=self.toggle_stored_calibration)
        self.use_stored_cal_check.grid(row=0, column=0, sticky="w", padx=(8, 10), pady=2)
        ttk.Checkbutton(self.options, text="Save raw data details", variable=self.save_raw_data_details_var).grid(row=0, column=1, sticky="w", padx=(0, 12), pady=2)
        ttk.Label(self.options, text="ID/DF priority").grid(row=0, column=2, sticky="w", padx=(0, 4), pady=2)
        ttk.Radiobutton(self.options, text="Rows", variable=self.id_df_priority_var, value="row", command=self._update_id_df_priority_widgets).grid(row=0, column=3, sticky="w", padx=(0, 2), pady=2)
        ttk.Radiobutton(self.options, text="Columns", variable=self.id_df_priority_var, value="col", command=self._update_id_df_priority_widgets).grid(row=0, column=4, sticky="w", padx=(0, 8), pady=2)

        self.expected_box = ttk.LabelFrame(self.root, text="Reference values")
        self.expected_box.pack(anchor="w", padx=8, pady=(0, 2))
        self.expected_rows_frame = ttk.Frame(self.expected_box)
        self.expected_rows_frame.grid(row=0, column=0, sticky="w", padx=2, pady=2)
        self.expected_ref_entries = []
        ttk.Button(self.expected_box, text="+", width=3, command=self.add_expected_ref_row).grid(row=0, column=1, padx=(6, 2), pady=2, sticky="w")
        ttk.Button(self.expected_box, text="-", width=3, command=self.remove_expected_ref_row).grid(row=0, column=2, padx=(0, 4), pady=2, sticky="w")

        expected_refs = self._get_initial_expected_refs()
        if not expected_refs:
            expected_refs = [{}]
        for item in expected_refs:
            self.add_expected_ref_row(item)

        # 4) Plate map editor tools: fill or modify the experimental table before image input.
        self.plate_map_tools = ttk.LabelFrame(self.root, text="Plate map editor")
        self.plate_map_tools.pack(anchor="w", padx=8, pady=(0, 2))
        self.copy_row_button = ttk.Button(self.plate_map_tools, text="COPY ROW A", command=self.copy_row)
        self.copy_row_button.pack(side="left", padx=(6, 4), pady=3)
        self.copy_col_button = ttk.Button(self.plate_map_tools, text="COPY COL 1", command=self.copy_col)
        self.copy_col_button.pack(side="left", padx=4, pady=3)
        self.grid_note_label = ttk.Label(
            self.plate_map_tools,
            text="Empty cell = no data (0 is treated as a value).",
        )
        self.grid_note_label.pack(side="left", padx=(14, 6), pady=3)

        self._build_plate_grid(last_plate)
        self._apply_window_size_policy()
        self.id_df_priority_var.trace_add("write", lambda *_: self._update_id_df_priority_widgets())
        self.toggle_stored_calibration()
        self._update_extended_view()
        self._update_id_df_priority_widgets()
        self._repack_main_sections()
        # The window is intentionally not shown here. It is displayed once,
        # from run(), after the event loop has processed pending geometry tasks.
        self.root.update_idletasks()

    def _finalize_initial_show(self):
        if getattr(self, "_initial_show_done", False):
            return
        self._initial_show_done = True
        try:
            # Compute and freeze the final content-based geometry while hidden.
            self.root.update_idletasks()
            self._apply_window_size_policy()
            self.root.update_idletasks()

            geom = self.root.geometry().split("+")[0]
            try:
                width, height = [int(x) for x in geom.split("x")[:2]]
            except Exception:
                width = int(self.root.winfo_reqwidth())
                height = int(self.root.winfo_reqheight())

            sw = int(self.root.winfo_screenwidth())
            sh = int(self.root.winfo_screenheight())
            x = max(0, int((sw - width) / 2))
            y = max(0, int((sh - height) / 2))

            self.root.geometry(f"{width}x{height}+{x}+{y}")
            self.root.minsize(width, height)
            self.root.maxsize(width, height)
            self.root.resizable(False, False)
            self.root.update_idletasks()

            # Single visible mapping operation.
            self.root.deiconify()
            self.root.lift()
        except Exception:
            try:
                self.root.deiconify()
            except Exception:
                pass

    @staticmethod
    def _is_finite_number(value):
        try:
            return math.isfinite(float(value))
        except Exception:
            return False

    @staticmethod
    def _parse_optional_float(text):
        s = str(text).strip().replace(",", ".")
        if not s:
            return float("nan")
        try:
            v = float(s)
            return v if math.isfinite(v) else float("nan")
        except Exception:
            return float("nan")

    @staticmethod
    def _normalize_cell_tokens(text):
        raw_tokens = [tok for tok in str(text).strip().split() if tok]
        out = []
        for tok in raw_tokens:
            s = str(tok).strip()
            if not s:
                continue
            m_num = re.match(r'^([+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+))(U|UNK|UNKNOWN|C|A)(.+)?$', s, flags=re.IGNORECASE)
            if m_num:
                out.append(m_num.group(1))
                out.append(m_num.group(2).upper())
                tail = (m_num.group(3) or '').strip()
                if tail:
                    out.append(tail)
                continue
            m_type = re.match(r'^(U|UNK|UNKNOWN|C|A)(.+)$', s, flags=re.IGNORECASE)
            if m_type:
                out.append(m_type.group(1).upper())
                tail = (m_type.group(2) or '').strip()
                if tail:
                    out.append(tail)
                continue
            out.append(s)
        return out

    @staticmethod
    def _is_type_token(token):
        return str(token).strip().upper() in {"U", "UNK", "UNKNOWN", "C", "A"}

    @staticmethod
    def _looks_like_number_token(token):
        try:
            float(str(token).strip().replace(",", "."))
            return True
        except Exception:
            return False

    def _split_override_id_df_tokens(self, tokens):
        override_df = float("nan")
        override_tokens = list(tokens)
        if override_tokens and self._looks_like_number_token(override_tokens[-1]):
            try:
                override_df = float(str(override_tokens[-1]).strip().replace(",", "."))
                override_tokens = override_tokens[:-1]
            except Exception:
                override_df = float("nan")
        override_id = " ".join([str(tok).strip() for tok in override_tokens if str(tok).strip()]).strip()
        return override_id, override_df

    def _parse_cell_entry(self, text, row_id_default):
        tokens = self._normalize_cell_tokens(text)
        if not tokens:
            return None

        first = tokens[0].upper()
        if first in {"U", "UNK", "UNKNOWN"}:
            typ = "U"
            conc = float("nan")
            override_id, override_df = self._split_override_id_df_tokens(tokens[1:])
            return conc, typ, (override_id or str(row_id_default).strip()), override_df

        conc = float(tokens[0].replace(",", "."))
        typ = "A"
        override_tokens = []
        if len(tokens) >= 2:
            second = tokens[1].upper()
            if second in {"C", "A", "U", "UNK", "UNKNOWN"}:
                typ = "U" if second in {"U", "UNK", "UNKNOWN"} else second
                override_tokens = tokens[2:]
            else:
                override_tokens = tokens[1:]
        override_id, override_df = self._split_override_id_df_tokens(override_tokens)
        return conc, typ, (override_id or str(row_id_default).strip()), override_df

    def _rebuild_cell_with_tag(self, text, tag):
        tokens = self._normalize_cell_tokens(text)
        if not tokens:
            return str(tag)
        first = tokens[0]
        rest = tokens[1:]
        if rest and self._is_type_token(rest[0]):
            rest = rest[1:]
        out = [first, str(tag)] + rest
        return " ".join([tok for tok in out if str(tok).strip()])

    def _get_initial_expected_refs(self):
        refs = self.saved_config.get("expected_refs", None)
        out = []
        if isinstance(refs, list):
            for item in refs:
                if not isinstance(item, dict):
                    continue
                value = self._parse_optional_float(item.get("value", ""))
                sd = self._parse_optional_float(item.get("sd", ""))
                if not math.isfinite(value):
                    continue
                out.append({
                    "id": str(item.get("id", item.get("ref_id", ""))).strip(),
                    "label": str(item.get("label", "")).strip(),
                    "value": value,
                    "sd": sd if math.isfinite(sd) else float("nan"),
                })
        if out:
            return out

        legacy_candidates = [
            ("ICP-MS", self.saved_config.get("expected_icpms_value", self.saved_config.get("expected_icpms", "")), self.saved_config.get("expected_icpms_sd", "")),
            ("Colorimetry", self.saved_config.get("expected_colorimetry_value", self.saved_config.get("expected_colorimetry", "")), self.saved_config.get("expected_colorimetry_sd", "")),
            (str(self.saved_config.get("expected_label", "")).strip(), self.saved_config.get("expected_value", ""), self.saved_config.get("expected_sd", "")),
        ]
        seen = set()
        for label, value_raw, sd_raw in legacy_candidates:
            value = self._parse_optional_float(value_raw)
            sd = self._parse_optional_float(sd_raw)
            if not math.isfinite(value):
                continue
            key = (label, value, sd if math.isfinite(sd) else None)
            if key in seen:
                continue
            seen.add(key)
            out.append({"id": "", "label": label, "value": value, "sd": sd if math.isfinite(sd) else float("nan")})
        return out

    def add_expected_ref_row(self, item=None):
        item = item or {}
        ref_id_var = tk.StringVar(value=str(item.get("id", item.get("ref_id", ""))))
        label_var = tk.StringVar(value=str(item.get("label", "")))
        value_var = tk.StringVar(value="" if not self._is_finite_number(item.get("value", float("nan"))) else str(item.get("value")))
        sd_var = tk.StringVar(value="" if not self._is_finite_number(item.get("sd", float("nan"))) else str(item.get("sd")))
        row_index = len(self.expected_ref_entries)
        ttk.Label(self.expected_rows_frame, text="Ref ID").grid(row=row_index, column=0, padx=(4, 2), pady=2, sticky="w")
        ttk.Entry(self.expected_rows_frame, textvariable=ref_id_var, width=6).grid(row=row_index, column=1, padx=(0, 6), pady=2, sticky="w")
        ttk.Label(self.expected_rows_frame, text="Label").grid(row=row_index, column=2, padx=(0, 2), pady=2, sticky="w")
        ttk.Entry(self.expected_rows_frame, textvariable=label_var, width=18).grid(row=row_index, column=3, padx=(0, 6), pady=2, sticky="w")
        ttk.Label(self.expected_rows_frame, text="Value").grid(row=row_index, column=4, padx=(0, 2), pady=2, sticky="w")
        ttk.Entry(self.expected_rows_frame, textvariable=value_var, width=10).grid(row=row_index, column=5, padx=(0, 6), pady=2, sticky="w")
        ttk.Label(self.expected_rows_frame, text="SD").grid(row=row_index, column=6, padx=(0, 2), pady=2, sticky="w")
        ttk.Entry(self.expected_rows_frame, textvariable=sd_var, width=8).grid(row=row_index, column=7, padx=(0, 4), pady=2, sticky="w")
        self.expected_ref_entries.append({"id": ref_id_var, "label": label_var, "value": value_var, "sd": sd_var})

    def remove_expected_ref_row(self):
        if len(self.expected_ref_entries) <= 1:
            return
        for w in self.expected_rows_frame.grid_slaves(row=len(self.expected_ref_entries)-1):
            w.destroy()
        self.expected_ref_entries.pop()

    def _collect_expected_refs(self):
        rows = []
        seen = set()
        for entry in getattr(self, "expected_ref_entries", []):
            ref_id = str(entry.get("id", tk.StringVar(value="")).get()).strip()
            label = str(entry["label"].get()).strip()
            value = self._parse_optional_float(entry["value"].get())
            sd = self._parse_optional_float(entry["sd"].get())
            if not math.isfinite(value):
                continue
            key = (ref_id, label, value, sd if math.isfinite(sd) else None)
            if key in seen:
                continue
            seen.add(key)
            rows.append({
                "id": ref_id,
                "label": label,
                "value": value,
                "sd": sd if math.isfinite(sd) else float("nan"),
            })
        return rows

    def _get_saved_config_names(self):
        cfg = load_all_config() or {}
        names = []
        for k in cfg.keys():
            if str(k).startswith("preset_"):
                names.append(str(k)[7:])
        names.sort()
        return names

    def _refresh_saved_config_combo(self, preferred=None):
        self.saved_config_names = self._get_saved_config_names()
        if hasattr(self, "saved_config_combo"):
            self.saved_config_combo["values"] = self.saved_config_names
        if preferred in self.saved_config_names:
            self.selected_preset_var.set(preferred)
        elif self.saved_config_names:
            self.selected_preset_var.set(self.saved_config_names[0])
        else:
            self.selected_preset_var.set("")

    def show_about_and_help(self):
        msg = (
            "SAM Plate Analyzer\n\n"
            "How to use\n"
            "- Fill only wells that contain data. Empty cell = no data (0 is treated as a value).\n"
            "- Use COPY ROW A or COPY COL 1 to propagate a pattern quickly.\n"
            "- Type buttons U/C/A apply a tag to the whole row.\n"
            "- In simplified view, advanced blocks are hidden.\n\n"
            "Header block\n"
            "- Unit and x 10^ define the displayed concentration unit.\n"
            "- SAVE CONFIG stores the current layout/options as a preset.\n"
            "- LOAD SELECTED restores a saved preset.\n"
            "- Extended view shows or hides advanced blocks for small screens / simple runs.\n\n"
            "Analysis options block\n"
            "- Use stored calibration: disables direct entry of calibration wells and reuses the stored calibration file.\n"
            "- All points are always used in fitting.\n"
            "- Fitting uses robust residual-based IRLS linear regression; all finite points are retained.\n"
            "- RGB signal is fixed to full background normalization. The image is never modified.\n"
            "- Save raw data details: exports extended diagnostics/output files.\n"
            "- ID/DF priority: chooses whether row defaults or column defaults are applied first.\n"
            "  The non-priority defaults are shown disabled to avoid confusion.\n\n"
            "Reference values block\n"
            "- Label / Value / SD define external reference values for comparison.\n"
            "- + adds a row, - removes the last row (minimum one row remains).\n\n"
            "Cell syntax\n"
            "- value type\n"
            "- value type ID\n"
            "- value type ID DF\n"
            "- U ID\n"
            "- U ID DF\n"
            "Examples: 1.5 C | 1.5 C CRM | 1.5 C CRM 50 | U SampleX | U SampleX 10\n"
            "When present, cell overrides take priority over row/column defaults.\n\n"
            "Author / license / citation\n"
            "- This section can be expanded progressively with author, year, license, version, citation text, and printable notes.\n"
            "- It is intended to evolve into the help/about section of the future web app.\n"
        )
        messagebox.showinfo("Help / About", msg, parent=self.root)

    def _set_entry_enabled(self, widget, enabled):
        widget.state(["!disabled"] if enabled else ["disabled"])

    def _update_id_df_priority_widgets(self):
        use_col = self.id_df_priority_var.get() == "col"

        if use_col:
            self.df_header_label.grid_remove()
            self.id_header_label.grid_remove()
            self.col_df_label.grid()
            self.col_id_label.grid()
        else:
            self.df_header_label.grid()
            self.id_header_label.grid()
            self.col_df_label.grid_remove()
            self.col_id_label.grid_remove()

        for r in range(self.nrow):
            if use_col:
                self.df_entries[r].grid_remove()
                self.id_entries[r].grid_remove()
            else:
                self.df_entries[r].grid()
                self.id_entries[r].grid()
                self._set_entry_enabled(self.df_entries[r], True)
                self._set_entry_enabled(self.id_entries[r], True)

        for c in range(self.ncol):
            if use_col:
                self.df_col_entries[c].grid()
                self.id_col_entries[c].grid()
                self._set_entry_enabled(self.df_col_entries[c], True)
                self._set_entry_enabled(self.id_col_entries[c], True)
            else:
                self.df_col_entries[c].grid_remove()
                self.id_col_entries[c].grid_remove()

        self._apply_window_size_policy()

    def _repack_main_sections(self):
        """Keep the visual order of the main blocks stable.

        This only changes widget placement. It does not modify any parsing,
        configuration, image-input, or analysis logic.
        """
        try:
            if hasattr(self, "setup_box") and self.setup_box.winfo_exists():
                self.setup_box.pack_forget()
                self.setup_box.pack(anchor="w", padx=8, pady=(6, 2))
            if hasattr(self, "options") and self.options.winfo_exists() and self.options.winfo_manager():
                self.options.pack_forget()
                self.options.pack(anchor="w", padx=8, pady=(0, 2))
            if hasattr(self, "expected_box") and self.expected_box.winfo_exists() and self.expected_box.winfo_manager():
                self.expected_box.pack_forget()
                self.expected_box.pack(anchor="w", padx=8, pady=(0, 2))
            if hasattr(self, "plate_map_tools") and self.plate_map_tools.winfo_exists():
                self.plate_map_tools.pack_forget()
                self.plate_map_tools.pack(anchor="w", padx=8, pady=(0, 2))
            if hasattr(self, "grid_scroll_container") and self.grid_scroll_container.winfo_exists():
                self.grid_scroll_container.pack_forget()
                self.grid_scroll_container.pack(anchor="w", expand=False, padx=8, pady=(1, 2))
        except Exception:
            pass

    def _set_plate_cell_width_for_view(self, show_extended):
        try:
            if show_extended:
                width = 8 if self.ncol <= 12 else 6 if self.ncol <= 24 else 5
            else:
                width = 6 if self.ncol <= 12 else 5 if self.ncol <= 24 else 4
            for e in getattr(self, "cells", {}).values():
                e.configure(width=width)
            for e in getattr(self, "df_col_entries", {}).values():
                e.configure(width=width)
            for e in getattr(self, "id_col_entries", {}).values():
                e.configure(width=width)
        except Exception:
            pass

    def _update_extended_view(self):
        previous_suspend = bool(getattr(self, "_layout_update_suspended", False))
        self._layout_update_suspended = True
        try:
            show_extended = bool(self.extended_view_var.get())
            self._set_plate_cell_width_for_view(show_extended)
            before_widget = getattr(self, "grid_scroll_container", None)

            def _pack_before_grid(widget, **kwargs):
                if widget.winfo_manager():
                    return
                if before_widget is not None and before_widget.winfo_manager():
                    widget.pack(before=before_widget, **kwargs)
                else:
                    widget.pack(**kwargs)

            if show_extended:
                _pack_before_grid(self.options, anchor="w", padx=10, pady=(0, 4))
                _pack_before_grid(self.expected_box, anchor="w", padx=10, pady=(0, 4))
                if not self.exp_label_widget.winfo_manager():
                    self.exp_label_widget.pack(side="left", after=self.unit_combo)
                if not self.exp_entry_widget.winfo_manager():
                    self.exp_entry_widget.pack(side="left", after=self.exp_label_widget, padx=(0, 16))
                if not self.config_tools.winfo_manager():
                    self.config_tools.pack(anchor="w", padx=6, pady=(1, 3))
                if not self.save_config_button.winfo_manager():
                    self.save_config_button.pack(side="left", padx=5)
                if not self.saved_config_label.winfo_manager():
                    self.saved_config_label.pack(side="left", padx=(10, 4))
                if not self.saved_config_combo.winfo_manager():
                    self.saved_config_combo.pack(side="left", padx=4)
                if not self.load_selected_button.winfo_manager():
                    self.load_selected_button.pack(side="left", padx=5)
                if not self.export_template_button.winfo_manager():
                    self.export_template_button.pack(side="left", padx=(12, 5))
                if not self.import_csv_button.winfo_manager():
                    self.import_csv_button.pack(side="left", padx=5)
                self.row_header_label.grid()
                for w in self.row_default_widgets + self.col_default_widgets + self.default_header_widgets + self.type_widgets:
                    w.grid()
                for w in self.row_labels:
                    w.grid()
                self._update_id_df_priority_widgets()
            else:
                self.options.pack_forget()
                self.expected_box.pack_forget()
                self.exp_label_widget.pack_forget()
                self.exp_entry_widget.pack_forget()
                self.save_config_button.pack_forget()
                self.saved_config_label.pack_forget()
                self.saved_config_combo.pack_forget()
                self.load_selected_button.pack_forget()
                self.export_template_button.pack_forget()
                self.import_csv_button.pack_forget()
                self.config_tools.pack_forget()
                self.row_header_label.grid_remove()
                for w in self.row_default_widgets + self.col_default_widgets + self.default_header_widgets + self.type_widgets:
                    w.grid_remove()
                for w in self.row_labels:
                    w.grid()

            # Do not repack all main sections during simple extended/compact toggling:
            # repacking unchanged widgets causes visible redraws on Windows.
            # Geometry recalculation is performed only once below.
        finally:
            self._layout_update_suspended = previous_suspend

        if not previous_suspend:
            self._apply_window_size_policy()

    def move_focus(self, event, r, c):
        if event.keysym == "Up" and r > 0:
            self.cells[(r - 1, c)].focus_set()
        elif event.keysym == "Down" and r < self.nrow - 1:
            self.cells[(r + 1, c)].focus_set()
        elif event.keysym == "Left" and event.widget.index(tk.INSERT) == 0 and c > 0:
            self.cells[(r, c - 1)].focus_set()
        elif event.keysym == "Right" and event.widget.index(tk.INSERT) == len(event.widget.get()) and c < self.ncol - 1:
            self.cells[(r, c + 1)].focus_set()

    def move_focus_df(self, event, r):
        if event.keysym == "Up" and r > 0:
            self.df_entries[r - 1].focus_set()
        elif event.keysym == "Down" and r < self.nrow - 1:
            self.df_entries[r + 1].focus_set()
        elif event.keysym == "Right":
            self.id_entries[r].focus_set()

    def move_focus_id(self, event, r):
        if event.keysym == "Up" and r > 0:
            self.id_entries[r - 1].focus_set()
        elif event.keysym == "Down" and r < self.nrow - 1:
            self.id_entries[r + 1].focus_set()
        elif event.keysym == "Left" and event.widget.index(tk.INSERT) == 0:
            self.df_entries[r].focus_set()
        elif event.keysym == "Right":
            self.cells[(r, 0)].focus_set()


    def _on_grid_frame_configure(self, event=None):
        if hasattr(self, "grid_canvas"):
            self.grid_canvas.configure(scrollregion=self.grid_canvas.bbox("all"))

    def _on_grid_canvas_configure(self, event=None):
        # Do not stretch the inner grid: entry sizes remain fixed and scrollbars expose overflow.
        if hasattr(self, "grid_canvas"):
            self.grid_canvas.configure(scrollregion=self.grid_canvas.bbox("all"))

    def _on_mousewheel(self, event):
        if not hasattr(self, "grid_canvas"):
            return
        if getattr(event, "num", None) == 4:
            self.grid_canvas.yview_scroll(-1, "units")
        elif getattr(event, "num", None) == 5:
            self.grid_canvas.yview_scroll(1, "units")
        else:
            delta = int(-1 * (event.delta / 120)) if getattr(event, "delta", 0) else 0
            if delta:
                self.grid_canvas.yview_scroll(delta, "units")

    def _on_shift_mousewheel(self, event):
        if not hasattr(self, "grid_canvas"):
            return
        delta = int(-1 * (event.delta / 120)) if getattr(event, "delta", 0) else 0
        if delta:
            self.grid_canvas.xview_scroll(delta, "units")

    def _apply_window_size_policy(self):
        if getattr(self, "_layout_update_suspended", False):
            return
        try:
            self.root.update_idletasks()
            sw = int(self.root.winfo_screenwidth())
            sh = int(self.root.winfo_screenheight())
            max_w = max(480, int(sw * 0.85))
            max_h = max(320, int(sh * 0.85))

            margin_x = 20
            margin_y = 20
            scrollbar_extra_x = 20
            scrollbar_extra_y = 20

            # Use the actual canvas bounding box rather than the historical
            # requested grid size. This makes compact view shrink to the visible
            # plate map instead of reserving space for hidden row/column fields.
            grid_req_w = 0
            grid_req_h = 0
            if hasattr(self, "grid_canvas") and self.grid_canvas.winfo_exists():
                bbox = self.grid_canvas.bbox("all")
                if bbox:
                    grid_req_w = int(bbox[2] - bbox[0])
                    grid_req_h = int(bbox[3] - bbox[1])
            if (grid_req_w <= 0 or grid_req_h <= 0) and hasattr(self, "grid") and self.grid.winfo_exists():
                grid_req_w = int(self.grid.winfo_reqwidth())
                grid_req_h = int(self.grid.winfo_reqheight())

            children_h = 0
            children_w = 0
            for child in self.root.winfo_children():
                if hasattr(self, "grid_scroll_container") and child == self.grid_scroll_container:
                    continue
                try:
                    if child.winfo_manager():
                        children_h += int(child.winfo_reqheight())
                        children_w = max(children_w, int(child.winfo_reqwidth()))
                except Exception:
                    pass

            available_grid_w = max(240, max_w - margin_x - scrollbar_extra_x)
            available_grid_h = max(100, max_h - children_h - margin_y - scrollbar_extra_y)

            # Canvas is content-tight when possible. Scrollbars remain available
            # for larger formats or small screens.
            canvas_w = min(max(grid_req_w + 4, 240), available_grid_w)
            canvas_h = min(max(grid_req_h + scrollbar_extra_y + 4, 80), available_grid_h)

            if hasattr(self, "grid_canvas") and self.grid_canvas.winfo_exists():
                self.grid_canvas.configure(width=int(canvas_w), height=int(canvas_h))
                self.grid_canvas.configure(scrollregion=self.grid_canvas.bbox("all"))

            self.root.update_idletasks()
            req_w = max(children_w + margin_x, canvas_w + margin_x + scrollbar_extra_x, 360)
            req_h = max(children_h + canvas_h + margin_y + scrollbar_extra_y, 260)
            width = min(int(req_w), max_w)
            height = min(int(req_h), max_h)

            self.root.geometry(f"{width}x{height}")
            self.root.minsize(int(width), int(height))
            self.root.maxsize(int(width), int(height))
            self.root.resizable(False, False)
        except Exception:
            pass

    def _on_plate_format_changed(self, event=None):
        label = self.plate_format_var.get()
        if label not in PLATE_FORMATS:
            return
        new_nrow, new_ncol = PLATE_FORMATS[label]
        if (int(new_nrow), int(new_ncol)) == (int(self.nrow), int(self.ncol)):
            return
        if messagebox.askyesno(
            "Change plate format",
            "Changing plate format rebuilds the editable grid. Current well entries that fit the new format will be preserved. Continue?",
            parent=self.root,
        ):
            previous_suspend = bool(getattr(self, "_layout_update_suspended", False))
            self._layout_update_suspended = True
            try:
                self._rebuild_grid_for_plate_format(new_nrow, new_ncol)
            finally:
                self._layout_update_suspended = previous_suspend
            if not previous_suspend:
                self._apply_window_size_policy()
        else:
            self.plate_format_var.set(_plate_label_from_dims(self.nrow, self.ncol))

    def _snapshot_last_plate(self):
        out = {}
        for r in range(getattr(self, "nrow", 0)):
            if hasattr(self, "df_entries") and r in self.df_entries:
                out[f"df_{r}"] = self.df_entries[r].get()
            if hasattr(self, "id_vars") and r in self.id_vars:
                out[f"id_{r}"] = self.id_vars[r].get()
            for c in range(getattr(self, "ncol", 0)):
                if hasattr(self, "cells") and (r, c) in self.cells:
                    out[f"cell_{r}_{c}"] = self.cells[(r, c)].get()
        for c in range(getattr(self, "ncol", 0)):
            if hasattr(self, "df_col_entries") and c in self.df_col_entries:
                out[f"df_col_{c}"] = self.df_col_entries[c].get()
            if hasattr(self, "id_col_vars") and c in self.id_col_vars:
                out[f"id_col_{c}"] = self.id_col_vars[c].get()
        return out

    def _clear_grid_widgets(self):
        for name in ["grid_scroll_container", "grid_canvas", "grid", "image_input_row", "start_button"]:
            w = getattr(self, name, None)
            if w is not None:
                try:
                    w.destroy()
                except Exception:
                    pass

    def _rebuild_grid_for_plate_format(self, nrow, ncol, last_plate=None):
        preserved = self._snapshot_last_plate()
        if isinstance(last_plate, dict):
            preserved.update(last_plate)
        self._clear_grid_widgets()
        self.nrow = int(nrow)
        self.ncol = int(ncol)
        self.root.title(f"Plate configuration ({self.nrow} x {self.ncol})")
        self.plate_format_var.set(_plate_label_from_dims(self.nrow, self.ncol))
        self._build_plate_grid(preserved)
        self._update_extended_view()
        self._update_id_df_priority_widgets()
        self.toggle_stored_calibration()

    def _build_plate_grid(self, last_plate):
        self.syntax_row = None
        self.grid_scroll_container = ttk.Frame(self.root)
        self.grid_scroll_container.pack(anchor="w", expand=False, padx=8, pady=(1, 2))
        self.grid_scroll_container.rowconfigure(0, weight=1)
        self.grid_scroll_container.columnconfigure(0, weight=1)

        self.grid_canvas = tk.Canvas(self.grid_scroll_container, highlightthickness=0)
        self.grid_canvas.grid(row=0, column=0, sticky="nsew")
        self.grid_vscroll = ttk.Scrollbar(self.grid_scroll_container, orient="vertical", command=self.grid_canvas.yview)
        self.grid_vscroll.grid(row=0, column=1, sticky="ns")
        self.grid_hscroll = ttk.Scrollbar(self.grid_scroll_container, orient="horizontal", command=self.grid_canvas.xview)
        self.grid_hscroll.grid(row=1, column=0, sticky="ew")
        self.grid_canvas.configure(yscrollcommand=self.grid_vscroll.set, xscrollcommand=self.grid_hscroll.set)

        self.grid = ttk.Frame(self.grid_canvas)
        self._grid_canvas_window = self.grid_canvas.create_window((0, 0), window=self.grid, anchor="nw")
        self.grid.bind("<Configure>", self._on_grid_frame_configure)
        self.grid_canvas.bind("<Configure>", self._on_grid_canvas_configure)
        self.grid_canvas.bind_all("<MouseWheel>", self._on_mousewheel)
        self.grid_canvas.bind_all("<Shift-MouseWheel>", self._on_shift_mousewheel)
        self.grid_canvas.bind_all("<Button-4>", self._on_mousewheel)
        self.grid_canvas.bind_all("<Button-5>", self._on_mousewheel)

        self.cells, self.df_entries, self.id_entries, self.id_vars = {}, {}, {}, {}
        self.df_col_entries, self.id_col_entries, self.id_col_vars = {}, {}, {}
        self.row_tag_buttons = {}
        self.row_labels = []
        self.type_widgets = []
        self.row_default_widgets = []
        self.col_default_widgets = []
        self.default_header_widgets = []

        self.row_header_label = ttk.Label(self.grid, text="Row", font=("Arial", 12, "bold"))
        self.row_header_label.grid(row=0, column=0)
        self.df_header_label = ttk.Label(self.grid, text="DF", font=("Arial", 12, "bold"))
        self.df_header_label.grid(row=0, column=1)
        self.id_header_label = ttk.Label(self.grid, text="ID", font=("Arial", 12, "bold"))
        self.id_header_label.grid(row=0, column=2)
        self.type_header_label = ttk.Label(self.grid, text="Type", font=("Arial", 12, "bold"))
        self.type_header_label.grid(row=0, column=3)

        cell_width = 8 if self.ncol <= 12 else 6 if self.ncol <= 24 else 5
        for c in range(self.ncol):
            ttk.Label(self.grid, text=str(c + 1), font=("Arial", 12, "bold")).grid(row=0, column=4 + c, padx=1)

        self.col_df_label = ttk.Label(self.grid, text="Col DF", font=("Arial", 11, "bold"))
        self.col_df_label.grid(row=self.nrow + 1, column=3, sticky="e", padx=(0, 5), pady=(8, 1))
        self.col_id_label = ttk.Label(self.grid, text="Col ID", font=("Arial", 11, "bold"))
        self.col_id_label.grid(row=self.nrow + 2, column=3, sticky="e", padx=(0, 5), pady=(1, 0))
        self.default_header_widgets.extend([self.df_header_label, self.id_header_label, self.col_df_label, self.col_id_label])
        self.type_widgets.append(self.type_header_label)

        for r in range(self.nrow):
            let = _row_label_from_index(r)
            row_label = ttk.Label(self.grid, text=let, font=("Arial", 12, "bold"))
            row_label.grid(row=r + 1, column=0)
            self.row_labels.append(row_label)

            de = ttk.Entry(self.grid, width=5, justify="center")
            de.insert(0, last_plate.get(f"df_{r}", "1"))
            de.grid(row=r + 1, column=1)
            de.bind("<Key>", lambda event, row=r: self.move_focus_df(event, row))
            self.df_entries[r] = de
            self.row_default_widgets.append(de)

            id_v = tk.StringVar(value=last_plate.get(f"id_{r}", let))
            id_e = ttk.Entry(self.grid, textvariable=id_v, width=10)
            id_e.grid(row=r + 1, column=2)
            id_e.bind("<Key>", lambda event, row=r: self.move_focus_id(event, row))
            self.id_vars[r] = id_v
            self.id_entries[r] = id_e
            self.row_default_widgets.append(id_e)

            tag_f = ttk.Frame(self.grid)
            tag_f.grid(row=r + 1, column=3, padx=5)
            self.row_tag_buttons[r] = {}
            self.type_widgets.append(tag_f)
            for t in ["U", "C", "A"]:
                btn = ttk.Button(tag_f, text=t, width=2, command=lambda row=r, tag=t: self.tag_row(row, tag))
                btn.pack(side="left")
                self.row_tag_buttons[r][t] = btn

            for c in range(self.ncol):
                e = ttk.Entry(self.grid, width=cell_width)
                e.insert(0, last_plate.get(f"cell_{r}_{c}", ""))
                e.grid(row=r + 1, column=4 + c)
                self.cells[(r, c)] = e
                e.bind("<Key>", lambda event, row=r, col=c: self.move_focus(event, row, col))

        for c in range(self.ncol):
            df_e = ttk.Entry(self.grid, width=cell_width, justify="center")
            df_e.insert(0, last_plate.get(f"df_col_{c}", ""))
            df_e.grid(row=self.nrow + 1, column=4 + c, pady=(8, 1))
            self.df_col_entries[c] = df_e
            self.col_default_widgets.append(df_e)

            col_default_id = last_plate.get(f"id_col_{c}", str(c + 1))
            id_v = tk.StringVar(value=col_default_id)
            id_e = ttk.Entry(self.grid, textvariable=id_v, width=cell_width, justify="center")
            id_e.grid(row=self.nrow + 2, column=4 + c, pady=(1, 0))
            self.id_col_vars[c] = id_v
            self.id_col_entries[c] = id_e
            self.col_default_widgets.append(id_e)

        # Image input: keep the launch controls inside the plate-map area, just below the table.
        self.image_input_row = ttk.Frame(self.grid)
        self.image_input_row.grid(row=self.nrow + 3, column=0, columnspan=4 + self.ncol, sticky="w", pady=(6, 1))
        ttk.Label(self.image_input_row, text="After completing the plate map:").pack(side="left", padx=(0, 12))
        self.acquire_camera_button = ttk.Button(self.image_input_row, text="ACQUIRE FROM CAMERA", command=self.confirm_with_camera)
        self.acquire_camera_button.pack(side="left", padx=(0, 6))
        self.load_image_button = ttk.Button(self.image_input_row, text="LOAD IMAGE", command=self.confirm_with_image_file)
        self.load_image_button.pack(side="left", padx=(0, 8))

        self._set_plate_cell_width_for_view(bool(self.extended_view_var.get()))
        self._apply_window_size_policy()

    def _well_to_rc(self, well):
        well = str(well).strip()
        m = re.match(r"^([A-Za-z]+)(\d+)$", well)
        if not m:
            raise ValueError("invalid well name")
        rr = _row_index_from_label(m.group(1))
        cc = int(m.group(2)) - 1
        if rr < 0 or rr >= self.nrow or cc < 0 or cc >= self.ncol:
            raise ValueError("well outside selected plate format")
        return rr, cc

    def export_plate_map_template_csv(self):
        path = filedialog.asksaveasfilename(
            parent=self.root,
            title="Export plate map template",
            defaultextension=".csv",
            filetypes=[("CSV files", "*.csv"), ("All files", "*.*")],
        )
        if not path:
            return
        try:
            with open(path, "w", newline="", encoding="utf-8") as f:
                wr = csv.writer(f)
                wr.writerow(["Well", "Conc", "Type", "ID", "DF"])
                for r in range(self.nrow):
                    for c in range(self.ncol):
                        well = f"{_row_label_from_index(r)}{c + 1}"
                        txt = self.cells.get((r, c)).get().strip() if (r, c) in self.cells else ""
                        conc, typ, id_c, df = "", "", "", ""
                        if txt:
                            try:
                                default_id, default_df = self._get_default_id_df_for_position(r, c)
                                parsed = self._parse_cell_entry(txt, default_id)
                                if parsed is not None:
                                    conc_v, typ_v, id_v, df_override = parsed
                                    conc = "" if not math.isfinite(conc_v) else conc_v
                                    typ = typ_v
                                    id_c = id_v
                                    df = df_override if math.isfinite(df_override) else default_df
                            except Exception:
                                pass
                        wr.writerow([well, conc, typ, id_c, df])
            messagebox.showinfo("Export complete", "Plate map template exported.", parent=self.root)
        except Exception as exc:
            messagebox.showerror("Export failed", str(exc), parent=self.root)

    def import_plate_map_csv(self):
        path = filedialog.askopenfilename(
            parent=self.root,
            title="Import plate map CSV",
            filetypes=[("CSV files", "*.csv"), ("All files", "*.*")],
        )
        if not path:
            return
        try:
            with open(path, "r", newline="", encoding="utf-8-sig") as f:
                sample = f.read(4096)
                f.seek(0)
                dialect = csv.Sniffer().sniff(sample, delimiters=",;\t") if sample.strip() else csv.excel
                rd = csv.DictReader(f, dialect=dialect)
                if not rd.fieldnames:
                    raise ValueError("CSV has no header")
                headers = {h.strip().lower(): h for h in rd.fieldnames if h is not None}
                def get(row, *names):
                    for name in names:
                        h = headers.get(name.lower())
                        if h is not None:
                            return str(row.get(h, "")).strip()
                    return ""
                imported = 0
                for row in rd:
                    well = get(row, "Well")
                    if not well:
                        continue
                    r, c = self._well_to_rc(well)
                    conc = get(row, "Conc", "Concentration")
                    typ = get(row, "Type") or "U"
                    sid = get(row, "ID", "SampleID", "Sample_ID")
                    df = get(row, "DF", "Dilution", "DilutionFactor")
                    typ_u = typ.upper()
                    if typ_u in {"UNKNOWN", "UNK"}:
                        typ_u = "U"
                    if typ_u not in {"U", "C", "A"}:
                        typ_u = "U"
                    tokens = []
                    if typ_u == "U" and not conc:
                        tokens.append("U")
                    else:
                        tokens.append(conc if conc else "0")
                        tokens.append(typ_u)
                    if sid:
                        tokens.append(sid)
                    if df:
                        tokens.append(df)
                    e = self.cells[(r, c)]
                    e.state(["!disabled"])
                    e.delete(0, tk.END)
                    e.insert(0, " ".join(str(t) for t in tokens if str(t).strip()))
                    imported += 1
            self.toggle_stored_calibration()
            messagebox.showinfo("Import complete", f"Imported {imported} wells from CSV.", parent=self.root)
        except Exception as exc:
            messagebox.showerror("Import failed", str(exc), parent=self.root)

    def _cell_has_tag_c(self, entry_widget):
        txt = [t.upper() for t in self._normalize_cell_tokens(entry_widget.get())]
        return len(txt) >= 2 and txt[1] == "C"

    def toggle_stored_calibration(self):
        use = self.use_stored_cal_var.get()
        for r in range(self.nrow):
            btn_c = self.row_tag_buttons[r].get("C")
            if btn_c is not None:
                btn_c.state(["disabled"] if use else ["!disabled"])
            for c in range(self.ncol):
                e = self.cells[(r, c)]
                if use and self._cell_has_tag_c(e):
                    e.state(["disabled"])
                else:
                    e.state(["!disabled"])

    def tag_row(self, row, tag):
        if tag == "C" and self.use_stored_cal_var.get():
            return
        for c in range(self.ncol):
            e = self.cells[(row, c)]
            if str(e.cget("state")) == "disabled":
                continue
            rebuilt = self._rebuild_cell_with_tag(e.get(), tag)
            e.delete(0, tk.END)
            e.insert(0, rebuilt)
        self.toggle_stored_calibration()

    def _get_default_id_df_for_position(self, r, c):
        row_id = self.id_vars[r].get().strip()
        col_id = self.id_col_vars[c].get().strip()
        row_df = self._parse_optional_float(self.df_entries[r].get())
        col_df = self._parse_optional_float(self.df_col_entries[c].get())

        if self.id_df_priority_var.get() == "col":
            id_default = col_id or row_id
            df_default = col_df if math.isfinite(col_df) else row_df
        else:
            id_default = row_id or col_id
            df_default = row_df if math.isfinite(row_df) else col_df

        if not str(id_default).strip():
            id_default = row_id or col_id or _row_label_from_index(r)
        if not math.isfinite(df_default):
            df_default = 1.0
        return str(id_default).strip(), float(df_default)

    def _collect_current_state(self):
        unit = self.unit_var.get()
        exp = self.exp_var.get().strip()
        unit_label = unit if exp in ("", "0") else f"{unit} 10^{exp}"

        result = {
            "unit": unit_label,
            "nrow": self.nrow,
            "ncol": self.ncol,
            "plate_format": _plate_label_from_dims(self.nrow, self.ncol),
            "data": {},
            "use_stored_calibration": self.use_stored_cal_var.get(),
            "save_raw_data_details": self.save_raw_data_details_var.get(),
            "save_diagnostics": self.save_raw_data_details_var.get(),
            "expected_refs": self._collect_expected_refs(),
            "use_background_subtraction": True,
            "initial_image_qc_enabled": True,
            "blank_mode": "both",
            "id_df_priority": self.id_df_priority_var.get(),
            "extended_view": bool(self.extended_view_var.get()),
            "plate_config_full_page": False,
        }
        plate_save = {}
        for (r, c), e in self.cells.items():
            txt = e.get().strip()
            plate_save[f"cell_{r}_{c}"] = txt
            if not txt:
                continue
            try:
                default_id, default_df = self._get_default_id_df_for_position(r, c)
                parsed = self._parse_cell_entry(txt, default_id)
                if parsed is None:
                    continue
                conc, typ, id_c, df_override = parsed
                df_final = float(df_override) if math.isfinite(df_override) else float(default_df)
                result["data"][(r, c)] = (conc, typ, df_final, id_c)
            except Exception:
                pass
        for r in range(self.nrow):
            plate_save[f"df_{r}"] = self.df_entries[r].get()
            plate_save[f"id_{r}"] = self.id_vars[r].get()
        for c in range(self.ncol):
            plate_save[f"df_col_{c}"] = self.df_col_entries[c].get()
            plate_save[f"id_col_{c}"] = self.id_col_vars[c].get()
        save_payload = {
            "last_plate": plate_save,
            "unit": unit,
            "exp": exp,
            "nrow": self.nrow,
            "ncol": self.ncol,
            "use_stored_calibration": self.use_stored_cal_var.get(),
            "save_raw_data_details": self.save_raw_data_details_var.get(),
            "save_diagnostics": self.save_raw_data_details_var.get(),
            "expected_refs": self._collect_expected_refs(),
            "use_background_subtraction": True,
            "initial_image_qc_enabled": True,
            "blank_mode": "both",
            "id_df_priority": self.id_df_priority_var.get(),
            "extended_view": bool(self.extended_view_var.get()),
            "plate_config_full_page": False,
        }
        return result, save_payload

    def _apply_preset_to_ui(self, preset):
        if not isinstance(preset, dict):
            return

        # Loading a preset can rebuild the grid and toggle several view states.
        # Suspend geometry recalculation during these intermediate operations so
        # the user sees only the final settled layout, not a sequence of
        # resize/repaint steps.
        previous_suspend = bool(getattr(self, "_layout_update_suspended", False))
        self._layout_update_suspended = True
        try:
            self.use_stored_cal_var.set(bool(preset.get("use_stored_calibration", self.use_stored_cal_var.get())))
            self.save_raw_data_details_var.set(bool(preset.get("save_raw_data_details", preset.get("save_diagnostics", self.save_raw_data_details_var.get()))))
            self.initial_image_qc_var.set(True)
            self.id_df_priority_var.set(str(preset.get("id_df_priority", self.id_df_priority_var.get())).lower())
            if self.id_df_priority_var.get() not in {"row", "col"}:
                self.id_df_priority_var.set("row")
            self.extended_view_var.set(bool(preset.get("extended_view", self.extended_view_var.get())))
            if hasattr(self, "full_page_var"):
                self.full_page_var.set(False)
            unit_label = str(preset.get("unit", self.unit_var.get()))
            if " 10^" in unit_label:
                unit, exp = unit_label.split(" 10^", 1)
                self.unit_var.set(unit)
                self.exp_var.set(exp)
            else:
                self.unit_var.set(unit_label)
                self.exp_var.set("0")

            expected_refs = preset.get("expected_refs", self._get_initial_expected_refs())
            while len(self.expected_ref_entries) < max(1, len(expected_refs)):
                self.add_expected_ref_row()
            for i, entry in enumerate(getattr(self, "expected_ref_entries", [])):
                item = expected_refs[i] if i < len(expected_refs) else {}
                if "id" in entry:
                    entry["id"].set(str(item.get("id", item.get("ref_id", ""))))
                entry["label"].set(str(item.get("label", "")))
                entry["value"].set("" if not self._is_finite_number(item.get("value", float("nan"))) else str(item.get("value")))
                entry["sd"].set("" if not self._is_finite_number(item.get("sd", float("nan"))) else str(item.get("sd")))

            preset_nrow = int(preset.get("nrow", self.nrow))
            preset_ncol = int(preset.get("ncol", self.ncol))
            last_plate = preset.get("last_plate", {}) or {}
            if (preset_nrow, preset_ncol) != (self.nrow, self.ncol) and (preset_nrow, preset_ncol) in set(PLATE_FORMATS.values()):
                self._rebuild_grid_for_plate_format(preset_nrow, preset_ncol, last_plate=last_plate)
            for r in range(self.nrow):
                self.df_entries[r].delete(0, tk.END)
                self.df_entries[r].insert(0, last_plate.get(f"df_{r}", self.df_entries[r].get()))
                self.id_vars[r].set(last_plate.get(f"id_{r}", self.id_vars[r].get()))
                for c in range(self.ncol):
                    self.cells[(r, c)].state(["!disabled"])
                    self.cells[(r, c)].delete(0, tk.END)
                    self.cells[(r, c)].insert(0, last_plate.get(f"cell_{r}_{c}", ""))
            for c in range(self.ncol):
                self.df_col_entries[c].delete(0, tk.END)
                self.df_col_entries[c].insert(0, last_plate.get(f"df_col_{c}", self.df_col_entries[c].get()))
                self.id_col_vars[c].set(last_plate.get(f"id_col_{c}", self.id_col_vars[c].get()))
            self.toggle_stored_calibration()
            self._apply_window_size_policy()

        finally:
            self._layout_update_suspended = previous_suspend
        if not previous_suspend:
            self._apply_window_size_policy()

    def save_config_named(self):
        name = simpledialog.askstring("Save config", "Configuration name:", parent=self.root)
        if not name:
            return
        _, save_payload = self._collect_current_state()
        save_all_config({f"preset_{name}": save_payload})
        self._refresh_saved_config_combo(preferred=name)
        messagebox.showinfo("Saved", f"Configuration '{name}' saved.", parent=self.root)

    def load_selected_config(self):
        name = self.selected_preset_var.get().strip()
        if not name:
            messagebox.showerror("Not found", "No saved configuration selected.", parent=self.root)
            return
        cfg = load_all_config() or {}
        preset = cfg.get(f"preset_{name}")
        if not isinstance(preset, dict):
            messagebox.showerror("Not found", f"Configuration '{name}' not found.", parent=self.root)
            return
        self._apply_preset_to_ui(preset)

    def copy_row(self):
        for r in range(1, self.nrow):
            self.df_entries[r].delete(0, tk.END)
            self.df_entries[r].insert(0, self.df_entries[0].get())
            self.id_vars[r].set(self.id_vars[0].get())
            for c in range(self.ncol):
                self.cells[(r, c)].state(["!disabled"])
                self.cells[(r, c)].delete(0, tk.END)
                self.cells[(r, c)].insert(0, self.cells[(0, c)].get())
        self.toggle_stored_calibration()

    def copy_col(self):
        for c in range(1, self.ncol):
            self.df_col_entries[c].delete(0, tk.END)
            self.df_col_entries[c].insert(0, self.df_col_entries[0].get())
            self.id_col_vars[c].set(self.id_col_vars[0].get())
            for r in range(self.nrow):
                self.cells[(r, c)].state(["!disabled"])
                self.cells[(r, c)].delete(0, tk.END)
                self.cells[(r, c)].insert(0, self.cells[(r, 0)].get())
        self.toggle_stored_calibration()

    def _finish_with_image(self, image_path, image_source):
        if not image_path:
            return
        self.result, save_payload = self._collect_current_state()
        self.result["image_path"] = str(image_path)
        self.result["image_source"] = str(image_source)
        save_payload["last_image_path"] = str(image_path)
        save_payload["last_image_source"] = str(image_source)
        save_all_config(save_payload)
        self.root.destroy()

    def confirm_with_image_file(self):
        path = filedialog.askopenfilename(
            parent=self.root,
            title="Select plate image",
            filetypes=[
                ("Image files", "*.png *.jpg *.jpeg *.tif *.tiff *.bmp"),
                ("All files", "*.*"),
            ],
        )
        if not path:
            return
        self._finish_with_image(path, "file")

    def _capture_image_from_camera(self):
        try:
            import cv2
        except Exception as exc:
            messagebox.showerror("Camera error", f"OpenCV is required for camera acquisition.\n\n{exc}", parent=self.root)
            return None

        cap = cv2.VideoCapture(0)
        if not cap.isOpened():
            messagebox.showerror("Camera error", "No camera could be opened.", parent=self.root)
            return None

        win = "SAM Plate Analyzer - camera capture"
        captured = None
        try:
            cv2.namedWindow(win, cv2.WINDOW_NORMAL)
            while True:
                ok, frame = cap.read()
                if not ok or frame is None:
                    messagebox.showerror("Camera error", "Could not read from camera.", parent=self.root)
                    return None
                preview = frame.copy()
                cv2.putText(
                    preview,
                    "SPACE/ENTER/C = capture | ESC/Q = cancel",
                    (20, 35),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.8,
                    (255, 255, 255),
                    2,
                    cv2.LINE_AA,
                )
                cv2.imshow(win, preview)
                key = cv2.waitKey(30) & 0xFF
                if key in (27, ord("q"), ord("Q")):
                    return None
                if key in (13, 32, ord("c"), ord("C")):
                    captured = frame.copy()
                    break
        finally:
            cap.release()
            try:
                cv2.destroyWindow(win)
            except Exception:
                cv2.destroyAllWindows()

        if captured is None:
            return None

        out_dir = Path.cwd() / "CAPTURED_IMAGES"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / ("camera_capture_" + time.strftime("%Y%m%d_%H%M%S") + ".png")
        if not cv2.imwrite(str(out_path), captured):
            messagebox.showerror("Camera error", "Could not save captured image.", parent=self.root)
            return None
        return str(out_path)

    def confirm_with_camera(self):
        path = self._capture_image_from_camera()
        if not path:
            return
        self._finish_with_image(path, "camera")

    def confirm(self):
        # Backward-compatible fallback for external callers.
        self.confirm_with_image_file()

    def run(self):
        # Display the configurator only after all startup geometry has been calculated.
        self._finalize_initial_show()
        self.root.mainloop()
        return self.result
