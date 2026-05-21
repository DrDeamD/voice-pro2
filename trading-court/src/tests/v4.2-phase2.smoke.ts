// ============================================================================
// v4.2 Phase 2 — policy + geopolitics smoke test
//
// Deterministic, pure-function tests (no network). Covers:
//   - hawkDoveLexicon scoring
//   - speaker authority weighting
//   - speechAnalysis aggregation
//   - preNewsWarning level classification
// ============================================================================

import { strict as assert } from "node:assert";
import { scoreHawkishness, SPEAKER_WEIGHT } from "../engines/hawkDoveLexicon.js";
import { analyzeSpeeches } from "../engines/speechAnalysis.js";
import { checkPreNewsVolatility } from "../engines/preNewsWarning.js";
import type { CalendarEvent, NewsItem } from "../types/index.js";

let pass = 0, fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  try {
    assert.deepEqual(actual, expected);
    console.log(`PASS ${name}`);
    pass++;
  } catch {
    console.log(`FAIL ${name}\n   expected: ${JSON.stringify(expected)}\n   actual:   ${JSON.stringify(actual)}`);
    fail++;
  }
}
function checkTrue(name: string, cond: any) {
  if (cond) { console.log(`PASS ${name}`); pass++; }
  else      { console.log(`FAIL ${name} — got ${JSON.stringify(cond)}`); fail++; }
}

// ─── A. hawkDoveLexicon ────────────────────────────────────────────────────
console.log("\n=== A: scoreHawkishness ===");
{
  // Strong hawkish text
  const r = scoreHawkishness("Powell: we must raise rates and stay higher for longer");
  checkTrue("Hawkish text: score > 0", r.score > 0);
  checkTrue("Hawkish text: phrasesMatched non-empty", r.phrasesMatched.length > 0);
  check("Hawkish text: speaker = POWELL", r.speaker, "POWELL");
  checkTrue("Hawkish text: speakerWeight = 1.0", r.speakerWeight === 1.0);
  checkTrue("Hawkish text: effectiveImpact > 0", r.effectiveImpact > 0);
}
{
  // Strong dovish text
  const r = scoreHawkishness("Lagarde: ECB ready to cut rates as inflation declining below target");
  checkTrue("Dovish text: score < 0", r.score < 0);
  check("Dovish text: speaker = LAGARDE", r.speaker, "LAGARDE");
  checkTrue("Dovish text: effectiveImpact < 0", r.effectiveImpact < 0);
}
{
  // Neutral text
  const r = scoreHawkishness("RBA leaves policy meeting agenda unchanged");
  check("Neutral text: score = 0", r.score, 0);
}
{
  // Speaker without weighted phrases — speakerWeight present, score 0
  const r = scoreHawkishness("Williams reviewed quarterly indicators");
  check("Plain speaker text: score = 0", r.score, 0);
  check("Plain speaker text: speaker = WILLIAMS", r.speaker, "WILLIAMS");
}
{
  // Cap test — many hawkish phrases shouldn't blow past +5
  const r = scoreHawkishness(
    "Powell: must raise rates, decisive action needed, stay higher for longer, " +
    "additional firming, further rate increases, inflation is too high, " +
    "balance sheet runoff, more work to do"
  );
  checkTrue("Hawkish cap: score <= 5", r.score <= 5);
  checkTrue("Hawkish cap: score >= 4 (still strong)", r.score >= 4);
}
{
  // Speaker weight check
  checkTrue("SPEAKER_WEIGHT: Powell = 1.0", SPEAKER_WEIGHT["POWELL"] === 1.0);
  checkTrue("SPEAKER_WEIGHT: Bowman < Powell", (SPEAKER_WEIGHT["BOWMAN"] ?? 0) < (SPEAKER_WEIGHT["POWELL"] ?? 1));
}

