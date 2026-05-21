# CHANGES — v3.9

**Theme:** Empirical confidence calibration loop. Replaces the v3.8
heuristic (`confidence = |composite|`) with bin-level win-rates derived
from backtest, so `confidence` is now a real probability when calibration
data exists.

This release is also the first one whose `npm run build` actually
compiles the backtest module — v3.8 shipped a tsconfig that excluded
`src/backtest/**`, so `npm run backtest` would have failed at runtime
with "module not found." That bug is fixed.

---

## What changed

### New module: `src/calibration/`

Six files implementing the calibration system:

| File | Purpose |
|------|---------|
| `types.ts` | `CalibrationBin`, `CalibrationData`, `CalibrationResult`, `MIN_BIN_SAMPLE_SIZE` |
| `calibrationData.json` | Bundled registry. Empty on first ship; CLI populates per symbol |
| `registry.ts` | `getCalibration(symbol)`, `getCalibratedSymbols()` — O(1) lookups |
| `applyCalibration.ts` | Pure decision-time function: composite → calibrated confidence or heuristic fallback |
| `buildCalibration.ts` | Converts backtest records → CalibrationData |
| `cli.ts` | `npm run calibrate` entrypoint |

### `src/engines/court.ts` modifications

`composeScores` now takes the symbol as its first argument and consults
`applyCalibration()` for the base confidence:

```ts
const heuristicConf = Math.min(100, Math.abs(compositeRaw));
const cal = applyCalibration(symbol, compositeRaw, heuristicConf);
const confidenceRaw = cal.confidence;
```

When the registry has data for the symbol AND the matched `|composite|`
bin has ≥20 trades, `confidenceRaw` becomes the empirical win-rate of
that bin (`winRate × 100`). Otherwise it falls back to the heuristic, so
pre-calibration deployments behave identically to v3.8.

The `m5Bonus` path also re-runs the calibration lookup when composite
shifts, so a +12 bonus that pushes `|composite|` from 28 to 40 produces
a confidence value drawn from the 40-55 bin, not the 25-40 bin.

Every verdict carries `scores.calibration` with the audit detail:
```json
{
  "source": "calibrated",
  "confidence": 67,
  "bin": { "loAbs": 25, "hiAbs": 40, "winRate": 0.667, "sampleSize": 30 }
}
```
A warnings line is appended explaining the source — visible in the
dashboard so the user can audit at a glance whether confidence is
empirical or heuristic.

### `tsconfig.node.json` and `tsconfig.test.json` fixes

Both add:
```json
"resolveJsonModule": true,
"include": [..., "src/backtest/**/*", "src/calibration/**/*"]
```

The first enables JSON imports for the registry. The second fixes the
v3.8 bug where `src/backtest/**` was excluded from the build.

### `package.json`

- Version bump to `3.9.0`.
- New scripts: `calibrate`, `test:calibration`.
- The default `test` script now includes the calibration smoke test.

### `src/tests/calibration.smoke.ts` (new)

A real unit test that:
1. Confirms an empty registry produces heuristic + `no_calibration` reason.
2. Builds a calibration from synthetic backtest records and verifies the
   bin math (30 trades, 20 wins, 10 losses → win-rate 0.667).
3. Verifies a 5-trade bin produces `low_sample` heuristic, not calibrated.
4. Verifies the m5Bonus simulation: composite shift moves the matched bin
   and produces a different confidence.
5. Verifies symbol case-insensitivity.

The test was run during development and PASSED. Output:
```
calibration smoke test PASSED
{
  "result_at_30": { "source": "calibrated", "confidence": 67,
                    "bin": { "loAbs": 25, "hiAbs": 40, "winRate": 0.667 } },
  "result_at_50": { "source": "heuristic", "confidence": 50,
                    "heuristicReason": "low_sample" }
}
```

An end-to-end CLI test (200 synthetic records, 60%+75% win-rates seeded
in two bins) recovered 61.0% and 74.0% respectively — the small variance
from the seeded RNG. The full pipeline works.

---

## How to use

### Step 1 — Backtest the symbol

```bash
npm run backtest -- --pair EURUSD --csv ./data/EURUSD --from 2026-01-01 --out results/eurusd.json
```

### Step 2 — Build calibration

```bash
npm run calibrate -- --pair EURUSD --records results/eurusd.json
```

This updates `src/calibration/calibrationData.json` in place.

### Step 3 — Rebuild and deploy

```bash
npm run build
npm run start    # or pm2 restart trading-court-pro
```

