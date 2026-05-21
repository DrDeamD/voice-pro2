# CHANGES — v4.0 stage 1d / priority 1.7

**Theme:** Opinion / preview / forecast / wrap filter in
`src/fetchers/news.ts:buildItem`.

Forces opinion / forecast / wrap articles to `category = GENERAL` and
`highImpact = false`, regardless of which event keywords (Fed, RBA, CPI,
intervention, etc.) appear in their titles. This closes the residual
`highImpactPending` veto that priority 1.8 alone could not.

---

## Production evidence (10:53 UTC, May 5, 2026)

After priorities 1, 1.5, 1.8 deployed, the user observed 7/7 still WAIT.
Inspection revealed the residual veto trigger:

```
"USD/JPY treads with caution amid fear of incurring another intervention hit"
   [BRK · INTERVENTION]  investingLive  ·  0.2h
   [BRK · INTERVENTION]  ForexLive CB   ·  0.4h     (MSID — 4 sources)
```

This is opinion / commentary about market FEAR of a possible intervention.
It is NOT an actual intervention. The classifier matched the substring
"INTERVENTION" and assigned `category = INTERVENTION`, which:

- Set `highImpact = true` → triggered `highImpactPending` on every USD pair
  (filterByPair correctly let it through because tagged USD)
- Set `breaking = true` (within 30-min freshness window)
- Activated MSID (multi-source intervention regime detection) since 2
  sources reported INTERVENTION on USD/JPY
- Caused USD/JPY's news engine to emit `News -55.7` and "BREAKING+REGIME"
  consensus tag

Same pattern on three other items in the same fixture:

- "Gold's outlook remains neutral-to-bearish... neutral Fed" → POLICY
  (because "Fed")
- "What are the main events for today?" → DATA (because "events" / "CPI"
  appearing in body)
- "investingLive Asia-Pacific FX news wrap: Awaiting the RBA" → POLICY
  (because "RBA")

All four are opinion / preview / wrap content. None is a real event.

---

## Fix (kept tight per 2M's constraints)

**Touched files:** ONLY `src/fetchers/news.ts`. Untouched:
- `src/fetchers/centralBanks.ts` (priority 1)
- `src/engines/newsEngine.ts` (priority 1.8)
- `filterByPair` in `news.ts` (priority 1.5)

**Approach:** Keyword-based override running BEFORE the existing
classifier. No semantic / conditional / probabilistic language detection.
Conservative — designed to miss some opinion pieces rather than wrongly
re-classify real events.

### `OPINION_PREVIEW_KEYWORDS` (40 entries)

Five categories of distinctive markers:

1. **Outlook / forecast prefixes:** `OUTLOOK`, `FORECAST`, `PREVIEW`,
   `PROJECTION`
2. **Wrap / summary articles:** `WRAP:`, `WRAP ` (with space; avoids
   "WRAPPING UP"), `ROUNDUP`, `RECAP`, `DAILY REVIEW`, `DAILY BRIEFING`,
   `MORNING REPORT`, `MARKET WRAP`, `NEWS WRAP`
3. **Speculation phrasing:** `AMID FEAR(S)`, `AMID CONCERNS`,
   `AMID UNCERTAINTY`, `SET TO HIKE/CUT/RAISE`, `EXPECTED TO HIKE/CUT/RAISE`,
   `COULD SEE`, `MAY FACE`
4. **Q&A / meta / preview:** `WHAT ARE THE MAIN`, `WHAT TO WATCH`,
   `WHAT TO EXPECT`, `THINGS TO KNOW`, `WATCHLIST`, `AHEAD OF`,
   `AWAITING THE`
5. **Analyst-view markers:** `ANALYSTS SEE`, `ANALYSTS EXPECT`,
   `STRATEGISTS SEE`, `STRATEGISTS EXPECT`, `TRADERS SEE`, `MARKET SEES`,
   `TREADS WITH CAUTION` (the production fixture trigger)

### `isOpinionOrPreview(text)` — single-pass substring check

```ts
function isOpinionOrPreview(text: string): boolean {
  const u = text.toUpperCase();
  return OPINION_PREVIEW_KEYWORDS.some(k => u.includes(k));
}
```

### `classifyCategory` and `isHighImpactText` — short-circuit on opinion

```ts
function classifyCategory(text: string): NewsItem["category"] {
  if (isOpinionOrPreview(text)) return "GENERAL";   // NEW
  // ... existing cascade unchanged ...
}

function isHighImpactText(text: string, category?: NewsItem["category"]): boolean {
  if (isOpinionOrPreview(text)) return false;       // NEW
  // ... existing logic unchanged ...
}
```

