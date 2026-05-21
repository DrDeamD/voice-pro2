// ============================================================================
// v4.1 Phase 1 — EUR Cross Pairs Smoke Test
//
// Verifies (deterministic, no network):
//   1. INSTRUMENTS registry has EURJPY and EURGBP with correct shape
//   2. SPREAD_LIMITS covers the new pairs
//   3. pipValueCache resolves cross pip-USD via helper rate
//   4. pipValueCache returns null when helper rate is missing (cold start)
//   5. pipValueCache returns null when helper rate is stale (>2 min)
//   6. structuralRR.computeLotSize uses the cache for crosses
//   7. structuralRR.computeLotSize returns null on cold cache (no fabrication)
//   8. tradePlan.computeLotSize honors the same contract
//   9. Standard USD-quoted and USD-based pairs still produce identical
//      lot-size results as before (no regression)
// ============================================================================

import { strict as assert } from "node:assert";
import { INSTRUMENTS } from "../config.js";
import { SPREAD_LIMITS } from "../engines/freshness.js";
import {
  recordQuote,
  getCachedQuote,
  computeCrossPipUSD,
  _clearCache,
} from "../engines/pipValueCache.js";
import { computeLotSize as srrLot } from "../engines/structuralRR.js";
import { computeLotSize as tpLot } from "../engines/tradePlan.js";
import type { Quote } from "../types/index.js";

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
function checkClose(name: string, actual: number, expected: number, tol: number) {
  const diff = Math.abs(actual - expected);
  if (diff <= tol) {
    console.log(`PASS ${name} (got ${actual.toFixed(4)}, expected ~${expected.toFixed(4)}, tol ${tol})`);
    pass++;
  } else {
    console.log(`FAIL ${name} — diff ${diff.toFixed(4)} > tol ${tol}`);
    console.log(`   expected: ~${expected}`);
    console.log(`   actual:   ${actual}`);
    fail++;
  }
}
function checkNull(name: string, actual: unknown) {
  if (actual === null) {
    console.log(`PASS ${name} (null as expected)`);
    pass++;
  } else {
    console.log(`FAIL ${name} — expected null, got ${JSON.stringify(actual)}`);
    fail++;
  }
}

function mkQuote(symbol: string, mid: number): Quote {
  return {
    symbol,
    bid: mid - 0.00005,
    ask: mid + 0.00005,
    mid,
    spread: 1.0,
    source: "test",
    ts: Date.now(),
    available: true,
  };
}

// ============================================================================
// A. Registry & spread-limit coverage
// ============================================================================
console.log("\n=== A1: EURJPY in registry ===");
check("EURJPY is registered", !!INSTRUMENTS.EURJPY, true);
check("EURJPY base/quote", `${INSTRUMENTS.EURJPY.base}/${INSTRUMENTS.EURJPY.quote}`, "EUR/JPY");
check("EURJPY pip = 0.01", INSTRUMENTS.EURJPY.pip, 0.01);
check("EURJPY decimals = 3", INSTRUMENTS.EURJPY.decimals, 3);
check("EURJPY has kraken code", !!INSTRUMENTS.EURJPY.kraken, true);
check("EURJPY has stooq code", INSTRUMENTS.EURJPY.stooq, "eurjpy");

console.log("\n=== A2: EURGBP in registry ===");
check("EURGBP is registered", !!INSTRUMENTS.EURGBP, true);
check("EURGBP base/quote", `${INSTRUMENTS.EURGBP.base}/${INSTRUMENTS.EURGBP.quote}`, "EUR/GBP");
check("EURGBP pip = 0.0001", INSTRUMENTS.EURGBP.pip, 0.0001);
check("EURGBP decimals = 5", INSTRUMENTS.EURGBP.decimals, 5);

console.log("\n=== A3: spread limits ===");
check("EURJPY in SPREAD_LIMITS", !!SPREAD_LIMITS.EURJPY, true);
check("EURGBP in SPREAD_LIMITS", !!SPREAD_LIMITS.EURGBP, true);
check("EURJPY max > normal", (SPREAD_LIMITS.EURJPY?.max ?? 0) > (SPREAD_LIMITS.EURJPY?.normal ?? 0), true);

// ============================================================================
// B. pipValueCache — cold start returns null
// ============================================================================
console.log("\n=== B1: Cold cache returns null for cross ===");
_clearCache();
check("getCachedQuote(USDJPY) cold = null", getCachedQuote("USDJPY"), null);
checkNull("computeCrossPipUSD(EUR, JPY) cold", computeCrossPipUSD("EUR", "JPY", 0.01));

