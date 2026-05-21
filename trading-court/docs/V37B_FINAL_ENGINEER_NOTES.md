# v37b-final Engineer Notes

This package is a full project snapshot based on v3.5.6 plus:

1. v36 statistical court direct integration.
2. FIXED synthetic NZDUSD truth gate (`synth(` and `audusd proxy`).
3. Pre-classical Truth Gate before indicators.
4. VWAP volume requirement.
5. Correct USD-base pip value for USDCAD/USDCHF.
6. v37b improvements:
   - balanced v36 confidence delta
   - range regime trust floor
   - conflict-based breaking news veto
7. Additional fix: confidence delta penalty now uses `trustFloor`, not hardcoded 60.

No dummy data, no random numbers, and no synthetic prices are added by this package.

Recommended use: dry-run / shadow mode first.
