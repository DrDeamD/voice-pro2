# CHANGES — v4.0 stage1h / priority 3a-bis (D4) + priority 6.5-main

**Theme:** Two patches shipping together.

1. **Priority 3a-bis (D4)** — MARKET_CLOSED regime label for XAU/USD when broker
   spot quotes freeze during the daily 21:00-23:00 UTC closure window.
2. **Priority 6.5-main** — Replace v3.7b tier-based confidenceDelta with Option D
   (linear trustMargin × sideMag formula) AND lower MIN_TRUST_SCORE from 60 to 50.

These are independent in scope but share a deploy window. They fix two distinct
problems identified in the priority 3 audit and 3b-prep journal data.

---

## Why ship together

Both patches are surgical (~5-20 lines each) and were validated by the priority
3b-prep journal data shipped 12 hours earlier. Shipping them in one stage1h
window:
- Reduces deploy overhead on the user
- Allows joint measurement: confidence distribution shift + XAU regime cleanup
- Keeps the priority 3 + 6.5 + D4 chain on schedule

The two patches do NOT interact technically:
- D4 changes regime detection at court.ts integration point
- 6.5-main changes statistical court delta computation
- Tested independently (Sections A and B of the integration test)

---

## Priority 3a-bis (D4) — what changed

### Background

Production journal showed XAU/USD producing `regime=UNKNOWN` for ~35% of
ASIA-session verdicts. After 4 wrong hypotheses (timeout, kraken config,
kraken not configured, cache poisoning), the user provided the actual root
cause: retail FX brokers (MT5, swissquote) close spot gold trading during
a daily low-liquidity window. PAXG-based candle sources (Kraken, Coinbase)
trade 24/7 and serve fresh candles, but the spot quote source freezes,
leaving the indicator pipeline computing on stale data.

### What the patch does

1. Added `MARKET_CLOSED` to `RegimeLabel` type union.
2. New helpers in `src/engines/regime.ts`:
   - `isInClosureWindow(symbol, now)` — returns true when symbol is XAUUSD
     and current UTC time is in [21:00, 23:00).
   - `makeMarketClosedRegime(ind)` — constructs a synthetic RegimeReport
     with label=MARKET_CLOSED, ADX preserved for diagnostics, ATR/BB nulled
     to flag stale data.
3. In `src/engines/court.ts`, intercept regime classification:
   ```ts
   const regime = isInClosureWindow(symbol, now)
     ? makeMarketClosedRegime(indH4)
     : classifyRegime(indH4);
   ```

### What this does NOT do

- Does NOT change candle fetcher logic. Kraken/Coinbase calls work as before.
- Does NOT block analysis during the window — verdict is still produced,
  just labeled correctly as MARKET_CLOSED for downstream filtering.
- Does NOT affect any non-XAU symbol or any time outside 21:00-23:00 UTC.

### Implications for measurement

Pre-D4: 19 of 54 ASIA XAU verdicts had regime=UNKNOWN, contaminating any
baseline analysis that included XAU. Post-D4: same 19 will be tagged
MARKET_CLOSED, easily filterable for analysis.

The Discovery B baseline (5,467 verdicts pre-priority 3a) included some
of these contaminated XAU verdicts. The Discovery B core findings (chain
compression) were robust to this contamination, but any future XAU-specific
analysis can now exclude MARKET_CLOSED records cleanly.

---

## Priority 6.5-main — what changed

### Background

Discovery B (May 5 2026) identified that production confidence p99 = 26,
max = 36 vs threshold = 77, with zero verdicts ever reaching BUY/SELL.
Experiments (a) and (c) traced the bottleneck to `applyV36StatisticalCourt`'s
`confidenceDelta` formula, which produced -13 in the typical case
(trustScore<60 → -8, cap fires → -5).

Priority 3b-prep data (May 7, 686 verdicts, 12h sample) added the missing
piece: trustScore distribution in production is essentially binary per pair,
clustered at 45.6 and 52.3, with **0% of verdicts ever exceeding the old
MIN_TRUST_SCORE=60**. The trust gate was a permanent block.

### What the patch does

1. **MIN_TRUST_SCORE constant** in `src/engines/v36/statCourt.ts` lowered
   from 60 to 50. Justification: production p75 = 52.3, so threshold 50
   opens ~25-35% of verdicts for trust-gated downstream logic. Threshold
   60 was a structural impossibility (0% pass rate observed).

2. **trustFloor logic** unchanged in formula but value updated by cascade:
   - RANGE regime: still 45 (priority 3.7b range-aware floor)
   - Other regimes: now 50 (was 60)

