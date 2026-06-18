# -*- coding: utf-8 -*-
"""
SAM Plate Analyzer — modular entrypoint.

Desktop flow:
- Plate layout UI
- Image selection
- Alignment viewer
- Thread-safe wait window during Analyzer.run()

Analytical logic is not modified here.
"""

import threading
import json
from pathlib import Path
import traceback
import sys
import types
import tkinter as tk
from tkinter import filedialog, messagebox, ttk


def _ensure_local_sam_plate_analyzer_package():
    """Prefer modules located next to this entrypoint.

    This makes the distributed single-folder version behave like the installed
    sam_plate_analyzer package, so relative imports inside analyzer/viewer/UI
    keep working and the UI file next to this script is the one actually used.
    """
    local_dir = Path(__file__).resolve().parent
    required = [
        "ui_plate_config.py",
        "analyzer.py",
        "viewer.py",
        "config_io.py",
        "roi_geometry.py",
        "roi_io.py",
        "roi_overlay.py",
    ]
    if not all((local_dir / name).exists() for name in required):
        return
    pkg = types.ModuleType("sam_plate_analyzer")
    pkg.__path__ = [str(local_dir)]
    pkg.__file__ = str(local_dir / "__init__.py")
    sys.modules["sam_plate_analyzer"] = pkg
    if str(local_dir) not in sys.path:
        sys.path.insert(0, str(local_dir))


_ensure_local_sam_plate_analyzer_package()

from sam_plate_analyzer.ui_plate_config import PlateLayoutUI
from sam_plate_analyzer.analyzer import Analyzer
from sam_plate_analyzer.viewer import PlateAlignViewer4Point
from sam_plate_analyzer.config_io import load_all_config, save_all_config


# Automatic analysis downscaling. Viewer and Analyzer use the SAME resized image,
# so all geometry coordinates remain consistent.
# Set to None to analyze the original full-resolution image.
# The resized image is kept in RAM only: no extra folder, no duplicate image.
MAX_ANALYSIS_SIDE = 2000


def _load_analysis_image(original_path: str, max_side: int | None):
    import cv2

    img = cv2.imread(original_path)
    if img is None:
        return None, 1.0

    h, w = img.shape[:2]
    if max_side is None:
        return img, 1.0

    scale = min(1.0, float(max_side) / float(max(h, w)))
    if scale >= 0.999999:
        return img, 1.0

    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    img_small = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
    return img_small, scale


def _initial_image_qc(img_bgr, nrow=8, ncol=12):
    """Fast pre-analysis QC based on image size and blur.

    This check is intentionally conservative. It does not replace well-level QC;
    it only prevents cryptic failures on images that are too small or too blurred.
    """
    import cv2
    import numpy as np

    if img_bgr is None:
        return {"status": "FAIL", "messages": ["image could not be opened"]}

    h, w = img_bgr.shape[:2]
    max_side = max(int(w), int(h))
    min_side = min(int(w), int(h))
    messages = [f"analysis image size: {w} x {h} px"]

    # Very rough expected pixel pitch from image width. This is intentionally only a pre-check.
    approx_pitch_x = float(w) / max(1.0, float(ncol + 1))
    approx_pitch_y = float(h) / max(1.0, float(nrow + 1))
    approx_pitch = min(approx_pitch_x, approx_pitch_y)
    approx_floor_diam = 0.72 * approx_pitch
    approx_roi_pixels = 3.14159 * (0.5 * approx_floor_diam) ** 2

    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    # Downsample for a stable and fast blur estimate on large images.
    g = gray
    if max_side > 1200:
        scale = 1200.0 / float(max_side)
        g = cv2.resize(gray, (max(1, int(round(w * scale))), max(1, int(round(h * scale)))), interpolation=cv2.INTER_AREA)
    blur_score = float(cv2.Laplacian(g, cv2.CV_64F).var())

    messages.append(f"approx well pitch: {approx_pitch:.1f} px")
    messages.append(f"approx ROI pixels/well: {approx_roi_pixels:.0f}")
    messages.append(f"blur score: {blur_score:.1f}")

    status = "OK"
    if max_side < 900 or approx_roi_pixels < 120:
        status = "FAIL"
        messages.append("resolution too low for reliable ROI statistics")
    elif max_side < 1500 or approx_roi_pixels < 300:
        status = "WARNING"
        messages.append("borderline resolution: concentration uncertainty may be larger")

    if blur_score < 18.0:
        status = "FAIL" if status == "FAIL" else "WARNING"
        messages.append("image appears blurred or low-detail")
    elif blur_score < 35.0 and status == "OK":
        status = "WARNING"
        messages.append("image sharpness is borderline")

    return {"status": status, "messages": messages}


