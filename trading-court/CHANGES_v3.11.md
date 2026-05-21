# CHANGES — v3.11

**Theme:** Honest removal of NZD/USD from the instrument list.

This release is a deliberate **subtraction**. After three failed
attempts to source clean intraday OHLC for NZD/USD on production
egress (Investing.com IP-blocked, Dukascopy v3.10.1 too slow,
Dukascopy v3.10.2 still unreliable in practice), the engineering
choice is to remove the pair rather than ship a broken or perpetually
WAIT-stuck experience.

---

## Why removal is the correct choice

| Path | Status | Outcome |
|------|--------|---------|
| Kraken NZDUSD | Doesn't exist | No spot pair |
| Investing.com pairId=8 | Tried | IP-blocked from production server |
| Dukascopy BI5 (v3.10.1) | Tried | Worked once, then perpetually slow + stale |
| Dukascopy BI5 + caching (v3.10.2) | Built | Was the next step; user judged the architectural complexity not worth it |
| Synthetic AUD-derived | Existed | Truth gate correctly rejects (it's a proxy, not data) |

The truth gate is doing its job. The system enforces a no-proxy
contract. With no real source available, the only honest configuration
is to **omit** the symbol entirely — not to ship a permanent WAIT or
relax the truth gate.

> "ج — حذف NZD/USD من القائمة بصراحة"

This release implements that choice cleanly.

---

## What changed

### Configuration

`src/config.ts` — `INSTRUMENTS["NZDUSD"]` removed. The system now
defines exactly **7 instruments**: EURUSD, GBPUSD, USDJPY, AUDUSD,
USDCAD, USDCHF, XAUUSD.

A documentation comment is left in place at the former location
explaining why the pair was removed and what was tried, so future
maintainers don't reintroduce the same broken paths.

### Fetchers

`src/fetchers/candles.ts`:
- `nzdusdSynthetic()` function deleted (~45 lines)
- `NZDUSD` special-case branch in `fetchSeries()` deleted
- `NZDUSD: "8"` removed from `INVESTING_PAIR_IDS` map
- File-header comment updated to drop NZDUSD synthetic mention

### Engines

`src/engines/v36/truth.ts`:
- `if (symbol === "NZDUSD") { ... synthetic_forbidden }` block deleted
- Truth gate is now fully symbol-agnostic again — its general
  `isSyntheticOrPseudo()` detection still rejects any pair fed
  synthetic data, but no per-symbol exceptions remain
- The v3.10.1 dukascopy:* freshness exception is **not present**
  (this build is based on the clean v3.10 truth.ts before that
  exception was added)

`src/engines/freshness.ts`:
- `NZDUSD` spread profile removed

`src/engines/v36/preGate.ts`:
- Comment updated to remove NZDUSD synthetic example

### Tests

`src/tests/integration.ts`:
- Removed the `v3.5.1 — NZD intervention regime → breakingScore < 0`
  test (entire test block) — no longer relevant

`src/tests/v37-three-fixes.ts`:
- Synthetic-trips-gate test now uses EURUSD instead of NZDUSD. The
  truth gate's synthetic detection is symbol-agnostic, so the test
  still validates the same logic, just with a pair that exists.
- Removed `NZDUSD pip = $10` pip-value assertion (3 USD-quote
  assertions remain: EURUSD, GBPUSD, AUDUSD).

`src/tests/v356-measurement.ts`:
- `PAIRS` array no longer contains NZDUSD.

`src/backtest/cli.ts`:
- Help-text instrument list updated.

### Dependencies

`package.json`:
- `version` → `3.11.0`
- `dukascopy-node` dependency **NOT included** (this build is from
  the v3.10 baseline, so the dependency was never added). If you're
  upgrading from v3.10.1 or v3.10.2 in place, run a clean
  `rm -rf node_modules && npm install` to drop the unused dep.

---

## What stays

Everything else from v3.10 is unchanged:

- Calibration system (v3.9 + v3.10 live calibration loop)
- Measurement / journal / outcome tracker (v3.5.6+)
- Truth gate's general detection of synthetic, PT5H-as-H4, stale data
- All 7 remaining instruments' candle chains (Kraken primary,
  Coinbase for XAUUSD, Stooq fallback, etc.)
- Frontend dashboard (will simply show 7 cards instead of 8)
- All engines (MTF, Momentum, Price Action, Regime, Correlation,
  News, ICT/SMC market structure, etc.)

The system is **architecturally simpler** after this release because
the NZDUSD-specific code paths (synthetic, special-case fetch chain,
truth-gate carve-out) are all gone.

---

## Verification

```bash
# TypeScript compilation
$ npx tsc -p tsconfig.node.json
exit 0

$ npx tsc -p tsconfig.test.json
exit 0

# Smoke tests (38 pass / 3 fail — same 3 VWAP failures as v3.10
# baseline; pre-existing, not caused by NZDUSD removal)
$ node dist/tests/v37-three-fixes.js
38 passed, 3 failed   # was 39/3 — diff is the removed NZDUSD pip test

$ node dist/tests/calibration.smoke.js
PASSED — recovered seeded 60%/75% win-rates from 200 fixture records

# Final NZDUSD scan (only documentation comments remain)
$ grep -rn "NZDUSD\|nzdusd" src/
src/config.ts:44:  // NZDUSD removed in v3.11. ...
src/tests/v37-three-fixes.ts:82:  // (Originally tested with NZDUSD; ...)
```

---

## Deployment

```bash
unzip trading_court_v3.11_FINAL.zip -d v3.11
cd v3.11
rm -rf node_modules dist     # important — drops dukascopy-node if upgrading
npm install
npm run build
pm2 restart trading-court-pro
```

After restart:
- Dashboard shows 7 cards (was 8)
- The "NZD/USD" row that was perpetually WAIT is gone
- All other 7 pairs work exactly as in v3.10
- No `synthetic_forbidden` reasons anywhere
- No `kraken:synth(AUD×*)` source strings in audit logs

---

## What this means for the calibration system

The v3.10 calibration loop reads from the journal per symbol. Past
NZDUSD entries in the journal will simply never be queried again
(the symbol isn't in INSTRUMENTS, so no future analyses generate
NZDUSD verdicts). The journal data is preserved, not deleted —
if you ever bring NZDUSD back with a working source, the historical
verdicts/outcomes are still there.

`npm run calibrate -- --from-journal` now operates on 7 pairs.

---

## Reversibility

If a real-time NZD/USD source becomes available later, restoring
the pair is a 5-line change:

1. Add the `NZDUSD` block back in `src/config.ts`'s `INSTRUMENTS`
2. Add the new fetcher to `candles.ts` (replacing the old NZDUSD
   special case with whatever source works)
3. Add the spread profile back in `freshness.ts`
4. Add `NZDUSD` back to test PAIRS arrays
5. Bump version

The truth gate doesn't need any per-symbol changes — its
`isSyntheticOrPseudo()` covers the synthetic case generically, and
freshness thresholds apply uniformly to all instruments.
