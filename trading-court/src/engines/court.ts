// ============================================================================
// The Court — orchestration layer (v3.9)
// CHANGES from v3.8:
//   - composeScores() now takes the symbol and consults applyCalibration()
//     to set the base confidence from empirical win-rates per |composite|
//     bin. Falls back to the v3.8 heuristic (|composite|) when no
//     calibration data exists or the matched bin has too few samples.
//   - m5Bonus path also re-runs the calibration lookup when composite
//     shifts, so the post-trigger confidence still corresponds to the
//     correct bin's empirical win-rate.
//   - Every verdict carries `scores.calibration` with the audit detail
//     (source, bin, sample size, heuristic reason).
//
// CHANGES from v3.7d (carried in v3.8):
//   - analyzePair body extracted into pure runCourt(input).
//   - runCourt takes pre-loaded data + a `now` clock — no awaits, no
//     fetches, no Date.now(). Backtest replay relies on this.
//
// Carries forward from v3.7c/d:
//   - m5Bonus re-derivation
//   - EOD Day-Trading Gate
//   - Type-safe weight resolver
//   - ICT dealing range fields propagation
// ============================================================================
import { INSTRUMENTS, WEIGHTS, DYNAMIC_WEIGHTS, RULES } from "../config.js";
import type {
  CalendarEvent, CandleSeries, Direction, EngineScores, NewsItem,
  PairAnalysis, Quote, Verdict,
} from "../types/index.js";
import { fetchQuote } from "../fetchers/quote.js";
import { fetchAllTimeframes } from "../fetchers/candles.js";
import { fetchNewsForPair } from "../fetchers/news.js";
import { fetchContext } from "../fetchers/context.js";

import { computeBlock } from "./indicators.js";
import { classifyRegime, regimeScore, isInClosureWindow, makeMarketClosedRegime } from "./regime.js";
import { analyzeMTF, mtfScore } from "./mtf.js";
import { analyzeCorrelation, correlationScore } from "./correlation.js";
import { analyzeNews, newsScore } from "./newsEngine.js";
import { analyzePriceAction, priceActionScore } from "./priceAction.js";
import { classifySession, applySession } from "./session.js";
import { buildPlan, classifyConfidence } from "./tradePlan.js";
import { evaluateRisk } from "./risk.js";
import { momentumScore } from "./momentum.js";

import { analyzeMarketStructure, marketStructureScore } from "./marketStructure.js";
import { classifyKillZone } from "./killZone.js";
import { analyzeManipulation, manipulationScore } from "./manipulation.js";
import { buildStructuralPlan, computeLotSize } from "./structuralRR.js";
import { detectRsiDivergence } from "./divergence.js";
import { assessFreshness } from "./freshness.js";

import { computeVwap, vwapScore } from "./vwap.js";
import { detectM5Trigger, m5TriggerScore } from "./m5trigger.js";
import { computeCalendarFeedback } from "./calendarFeedback.js";

import { applyV36StatisticalCourt } from "./v36/statCourt.js";
import { v36TruthGate } from "./v36/truth.js";
import { buildPreGateWaitAnalysis } from "./v36/preGate.js";
import { evaluateBreakingNewsVeto, applyBreakingVetoResult } from "./breakingNewsVeto.js";

import { evaluateDayTradingGate, applyDayTradingGate } from "./dayTradingGate.js";

// v4.2 Phase 1 — new analytical engines (no veto logic, just attached fields)
import { computeFibonacci } from "./fibonacci.js";
import { computePivotPoints } from "./pivotPoints.js";
import { computeORB } from "./orb.js";
import { computeConfluence } from "./confluence.js";
import { buildArgumentCards } from "./argumentCards.js";
// v4.2 Phase 2 — policy + geopolitical engines
import { checkPreNewsVolatility } from "./preNewsWarning.js";
import { analyzeSpeeches } from "./speechAnalysis.js";
// v4.5 — Phase 3: volume profile
import { computeVolumeProfile } from "./volumeProfile.js";
// v4.2 Phase 3 — volume profile


// v3.9 — empirical confidence calibration
import { applyCalibration } from "../calibration/applyCalibration.js";
import type { CalibrationResult } from "../calibration/types.js";

// ─── Public input contract for runCourt ────────────────────────────────────
export interface CourtInput {
  symbol: string;
  calendarEvents: CalendarEvent[];
  now: Date;
  quote: Quote;
  series: Record<string, CandleSeries>;
  ctx: any; // ContextChanges shape — kept loose to avoid extra import cycles
  newsItems: NewsItem[];
  /** Backtest mode: skip freshness vetoes (historical data is "stale" by definition). */
  backtestMode?: boolean;
  /** v4.2 Phase 2 — GPR report from snapshot level. Attached so argumentCards
   *  can include geopolitical reasoning. */
  gpr?: any;
}

