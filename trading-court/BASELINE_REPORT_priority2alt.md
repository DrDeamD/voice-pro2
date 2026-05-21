# Baseline Report — Priority 2-alt
## Synthetic Historical Replay, 60 days × 3 pairs

**Date:** May 5, 2026
**Method:** Backtest replay using v3.8 framework on synthetic M1 candles
generated with regime variety (TREND/RANGE/CHOPPY/VOLATILE).
**Pairs:** EURUSD, GBPUSD, USDJPY
**Window:** 60 days, M1 step 15min, warmup 1500 bars, hold 720 bars
**Total decision points:** 16,980 across 3 pairs
**Time to run:** ~3 minutes per pair, ~10 min total

---

## Honest disclosures (read first)

**This is NOT a real-data baseline.** I could not fetch HistData CSVs from
the sandbox — egress blocked. To answer 2M's questions without further
delay I generated synthetic M1 candles with realistic properties:

- Regime mix (TREND_UP / TREND_DOWN / RANGE / CHOPPY / VOLATILE)
- Hour-of-day liquidity profile (Asia quiet, London/NY active)
- Per-pair volatility tuned to historical norms
- Random walk with regime-aware drift

**What this baseline RELIABLY answers:**
- Mathematical reachability of `|composite|` thresholds (50, 70)
- Engine architecture behavior (truth gate, MTF, regime, market structure)
- Distribution of risk-gate rejection reasons

**What this baseline CANNOT answer:**
- Real win-rate on actual market data
- True BUY/SELL distribution on 60 days of EURUSD (regime mix differs)
- Whether news/calendar engine adjustments would change verdict ratios

**Phase 1 limitations from replay.ts (acknowledged in code):**
- News input stubbed to `[]`
- Calendar input stubbed to `[]`
- Context (DXY/VIX/Oil/Gold/US10Y) stubbed to neutral

The user can re-run this exact baseline on real HistData by replacing
`data/synthetic/*.csv` with HistData files of the same shape. Command:
`node dist/backtest/baseline-runner.js`.

---

## The four metrics 2M asked for

### 1. Number of verdicts issued

| Pair | Verdicts |
|---|---|
| EURUSD | 5,660 |
| GBPUSD | 5,660 |
| USDJPY | 5,660 |
| **Total** | **16,980** |

Same count per pair — same M1 length, same step. Reproducible.

### 2. Distribution (BUY/SELL/WAIT)

| Verdict | Count | Pct |
|---|---|---|
| WAIT | 16,980 | **100.00%** |
| BUY | 0 | 0% |
| SELL | 0 | 0% |

**Zero trades issued in 60 days × 3 pairs.** This is empirical
confirmation of the over-rejection thesis at architectural level.

The synthetic data is not blameless here — without news contributions
boosting composite, technical-only signals are weaker than live. But:

### 3. WAIT rate

100.00% across all three pairs and across 60 days of replay.

**Even excluding weekend/killzone vetoes** (~32% of decisions points),
the remaining 68% of decision points (~11,500) all returned WAIT.

### 4. |composite| distribution — the core question

| Pair | min | max | mean | p50 | p90 | p95 | p99 | ≥50 count | ≥70 count |
|---|---|---|---|---|---|---|---|---|---|
| EURUSD | 0.0 | **63.8** | 25.9 | 25.6 | 47.4 | 52.2 | 56.7 | 421 (7.4%) | 0 |
| GBPUSD | 0.0 | **72.2** | 25.3 | 24.4 | 45.6 | 51.4 | 59.4 | 358 (6.3%) | 8 (0.14%) |
| USDJPY | 0.0 | **72.2** | 25.2 | 24.6 | 44.8 | 50.0 | 57.9 | 285 (5.0%) | 8 (0.14%) |
| **Total** | — | **72.2** | — | — | — | — | — | **1,064 (6.3%)** | **16 (0.09%)** |

---

## Discovery B — verdict on engine-weight re-calibration

I claimed in the audit that `|composite| ≥ 70` is "mathematically near-
impossible". The data **partially refutes me, partially confirms me**:

**Refuted:** `|composite|` DOES reach 70+ on the strongest synthetic
setups. Max observed: 72.2. So the architecture can produce strong
signals.

**Partially confirmed:** Only 16 of 16,980 verdicts (0.09%) had
`|composite| ≥ 70`. With `v36 MIN_CONFIDENCE = 77` and confidence ≈
heuristic `|composite|`, **at most 16 setups in 60 days × 3 pairs would
have crossed the v36 threshold even before any other rejection** —
about one trade per pair every 12 days.

The bottleneck is not the engine weights' arithmetic ceiling; it is the
sparsity of conditions where all engines align strongly enough.
Re-calibrating weights to push |composite| above 70 more often would
require either:

(a) Increasing per-engine score amplitude (risk: more false positives)
(b) Reducing the number of engines that need to align (risk: less
    diversification)

Neither is obviously correct. **Discovery B is downgraded**: it remains
a real finding but is no longer a blocker. The audit's priority 6.5 is
NOT promoted for execution.

---

## What the baseline reveals about real bottleneck

Top rejection reasons across all 3 pairs (counts approximate, normalized):

| Reason | EURUSD | GBPUSD | USDJPY | Per-pair avg |
|---|---|---|---|---|
| Composite confidence < threshold | 5618 | 5607 | 5608 | **99.2%** |
| RR < minimum (computed) | 3962 | 3993 | 3883 | 69.8% |
| RR n/a (no plan computed) | 1628 | 1561 | 1649 | 28.4% |
| FLAT direction (composite < threshold) | 1628 | 1561 | 1649 | 28.4% |
| Weekend / killzone | ~1820 | ~1820 | ~1820 | ~32% |
| Regime UNKNOWN | 680 | 680 | 680 | 12.0% |
| Regime VOLATILE | 0 | 0 | 480 | varies |
| Day-trading time gate (NY close) | ~580 | ~588 | ~553 | ~10% |