Side effects (deliberate):

- `breaking` flag becomes `false` for opinion items (because it requires
  category to be INTERVENTION/POLICY, which can no longer occur for opinion)
- `velocityScore` reduced (computeVelocityScore uses category multiplier,
  GENERAL gets 0.3 vs POLICY 0.9)
- MSID detection downgraded for opinion items (MSID requires
  `category === "INTERVENTION"`)
- `sentiment` STILL computed (analyst tone IS information; the bear/bull
  word count still runs)

---

## Test results

```
v4-priority1.7-opinion-filter.smoke.ts:
  34 passed, 0 failed                  (smoke — direct classifier tests)

v4-priority1.7-integration-prod.smoke.ts:
  29 passed, 0 failed                  (integration — full chain on 10:53 fixture)

Total priority 1.7: 63 assertions (well above 27 required)

Regression suite (all green):
  v4-priority1-holiday-bug:           29 passed
  v4-priority1b-news-leak:            27 passed
  v4-priority1.8-highimpact-window:   15 passed
  v4-priority1.8-integration-prod:     9 passed
  v37-three-fixes:                    41 passed
  calibration:                        PASSED
  calibration-from-journal:           PASSED

Baseline gate (per 2M):
  EURUSD LONDON max |composite| = 63.8 (matches pre-1.7 baseline; no regression)
```

---

## Integration test — what it asserts about the production scenario

The integration test reconstructs all 9 items the user observed at 10:53
UTC and runs the full chain (filterByPair → analyzeNews) on USD/CHF,
USD/JPY, AUD/USD. Asserted outcomes:

**USD/CHF (the production-vetoed pair):**
- `highImpactPending = false` ← was `true` before 1.7
- `breakingActive = false`
- 6 items pass filterByPair, 5 are GENERAL after 1.7, only Switzerland CPI
  remains DATA (and is past the 60-min window from priority 1.8)

**USD/JPY (the MSID-active pair):**
- `highImpactPending = false`
- `breakingActive = false`
- `interventionRegime.active = false` ← MSID DOWNGRADED, was active before 1.7

**AUD/USD (the legitimate RBA pair):**
- `highImpactPending = false` (RBA event past 60-min window — priority 1.8
  already handled this; 1.7 doesn't change AUD/USD's outcome here because
  the RBA items are real past-tense events, not opinion)

**Real-event regression guards:**
- "BoC delivers rate hike of 25 basis points" → POLICY, highImpact=true
- "BoJ intervention confirmed: yen sold..." → INTERVENTION, highImpact=true
- "US CPI rises 3.2%..." → DATA, highImpact=true
- "Fed Powell holds press conference..." → DATA, highImpact=true

**Opinion override beats real-event keywords:**
- "Outlook: Fed expected to deliver another rate hike" → GENERAL (not POLICY)
- "FOMC preview: what to expect..." → GENERAL (not DATA)
- "BoJ intervention preview" → GENERAL (PREVIEW wins over INTERVENTION)
- "ECB rate cut forecast: analysts see 25bp move" → GENERAL

**Non-opinion edge cases:**
- "Powell wraps up testimony" (verb form, not "WRAP:") → DATA (correct)
- "FX wrap session ends..." (noun form) → GENERAL (correct)

---

## What did NOT change

- `centralBanks.ts` — priority 1 fixes intact
- `filterByPair` — priority 1.5 logic intact
- `newsEngine.ts` — priority 1.8 windowing logic intact
- All other engines — untouched
- VERSION bumped 4.0.0-stage1c → 4.0.0-stage1d

---

## Acceptance criteria (production)

After deploying, observe at the next analysis cycle:

### Mandatory: opinion items downgraded

If the dashboard's news section shows any of:
- "Outlook: ..."
- "Forecast: ..." / "...forecast"
- "...preview" / "...wrap"
- "What are the main events..."
- "...amid fear / amid concerns"
- "Awaiting the ..."
- "Analysts see..."
- "treads with caution"

Their tag should be **GENERAL**, not POLICY/INTERVENTION/DATA. They
should NOT have a [BRK] badge.

### Mandatory: real events untouched

If a real event arrives during observation:
- "Fed cuts rates by 25bps" → POLICY
- "BoJ intervention confirmed" → INTERVENTION
- "US CPI release: 3.2%" → DATA
- "FOMC press conference begins" → DATA

These should still be tagged correctly with [BRK] when fresh.

### Mandatory: USD/CHF, USD/JPY veto cleared