// ─── Strongly-typed weight resolver ────────────────────────────────────────
type WeightMap = Record<string, number>;

function resolveWeights(highImpactActive: boolean, breakingActive: boolean): WeightMap {
  if (breakingActive) return { ...WEIGHTS, ...DYNAMIC_WEIGHTS.breakingNews } as WeightMap;
  if (highImpactActive) return { ...WEIGHTS, ...DYNAMIC_WEIGHTS.highImpactNews } as WeightMap;
  return { ...WEIGHTS } as WeightMap;
}

function w(W: WeightMap, key: string): number {
  const v = W[key];
  return Number.isFinite(v) ? v : 0;
}

function composeScores(
  symbol: string,
  mtfS: number, regimeS: number, momS: number, corrS: number,
  newsS: number, paS: number,
  msS: number, manipS: number, divS: number,
  vwapS: number,
  sessionWeight: number,
  highImpactActive: boolean,
  breakingActive: boolean,
): EngineScores & { calibration?: CalibrationResult } {
  const W = resolveWeights(highImpactActive, breakingActive);

  const base =
    w(W, "marketStructure") * msS +
    w(W, "mtf")             * mtfS +
    w(W, "momentum")        * momS +
    w(W, "vwap")            * vwapS +
    w(W, "priceAction")     * paS +
    w(W, "manipulation")    * manipS +
    w(W, "divergence")      * divS +
    w(W, "regime")          * regimeS +
    w(W, "correlation")     * corrS +
    w(W, "news")            * newsS;

  const compositeRaw = clamp(base, -100, 100);

  // v3.9 — empirical calibration. The heuristic is the v3.8 fallback used
  // when no calibration data exists, when the matched bin has too few
  // samples, or when the symbol has no registry entry. The calibration
  // result is attached to scores for audit trail and dashboard display.
  const heuristicConf = Math.min(100, Math.abs(compositeRaw));
  const cal = applyCalibration(symbol, compositeRaw, heuristicConf);
  const confidenceRaw = cal.confidence;

  const [composite, confidence] = applySession(compositeRaw, confidenceRaw, sessionWeight);

  const [direction, tier, sizeMult] = deriveDecision(composite, confidence);

  return {
    mtf: round(mtfS), regime: round(regimeS), momentum: round(momS),
    correlation: round(corrS), news: round(newsS), priceAction: round(paS),
    ...({ marketStructure: round(msS), manipulation: round(manipS), divergence: round(divS), vwap: round(vwapS) } as any),
    sessionWeight: round3(sessionWeight),
    compositeRaw: round(compositeRaw),
    composite: round(composite),
    confidence: round(confidence),
    direction,
    confidenceTier: tier,
    sizeMultiplier: sizeMult,
    calibration: cal,
  };
}

function deriveDecision(composite: number, confidence: number): [Direction, EngineScores["confidenceTier"], number] {
  let direction: Direction = "FLAT";
  if (composite >= 15) direction = "LONG";
  else if (composite <= -15) direction = "SHORT";
  const [tier, sizeMult] = classifyConfidence(confidence);
  return [direction, tier, sizeMult];
}

function isStrongTrendContext(scores: EngineScores, regime: any, mtf: any, news: any): boolean {
  if (!["TREND_UP", "TREND_DOWN"].includes(regime.label)) return false;
  if (regime.adx == null || regime.adx < RULES.adxTrendAbove + 3) return false;
  if (Math.abs(mtf.alignment) < 50) return false;
  if (scores.direction === "LONG" && regime.label !== "TREND_UP") return false;
  if (scores.direction === "SHORT" && regime.label !== "TREND_DOWN") return false;
  if (news.highImpactPending) return false;
  if (news.breakingActive) return false;
  if (scores.direction === "LONG" && news.pairScore <= -20) return false;
  if (scores.direction === "SHORT" && news.pairScore >= 20) return false;
  return true;
}

