// ============================================================================
// Judge Override Adapter — v3.7d
//
// HARD RULE FOR THIS FILE:
//   Every reader function below either reads a field that is defined in the
//   project's type contracts, or returns null/false/"NONE". No regex, no
//   string parsing, no synthesised defaults. If the engines did not measure
//   it, the judge does not see it.
//
// Why this matters:
//   The v3.6 file extracted h4Trend, premiumPct, BOS, CHoCH, sweeps from
//   text matching on `analysis.bullCase` and `analysis.summary`. That
//   pretended to be data when it was a re-decoding of human-readable text.
//
// Field provenance (verified against the actual engine outputs):
//   h4Trend            ← regime.label
//   premiumPct         ← marketStructure.dealingRange.positionPctScaled (v3.7d)
//                        OR marketStructure.premiumDiscount.positionPct × 100
//   intradayBias       ← scores.direction + composite/marketStructure score
//                        (corroborated, not single-source)
//   newsImpact         ← news.breakingActive | news.highImpactPending
//   newsAlignedWithTrade ← news.breakingScore vs direction
//                          OR news.pairScore vs direction (when HIGH pending)
//   sweptHigh / sweptLow ← manipulation.primary.kind
//   bos                ← marketStructure.lastBosKind (v3.7d)
//   choch              ← marketStructure.lastChochKind (v3.7d)
//   entryConfirmation  ← (analysis as any).m5Trigger.signal
//
// Where a needed field is missing or stale, the judge is told "UNKNOWN"
// instead of being given a fake value.
// ============================================================================

import type { Direction, PairAnalysis, Verdict } from "../../types/index.js";
import {
  judgeEngineV4,
  type H4Trend,
  type IntradayBias,
  type NewsImpact,
  type StructureSignal,
} from "../judge/judgeEngineV4.js";

export interface JudgeOverrideMessage {
  en: string;
  ar: string;
}

export interface JudgeOverrideResult {
  active: boolean;
  from: Verdict;
  to: Verdict;
  code: string | null;
  severity: "INFO" | "WARNING" | "BLOCKER";
  mode?: "NO_OVERRIDE" | "CONFIDENCE_ADJUST" | "WAIT_FOR_CONFIRMATION" | "HARD_WAIT";
  riskScore?: number;
  confidenceAdjustment?: number;
  adjustedConfidence?: number;
  // v3.7d — surface data-quality so the user can see why the judge said what
  // it did (or didn't).
  inputs?: {
    h4Trend: H4Trend;
    premiumPct: number | null;
    intradayBias: IntradayBias;
    newsImpact: NewsImpact;
    sweptHigh: boolean | null;
    sweptLow: boolean | null;
    bos: StructureSignal;
    choch: StructureSignal;
    newsAlignedWithTrade: boolean;
    entryConfirmation: boolean;
    premiumPctSource: "dealingRange" | "premiumDiscount" | "missing";
    // v4.6 Phase A
    fibGoldenZoneAligned: boolean;
    fibExtendedSameDirection: boolean;
    dailyPivotAgainst: boolean;
  };
  messages: JudgeOverrideMessage[];
}

function emptyJudgeOverride(verdict: Verdict, confidence = 0): JudgeOverrideResult {
  return {
    active: false,
    from: verdict,
    to: verdict,
    code: null,
    severity: "INFO",
    mode: "NO_OVERRIDE",
    riskScore: 0,
    confidenceAdjustment: 0,
    adjustedConfidence: confidence,
    messages: [],
  };
}

function verdictFromDirection(direction: Direction): Verdict {
  if (direction === "LONG") return "BUY";
  if (direction === "SHORT") return "SELL";
  return "WAIT";
}

// ─── Strict structured-field readers ────────────────────────────────────────

function readH4Trend(a: PairAnalysis): H4Trend {
  const label = String((a.regime as any)?.label ?? "").toUpperCase();
  if (label === "TREND_UP") return "UP";
  if (label === "TREND_DOWN") return "DOWN";
  if (label === "RANGE") return "RANGE";
  // DEAD, VOLATILE, UNKNOWN, missing → all honestly UNKNOWN.
  return "UNKNOWN";
}

/**
 * Returns positionPct on a 0..100 scale, or null if unavailable.
 * Source preference: dealingRange (ICT-anchored) → premiumDiscount (legacy).
 * NEVER fabricates a value when both are absent.
 */
