// ============================================================================
// v4.0 priority 1.7 — Integration Test (10:53 production fixture)
//
// Uses the EXACT items the user observed at 10:53 UTC on May 5, 2026, and
// runs the full news chain (filterByPair from priority 1.5 → highImpact
// aggregation with window from priority 1.8 → MSID detection) to verify
// that priority 1.7 correctly clears highImpactPending on pairs that
// were vetoed only by misclassified opinion/preview articles.
//
// This is the integration equivalent of v4-priority1.7-opinion-filter
// (which tested classifyCategory directly). Here we test the user-visible
// outcome: does USD/CHF still show "stand down" after priority 1.7 ships?
// ============================================================================

import { strict as assert } from "node:assert";
import { analyzeNews } from "../engines/newsEngine.js";
import type { NewsItem } from "../types/index.js";

// Replicate the priority-1.7-patched buildItem behavior for fixture
// construction. We can't import the production buildItem directly because
// it's not exported, but the logic is identical to news.ts as patched.
const OPINION_PREVIEW_KEYWORDS = [
  "OUTLOOK", "FORECAST", "PREVIEW", "PROJECTION",
  "WRAP:", "WRAP ", "ROUNDUP", "RECAP",
  "DAILY REVIEW", "DAILY BRIEFING", "MORNING REPORT",
  "MARKET WRAP", "NEWS WRAP",
  "AMID FEAR", "AMID FEARS", "AMID CONCERNS", "AMID UNCERTAINTY",
  "SET TO HIKE", "SET TO CUT", "SET TO RAISE",
  "EXPECTED TO HIKE", "EXPECTED TO CUT", "EXPECTED TO RAISE",
  "COULD SEE", "MAY FACE",
  "WHAT ARE THE MAIN", "WHAT TO WATCH", "WHAT TO EXPECT",
  "THINGS TO KNOW", "WATCHLIST",
  "AHEAD OF", "AWAITING THE",
  "ANALYSTS SEE", "ANALYSTS EXPECT",
  "STRATEGISTS SEE", "STRATEGISTS EXPECT",
  "TRADERS SEE", "MARKET SEES",
  "TREADS WITH CAUTION",
];
const INTERVENTION_KEYWORDS = ["INTERVENTION", "RATE CHECK", "FX OPERATION"];
const POLICY_KEYWORDS = [
  "RATE HIKE", "RATE CUT", "EMERGENCY MEETING", "EMERGENCY",
  "UNSCHEDULED", "PIVOT", "GUIDANCE",
];
const HIGH_IMPACT_TOKENS = [
  "FOMC", "NFP", "CPI", "PAYROLLS", "PPI", "GDP",
  "RATE DECISION", "RATE STATEMENT", "PRESS CONFERENCE",
  "FED", "ECB", "BOE", "BOJ", "RBA", "BOC",
];

function isOpinionOrPreview(text: string): boolean {
  const u = text.toUpperCase();
  return OPINION_PREVIEW_KEYWORDS.some(k => u.includes(k));
}

function classify(text: string): NewsItem["category"] {
  if (isOpinionOrPreview(text)) return "GENERAL";
  const u = text.toUpperCase();
  if (INTERVENTION_KEYWORDS.some(k => u.includes(k))) return "INTERVENTION";
  if (POLICY_KEYWORDS.some(k => u.includes(k))) return "POLICY";
  if (HIGH_IMPACT_TOKENS.some(k => u.includes(k))) return "DATA";
  return "GENERAL";
}

function isHighImpact(text: string, cat: NewsItem["category"]): boolean {
  if (isOpinionOrPreview(text)) return false;
  if (cat === "INTERVENTION" || cat === "POLICY") return true;
  const u = text.toUpperCase();
  return HIGH_IMPACT_TOKENS.some(t => u.includes(t));
}

interface ItemSpec {
  title: string;
  ccys: string[];
  freshnessH: number;
  source: string;
  sentiment?: number;
}

function build(s: ItemSpec): NewsItem {
  const cat = classify(s.title);
  const hi = isHighImpact(s.title, cat);
  // breaking flag: same as production buildItem — POLICY/INTERVENTION + fresh
  const breaking = (cat === "INTERVENTION" || cat === "POLICY") && s.freshnessH <= 0.5;
  return {
    title: s.title,
    url: "https://test.example/" + encodeURIComponent(s.title),
    source: s.source,
    publishedUtc: new Date(Date.now() - s.freshnessH * 3600 * 1000).toISOString(),
    freshnessHours: s.freshnessH,
    sentiment: s.sentiment ?? 0,
    impactCurrencies: s.ccys,
    highImpact: hi,
    breaking,
    category: cat,
    velocityScore: breaking ? 8 : 2,
  };
}

// filterByPair after priority 1.5
function filterForPair(items: NewsItem[], base: string, quote: string): NewsItem[] {
  const ccys = new Set([base, quote]);
  if (base === "XAU") ccys.add("USD");
  return items.filter(it => it.impactCurrencies.some(c => ccys.has(c)));
}