// ============================================================================
// C. pipValueCache — warm helper rates
// ============================================================================
console.log("\n=== C1: Warm cache resolves cross pip-USD correctly ===");
_clearCache();
recordQuote("USDJPY", mkQuote("USDJPY", 150.0));
recordQuote("GBPUSD", mkQuote("GBPUSD", 1.25));
recordQuote("USDCHF", mkQuote("USDCHF", 0.90));
recordQuote("USDCAD", mkQuote("USDCAD", 1.40));

// EUR/JPY: (0.01 × 100k) / 150 = $6.6667 per lot per pip
{
  const r = computeCrossPipUSD("EUR", "JPY", 0.01);
  if (!r) {
    console.log("FAIL EUR/JPY cross resolution — got null");
    fail++;
  } else {
    checkClose("EUR/JPY pipUsdPerLot ≈ 6.67", r.pipUsdPerLot, 1000 / 150, 0.001);
    check("EUR/JPY helperPair = USDJPY", r.helperPair, "USDJPY");
    check("EUR/JPY source = computed_from_usdpair", r.source, "computed_from_usdpair");
  }
}

// EUR/GBP: 0.0001 × 100k × 1.25 = 12.5 per lot per pip
{
  const r = computeCrossPipUSD("EUR", "GBP", 0.0001);
  if (!r) {
    console.log("FAIL EUR/GBP cross resolution — got null");
    fail++;
  } else {
    checkClose("EUR/GBP pipUsdPerLot ≈ 12.5", r.pipUsdPerLot, 10 * 1.25, 0.001);
    check("EUR/GBP helperPair = GBPUSD", r.helperPair, "GBPUSD");
  }
}

// GBP/JPY: (0.01 × 100k) / 150 = 6.67 — same as EURJPY because helper is USDJPY
{
  const r = computeCrossPipUSD("GBP", "JPY", 0.01);
  if (r) checkClose("GBP/JPY pipUsdPerLot ≈ 6.67", r.pipUsdPerLot, 1000 / 150, 0.001);
  else { console.log("FAIL GBP/JPY"); fail++; }
}

// CAD/CHF: (0.0001 × 100k) / 0.90 ≈ 11.11
{
  const r = computeCrossPipUSD("CAD", "CHF", 0.0001);
  if (r) checkClose("CAD/CHF pipUsdPerLot ≈ 11.11", r.pipUsdPerLot, 10 / 0.90, 0.001);
  else { console.log("FAIL CAD/CHF"); fail++; }
}

// ============================================================================
// D. pipValueCache — USD-involved pairs refused (caller should use direct logic)
// ============================================================================
console.log("\n=== D1: USD-involved pairs are refused ===");
checkNull("computeCrossPipUSD(EUR, USD)", computeCrossPipUSD("EUR", "USD", 0.0001));
checkNull("computeCrossPipUSD(USD, JPY)", computeCrossPipUSD("USD", "JPY", 0.01));
checkNull("computeCrossPipUSD(XAU, USD)", computeCrossPipUSD("XAU", "USD", 0.1));

// ============================================================================
// E. Unsupported quote currency
// ============================================================================
console.log("\n=== E1: Unknown quote currency returns null ===");
checkNull("computeCrossPipUSD(EUR, XYZ)", computeCrossPipUSD("EUR", "XYZ", 0.0001));

// ============================================================================
// F. Lot sizing — structuralRR.computeLotSize regressions
// ============================================================================
console.log("\n=== F1: structuralRR lot size — USD-quoted regression ===");
{
  // EUR/USD: $100 balance, 1% risk, 20 pip SL → lot ≈ 0.05
  // because: $1 risk / (20 × $10) = 0.005? No wait, balance=100, riskPct=1 → $1 risk.
  // pip value = $10/lot, 20 pips × $10 = $200 per 1 lot. Lot = $1/$200 = 0.005.
  // Note: original test expectations assume balance=100 USD which is small; we'll use bigger.
  const lot = srrLot("EURUSD", 10_000, 1, 20, mkQuote("EURUSD", 1.10), 0.0001);
  // $100 risk / (20 × $10) = 0.50 lot
  checkClose("EURUSD lot @ 10k bal / 1% / 20pip ≈ 0.50", lot ?? -1, 0.50, 0.001);
}

