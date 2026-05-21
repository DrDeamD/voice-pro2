# CHANGES — v4.0 stage 1c / priority 1.8 (revised)

**Theme:** `highImpactPending` becomes a sliding-window flag.

This document was revised after a process-level review. The technical
content is unchanged. What changed:

1. Added explicit acknowledgment that the 60-min window is a guess,
   not measured. Code-level TODO links to priority 9.
2. Added an integration test built from the user's actual production
   screenshots (10:13 UTC, May 5, 2026), proving the smoke-test result
   matches the production data shape — and revealing one finding the
   smoke test alone missed (see "Integration test finding" below).
3. Restored priority 4 (Asia confidence) to its original position.
   Earlier I marked it "candidate for cancellation" based on a single
   London screenshot — insufficient evidence to overrule a previously
   approved decision.
4. Removed two priorities I had self-discovered and added without
   approval (10.5 — MS scoring re-architecture; 10.7 — engine weight
   re-calibration). They are real findings, but adding them to the
   active plan was scope creep. They are now in a "Discovered, awaiting
   approval" section at the bottom.

The technical fix in `newsEngine.ts` is unchanged from the previous
revision of this document.

---

## The technical fix (unchanged)

`src/config.ts` — new tunable:

```ts
highImpactPendingWindowMin: 60,
```

`src/engines/newsEngine.ts` — gated aggregation:

```ts
const windowH = RULES.highImpactPendingWindowMin / 60;
for (const it of items) {
  // ... existing sentiment aggregation (unchanged) ...
  if (
    it.highImpact &&
    it.freshnessHours !== null &&
    it.freshnessHours >= 0 &&
    it.freshnessHours <= windowH
  ) {
    highImpact = true;
  }
}
```

Stale `highImpact` items keep contributing to sentiment scoring.
They no longer trigger the risk-gate `stand-down` veto.

---

## On the 60-minute number (TODO logged in code)

The value 60 is an **educated guess**, not measured. It is the median
of common practitioner guidance ("wait an hour after major data"). The
empirically optimal value depends on the specific event class:

- NFP: typical liquidity recovery 30-45 min
- ECB rate decision + press conference: 90-120 min (Q&A reveals new info)
- CPI: 30-60 min
- Fed minutes: 15-30 min

A single global value cannot be optimal for all of these. The 60 is a
conservative middle.

**Code-level TODO** in `src/config.ts` at the rule definition: when
priority 9 (live calibration warmup) accumulates ~6 weeks of journal
data, the constant should be re-derived per-event-type from outcome
distributions. Until then, acceptable range is 45-90; outside that,
we are guessing wildly.

---

## Integration test finding

`src/tests/v4-priority1.8-integration-prod.smoke.ts` reproduces the
user's USD/CHF view at 10:13 UTC, May 5, 2026. It uses the actual
items shown in the dashboard:

- "Gold's outlook remains neutral-to-bearish..." [POLICY, ForexLive, 0.8h]
- "Switzerland April CPI +0.6% vs +0.6% y/y expected" [DATA, ForexLive, 1.7h]
- "What are the main events for today?" [DATA, ForexLive, 1.8h]
- (RBA items filtered out by priority 1.5 — verified)

After applying filterByPair (priority 1.5) and the 60-minute window
(priority 1.8), the test asserts:

> `highImpactPending = true` on USD/CHF — **the production scenario is
> NOT fully fixed by priority 1.8 alone.**

Reason: "Gold's outlook" is 0.8h old (within window), tagged USD via
the "Fed" keyword, and classified POLICY → `highImpact = true`. The
window patch correctly excludes the 1.7h CPI but the 0.8h opinion
piece keeps the veto active.

**Implication:** priority 1.7 (opinion/preview filter) is NOT optional.
It is required to fully fix the USD/CHF veto. The integration test
asserts both behaviors:

