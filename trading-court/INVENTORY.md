# INVENTORY — Trading Court v4.6.0-phaseA-judge
# Reverse Review (browser → HTML → JS → API → engine)
# Generated: 2026-05-20

## Layer 1 — User-visible widgets (HTML/JS in server.ts)

### Top bar
| ID | Renderer | Data source | Status |
|----|----------|-------------|--------|
| #source-bar    | renderSources()        | data.dataSourceHealth          | OK |
| #gpr-host      | renderGPR()            | data.gpr                       | OK |
| #strength-host | renderCurrencyStrength | data.currencyStrength          | OK |
| #changes-host  | renderVerdictChanges() | fetch /api/changes             | OK |
| #breaking-host | renderBreakingBanner() | data.breakingNews              | OK |

### Pairs table (left)
| Column | Source field | Status |
|--------|--------------|--------|
| Pair display    | p.display + p.news.breakingActive ⚡ | OK |
| Price BID/ASK   | p.quote.{mid,bid,ask,spread}          | OK |
| Regime          | p.regime.label + p.regime.adx          | OK |
| MTF             | p.mtf.alignment                       | OK |
| Confidence      | p.scores.confidence + .confidenceTier  | OK |
| Session         | p.session.name                        | OK |
| Opportunity     | p.opportunityStatus                   | OK |
| Verdict         | p.verdict                             | OK |

### Detail pane (right, after click)
| Block | Source | Status |
|-------|--------|--------|
| Verdict header (composite, confidence) | p.scores            | OK |
| Score bars (MS, MTF, Mom, VWAP, PA, Reg, Corr, News) | p.scores        | OK |
| Trade plan (entry, SL, TPs, RR, lot)   | p.plan              | OK |
| VWAP card                              | p.vwap              | OK |
| Reference levels (PDH/PDL, Asia, etc)  | p.priceAction.sessionLevels | OK |
| Argument Cards BUY/SELL                | p.argumentCards     | OK [Phase A] |
| Invalidation triggers                  | p.argumentCards.invalidation | OK [Phase A] |
| Confluence breakdown                   | p.confluence        | OK [Phase A] |
| Fibonacci levels                       | p.fibonacci         | OK [Phase A] |
| Pivot Points                           | p.pivotPoints       | OK [Phase A] |
| Opening Range Breakout                 | p.orb               | OK [Phase A] |
| Legacy bull/bear cases                 | p.bullCase/bearCase | OK |
| WAIT shortfalls (missing/nextSteps)    | p.verdictExplanation | OK |
| Volume Profile                         | p.volumeProfile     | OK [v4.5] |
| Pair correlation top-3                 | snapshotCache.pairCorrelation | OK [v4.5] |
| Latest news                            | p.news.items        | OK |
| Risk gate reasons                      | p.risk.reasons      | OK |

### Bottom
| Block | Source | Status |
|-------|--------|--------|
| Calendar (24h)                         | data.calendarEvents | OK |

---

## Layer 2 — API endpoints

| Endpoint | Backing | Used by dashboard? |
|----------|---------|--------------------|
| /healthz                | constant            | (health probes only) |
| /api/snapshot           | getSnapshot()       | YES (main loop) |
| /api/pair/:symbol       | analyzePair()       | NO (external API) |
| /api/calendar           | fetchCalendar       | NO (snapshot embeds events) |
| /api/breaking           | fetchBreakingNews   | NO (snapshot embeds news) |
| /api/strength           | snapshot.currencyStrength | NO (via snapshot) |
| /api/gpr                | snapshot.gpr        | NO (via snapshot) |
| /api/correlation        | snapshot.pairCorrelation | NO (via snapshot) |
| /api/changes            | getChangeLog()      | YES (renderVerdictChanges) |
| /api/speeches           | aggregated per-pair speechReport | **NO — orphan endpoint** |
| /api/sources            | sourceHealth        | NO (snapshot.dataSourceHealth used instead) |
| /api/state              | rapid mode probe    | NO (snapshot is single source of truth) |
| /api/performance        | calibration recorder | NO (admin tool) |

---

## Layer 3 — Engine outputs vs display path

### Snapshot-level fields → consumed by dashboard
| Field | Display path | Status |
|-------|--------------|--------|
| dataSourceHealth      | #source-bar pills          | OK |
| breakingNews          | banner + per-pair items   | OK |
| currencyStrength      | #strength-host bars        | OK |
| gpr                   | #gpr-host                  | OK |
| pairCorrelation       | per-pair top-3 + (no matrix) | PARTIAL |
| verdictChanges        | #changes-host (top 5)      | OK |
| calendarEvents        | calendar table             | OK |

### Per-pair fields (court.ts → finalAnalysis)
| Field | Display path | Status |
|-------|--------------|--------|
| quote, regime, mtf, correlation, news, priceAction, session | table + bars | OK |
| scores (incl. calibration sub-object) | bars                    | OK (calibration provenance NOT shown) |
| plan, risk                            | trade-plan card + risk gate | OK |
| verdict, opportunityStatus            | row + header               | OK |
| bullCase / bearCase                   | legacy cards               | OK |
| summary                               | header text                | OK |
| verdictExplanation                    | WAIT shortfalls            | OK |
| warnings                              | **NOT displayed cleanly**  | GAP |
| indicators (m5..d1)                   | not displayed              | (hidden by design — fair) |
| marketStructure                       | only via score bar         | DETAIL HIDDEN |
| killZone                              | only via warnings          | GAP |
| manipulation                          | only via legacy bullCase   | GAP |
| structuralPlan                        | inlined into plan          | OK |
| divergenceH1, divergenceM15           | only via legacy bullCase   | GAP |
| freshness                             | only via warnings          | GAP |
| vwap                                  | VWAP card                  | OK |
| m5Trigger                             | only via legacy bullCase   | PARTIAL |
| calendarFeedback                      | only via warnings          | GAP |
| eodGate                               | only via warnings          | GAP |
| fibonacci                             | Fib card                   | OK [Phase A] |
| pivotPoints                           | Pivot card                 | OK [Phase A] |
| orb                                   | ORB card                   | OK [Phase A] |
| **preNewsWarning**                    | only via warnings          | **GAP (Phase 2)** |
| **speechReport**                      | none on dashboard          | **GAP (Phase 2)** |
| gpr                                   | top bar                    | OK (snapshot-level) |
| volumeProfile                         | VP card                    | OK [v4.5] |
| **judgeOverride** (after applyV36)    | only via warnings line     | **GAP (Phase A)** |
| confluence                            | Confluence card            | OK [Phase A] |
| argumentCards                         | Argument cards             | OK [Phase A] |