console.log("\n=== F2: structuralRR lot size — USDJPY (USD-base, JPY-quote) ===");
{
  // USDJPY @ 150: pip value = (0.01 × 100k) / 150 = $6.667/lot
  // $100 risk / (20 pip × $6.667) = $100 / $133.33 = 0.75 lot
  const lot = srrLot("USDJPY", 10_000, 1, 20, mkQuote("USDJPY", 150.0), 0.01);
  checkClose("USDJPY lot @ 10k / 1% / 20pip ≈ 0.75", lot ?? -1, 0.75, 0.005);
}

console.log("\n=== F3: structuralRR lot size — EUR/JPY cross (warm cache) ===");
{
  // EURJPY: pip value = $6.667/lot (same calc as USDJPY)
  // $100 risk / (20 × $6.667) = 0.75 lot
  const lot = srrLot("EURJPY", 10_000, 1, 20, mkQuote("EURJPY", 165.0), 0.01);
  checkClose("EURJPY lot @ 10k / 1% / 20pip ≈ 0.75", lot ?? -1, 0.75, 0.005);
}

console.log("\n=== F4: structuralRR lot size — EUR/GBP cross (warm cache) ===");
{
  // EURGBP: pip value = $12.50/lot
  // $100 risk / (20 × $12.50) = 0.40 lot
  const lot = srrLot("EURGBP", 10_000, 1, 20, mkQuote("EURGBP", 0.85), 0.0001);
  checkClose("EURGBP lot @ 10k / 1% / 20pip ≈ 0.40", lot ?? -1, 0.40, 0.005);
}

console.log("\n=== F5: structuralRR lot size — cross on COLD cache returns null ===");
_clearCache();
{
  const lot = srrLot("EURJPY", 10_000, 1, 20, mkQuote("EURJPY", 165.0), 0.01);
  checkNull("EURJPY lot on cold cache", lot);
}

// ============================================================================
// G. tradePlan.computeLotSize — same contract
// ============================================================================
console.log("\n=== G1: tradePlan lot size — EUR/USD regression ===");
_clearCache();
{
  // tradePlan signature: (symbol, entry, riskDistance, balance, riskPct)
  // EUR/USD entry=1.10, riskDistance=0.0020 (=20pip), balance=100, riskPct=1
  // riskAmount = 100 × 0.01 = $1
  // pipsRisked = 0.0020 / 0.0001 = 20
  // pipValueUsd = $10/lot
  // lot = $1 / (20 × 10) = 0.005
  const lot = tpLot("EURUSD", 1.10, 0.0020, 100, 1);
  if (lot == null) { console.log("FAIL EURUSD tradePlan lot — got null"); fail++; }
  else checkClose("EURUSD tradePlan lot 0.005", lot, 0.005, 0.0005);
}

console.log("\n=== G2: tradePlan lot size — EUR/JPY warm ===");
{
  _clearCache();
  recordQuote("USDJPY", mkQuote("USDJPY", 150.0));
  // EUR/JPY entry=165, riskDistance=0.20 (=20 pip), balance=100, riskPct=1
  // pipValueUsd = 1000/150 = 6.667
  // lot = $1 / (20 × 6.667) = 0.0075
  const lot = tpLot("EURJPY", 165.0, 0.20, 100, 1);
  if (lot == null) { console.log("FAIL EURJPY tradePlan lot — got null"); fail++; }
  else checkClose("EURJPY tradePlan lot 0.0075", lot, 0.0075, 0.0005);
}

console.log("\n=== G3: tradePlan lot size — EUR/JPY COLD ===");
_clearCache();
{
  const lot = tpLot("EURJPY", 165.0, 0.20, 100, 1);
  checkNull("EURJPY tradePlan lot cold", lot);
}

// ============================================================================
// H. Stale rate handling — entry older than MAX_AGE_MS returns null
// ============================================================================
console.log("\n=== H1: Stale helper rate returns null ===");
_clearCache();
{
  // Manually craft a stale entry by recording then sleeping (we can't sleep in
  // a deterministic test, so instead we verify via getCachedQuote at a future
  // timestamp). Simulate by overriding now > recordedTs + MAX_AGE_MS.
  recordQuote("USDJPY", mkQuote("USDJPY", 150.0));
  const futureNow = Date.now() + 130_000;  // > 2 min later
  const cached = getCachedQuote("USDJPY", futureNow);
  checkNull("getCachedQuote at +130s", cached);
  // computeCrossPipUSD with the same future timestamp should fail too
  const r = computeCrossPipUSD("EUR", "JPY", 0.01, futureNow);
  checkNull("computeCrossPipUSD at +130s", r);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