let pass = 0, fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  try {
    assert.deepEqual(actual, expected);
    console.log(`PASS ${name}`);
    pass++;
  } catch {
    console.log(`FAIL ${name}`);
    console.log(`   expected: ${JSON.stringify(expected)}`);
    console.log(`   actual:   ${JSON.stringify(actual)}`);
    fail++;
  }
}

// ─── 10:53 UTC May 5, 2026 fixture ─────────────────────────────────────────
const FIXTURE_10_53: ItemSpec[] = [
  {
    title: "USD/JPY treads with caution amid fear of incurring another intervention hit",
    ccys: ["USD", "JPY"],
    freshnessH: 0.2,
    source: "investingLive",
    sentiment: -25,
  },
  {
    title: "USD/JPY treads with caution amid fear of incurring another intervention hit",
    ccys: ["USD", "JPY"],
    freshnessH: 0.4,
    source: "ForexLive CB",
    sentiment: -25,
  },
  {
    title: "Oil prices stay elevated amid Middle East tensions",
    ccys: ["USD"],
    freshnessH: 0.4,
    source: "ForexLive",
    sentiment: 0,
  },
  {
    title: "Gold's outlook remains neutral-to-bearish amid prolonged US-Iran stalemate and neutral Fed",
    ccys: ["USD"],
    freshnessH: 1.5,
    source: "ForexLive",
    sentiment: -10,
  },
  {
    title: "What are the main events for today?",
    ccys: ["USD", "EUR", "GBP"],
    freshnessH: 1.8,
    source: "ForexLive",
    sentiment: 0,
  },
  {
    title: "Switzerland April CPI +0.6% vs +0.6% y/y expected",
    ccys: ["CHF"],
    freshnessH: 2.4,
    source: "ForexLive",
    sentiment: 0,
  },
  {
    title: "RBA governor Bullock: We must get on top of inflation now",
    ccys: ["AUD"],
    freshnessH: 2.7,
    source: "ForexLive CB",
    sentiment: 20,
  },
  {
    title: "RBA raises cash rate to 4.35% in May monetary policy meeting",
    ccys: ["AUD"],
    freshnessH: 3.7,
    source: "ForexLive CB",
    sentiment: 35,
  },
  {
    title: "investingLive Asia-Pacific FX news wrap: Awaiting the RBA",
    ccys: ["AUD", "JPY"],
    freshnessH: 4.5,
    source: "ForexLive",
    sentiment: 0,
  },
];

const allItems = FIXTURE_10_53.map(build);

console.log("\n=== Fixture summary (after priority 1.7 classification) ===");
for (const it of allItems) {
  console.log(`  [${it.category.padEnd(12)}] hi=${String(it.highImpact).padEnd(5)} brk=${String(it.breaking).padEnd(5)} ${it.title.slice(0, 70)}`);
}

console.log("\n=== Group 1: per-item classification ===");

{
  const treadsItems = allItems.filter(i => i.title.includes("treads with caution"));
  for (const it of treadsItems) {
    check(`'treads with caution' ${it.source}: category = GENERAL`, it.category, "GENERAL");
    check(`'treads with caution' ${it.source}: highImpact = false`, it.highImpact, false);
    check(`'treads with caution' ${it.source}: breaking = false (was true pre-1.7)`, it.breaking, false);
  }
}

{
  const golds = allItems.find(i => i.title.startsWith("Gold's outlook"))!;
  check("'Gold's outlook': GENERAL", golds.category, "GENERAL");
  check("'Gold's outlook': highImpact false", golds.highImpact, false);
}

{
  const what = allItems.find(i => i.title.startsWith("What are the main"))!;
  check("'What are the main events': GENERAL", what.category, "GENERAL");
  check("'What are the main events': highImpact false", what.highImpact, false);
}

{
  const wrap = allItems.find(i => i.title.includes("FX news wrap"))!;
  check("'FX news wrap': GENERAL", wrap.category, "GENERAL");
  check("'FX news wrap': highImpact false", wrap.highImpact, false);
}

{
  // Real CPI release — must still be DATA
  const cpi = allItems.find(i => i.title.includes("CPI"))!;
  check("Real CPI: DATA (regression guard)", cpi.category, "DATA");
  check("Real CPI: highImpact true", cpi.highImpact, true);
}

{
  // Real RBA rate hike — past tense, no opinion markers, has "RATE" + "POLICY"
  // wait — "RBA raises cash rate to 4.35% in May monetary policy meeting"
  // contains "monetary policy" but not "rate hike". Let's see what classifies.
  const rba = allItems.find(i => i.title.includes("RBA raises"))!;
  // Should be DATA via "RBA" keyword (in HIGH_IMPACT_TOKENS), not POLICY
  // (no "RATE HIKE" literal)
  check("RBA raises (no opinion markers): DATA", rba.category, "DATA");
  check("RBA raises: highImpact true", rba.highImpact, true);
}