// ─── B. speechAnalysis ─────────────────────────────────────────────────────
console.log("\n=== B: analyzeSpeeches ===");
{
  const items: NewsItem[] = [
    {
      title: "Powell: must raise rates and stay higher for longer",
      url: "https://federalreserve.gov/example1",
      source: "CB:fed",
      publishedUtc: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      freshnessHours: 0.5,
      sentiment: 0,
      impactCurrencies: ["USD"],
      highImpact: true,
    } as NewsItem,
    {
      title: "Lagarde: ECB ready to cut as inflation declining",
      url: "https://ecb.europa.eu/example2",
      source: "CB:ecb",
      publishedUtc: new Date(Date.now() - 2 * 3600_000).toISOString(),
      freshnessHours: 2,
      sentiment: 0,
      impactCurrencies: ["EUR"],
      highImpact: true,
    } as NewsItem,
    {
      title: "Generic market commentary",
      url: "https://example.com/3",
      source: "ForexLive",
      publishedUtc: new Date().toISOString(),
      freshnessHours: 0.1,
      sentiment: 0,
      impactCurrencies: [],
      highImpact: false,
    } as NewsItem,
  ];
  const r = analyzeSpeeches(items);
  check("speechAnalysis: recent count = 2 (skipped non-CB)", r.recent.length, 2);
  checkTrue("USD stance > 0 (hawkish)", (r.byCurrency["USD"]?.stanceScore ?? 0) > 0);
  checkTrue("EUR stance < 0 (dovish)", (r.byCurrency["EUR"]?.stanceScore ?? 0) < 0);
  checkTrue("Highest-impact speech is Powell or Lagarde",
    r.recent[0]?.hawkDove.speaker === "POWELL" || r.recent[0]?.hawkDove.speaker === "LAGARDE");
  checkTrue("highImpactRecent = true (Powell within 1h)", r.highImpactRecent === true);
}
{
  const r = analyzeSpeeches([]);
  check("speechAnalysis empty input → recent = []", r.recent.length, 0);
  check("speechAnalysis empty → highImpactRecent = false", r.highImpactRecent, false);
}

// ─── C. preNewsWarning ─────────────────────────────────────────────────────
console.log("\n=== C: checkPreNewsVolatility ===");
{
  // Imminent (10 min) HIGH USD event → BLOCKER
  const events: CalendarEvent[] = [
    {
      title: "NFP",
      country: "USD",
      dateUtc: new Date(Date.now() + 10 * 60_000).toISOString(),
      impact: "HIGH",
      forecast: "200K", previous: "180K",
      minutesFromNow: 10,
    } as CalendarEvent,
  ];
  const r = checkPreNewsVolatility(events, "EUR", "USD");
  check("Pre-news 10min HIGH USD: BLOCKER", r.level, "BLOCKER");
  check("Pre-news minutesUntil = 10", r.minutesUntil, 10);
  checkTrue("Pre-news event title NFP", r.event?.title === "NFP");
}
{
  // 22 minutes → WARNING
  const events: CalendarEvent[] = [
    {
      title: "CPI",
      country: "USD",
      dateUtc: new Date(Date.now() + 22 * 60_000).toISOString(),
      impact: "HIGH",
      forecast: "3.2%", previous: "3.1%",
      minutesFromNow: 22,
    } as CalendarEvent,
  ];
  const r = checkPreNewsVolatility(events, "EUR", "USD");
  check("Pre-news 22min HIGH USD: WARNING", r.level, "WARNING");
}
{
  // 45 min → INFO
  const events: CalendarEvent[] = [
    {
      title: "GDP",
      country: "EUR",
      dateUtc: new Date(Date.now() + 45 * 60_000).toISOString(),
      impact: "HIGH",
      forecast: "0.3%", previous: "0.2%",
      minutesFromNow: 45,
    } as CalendarEvent,
  ];
  const r = checkPreNewsVolatility(events, "EUR", "USD");
  check("Pre-news 45min HIGH EUR: INFO", r.level, "INFO");
}
{
  // > 60 min → NONE
  const events: CalendarEvent[] = [
    {
      title: "Retail Sales",
      country: "USD",
      dateUtc: new Date(Date.now() + 90 * 60_000).toISOString(),
      impact: "HIGH",
      forecast: "0.4%", previous: "0.3%",
      minutesFromNow: 90,
    } as CalendarEvent,
  ];
  const r = checkPreNewsVolatility(events, "EUR", "USD");
  check("Pre-news 90min HIGH: NONE", r.level, "NONE");
}
{
  // Wrong currency → NONE
  const events: CalendarEvent[] = [
    {
      title: "RBA Statement",
      country: "AUD",
      dateUtc: new Date(Date.now() + 5 * 60_000).toISOString(),
      impact: "HIGH",
      forecast: "", previous: "",
      minutesFromNow: 5,
    } as CalendarEvent,
  ];
  const r = checkPreNewsVolatility(events, "EUR", "USD");
  check("Pre-news AUD event on EURUSD: NONE", r.level, "NONE");
}
{
  // Medium impact within window → NONE (we only block on HIGH)
  const events: CalendarEvent[] = [
    {
      title: "Existing Home Sales",
      country: "USD",
      dateUtc: new Date(Date.now() + 10 * 60_000).toISOString(),
      impact: "MEDIUM",
      forecast: "5M", previous: "4.9M",
      minutesFromNow: 10,
    } as CalendarEvent,
  ];
  const r = checkPreNewsVolatility(events, "EUR", "USD");
  check("Pre-news MEDIUM event: NONE", r.level, "NONE");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