In the next analysis cycle, on USD/CHF and USD/JPY:
- "High-impact event recently released / pending – stand down" should NOT
  appear UNLESS a NEW fresh real event has arrived since deployment

### Mandatory: MSID downgraded

If the dashboard previously showed "BREAKING+REGIME: 4 sources on USD,JPY"
based on "treads with caution" articles, this badge should now disappear
(MSID requires category=INTERVENTION which no longer fires for opinion).

If a REAL multi-source intervention occurs (BoJ confirms intervention,
multiple sources report), MSID should still activate.

### Source health unchanged

`fl_centralbank`, `forexlive`, `gnews` pills remain green. No fetcher
logic changed.

---

## Risk

### A. Opinion filter too aggressive

Some legitimate articles use opinion-like language. Example:
"BoC Macklem: economic outlook supports current rate path" — title
contains "OUTLOOK", filter classifies GENERAL. The classifier loses this
as a POLICY item.

Mitigation: BoC speeches arrive via `centralBanks.ts` not `news.ts`
buildItem. They use a different code path with their own classifier
(post priority 1). Cross-feed analyst commentary remains in news.ts and
gets the conservative filter.

If a real BoC RSS item gets misclassified, the upstream `centralBanks.ts`
RSS fetcher's classifier will catch it (different code path).

### B. Opinion filter too conservative

The filter uses 40 specific keywords. Some opinion patterns are missed:
- "Could rally" / "may strengthen" — not in keyword list
- Long-form analytical articles without distinctive markers
- Foreign-language opinion pieces (filter is English-only)

Mitigation: missed opinion items contribute to sentiment via the
existing sentiment lexicon, but they retain whatever classification the
existing cascade assigns. They will still trigger `highImpactPending` if
they match POLICY/INTERVENTION keywords. This is acceptable conservatism
— the filter's job is to catch the COMMON patterns observed in
production, not all possible opinion articles.

If new patterns emerge, they're added to OPINION_PREVIEW_KEYWORDS in a
follow-up patch.

### C. MSID misses real interventions

Pre-1.7, MSID detected real interventions reliably IF multiple sources
reported them with the word "intervention" in title.

Post-1.7, MSID still works for "BoJ intervention confirmed", "Fed
intervenes in FX market" (no opinion markers). But MSID misses:
"BoJ intervention preview" (PREVIEW catches it) and "amid fear of
intervention" (AMID FEAR catches it).

This is the right trade-off: real BoJ interventions arrive with
unambiguous past-tense language ("intervened", "confirmed", "sold yen
to defend"), not speculative future-tense ("amid fear of"). Real events
don't get filtered.

---

## Deployment

```bash
unzip trading_court_v4.0_stage1d_priority1.7_FINAL.zip -d v4-stage1d
cd v4-stage1d
rm -rf node_modules dist
npm install
npm run build

# Verify all priority smoke + integration tests:
node dist/tests/v4-priority1-holiday-bug.smoke.js          # 29 passed
node dist/tests/v4-priority1b-news-leak.smoke.js           # 27 passed
node dist/tests/v4-priority1.8-highimpact-window.smoke.js  # 15 passed
node dist/tests/v4-priority1.8-integration-prod.smoke.js   # 9 passed
node dist/tests/v4-priority1.7-opinion-filter.smoke.js     # 34 passed
node dist/tests/v4-priority1.7-integration-prod.smoke.js   # 29 passed

# Optional: re-verify baseline
node dist/backtest/baseline-runner.js | grep "EURUSD"
# Should show: max=63.8, mean=25.9 (unchanged from pre-1.7)

pm2 restart trading-court-pro
```

---

## Status of v4.0 plan (2M-approved order)

| # | Priority | Status |
|---|---|---|
| 1 | Holiday bug in centralBanks.ts | shipped, verified production |
| 1.5 | filterByPair currency leak | shipped, verified production |
| 1.8 | highImpactPending sliding window | shipped, awaiting verification |
| **1.7** | **Opinion / preview filter** | **shipped, awaiting verification** |
| 3 | Hurst as confirming + statMath audit-then-fix | next (full statMath review first) |
| 8 | Unified decisionEngine (absorbs priority 4) | after 3 verified |
| 5 | RR flex for RANGE (near-edge) | after 8 verified |
| 9 | A/B testing for 2 weeks | after 5 |
| 10 | Live calibration warmup | last |

---

Tell me what you observe in production. If USD/CHF and USD/JPY clear the
high-impact veto as predicted, next is priority 3 (statMath audit). If
something unexpected happens, we diagnose first.
