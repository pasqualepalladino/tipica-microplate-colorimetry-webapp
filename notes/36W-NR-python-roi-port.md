Milestone 36W-NR — Port Python ROI pixel filtering semantics to TypeScript



Recommended Codex effort: high.



NON-NEGOTIABLE OPERATING RULE — PYTHON FIRST



For this milestone, the Python reference code is the only source of truth.



Do not infer behavior from the current webapp.

Do not infer behavior from previous Codex/Copilot attempts.

Do not apply or copy stash@{0}.

Do not optimize, simplify, redesign, or “improve” the algorithm.

Do not perform exploratory diagnostics or trial-and-error fixes.



Required workflow:

1\. Read the exact Python implementation in reference\_python/analyzer.py.

2\. Map each relevant Python step explicitly.

3\. Port only that mapped logic to TypeScript in src/core/sampling.ts.

4\. Preserve existing web ROI geometry unless Python mapping explicitly requires otherwise.

5\. Validate by build/smoke/diff checks only.



If a behavior is not present in the Python source, do not invent it.

If a detail is unclear, stop at the closest faithful port and leave a minimal TODO/comment rather than creating a new behavior.



Starting point:

Latest committed state:

c6ab281 Add ROI mask inclusion parity audit



Important:

There is a stash named "WIP unsafe ROI sampling port from Codex". Do not apply it. Ignore it unless explicitly asked later.



Goal:

Replace the current web robust ROI pixel-statistics logic with a faithful TypeScript port of the Python reference logic in:



reference\_python/analyzer.py

\- \_robust\_inner\_mask

\- \_fuzzy\_liquid\_mask\_within\_roi

\- \_compute\_well\_robust\_statistics



Python source-of-truth semantics already inspected:



1\. \_robust\_inner\_mask(mask\_u8, erosion\_px=4)

\- if mask empty: return empty mask

\- k = max(1, int(erosion\_px))

\- elliptical structuring element size = (2\*k + 1, 2\*k + 1)

\- cv2.erode(mask\_u8, ellipse\_kernel, iterations=1)

\- if eroded mask has <16 pixels, fallback to original mask



2\. \_fuzzy\_liquid\_mask\_within\_roi(img\_bgr, roi\_mask\_u8, center\_xy=None, tol\_gray=10, tol\_sat=20)

\- gray = cv2.cvtColor(img\_bgr, COLOR\_BGR2GRAY)

\- hsv = cv2.cvtColor(img\_bgr, COLOR\_BGR2HSV)

\- sat = HSV saturation channel

\- inside roi\_mask:

&#x20; seed\_gray = median(gray\[roi\_mask])

&#x20; seed\_sat = median(sat\[roi\_mask])

\- candidate pixels:

&#x20; roi\_mask AND abs(gray - seed\_gray) <= 10 AND abs(sat - seed\_sat) <= 20

\- morphology open with 3x3 ellipse, then close with 3x3 ellipse

\- connected components, 8-connectivity

\- if component overlaps seed point, keep seed component

\- otherwise keep component whose mean x/y is closest to ROI centroid, ignoring area <20

\- if selected component has < max(20, 20% of roi\_mask pixels), fallback to roi\_mask

\- return selected component mask



3\. \_compute\_well\_robust\_statistics(...)

\- full\_mask = m > 0

\- n\_roi = count full\_mask

\- inner\_u8 = \_robust\_inner\_mask(m, erosion\_px=4)

\- core\_mask = inner\_u8 > 0

\- if core empty, fallback to full\_mask

\- ctr = \_mask\_centroid(inner\_u8)

\- fuzzy\_u8 = \_fuzzy\_liquid\_mask\_within\_roi(img\_bgr, inner\_u8, ctr)

\- fuzzy\_mask = fuzzy\_u8 > 0

\- if fuzzy\_mask has >30 pixels, core\_mask = fuzzy\_mask

\- n\_core = count core\_mask

\- hi\_thr = percentile(gray\_core, 88)

\- lo\_thr = percentile(gray\_core, 8) is computed but not used for routine exclusion in the shown Python code

\- used\_mask = core\_mask.copy()