def _handle_initial_image_qc(root, qc_payload):
    status = str((qc_payload or {}).get("status", "OK")).upper()
    messages = list((qc_payload or {}).get("messages", []) or [])
    text = "Initial image QC: " + status + "\n\n" + "\n".join("- " + str(m) for m in messages)
    if status == "OK":
        print(text)
        return True
    if status == "WARNING":
        print(text)
        return messagebox.askyesno("Initial image QC warning", text + "\n\nContinue anyway?", parent=root)
    print(text)
    return messagebox.askyesno("Initial image QC failed", text + "\n\nAnalysis is not recommended. Continue anyway?", parent=root)

def _stored_geometry_matches_image(stored_cfg: dict, img_bgr) -> bool:
    if img_bgr is None:
        return False
    h, w = img_bgr.shape[:2]
    try:
        return int(stored_cfg.get("analysis_image_width", -1)) == int(w) and int(stored_cfg.get("analysis_image_height", -1)) == int(h)
    except Exception:
        return False


def _save_analysis_geometry_image_size(img_bgr):
    if img_bgr is None:
        return
    h, w = img_bgr.shape[:2]
    try:
        save_all_config({
            "analysis_image_width": int(w),
            "analysis_image_height": int(h),
            "analysis_max_side": None if MAX_ANALYSIS_SIDE is None else int(MAX_ANALYSIS_SIDE),
        })
    except Exception:
        pass


def _fourcorner_sidecar_path(image_path: str) -> str:
    p = Path(image_path)
    return str(p.with_name(p.stem + "_4corner_wells.json"))


def _apply_fourcorner_geometry_to_cfg(cfg: dict, img_path: str, geo: dict | None):
    if not geo:
        return cfg
    out = dict(cfg)
    corner_keys = ["corner_a1", "corner_a12", "corner_h12", "corner_h1"]
    extra_keys = ["corner_c4", "corner_c9", "corner_f9", "corner_f4"]
    floor_keys = ["floor_a1_circle_img", "floor_a12_circle_img", "floor_h12_circle_img", "floor_h1_circle_img"]
    if all(k in geo and geo.get(k) is not None for k in corner_keys):
        for k in corner_keys + extra_keys + floor_keys:
            if k in geo and geo.get(k) is not None:
                out[k] = geo[k]
        sidecar = {k: geo[k] for k in corner_keys + extra_keys + floor_keys if k in geo and geo.get(k) is not None}
        sidecar_path = _fourcorner_sidecar_path(img_path)
        out["fourcorner_geometry_path"] = sidecar_path
        try:
            Path(sidecar_path).write_text(json.dumps(sidecar, indent=2), encoding="utf-8")
        except Exception:
            pass
    return out