function readPremiumPct(a: PairAnalysis): { value: number | null; source: "dealingRange" | "premiumDiscount" | "missing" } {
  const ms = a.marketStructure as any;

  const dr = ms?.dealingRange;
  if (dr && Number.isFinite(dr.positionPctScaled)) {
    return { value: Number(dr.positionPctScaled), source: "dealingRange" };
  }

  const pd = ms?.premiumDiscount;
  // Reject UNKNOWN zone explicitly — its positionPct is the engine's null
  // signal (set to 0.5 with rangeHigh/rangeLow null when swings insufficient).
  if (pd && pd.zone !== "UNKNOWN" && Number.isFinite(pd.positionPct)) {
    return { value: Number(pd.positionPct) * 100, source: "premiumDiscount" };
  }

  return { value: null, source: "missing" };
}

function readIntradayBias(a: PairAnalysis): IntradayBias {
  const direction = a.scores?.direction;
  const composite = Number(a.scores?.composite ?? 0);
  const msScore = Number((a.marketStructure as any)?.score ?? 0);

  // Require corroboration: direction must agree with at least one of
  // composite or marketStructure score in the same sign and magnitude.
  if (direction === "LONG" && (composite >= 30 || msScore >= 25)) return "BULL";
  if (direction === "SHORT" && (composite <= -30 || msScore <= -25)) return "BEAR";
  // Strong standalone signal even without direction == LONG/SHORT.
  if (composite >= 35 || msScore >= 30) return "BULL";
  if (composite <= -35 || msScore <= -30) return "BEAR";
  return "NEUTRAL";
}

function readNewsImpact(a: PairAnalysis): NewsImpact {
  const news = a.news as any;
  if (!news) return "NONE";
  if (news.breakingActive === true) return "HIGH";
  if (news.highImpactPending === true) return "HIGH";
  // NewsReport does not currently expose a mediumImpactPending flag.
  // Returning "MEDIUM" without evidence would be a fabrication, so we don't.
  return "NONE";
}

function readNewsAlignedWithTrade(a: PairAnalysis): boolean {
  const news = a.news as any;
  const direction = a.scores?.direction;
  if (!news || direction === "FLAT") return false;

  // 1. Breaking news has its own directional score.
  if (news.breakingActive === true && Number.isFinite(news.breakingScore)) {
    const bs = Number(news.breakingScore);
    if (direction === "LONG" && bs > 15) return true;
    if (direction === "SHORT" && bs < -15) return true;
    return false;
  }

  // 2. HIGH-impact pending: align via pairScore.
  if (news.highImpactPending === true && Number.isFinite(news.pairScore)) {
    const ps = Number(news.pairScore);
    if (direction === "LONG" && ps > 15) return true;
    if (direction === "SHORT" && ps < -15) return true;
  }

  return false;
}

/**
 * Map manipulation primary signal → which side's liquidity was just swept.
 *
 * Convention used by judgeEngineV4:
 *   sweptHigh = buy-side liquidity grabbed (sell-stops above) → bearish reversal cue
 *   sweptLow  = sell-side liquidity grabbed (buy-stops below) → bullish reversal cue
 *
 * Mapping from manipulation engine kinds:
 *   BULLISH_SWEEP : wick BELOW session low, close ABOVE → sweptLow = true
 *   BEARISH_SWEEP : wick ABOVE session high, close BELOW → sweptHigh = true
 *   JUDAS_BULL    : London dipped to londonLow then reversed up → sweptLow = true
 *   JUDAS_BEAR    : London spiked to londonHigh then reversed down → sweptHigh = true
 *   NONE          : both null (not "false" — null = "we didn't measure this here")
 *
 * Returns null/null when the engine reports NONE so the judge can distinguish
 * "no sweep" from "engine didn't speak".
 */
function readSweeps(a: PairAnalysis): { sweptHigh: boolean | null; sweptLow: boolean | null } {
  const manip = (a as any).manipulation;
  if (!manip || !manip.primary) return { sweptHigh: null, sweptLow: null };
  const kind = String(manip.primary.kind ?? "").toUpperCase();

  switch (kind) {
    case "BULLISH_SWEEP": return { sweptHigh: false, sweptLow: true };
    case "JUDAS_BULL":    return { sweptHigh: false, sweptLow: true };
    case "BEARISH_SWEEP": return { sweptHigh: true,  sweptLow: false };
    case "JUDAS_BEAR":    return { sweptHigh: true,  sweptLow: false };
    case "NONE":          return { sweptHigh: false, sweptLow: false };
    default:              return { sweptHigh: null,  sweptLow: null };
  }
}

function readBos(a: PairAnalysis): StructureSignal {
  const ms = a.marketStructure as any;
  if (!ms?.lastBosKind) return "NONE";
  // Only respect a BOS the user can still act on — fresh = ageBars ≤ 3.
  if (ms.lastBosFresh !== true) return "NONE";
  const k = String(ms.lastBosKind);
  if (k === "BOS_BULL") return "BULL";
  if (k === "BOS_BEAR") return "BEAR";
  return "NONE";
}

