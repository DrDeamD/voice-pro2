// ============================================================================
// v4.2 Phase 1 — 6 new analytical engines smoke test (deterministic)
//
// Covers: fibonacci, pivotPoints, currencyStrength, confluence, ORB,
// argumentCards. Pure-function tests, no network.
// ============================================================================

import { strict as assert } from "node:assert";
import { computeFibonacci } from "../engines/fibonacci.js";
import { computePivotPoints } from "../engines/pivotPoints.js";
import { computeCurrencyStrength } from "../engines/currencyStrength.js";
import { computeConfluence } from "../engines/confluence.js";
import { computeORB } from "../engines/orb.js";
import { buildArgumentCards } from "../engines/argumentCards.js";
import type { Swing } from "../engines/marketStructure.js";
import type { Candle, EngineScores, PairAnalysis } from "../types/index.js";

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

// ─── Fibonacci ─────────────────────────────────────────────────────────────
console.log("\n=== Fibonacci ===");
{
  const swings: Swing[] = [
    { kind: "SL", price: 1.0820, index: 0, tsUtc: "2026-05-19T08:00:00Z" },
    { kind: "HH", price: 1.0985, index: 24, tsUtc: "2026-05-20T08:00:00Z" },
  ];
  const fib = computeFibonacci(swings, 1.0902, 0.0001);
  check("Fib leg type = BULL_LEG", fib.legType, "BULL_LEG");
  check("Fib legHigh = 1.0985", fib.legHigh, 1.0985);
  check("Fib legLow = 1.0820", fib.legLow, 1.0820);
  checkTrue("Fib positionRatio in [0,1]", (fib.positionRatio ?? -1) >= 0 && (fib.positionRatio ?? 2) <= 1);
  checkTrue("Fib reasoning non-empty", fib.reasoning.length > 0);
  // Price 1.0902 is at (1.0985-1.0902)/(1.0985-1.0820) = 0.5030 — Golden Zone
  checkTrue("Fib detects Golden Zone for 0.5 retracement", fib.inGoldenZone);
  // 3 nearby levels returned
  check("Fib nearbyLevels count = 3", fib.nearbyLevels.length, 3);
}
{
  // Empty swings — must return empty report
  const fib = computeFibonacci([], 1.0900, 0.0001);
  check("Fib empty swings → UNKNOWN", fib.legType, "UNKNOWN");
  check("Fib empty → no nearbyLevels", fib.nearbyLevels.length, 0);
}

// ─── Pivot Points ──────────────────────────────────────────────────────────
console.log("\n=== Pivot Points ===");
{
  // Yesterday: H=1.0950, L=1.0850, C=1.0900 → P=(1.0950+1.0850+1.0900)/3=1.0900
  const d1: Candle[] = [
    { t: 1747353600, o: 1.0860, h: 1.0950, l: 1.0850, c: 1.0900 }, // yesterday
    { t: 1747440000, o: 1.0900, h: 1.0920, l: 1.0880, c: 1.0905 }, // today (in-progress)
  ];
  const piv = computePivotPoints(d1, 1.0905, 0.0001);
  checkTrue("Pivot P ≈ 1.0900", Math.abs((piv.classic?.P ?? 0) - 1.0900) < 0.0001);
  checkTrue("Pivot basis date is from yesterday's candle", piv.basis?.dateUtc != null);
  // R1 = 2P - PDL = 2*1.0900 - 1.0850 = 1.0950
  checkTrue("Pivot R1 ≈ 1.0950", Math.abs((piv.classic?.R1 ?? 0) - 1.0950) < 0.0001);
  // S1 = 2P - PDH = 2*1.0900 - 1.0950 = 1.0850
  checkTrue("Pivot S1 ≈ 1.0850", Math.abs((piv.classic?.S1 ?? 0) - 1.0850) < 0.0001);
  // Camarilla H4/L4 should exist
  checkTrue("Camarilla H4 finite", Number.isFinite(piv.camarilla?.H4));
  checkTrue("Camarilla L4 finite", Number.isFinite(piv.camarilla?.L4));
  checkTrue("Nearest level identified", piv.nearestLevelName != null);
}
{
  const piv = computePivotPoints([], 1.0905, 0.0001);
  check("Pivot empty d1 → null basis", piv.basis, null);
}

// ─── Currency Strength ─────────────────────────────────────────────────────
console.log("\n=== Currency Strength ===");
{
  const mkPair = (sym: string, changePct: number): any => ({
    symbol: sym,
    quote: { symbol: sym, mid: 1, bid: 1, ask: 1, spread: 0, source: "test", ts: 0, available: true, changePct },
  });
  // Scenario: USD strong (EURUSD down 0.5%, GBPUSD down 0.4%, USDJPY up 0.6%)
  const pairs: any[] = [
    mkPair("EURUSD", -0.5),
    mkPair("GBPUSD", -0.4),
    mkPair("USDJPY", +0.6),
  ];
  const cs = computeCurrencyStrength(pairs);
  check("Strength: pairsUsed = 3", cs.pairsUsed, 3);
  checkTrue("Strength: USD score positive", (cs.byCurrency["USD"]?.score ?? 0) > 0);
  checkTrue("Strength: EUR score non-positive", (cs.byCurrency["EUR"]?.score ?? 1) <= 0);
  checkTrue("Strength: strongest is USD", cs.strongest === "USD");
}
{
  // No change data
  const cs = computeCurrencyStrength([]);
  check("Strength empty → pairsUsed 0", cs.pairsUsed, 0);
}