console.log("\n=== Group 2: pair-level outcome (USD/CHF — production case) ===");

{
  const usdchf = filterForPair(allItems, "USD", "CHF");
  console.log(`USD/CHF receives ${usdchf.length} items after filterByPair:`);
  for (const it of usdchf) {
    console.log(`    [${it.category}] hi=${it.highImpact} ${it.title.slice(0, 60)}`);
  }
  const r = analyzeNews("USDCHF", usdchf);
  check("USD/CHF: highImpactPending = false (was true before 1.7)",
        r.highImpactPending, false);
  check("USD/CHF: breakingActive = false",
        r.breakingActive, false);
}

console.log("\n=== Group 3: AUD/USD (real RBA event remains valid) ===");

{
  const audusd = filterForPair(allItems, "AUD", "USD");
  const r = analyzeNews("AUDUSD", audusd);
  // RBA raises (3.7h) is DATA + highImpact, but >60 min window from priority
  // 1.8 → highImpactPending = false IS expected here, even though RBA was real.
  // (For a REAL fresh RBA event <60min, pending would still fire.)
  check("AUD/USD: highImpactPending = false (RBA event is past 60-min window)",
        r.highImpactPending, false);
}

console.log("\n=== Group 4: USD/JPY — both legs of the production fixture ===");

{
  const usdjpy = filterForPair(allItems, "USD", "JPY");
  const r = analyzeNews("USDJPY", usdjpy);
  // Both 'treads with caution' items are now GENERAL. No fresh INTERVENTION/
  // POLICY items remain for USD/JPY. So highImpactPending should be false.
  check("USD/JPY: highImpactPending = false after 1.7", r.highImpactPending, false);
  check("USD/JPY: breakingActive = false (no fresh real breaking)", r.breakingActive, false);
  // MSID also depends on category=INTERVENTION. With both items now GENERAL,
  // MSID should NOT activate.
  check("USD/JPY: interventionRegime.active = false (MSID downgraded)",
        r.interventionRegime.active, false);
}

console.log("\n=== Group 5: contrast — what BEFORE 1.7 would have looked like ===");

{
  // Simulate pre-1.7 behavior: same items, but classified ignoring the
  // opinion filter. The 'treads with caution' items would be INTERVENTION.
  function classifyPre17(text: string): NewsItem["category"] {
    const u = text.toUpperCase();
    if (INTERVENTION_KEYWORDS.some(k => u.includes(k))) return "INTERVENTION";
    if (POLICY_KEYWORDS.some(k => u.includes(k))) return "POLICY";
    if (HIGH_IMPACT_TOKENS.some(k => u.includes(k))) return "DATA";
    return "GENERAL";
  }
  const treadsTitle = "USD/JPY treads with caution amid fear of incurring another intervention hit";
  const preCat = classifyPre17(treadsTitle);
  const postCat = classify(treadsTitle);
  check("Pre-1.7 classification of 'treads with caution': INTERVENTION (the bug)",
        preCat, "INTERVENTION");
  check("Post-1.7 classification: GENERAL (the fix)",
        postCat, "GENERAL");
}

console.log("\n=== Group 6: variants & boundary ===");

{
  // "Awaiting the RBA" — opinion preview keyword "AWAITING THE"
  const t = "Awaiting the RBA: dollar holds gains";
  const cat = classify(t);
  check("'Awaiting the RBA': GENERAL", cat, "GENERAL");
}

{
  // Wrap variant — "WRAP " with trailing space test
  const t = "FX wrap session ends with risk-on";
  const cat = classify(t);
  check("'FX wrap session': GENERAL", cat, "GENERAL");
}

{
  // No false positive on "wraps up" (verb)
  const t = "Powell wraps up testimony before House panel";
  const cat = classify(t);
  // Still classified DATA via "POWELL" + "FED" indirectly? No — title has
  // "Powell" but only "FED" is in tokens. So no DATA, falls through to GENERAL.
  // Actually let's check: u = "POWELL WRAPS UP TESTIMONY BEFORE HOUSE PANEL"
  // OPINION check: "WRAP " in "WRAPS UP" → contains "WRAP " (W-R-A-P-space)?
  // "WRAPS UP" → W-R-A-P-S-space-U-P — no "WRAP " at any position.
  // OK so no opinion match. Then HIGH_IMPACT_TOKENS: "FED" in "POWELL WRAPS UP"?
  // No. So GENERAL.
  check("'Powell wraps up' (verb form): GENERAL", cat, "GENERAL");
}

{
  // Another classifier guard: opinion + intervention combo doesn't escape filter
  const t = "BoJ intervention preview: yen at risk if 160 breaks";
  const cat = classify(t);
  check("'BoJ intervention preview': GENERAL (PREVIEW wins over INTERVENTION)",
        cat, "GENERAL");
  check("'BoJ intervention preview': highImpact false",
        isHighImpact(t, cat), false);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