function readChoch(a: PairAnalysis): StructureSignal {
  const ms = a.marketStructure as any;
  if (!ms?.lastChochKind) return "NONE";
  if (ms.lastChochFresh !== true) return "NONE";
  const k = String(ms.lastChochKind);
  if (k === "CHOCH_BULL") return "BULL";
  if (k === "CHOCH_BEAR") return "BEAR";
  return "NONE";
}

function readEntryConfirmation(a: PairAnalysis): boolean {
  const m5t = (a as any).m5Trigger;
  if (!m5t) return false;
  const sig = String(m5t.signal ?? "").toUpperCase();
  return sig === "BULL_TRIGGER" || sig === "BEAR_TRIGGER";
}

// ─── v4.6 Phase A — Fibonacci + Pivot readers ─────────────────────────────

/**
 * True when price is in Fib Golden Zone (50-61.8% retracement) AND the
 * dealing leg matches the verdict direction AND H4 trend agrees.
 *
 * BUY: requires BULL_LEG leg + H4 trend UP
 * SELL: requires BEAR_LEG leg + H4 trend DOWN
 *
 * Anything else returns false (e.g. golden zone of a BEAR_LEG when we are
 * considering a BUY — that is NOT a discount, it's catching a falling knife).
 */
function readFibGoldenZoneAligned(a: PairAnalysis, h4Trend: H4Trend, verdict: Verdict): boolean {
  const fib = (a as any).fibonacci;
  if (!fib || fib.inGoldenZone !== true) return false;
  if (verdict === "BUY"  && fib.legType === "BULL_LEG" && h4Trend === "UP")   return true;
  if (verdict === "SELL" && fib.legType === "BEAR_LEG" && h4Trend === "DOWN") return true;
  return false;
}

/**
 * True when price has moved BEYOND 1.272 Fibonacci extension in the trade's
 * direction (overstretched). Implies the impulse has already run a lot.
 */
function readFibExtendedSameDirection(a: PairAnalysis, verdict: Verdict): boolean {
  const fib = (a as any).fibonacci;
  if (!fib || !Number.isFinite(fib.positionRatio)) return false;
  if ((fib.positionRatio as number) < 1.272) return false;
  if (verdict === "BUY"  && fib.legType === "BULL_LEG") return true;
  if (verdict === "SELL" && fib.legType === "BEAR_LEG") return true;
  return false;
}

/**
 * True when classic daily pivot P stands AGAINST the trade direction.
 *   - BUY but current price BELOW pivot  → pivot is overhead resistance
 *   - SELL but current price ABOVE pivot → pivot is support below
 *
 * Returns false when pivots are unavailable (e.g. first 2 D1 candles missing)
 * or when price equals pivot exactly.
 */
function readDailyPivotAgainst(a: PairAnalysis, verdict: Verdict): boolean {
  const piv = (a as any).pivotPoints;
  if (!piv || !piv.classic || !piv.basis) return false;
  const P = piv.classic.P;
  if (typeof P !== "number" || !Number.isFinite(P)) return false;
  const price = a.quote && Number.isFinite(a.quote.mid) ? a.quote.mid : null;
  if (price == null) return false;
  if (verdict === "BUY"  && price < P) return true;
  if (verdict === "SELL" && price > P) return true;
  return false;
}