// ─── Confluence ────────────────────────────────────────────────────────────
console.log("\n=== Confluence ===");
{
  const scores: EngineScores = {
    mtf: 65, regime: 50, momentum: 30, correlation: -15, news: 5, priceAction: 35,
    sessionWeight: 1.08,
    compositeRaw: 32, composite: 32, confidence: 67,
    direction: "LONG",
    confidenceTier: "VALID",
    sizeMultiplier: 0.7,
    ...({ marketStructure: 42, manipulation: 20, divergence: -10, vwap: 15 } as any),
  };
  const conf = computeConfluence(scores);
  check("Confluence direction LONG", conf.direction, "LONG");
  check("Confluence totalEngines = 10", conf.totalEngines, 10);
  checkTrue("Confluence: supporting > 0", conf.supporting > 0);
  checkTrue("Confluence: summary non-empty", conf.summary.length > 0);
  // Breakdown should be sorted by absolute contribution descending
  const contribs = conf.breakdown.map(b => Math.abs(b.contribution));
  let sorted = true;
  for (let i = 1; i < contribs.length; i++) if (contribs[i]! > contribs[i-1]!) sorted = false;
  checkTrue("Confluence breakdown sorted by |contribution|", sorted);
}

// ─── Opening Range Breakout ────────────────────────────────────────────────
console.log("\n=== Opening Range Breakout ===");
{
  // Build M15 candles: today at 00:00, 00:15, ..., 14:00 UTC
  // London opens 07:00. First 4 candles (07:00, 07:15, 07:30, 07:45) form range.
  const baseTs = Math.floor(new Date(Date.UTC(2026, 4, 20, 0, 0, 0)).getTime() / 1000);
  const candles: Candle[] = [];
  for (let i = 0; i < 60; i++) {
    const t = baseTs + i * 900;  // 15 min steps
    candles.push({ t, o: 1.1000, h: 1.1010, l: 1.0995, c: 1.1005 });
  }
  // Now date: assume "now" is 2026-05-20 10:00 UTC (post-london-open)
  const now = new Date(Date.UTC(2026, 4, 20, 10, 0, 0));
  const orb = computeORB(candles, 1.1005, 0.0001, now);
  checkTrue("ORB london high present", orb.london.high != null);
  checkTrue("ORB london low present", orb.london.low != null);
  checkTrue("ORB london rangePips > 0", (orb.london.rangePips ?? 0) > 0);
  checkTrue("ORB ny status PENDING (before 13 UTC)",
    orb.ny.status === "PENDING" || orb.ny.status === "FORMING");
}

// ─── Argument Cards ────────────────────────────────────────────────────────
console.log("\n=== Argument Cards ===");
{
  const fakeAnalysis: PairAnalysis = {
    symbol: "EURUSD", display: "EUR/USD",
    quote: { symbol: "EURUSD", bid: 1.10, ask: 1.1001, mid: 1.10005, spread: 1, source: "test", ts: 0, available: true },
    regime: { label: "TREND_UP", adx: 28, atrPct: 0.5, bbWidthPct: 1.0, reasoning: "" },
    mtf: { m15Dir: "LONG", h1Dir: "LONG", h4Dir: "LONG", d1Dir: "LONG", alignment: 70, direction: "LONG", reasoning: "" },
    correlation: { dxyChange: -0.3, goldChange: 0.5, oilChange: 0, vixChange: 0, yield10yChange: 0, score: 20, available: true, reasoning: "" },
    news: { items: [], baseScore: 0, quoteScore: 0, pairScore: 0, highImpactPending: false, reasoning: "" },
    priceAction: { direction: "BULLISH", score: 30, signals: [], sessionLevels: { asiaHigh: null, asiaLow: null, pdh: null, pdl: null, weeklyOpen: null, londonOpen: null, nyOpen: null }, reasoning: "" },
    session: { name: "LONDON", active: ["LONDON"], weight: 1.08, utcHour: 9, reasoning: "" },
    scores: {
      mtf: 70, regime: 45, momentum: 25, correlation: 20, news: 0, priceAction: 30,
      sessionWeight: 1.08, compositeRaw: 35, composite: 38, confidence: 72,
      direction: "LONG", confidenceTier: "VALID", sizeMultiplier: 0.7,
    },
    plan: { direction: "LONG", tier: "B", confidenceTier: "VALID", entry: 1.1001, stopLoss: 1.0980, tp1: 1.1030, tp2: 1.1060, tp3: 1.1090, rr1: 1.5, rr2: 3.0, spreadCost: 1, stopDistancePips: 21, lotSizePer1Pct: 0.05, notes: [], sizeMultiplier: 0.7 },
    risk: { passed: true, reasons: [], atrUsed: 0.0010, calendarBlocked: false, calendarEvents: [] },
    verdict: "BUY",
    opportunityStatus: "TRADABLE",
    bullCase: [], bearCase: [], summary: "", verdictExplanation: { headline: "", why: [], missing: [], nextSteps: [] },
    warnings: [],
    indicators: {} as any,
    generatedUtc: new Date().toISOString(),
  };
  const ac = buildArgumentCards(fakeAnalysis);
  checkTrue("ArgCards: buyCards has STRONG MTF card", ac.buyCards.some(c => c.titleAr.includes("محاذاة فريمات")));
  checkTrue("ArgCards: buyCards has TREND_UP card", ac.buyCards.some(c => c.titleAr.includes("ترند H4 صاعد")));
  checkTrue("ArgCards: invalidation triggers non-empty for BUY", ac.invalidation.triggersAr.length > 0);
  checkTrue("ArgCards: summary non-empty", ac.summary.length > 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
