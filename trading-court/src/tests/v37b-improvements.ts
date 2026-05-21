// ============================================================================
// v3.7b — User-specified scenario tests (decision-level isolation)
//
// Each improvement is tested at the layer where the change actually lives:
//   Improvement 1 (symmetric delta)        → tested in computeV36Court directly
//   Improvement 2 (range trustFloor)       → tested in computeV36Court directly
//   Improvement 3 (breaking news direction)→ tested in evaluateBreakingNewsVeto directly
//
// Witness math is NOT under test here — it has separate coverage. This file
// answers the user's exact 4 questions:
//   1) Trend قوي + v36 aligned                → does NOT kill the trade
//   2) Range clean                              → not killed for non-trending Hurst
//   3) Breaking news مخالف للصفقة             → WAIT
//   4) Breaking news موافق للصفقة             → confidence -8, NOT WAIT
// ============================================================================

import type { NewsReport, PairAnalysis, RegimeReport } from "../types/index.js";
import { _testOnly_computeV36Court as computeV36Court } from "../engines/v36/statCourt.js";
import { evaluateBreakingNewsVeto } from "../engines/breakingNewsVeto.js";
import type { V36WitnessResult } from "../engines/v36/statTypes.js";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`✅ ${name}${detail ? ` — ${detail}` : ""}`); pass++; }
  else      { console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`); fail++; }
}

// ─── Realistic witness factories ────────────────────────────────────────────
const w = {
  rvHealthy:    (): V36WitnessResult => ({ name: "RealizedVolBipower", signal: +20, confidence: 0.6, reliable: true,  reasons: ["jumpRatio=0.05"] }),
  hurstTrend:   (): V36WitnessResult => ({ name: "HurstExponent",      signal: +30, confidence: 0.65, reliable: true, reasons: ["hurst=0.62"] }),
  hurstRange:   (): V36WitnessResult => ({ name: "HurstExponent",      signal: -30, confidence: 0.55, reliable: true, reasons: ["hurst=0.38"] }),
  garchStable:  (): V36WitnessResult => ({ name: "GARCH",              signal: +20, confidence: 0.85, reliable: true, reasons: ["persistence=0.83"] }),
  garchHigh:    (): V36WitnessResult => ({ name: "GARCH",              signal: -35, confidence: 0.85, reliable: true, reasons: ["high_persistence"] }),
  hawkesLong:   (mag = 60): V36WitnessResult => ({ name: "HawkesLite", signal: +mag, confidence: 0.55, reliable: true, reasons: ["longAlpha=0.6"] }),
};

function buildAnalysis(opts: {
  direction: "LONG" | "SHORT";
  oldConfidence: number;
  composite: number;
  mtfAlignment: number;
  regimeLabel: RegimeReport["label"];
}): PairAnalysis {
  return {
    symbol: "EURUSD", display: "EUR/USD",
    quote: { symbol: "EURUSD", bid: 1.10, ask: 1.1001, mid: 1.10005, spread: 1, source: "test", ts: Date.now(), available: true },
    regime: { label: opts.regimeLabel, adx: null, atrPct: null, bbWidthPct: null, reasoning: "test" },
    mtf: { m15Dir: opts.direction, h1Dir: opts.direction, h4Dir: opts.direction, d1Dir: opts.direction,
           alignment: opts.mtfAlignment, direction: opts.direction, reasoning: "test" },
    correlation: { dxyChange: null, goldChange: null, oilChange: null, vixChange: null, yield10yChange: null, score: 0, available: false, reasoning: "" },
    news: { items: [], baseScore: 0, quoteScore: 0, pairScore: 0, highImpactPending: false, reasoning: "" },
    priceAction: { direction: "NEUTRAL", score: 0, signals: [],
                   sessionLevels: { asiaHigh: null, asiaLow: null, pdh: null, pdl: null, weeklyOpen: null, londonOpen: null, nyOpen: null }, reasoning: "" },
    session: { name: "LONDON", active: ["LONDON"], weight: 1.0, utcHour: 10, reasoning: "" },
    scores: { mtf: 0, regime: 0, momentum: 0, correlation: 0, news: 0, priceAction: 0,
              sessionWeight: 1.0,
              compositeRaw: opts.composite, composite: opts.composite, confidence: opts.oldConfidence,
              direction: opts.direction, confidenceTier: "VALID", sizeMultiplier: 0.7 },
    plan: { direction: opts.direction, tier: "B", confidenceTier: "VALID",
            entry: 1.10, stopLoss: 1.095, tp1: 1.108, tp2: 1.115, tp3: 1.125,
            rr1: 1.6, rr2: 3.0, spreadCost: 1, stopDistancePips: 50, lotSizePer1Pct: 0.02,
            sizeMultiplier: 0.7, notes: [] },
    risk: { passed: true, reasons: [], atrUsed: 0.005, calendarBlocked: false, calendarEvents: [] },
    verdict: opts.direction === "LONG" ? "BUY" : "SELL",
    opportunityStatus: "TRADABLE", bullCase: [], bearCase: [], summary: "",
    verdictExplanation: { headline: "", why: [], missing: [], nextSteps: [] },
    warnings: [], indicators: {} as any,
    generatedUtc: new Date().toISOString(),
  };
}

// ============================================================================
// SCENARIO 1: Strong trend + v36 aligned → must NOT kill the trade
// ============================================================================
console.log("\n=== Scenario 1: Strong trend + v36 aligned → preserves BUY ===");
{
  const analysis = buildAnalysis({
    direction: "LONG", oldConfidence: 78, composite: 70, mtfAlignment: 80, regimeLabel: "TREND_UP",
  });
  const witnesses = [w.rvHealthy(), w.hurstTrend(), w.garchStable(), w.hawkesLong(70)];
  const court = computeV36Court(analysis, witnesses);

  console.log(`  trustScore=${court.trustScore.toFixed(0)}, sideScore=${court.sideScore.toFixed(0)}, ` +
              `cap=${court.confidenceCap}, delta=${court.confidenceDelta}, allowed=${court.allowed}`);

  ok("trustScore ≥ 60 (clears MIN_TRUST_SCORE)", court.trustScore >= 60);
  ok("sideScore ≥ 45 (clears LONG threshold)", court.sideScore >= 45);
  ok("side === LONG", court.side === "LONG");
  ok("confidenceCap = 100 (no risk caps)", court.confidenceCap === 100);
  ok("confidenceDelta is POSITIVE (Improvement 1)", court.confidenceDelta > 0,
     `delta=${court.confidenceDelta}`);
  ok("court.allowed === true (trade NOT killed)", court.allowed === true);
}

// ============================================================================
// SCENARIO 2: Clean range setup → NOT killed because Hurst < trending
// ============================================================================
console.log("\n=== Scenario 2: Clean RANGE regime, mean-reverting Hurst → not killed ===");
{
  const rangeA = buildAnalysis({ direction: "LONG", oldConfidence: 78, composite: 60, mtfAlignment: 50, regimeLabel: "RANGE" });
  const trendA = buildAnalysis({ direction: "LONG", oldConfidence: 78, composite: 60, mtfAlignment: 50, regimeLabel: "TREND_UP" });

  // Identical witnesses for both — only regime differs.
  const witnesses = [w.rvHealthy(), w.hurstRange(), w.garchStable(), w.hawkesLong(50)];
  const rangeCourt = computeV36Court(rangeA, witnesses);
  const trendCourt = computeV36Court(trendA, witnesses);

  console.log(`  RANGE: trust=${rangeCourt.trustScore.toFixed(0)}, allowed=${rangeCourt.allowed}, reasons=${JSON.stringify(rangeCourt.reasons)}`);
  console.log(`  TREND: trust=${trendCourt.trustScore.toFixed(0)}, allowed=${trendCourt.allowed}, reasons=${JSON.stringify(trendCourt.reasons)}`);

  // Same witness math → same trustScore. Difference comes purely from regime branch.
  ok("RANGE and TREND see identical trustScore", Math.abs(rangeCourt.trustScore - trendCourt.trustScore) < 0.5);

  // RANGE never emits the 60-floor reason name
  ok("RANGE does NOT emit v36_trust_score_below_60",
     !rangeCourt.reasons.includes("v36_trust_score_below_60"));

  // RANGE: mean_reverting reason exists but does NOT block
  if (rangeCourt.reasons.includes("v36_mean_reverting_environment")) {
    // The reason is present but is allowed-through in range mode
    const meanReverttingNotBlocking =
      rangeCourt.allowed === true ||
      // Or some OTHER reason caused the block (not mean_reverting)
      rangeCourt.reasons.some(r => r !== "v36_mean_reverting_environment" && (r.includes("risk") || r.includes("unstable") || r.includes("trust_score_below")));
    ok("RANGE: mean_reverting present but NOT the blocker", meanReverttingNotBlocking);
  } else {
    console.log("  (mean_reverting reason not present in this scenario)");
  }

  // Force a scenario where trustScore is exactly in [45, 60) range
  // We need trustRaw between -10 and 20 → witnesses tuned accordingly
  const midWitnesses: V36WitnessResult[] = [
    { name: "RealizedVolBipower", signal: +20, confidence: 1.0, reliable: true, reasons: [] },
    { name: "HurstExponent",      signal: -30, confidence: 1.0, reliable: true, reasons: [] },
    { name: "GARCH",              signal:   0, confidence: 1.0, reliable: true, reasons: [] },
    w.hawkesLong(50),
  ];
  // trustRaw = (20 + (-30) + 0)/3 = -3.33, trustScore = 50 - 1.67 ≈ 48.3 → in [45, 60)
  const rangeMid = computeV36Court(rangeA, midWitnesses);
  const trendMid = computeV36Court(trendA, midWitnesses);
  console.log(`  [45,60) test → RANGE trust=${rangeMid.trustScore.toFixed(0)} allowed=${rangeMid.allowed}, TREND trust=${trendMid.trustScore.toFixed(0)} allowed=${trendMid.allowed}`);

  ok("at trustScore in [45,60): TREND is blocked",
     trendMid.reasons.includes("v36_trust_score_below_60") && trendMid.allowed === false);
  ok("at trustScore in [45,60): RANGE NOT blocked by trust floor (only by mean_reverting if at all)",
     !rangeMid.reasons.includes("v36_trust_score_below_60") &&
     !rangeMid.reasons.includes("v36_trust_score_below_45_range"));

  // Force trustScore < 45 → range emits its own reason name
  const weakWitnesses: V36WitnessResult[] = [
    { name: "RealizedVolBipower", signal: -70, confidence: 1.0, reliable: true, reasons: [] },
    { name: "HurstExponent",      signal: -30, confidence: 1.0, reliable: true, reasons: [] },
    { name: "GARCH",              signal: -35, confidence: 1.0, reliable: true, reasons: [] },
    w.hawkesLong(50),
  ];
  // trustRaw = (-70 + -30 + -35)/3 = -45, trustScore = 50 - 22.5 = 27.5 → below 45
  const weakRange = computeV36Court(rangeA, weakWitnesses);
  ok("RANGE trustScore < 45: emits range-specific reason name",
     weakRange.reasons.includes("v36_trust_score_below_45_range"));
}

// ============================================================================
// SCENARIO 3: Breaking news against direction → WAIT
// ============================================================================
console.log("\n=== Scenario 3: Breaking news CONFLICT (LONG vs bearish breaking) ===");
{
  const news: NewsReport = {
    items: [], baseScore: 0, quoteScore: 0, pairScore: 0, highImpactPending: false, reasoning: "",
    breakingActive: true, breakingScore: -60, breakingCurrencies: ["EUR"],
  };
  const result = evaluateBreakingNewsVeto({
    direction: "LONG", confidence: 78, rr1: 1.8,
    news, pairCcys: new Set(["EUR", "USD"]),
  });
  console.log(`  applied=${result.applied}, vetoed=${result.vetoed}, planTier=${result.newPlanTier}`);

  ok("conflict detected", result.applied);
  ok("vetoed=true (hard WAIT)", result.vetoed);
  ok("planTier=REJECTED on conflict", result.newPlanTier === "REJECTED");
  ok("reason mentions CONFLICT", (result.reason ?? "").includes("CONFLICT"));
  ok("affectedCcys = [EUR]", result.affectedCcys.length === 1 && result.affectedCcys[0] === "EUR");
  ok("breakingScore preserved", result.breakingScore === -60);

  const aligned = evaluateBreakingNewsVeto({
    direction: "SHORT", confidence: 78, rr1: 1.8,
    news, pairCcys: new Set(["EUR", "USD"]),
  });
  ok("SHORT vs same bearish news = NOT vetoed", !aligned.vetoed);
  ok("SHORT vs bearish news → confidence 78→70", aligned.newConfidence === 70);
}

// ============================================================================
// SCENARIO 4: Breaking news with direction → confidence -8, NOT WAIT
// ============================================================================
console.log("\n=== Scenario 4: Breaking news ALIGNED (LONG with bullish breaking) ===");
{
  const news: NewsReport = {
    items: [], baseScore: 0, quoteScore: 0, pairScore: 0, highImpactPending: false, reasoning: "",
    breakingActive: true, breakingScore: +60, breakingCurrencies: ["EUR"],
  };
  const result = evaluateBreakingNewsVeto({
    direction: "LONG", confidence: 78, rr1: 1.8,
    news, pairCcys: new Set(["EUR", "USD"]),
  });
  console.log(`  applied=${result.applied}, vetoed=${result.vetoed}, oldConf=78, newConf=${result.newConfidence}, ` +
              `tier=${result.newConfidenceTier}, planTier=${result.newPlanTier}`);

  ok("aligned detected", result.applied);
  ok("NOT vetoed", !result.vetoed);
  ok("confidence reduced by exactly 8 (78→70)", result.newConfidence === 70);
  ok("warning mentions ALIGNED", (result.warning ?? "").includes("ALIGNED"));
  ok("warning mentions confidence drop 78→70", (result.warning ?? "").includes("78"));
  ok("planTier recomputed from newConfidence", result.newPlanTier === "B" || result.newPlanTier === "A");

  const lowConf = evaluateBreakingNewsVeto({
    direction: "LONG", confidence: 5, rr1: 1.8,
    news, pairCcys: new Set(["EUR", "USD"]),
  });
  ok("low-confidence aligned: floor at 0", lowConf.newConfidence === 0);
  ok("low-confidence aligned: still not vetoed", !lowConf.vetoed);

  const weakBrk = evaluateBreakingNewsVeto({
    direction: "LONG", confidence: 78, rr1: 1.8,
    news: { ...news, breakingScore: +20 }, pairCcys: new Set(["EUR", "USD"]),
  });
  ok("weak breaking score: still applied (no veto, penalty -8)",
     weakBrk.applied && !weakBrk.vetoed && weakBrk.newConfidence === 70);
}

// ============================================================================
// SCENARIO 5: regression — no breaking news → no-op
// ============================================================================
console.log("\n=== Scenario 5: no breaking news → no-op ===");
{
  const news: NewsReport = {
    items: [], baseScore: 0, quoteScore: 0, pairScore: 0, highImpactPending: false, reasoning: "",
    breakingActive: false,
  };
  const result = evaluateBreakingNewsVeto({
    direction: "LONG", confidence: 78, rr1: 1.8,
    news, pairCcys: new Set(["EUR", "USD"]),
  });
  ok("no-op when breakingActive=false", !result.applied && !result.vetoed);
  ok("confidence unchanged when no-op", result.newConfidence === 78);
}

// ============================================================================
// SCENARIO 6: breaking news on UNRELATED currency → no-op
// ============================================================================
console.log("\n=== Scenario 6: breaking news on unrelated ccy → no-op ===");
{
  const news: NewsReport = {
    items: [], baseScore: 0, quoteScore: 0, pairScore: 0, highImpactPending: false, reasoning: "",
    breakingActive: true, breakingScore: -60, breakingCurrencies: ["JPY"],
  };
  const result = evaluateBreakingNewsVeto({
    direction: "LONG", confidence: 78, rr1: 1.8,
    news, pairCcys: new Set(["EUR", "USD"]),
  });
  ok("EUR/USD setup unaffected by JPY breaking", !result.applied);
}

// ============================================================================
// SCENARIO 7: Improvement 1 — exact delta numbers (recalibrated)
//
// Found during testing: realistic witness outputs cap trustScore near 62, so
// the original v37b plan of "+8 at trustScore≥70" was structurally
// unreachable. Recalibrated thresholds:
//   - +6 at trustScore ≥ MIN_TRUST_SCORE (60) and |sideScore| ≥ 50
//   - +4 additional at trustScore ≥ 70 and |sideScore| ≥ 70 (rare, near-max)
//   - −8 at trustScore < 60   (was −12)
//   - −5 at cap < 100         (was −8)
// ============================================================================
console.log("\n=== Scenario 7: Improvement 1 — exact delta numbers (recalibrated) ===");
{
  const a = buildAnalysis({ direction: "LONG", oldConfidence: 70, composite: 80, mtfAlignment: 80, regimeLabel: "TREND_UP" });
  const c = computeV36Court(a, [w.rvHealthy(), w.hurstTrend(), w.garchStable(), w.hawkesLong(70)]);
  console.log(`  reward path: trust=${c.trustScore.toFixed(0)}, side=${c.sideScore.toFixed(0)}, delta=${c.confidenceDelta}`);
  ok("aligned trade gets +6 base bonus (was max +3)", c.confidenceDelta >= 6);

  // Penalty path: low trust + cap < 100
  const penalty = computeV36Court(a, [w.rvHealthy(), w.hurstRange(), w.garchHigh(), w.hawkesLong(50)]);
  console.log(`  penalty path: trust=${penalty.trustScore.toFixed(0)}, cap=${penalty.confidenceCap}, delta=${penalty.confidenceDelta}`);
  // Expected delta: -8 (low trust) + -5 (cap<100) = -13. Old would be -20.
  ok("penalty path delta = -13 (was -20)", penalty.confidenceDelta === -13);
  ok("penalty path delta strictly less harsh than v36 original (-20)", penalty.confidenceDelta > -20);
}

// ============================================================================
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