function opportunityStatus(verdict: Verdict, confidence: number, reasons: string[]): PairAnalysis["opportunityStatus"] {
  if (verdict === "BUY" || verdict === "SELL") return "TRADABLE";
  const hardMarkers = ["Regime DEAD", "Regime VOLATILE", "Regime UNKNOWN", "Calendar block", "conflict veto", "against", "ATR unavailable", "Breaking news", "Day-trading gate"];
  const hasHard = reasons.some(r => hardMarkers.some(m => r.includes(m)));
  if (hasHard) return "NONE";
  const softCount = reasons.filter(r => /confidence|RR |FLAT/.test(r)).length;
  if (confidence >= 60 && softCount === 1) return "NEAR";
  if (confidence >= 60 && softCount >= 2) return "WATCHLIST";
  if (softCount === 1 && confidence >= 50) return "WATCHLIST";
  return "NONE";
}

function buildCases(scores: EngineScores, regime: any, mtf: any, corr: any, news: any, pa: any, _session: any, vwap: any, m5t: any): [string[], string[]] {
  const bull: string[] = [], bear: string[] = [];
  if (mtf.alignment > 0) bull.push(`MTF alignment ${fmtSigned(mtf.alignment)} (M15 ${mtf.m15Dir}×2, H1 ${mtf.h1Dir}×3, H4 ${mtf.h4Dir}×3, D1 ${mtf.d1Dir}×2)`);
  else if (mtf.alignment < 0) bear.push(`MTF alignment ${fmtSigned(mtf.alignment)} (M15 ${mtf.m15Dir}×2, H1 ${mtf.h1Dir}×3, H4 ${mtf.h4Dir}×3, D1 ${mtf.d1Dir}×2)`);

  if (regime.label === "TREND_UP") bull.push(`H4 regime TREND_UP, ADX ${regime.adx?.toFixed(1)} (score ${(scores as any).regime?.toFixed(0)})`);
  else if (regime.label === "TREND_DOWN") bear.push(`H4 regime TREND_DOWN, ADX ${regime.adx?.toFixed(1)} (score ${(scores as any).regime?.toFixed(0)})`);
  else { bull.push(`Regime = ${regime.label}`); bear.push(`Regime = ${regime.label}`); }

  if (scores.momentum > 20) bull.push(`Momentum ${fmtSigned(scores.momentum)}`);
  else if (scores.momentum < -20) bear.push(`Momentum ${fmtSigned(scores.momentum)}`);

  if (vwap?.positionVsDaily === "ABOVE") bull.push(`VWAP: price above daily VWAP (${vwap.distancePct?.toFixed(3)}%) — institutional buy territory`);
  else if (vwap?.positionVsDaily === "BELOW") bear.push(`VWAP: price below daily VWAP (${vwap.distancePct?.toFixed(3)}%) — institutional sell territory`);

  if (m5t?.signal === "BULL_TRIGGER") bull.push(`M5 Entry Trigger CONFIRMED: ${m5t.reasoning}`);
  else if (m5t?.signal === "BEAR_TRIGGER") bear.push(`M5 Entry Trigger CONFIRMED: ${m5t.reasoning}`);
  else if (m5t?.signal === "BULL_CROSS") bull.push(`M5 EMA Cross UP — waiting for impulse candle`);
  else if (m5t?.signal === "BEAR_CROSS") bear.push(`M5 EMA Cross DOWN — waiting for impulse candle`);

  if (corr.available && corr.score > 15) bull.push(`Cross-market ${fmtSigned(corr.score)}: ${corr.reasoning}`);
  else if (corr.available && corr.score < -15) bear.push(`Cross-market ${fmtSigned(corr.score)}: ${corr.reasoning}`);

  if (news.pairScore > 15) bull.push(`News/Calendar ${fmtSigned(news.pairScore)}: ${news.reasoning}`);
  else if (news.pairScore < -15) bear.push(`News/Calendar ${fmtSigned(news.pairScore)}: ${news.reasoning}`);

  if (news.breakingActive && (news.breakingScore ?? 0) > 15) bull.push(`⚡ BREAKING bias +${news.breakingScore} (${(news.breakingCurrencies ?? []).join(", ")})`);
  else if (news.breakingActive && (news.breakingScore ?? 0) < -15) bear.push(`⚡ BREAKING bias ${news.breakingScore} (${(news.breakingCurrencies ?? []).join(", ")})`);

  if (pa?.bias === "BULL") bull.push(`PA bias BULL: ${pa.reasoning}`);
  else if (pa?.bias === "BEAR") bear.push(`PA bias BEAR: ${pa.reasoning}`);

  return [bull, bear];
}

