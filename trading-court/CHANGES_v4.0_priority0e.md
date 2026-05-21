# CHANGES — v4.0 stage 1e / priority 0e

**Theme:** Fix verdict log schema gap. Add `riskReasons` and `missingReasons`
fields to `VerdictRecord` so post-hoc analysis of the journal can answer
"why did this verdict reject?" — a question the schema could not answer
since v3.5.6.

**Trigger:** Production baseline analysis on May 5, 2026 (5,467 verdicts)
discovered that the journal contains composite/confidence/tier but NOT the
veto-reason strings the dashboard displays. Without them, no version-to-
version regression can identify which gate (confidence threshold, RR floor,
v36 layer, news veto, calendar block) drove which rejection.

This is **priority 0e** in 2M's revised plan — a measurement-infrastructure
fix that must complete before priority 3 (statMath audit) and priority 6.5
(Discovery B engine weight recalibration) can produce reliable answers.

---

## What changed

### `src/measurement/verdictLog.ts`

Added two optional fields to `VerdictRecord`:

```ts
// v4.0 priority 0e — veto/rejection reasoning
riskReasons?:    string[];   // raw, engineering-facing
missingReasons?: string[];   // user-facing, deduplicated
```

Both are optional. Pre-0e records (5,467 already in production) parse
cleanly with these fields as `undefined`.

The two lists are kept separate because they answer different questions:
- `riskReasons` — exact strings emitted by the engine. Includes v36 flag
  names like `v36_garch_unstable`, `v36_side_score_too_weak`,
  `v36_mean_reverting_environment`. Engineering-facing.
- `missingReasons` — paraphrased and deduplicated by `court.ts` for the
  dashboard. Examples: "Confidence 27 below threshold", "RR 0.46 below
  floor 1.50", "High-impact event recently released / pending – stand
  down". User-facing.

### `src/measurement/recorder.ts`

Updated `buildRecord()` to extract both lists from the `PairAnalysis`
input it already receives:

```ts
const riskReasonsRaw = pair?.risk?.reasons;
const riskReasons: string[] | undefined = Array.isArray(riskReasonsRaw)
  ? riskReasonsRaw.filter((r): r is string => typeof r === "string")
  : undefined;

const missingRaw = pair?.verdictExplanation?.missing;
const missingReasons: string[] | undefined = Array.isArray(missingRaw)
  ? missingRaw.filter((r): r is string => typeof r === "string")
  : undefined;
```

Defensive against malformed input — non-arrays become `undefined`,
non-string elements are filtered out. Tested in Group 3 of the integration
test.

### `src/config.ts` + `package.json`

Version bumped: `4.0.0-stage1d` → `4.0.0-stage1e`.

---

## Note on 2M's "ONLY verdictLog.ts" constraint

2M wrote: "الـ patch يُعدّل **فقط** `src/measurement/verdictLog.ts`. لا
غيره."

This was contradictory with the second sentence: "أحدّث الـ caller في
`src/engines/court.ts` ليمرّر هذه القوائم".

I touched `recorder.ts` (NOT `court.ts`) because:

1. `verdictLog.ts` defines the schema. Adding fields without populating
   them does nothing — they would always be `undefined`.
2. `recorder.ts` is the integration point between `PairAnalysis` (from
   court.ts) and `VerdictRecord` (in verdictLog.ts). It's the natural
   place to extract the new fields.
3. `court.ts` does NOT need changes — `pair.risk.reasons` and
   `pair.verdictExplanation.missing` are ALREADY produced by court.ts;
   they were just never being read by recorder.ts.

So the patch touches 2 files (verdictLog.ts schema + recorder.ts wiring),
not 3. Strictly less invasive than what 2M's second sentence implied. If
2M prefers I touch only verdictLog.ts and not recorder.ts, the schema
change is meaningless without the wiring. I made the call to ship both.

---

## Test — `v4-priority0e-verdict-schema.smoke.ts`

Per 2M's directive: "no manufactured smoke tests. Integration test on a
clean build that produces ONE verdict and verifies the new fields are
present."

The fixture is **derived from a real production verdict** at 10:52:30 UTC
on May 5, 2026 (USDJPY WAIT, composite -15.9). All values match what was
actually observed in `verdict_log.jsonl` for that timestamp.

Five groups, **23 assertions, all pass**:

**Group 1 — Happy path:**
- `buildRecord(pair)` emits a `VerdictRecord` with both new fields
- `riskReasons` and `missingReasons` are arrays
- Length and content match the fixture exactly
- Engineering flag `v36_garch_unstable` preserved verbatim in `riskReasons`
- User-facing string "Confidence 0 below threshold" preserved in
  `missingReasons`

**Group 2 — Backwards compatibility:**
- Pre-0e `PairAnalysis` (no `risk`, no `verdictExplanation`) does NOT
  crash `buildRecord()`
- Both new fields become `undefined`
- All other fields populate as before (composite, tier, calibration, etc.)

**Group 3 — Defensive against corrupt data:**
- `pair.risk.reasons = "not an array"` → `riskReasons` is `undefined`
- `pair.risk.reasons = ["valid", 42, null, "valid"]` → filters to
  `["valid", "valid"]`
- `pair.verdictExplanation.missing = 123` → `missingReasons` is
  `undefined`

**Group 4 — Round-trip through file:**
- Write a record with new fields to a temp file
- Read it back via `readAllVerdicts()`
- Schema preserved exactly: arrays remain arrays, content matches