\- n\_used = count used\_mask

\- if n\_used < max(20, int(0.35 \* n\_core)):

&#x20;   used\_mask = core\_mask \& (gray <= hi\_thr)

\- if n\_used < 12:

&#x20;   used\_mask = core\_mask.copy()

\- median B/G/R are computed on used\_mask



Critical difference to fix:

Current src/core/sampling.ts robustTrimmedRoiStats applies systematic percentile trimming:

usedPixels = corePixels.filter(gray >= darkThreshold \&\& gray <= brightThreshold)

This is not Python-equivalent. Python normally uses the core/fuzzy mask directly and only applies bright fallback if the usable count is too low.



Files to inspect/change:

\- src/core/sampling.ts



Do not change:

\- score formula

\- fitting

\- ranking

\- PAbs formula

\- C0/C0\_sd

\- dilution

\- geometry override behavior

\- BG model

\- method aliases

\- workbook schema unless only updating existing diagnostic labels/status strings



Implementation requirements:

A. Keep the existing ROI shape sampling functions:

\- sampleCircularRoi

\- sampleCircleIntersectionRoi

They may still define the geometric ROI pixels.

Do not change circle/intersection geometry in this milestone.



B. Replace robustTrimmedRoiStats internals with Python-like pixel filtering:

\- use full ROI pixels as Python full\_mask equivalent

\- erode using ellipse radius 4 equivalent to cv2 MORPH\_ELLIPSE kernel

\- fallback to full ROI if eroded count <16

\- compute gray and HSV saturation for pixels

\- implement Python-like fuzzy liquid mask within the eroded ROI

\- implement 3x3 ellipse open then close

\- implement 8-connected components

\- choose component containing rounded center point if possible, else component closest to ROI centroid, area >=20

\- fallback to eroded ROI if selected fuzzy component too small

\- if fuzzy count >30, use it as core

\- usedPixels should normally equal corePixels

\- do not apply systematic 8–88 percentile trimming

\- only apply gray <= hi\_thr fallback if used count is below max(20, floor(0.35\*n\_core)), matching Python control flow

\- if used count <12, fallback to core



C. Preserve diagnostic fields:

\- roiFullPixels = n\_roi

\- roiCorePixels = n\_core after fuzzy replacement

\- roiUsedPixels = n\_used

\- roiUsedFraction = n\_used / n\_core

\- roiTrimDarkQ may remain 8 for traceability, but note dark threshold is not used for routine exclusion

\- roiTrimBrightQ = 88

\- roiPixelStatisticsMode should be renamed or set to a clear Python-like value if allowed by types, e.g. "python-robust-v1". If the type does not allow it, keep existing string and add warning/notes carefully without breaking TypeScript.



D. Color channel:

Browser ImageData is RGBA with r,g,b. Python uses BGR internally but exports R/G/B medians. Make sure final returned r/g/b medians correspond to browser r/g/b and match Python exported R/G/B semantics.



E. Add small helper functions as needed:

\- median

\- percentile already exists

\- hsv saturation conversion for RGB

\- morphology open/close on pixel sets or boolean mask

\- connected components over ROI pixels

\- centroid and rounded seed selection



F. Do not claim parity until user reruns browser export.

After runtime change, stale web\_after\_36U.zip still reflects old behavior.



Validation:

Run:

npm run build

npm run smoke:plate-configurator

git diff --check

git restore tsconfig.tsbuildinfo

rm -rf tools/\_\_pycache\_\_

git status

git diff --stat



Do not commit.



Final report must include:

1\. files changed;

2\. whether only src/core/sampling.ts changed;

3\. whether tools/compare\_python\_web\_outputs.py changed;

4\. whether runtime logic changed;

5\. exact Python functions ported;

6\. explanation of old web behavior versus new Python-like behavior;

7\. whether systematic 8–88 trimming was removed;

8\. whether fuzzy liquid connected-component selection was implemented;

9\. whether sampleCircularRoi/sampleCircleIntersectionRoi geometry was left unchanged;

10\. validation results;

11\. explicit reminder that a fresh browser export with shared-geometry override is required before evaluating numeric improvement.