function buildSummary(meta: any, _quote: any, scores: EngineScores, regime: any, verdict: Verdict, plan: any, _risk: any, session: any, vwap: any): string {
  const parts: string[] = [];
  parts.push(`${meta.display}: ${verdict} (${scores.confidenceTier})`);
  parts.push(`composite ${fmtSigned(scores.composite)}, conf ${scores.confidence.toFixed(0)}`);
  parts.push(`regime ${regime.label}, ADX ${regime.adx?.toFixed(1) ?? "n/a"}`);
  parts.push(`session ${session.label} ×${session.weight.toFixed(2)}`);
  if (vwap?.positionVsDaily) parts.push(`vwap ${vwap.positionVsDaily}`);
  if (plan.rr1 != null) parts.push(`RR ${plan.rr1.toFixed(2)}`);
  return parts.join(" | ");
}

function buildVerdictExplanation(symbol: string, verdict: Verdict, scores: EngineScores, regime: any, mtf: any, plan: any, risk: any, rrFloor: number, oppStatus: PairAnalysis["opportunityStatus"]): PairAnalysis["verdictExplanation"] {
  const meta = INSTRUMENTS[symbol];
  const why: string[] = [];
  const missing: string[] = [];
  const nextSteps: string[] = [];

  if (verdict === "BUY" || verdict === "SELL") {
    const headline = `Court rules ${verdict} on ${meta.display} (${plan.tier})`;
    why.push(`Composite ${fmtSigned(scores.composite)}, confidence ${scores.confidence.toFixed(0)} (${scores.confidenceTier})`);
    why.push(`H4 regime ${regime.label}, ADX ${regime.adx?.toFixed(1) ?? "n/a"}; MTF ${fmtSigned(mtf.alignment)}`);
    why.push(`RR ${plan.rr1?.toFixed(2)} ≥ floor ${rrFloor.toFixed(2)}; grade ${plan.tier}`);
    why.push("Risk gate passed");
    return { headline, why, missing, nextSteps };
  }

  for (const r of risk.reasons || []) {
    const rl = r.toLowerCase();
    if (rl.includes("breaking news")) {
      missing.push(r);
      nextSteps.push("Wait 15-30min for breaking-news squeeze to settle");
    } else if (rl.includes("day-trading gate")) {
      missing.push(r);
      nextSteps.push("Wait for next session — current window cannot accommodate same-day exit");
    } else if (rl.includes("confidence") && rl.includes("<")) {
      missing.push(`Confidence ${scores.confidence.toFixed(0)} below threshold`);
      nextSteps.push("Wait for one more engine to align (MTF, momentum, VWAP, or PA)");
    } else if (rl.startsWith("rr ")) {
      missing.push(`RR ${plan.rr1 ?? "n/a"} below floor ${rrFloor.toFixed(2)}`);
      nextSteps.push("Wait for a better entry (pullback) to raise RR above floor");
    } else if (rl.includes("flat")) {
      missing.push("Direction FLAT – engines not agreeing");
      nextSteps.push("Wait for composite to cross ±15");
    } else if (rl.includes("dead") || rl.includes("unknown")) {
      missing.push(`Regime ${regime.label} – no tradable structure`);
      nextSteps.push(`Wait for ADX > ${RULES.adxTrendAbove} with EMA stack expansion`);
    } else if (rl.includes("volatile")) {
      missing.push("Regime VOLATILE – big range, no trend");
      nextSteps.push("Wait for volatility to compress and H4 directional close");
    } else if (rl.includes("conflict") || rl.includes("news strongly")) {
      missing.push("Setup conflicts with news/calendar sentiment");
      nextSteps.push("Wait for data surprise to fade or flip");
    } else if (rl.includes("calendar block")) {
      missing.push("Economic calendar has HIGH-impact event in window");
      nextSteps.push(`Wait ${RULES.calendarBlockMinutes}min after the event`);
    } else if (rl.includes("against")) {
      missing.push("Direction fights H4 trend regime");
      nextSteps.push("Wait for regime flip or stronger counter-trend confirmation");
    } else if (rl.includes("atr")) {
      missing.push("ATR unavailable – cannot size risk");
      nextSteps.push("Wait for candle data");
    } else {
      missing.push(r);
    }
  }
  const dedup = (a: string[]) => [...new Set(a)];
  const headline =
    oppStatus === "NEAR" ? `Court holds ${meta.display} as WAIT – NEAR OPPORTUNITY (one blocker away)` :
    oppStatus === "WATCHLIST" ? `Court holds ${meta.display} as WAIT – on WATCHLIST` :
    `Court rules WAIT on ${meta.display}`;
  why.push(`Composite ${fmtSigned(scores.composite)}, confidence ${scores.confidence.toFixed(0)} (${scores.confidenceTier}); direction ${scores.direction}`);
  why.push(`Regime ${regime.label}, ADX ${regime.adx?.toFixed(1) ?? "n/a"}; MTF ${fmtSigned(mtf.alignment)}`);
  if (plan.rr1 != null) why.push(`RR ${plan.rr1.toFixed(2)} vs floor ${rrFloor.toFixed(2)}`);
  return { headline, why, missing: dedup(missing), nextSteps: dedup(nextSteps) };
}

