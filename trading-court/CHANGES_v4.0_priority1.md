# CHANGES — v4.0 stage 1 / priority 1

**Theme:** Holiday-bug fix in `fetchers/centralBanks.ts`. Eliminates the
production failure mode where future-dated holiday RSS items from central
bank feeds (Boxing Day, Christmas Day, Remembrance Day, scheduled
publications) were classified as BREAKING POLICY events with `freshnessHours = 0`
and `highImpact = true`, which then triggered `news.highImpactPending = true`
and made the risk gate veto every CAD-paired analysis.

This is the first of ten priorities in the v4.0 plan. It is independent of
the other priorities and ships first because:
- The diagnosis is unambiguous (verified against user's 02:49 production
  screenshots).
- The fix is local (one file, one function).
- The acceptance criteria can be verified within minutes of deploy.

---

## Production evidence (before fix)

User dashboard at 02:49 UTC, every pair detail showed:

```
أخبار عاجلة — تأثير محتمل على التحليل
  Boxing Day                                 0m ago    CAD    POLICY
  Christmas Day                              0m ago    CAD    POLICY
  Publication: Summary of Deliberations      0m ago    CAD    POLICY
  Interest Rate Announcement                 0m ago    CAD    POLICY
  Remembrance Day                            0m ago    CAD    POLICY
```

Today's date is May 5, 2026. None of the listed dates (Dec 25/26, Nov 11)
were "0 minutes ago". The "0m ago" was an artifact of three compounding bugs:

1. `Math.max(0, negative)` clamped future timestamps to zero
2. Default category was `POLICY` (not `GENERAL`), so any item without
   policy keywords still got POLICY
3. `highImpact = true` was hard-coded for every CB-feed item, regardless
   of category

The result chain:
```
Future-dated "Boxing Day" entry from BoC RSS
   ↓ Math.max(0, negative) = 0
freshnessHours = 0
   ↓ default category = POLICY
category = POLICY
   ↓ POLICY + freshness 0min ≤ 30min
breaking = true
   ↓ unconditional
highImpact = true
   ↓ newsEngine.ts: any highImpact item → highImpactPending=true
news.highImpactPending = true
   ↓ risk.ts:62: if (news.highImpactPending) passed = false
"High-impact event recently released / pending – stand down"
   ↓
USD/CAD WAIT (regardless of any other signal)
```

Because `news.highImpactPending` is a boolean global per pair, ANY single
contaminated item poisoned the entire pair's analysis.

---

## What changed

### `src/fetchers/centralBanks.ts`

Four concrete changes inside `buildCbNewsItem()`:

#### Fix 1: future-date detection

```ts
// Before
const freshnessHours = pub
  ? Math.max(0, (now - pub.getTime()) / 3600_000)
  : null;

// After
const ageMs = pub ? now - pub.getTime() : null;
const isFresh = ageMs !== null && ageMs >= 0;
const freshnessHours = isFresh ? ageMs! / 3600_000 : null;
```

Future-dated items now get `freshnessHours = null` instead of `0`. The
`isFresh` flag carries the same information explicitly so downstream
checks can no longer mistake "future" for "just published".

#### Fix 2: operational/holiday keyword filter

New constant `OPERATIONAL_KEYWORDS` (24 entries) covering:
- Bank holidays (G10 + global): Boxing Day, Christmas, Remembrance Day,
  Bank Holiday, Good Friday, Thanksgiving, Victoria Day, Canada Day,
  Labour Day, Family Day, Day of Mourning, Golden Week, etc.
- Forward-schedule entries: "Publication:", "MPC SCHEDULE", "FOMC SCHEDULE"
- Operational notices: "OFFICE CLOSED", "OBSERVED"

New helper `isOperationalNotice(text)` checks the title+description.

#### Fix 3: GENERAL is the default, not POLICY

```ts
// Before
let category: NewsItem["category"] = "GENERAL";
if (INTERVENTION_KEYWORDS.some(...)) category = "INTERVENTION";
else if (POLICY_KEYWORDS.some(...))  category = "POLICY";
else category = "POLICY"; // ← removed (this was the bug)

// After
let category: NewsItem["category"];
if (isOperationalNotice(full)) {
  category = "GENERAL";                                // hard override
} else if (INTERVENTION_KEYWORDS.some(...)) {
  category = "INTERVENTION";
} else if (POLICY_KEYWORDS.some(...)) {
  category = "POLICY";
} else {
  category = "GENERAL";                                // changed from POLICY
}
```