(The counts overlap — a single verdict can list multiple reasons.)

**Reading the data:**

- **Confidence threshold dominates everything**: 99.2% of decisions fail
  this gate. Even if every other gate were lifted, we'd get few trades.
  This is the audit's priority 8 territory (decisionEngine merge).

- **RR floor 1.50 is the second filter**: 70% of decisions also fail RR.
  Audit priority 5 territory.

- **FLAT direction = 28%**: when |composite| < direction threshold, no
  buy/sell side is chosen. Audit priority 8 — reduce direction threshold.

- **Regime UNKNOWN at 12%**: classifier returns UNKNOWN when it can't
  decide. Worth investigating in priority 3 (statMath fix).

---

## Implication for v4.0 plan

**Priorities that affect bottleneck most (in order of leverage):**

| # | Priority | Impact on baseline numbers |
|---|---|---|
| 8 | decisionEngine merge | Removes layered confidence multiplication. Could lift the ~6% of verdicts with composite ≥ 50 above any single threshold. |
| 5 | RR flex for RANGE | Removes ~70% RR rejection for valid range setups. Combined with 8, could move ~5% of WAITs to BUY/SELL. |
| 3 | Hurst confirming + statMath | Reduces v36 hard caps. Synergy with 8. |
| 1.7 | Opinion/preview filter | Not visible in synthetic baseline (no news), but production-confirmed important. |
| 4 | Asia confidence absolute | Visible in production but only 0.05× effect — confirms 2M's earlier intuition this is medium-impact. |

**Priorities that affect bottleneck least:**

| # | Priority | Impact |
|---|---|---|
| 6.5 | Engine weight re-calibration | Composite already reaches 70+. Diminishing returns. |
| 6 | FRED rename | Cosmetic. |

---

## Recommendation

Stick to the planned order:

1. **1.7** (opinion/preview filter) — production-validated need
2. **3** (Hurst + statMath audit) — high leverage on |composite| distribution
3. **4** (Asia confidence absolute) — small but real
4. **5** (RR flex for RANGE) — second-largest baseline bottleneck
5. **8** (decisionEngine merge) — largest bottleneck

After **3, 5, 8** ship, re-run this exact baseline. If `|composite| ≥ 50`
verdicts start producing BUY/SELL, the system is unlocked. If they
still don't, we revisit 6.5.

**Discovery B (engine weights):** Logged, NOT promoted to active plan.

---

## What I did NOT do

- Fetch real HistData (egress blocked)
- Run on actual user journal data (still missing)
- Test priority 1.7 against this baseline (would require simulating
  the news classifier with real news fixtures)
- Run more than 60 days (sandbox time/space constraint)

The user can extend this to 6 months or 1 year on his server with
real data using the same `baseline-runner.js` and replacing the
`data/synthetic/*.csv` files.

---

## Files produced

- `data/synthetic/EURUSD.csv` — 86,400 M1 bars (60 days)
- `data/synthetic/GBPUSD.csv` — same
- `data/synthetic/USDJPY.csv` — same
- `data/synthetic/EURUSD-verdicts.json` — full verdict records
- `data/synthetic/GBPUSD-verdicts.json` — same
- `data/synthetic/USDJPY-verdicts.json` — same
- `data/synthetic/baseline-summary.json` — aggregated metrics
- `src/backtest/baseline-runner.ts` — reproducible runner
- `scripts/generate_synthetic_candles.py` — data generator

To re-run on real data: place HistData CSVs at the same paths, run
`node dist/backtest/baseline-runner.js`.

---

## Code changes shipped as part of this work

These are bug-fix-class changes discovered while making the backtest
work. They are minimal and surgical:

1. `src/engines/v36/truth.ts` — accepts optional `nowMs` parameter for
   freshness anchoring. Default behavior unchanged (uses `Date.now()`).
   When backtest mode is active and `nowMs` is provided, freshness
   checks anchor to the historical bar's timestamp. Production callers
   never pass `nowMs`, so no behavior change.

2. `src/engines/court.ts` — passes `now.getTime()` to `v36TruthGate`
   when `backtestMode === true`. Otherwise passes `undefined` (no
   change in production).

3. `src/backtest/replay.ts` — `buildSyntheticQuote` now sets
   `quote.ts` in milliseconds (matching production convention) instead
   of seconds. This was a unit mismatch latent bug in v3.8 backtest
   that prevented the truth gate from being satisfied. Fixed.

These three changes are validated against existing smoke tests
(41 passed, 0 failed). They are required to make backtest replay
work and would be required regardless of synthetic vs real data.

---

## Remaining open question for 2M

The synthetic data found `|composite| max = 72.2`. But the production
screenshots showed `composite max ≈ -47` (USD/JPY) and most pairs
under 30. **Why does live show weaker signals than synthetic?**

Three hypotheses:

(a) Synthetic regime mix has more clean trends than May 5 actually had
(b) Live news/calendar engines DRAG composite via conflicting signals
    (the synthetic stubs don't add this drag)
(c) Live data has more chop/noise than synthetic at M1

If (a) or (c): the synthetic baseline overstates engine capability.
If (b): the news/calendar engines ACTIVELY HURT composite, and
priority 1.7 gains importance beyond just the highImpact veto.

I suspect (b) based on production traces. When priority 1.7 ships and
re-runs of this baseline (with real news fixtures) become possible in
priority 7 (synthetic calibration), this question gets answered.

For now: **the live ceiling is lower than the synthetic ceiling.** That
is informative — and uncomfortable.

— 1M
