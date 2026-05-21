# CHANGES — v4.0 stage 1g / priority 3b-prep

**Theme:** Comprehensive audit logging. Adds nested `v3b` object to verdict
log capturing 10 raw component scores + session state + full v36 statistical
court state including all 4 witness outputs.

**Trigger:** Priority 6.5 design draft and experiment (a)+(c) identified
that `applyV36StatisticalCourt`'s confidenceDelta is the dominant compression
bottleneck (production confidence p99 = 26.1, max = 36, threshold = 77).
To select between options A/B/C/D for the delta fix, we need per-verdict
visibility into trustScore, sideScore, cap-firing, and per-witness outputs.
Without this data, choosing between options is guess-by-design — what 2M
classified as "synthetic reasoning".

This is **priority 3b-prep** in 2M's revised plan — a measurement-only
patch that must complete and accumulate 24-36 hours of journal data before
priority 6.5-main can ship with a data-justified option choice.

---

## What changed

### `src/measurement/verdictLog.ts`

Added new exported interface `VerdictV3bAudit` with three top-level groups:

```ts
export interface VerdictV3bAudit {
  components: {  // 10 raw scores from composeScores
    marketStructure, mtfAlignment, momentum, vwap, priceAction,
    manipulation, divergence, regimeScore, correlation, newsScore
  };
  session: {  // session weight + pre-multiplier composite
    name, weight, compositeBeforeSession
  };
  v36: {  // statistical court state
    truthOk, trustScore, sideScore, trustFloor, confidenceCap,
    confidenceDelta, oldConfidence, newConfidence,
    witnesses: {
      hurst:  { signal, confidence, reliable, h, r2 }
      garch:  { signal, confidence, reliable, persistence }
      rvb:    { signal, confidence, reliable, jumpRatio }
      hawkes: { signal, confidence, reliable, longEvents, shortEvents }
    }
  };
}
```

Added optional `v3b?: VerdictV3bAudit` field to `VerdictRecord`. Optional
for full backwards compatibility with all pre-3b-prep records.

### `src/measurement/recorder.ts`

Updated `buildRecord()` to populate `v3b` from data already in
`PairAnalysis`:
- `pair.scores.{...}` for the 10 components (some cast as `any` because
  composeScores stores manipulation/divergence/vwap/marketStructure via
  `as any` cast)
- `pair.session.name` + `pair.scores.sessionWeight` + `pair.scores.compositeRaw`
  for session state
- `pair.v36.{truth, court, oldConfidence, newConfidence, witnesses}` for
  v36 state (added by `applyV36StatisticalCourt` via `as any` cast)
- Witness lookup by name (RealizedVolBipower, HurstExponent, GARCH, HawkesLite)
  with metric extraction from `witness.metrics.*`

Defensive design:
- `pair.v36` may be absent if truth gate hard-failed — all v36 fields default
  to 0/null with `truthOk = false` distinguishing this from "ran but rejected"
- `numOrNull()` helper returns `null` for non-finite values (preserves
  signal "we couldn't measure" vs "we measured and got 0")
- All component fields use `numOr0()` (preserves "engine voted 0" semantics)

### `src/config.ts` + `package.json`

Version bumped: `4.0.0-stage1f` → `4.0.0-stage1g`.

---

## What this enables — the priority 6.5 decision matrix

After 3b-prep deploy and 24-36 hours of accumulated data, we can answer:

```
distribution of trustScore across all verdicts:
  → if p50 ≥ 58 (close to floor) → priority 6.5 picks Option B
  → if bimodal at 50 & 65         → Option A (graduated symmetric)
  → if p50 < 50 (low and broad)   → Option D (linear trustMargin)
  → if p50 ≥ 60 already           → Option C (boost-dominant)
```

These four hypotheses currently cannot be distinguished from journal data —
that is exactly the gap 3b-prep closes. Per-witness data also enables
post-fix verification: did R1+R2 (priority 3b-main, deferred) actually
move Hurst confidence from <0.35 to higher values?

---

## D1-pattern observability — third application of the rule

This is the **third time** in priority 3 alone that we've shipped a schema
extension before the related fix:
1. **Priority 0e** — riskReasons + missingReasons (closed gap from v3.5.6)
2. **Priority 3a** — highImpactPending (closed news veto attribution gap)
3. **Priority 3b-prep** — comprehensive v3b audit (this patch)

The pattern is now well-established: **observability before intervention**.
Each shipped fix has been measurable in retrospect, which has been a key
input to subsequent decisions (D1 walkback, experiment (c) results,
priority 6.5 option ranking).

The cost of these schema-only patches is small (~3-4 hours each, no
behavioral risk). The benefit is large — every analytical decision after
the patch ships is data-grounded rather than synthetic.

---

## Test — `v4-priority3b-prep-audit.smoke.ts`

Per 2M's directive: integration test on production-shaped fixtures, no
manufactured smoke data. **62 assertions across 9 groups, all pass.**