3. **confidenceDelta formula** replaced from tier-based to linear (Option D):
   ```ts
   // Old (v3.7b):
   if (trustScore >= 60 && |sideScore| >= 50) +6
   if (trustScore >= 70 && |sideScore| >= 70) +4
   if (trustScore < trustFloor)              -8
   if (confidenceCap < 100)                  -5

   // New (priority 6.5-main, Option D):
   const trustMargin = trustScore - trustFloor;
   const sideMag = |sideScore|;
   confidenceDelta = clamp((trustMargin * sideMag) / 250, -10, +15);
   if (confidenceCap < 100) confidenceDelta -= 2;
   ```

### Why Option D over A/B/C

From priority 6.5 design draft, four options were presented:
- **A** (tier-graduated symmetric): cliffs at trust 60/70 — won't fit our distribution
- **B** (penalty-only relaxation): smallest change, but still uses tier 60 boost — won't fire
- **C** (boost-dominant): requires trust ≥ 60 — never reached, **impotent**
- **D** (linear margin × sideMag): smooth, no cliffs, scales naturally with our binary-ish distribution

3b-prep data (`p25=p50=45.6, p75=52.3, stdev=0` per pair) shows distribution
is bimodal-low. Option D handles this cleanly — both modes get small deltas,
no spurious tier-cliff effects.

### Calibration on production scenarios

| Scenario                                              | v3.7b old | 6.5 new |
|-------------------------------------------------------|-----------|---------|
| Production p50 (trust=45.6, side=30, cap fires)       | -13       | -2.53   |
| Production p75 (trust=52.3, side=40, no cap)          | -8        | +0.37   |
| Strong aligned (trust=75, side=80, no cap, rare)      | +10       | +8.0    |
| Theoretical max boost (trust=100, side=100)           | +10       | +15     |
| Theoretical max penalty (trust=0, side=100, cap)      | -13       | -12     |

Net effect:
- Typical production cases: penalty ~5x softer, occasional small boost
- Strong aligned cases: similar magnitude (+8 vs +10), still positive
- Extreme bounds: contained by clamps, no over-correction

### Predicted production impact

- **Trust gate pass rate**: 0% → ~25-35% (verdicts at p75 = 52.3 mode pass)
- **Confidence p99**: 26 → ~36 (improvement of ~+10 from delta softening)
- **Confidence max**: 36 → ~46 (still well below MIN_CONFIDENCE=77)
- **BUY/SELL rate**: stays ~0/hour. **Priority 6.5-main is foundational, not
  trade-unlocking.** MIN_CONFIDENCE=77 remains the binding constraint and is
  NOT modified in this patch. Trade unlock requires priority 8 (threshold
  tuning) which sequences after priority 3b-main and 3c.
- **tier classifications**: REJECT rate drops from 100% to ~85%. Some verdicts
  reach WEAK/VALID tier, even if final verdict stays WAIT. This is the
  user-visible signal that the system is no longer fully blocked.
- **Internal metrics quality**: confidence numbers become honest (less
  compressed). Useful for downstream calibration data accumulation.

**This patch is intentionally a foundation, not a trade-unlock.** A user
expecting BUY/SELL signals immediately after deploy will be disappointed.
The value is structural: trust gate becomes a meaningful signal instead of
a permanent block, the v36 layer's behavior aligns with empirical trustScore
distribution, and the path to actual trade unlocking (via priority 8) is
clear and measurable.

### Why MIN_TRUST_SCORE 50 specifically

- Not 45: matches RANGE floor; would erase the meaningful regime distinction
- Not 55: empirical p75 = 52.3, would still fail ~75% of verdicts
- Not 60: empirical 0% pass rate, the entire problem we're fixing
- **50 is the largest value that opens a meaningful pass rate without erasing regime distinction**

---

## What did NOT change

- `src/engines/regime.ts` `classifyRegime()` itself — D4 layers MARKET_CLOSED
  on top, doesn't modify the existing classifier
- `src/fetchers/candles.ts` — fetcher chain unchanged. The candle issue was
  never about candles; PAXG works fine 24/7
- News pipeline (priorities 1, 1.5, 1.7, 1.8) — UNTOUCHED
- Verdict log schema (priority 3b-prep nested object) — UNTOUCHED
- The `allowed` condition in v36 court — uses new trustFloor (50/45) but
  same logic
- `MIN_CONFIDENCE = 77` — unchanged. This is independent of trust gate