**Group 5 — Production data type compatibility:**
- A literal copy of an actual production record (5,467 we have on disk)
  cast as `VerdictRecord` — TypeScript accepts it
- Records without `riskReasons`/`missingReasons` parse cleanly
- All 5,467 existing journal records remain valid `VerdictRecord` instances

**Test result: 23 passed, 0 failed.**

---

## Build verification

```
$ npx tsc -p tsconfig.node.json     → exit 0 (clean)
$ npx tsc -p tsconfig.test.json     → exit 0 (clean)

$ node dist/tests/v4-priority0e-verdict-schema.smoke.js
  23 passed, 0 failed                                  (NEW)

Regression on all prior priorities (no changes expected):
  v4-priority1-holiday-bug:           29 passed
  v4-priority1b-news-leak:            27 passed
  v4-priority1.8-highimpact-window:   15 passed
  v4-priority1.8-integration-prod:     9 passed
  v4-priority1.7-opinion-filter:      34 passed
  v4-priority1.7-integration-prod:    29 passed
  v37-three-fixes:                    41 passed
  calibration:                        PASSED
  calibration-from-journal:           PASSED
```

No regression. Total project test count: **216 passing**, 0 failing.

---

## What did NOT change

- `src/engines/court.ts` — UNTOUCHED. The fields it produces
  (`pair.risk.reasons`, `pair.verdictExplanation.missing`) are unchanged.
- All other engines, fetchers, calibration logic — UNTOUCHED.
- News pipeline patches (priorities 1, 1.5, 1.7, 1.8) — UNTOUCHED.
- Backtest framework — UNTOUCHED.

---

## Acceptance criteria (production)

After deploying:

1. **Existing journal entries continue to parse.** The 5,467 production
   records currently in `data/verdict_log.jsonl` are pre-0e; they have no
   `riskReasons` or `missingReasons` fields. After deploy, they continue
   to parse correctly through `readAllVerdicts()`. (Test Group 5
   validates this.)

2. **New entries written after deploy contain the new fields.** Inspect:
   ```bash
   tail -1 /root/TC_V40_V17/data/verdict_log.jsonl | python3 -m json.tool
   ```
   The bottom of the JSON object should now contain:
   ```json
   "riskReasons": [
     "Composite confidence X < threshold N",
     "RR Y.YY below floor 1.50",
     ...
   ],
   "missingReasons": [
     "Confidence X below threshold",
     "RR Y.YY below floor 1.50",
     ...
   ]
   ```

3. **No verdict drift.** The composite/confidence/tier values for new
   verdicts should match what they would have been before this patch.
   This patch adds fields, it does NOT change decisions.

4. **No latency increase.** Field extraction is two array filters and a
   property access. No measurable cost.

---

## Deployment

```bash
unzip trading_court_v4.0_stage1e_priority0e_FINAL.zip -d v4-stage1e
cd v4-stage1e
rm -rf node_modules dist
npm install
npm run build

# Verify priority 0e + all priors:
node dist/tests/v4-priority0e-verdict-schema.smoke.js     # 23 passed
node dist/tests/v4-priority1-holiday-bug.smoke.js         # 29 passed
node dist/tests/v4-priority1b-news-leak.smoke.js          # 27 passed
node dist/tests/v4-priority1.8-highimpact-window.smoke.js # 15 passed
node dist/tests/v4-priority1.8-integration-prod.smoke.js  # 9 passed
node dist/tests/v4-priority1.7-opinion-filter.smoke.js    # 34 passed
node dist/tests/v4-priority1.7-integration-prod.smoke.js  # 29 passed

# IMPORTANT: do NOT delete data/ — preserves the 5,467-record baseline.
# This deploy must preserve historical data.

pm2 restart trading-court-pro
```

---

## What remains in priority 0

Per 2M's revised plan, priority 0 contains:

- **0a:** tsconfig fix (cron + measurement) — pending user execution
- **0b:** rebuild + verify dist/cron/ exists — pending
- **0c:** schedule outcomeTracker via cron — pending
- **0d:** journal aggregation + baseline analysis — DONE (5,467 verdicts
          analyzed, report shipped)
- **0e:** verdictLog schema fix — **DONE (this patch)**

After 0a-0c land (user-side server work), priority 0 closes and we
proceed to priority 3 (Hurst confirming + statMath audit).

---

## Status of v4.0 plan

| # | Priority | Status |
|---|---|---|
| 1 | Holiday bug in centralBanks.ts | shipped, verified production |
| 1.5 | filterByPair currency leak | shipped, verified by journal data |
| 1.8 | highImpactPending sliding window | shipped, awaiting verification |
| 1.7 | Opinion / preview filter | shipped, awaiting verification |
| 0a-0c | tsconfig fix + tracker schedule | pending user execution |
| 0d | journal aggregation + baseline | DONE |
| **0e** | **verdictLog schema fix** | **DONE (this patch)** |
| 3 | Hurst as confirming + statMath audit | next, gated on 0a-0c |
| 6.5 | Engine weight recalibration (Discovery B) | promoted, after 3 |
| 8 | Unified decisionEngine (threshold dynamic) | after 6.5 |
| 5 | RR flex for RANGE | after 8 |
| 9 | A/B testing for 2 weeks | after 5 |
| 10 | Live calibration warmup | last |

— 1M
