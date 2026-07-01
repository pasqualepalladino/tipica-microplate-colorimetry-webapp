# 36X-A Artifact Parity Audit (audit-only)

## Inputs audited
- Python ZIP: test_data/manual_comparison/python_after_36W_V_bg_model_proof.zip
- Web ZIP: test_data/manual_comparison/web_after_36W_U_shared_geometry.zip
- Report: test_data/manual_comparison/comparison_after_36W_V_pythonproof_vs_36W_U_web.md

## Figure gaps
- RESULTS/Piastra 70_FIGURE_RGB.png: RELEASE_BLOCKING_GAP
  - Web figure context lacks reference/recovery evidence while Python provides it.
- RESULTS/Piastra 70_BEST_CHANNEL.png: RELEASE_BLOCKING_GAP
  - Web figure context lacks reference/recovery evidence while Python provides it.
- RAW_DATA_DETAILS/Piastra 70_METHOD_COMPARISON.png: STYLE_DIFFERENCE_ONLY
  - Same dimensions, pixel differences present.
- RAW_DATA_DETAILS/Piastra 70_BG_STAT_MASK.png and RAW_DATA_DETAILS/Piastra 70_FIGURE_CIELAB_DELTAE.png: OK
  - Pixel-identical in current pair.

## Excel gaps
- REPORT/07_METHOD_COMPARISON: RELEASE_BLOCKING_GAP
  - Web missing reference/recovery panel columns present in Python:
    - expected_label_ICP_MS
    - expected_id_ICP_MS
    - expected_value_ICP_MS
    - expected_sd_ICP_MS
    - estimate_for_expected_ICP_MS
    - delta_expected_ICP_MS
    - recovery_pct_ICP_MS
    - rel_error_ICP_MS
- DIAGNOSTICS/10_METHOD_COMPARISON: DIAGNOSTIC_ONLY_EXTRA
  - Classified as diagnostic-only extension difference in this audit.
- Other REPORT/DIAGNOSTICS sheets in this pair: mostly OK for presence/shape parity.

## TXT caption gaps
- RAW_DATA_DETAILS/Piastra 70_RAW_DATA_DETAILS_CAPTION.txt: OK
- RESULTS/Piastra 70_RESULTS_CAPTION.txt: INTENTIONAL_BETA_DIFFERENCE
  - Difference is acknowledged as beta-level transparency wording.

## Release blockers (current ZIP pair)
- RESULTS/Piastra 70_FIGURE_RGB.png missing reference/recovery context in web output.
- RESULTS/Piastra 70_BEST_CHANNEL.png missing reference/recovery context in web output.
- REPORT/07_METHOD_COMPARISON missing reference/recovery fields in web output.

## Recommended next fix milestones
- 36X-B: restore REPORT/07_METHOD_COMPARISON reference/recovery fields in web export path for beta parity.
- 36X-C: ensure RESULTS figure context includes C0 ± SD and reference/recovery panel when reference values are available.
- 36X-D: finalize STYLE_DIFFERENCE_ONLY visual polishing (legend/text overlap/readability) without touching scientific calculations.
