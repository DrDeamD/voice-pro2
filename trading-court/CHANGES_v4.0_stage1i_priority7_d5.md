# CHANGES — v4.0 stage1i / priority 7 (D5)

**Theme:** Statistical witnesses migrated from H1 to M15 candles, eliminating the
duplicate-signal problem that gates priority 8 (trade unlock).

**Single-variable change:** Witness math, thresholds, bands — all unchanged.
The only change is the input timeframe.

---

## Why this patch is critical (and ordered first)

### The discovery

Production retrospective on 1456 stage1h verdicts (May 7-8 2026, 22h sample):

```
trustScore stdev=0.0 for 6 of 7 pairs
35 VALID verdicts identified — but ALL 35 were USDCHF/NY/TREND_DOWN
35 confidence values clustered between 60.1 and 61.8
```

These were not 35 trade candidates. They were ONE trade snapshot, repeated 35
times across one TREND_DOWN H1 candle in NY session, by polling cadence
(~10 seconds per cycle).

Root cause: all 4 statistical witnesses (RV-B, Hurst, GARCH, Hawkes) computed
on H1 candles. H1 updates once per hour. Within a single H1, witness inputs
were identical → witness outputs identical → trustScore identical.

### Why we shipped this BEFORE priority 8

The original plan put priority 8 (MIN_CONFIDENCE tuning) before D5. Original
intent: lower MIN_CONFIDENCE from 77 to ~60 and observe BUY/SELL emergence.

With the D5 finding, that plan would have produced:
- Lowering MIN_CONFIDENCE → first BUY/SELL appears
- Same H1 witness output → SAME signal repeated 35-50 times
- Dashboard floods with duplicate USDCHF SHORTs (or whatever the H1 produces)
- "Trades" exist but they're not real diversity — same opportunity sampled

That would be operational chaos. D5 must come first so priority 8 has clean
underlying signals to work with.

---

## What changed

### Code change (1 file, ~5 lines functional)

`src/engines/v36/statCourt.ts:308`

```diff
- const h1 = input.series["1h"]?.candles ?? [];
+ const m15 = input.series["15m"]?.candles ?? [];

  const statWitnesses: V36WitnessResult[] = truth.ok ? [
-   realizedVolBipowerWitness(h1),
-   hurstWitness(h1),
-   garchWitness(h1),
-   hawkesLiteWitness(h1),
+   realizedVolBipowerWitness(m15),
+   hurstWitness(m15),
+   garchWitness(m15),
+   hawkesLiteWitness(m15),
  ] : [];
```

(Plus a 30-line comment block explaining rationale for future maintainers.)

### What did NOT change

- `src/engines/v36/statMath.ts` — UNTOUCHED. All 4 witness implementations,
  formulas, bands, thresholds, sample-size requirements remain identical.