- After 1.8 alone: `pending = true` (Gold's outlook keeps it active)
- After 1.7 + 1.8 (Gold's outlook downgraded to GENERAL): `pending = false`

This is a finding that the smoke test (which used clean fixtures)
could not have surfaced. It demonstrates why the integration test was
necessary.

---

## Test results

```
$ node dist/tests/v4-priority1.8-highimpact-window.smoke.js
  15 passed, 0 failed                          (smoke — fixture-based)

$ node dist/tests/v4-priority1.8-integration-prod.smoke.js
  9 passed, 0 failed                           (NEW — production fixture)

$ node dist/tests/v4-priority1-holiday-bug.smoke.js
  29 passed, 0 failed                          (priority 1 still passes)

$ node dist/tests/v4-priority1b-news-leak.smoke.js
  27 passed, 0 failed                          (priority 1.5 still passes)

$ node dist/tests/v37-three-fixes.js
  41 passed, 0 failed
```

---

## Active v4.0 plan (corrected)

| # | Priority | Status |
|---|---|---|
| 1 | Holiday bug in centralBanks.ts | shipped & verified |
| 1.5 | filterByPair currency leak | shipped, awaiting verification |
| 1.8 | highImpactPending sliding window | shipped, awaiting verification |
| 1.7 | Opinion/preview filter in news classifier | next (gated on verification) |
| 3 | Hurst as confirming + statMath.ts review | after 1.7 |
| 4 | Asia confidence (absolute, not multiplicative) | after 3 |
| 5 | RR flex for RANGE near-edge | after 4 |
| 2 | Regression baseline | gated on journal data availability |
| 6 | FRED -> USD_BROAD rename | low |
| 7 | Synthetic calibration on historical data | gated on backtest data |
| 8 | Unified decisionEngine, threshold 77, feature flag | after 3, 4, 5 |
| 9 | A/B testing for 2 weeks | after 8 |
| 10 | Live calibration warmup | last |

---

## Discovered during execution — pending user approval, NOT in active plan

These are real findings from auditing the codebase. They are NOT in
the active plan and will not be executed without explicit user
approval. Documented here for transparency.

### Discovery A — Market structure scoring conflicts with its own context

In `engines/marketStructure.ts`, the score reflects structural bias
(BOS direction). The accompanying text-based context says
"PREMIUM 65% — hunt SHORTS only". When MTF and Regime engines align
bearish but MS score is +22 because of a recent BULL BOS, the
composite incorrectly weighs MS as bullish even though the operational
advice in the text is to short.

Observed in production at 10:13 UTC on USD/CAD: MS +23 ("BOS_BULL,
77% premium, hunt shorts") with MTF -70, Regime -51, Momentum -25.8,
VWAP -32, PA -18 — composite ended at -22 instead of -35+ because MS
fought the consensus.

**Estimated work:** 1 day. Refactor MS scoring to compose structural
bias and zone-based execution advice into a single coherent score.

### Discovery B — Engine weights cap composite at ~+/-50 in practice

Sum of weights <= 1.0; individual engine outputs rarely exceed +/-60;
arithmetic ceiling for `|composite|` is ~+/-50 in normal conditions.
Combined with the v36 layer's MIN_CONFIDENCE = 77, this means
`confidence >= 77` is mathematically near-impossible.

**Estimated work:** 0.5 day. Re-calibrate weights to allow `|composite|`
to reach 70+ on strong setups. Requires regression baseline (priority
2) to validate.

### Discovery C — Calendar UI shows passed events as "in progress"

Cosmetic. Spanish Unemployment Change at 07:00 UTC was 73 minutes past
when observed at 08:13. UI showed "جاري..." (in progress). Likely cause:
`actual` field null + `scheduledTime` past = falls through to default
"in progress" state.

**Estimated work:** 15 minutes. UX polish, no analysis impact.

---

## Acceptance criteria (production)

After deploying, observe at the next analysis cycle:

### Mandatory: stale-event veto inspection

If you see a high-impact event in the breaking-news list that is
**>60 minutes old**, the affected pair's risk-gate "missing reasons"
should NOT contain `High-impact event recently released / pending –
stand down` — UNLESS another fresh high-impact item is also present
(e.g. the priority-1.7-territory "Gold's outlook" opinion piece).

### Mandatory: fresh-event still vetoes

If a high-impact event released **less than 60 minutes ago** is on
the ticker, the affected pair SHOULD still show the stand-down veto.

### Important caveat

Per the integration test finding above: priority 1.8 alone does NOT
fully clear USD/CHF when the news feed contains a USD-tagged opinion
piece classified as POLICY. Priority 1.7 will close that gap.

---

## Deployment

```bash
unzip trading_court_v4.0_stage1c_priority1.8_FINAL.zip -d v4-stage1c
cd v4-stage1c
rm -rf node_modules dist
npm install
npm run build

# Verify all priority smoke + integration tests:
node dist/tests/v4-priority1-holiday-bug.smoke.js          # 29 passed
node dist/tests/v4-priority1b-news-leak.smoke.js           # 27 passed
node dist/tests/v4-priority1.8-highimpact-window.smoke.js  # 15 passed
node dist/tests/v4-priority1.8-integration-prod.smoke.js   # 9 passed

pm2 restart trading-court-pro
```

After restart: any pair currently vetoed by a stale (>60 min)
high-impact event with NO fresh USD-tagged opinion piece in the feed
should be released at the next analysis cycle.
