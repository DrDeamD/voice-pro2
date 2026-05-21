# CHANGES — v4.0 stage 1f / priority 3a (R6)

**Theme:** Add `highImpactPending` field to `newsContext` in verdict log.
Single-line journal observability fix.

**Trigger:** Priority 3 statMath audit (1M, 2026-05-05) discovered that the
`highImpactPending` boolean — which is the DIRECT cause of the visible veto
"High-impact event recently released / pending – stand down" emitted from
`risk.ts:62-64` — was NOT being logged to the verdict journal. As a result,
post-hoc analysis could see that the veto fired but could not distinguish
between several possible causes.

This is **priority 3a** in 2M's revised plan — a measurement-only fix that
must complete and accumulate 2-3 days of journal data before priority 3b
(Hurst confidence cap + signal smoothing) can be evaluated against real data.

---

## D1 walkback — 1M's incorrect "third veto source" hypothesis

This patch explicitly walks back a hypothesis I (1M) made in the previous
round.

### What I claimed

After analyzing the production verdict at 2026-05-05T15:00:28.457Z (XAUUSD
WAIT) which contained `riskReasons: ["High-impact event recently released /
pending – stand down"]` while `newsContext.breakingActive=false`,
`newsContext.msidActive=false`, and `calendarContext.blockedBy=null`, I
hypothesized that there must be a "third veto source" — some code path
emitting that string outside the priorities 1.7+1.8 patch surface.

### What was actually happening

There is **no third veto source**. The string is emitted from exactly one
location: `risk.ts:62-64`, which checks ONE field: `news.highImpactPending`.

The reason the veto fired was that `news.highImpactPending` was `true` at
the time of that verdict. But:

1. The journal was logging `breakingActive`, `breakingScore`, `msidActive`
2. The journal was NOT logging `highImpactPending`
3. So my analysis of the journal could see "veto fired, all logged news
   flags are false" and incorrectly concluded "the trigger must be from
   somewhere else"

The hypothesis was wrong. The fix is to log the field that was being read
but not written.

### The lesson

**A hypothesis based on absence of evidence in the journal is only valid
if the journal is known to log that evidence.** Before claiming "this veto
came from an unknown source", I should have first verified that all three
known sources are observable in the journal. They were not. I jumped from
"not visible" to "third source must exist".

2M's process notes added: before claiming `discovered new source`, verify
observability of all known sources in the journal first. If the relevant
field is not logged, the diagnosis is hypothesis, not finding.

---

## What changed

### `src/measurement/verdictLog.ts`

Added one optional field to `VerdictNewsContext`:

```ts
export interface VerdictNewsContext {
  breakingActive: boolean;
  breakingScore:  number;
  msidActive:     boolean;
  highImpactPending?: boolean;  // NEW
}
```

Optional for backwards compatibility with the 5,400+ records already in
production. Pre-3a records parse cleanly with this field as `undefined`.

### `src/measurement/recorder.ts`

Updated `buildRecord()` to populate the field:

```ts
const newsContext = {
  breakingActive:    !!news.breakingActive,
  breakingScore:     numOr0(news.breakingScore),
  msidActive:        !!(news.interventionRegime && news.interventionRegime.active),
  highImpactPending: !!news.highImpactPending,    // NEW
};
```

`!!` coerces undefined to false (defensive). When the source pair object
has `highImpactPending` set (true or false), it is preserved verbatim.
When absent, it becomes `false` — distinguishable from pre-3a records
where the field is `undefined`.

### `src/config.ts` + `package.json`

Version bumped: `4.0.0-stage1e` → `4.0.0-stage1f`.

---

## What this enables

After 2-3 days of new journal data with this field, we can answer for
every verdict where the "High-impact event" veto fired:

```
SELECT
  COUNT(*) WHERE highImpactPending=true && breakingActive=false  → fresh real news event
  COUNT(*) WHERE highImpactPending=true && breakingActive=true   → covered by both
  COUNT(*) WHERE highImpactPending=false && veto string present  → bug, escalate
```

If we see records in the third bucket, that's a real third source and
priority 3a needs a follow-up. If we don't, then priority 1.7's keyword
filter and priority 1.8's window logic are correctly attributing all
high-impact vetoes.

---

## Test — `v4-priority3a-highimpact-observability.smoke.ts`

Per 2M's directive: "no manufactured smoke tests. Integration test on
production fixture."

Fixture #1 (`makeBaselinePair`): derived from production USDCAD verdict at
2026-05-05T10:52:30.972Z. All news flags false.

Fixture #2 (`makeHighImpactPendingPair`): derived from production XAUUSD
verdict at 2026-05-05T15:00:28.457Z — the verdict that originally triggered
the D1 investigation. `highImpactPending=true` while breakingActive and
msidActive are false. Risk reasons contain the visible veto string.

