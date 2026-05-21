# CHANGES — v4.0 stage 1b / priority 1.5

**Theme:** Fix `filterByPair` news-leak in `fetchers/news.ts`. Stops
currency-specific breaking news from polluting unrelated pairs.

This is a follow-up to v4.0-stage1 (priority 1, the central-bank holiday
bug). Production verification at 06:16 UTC on May 5, 2026 showed the
priority 1 patch worked correctly (no holiday entries in breaking news,
real RBA event correctly displayed) — but exposed a second bug in the
news pipeline that was not part of the original audit report.

---

## What was found in production after priority 1 deployed

User dashboard at 06:16 UTC, ~14 minutes before RBA Cash Rate decision:

- Breaking news box: "Heads up: RBA monetary policy decision set for the
  bottom of the hour" (impactCurrencies = `[AUD, NZD]`, breaking = true)
- AUD/USD: "High-impact event recently released / pending – stand down"
  (CORRECT — RBA imminent)
- EUR/USD: "High-impact event recently released / pending – stand down"
  (WRONG — RBA does not affect EUR)
- USD/CAD: same wrong veto
- USD/CHF: same wrong veto
- USD/JPY: same wrong veto (additionally MSID-active on JPY, but RBA
  shouldn't have been a contributing factor)
- XAU/USD: same wrong veto

Five out of seven pairs were vetoed by an event that doesn't affect
their currencies. This was not the holiday bug (priority 1 fixed that)
but a separate leak in the news pipeline.

## Root cause

`fetchers/news.ts:filterByPair()` had a "let breaking through" bypass:

```ts
return items.filter(it =>
  it.impactCurrencies.some(c => ccys.has(c)) ||
  it.breaking,                                    // ← this line
);
```

The original intent (v3.3 era): "let global breaking events through to
all pairs even if currency keywords don't match." Reasonable in theory.

In practice: every CURRENCY-SPECIFIC breaking event (RBA AUD news,
BoJ JPY intervention, ECB EUR statement) bypassed the currency filter
for ALL pairs. The newsEngine then aggregated these items into the
items list for unrelated pairs, set `highImpactPending = true`, and the
risk gate vetoed every pair with the standard "stand down" message.

The pollution path:
```
RBA breaking item                         (impactCurrencies = [AUD, NZD])
   ↓ filterByPair allowed via `|| it.breaking`
EUR/USD items list contains RBA item
   ↓ newsEngine.ts:208 sets highImpact = true
EUR/USD news.highImpactPending = true
   ↓ risk.ts:62
EUR/USD WAIT with "High-impact event ... – stand down"
```

## Fix

Removed the `|| it.breaking` bypass:

```ts
function filterByPair(items: NewsItem[], base: string, quote: string): NewsItem[] {
  const ccys = new Set([base, quote]);
  if (base === "XAU") ccys.add("USD");
  return items.filter(it => it.impactCurrencies.some(c => ccys.has(c)));
}
```

An item passes the pair filter ONLY if its impactCurrencies intersects
the pair's currencies. The breaking flag, highImpact flag, sentiment,
velocity score — all preserved on items that pass. Only the PASS
criterion changed.

## Trade-off (documented for honesty)

The bypass had a legitimate edge case: a TRULY global event (e.g.
"World Bank issues recession warning") with empty impactCurrencies
will now be filtered out for all pairs. Acceptable because:

1. The item's downstream contribution to scoring already required
   impactCurrencies (newsEngine.ts aggregates per-currency); without
   them, the item produced no per-pair signal anyway.
2. The classifier in news.ts:buildItem matches against the full
   currency-keyword lexicon. A genuinely global event will, in
   practice, mention at least one major currency.
3. Geopolitical events get the GEOPOLITICS category and route through
   the correlation engine (DXY/Gold/Oil/VIX), not news.

If a real global event with empty impactCurrencies starts appearing
and affecting analysis quality, we add it to the GENERAL→ALL routing
in a future patch. For now, the cost of the leak is much higher than
the cost of this edge case.

## What did NOT change

- `centralBanks.ts` — priority 1 fixes intact.
- `newsEngine.ts` — internal logic unchanged. The MSID detection,
  breakingActive flag, dynamic-weights mode all work the same. They
  now operate on a CORRECT per-pair items list.
- All other engines, calibration, judge — untouched.

## Smoke test

`src/tests/v4-priority1b-news-leak.smoke.ts` — 27 assertions, 4 groups:

1. **Group 1 (production scenario)**: For each of the 7 instruments,
   verify that an RBA-tagged breaking item with `[AUD, NZD]` impact
   correctly passes for AUD/USD and is correctly filtered out for
   EUR/USD, USD/CAD, USD/JPY, USD/CHF, XAU/USD. (16 assertions)

2. **Group 2 (no regression)**: Confirm that items passing the filter
   keep their breaking and highImpact flags intact. (2 assertions)

3. **Group 3 (multi-currency events)**: G7 statement with
   `[USD, EUR, JPY, GBP]` correctly reaches all matching pairs and is
   filtered out from non-matching pairs (e.g. AUD/NZD). (1 assertion)

4. **Group 4 (edge cases)**: Empty input, items with empty
   impactCurrencies (filtered out), XAU→USD expansion still works.
   (3 assertions)

Result: **27/27 pass**.

## Build verification

```
$ npx tsc -p tsconfig.node.json     → exit 0
$ npx tsc -p tsconfig.test.json     → exit 0

$ node dist/tests/v4-priority1-holiday-bug.smoke.js
  29 passed, 0 failed                                  (priority 1 still passes)

$ node dist/tests/v4-priority1b-news-leak.smoke.js
  27 passed, 0 failed                                  (priority 1.5 — NEW)

$ node dist/tests/calibration.smoke.js                 → PASSED
$ node dist/tests/calibration-from-journal.smoke.js    → PASSED
$ node dist/tests/v37-three-fixes.js
  40 passed, 1 failed                                  (same 1 pre-existing
                                                        VWAP failure as v3.10)
```

## Acceptance criteria (production)

After deploying this patch, observe at the next analysis cycle:

### Mandatory: per-pair veto inspection

For pairs WHERE no real high-impact event is pending in the FairEconomy
calendar within ±30min of a HIGH-impact match, the risk-gate "missing
reasons" should NOT contain:

```
High-impact event recently released / pending – stand down
```

UNLESS the news engine has detected a separate breaking event that is
relevant to the pair's currencies (e.g. fresh Fed news on USD pairs).

### Specific test (replays the production scenario)

If RBA Cash Rate is imminent on the dashboard:
- AUD/USD should still show the high-impact veto (RBA is real for AUD)
- EUR/USD, USD/CAD, USD/CHF, XAU/USD should NOT show the high-impact
  veto unless they have their own pair-relevant breaking event

### Mandatory: breaking news box content

The breaking news box at the top of the dashboard is global UI; it
shows all current breaking items system-wide. This is unchanged. The
box may still show RBA/BoJ/ECB items even on EUR/USD's detail view.
That is OK — only the per-pair veto behavior is changing.

### Mandatory: source health

`fl_centralbank`, `forexlive`, `gnews` pills should remain green.
This patch does not change fetching, only post-fetch filtering.

## What if it doesn't work

### A. Wrong pairs still get high-impact veto

Check whether the breaking items are ACTUALLY currency-specific:

```bash
# Check the items going into a specific pair
grep "RBA monetary policy" /var/log/trading-court/*.log | head
```

If the items are leaking through despite this patch:

1. Verify the patch deployed: `grep -c "Removed the.*it.breaking.*bypass" src/fetchers/news.ts` → should be 1
2. Check if the items have impactCurrencies that incorrectly include
   the pair's currencies. The classifier in news.ts:buildItem uses
   `CURRENCY_KEYWORDS` to assign impactCurrencies. If "RBA" is leaking
   into USD-tagged items, the keyword match is wrong somewhere.

### B. Real Fed news no longer reaches pairs

If a genuine Fed item disappears from USD pairs, the issue is that the
classifier didn't tag it with USD. Check the item title/description —
does it contain any USD_KEYWORDS? If "POWELL" / "FOMC" / "FED" / "USD"
all missing, the item shouldn't have been considered breaking USD news
to begin with.

### C. WAIT rate didn't drop noticeably

Expected for sessions with no real breaking events. Priority 1.5's
benefit is primarily during real currency-specific breaking events
(RBA, BoJ, ECB rate decisions). Outside those moments, the v36
statistical court (priority 8) and Asia session weighting (priority 4)
remain the dominant rejectors.

## Deployment

```bash
unzip trading_court_v4.0_stage1b_priority1.5_FINAL.zip -d v4-stage1b
cd v4-stage1b
rm -rf node_modules dist
npm install
npm run build

# Verify both priority 1 and 1.5 smoke tests pass:
node dist/tests/v4-priority1-holiday-bug.smoke.js   # 29 passed, 0 failed
node dist/tests/v4-priority1b-news-leak.smoke.js    # 27 passed, 0 failed

pm2 restart trading-court-pro
```

## Status of v4.0 plan

| # | Priority | Status |
|---|---|---|
| 1 | Holiday-bug fix in centralBanks.ts | ✅ shipped (stage1) |
| **1.5** | **filterByPair news-leak fix** | **✅ shipped (stage1b)** |
| 2 | Regression baseline (journal or backtest replay) | ⏳ awaiting journal data |
| 3 | Hurst as confirming + statMath.ts review | not started |
| 4 | Asia session weight (absolute, not multiplicative) | not started |
| 5 | RR flex for RANGE (with near-edge condition) | not started |
| 6 | FRED → USD_BROAD rename | not started |
| 7 | Synthetic calibration on 3-month historical | not started |
| 8 | Unified decisionEngine, threshold 77, feature flag | not started |
| 9 | A/B testing for 2 weeks | not started |
| 10 | Live calibration warmup | not started |

Tell me which is next and I proceed.