class AnalysisWaitWindow:
    """Thread-safe wait window with lightweight RGB spring animation."""

    def __init__(self, parent: tk.Tk):
        self.parent = parent
        self.win = tk.Toplevel(parent)
        self.win.title("Processing")
        self.win.resizable(False, False)
        self.win.protocol("WM_DELETE_WINDOW", lambda: None)

        outer = ttk.Frame(self.win, padding=12)
        outer.pack(fill="both", expand=True)

        ttk.Label(outer, text="Image analysis in progress...").pack(pady=(0, 8))

        self.canvas = tk.Canvas(
            outer,
            width=220,
            height=220,
            highlightthickness=0,
            bd=0,
            bg="white",
        )
        self.canvas.pack()

        self.status_var = tk.StringVar(value="Please wait")
        ttk.Label(outer, textvariable=self.status_var).pack(pady=(8, 0))

        self._center_x = 110
        self._center_y = 110
        self._amp = 44
        self._radius = 38
        self._tick = 0
        self._running = True

        self._items = {
            "red": self.canvas.create_oval(0, 0, 0, 0, fill="#ff0000", outline=""),
            "green": self.canvas.create_oval(0, 0, 0, 0, fill="#00ff00", outline=""),
            "blue": self.canvas.create_oval(0, 0, 0, 0, fill="#0000ff", outline=""),
            "white": self.canvas.create_oval(0, 0, 0, 0, fill="#ffffff", outline="", state="hidden"),
        }

        self._position_window()
        self._force_show()
        self._animate()

    def _position_window(self):
        self.win.update_idletasks()
        w = self.win.winfo_reqwidth()
        h = self.win.winfo_reqheight()

        sw = self.win.winfo_screenwidth()
        sh = self.win.winfo_screenheight()

        x = max(0, (sw - w) // 2)
        y = max(0, (sh - h) // 2)
        self.win.geometry(f"{w}x{h}+{x}+{y}")

    def _force_show(self):
        self.win.deiconify()
        self.win.lift()
        try:
            self.win.attributes("-topmost", True)
        except Exception:
            pass
        self.win.update_idletasks()
        self.win.update()
        try:
            self.win.after(300, lambda: self.win.attributes("-topmost", False))
        except Exception:
            pass

    @staticmethod
    def _interp_rgb(c1, c2, t):
        return tuple(int(round(a + (b - a) * t)) for a, b in zip(c1, c2))

    @staticmethod
    def _to_hex(rgb):
        return "#{:02x}{:02x}{:02x}".format(*rgb)

    def _set_circle(self, item_id, cx, cy, r, fill):
        self.canvas.coords(item_id, cx - r, cy - r, cx + r, cy + r)
        self.canvas.itemconfigure(item_id, fill=fill)

    def _animate(self):
        if not self._running:
            return

        import math

        phase = 2.0 * math.pi * (self._tick / 180.0)
        s = math.cos(phase)

        cx = self._center_x
        cy = self._center_y
        a = self._amp
        r = self._radius

        red_xy = (cx, cy - a * s)
        green_xy = (cx - 0.8660254 * a * s, cy + 0.5 * a * s)
        blue_xy = (cx + 0.8660254 * a * s, cy + 0.5 * a * s)

        self._set_circle(self._items["red"], red_xy[0], red_xy[1], r, "#ff0000")
        self._set_circle(self._items["green"], green_xy[0], green_xy[1], r, "#00ff00")
        self._set_circle(self._items["blue"], blue_xy[0], blue_xy[1], r, "#0000ff")

        pulse = math.exp(-((s / 0.055) ** 2))
        if pulse > 0.35:
            self.canvas.coords(self._items["white"], cx - r, cy - r, cx + r, cy + r)
            fill_rgb = self._interp_rgb((245, 245, 245), (255, 255, 255), min(1.0, pulse))
            self.canvas.itemconfigure(self._items["white"], fill=self._to_hex(fill_rgb), state="normal")
            self.canvas.tag_raise(self._items["white"])
        else:
            self.canvas.itemconfigure(self._items["white"], state="hidden")

        self._tick = (self._tick + 1) % 180
        self.win.after(16, self._animate)

    def close(self):
        self._running = False
        try:
            self.win.destroy()
        except Exception:
            pass



def _show_completion_popup(root: tk.Tk, title: str, message: str, is_error: bool = False):
    popup = tk.Toplevel(root)
    popup.withdraw()
    popup.overrideredirect(True)
    popup.geometry("1x1+0+0")
    try:
        popup.attributes("-topmost", True)
    except Exception:
        pass
    try:
        popup.deiconify()
        popup.lift()
        popup.focus_force()
        popup.bell()
    except Exception:
        pass
    try:
        popup.update_idletasks()
        popup.update()
    except Exception:
        pass
    try:
        if is_error:
            messagebox.showerror(title, message, parent=popup)
        else:
            messagebox.showinfo(title, message, parent=popup)
    finally:
        try:
            popup.destroy()
        except Exception:
            pass

def _run_analyzer_with_wait(root: tk.Tk, img_path: str, cfg: dict, img_bgr=None):
    wait = AnalysisWaitWindow(root)
    result = {"error": None, "traceback": ""}
    thread_holder = {"thread": None}

    def worker():
        try:
            analyzer = Analyzer(img_path, cfg, img_bgr=img_bgr)
            analyzer.run()
        except Exception as exc:
            result["error"] = exc
            result["traceback"] = traceback.format_exc()

    def start_worker():
        t = threading.Thread(target=worker, daemon=True)
        thread_holder["thread"] = t
        t.start()
        poll()

    def poll():
        t = thread_holder["thread"]
        if t is None or t.is_alive():
            root.after(50, poll)
            return

        wait.close()
        err = result.get("error")
        if err is not None:
            _show_completion_popup(root, "Analysis failed", f"{err}\n\n{result.get('traceback', '')}", is_error=True)
        else:
            _show_completion_popup(root, "Done", "Analysis completed.", is_error=False)
        root.quit()

    root.after(100, start_worker)


def main():
    cfg = PlateLayoutUI().run()
    if not cfg:
        return

    root = tk.Tk()
    root.withdraw()

    img_path = cfg.get("image_path")
    if not img_path:
        img_path = filedialog.askopenfilename(
            title="Select plate image",
            filetypes=[
                ("Image files", "*.png *.jpg *.jpeg *.tif *.tiff *.bmp"),
                ("All files", "*.*"),
            ],
        )
    if not img_path:
        return

    print("Selected image:", img_path)
    print("Image source:", cfg.get("image_source", "file"))
    print("Unit:", cfg.get("unit"))
    print("Configured wells:", len(cfg.get("data", {})))

    img_bgr, resize_scale = _load_analysis_image(img_path, MAX_ANALYSIS_SIDE)
    if img_bgr is None:
        messagebox.showerror("Image error", "Could not open selected image.")
        return

    if resize_scale < 0.999999:
        print(f"Analysis image: in-memory resized from original; scale={resize_scale:.4f}, size={img_bgr.shape[1]}x{img_bgr.shape[0]} px")
    else:
        print(f"Analysis image: original, size={img_bgr.shape[1]}x{img_bgr.shape[0]} px")

    qc_payload = _initial_image_qc(
        img_bgr,
        nrow=int(cfg.get("nrow", 8)),
        ncol=int(cfg.get("ncol", 12)),
    )
    cfg["initial_image_qc"] = qc_payload
    if not _handle_initial_image_qc(root, qc_payload):
        return

    cfg["original_image_path"] = img_path
    cfg["analysis_resize_scale"] = float(resize_scale)
    cfg["analysis_max_side"] = None if MAX_ANALYSIS_SIDE is None else int(MAX_ANALYSIS_SIDE)
    cfg["analysis_image_width"] = int(img_bgr.shape[1])
    cfg["analysis_image_height"] = int(img_bgr.shape[0])

    stored_cfg = load_all_config() or {}
    has_saved_four_point_geometry = (
        all(
            k in stored_cfg and stored_cfg.get(k) is not None
            for k in ["fourpt_a1_img", "fourpt_a12_img", "fourpt_h12_img", "fourpt_h1_img"]
        )
        and _stored_geometry_matches_image(stored_cfg, img_bgr)
    )

    if has_saved_four_point_geometry:
        use_saved = messagebox.askyesnocancel(
            "Stored geometry",
            "Choose:\n- Yes = use stored 4-point geometry\n- No = redefine 4-point geometry for this image\n- Cancel = exit",
            parent=root,
        )
        if use_saved is None:
            return
        if use_saved:
            geo = {
                "corner_a1": stored_cfg.get("fourpt_a1_img"),
                "corner_a12": stored_cfg.get("fourpt_a12_img"),
                "corner_h12": stored_cfg.get("fourpt_h12_img"),
                "corner_h1": stored_cfg.get("fourpt_h1_img"),
                "corner_c4": stored_cfg.get("fourpt_c4_img"),
                "corner_c9": stored_cfg.get("fourpt_c9_img"),
                "corner_f9": stored_cfg.get("fourpt_f9_img"),
                "corner_f4": stored_cfg.get("fourpt_f4_img"),
                "floor_a1_circle_img": stored_cfg.get("floor_a1_circle_img"),
                "floor_a12_circle_img": stored_cfg.get("floor_a12_circle_img"),
                "floor_h12_circle_img": stored_cfg.get("floor_h12_circle_img"),
                "floor_h1_circle_img": stored_cfg.get("floor_h1_circle_img"),
            }
            cfg = _apply_fourcorner_geometry_to_cfg(cfg, img_path, geo)
        else:
            viewer = PlateAlignViewer4Point(
                img_bgr,
                nrow=int(cfg.get("nrow", 8)),
                ncol=int(cfg.get("ncol", 12)),
            )
            geo = viewer.run()
            if geo is None:
                print("Alignment canceled.")
                return
            _save_analysis_geometry_image_size(img_bgr)
            cfg = _apply_fourcorner_geometry_to_cfg(cfg, img_path, geo)
    else:
        viewer = PlateAlignViewer4Point(
            img_bgr,
            nrow=int(cfg.get("nrow", 8)),
            ncol=int(cfg.get("ncol", 12)),
        )
        geo = viewer.run()
        if geo is None:
            print("Alignment canceled.")
            return
        cfg = _apply_fourcorner_geometry_to_cfg(cfg, img_path, geo)

    _run_analyzer_with_wait(root, img_path, cfg, img_bgr=img_bgr)
    root.mainloop()


if __name__ == "__main__":
    main()
