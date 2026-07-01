# 36W-NR shared-geometry validation

Date: 2026-07-01

Code commit:
- 42dcc05 Port Python ROI pixel filtering semantics

Compared files:
- Python: test_data/manual_comparison/python_RUN_20260529_122854.zip
- Web: test_data/manual_comparison/web_after_36W_NR_shared_geometry.zip
- Report: test_data/manual_comparison/comparison_after_36W_NR_shared_geometry.md

Key outcome:
- Shared-geometry comparison completed after loading python_geometry_canonical.json in the developer diagnostic panel.
- Python best method: DeltaE_chroma.
- Web best method: DeltaE_ab_chroma.
- Canonical selected-method match: true.
- Score/BaseScore reconstruct internally in both Python and web; score formula is not the first cause of residual differences.
- ROI RGB medians are now very close under shared geometry: max_abs = 1 for Red, Green, and Blue medians.
- PAbs_Blue web C0_median = 229.82818699727983 mM, very close to ICP-MS expected value 228 mM.
- Remaining blocker: upstream fit-input parity, mainly residual extracted-value/BG/PAbs-correction/CIELAB differences.

Conclusion:
36W-NR is a strong partial success. Do not patch score/ranking next. Next corrective work should target exported/intermediate PAbs correction mapping, BG model/mask parity under shared geometry, or CIELAB conversion/reference parity.