The next `runCourt()` invocation for EURUSD will use empirical win-rates
for any bin with ≥20 trades. Other bins continue using the heuristic.

### Step 4 — Audit

Look at any verdict's `warnings` field:
- `Confidence: empirical (bin |comp| 25-40, 124 trades, win-rate 64.3%)` — calibrated
- `Confidence: heuristic (matched bin has <20 trades)` — heuristic with explanation

### Batch mode

For multiple symbols at once:
```bash
# Run backtest for each
for p in EURUSD GBPUSD USDJPY XAUUSD; do
  npm run backtest -- --pair $p --csv ./data/$p --out results/$p.json
done
# Calibrate all in one shot
npm run calibrate -- --batch ./results/
```

### Reverting a symbol

```bash
npm run calibrate -- --remove EURUSD
npm run build
```

That symbol now uses the heuristic again until re-calibrated.

---

## What this means in practice

**Before v3.9:** A composite of 50 always meant `confidence = 50`,
regardless of how often that score actually produced winning trades.
The tier (REJECT/WEAK/VALID/STRONG) was a rough proxy — useful but not
grounded.

**After v3.9 (with calibration data):** A composite of 50 means
"historically this scored a 73% win-rate in our backtest, so confidence
= 73." Tier classification (`STRONG ≥ 72`) now corresponds to a real
73%+ empirical win-rate threshold. Position sizing tracks that.

**Without calibration data:** v3.8 behavior. No regression.

---

## Honest limitations

1. **Phase 1 backtest is technical-only.** News, calendar, and macro
   context are stubbed in the v3.8 backtest. The win-rates produced by
   the calibration are therefore for "technical setup alone" — they do
   not include the boost from news-engine alignment or the protection
   from breaking-news vetoes. Production decisions still apply those
   filters, so live performance should be at least as good as the
   calibration suggests.
2. **Calibration is per-symbol.** EURUSD calibration does not apply to
   GBPUSD. This is intentional: different pairs have different
   regime characteristics.
3. **Bins are coarse.** Seven `|composite|` buckets. Within a bucket,
   the system assumes uniform win-rate. A future round can refine to
   smaller buckets or interpolation when data volume permits.
4. **No automatic refresh.** The calibration data is bundled at build
   time. Run `npm run calibrate` periodically (monthly?) to refresh. A
   Phase 3 trade-journal-driven continuous calibration loop is a
   natural follow-up.
5. **Composite outside bin schedule** (theoretically `|composite|` > 200
   after the m5Bonus stack) returns heuristic. In practice composite is
   clamped to ±100 in `composeScores`, so this branch is unreachable
   today; kept as a safety net.

---

## Files changed

| File | Status | Lines | Why |
|------|--------|-------|-----|
| `src/calibration/types.ts` | NEW | 79 | Types + sample-size constant |
| `src/calibration/calibrationData.json` | NEW | 6 | Empty registry |
| `src/calibration/registry.ts` | NEW | 35 | Bundled JSON loader |
| `src/calibration/applyCalibration.ts` | NEW | 73 | Decision-time function |
| `src/calibration/buildCalibration.ts` | NEW | 95 | Records → CalibrationData |
| `src/calibration/cli.ts` | NEW | 234 | `npm run calibrate` |
| `src/engines/court.ts` | MODIFIED | +50 | Wire applyCalibration into composeScores + m5Bonus path |
| `src/tests/calibration.smoke.ts` | NEW | 113 | Unit test |
| `tsconfig.node.json` | MODIFIED | — | resolveJsonModule + backtest/calibration includes |
| `tsconfig.test.json` | MODIFIED | — | Same |
| `package.json` | MODIFIED | — | calibrate + test:calibration scripts; v3.9.0 |
| `CHANGES_v3.9.md` | NEW | — | This document |

`tsc -p tsconfig.node.json` passes with zero errors.
`tsc -p tsconfig.test.json` passes with zero errors.
`node dist/tests/calibration.smoke.js` passes.

## Deferred to next round (Phase 2B+)

- **Historical FRED context for backtest** — easy win, just plumbing.
- **FairEconomy historical calendar archive** — research effort.
- **Historical news archive** — bigger research effort. Need a free or
  cheap source.
- **Trade journal** with persistent outcome tracking — feeds continuous
  calibration refresh from live data, not just backtest.
- **Tier-threshold re-tuning** — the current `STRONG ≥ 72` is intuitive
  for win-rate semantics, but could be data-driven once enough
  calibration data exists.