Fixture #3 (`makeLegacyPair`): pre-priority-1.8 simulation where
`news.highImpactPending` is `undefined`. Tests defensive coercion.

Five groups, **16 assertions, all pass:**

**Group 1 — Baseline:**
- `highImpactPending` logged as `false` when news flags are clean
- Other newsContext fields unchanged

**Group 2 — XAUUSD 15:00 reproduction:**
- `highImpactPending` logged as `true`
- breakingActive remains `false`
- riskReasons (priority 0e schema) contains the visible veto string
- This combination is now journalable for the first time

**Group 3 — Legacy compat:**
- pre-1.8 pair where `news.highImpactPending=undefined` → coerces to `false`
- No crash, other fields unchanged

**Group 4 — Round-trip:**
- Two records (one with each fixture) written, read back
- Field preserved across write/read
- True remains true, false remains false

**Group 5 — Pre-3a production records:**
- A literal sample from the actual production journal (5,400+ records)
- Cast as `VerdictRecord` — TypeScript accepts (field is optional)
- Pre-3a records have `highImpactPending = undefined`, distinguishable
  from post-3a `false`

**Test result: 16 passed, 0 failed.**

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
v37-three-fixes:                    41 passed
calibration:                        PASSED
calibration-from-journal:           PASSED

Total: 232 tests passing, 0 failing
```

No regression on any prior priority.

---

## What did NOT change

- `src/engines/court.ts` — UNTOUCHED. The `highImpactPending` field is
  already populated by `newsEngine.ts:305` and consumed by `risk.ts:62`,
  `court.ts:162`, `court.ts:364`. We just expose it to the journal.
- `src/engines/risk.ts` — UNTOUCHED. The veto logic is unchanged.
- `src/engines/newsEngine.ts` — UNTOUCHED. Priority 1.7 + 1.8 are
  unaffected.
- All statistical engines, calibration, dashboard — UNTOUCHED.

---

## Acceptance criteria

After deploying:

1. **Existing journal entries continue to parse.** The 5,400+ pre-3a records
   have no `highImpactPending` field. After deploy, they continue to parse
   correctly — the field is optional. (Test Group 5 validates this.)

2. **New entries written after deploy contain the field.** Inspect:
   ```bash
   tail -1 data/verdict_log.jsonl | python3 -m json.tool | \
     grep -A 3 newsContext
   ```
   Expected:
   ```json
   "newsContext": {
     "breakingActive": false,
     "breakingScore": 0,
     "msidActive": false,
     "highImpactPending": false  ← NEW
   },
   ```
   For verdicts during high-impact events, value will be `true`.

3. **No verdict drift.** Composite, confidence, tier remain identical.
   This patch adds an observability field, it does NOT change decisions.

4. **No latency increase.** One additional `!!` coercion per verdict.
   Imperceptible.

---

## Deployment

```bash
unzip trading_court_v4.0_stage1f_priority3a_FINAL.zip -d /root/TC_V40_V19
cd /root/TC_V40_V19

# Preserve journal continuity:
mkdir -p data
cp /root/TC_V40_V18/data/verdict_log.jsonl data/

# Build with the existing tsconfig fix (already applied to V18; copy to V19):
cp /root/TC_V40_V18/tsconfig.node.json ./tsconfig.node.json
rm -rf node_modules dist
npm install
npm run build

# Verify:
node dist/tests/v4-priority3a-highimpact-observability.smoke.js   # 16 passed

# Switch PM2:
pm2 stop v40-stage1e
pm2 delete v40-stage1e
pm2 start dist/server.js --name v40-stage1f --cwd /root/TC_V40_V19
pm2 save

# 1 minute later, verify field appears:
sleep 60
tail -1 data/verdict_log.jsonl | python3 -c "
import json, sys
r = json.loads(sys.stdin.read())
print('Version:', r['version'])
print('highImpactPending:', r['newsContext'].get('highImpactPending', 'MISSING — patch failed'))
"
```

Expected output:
```
Version: 4.0.0-stage1f
highImpactPending: false   (or true during real high-impact events)
```

If `MISSING — patch failed` — the recorder didn't pick up the change.
Investigate: was the build cache stale? Did pm2 actually restart from V19?

---

## What remains in priority 3

Per 2M's revised plan, priority 3 splits into 3 sequential rounds:

- **3a (this patch):** highImpactPending observability — DONE pending review
- **3b:** R1 (Hurst confidence cap fix) + R2 (Hurst signal smoothing) —
  ships AFTER 3a accumulates 2-3 days of journal data.
- **3c:** R3 (Hurst as confirming directional witness) — ships AFTER 3b.
  Requires design doc answering 2M's three questions about Hurst/regime/
  composite conflict resolution.

Then priority 6.5 (Discovery B + R4 H4 candles + R5 +20 baseline removal)
in the same wave.

— 1M