**Group 1 — 10 raw component scores:**
All 10 fields extracted correctly from `pair.scores`. The fixture USDJPY
uses values from real production (marketStructure=-20, mtf=20, news=-46.6,
etc.) at 2026-05-05T15:00.

**Group 2 — Session state:**
Verifies `name=NY`, `weight=1.08` (NY weight from SESSION_WEIGHTS),
`compositeBeforeSession=-22` (raw before applySession multiplier).

**Group 3 — v36 court state:**
trustScore=55, sideScore=30, trustFloor=60 (TREND_DOWN regime, not RANGE),
confidenceCap=72 (GARCH unstable cap), confidenceDelta=-13 (typical
production: trust<60 → -8, cap<100 → -5).

**Group 4 — Witness outputs:**
All 4 witnesses' signal, confidence, reliable, and key metrics extracted:
Hurst (h, r2), GARCH (persistence), RVB (jumpRatio), Hawkes (longEvents,
shortEvents). Values match real witness output shapes.

**Group 5 — Legacy pair (no v36):**
Pre-3b-prep simulation: when `pair.v36` is absent (e.g., during initial
deploy before applyV36 ran), all v36 fields default to safe values.
truthOk=false, all numbers=0, all metric fields=null. Components still
extract from pair.scores.

**Group 6 — Truth gate failed:**
v36 attached but `truth.ok=false`, court state all zeros. Witness array
empty (no witnesses ran). All metric fields=null. Distinguishable from
"ran but rejected" (truthOk=true, fields populated).

**Group 7 — RANGE regime:**
trustFloor correctly computed as 45 (priority 3.7b range-aware floor)
when `pair.regime.label === "RANGE"`. trustScore preserved.

**Group 8 — Round-trip through file:**
Write to temp file, read back, verify all v3b fields preserved across
JSON serialization/deserialization. Also verifies prior priority 0e fields
(riskReasons) coexist correctly.

**Group 9 — Pre-3b-prep records still valid:**
Real production record from before this patch (no v3b field) parses
cleanly as `VerdictRecord`. TypeScript accepts; v3b is undefined;
all other fields preserved including priority 3a's highImpactPending.

**Test result: 62 passed, 0 failed.**

---

## Regression — all prior priorities

```
v4-priority1-holiday-bug:           29 passed
v4-priority1b-news-leak:            27 passed
v4-priority1.8-highimpact-window:   15 passed
v4-priority1.8-integration-prod:     9 passed
v4-priority1.7-opinion-filter:      34 passed
v4-priority1.7-integration-prod:    29 passed
v4-priority0e-verdict-schema:       23 passed
v4-priority3a-highimpact-observability: 16 passed

Total: 244 tests passing (incl. 62 new), 0 failing
```

No regression on any prior priority.

---

## What did NOT change

- `src/engines/court.ts` — UNTOUCHED. composeScores produces all 10
  components on `pair.scores`; we just expose them to the journal.
- `src/engines/v36/statCourt.ts` — UNTOUCHED. applyV36StatisticalCourt
  attaches `pair.v36` already; we just expose to the journal.
- `src/engines/v36/statMath.ts` — UNTOUCHED. All four witnesses produce
  metrics already; we just extract.
- News pipeline (priorities 1, 1.5, 1.7, 1.8) — UNTOUCHED.
- Behavior of any verdict — UNTOUCHED. This is observability only.

---

## Acceptance criteria (production)

After deploying:

1. **Pre-3b-prep journal entries continue to parse.** ~2,200+ records
   currently in production have no `v3b` field. They continue to parse
   correctly — the field is optional. (Test Group 9 validates this.)

2. **New entries written after deploy contain `v3b`.** Inspect:
   ```bash
   tail -1 /root/TC_V40_*/data/verdict_log.jsonl | python3 -m json.tool | \
     grep -A 30 '"v3b"'
   ```
   Expected: nested object with components/session/v36 sub-objects, each
   populated.

3. **No verdict drift.** composite, confidence, tier, all other fields
   remain identical pre/post deploy. This patch adds observability fields,
   it does NOT change decisions.

4. **No latency increase.** Field extraction is property access + array
   filter (`witnessByName`). Imperceptible (<0.1ms/verdict).

---

## Deployment

```bash
# Stop here, send to 2M for review. Do NOT deploy without 2M approval.
```

---

## What remains in priority 3 + 6.5 chain

Per 2M's revised plan (after experiment (c) results):

```
Wed May 6 21:00      → 3b-prep ship + verify             (THIS PATCH)
Thu May 7 21:00      → analyze 3b-prep data + ship 6.5-main (option from data)
Fri May 8 21:00      → measure 6.5 impact
Sat-Sun May 9-10     → STOP (markets closed)
Mon May 11 21:00     → ship 3b-main (R1+R2 Hurst)        — now measurable
Tue May 12 21:00     → ship 3c (Hurst-as-confirming + design doc)
Wed May 13 21:00     → close priority 3 + 6.5 chain
```

D4 (XAU candles in ASIA) parallel track: investigate during ASIA UTC
window starting tonight ~23:00 CEST. Independent of this patch.

— 1M