---

## Layer 4 — Source pill labels vs reality (consistency check)

Current KNOWN_SOURCES in config.ts:
- swissquote, kraken, stooq (QUOTE)
- tradingview (CANDLE)
- tv_context (CONTEXT)
- faireconomy (CALENDAR)
- forexlive, forexlive_cb, livesquawk (NEWS)

After v4.3 rebrand:
- "forexlive" key actually carries InvestingLive data (with forexlive.com legacy fallback).
- Dashboard SOURCE_LABEL hard-codes "forexlive" / "fl_centralbank" labels → misleading; should read "investinglive" / "il_centralbank".
- SOURCE_GROUP hash in renderSources still lists legacy `gnews`, `investing_rss` keys that no longer fire — dead branches.

---

## Identified Gaps — Prioritized

### P0 (functional gaps — engine ran, user blind) — ✅ ALL RESOLVED v4.6.1–v4.6.4
1. ✅ **speechReport widget** — added to renderDetail (🎙️ خطابات البنوك المركزية). v4.6.3 fixed
   `isFromCB()` (source carried label not key) + keyword currency attribution; v4.6.4 fixed
   PBOC→CNY ordering vs BOC→CAD collision. Confirmed live on EUR/AUD (6 ECB speeches).
2. ✅ **judgeOverride card** — added (⚖️ قرار القاضي V4) with mode/risk/adjustedConfidence +
   Phase A input flags. Renders when mode≠NO_OVERRIDE; correctly hidden while all pairs WAIT.
3. ✅ **preNewsWarning widget** — added at top of detail (🛑 Pre-News). Data confirmed via curl
   (3 AUD pairs hit BLOCKER · 1min). Renders when level≠NONE.

### P1 (display polish) — ✅ ALL RESOLVED v4.6.5–v4.6.8
4. ✅ **Hawkish/Dovish stance bar** (v4.6.5) — top bar `#cbstance-host`, aggregates
   `speechReport.byCurrency` across all pairs (dedup by title), shows HAWK/DOVE/NEUTRAL
   per currency. Renders only currencies with speechCount>0.
5. ✅ **Pair correlation 13×13 heatmap** (v4.6.6) — full-width section `#heatmap-body`,
   green/red ρ matrix from `pairCorrelation.matrix`, ρ×100 cells with hover tooltip.
6. ✅ **Source pill labels** (v4.6.7) — labels/groups now flow from config.ts
   KNOWN_SOURCES via dataSourceHealth (single source of truth); hardcoded JS maps
   removed. forexlive→investinglive, fl_centralbank→il_centralbank, dead
   gnews/investing_rss dropped.
7. ✅ **Calibration provenance** (v4.6.8) — line under detail-header headline shows
   empirical (bin range · sample size · win-rate) vs heuristic (with reason).

### P2 (engine outputs not surfaced)
8. ✅ **Divergence card** (v4.6.9) — H1 + M15 RSI divergence signals (kind, strength,
   bars apart, note) in detail pane after ORB. Hidden when no signals.
9. ✅ **Manipulation events** (v4.6.10) — primary sweep/Judas signal (kind, strength,
   swept level, note) in detail pane after Divergence. Hidden when kind=NONE.
10. ✅ **KillZone card** (v4.6.11) — session-quality context (zone, 3-star quality,
    weight, veto, reasoning) in detail pane after Manipulation.
11. ✅ **EOD gate notice** (v4.6.12) — shows day-trading gate veto/warning + hours
    to NY close in detail pane after KillZone. Hidden when neither vetoed nor warning.
12. ✅ **Calendar feedback** (v4.6.13) — past economic surprises still moving the
    bias (currency, direction, magnitude, minutes ago, decay%) filtered to pair
    currencies, in detail pane after EOD gate.
13. **Market structure detail** (dealing range, premium %, last BOS/CHoCH age).

### P3 (newsEngine internals — needs verification)
14. **News duplicate suppression** — confirm dedup logic before claiming complete.
15. **Title-vs-description weighting** — confirm.

---

## Methodology Improvements (proposed additions to 7-step plan)

8. **End-state screenshot before "done"** — for every widget added, capture browser screenshot in `_proofs/` and reference it in commit message. No screenshot = NOT done.
9. **INVENTORY.md kept in sync** — every PR that adds/removes a widget or engine field must update INVENTORY.md in the same commit. Reviewer checks INVENTORY first.
10. **Single-source rule for state** — snapshot is the only canonical data path for the UI; new endpoints are only added when truly orphan (admin/debug). Otherwise data joins the snapshot.
11. **Layer-trace test on every new field** — before merging, run a script that asserts each engine field has at least one HTML render path OR is explicitly marked "internal-only" in INVENTORY.
12. **Versioned dashboard sections** — when a section becomes legacy (e.g. legacy bull/bear cases vs argumentCards), tag it `[legacy]` in the HTML so reviewers see what's superseded.