- truth gate (`truth.ts`) — already validates M15 (it's in REQUIRED list)
- recorder (`recorder.ts`) — schema unchanged
- regime detection — unchanged
- statistical court delta logic (priority 6.5-main) — unchanged
- All v36 court allowed/blocked logic — unchanged

This is the most disciplined change we could make: ONE variable, no other
adjustments. Any difference in production behavior is attributable solely to
timeframe, not threshold tuning.

---

## Why M15 (not M5, not M30)

### Considered alternatives

| Timeframe | Verdict | Reason |
|-----------|---------|--------|
| **M15**   | ✅ chosen | 4 candles/hour. Ample sample size. Fresh witnesses every 15 min. Series already fetched. |
| M5        | ❌ rejected | Microstructure noise dominates. Returns at this scale have very low signal/noise. Hurst H drifts toward 0.5. |
| M30       | ❌ rejected | Half the data points. Hurst's 128-candle requirement = 64h of data. Not fresh enough. |

### Sample size adequacy at M15

Witness data requirements (unchanged):
- RV-B: ≥ 48 returns (≥ 49 candles) → 12.25 hours of M15
- Hurst: ≥ 128 prices → 32 hours of M15
- GARCH: ≥ 96 returns → 24 hours of M15
- Hawkes: ≥ 80 candles + ≥ 72 returns → 20 hours of M15

Production fetch depth: `"15m": "P1W"` (1 week) = 672 candles.

All requirements met with massive headroom. No witness will fail "insufficient
data" reliability checks under normal operation.

---

## Risk acknowledged: GARCH persistence at M15

### The known stylized fact

Volatility clustering is more pronounced at finer timescales. GARCH(1,1) fits
on M15 returns typically yield higher α+β (persistence) than the same data
sampled at H1. This is well-documented in the econometrics literature.

### Implication for our thresholds

Current GARCH bands (unchanged):
- persistence > 0.97 → signal -80 (`non_stationary_risk`)
- persistence > 0.94 → signal -35 (`high_persistence`)
- persistence < 0.85 → signal +20 (`stable_variance`)

At M15, "normal" persistence may sit at 0.95-0.97 in many regimes. If so:
- `non_stationary_risk` may fire too often
- `stable_variance` may rarely fire
- Net effect: trustScore biased lower than it should be at M15

### Decision

We ship with original bands and accept this risk for 24-48h of measurement.
After that period, if the data shows GARCH consistently in `non_stationary_risk`
mode for normal markets, we tune bands in a follow-up patch (priority 7-bis).

**Why not tune now:** Single-variable change discipline. If we change both the
timeframe AND the thresholds simultaneously, we cannot isolate the cause of
any post-deploy behavior changes. We change one knob, measure, then tune.

---

## Tests — `v4-stage1i-priority7-d5-m15-witnesses.smoke.ts`

**17 assertions across 5 sections, all passing.** Tests are designed to verify
the migration is sound without manufacturing implausible scenarios.

### Section A — Sample size validation (4 tests)
- RV-B reliable at 96 M15 candles
- GARCH reliable at 144 M15 candles (at 96 it's borderline due to >= check)
- Hurst produces witness output at 144 and 288 M15 candles
- Hawkes produces witness output at 96 M15 candles

### Section B — Diversity property (3 tests)
- Trending vs volatile candle series produce DIFFERENT jumpRatio
- Trending vs volatile produce DIFFERENT GARCH persistence
- Trending vs volatile produce DIFFERENT Hawkes signal

This is the entire point of D5: different inputs must produce different
outputs. Pre-fix, H1 stagnation made this property fail in production.

### Section C — Determinism (5 tests)
- Synthetic candle generator is byte-deterministic
- Each of 4 witnesses produces identical output on identical inputs
- (Confirms migration didn't introduce non-determinism)

### Section D — Intraday change detection (1 test)
- Adding 4 M15 candles (1 hour worth) to a 140-candle series changes at
  least 1 of 4 witnesses' metrics. In our test data, RV-B + Hurst + Hawkes
  changed; GARCH was stable (its grid search picks similar α/β for similar
  data, which is correct behavior).

### Section E — Witness math sanity (2 tests)
- Witnesses are reliable when fed M15 inputs (150 candles)
- Witnesses are reliable when fed H1 inputs (150 candles, same N)
- This proves the migration preserves witness functionality at multiple scales.

---

## Regression — all 11 prior test suites

```
v4-priority1-holiday-bug:           29 passed
v4-priority1b-news-leak:            27 passed
v4-priority1.8-highimpact-window:   15 passed
v4-priority1.8-integration-prod:     9 passed
v4-priority1.7-opinion-filter:      34 passed
v4-priority1.7-integration-prod:    29 passed
v4-priority0e-verdict-schema:       23 passed
v4-priority3a-highimpact-observability: 16 passed
v4-priority3b-prep-audit:           62 passed
v4-stage1h-d4-and-priority6.5:      44 passed
v4-stage1i-priority7-d5-m15-witnesses: 17 passed (new)

Total: 305 tests passing, 0 failing
```

No fixtures needed updating — D5 is a pure timeframe change that doesn't
affect any test that uses synthetic candle inputs (since they were already
N candles regardless of "timeframe").

---

## Predicted production impact

### Diversity emerges (the entire point)

After 24h of stage1i:
- trustScore stdev should be > 0 for ALL pairs (vs 0 for 6 of 7 pre-fix)
- A given pair should produce DIFFERENT trustScore values across different M15
- VALID/WEAK tier distribution should reflect actual market diversity, not
  H1 sampling artifacts

### What may shift

**Trust gate pass rate:**
- Pre-D5 (stage1h): 58.7%
- Post-D5: hard to predict. M15 noisier → more "moderate jump risk" flags →
  occasional trustScore drops. Could land in 40-65% range.

**Confidence distribution:**
- Pre-D5 max: 61.8 (clustered in [60-70) bucket)
- Post-D5: max should still hit 60+ for genuinely strong setups, but they'll
  be DIFFERENT setups (not same USDCHF repeated). Expect richer distribution
  shape in [40-60) and [60-70) buckets.

**Tier diversification:**
- Pre-D5: 35 VALID (all USDCHF/NY/TREND_DOWN)
- Post-D5: VALID count may DECREASE in absolute terms but DIVERSIFY across
  pairs/sessions/regimes. Quality > quantity.

### What MAY NOT change yet

- BUY/SELL count: still ~0/hour. MIN_CONFIDENCE=77 still binding.
- Verdicts: still 100% WAIT. We're not unlocking trades in this patch.

D5 is a foundation patch. Same as 6.5-main was foundation. Trade unlock
remains priority 8 (after 3b-main + 3c).

---

## Acceptance criteria (production)

After 24-48h of accumulation:

1. **Diversity check** — most important:
   ```bash
   python3 -c "
   import json, statistics
   from collections import defaultdict
   per_pair = defaultdict(list)
   with open('/root/TC_V40_V21/data/verdict_log.jsonl') as f:
       for line in f:
           if line.strip():
               r = json.loads(line)
               if r.get('version') == '4.0.0-stage1i' and r.get('v3b'):
                   per_pair[r['pair']].append(r['v3b']['v36']['trustScore'])
   for pair in sorted(per_pair.keys()):
       vals = per_pair[pair]
       if len(vals) > 1:
           print(f'{pair}: n={len(vals)}, stdev={statistics.stdev(vals):.2f}')
   "
   ```
   Expected: stdev > 0 for ALL pairs (not just USDCHF). This is the binary
   test of D5 success.

2. **No regressions** — `pm2 logs v40-current --err --lines 100` clean.

3. **No GARCH over-firing** — count of `non_stationary_risk` reasons in
   recent verdicts should not be a majority of v3b records. If > 50%,
   GARCH bands need tuning.

4. **VALID verdicts diversify** — VALID set should now include multiple
   pairs and/or sessions and/or regimes (not 100% one combination).

---

## Rollback paths

### Path 1 — restore stage1h (5 min)
```bash
pm2 stop v40-current && pm2 delete v40-current
PORT=3337 pm2 start dist/server.js --name v40-current --cwd /root/TC_V40_V21
# (where TC_V40_V21 is now restored to stage1h ZIP contents)
```

### Path 2 — quick revert to H1 (2 min)
Edit `src/engines/v36/statCourt.ts` line 308:
```ts
const m15 = input.series["1h"]?.candles ?? [];
```
(rename keeps but reads H1). Rebuild + restart.

### Trigger conditions

- GARCH `non_stationary_risk` fires > 50% of stage1i verdicts
- Witnesses become UNRELIABLE for > 20% of verdicts (sample size issue)
- Trust gate pass rate drops below 30%
- Any v36 layer test fails post-deploy

### Trigger conditions we do NOT roll back on

- trustScore stdev > 0 across pairs (intended — that's success)
- Tier counts shift (intended — diversification expected)
- Confidence max changes by ±5 points (intended — different signals)

---

## Sequencing — updated roadmap

```
[Fri May 8 evening] → ship stage1i (this patch)
[Sat-Sun May 9-10]  → data accumulates (~3000 verdicts on D5 patch)
[Mon May 11 09:00]  → D5 retrospective on 48h data
                      ─ if successful: ship priority 3b-main + 3c + 8 (combined)
                      ─ if GARCH over-fires: tune bands, re-deploy
[Tue May 12]        → measure combined patch
                      ★ first BUY/SELL signal possible ★
[Wed-Thu May 13-14] → priority 4/5/9 evaluation
```

Total path to first trade: ~4 days (Fri ship → Tue trades).
Original estimate (before D5 prioritization): 5-7 days.

---

## D5 backlog status

D5 (this priority): RESOLVED with M15 migration.

D5b (v36/MARKET_CLOSED interaction): UNCHANGED — still priority 7-bis backlog.
After D5 is verified, address D5b in the same priority slot.

D5c (NEW — possible follow-up): If GARCH bands need tuning at M15, that's a
small ~10-line patch to `statMath.ts` persistence thresholds. Track as
priority 7-bis. Decided after Mon retrospective.

---

— M1 + M2