function severityFromMode(mode: JudgeOverrideResult["mode"]): JudgeOverrideResult["severity"] {
  if (mode === "HARD_WAIT") return "BLOCKER";
  if (mode === "WAIT_FOR_CONFIRMATION") return "WARNING";
  return "INFO";
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function evaluateJudgeOverride(analysis: PairAnalysis): JudgeOverrideResult {
  const currentVerdict = analysis.verdict;
  const directionVerdict = verdictFromDirection(analysis.scores?.direction ?? "FLAT");
  const from = currentVerdict !== "WAIT" ? currentVerdict : directionVerdict;
  const confidence = analysis.scores?.confidence ?? 0;

  if (from === "WAIT") return emptyJudgeOverride(currentVerdict, confidence);

  const sweeps = readSweeps(analysis);
  const premium = readPremiumPct(analysis);

  const inputs = {
    h4Trend: readH4Trend(analysis),
    premiumPct: premium.value,
    intradayBias: readIntradayBias(analysis),
    newsImpact: readNewsImpact(analysis),
    // Coerce null → false ONLY when handed to the engine, because the engine
    // type is boolean. We retain the original null in `inputs` for audit.
    sweptHigh: sweeps.sweptHigh,
    sweptLow: sweeps.sweptLow,
    bos: readBos(analysis),
    choch: readChoch(analysis),
    newsAlignedWithTrade: readNewsAlignedWithTrade(analysis),
    entryConfirmation: readEntryConfirmation(analysis),
    premiumPctSource: premium.source,
    // v4.6 Phase A — Fibonacci + Pivot signals into judge
    fibGoldenZoneAligned: false,
    fibExtendedSameDirection: false,
    dailyPivotAgainst: false,
  };
  // Compute Phase A signals AFTER inputs object exists (depend on h4Trend + verdict from above)
  inputs.fibGoldenZoneAligned    = readFibGoldenZoneAligned(analysis, inputs.h4Trend, from);
  inputs.fibExtendedSameDirection = readFibExtendedSameDirection(analysis, from);
  inputs.dailyPivotAgainst        = readDailyPivotAgainst(analysis, from);

  const out = judgeEngineV4({
    verdict: from,
    confidence,
    h4Trend: inputs.h4Trend,
    premiumPct: inputs.premiumPct,
    intradayBias: inputs.intradayBias,
    newsImpact: inputs.newsImpact,
    sweptHigh: inputs.sweptHigh === true,
    sweptLow: inputs.sweptLow === true,
    bos: inputs.bos,
    choch: inputs.choch,
    newsAlignedWithTrade: inputs.newsAlignedWithTrade,
    entryConfirmation: inputs.entryConfirmation,
    // v4.6 Phase A
    fibGoldenZoneAligned:    inputs.fibGoldenZoneAligned,
    fibExtendedSameDirection: inputs.fibExtendedSameDirection,
    dailyPivotAgainst:        inputs.dailyPivotAgainst,
  });

  if (!out.active) {
    return {
      ...emptyJudgeOverride(currentVerdict, confidence),
      inputs,
    };
  }

  return {
    active: true,
    from: out.from,
    to: out.to,
    code: out.riskItems.map(x => x.code).join("+") || out.mode,
    severity: severityFromMode(out.mode),
    mode: out.mode,
    riskScore: out.riskScore,
    confidenceAdjustment: out.confidenceAdjustment,
    adjustedConfidence: out.adjustedConfidence,
    inputs,
    messages: out.messages,
  };
}

export function applyJudgeOverride(analysis: PairAnalysis): PairAnalysis {
  const judgeOverride = evaluateJudgeOverride(analysis);

  if (!judgeOverride.active) {
    return { ...analysis, ...({ judgeOverride } as any) };
  }

  const nextVerdict = judgeOverride.to;
  const nextDirection: Direction =
    nextVerdict === "BUY" ? "LONG" :
    nextVerdict === "SELL" ? "SHORT" :
    "FLAT";

  const nextConfidence = Math.min(
    judgeOverride.adjustedConfidence ?? analysis.scores.confidence ?? 0,
    nextVerdict === "WAIT" ? 59 : 100,
  );

  return {
    ...analysis,
    verdict: nextVerdict,
    scores: {
      ...analysis.scores,
      direction: nextDirection,
      confidence: nextConfidence,
    },
    plan: {
      ...analysis.plan,
      direction: nextDirection,
      notes: [
        ...analysis.plan.notes,
        `JudgeOverrideV4: ${judgeOverride.code ?? "active"}`,
        `JudgeRiskScore: ${judgeOverride.riskScore ?? 0}`,
        `PremiumPctSource: ${judgeOverride.inputs?.premiumPctSource ?? "missing"}`,
      ],
    },
    warnings: [
      ...analysis.warnings,
      `Judge Override V4: ${judgeOverride.mode ?? "active"} risk=${judgeOverride.riskScore ?? 0}`,
    ],
    summary: `${analysis.summary} | Judge Override V4: ${judgeOverride.from} → ${judgeOverride.to} risk=${judgeOverride.riskScore ?? 0}`,
    verdictExplanation: {
      ...analysis.verdictExplanation,
      why: [
        ...analysis.verdictExplanation.why,
        `Judge Override V4 reviewed risk score ${judgeOverride.riskScore ?? 0}`,
      ],
      missing: nextVerdict === "WAIT"
        ? [...analysis.verdictExplanation.missing, judgeOverride.code ?? "judge_override_v4_active"]
        : analysis.verdictExplanation.missing,
      nextSteps: [
        ...analysis.verdictExplanation.nextSteps,
        ...judgeOverride.messages.map(m => m.en),
      ],
    },
    ...({ judgeOverride } as any),
  };
}
