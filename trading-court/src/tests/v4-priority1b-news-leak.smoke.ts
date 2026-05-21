// ============================================================================
// v4.0-stage1b Priority 1.5 — Smoke Test
//
// Verifies the fix to filterByPair() in fetchers/news.ts.
//
// Before fix: a breaking news item with impactCurrencies=[AUD,NZD] passed
// the filter for ANY pair (EUR/USD, USD/CAD, etc.) because of
// `|| it.breaking` bypass. This made every breaking news event pollute
// every pair's items list.
//
// After fix: an item passes the filter ONLY if its impactCurrencies
// intersects the pair's currencies. Breaking flag is preserved on items
// that legitimately match — it drives downstream scoring as before — but
// it no longer creates false positives in unrelated pairs.
// ============================================================================

import { strict as assert } from "node:assert";
import type { NewsItem } from "../types/index.js";

// Inline copy of the patched filter logic. We test the contract directly
// because filterByPair is not exported. Drift between this test mirror and
// the production function is a known limitation; both must be updated
// together if filterByPair changes.
function filterByPairUnderTest(items: NewsItem[], base: string, quote: string): NewsItem[] {
  const ccys = new Set([base, quote]);
  if (base === "XAU") ccys.add("USD");
  return items.filter(it => it.impactCurrencies.some(c => ccys.has(c)));
}

// ─── Synthetic fixtures ─────────────────────────────────────────────────────
function mkItem(opts: {
  title: string;
  impactCurrencies: string[];
  breaking?: boolean;
  category?: NewsItem["category"];
  highImpact?: boolean;
}): NewsItem {
  return {
    title: opts.title,
    url: "https://example.com/" + opts.title.toLowerCase().replace(/\s+/g, "-"),
    source: "test",
    publishedUtc: new Date().toISOString(),
    freshnessHours: 0.1,
    sentiment: 0,
    impactCurrencies: opts.impactCurrencies,
    highImpact: opts.highImpact ?? true,
    breaking: opts.breaking ?? false,
    category: opts.category ?? "POLICY",
    velocityScore: 5,
  };
}

// The exact production scenario at 06:16 UTC on May 5, 2026.
const RBA_BREAKING = mkItem({
  title: "Heads up: RBA monetary policy decision set for the bottom of the hour",
  impactCurrencies: ["AUD", "NZD"],
  breaking: true,
  category: "POLICY",
  highImpact: true,
});

const FED_NEUTRAL = mkItem({
  title: "Fed Williams speech transcript released",
  impactCurrencies: ["USD"],
  breaking: false,
  category: "POLICY",
});

const ECB_BREAKING = mkItem({
  title: "ECB Lagarde signals rate cut at next meeting",
  impactCurrencies: ["EUR"],
  breaking: true,
  category: "POLICY",
});

const G7_GLOBAL = mkItem({
  title: "G7 finance ministers issue joint statement on currency stability",
  impactCurrencies: ["USD", "EUR", "JPY", "GBP"],
  breaking: true,
  category: "INTERVENTION",
});

const NO_CURRENCY = mkItem({
  title: "World Bank revises 2027 growth forecast",
  impactCurrencies: [],   // edge case: classifier didn't match any currency
  breaking: true,
  category: "GENERAL",
});

const ALL_ITEMS = [RBA_BREAKING, FED_NEUTRAL, ECB_BREAKING, G7_GLOBAL, NO_CURRENCY];

// ─── Test runner ────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  try {
    assert.deepEqual(actual, expected);
    console.log(`✅ ${name}`);
    pass++;
  } catch {
    console.log(`❌ ${name}`);
    console.log(`   expected: ${JSON.stringify(expected)}`);
    console.log(`   actual:   ${JSON.stringify(actual)}`);
    fail++;
  }
}

console.log("\n=== Test Group 1: RBA breaking should NOT leak to non-AUD pairs ===");

{
  const audusd = filterByPairUnderTest(ALL_ITEMS, "AUD", "USD").map(i => i.title);
  check("AUD/USD: receives RBA (relevant)",     audusd.includes(RBA_BREAKING.title), true);
  check("AUD/USD: receives Fed (USD currency)", audusd.includes(FED_NEUTRAL.title), true);
  check("AUD/USD: receives G7 (USD in list)",   audusd.includes(G7_GLOBAL.title), true);
  check("AUD/USD: rejects ECB-only",            audusd.includes(ECB_BREAKING.title), false);
  check("AUD/USD: rejects no-currency item",    audusd.includes(NO_CURRENCY.title), false);
}

