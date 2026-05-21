# Trading Court v3.7 — Three Truth Fixes

This patch closes the three remaining honesty gaps identified in the v3.5.6 +
v36 audit. It must be applied **on top of** the previously fixed v36 patch
(`trading_court_v36_direct_patch_FIXED`).

## What this patch fixes

### Fix 1 — Pre-classical truth gate
The v36 truth gate previously ran only at the *end* of `analyzePair()`, after
RSI / EMA / ATR / VWAP / MTF / market-structure had already been computed on
potentially contaminated candles (synthetic NZDUSD, Investing PT5H-as-H4).
The final verdict was forced to WAIT, but the dashboard still showed numbers
derived from non-truth data.

This patch runs the same truth gate **immediately after** the network fetch
(`fetchQuote` + `fetchAllTimeframes` + ...) and **before** any indicator is
computed. If the gate fails, `analyzePair()` returns an early WAIT analysis
constructed from real inputs (quote, session, candle counts) and explicit
nulls for every classical indicator — guaranteeing no RSI/EMA/ATR/VWAP/MTF
number on the dashboard was ever computed on contaminated data.

### Fix 2 — VWAP requires real volume
`engines/vwap.ts` previously had `const v = c.v ?? 1;` which silently degraded
VWAP into a non-volume-weighted typical-price average when the candle source
omitted volume (Investing fallback, Stooq). The output was still labeled
"VWAP" with `+1σ / +2σ` bands. This patch refuses to compute VWAP when any
candle in the window has missing, zero, or negative volume, returning a clean
"VWAP unavailable: candle volume missing or non-positive" report instead.

### Fix 3 — Pip value for USDCAD / USDCHF / USDJPY (unified USD-base formula)
`engines/tradePlan.ts::computeLotSize` previously used `pipValueUsd = 10`
("approximate") for any pair where quote ≠ USD and quote ≠ JPY. This
under-reported lot size for **USDCAD** by ~30% and **over-reported** for
**USDCHF** by ~10% (over-leverage risk). The JPY formula `1000 / entry` was
also a special case that only worked for USDJPY.

This patch unifies all USD-base / foreign-quote pairs under one correct
formula:

```ts
pipValueUsd = (pip * 100000) / entry;
```

Verified against expected values:
- USDJPY @ 150 → $6.67  (was correct via special-case)
- USDCAD @ 1.40 → $7.14 (was $10 — wrong by +40%)
- USDCHF @ 0.90 → $11.11 (was $10 — wrong by −10%, OVER-LEVERAGE)

The patch also returns `null` instead of fabricating a number when entry ≤ 0,
or when neither side of a pair is USD (refusing to "approximate" cross-pairs
that aren't in the current INSTRUMENTS set).

## Files

### New file
- `src/engines/v36/preGate.ts` — `buildPreGateWaitAnalysis()` helper

### Modified files (replace in place)
- `src/engines/court.ts` — adds two imports + 8-line truth gate block after fetch
- `src/engines/vwap.ts` — replaces `computeVwapBands()` and adds early-return
   in `computeVwap()` when daily band is null
- `src/engines/tradePlan.ts` — replaces the `pipValueUsd` decision branch in
   `computeLotSize()`

### Tests
- `src/tests/v37-three-fixes.ts` — 42 assertions covering all three fixes

## Verification

```bash
# Compile both build profiles (must produce zero errors)
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.test.json

# Run the v37 fix verification suite (must report 42 passed, 0 failed)
npx tsc -p tsconfig.test.json
node dist/tests/v37-three-fixes.js

# Optional: re-run prior gate stress test (must still report 9 passed)
node dist/tests/v36-truth-gate-stress.js
```

## Compatibility

- All previous v36 tests (smoke + 9-case stress) continue to pass without
  modification.
- The late `applyV36StatisticalCourt()` call at the end of `analyzePair()` is
  unchanged. When the pre-gate passes, both gates run with the same data and
  produce identical truth verdicts (idempotent), but only the early gate
  short-circuits the indicator pipeline.
- No new external API calls. No new dependencies. No randomness.
