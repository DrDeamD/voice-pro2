# v3.7b — Three Improvements (Opportunity Preservation)

## Decision context

User question: *"Is this project an opportunity killer?"*

Answer (after reading the full code): **Yes, in three specific, fixable ways.**
The truth gate is excellent and untouched here. What was over-tight is the
**statistical opportunity filter** layered on top of it.

User explicitly approved Improvements 1+2+3 and explicitly rejected Improvement 4
(Pre-Gate Granularity) to preserve truth-gate strictness:

> *"البيانات الكاذبة ممنوعة دائماً، لكن الفرص النظيفة لا تُقتل ظلماً."*
> ("False data is always blocked, but clean opportunities are not unjustly killed.")

## What changed

### Improvement 1 — `confidenceDelta` recalibrated symmetric

**File:** `src/engines/v36/statCourt.ts`

Old asymmetry made v36 demote any VALID-tier setup (oldConf 60-72) into WAIT
even on clean truth: max reward +3, max penalty -20.

```
                       OLD                                NEW (v3.7b)
trustScore≥70 + side≥60     +3   →    trustScore≥60 + |side|≥50    +6
                            ─    →    trustScore≥70 + |side|≥70    +4 additional
trustScore<60               -12  →    trustScore<60                -8
confidenceCap<100           -8   →    confidenceCap<100            -5
```

**Calibration finding (during testing):** Realistic witness outputs cap
`trustScore` near 62 (not 70+). The original v37b plan of `+8 at trustScore≥70`
was structurally unreachable. Bonus thresholds are anchored to the actual
achievable range: at the floor (60) gets +6; near-max (70+) gets +10 total.

### Improvement 2 — Range-aware `trustFloor` + cap suppression

**File:** `src/engines/v36/statCourt.ts`

Two coupled changes inside RANGE regime:

1. `trustFloor` lowered from 60 → 45. In a RANGE, mean-reverting Hurst is the
   regime signal, not a defect. The original 60-floor implicitly required
   Hurst > 0.58 (trending), silently killing every clean range setup.

2. Mean-reverting Hurst no longer triggers the 72 confidence cap inside RANGE.
   This was a hidden coupling: even with a relaxed floor, the cap still
   forced `newConf ≤ 72 < MIN_CONFIDENCE(77)`, blocking range trades anyway.
   Inside RANGE we now emit `v36_mean_reverting_consistent_with_range`
   (observation only, no cap, no block).

Outside RANGE, behavior is unchanged: mean-reverting still caps at 72 and
emits `v36_mean_reverting_environment` as before.

### Improvement 3 — Breaking-news veto: direction-aware

**Files:** new `src/engines/breakingNewsVeto.ts`, modified `src/engines/court.ts`

| Direction vs breaking score                   | Before (v3.3.1) | After (v3.7b)                    |
|-----------------------------------------------|-----------------|----------------------------------|
| LONG vs `breakingScore ≤ -45`                 | WAIT            | **WAIT (hard veto)**             |
| SHORT vs `breakingScore ≥ +45`                | WAIT            | **WAIT (hard veto)**             |
| LONG vs `breakingScore ≥ 0` (aligned)         | WAIT            | **confidence -8, NO veto**       |
| SHORT vs `breakingScore ≤ 0` (aligned)        | WAIT            | **confidence -8, NO veto**       |
| Either direction, weak breaking (`|score|<45`)| WAIT            | **confidence -8, NO veto**       |
| Breaking on unrelated currency                | no-op           | no-op                            |
| `breakingActive=false`                        | no-op           | no-op                            |

When confidence is reduced, the helper recomputes plan tier and size multiplier
honestly so downstream consumers cannot mistake a dampened signal for a clean
one. The pure-function shape (`evaluateBreakingNewsVeto`) makes the logic
directly testable without spinning up `analyzePair()`.

## Test results

```
v37b-improvements.ts          34/34 passed   (4 user-spec scenarios + edges)
v37-three-fixes.ts            42/42 passed   (regression: pip / VWAP / pre-gate)
v36-truth-gate-stress.ts       9/9  passed   (regression: truth gate strictness)
v36-stat-court-smoke.ts        OK            (smoke)
integration.ts                36/36 passed   (E2E including Mimura intervention)
```

The 4 user-specified scenarios all behave as required:

1. **Strong trend + v36 aligned** → `delta=+6, allowed=true, BUY preserved` ✅
2. **Clean RANGE, mean-reverting Hurst** → no `v36_trust_score_below_60`, no
   `v36_mean_reverting_environment` cap, allowed when trustScore ≥ 45 ✅
3. **Breaking news vs direction (conflict)** → hard veto, planTier=REJECTED ✅
4. **Breaking news with direction (aligned)** → `confidence 78→70`, no veto ✅

## What was NOT changed

- **Truth gate** (`src/engines/v36/truth.ts`, `preGate.ts`): identical to v37.
  Synthetic data, PT5H-as-H4, stale data, missing series — all still hard-fail
  to a pre-classical WAIT analysis.
- **Pip-value math, VWAP volume requirement, pre-classical gate** (v37 fixes):
  all preserved.
- **Improvement 4 (Pre-Gate Granularity)**: rejected by user, not implemented.
  Truth gate stays all-or-nothing.

## Recommendations for go-live

1. Run **dry-run mode for ≥5 days** before live trading. Observe the verdict
   distribution: if 0 trades on 8 pairs over a normal day, escalate.
2. After ≥50 closed trades, recalibrate `MIN_CONFIDENCE` (currently 77) using
   actual win/loss distributions instead of heuristic.
3. Review the kept `v36_mean_reverting_consistent_with_range` reasons after a
   week — they should appear naturally on RANGE pairs and never cause blocks.
4. Improvement 4 (Pre-Gate Granularity) and News-NLP negation handling can be
   considered after real data shows whether they would help.