The operational filter runs BEFORE the keyword matchers, so a holiday
entry that incidentally contains a policy keyword ("Boxing Day — schedule
for next rate decision") still resolves to GENERAL.

#### Fix 4: highImpact tied to category

```ts
// Before
const highImpact = true;  // unconditional for ALL CB items

// After
const highImpact = category === "INTERVENTION" || category === "POLICY";
```

GENERAL items (holidays, schedule entries, annual reports) no longer
trigger `highImpactPending` and no longer cause risk-gate vetoes.

#### Fix 5 (implicit): breaking now requires `isFresh`

```ts
const breaking = (
  (category === "INTERVENTION" || category === "POLICY") &&
  isFresh &&                                 // explicit dependency
  freshnessHours! * 60 <= RULES.breakingNewsMaxAgeMin
);
```

This is logically equivalent to checking `freshnessHours !== null` after
Fix 1 (because `isFresh === false` ⟹ `freshnessHours === null`), but
making the dependency explicit prevents regressions if the freshness
derivation is ever refactored.

### `src/config.ts`

Version bump:
```ts
export const VERSION = "4.0.0-stage1";  // was "3.10.0"
```

This finally fixes the dashboard footer cosmetic bug noted in the audit.

### `package.json`

Version bump 3.11.0 → 4.0.0-stage1.

### `src/tests/v4-priority1-holiday-bug.smoke.ts` (NEW)

Smoke test, 29 assertions across 4 test groups:

1. **Group 1** — Future-dated holidays (Boxing Day, Christmas Day,
   Remembrance Day, Publication: Summary of Deliberations, future
   Interest Rate Announcement). All correctly classified GENERAL,
   non-breaking, non-highImpact.

2. **Group 2** — Real breaking news still triggers correctly. BoC
   emergency rate cut from 10 minutes ago: POLICY, breaking, highImpact.
   BoC rate hike from 45 min ago (older than `breakingNewsMaxAgeMin`):
   POLICY, NOT breaking, still highImpact.

3. **Group 3** — Operational keyword override. A title combining "Boxing
   Day" and a rate keyword still resolves to GENERAL because
   `isOperationalNotice()` runs first.

4. **Group 4** — Default for non-keyword CB items. An "Annual report 2026"
   item now correctly resolves to GENERAL (was POLICY).

Result: **29/29 pass**.

---

## What did NOT change

Deliberately kept identical to v3.11 to keep this patch surgical:

- `src/engines/v36/statCourt.ts` — the 77-confidence threshold remains.
  The over-rejection from this layer is fixed in priority 8, not now.
- `src/engines/session.ts` — the Asia confidence multiplier remains.
  Fixed in priority 4.
- `src/calibration/*` — calibration data still empty. Fixed in
  priorities 7 and 9.
- All other engines and fetchers — untouched.

---

## Build verification

```
$ npx tsc -p tsconfig.node.json     → exit 0 (no errors)
$ npx tsc -p tsconfig.test.json     → exit 0 (no errors)
$ node dist/tests/v4-priority1-holiday-bug.smoke.js
  29 passed, 0 failed

$ node dist/tests/calibration.smoke.js                     → unchanged from v3.11
$ node dist/tests/calibration-from-journal.smoke.js         → unchanged from v3.11
$ node dist/tests/v37-three-fixes.js
  39 passed, 2 failed   (same 2 failing tests as v3.11/v3.10 baseline)
```

The two pre-existing v37 test failures (`VWAP refused when any bar has
v=0`, `VWAP refused when any bar has negative volume`) are unrelated to
this patch — they were present in v3.10 and v3.11 baselines.

---

## Acceptance criteria (run on production after deploy)

### Mandatory: dashboard inspection

Open the dashboard. For EACH pair detail, the breaking-news box should:

1. **NOT contain** any of: "Boxing Day", "Christmas Day", "Remembrance Day",
   "Bank Holiday", "Publication: Summary of Deliberations" (forward-dated),
   "Interest Rate Announcement" (forward-dated), "Good Friday".

2. May still contain real breaking events that match POLICY keywords AND
   are within 30 minutes — e.g. an actual rate hike from a few minutes
   ago is still BREAKING and that is correct.

### Mandatory: risk-gate inspection

For pairs WHERE no actual high-impact event is pending in the FairEconomy
calendar (i.e. no HIGH-impact event within ±30 min), the risk-gate
"missing reasons" should NOT contain:

```
High-impact event recently released / pending – stand down
```

If no real event is pending, this string should be absent.

For pairs where a real event IS pending (e.g. RBA Cash Rate decision in
4 hours, FOMC in 14 hours), the string MAY still appear — that is correct
and is not affected by this patch.

### Mandatory: source-health verification

The `fl_centralbank` source pill on the dashboard should still show green.
This patch does not change how the source is fetched; it only changes how
items are classified after fetching. If the pill goes red, the issue is
unrelated.

### Recommended: log inspection

If you have access to the application logs, grep for the dynamic-weights
warning:

```
"⚡ BREAKING NEWS ACTIVE — dynamic weights: news ↑ 0.25"
```

Before this patch: this should appear frequently in production logs as
the pollution triggers it. After this patch: this should appear ONLY
when actual breaking news is detected, which is rare.

### Quantitative: WAIT-rate floor (optional, requires journal)

If your journal has data, run before and after deploy:

```bash
node -e "
const fs = require('fs');
const cutoff = Date.now() - 7*24*3600*1000;  // last 7 days
const v = fs.readFileSync('data/verdict_log.jsonl', 'utf8').trim().split('\n')
  .map(l => JSON.parse(l))
  .filter(v => new Date(v.timestamp).getTime() >= cutoff);
const total = v.length;
const wait = v.filter(x => x.verdict === 'WAIT').length;
const cadVeto = v.filter(x => (x.symbol === 'USDCAD') &&
  (x.warnings || []).some(w => w.includes('High-impact'))).length;
console.log('Total verdicts (7d):', total);
console.log('WAIT rate:', (wait/total*100).toFixed(1) + '%');
console.log('USDCAD with high-impact veto:', cadVeto);
"
```

Expected after this patch: USD/CAD with `High-impact ... – stand down`
should drop substantially compared to before. The overall WAIT rate
will probably drop only 1-3% because the other over-rejection mechanics
(v36 layer, Asia weight, calibration heuristic) still apply. Big drops
in WAIT rate happen in priorities 4, 5, 8.

---

## Deployment

```bash
unzip trading_court_v4.0_stage1_priority1_FINAL.zip -d v4-stage1
cd v4-stage1
rm -rf node_modules dist
npm install
npm run build

# Run the smoke test on the production server before going live:
node dist/tests/v4-priority1-holiday-bug.smoke.js
# Expected: "29 passed, 0 failed"

pm2 restart trading-court-pro

# Wait one analysis cycle (~30 seconds), then check the dashboard.
# The breaking-news box should no longer contain the holiday entries.
```

---

## What if it doesn't work

Three possible failure modes, each with diagnosis:

### A. Holidays still appearing as breaking

Check if the deployed file actually contains the patch:

```bash
grep -c "OPERATIONAL_KEYWORDS" src/fetchers/centralBanks.ts
# Expected: 2 (definition + use)
# If 0: deploy did not take. Re-extract the ZIP.
```

If the patch IS deployed but holidays still appear, the issue is in
another fetcher. Check `src/fetchers/news.ts` (general feed) — but the
audit found this fetcher already uses keyword-based classification, so
it should not produce the same bug.

### B. Real BoC breaking news not appearing anymore

If a genuine BoC rate decision (e.g. an actual emergency cut) is missing
from the breaking-news box, the operational keyword filter is too
aggressive. Inspect the title — if it contains a holiday keyword by
coincidence, that is the issue. Adjust `OPERATIONAL_KEYWORDS` to require
more specific matches (e.g. "BANK HOLIDAY" instead of "BANK").

### C. WAIT rate didn't drop at all

This is expected for most sessions because the other over-rejection
layers still apply. The bottleneck is the v36 statistical court (77
confidence threshold) which is fixed in priority 8. Priority 1 only
removes ONE source of the bottleneck — the spurious calendar/news veto
from holiday pollution. If that specific veto wasn't firing on most
pairs (e.g. because their currencies aren't covered by BoC), WAIT rate
won't change much for those pairs.

---

## Next priority

After this patch is verified in production, priority 2 is:

> Build regression baseline from journal data (or, if journal data is
> insufficient, from historical replay via the v3.8 backtest framework).

No code changes for priority 2 — it's a measurement/baseline-collection
task. The actual next code change is priority 3 (Hurst-as-confirming +
statMath.ts review).

Tell me what your journal check showed and we proceed.