{
  const eurusd = filterByPairUnderTest(ALL_ITEMS, "EUR", "USD").map(i => i.title);
  check("EUR/USD: rejects RBA breaking (PROD BUG)", eurusd.includes(RBA_BREAKING.title), false);
  check("EUR/USD: receives ECB",                    eurusd.includes(ECB_BREAKING.title), true);
  check("EUR/USD: receives Fed",                    eurusd.includes(FED_NEUTRAL.title), true);
  check("EUR/USD: receives G7",                     eurusd.includes(G7_GLOBAL.title), true);
  check("EUR/USD: rejects no-currency item",        eurusd.includes(NO_CURRENCY.title), false);
}

{
  const usdcad = filterByPairUnderTest(ALL_ITEMS, "USD", "CAD").map(i => i.title);
  check("USD/CAD: rejects RBA breaking (PROD BUG)", usdcad.includes(RBA_BREAKING.title), false);
  check("USD/CAD: receives Fed",                    usdcad.includes(FED_NEUTRAL.title), true);
  check("USD/CAD: rejects ECB",                     usdcad.includes(ECB_BREAKING.title), false);
}

{
  const usdjpy = filterByPairUnderTest(ALL_ITEMS, "USD", "JPY").map(i => i.title);
  check("USD/JPY: rejects RBA breaking (PROD BUG)", usdjpy.includes(RBA_BREAKING.title), false);
  check("USD/JPY: receives Fed",                    usdjpy.includes(FED_NEUTRAL.title), true);
  check("USD/JPY: receives G7 (JPY in list)",       usdjpy.includes(G7_GLOBAL.title), true);
}

{
  const usdchf = filterByPairUnderTest(ALL_ITEMS, "USD", "CHF").map(i => i.title);
  check("USD/CHF: rejects RBA breaking (PROD BUG)", usdchf.includes(RBA_BREAKING.title), false);
  check("USD/CHF: receives Fed",                    usdchf.includes(FED_NEUTRAL.title), true);
}

{
  const xauusd = filterByPairUnderTest(ALL_ITEMS, "XAU", "USD").map(i => i.title);
  check("XAU/USD: rejects RBA breaking (PROD BUG)", xauusd.includes(RBA_BREAKING.title), false);
  check("XAU/USD: receives Fed (USD)",              xauusd.includes(FED_NEUTRAL.title), true);
  check("XAU/USD: receives G7 (USD in list)",       xauusd.includes(G7_GLOBAL.title), true);
}

console.log("\n=== Test Group 2: Currency-specific breaking still triggers correctly ===");

{
  const audusd = filterByPairUnderTest(ALL_ITEMS, "AUD", "USD");
  const rba = audusd.find(i => i.title === RBA_BREAKING.title);
  check("AUD/USD: RBA item still has breaking=true", rba?.breaking, true);
  check("AUD/USD: RBA item still has highImpact=true", rba?.highImpact, true);
  // The flags are preserved on items that pass — only the PASS criterion changed.
}

console.log("\n=== Test Group 3: Truly global events with multi-currency lists work ===");

{
  // G7 statement has impactCurrencies = [USD, EUR, JPY, GBP]. Should reach
  // every pair containing one of those. Let's verify it does NOT reach pairs
  // where neither base nor quote is in that list.
  const aussiePairs = filterByPairUnderTest(ALL_ITEMS, "AUD", "NZD").map(i => i.title);
  // AUD/NZD → ccys = {AUD, NZD}. G7 list is {USD, EUR, JPY, GBP}. No overlap.
  // We don't trade AUD/NZD but the test confirms the boundary behavior.
  check("AUD/NZD: rejects G7 (no overlap with [USD,EUR,JPY,GBP])",
        aussiePairs.includes(G7_GLOBAL.title), false);
}

console.log("\n=== Test Group 4: Edge cases ===");

{
  const empty = filterByPairUnderTest([], "EUR", "USD");
  check("Empty input: empty output", empty.length, 0);
}

{
  const onlyNoCurrency = filterByPairUnderTest([NO_CURRENCY], "EUR", "USD");
  check("Item with empty impactCurrencies: filtered out", onlyNoCurrency.length, 0);
}

{
  // Verify XAU special-case still works.
  const goldPair = filterByPairUnderTest([FED_NEUTRAL], "XAU", "USD");
  check("XAU/USD: USD-tagged item passes via XAU→USD expansion", goldPair.length, 1);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