// ============================================================================
// runCourt — pure analysis function. No fetches. No Date.now(). Same logic
// as the old analyzePair body, parameterised on `now` and pre-loaded data.
// ============================================================================
export function runCourt(input: CourtInput): PairAnalysis {
  const { symbol, calendarEvents, now, quote, series, ctx, newsItems, backtestMode, gpr } = input;
  const meta = INSTRUMENTS[symbol];
  const warnings: string[] = [];

  const session = classifySession(now);

  if (!quote.available) warnings.push("Quote unavailable");
  for (const tf of ["5m", "15m", "1h", "4h", "1d"]) {
    if (!series[tf]?.available || !series[tf].candles.length) warnings.push(`${tf} candles unavailable`);
  }

  const preGateTruth = v36TruthGate(symbol, quote, series, backtestMode ? now.getTime() : undefined);
  if (!preGateTruth.ok) {
    return buildPreGateWaitAnalysis({
      symbol, meta, quote, session, series, truth: preGateTruth,
    });
  }

  const indM5  = computeBlock(series["5m"]);
  const indM15 = computeBlock(series["15m"]);
  const indH1  = computeBlock(series["1h"]);
  const indH4  = computeBlock(series["4h"]);
  const indD1  = computeBlock(series["1d"]);

  // v4.0 priority 3a-bis (D4) — XAU/USD market closure detection.
  // When XAU is in its known broker-closure window (21:00-23:00 UTC), the
  // spot quote source freezes and indicators are computed on stale data.
  // Tag those verdicts as MARKET_CLOSED instead of UNKNOWN — honest
  // labeling, easier baseline filtering. See regime.ts for full rationale.
  const regime = isInClosureWindow(symbol, now)
    ? makeMarketClosedRegime(indH4)
    : classifyRegime(indH4);
  const mtf = analyzeMTF(indM15, indH1, indH4, indD1);
  const corr = analyzeCorrelation(symbol, ctx);

  const calFeedback = computeCalendarFeedback(calendarEvents);
  const news = analyzeNews(symbol, newsItems, calFeedback.currencyBonus);

  const pa = analyzePriceAction(series["15m"], series["1h"], series["4h"], series["1d"]);

  const marketStructure = analyzeMarketStructure(
    series["4h"]?.candles ?? [],
    quote.available ? quote.mid : (indH4.lastClose ?? 0),
  );
  const killZone = classifyKillZone(now);
  const manipulation = analyzeManipulation(
    series["1h"]?.candles ?? [],
    series["15m"]?.candles ?? [],
    marketStructure.swingsH4,
    now,
  );
  const divergenceH1 = detectRsiDivergence(series["1h"]?.candles ?? [], 14, 5);
  const divergenceM15 = detectRsiDivergence(series["15m"]?.candles ?? [], 14, 4);
  const freshness = assessFreshness(symbol, quote, series["15m"]);

  const currentPrice = quote.available ? quote.mid : (indH4.lastClose ?? 0);
  const vwap = computeVwap(series["5m"]?.candles ?? [], currentPrice);

  // v4.2 Phase 1 — analytical engines (no veto, no scoring contribution; pure
  // information that the judge + arg-cards layer can use). All resolved here
  // so they're available downstream.
  const fibonacci = computeFibonacci(marketStructure.swingsH4, currentPrice, meta.pip);
  const pivotPoints = computePivotPoints(series["1d"]?.candles ?? [], currentPrice, meta.pip);
  const orb = computeORB(series["15m"]?.candles ?? [], currentPrice, meta.pip, now);

  // v4.2 Phase 2 — policy + macro overlays
  const preNewsWarning = checkPreNewsVolatility(calendarEvents, meta.base, meta.quote);
  const speechReport = analyzeSpeeches(newsItems);

  // v4.5 — volume profile (POC/VAH/VAL) for the current UTC day
  const volumeProfile = computeVolumeProfile(series["5m"]?.candles ?? [], currentPrice, meta.pip);

  const mtfDirectionHint: "LONG" | "SHORT" | "FLAT" =
    mtf.direction === "LONG" ? "LONG" : mtf.direction === "SHORT" ? "SHORT" : "FLAT";
  const m5Trigger = detectM5Trigger(series["5m"]?.candles ?? [], mtfDirectionHint);

  const sMtf = mtfScore(mtf);
  const sRegime = regimeScore(regime);
  const sMom = momentumScore(indM15, indH1, indH4);
  const sCorr = correlationScore(corr);
  const sNews = newsScore(news);
  const sPa = priceActionScore(pa);
  const sMs = marketStructureScore(marketStructure);
  const sManip = manipulationScore(manipulation);
  const sDiv = clamp(divergenceH1.score + 0.5 * divergenceM15.score, -100, 100);
  const sVwap = vwapScore(vwap);

  const breakingActive = !!news.breakingActive;
  const highImpactActive = news.highImpactPending ||
    calFeedback.signals.some(s => s.magnitude >= 40 && s.minutesAgo <= 60);

  const effectiveSessionWeight = killZone.vetoed ? session.weight : Math.max(session.weight, killZone.weight);

  const scores = composeScores(
    symbol,
    sMtf, sRegime, sMom, sCorr, sNews, sPa,
    sMs, sManip, sDiv, sVwap,
    effectiveSessionWeight,
    highImpactActive,
    breakingActive,
  );

  const h1h4Aligned =
    (mtf.h1Dir === scores.direction || mtf.h4Dir === scores.direction) &&
    (mtf.h1Dir !== "FLAT" || mtf.h4Dir !== "FLAT");

  const m5Bonus = h1h4Aligned ? m5TriggerScore(m5Trigger) : 0;
  if (m5Bonus !== 0) {
    const newComposite = clamp(scores.composite + m5Bonus, -100, 100);

    // v3.9 — when composite shifts, redo calibration lookup so confidence
    // reflects the new bin's empirical win-rate. If we are on the heuristic
    // path, fall back to the v3.8 logic (add a fraction of |bonus|).
    const heuristicConf = clamp(scores.confidence + Math.abs(m5Bonus) * 0.6, 0, 100);
    const calNew = applyCalibration(symbol, newComposite, heuristicConf);
    const newConfidence = calNew.confidence;

    const [newDir, newTier, newSize] = deriveDecision(newComposite, newConfidence);

    scores.composite = round(newComposite);
    scores.confidence = round(newConfidence);
    scores.direction = newDir;
    scores.confidenceTier = newTier;
    scores.sizeMultiplier = newSize;
    (scores as any).m5Trigger = m5TriggerScore(m5Trigger);
    (scores as any).calibration = calNew;
  }

  const plan = buildPlan(symbol, scores.direction, quote, indM15, indH1, indH4, scores.confidence);

  let structuralPlan: any = null;
  if (scores.direction === "LONG" || scores.direction === "SHORT") {
    structuralPlan = buildStructuralPlan(
      scores.direction,
      quote,
      meta.pip,
      marketStructure.swingsH4,
      marketStructure.orderBlocks,
      marketStructure.liquidityPools,
      indH4.atr14 ?? indH1.atr14,
      marketStructure.premiumDiscount.rangeHigh,
      marketStructure.premiumDiscount.rangeLow,
    );
    if (structuralPlan.valid && structuralPlan.rr1 != null) {
      plan.entry = structuralPlan.entry;
      plan.stopLoss = structuralPlan.stopLoss;
      plan.tp1 = structuralPlan.tp1;
      plan.tp2 = structuralPlan.tp2;
      plan.tp3 = structuralPlan.tp3;
      plan.rr1 = structuralPlan.rr1;
      plan.rr2 = structuralPlan.rr2;
      plan.stopDistancePips = structuralPlan.stopDistancePips;
      plan.notes.push(`Structural RR: SL=${structuralPlan.slAnchor}, TP1=${structuralPlan.tp1Anchor}`);
      if (plan.stopDistancePips) {
        const ls = computeLotSize(symbol, 100, 1, plan.stopDistancePips, quote, meta.pip);
        if (ls != null && ls > 0) plan.lotSizePer1Pct = ls;
      }
    } else if (!structuralPlan.valid) {
      plan.notes.push("Structural plan invalid — using ATR-based geometry");
    }
  }

  const strongTrend = isStrongTrendContext(scores, regime, mtf, news);
  const rrFloor = strongTrend ? RULES.minRRStrongTrend : RULES.minRR;
  const atrRisk = indM15.atr14 ?? indH1.atr14 ?? indH4.atr14;

  const risk = evaluateRisk(meta.base, meta.quote, scores.direction, scores, regime, news, plan, atrRisk, calendarEvents, rrFloor);

  // Breaking news direction-aware veto
  {
    const pairCcys = new Set([meta.base, meta.quote]);
    if (meta.base === "XAU") pairCcys.add("USD");

    const brkResult = evaluateBreakingNewsVeto({
      direction: scores.direction,
      confidence: scores.confidence,
      rr1: plan.rr1,
      news,
      pairCcys,
    });

    if (brkResult.vetoed) {
      risk.passed = false;
      if (brkResult.reason) risk.reasons.push(brkResult.reason);
      const intRegime = (news as any).interventionRegime;
      if (intRegime?.active && intRegime.sourceCount >= RULES.msidMinSources) {
        risk.reasons.push(
          `MSID context: ${intRegime.sourceCount} sources, oldest ${intRegime.oldestHours.toFixed(1)}h`,
        );
      }
    } else if (brkResult.applied) {
      applyBreakingVetoResult(scores, plan, brkResult);
    }

    if (brkResult.warning) warnings.push(brkResult.warning);
  }

  if (killZone.vetoed) {
    risk.passed = false;
    risk.reasons.push(`KillZone veto: ${killZone.vetoReason ?? killZone.reasoning}`);
  }

  // v3.8 — freshness vetoes are skipped in backtest mode (historical data
  // is intentionally "stale" relative to wall clock).
  if (!backtestMode) {
    if (freshness.spreadVeto) {
      risk.passed = false;
      risk.reasons.push(`Spread veto: ${freshness.spread.toFixed(2)}p`);
    }
    if (freshness.staleVeto) {
      risk.passed = false;
      risk.reasons.push("Data staleness veto");
    }
  }

  const eodGate = evaluateDayTradingGate({
    now,
    direction: scores.direction,
    confidenceTier: scores.confidenceTier,
    stopDistancePips: plan.stopDistancePips,
    symbol,
  });
  applyDayTradingGate(eodGate, risk, plan, warnings);

  // v4.2 Phase 2 — Pre-News volatility veto/warning
  if (!backtestMode) {
    if (preNewsWarning.level === "BLOCKER") {
      risk.passed = false;
      risk.reasons.push(`Pre-news BLOCKER: ${preNewsWarning.reasoningEn}`);
    } else if (preNewsWarning.level === "WARNING") {
      warnings.push(`⚠ Pre-news: ${preNewsWarning.reasoningEn}`);
    } else if (preNewsWarning.level === "INFO") {
      warnings.push(`Pre-news INFO: ${preNewsWarning.reasoningEn}`);
    }
  }

  if (strongTrend && plan.rr1 != null && RULES.minRRStrongTrend <= plan.rr1 && plan.rr1 < RULES.minRR) {
    plan.notes.push(`Strong-trend RR flex: floor ${RULES.minRRStrongTrend.toFixed(2)} instead of ${RULES.minRR.toFixed(2)}`);
  }

  let verdict: Verdict;
  if (!risk.passed || scores.direction === "FLAT") {
    verdict = "WAIT";
    if (plan.tier !== "REJECTED") plan.tier = "REJECTED";
  } else {
    verdict = scores.direction === "LONG" ? "BUY" : "SELL";
  }

  const oppStatus = opportunityStatus(verdict, scores.confidence, risk.reasons);
  const [bullCase, bearCase] = buildCases(scores, regime, mtf, corr, news, pa, session, vwap, m5Trigger);

  if (marketStructure.score > 20) bullCase.push(`Market structure ${fmtSigned(marketStructure.score)}: ${marketStructure.reasoning}`);
  else if (marketStructure.score < -20) bearCase.push(`Market structure ${fmtSigned(marketStructure.score)}: ${marketStructure.reasoning}`);
  if (manipulation.score > 30) bullCase.push(`Manipulation ${fmtSigned(manipulation.score)}: ${manipulation.primary.note}`);
  else if (manipulation.score < -30) bearCase.push(`Manipulation ${fmtSigned(manipulation.score)}: ${manipulation.primary.note}`);
  if (divergenceH1.score > 25) bullCase.push(`H1 RSI divergence ${fmtSigned(divergenceH1.score)}: ${divergenceH1.reasoning}`);
  else if (divergenceH1.score < -25) bearCase.push(`H1 RSI divergence ${fmtSigned(divergenceH1.score)}: ${divergenceH1.reasoning}`);
  if (calFeedback.signals.length) {
    const feedbackLine = calFeedback.reasoning;
    if ((scores as any).news > 15) bullCase.push(feedbackLine);
    else if ((scores as any).news < -15) bearCase.push(feedbackLine);
  }

  const summary = buildSummary(meta, quote, scores, regime, verdict, plan, risk, session, vwap);
  const verdictExplanation = buildVerdictExplanation(symbol, verdict, scores, regime, mtf, plan, risk, rrFloor, oppStatus);

  for (const r of freshness.reasons) warnings.push(`Freshness: ${r}`);
  if (killZone.killZone !== "NONE" && !killZone.vetoed) warnings.push(`Kill zone: ${killZone.killZone} (q${killZone.quality}, x${killZone.weight.toFixed(2)})`);
  if (breakingActive) warnings.push(`⚡ BREAKING NEWS ACTIVE — dynamic weights: news ↑ 0.25 (${news.breakingCurrencies?.join(",")})`);
  else if (highImpactActive) warnings.push(`Dynamic weights active: HIGH-impact news mode (news weight ↑)`);
  if (m5Bonus !== 0) warnings.push(`M5 Entry Trigger: ${m5Trigger.signal} (${m5Bonus > 0 ? "+" : ""}${m5Bonus}pts composite, direction re-derived)`);
  if (calFeedback.signals.length) warnings.push(calFeedback.reasoning);

  // v3.9 — confidence provenance audit line.
  const cal = (scores as any).calibration as CalibrationResult | undefined;
  if (cal) {
    if (cal.source === "calibrated" && cal.bin) {
      warnings.push(
        `Confidence: empirical (bin |comp| ${cal.bin.loAbs}-${cal.bin.hiAbs === 200 ? "∞" : cal.bin.hiAbs}, ` +
        `${cal.bin.sampleSize} trades, win-rate ${(cal.bin.winRate * 100).toFixed(1)}%)`,
      );
    } else if (cal.source === "heuristic") {
      const why =
        cal.heuristicReason === "no_calibration" ? "no calibration data" :
        cal.heuristicReason === "low_sample"     ? "matched bin has <20 trades" :
        cal.heuristicReason === "no_match"       ? "composite outside bin schedule" :
        "fallback";
      warnings.push(`Confidence: heuristic (${why})`);
    }
  }

  const analysisBeforeV36 = {
    symbol, display: meta.display,
    quote, regime, mtf, correlation: corr, news, priceAction: pa, session,
    scores, plan, risk,
    verdict, opportunityStatus: oppStatus,
    bullCase, bearCase, summary, verdictExplanation,
    warnings,
    indicators: { m5: indM5, m15: indM15, h1: indH1, h4: indH4, d1: indD1 },
    marketStructure, killZone, manipulation,
    structuralPlan,
    divergenceH1, divergenceM15,
    freshness,
    ...({ vwap, m5Trigger, calendarFeedback: calFeedback, eodGate,
          fibonacci, pivotPoints, orb,
          preNewsWarning, speechReport, gpr,
          volumeProfile,
          } as any),
    generatedUtc: now.toISOString(),
  };

  // v36 statistical court + judge override may rewrite verdict
  const finalAnalysis = applyV36StatisticalCourt(analysisBeforeV36, { symbol, quote, series });

  // v4.2 Phase 1 — confluence + argument cards built from the FINAL analysis
  // so they reflect any v36/judge overrides.
  const confluence = computeConfluence(finalAnalysis.scores, highImpactActive, breakingActive);
  const argumentCards = buildArgumentCards(finalAnalysis);

  return {
    ...finalAnalysis,
    ...({ confluence, argumentCards } as any),
  };
}

// ============================================================================
// analyzePair — async live wrapper. Fetches all data, then delegates to
// runCourt. Same public signature as before, fully backward-compatible.
// ============================================================================
export async function analyzePair(
  symbol: string,
  calendarEvents: CalendarEvent[],
  gpr?: any,
): Promise<PairAnalysis> {
  const [quote, series, ctx, newsItems] = await Promise.all([
    fetchQuote(symbol),
    fetchAllTimeframes(symbol),
    fetchContext(),
    fetchNewsForPair(symbol),
  ]);

  return runCourt({
    symbol,
    calendarEvents,
    now: new Date(),
    quote,
    series,
    ctx,
    newsItems,
    gpr,
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
function round(v: number, d = 1): number { const m = Math.pow(10, d); return Math.round(v * m) / m; }
function round3(v: number): number { return Math.round(v * 1000) / 1000; }
function fmtSigned(v: number): string { return (v >= 0 ? "+" : "") + v.toFixed(1); }
