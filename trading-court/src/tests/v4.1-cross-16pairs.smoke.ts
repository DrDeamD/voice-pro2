// ============================================================================
// v4.1 Phase 2 — 16-Pairs Registry Smoke Test
//
// Verifies that all 16 instruments are correctly defined, that the cross-pair
// math resolves to a finite USD value for every cross, and that no helper
// rate is missing for any of them.
//
// This complements v4.1-cross-eur-pairs.smoke.ts (which deep-tests EUR pairs).
// Here we focus on COVERAGE — does every new pair plug into the existing
// pipValueCache + lot-sizing pipeline correctly?
// ============================================================================

import { strict as assert } from "node:assert";
import { INSTRUMENTS } from "../config.js";
import { SPREAD_LIMITS } from "../engines/freshness.js";
import {
  recordQuote,
  computeCrossPipUSD,
  _clearCache,
} from "../engines/pipValueCache.js";
import { computeLotSize as srrLot } from "../engines/structuralRR.js";
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
function checkFinite(name: string, actual: unknown) {
  if (typeof actual === "number" && Number.isFinite(actual) && actual > 0) {
    console.log(`PASS ${name} (${(actual as number).toFixed(4)})`);
    pass++;
  } else {
    console.log(`FAIL ${name} — expected positive finite number, got ${JSON.stringify(actual)}`);
    fail++;
  }
}

function mkQuote(symbol: string, mid: number): Quote {
  return {
    symbol, bid: mid * 0.9999, ask: mid * 1.0001, mid, spread: 1,
    source: "test", ts: Date.now(), available: true,
  };
}

// ─── Expected 13 instruments (after GBPJPY/CADJPY/GBPCHF removal) ─────────
const EXPECTED_PAIRS = [
  // 7 majors
  "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "XAUUSD",
  // Phase 1: 2 EUR crosses
  "EURJPY", "EURGBP",
  // Phase 2: 4 verified-working crosses (no NZD)
  "AUDJPY", "EURCHF", "EURAUD", "EURCAD",
];

const PHASE2_CROSSES = ["AUDJPY", "EURCHF", "EURAUD", "EURCAD"];

// ─── A. Registry coverage ──────────────────────────────────────────────────
console.log("\n=== A: All 13 instruments registered ===");
check("Total instrument count", Object.keys(INSTRUMENTS).length, 13);
for (const sym of EXPECTED_PAIRS) {
  check(`${sym} present`, !!INSTRUMENTS[sym], true);
}

// ─── B. Spread limits coverage ─────────────────────────────────────────────
console.log("\n=== B: All 16 pairs have spread limits ===");
for (const sym of EXPECTED_PAIRS) {
  const lim = SPREAD_LIMITS[sym];
  if (!lim) { console.log(`FAIL ${sym} missing spread limit`); fail++; continue; }
  if (!(lim.max > lim.normal && lim.normal > 0)) {
    console.log(`FAIL ${sym} spread limit shape invalid: ${JSON.stringify(lim)}`);
    fail++;
    continue;
  }
  console.log(`PASS ${sym} spread: normal=${lim.normal} max=${lim.max}`);
  pass++;
}

// ─── C. Field shape sanity ─────────────────────────────────────────────────
console.log("\n=== C: Phase 2 crosses have expected metadata shape ===");
for (const sym of PHASE2_CROSSES) {
  const m = INSTRUMENTS[sym];
  if (!m) continue;
  // base + quote must be non-USD (these are all crosses)
  check(`${sym} base != USD`, m.base !== "USD", true);
  check(`${sym} quote != USD`, m.quote !== "USD", true);
  // pip + decimals consistent: JPY pairs → pip=0.01 decimals=3, others 0.0001/5
  if (m.quote === "JPY") {
    check(`${sym} pip=0.01 for JPY quote`, m.pip, 0.01);
    check(`${sym} decimals=3 for JPY quote`, m.decimals, 3);
  } else {
    check(`${sym} pip=0.0001`, m.pip, 0.0001);
    check(`${sym} decimals=5`, m.decimals, 5);
  }
  // keywords includes both currencies
  check(`${sym} keywords contain base`, m.keywords.includes(m.base), true);
  check(`${sym} keywords contain quote`, m.keywords.includes(m.quote), true);
}

// ─── D. Cross pip-USD math — all 7 new pairs resolve with warm helpers ─────
console.log("\n=== D: Cross pip-USD math for Phase 2 pairs ===");
_clearCache();
// Warm cache with realistic mid-prices (as of late 2024 / 2026 ballpark)
recordQuote("USDJPY", mkQuote("USDJPY", 150.0));   // for JPY-quoted
recordQuote("USDCHF", mkQuote("USDCHF", 0.90));    // for CHF-quoted
recordQuote("USDCAD", mkQuote("USDCAD", 1.40));    // for CAD-quoted
recordQuote("AUDUSD", mkQuote("AUDUSD", 0.65));    // for AUD-quoted

for (const sym of PHASE2_CROSSES) {
  const m = INSTRUMENTS[sym];
  if (!m) continue;
  const r = computeCrossPipUSD(m.base, m.quote, m.pip);
  if (!r) {
    console.log(`FAIL ${sym} returned null — helper rate missing or unsupported quote`);
    fail++;
    continue;
  }
  checkFinite(`${sym} pipUsdPerLot (helper=${r.helperPair})`, r.pipUsdPerLot);
}

// ─── E. Lot-size end-to-end on Phase 2 crosses ─────────────────────────────
console.log("\n=== E: structuralRR lot size for Phase 2 crosses ===");
// $10k balance, 1% risk, 20-pip SL — every cross should return a positive lot
const dummyMids: Record<string, number> = {
  AUDJPY: 100.0, EURCHF: 0.95, EURAUD: 1.65, EURCAD: 1.45,
};
for (const sym of PHASE2_CROSSES) {
  const m = INSTRUMENTS[sym];
  if (!m) continue;
  const lot = srrLot(sym, 10_000, 1, 20, mkQuote(sym, dummyMids[sym]!), m.pip);
  checkFinite(`${sym} lot @ 10k/1%/20pip`, lot ?? -1);
}

// ─── F. Cold cache: every cross returns null lot size (no fabrication) ─────
console.log("\n=== F: Cold cache → null lot size (no fabrication) ===");
_clearCache();
for (const sym of PHASE2_CROSSES) {
  const m = INSTRUMENTS[sym];
  if (!m) continue;
  const lot = srrLot(sym, 10_000, 1, 20, mkQuote(sym, dummyMids[sym]!), m.pip);
  if (lot === null) {
    console.log(`PASS ${sym} cold-cache returns null`);
    pass++;
  } else {
    console.log(`FAIL ${sym} cold-cache should return null, got ${lot}`);
    fail++;
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