---

## Test — `v4-stage1h-d4-and-priority6.5.smoke.ts`

Per 2M's directive: integration test on production-shaped fixtures with real
numbers from the 3b-prep journal. **44 assertions across 11 groups, all pass.**

### Section A — D4 patch
- **A1**: closure window boundaries (9 assertions including 21:00 lower edge,
  21:30 mid-window matching production UNKNOWN times, 23:00 upper exclusive)
- **A2**: symbol filter — only XAUUSD triggers, 7 other symbols stay open
- **A3**: makeMarketClosedRegime preserves ADX, nulls volatility metrics
- **A4**: regimeScore returns 0 for MARKET_CLOSED (no directional bias from
  stale data) — sanity-checked against TREND_UP returning +48 at same ADX
- **A5**: classifyRegime unchanged for non-closure paths

### Section B — Priority 6.5-main delta + MIN_TRUST_SCORE
- **B1**: production-scenario calibration (p50 case shows -13→-2.53, p75 shows
  -8→+0.37)
- **B2**: strong aligned case bounded at +8.0 (under +15 clamp)
- **B3**: theoretical max boost clamped to +15, max penalty clamped to -12
- **B4**: RANGE regime keeps trustFloor=45, behaves softer than non-RANGE (50)
- **B5**: cap penalty reduced from -5 to -2
- **B6**: trust gate pass rate calibration on real 686-verdict sample
  (0/686 at threshold 60, 239/686 ≈ 34.8% at threshold 50)

**Test result: 44 passed, 0 failed.**

---

## Regression — all 9 prior tests

```
v4-priority1-holiday-bug:           29 passed
v4-priority1b-news-leak:            27 passed
v4-priority1.8-highimpact-window:   15 passed
v4-priority1.8-integration-prod:     9 passed
v4-priority1.7-opinion-filter:      34 passed
v4-priority1.7-integration-prod:    29 passed
v4-priority0e-verdict-schema:       23 passed
v4-priority3a-highimpact-observability: 16 passed
v4-priority3b-prep-audit:           62 passed (1 fixture updated for new trustFloor=50)

Total: 288 tests passing (incl. 44 new), 0 failing
```

The 3b-prep audit had one fixture assertion updated: `v36.trustFloor` for a
TREND_DOWN regime fixture changed from 60 → 50. This is expected — the
trustFloor mirror in `recorder.ts` was updated to match the new
`MIN_TRUST_SCORE`. The fixture is otherwise identical to the original
production verdict.

---

## Acceptance criteria (production)

After deploying:

1. **XAU/USD verdicts in 21:00-23:00 UTC window show regime=MARKET_CLOSED**
   (not UNKNOWN). Verify:
   ```bash
   tail -200 data/verdict_log.jsonl | python3 -c "
   import json, sys
   for line in sys.stdin:
       if line.strip():
           r = json.loads(line)
           if r.get('pair') == 'XAUUSD' and '21:' in r['ts']:
               print(r['ts'], r['components'].get('regime'))
   "
   ```
   Expected: regime=MARKET_CLOSED for entries between 21:00:00Z and 22:59:59Z.

2. **Confidence distribution shifts up modestly**. Verify after 6h of accumulation:
   ```bash
   python3 -c "
   import json, statistics
   confs = []
   with open('data/verdict_log.jsonl') as f:
       for line in f:
           r = json.loads(line)
           if r.get('version') == '4.0.0-stage1h':
               confs.append(r['confidence'])
   if confs:
       print(f'n={len(confs)}, p99={statistics.quantiles(confs, n=100)[98]:.1f}, max={max(confs):.1f}')
   "
   ```
   Expected: p99 in [32, 42] range, max in [40, 50] range. Notably both
   still below MIN_CONFIDENCE=77 — this is expected; trade unlock is priority 8.

3. **Trust gate pass rate >0%**. Verify in v3b nested data:
   ```bash
   python3 -c "
   import json
   total, passed = 0, 0
   with open('data/verdict_log.jsonl') as f:
       for line in f:
           r = json.loads(line)
           if r.get('version') == '4.0.0-stage1h' and r.get('v3b'):
               v = r['v3b']['v36']
               if v['truthOk']:
                   total += 1
                   if v['trustScore'] >= v['trustFloor']:
                       passed += 1
   print(f'Trust gate pass rate: {passed}/{total} ({100*passed/total if total else 0:.1f}%)')
   "
   ```
   Expected: 25-40% pass rate (was 0% pre-6.5).

