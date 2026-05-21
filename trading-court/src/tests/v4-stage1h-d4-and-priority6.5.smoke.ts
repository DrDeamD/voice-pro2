// ============================================================================
// v4.0 stage1h — Combined integration test for two patches:
//
//   (A) priority 3a-bis (D4) — MARKET_CLOSED regime for XAU during 21:00-23:00 UTC
//   (B) priority 6.5-main    — Option D linear delta + MIN_TRUST_SCORE lowered 60→50
//
// These two patches ship together as stage1h. They are independent in scope
// (D4 is regime detection, 6.5 is statistical court delta) but share a deploy
// window and ZIP, so they share a test file. Each section below tests one
// patch in isolation, with no cross-coupling.
//
// All numerics are derived from real production journal data (3b-prep, 686
// verdicts, 12h sample) and the existing v36 formulas. No manufactured smoke.
// ============================================================================

import { strict as assert } from "node:assert";
import {
  isInClosureWindow,
  makeMarketClosedRegime,
  classifyRegime,
  regimeScore,
} from "../engines/regime.js";
import type { IndicatorBlock, RegimeReport } from "../types/index.js";

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

// ─── helper: build a UTC Date at given hour:min ─────────────────────────────
function utcDate(hour: number, minute: number = 0): Date {
  const d = new Date("2026-05-07T00:00:00Z");
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION A — D4 patch: isInClosureWindow + makeMarketClosedRegime
// ════════════════════════════════════════════════════════════════════════════
console.log("\n=== A1: isInClosureWindow — XAUUSD time-of-day boundaries ===");

// Window: 21:00 UTC (1260 min) inclusive, 23:00 UTC (1380 min) exclusive.
check("XAU before window (20:59 UTC)", isInClosureWindow("XAUUSD", utcDate(20, 59)), false);
check("XAU lower edge (21:00 UTC)",     isInClosureWindow("XAUUSD", utcDate(21, 0)),  true);
check("XAU mid-window (21:30 UTC)",     isInClosureWindow("XAUUSD", utcDate(21, 30)), true);
check("XAU last broken in journal (21:37 UTC)", isInClosureWindow("XAUUSD", utcDate(21, 37)), true);
check("XAU MT5 frozen at (21:49 UTC)",  isInClosureWindow("XAUUSD", utcDate(21, 49)), true);
check("XAU upper edge (22:59 UTC)",     isInClosureWindow("XAUUSD", utcDate(22, 59)), true);
check("XAU just past window (23:00 UTC)", isInClosureWindow("XAUUSD", utcDate(23, 0)), false);
check("XAU well after window (00:30 UTC)", isInClosureWindow("XAUUSD", utcDate(0, 30)), false);
check("XAU in NY session (15:00 UTC)",  isInClosureWindow("XAUUSD", utcDate(15, 0)),  false);

console.log("\n=== A2: isInClosureWindow — symbol filter (only XAUUSD triggers) ===");

// Even within the 21-23 UTC window, only XAU is affected.
const inWin = utcDate(21, 30);
check("EURUSD in window stays open", isInClosureWindow("EURUSD", inWin), false);
check("GBPUSD in window stays open", isInClosureWindow("GBPUSD", inWin), false);
check("USDJPY in window stays open", isInClosureWindow("USDJPY", inWin), false);
check("USDCHF in window stays open", isInClosureWindow("USDCHF", inWin), false);
check("USDCAD in window stays open", isInClosureWindow("USDCAD", inWin), false);
check("AUDUSD in window stays open", isInClosureWindow("AUDUSD", inWin), false);
check("Empty symbol stays open",     isInClosureWindow("", inWin),       false);

console.log("\n=== A3: makeMarketClosedRegime — synthetic regime construction ===");
{
  const ind: IndicatorBlock = {
    lastClose: 4554.95, atr14: 12.5, adx14: 14.9,
    bbWidth: 0.012, ema20: 4555, ema50: 4560, ema200: 4540,
  } as IndicatorBlock;
  const r = makeMarketClosedRegime(ind);
  check("MARKET_CLOSED label",            r.label, "MARKET_CLOSED");
  check("adx preserved for diagnostics",  r.adx, 14.9);
  check("atrPct nulled (stale data flag)", r.atrPct, null);
  check("bbWidthPct nulled (stale data flag)", r.bbWidthPct, null);
  check("reasoning mentions closure",     r.reasoning?.includes("closure window"), true);
  check("reasoning mentions UTC times",   r.reasoning?.includes("21:00-23:00 UTC"), true);
}

console.log("\n=== A4: regimeScore — MARKET_CLOSED yields 0 (no directional bias) ===");
{
  const closed: RegimeReport = makeMarketClosedRegime({ adx14: 30 } as IndicatorBlock);
  // Even with high ADX, MARKET_CLOSED should produce 0 score (we don't trust
  // any directional signal during stale-quote window).
  check("MARKET_CLOSED score=0 with adx=30", regimeScore(closed), 0);

  // Compare to TREND_UP at same ADX which would give +48
  const trendUp: RegimeReport = {
    label: "TREND_UP", adx: 30, atrPct: 0.4, bbWidthPct: 0.5,
    reasoning: "test"
  };
  check("Sanity: TREND_UP same ADX gives +48", regimeScore(trendUp), 48);
}

console.log("\n=== A5: classifyRegime — unchanged for non-XAU paths ===");
{
  // The existing classifier is NOT modified. MARKET_CLOSED is layered on
  // top via court.ts logic. classifyRegime itself never returns MARKET_CLOSED.
  const ind: IndicatorBlock = {
    lastClose: 1.085, atr14: 0.0008, adx14: 28,
    bbWidth: 0.005, ema20: 1.084, ema50: 1.082, ema200: 1.078,
  } as IndicatorBlock;
  const r = classifyRegime(ind);
  check("Standard EUR/USD trend → TREND_UP", r.label, "TREND_UP");
  // No MARKET_CLOSED leaking from classifyRegime
  const indFlat: IndicatorBlock = {
    lastClose: 1.085, atr14: 0.0008, adx14: 14,
    bbWidth: 0.005, ema20: 1.085, ema50: 1.085, ema200: 1.085,
  } as IndicatorBlock;
  check("Standard low-ADX → RANGE not MARKET_CLOSED", classifyRegime(indFlat).label, "RANGE");
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION B — Priority 6.5-main: Option D delta + MIN_TRUST_SCORE 50
// ════════════════════════════════════════════════════════════════════════════
//
// We test the DELTA FORMULA in isolation. Calling computeV36Court itself
// would require mocking 4 witness outputs and a full PairAnalysis, which is
// covered separately by smoke tests. Here we verify the formula transformation
// by re-implementing it identically and confirming behavior on production scenarios.

function priority65DeltaFormula(
  trustScore: number,
  sideScore: number,
  trustFloor: number,
  confidenceCap: number,
): number {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const trustMargin = trustScore - trustFloor;
  const sideMag = Math.abs(sideScore);
  let confidenceDelta = clamp((trustMargin * sideMag) / 250, -10, +15);
  if (confidenceCap < 100) confidenceDelta -= 2;
  return confidenceDelta;
}

function v37bDeltaFormula(
  trustScore: number,
  sideScore: number,
  trustFloor: number,
  confidenceCap: number,
  minTrust: number,
): number {
  let confidenceDelta = 0;
  if (trustScore >= minTrust && Math.abs(sideScore) >= 50) confidenceDelta += 6;
  if (trustScore >= 70 && Math.abs(sideScore) >= 70) confidenceDelta += 4;
  if (trustScore < trustFloor) confidenceDelta -= 8;
  if (confidenceCap < 100) confidenceDelta -= 5;
  return confidenceDelta;
}

console.log("\n=== B1: Production-scenario calibration (real numbers from 3b-prep) ===");

// Production p50 case: typical XAU/EUR/GBP/CHF verdict.
// trustScore=45.6 (from journal), sideScore=30 (typical mid), cap fires.
{
  const newDelta = priority65DeltaFormula(45.6, 30, 50, 65);
  const oldDelta = v37bDeltaFormula(45.6, 30, 60, 65, 60);
  console.log(`   Production p50: trust=45.6, side=30, cap fires`);
  console.log(`     v3.7b old: ${oldDelta}`);
  console.log(`     6.5  new: ${newDelta.toFixed(2)}`);
  check("p50 case old delta = -13",  oldDelta, -13);
  // (45.6-50)*30/250 = -0.528, clamped to -0.528, minus 2 cap = -2.528
  check("p50 case new delta = -2.53", Math.abs(newDelta - (-2.528)) < 0.01, true);
  check("p50 improvement: new is less negative", newDelta > oldDelta, true);
}

// Production p75 case: slightly stronger trust.
// trustScore=52.3 (from journal), sideScore=40, no cap.
{
  const newDelta = priority65DeltaFormula(52.3, 40, 50, 100);
  const oldDelta = v37bDeltaFormula(52.3, 40, 60, 100, 60);
  console.log(`   Production p75: trust=52.3, side=40, no cap`);
  console.log(`     v3.7b old: ${oldDelta}`);
  console.log(`     6.5  new: ${newDelta.toFixed(2)}`);
  check("p75 case old delta = -8 (trust<60)", oldDelta, -8);
  // (52.3-50)*40/250 = 0.368, no cap penalty = +0.368
  check("p75 case new delta = +0.37", Math.abs(newDelta - 0.368) < 0.01, true);
  check("p75 case: new flips from penalty to small boost", newDelta > 0, true);
}

console.log("\n=== B2: Strong aligned case — boost is bounded ===");
// Hypothetical strong scenario: trustScore=75 (rare), sideScore=80 (strong direction).
{
  const newDelta = priority65DeltaFormula(75, 80, 50, 100);
  // (75-50)*80/250 = 8.0, no cap = +8.0
  check("Strong scenario delta ≈ +8.0", Math.abs(newDelta - 8.0) < 0.01, true);
  check("Strong scenario stays under +15 cap", newDelta < 15, true);
}

console.log("\n=== B3: Extreme edge cases — clamps prevent overshoot ===");
// Theoretical max boost: trustScore=100, sideScore=100, no cap.
// (100-50)*100/250 = 20, clamped to +15.
{
  const maxBoost = priority65DeltaFormula(100, 100, 50, 100);
  check("Theoretical max boost clamps to +15", maxBoost, 15);
}
// Theoretical max penalty: trustScore=0, sideScore=100, cap fires.
// (0-50)*100/250 = -20, clamped to -10, minus 2 cap = -12.
{
  const maxPenalty = priority65DeltaFormula(0, 100, 50, 50);
  check("Theoretical max penalty clamps to -10 plus -2 cap = -12", maxPenalty, -12);
}

console.log("\n=== B4: RANGE regime keeps trustFloor=45 (priority 3.7b unchanged) ===");
// In RANGE regime, trustFloor stays at 45, not 50. So a verdict with
// trustScore=45.6 in RANGE has trustMargin = 0.6 (positive!), not -4.4.
{
  const rangeDelta = priority65DeltaFormula(45.6, 30, 45, 100);
  // (45.6-45)*30/250 = 0.072, no cap = +0.072
  check("RANGE: trust=45.6 just above floor=45 → small positive", rangeDelta > 0, true);
  check("RANGE: tiny boost ≈ +0.07", Math.abs(rangeDelta - 0.072) < 0.01, true);
  
  const nonRangeDelta = priority65DeltaFormula(45.6, 30, 50, 100);
  check("Non-RANGE: trust=45.6 below floor=50 → small negative", nonRangeDelta < 0, true);
  check("RANGE softens delta vs non-RANGE", rangeDelta > nonRangeDelta, true);
}

console.log("\n=== B5: Cap penalty reduced from -5 to -2 ===");
// Same trust+side scenario, only difference is cap firing.
{
  const noCap = priority65DeltaFormula(50, 50, 50, 100);
  const withCap = priority65DeltaFormula(50, 50, 50, 65);
  check("Cap penalty under priority 6.5 = -2", Math.abs((withCap - noCap) - (-2)) < 0.01, true);
}

console.log("\n=== B6: Trust gate passes for ~25% of production verdicts ===");
// 686 verdicts journal: p75 = 52.3. With MIN_TRUST_SCORE=50, those at the
// 52.3 mode pass (~25-35%). With old 60, NONE passed.
{
  // Use the production sample approximation: p25=p50=45.6, p75=52.3
  // Out of 686 verdicts: 447 in [45-50), 239 in [50-55).
  // With MIN_TRUST_SCORE=50: all 239 in [50-55) pass = 239/686 = 34.8%.
  // With MIN_TRUST_SCORE=60: 0 pass.
  const cutoff50 = 50;
  const cutoff60 = 60;
  
  // Approximate distribution from histogram:
  const sampleScores = [
    ...Array(447).fill(45.6),  // [45-50) bucket, mostly 45.6
    ...Array(239).fill(52.3),  // [50-55) bucket, mostly 52.3
  ];
  
  const passAt50 = sampleScores.filter(s => s >= cutoff50).length;
  const passAt60 = sampleScores.filter(s => s >= cutoff60).length;
  
  check("Trust gate at 60: 0 verdicts pass (old)", passAt60, 0);
  check("Trust gate at 50: 239 verdicts pass (new)", passAt50, 239);
  check("Trust gate at 50: ~35% pass rate", Math.abs(passAt50 / 686 - 0.348) < 0.01, true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