4. **No verdict crashes or errors**. Inspect `pm2 logs v40-current --err`.

5. **BUY/SELL verdicts should NOT appear** (this patch is foundational; if
   any BUY/SELL appears at >5/hour, refer to rollback triggers — likely
   indicates over-correction in delta or unintended interaction with
   MARKET_CLOSED regime).

---

## Rollback paths

### Path 1 (easiest) — restore previous deployment
```bash
pm2 stop v40-current && pm2 delete v40-current
pm2 start dist/server.js --name v40-current --cwd /root/TC_V40_V20  # the stage1g dir
```
~5 minutes.

### Path 2 — soften by raising trust threshold back
Edit live: `MIN_TRUST_SCORE = 60` (still using Option D delta), rebuild,
restart. Trust gate locks again but delta improvement remains.

### Path 3 — full rollback to v3.7b delta
Replace the Option D block with the v3.7b tier-based block. ~10 lines.
Rebuild, restart.

### Trigger conditions for rollback

- Confidence p99 jumps from 26 → 70+ (over-correction)
- BUY/SELL verdicts > 5/hour sustained (any positive rate is informative for
  this patch since predicted ~0; 5+/hour means delta over-corrected)
- tier classifications above VALID for >50% of verdicts
- Any v36 layer test fails post-deploy

### Trigger conditions we do NOT roll back on

- Confidence rises into [30, 50] range (intended)
- BUY/SELL verdicts at 0/hour (intended — this patch is foundational, not
  trade-unlocking)
- Some verdicts now reach WEAK/VALID tier instead of universal REJECT (intended)
- MARKET_CLOSED appears for XAU during 21:00-23:00 UTC (intended)

---

## Sequencing

```
[Now]                  → ship stage1h (this patch)
[+24h]                 → measure confidence/trust pass rate / BUY-SELL count
[+24h analysis]        → priority 6.5 retrospective: did predictions match?
[+48h]                 → ship priority 3b-main (R1+R2 Hurst) — now measurable
[+72h]                 → ship priority 3c (Hurst-as-confirming + design doc)
[+96h]                 → close priority 3 + 6.5 chain
```

After this sequence, the priority 3 family closes. Next priorities (4, 5, 7, 8, 9)
re-evaluated based on data.

---

## Discoveries logged for backlog

**D5 — stat witnesses tied to H1 only**

The 3b-prep journal data revealed that trustScore has stdev=0.0 for 6 of 7
pairs over a 12-hour sample. This is because all 4 statistical witnesses
(Hurst, GARCH, RV-B, Hawkes) compute on H1 candles only. H1 candles update
once per hour, so 50+ verdicts within the same H1 produce identical witness
output — leading to identical trustScore.

This is not a bug under priority 3+6.5 scope, but it limits the system's
ability to react to intraday changes. **Defer to priority 9 architectural
review:** should witnesses recompute on M15 or M5? The decision involves
a tradeoff between responsiveness and statistical noise.

**D5b — v36 court does not respect MARKET_CLOSED regime**

Theoretical edge case identified during stage1h review (2M):

`applyV36StatisticalCourt` runs independently of the regime label set in
`court.ts`. If v36's truth gate passes (PAXG candles fresh, 24/7) AND
v36's court allows (statistical witnesses + new softer trust gate), v36
can override the upstream WAIT verdict and emit BUY/SELL — even when the
regime label is MARKET_CLOSED. Sequence:
1. court.ts:321 sets regime=MARKET_CLOSED for XAU at 21:30 UTC
2. court.ts:157 tradablePair() returns false → upstream verdict = WAIT
3. applyV36StatisticalCourt runs on PAXG candles (fresh)
4. If v36 court allows, line 311 sets nextVerdict = directionToVerdict(side)
5. → BUY/SELL emitted on stale spot data

In practice this is unlikely because:
- XAU only (no other symbol triggers MARKET_CLOSED currently)
- 2-hour window per day (21:00-23:00 UTC)
- v36 trust gate post-fix still fails ~65% of the time
- v36 truth gate may itself reject during stale-quote conditions

But it's not impossible. **Defer to priority 7:** v36 court should check
`analysis.regime?.label === "MARKET_CLOSED"` and force WAIT, regardless of
witness output. Stale spot quotes invalidate directional signals even when
PAXG candles look fresh. Same logic should apply to any future "low data
quality" regime labels (e.g., DEAD with no liquidity, weekend rollover).

Estimated patch size: ~5 lines in `applyV36StatisticalCourt`.

— 1M
