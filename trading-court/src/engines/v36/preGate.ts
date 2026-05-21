// ============================================================================
// Trading Court Pro v3.7 — Pre-Classical Truth Gate
//
// Purpose:
//   Run v36 truth gate BEFORE any classical indicator is computed
//   (RSI / EMA / ATR / VWAP / MTF / market-structure / divergence ...).
//
// If truth fails, return an early WAIT analysis directly — without ever
// feeding contaminated candles (Investing PT5H-as-H4 etc.) into
// the classical engines.
//
// Pure construction. No fetch. No randomness. No defaults that simulate data.
// ============================================================================

import type {
  CandleSeries,
  ConfidenceTier,
  IndicatorBlock,
  InstrumentMeta,
  PairAnalysis,
  Quote,
  SessionReport,
} from "../../types/index.js";
import type { V36TruthResult } from "./statTypes.js";

function emptyIndicatorBlock(tf: string, n: number): IndicatorBlock {
  return {
    tf, n,
    lastClose: null,
    ema20: null, ema50: null, ema200: null, sma50: null,
    rsi14: null, atr14: null, adx14: null, bbWidth: null,
    structHigh: null, structLow: null,
  };
}

/**
 * Build a fully-typed PairAnalysis representing an early WAIT decision
 * caused by the v36 pre-classical truth gate. No classical indicators were
 * computed; every field is either a real input (quote, session, meta) or a
 * documented zero/null/FLAT default.
 */
export function buildPreGateWaitAnalysis(input: {
  symbol: string;
  meta: InstrumentMeta;
  quote: Quote;
  session: SessionReport;
  series: Record<string, CandleSeries>;
  truth: V36TruthResult;
}): PairAnalysis {
  const { symbol, meta, quote, session, series, truth } = input;

  const tier: ConfidenceTier = "REJECT";
  const reasons = truth.reasons;
  const reasonText = reasons.join(", ") || "v36_pre_classical_gate_failed";

  const warnings = [
    "v36 PRE-CLASSICAL TRUTH GATE FAILED — classical indicators NOT computed",
    ...truth.warnings.map(w => `V36 PreGate Truth: ${w}`),
    ...reasons.map(r => `V36 PreGate: ${r}`),
  ];

  // Build empty indicator blocks reflecting only the candle counts we actually
  // received (so the dashboard can still display "n bars available").
  const m5n  = series["5m"]?.candles.length  ?? 0;
  const m15n = series["15m"]?.candles.length ?? 0;
  const h1n  = series["1h"]?.candles.length  ?? 0;
  const h4n  = series["4h"]?.candles.length  ?? 0;
  const d1n  = series["1d"]?.candles.length  ?? 0;

  return {
    symbol,
    display: meta.display,
    quote,
    regime: {
      label: "UNKNOWN",
      adx: null,
      atrPct: null,
      bbWidthPct: null,
      reasoning: "Skipped: pre-classical truth gate failed",
    },
    mtf: {
      m15Dir: "FLAT", h1Dir: "FLAT", h4Dir: "FLAT", d1Dir: "FLAT",
      alignment: 0,
      direction: "FLAT",
      reasoning: "Skipped: pre-classical truth gate failed",
    },
    correlation: {
      dxyChange: null, goldChange: null, oilChange: null,
      vixChange: null, yield10yChange: null,
      score: 0, available: false,
      reasoning: "Skipped: pre-classical truth gate failed",
    },
    news: {
      items: [],
      baseScore: 0, quoteScore: 0, pairScore: 0,
      highImpactPending: false,
      reasoning: "Skipped: pre-classical truth gate failed",
    },
    priceAction: {
      direction: "NEUTRAL",
      score: 0,
      signals: [],
      sessionLevels: {
        asiaHigh: null, asiaLow: null,
        pdh: null, pdl: null,
        weeklyOpen: null, londonOpen: null, nyOpen: null,
      },
      reasoning: "Skipped: pre-classical truth gate failed",
    },
    session,
    scores: {
      mtf: 0, regime: 0, momentum: 0, correlation: 0, news: 0, priceAction: 0,
      sessionWeight: session.weight,
      compositeRaw: 0, composite: 0, confidence: 0,
      direction: "FLAT",
      confidenceTier: tier,
      sizeMultiplier: 0,
    },
    plan: {
      direction: "FLAT",
      tier: "REJECTED",
      confidenceTier: tier,
      entry: null, stopLoss: null,
      tp1: null, tp2: null, tp3: null,
      rr1: null, rr2: null,
      spreadCost: null, stopDistancePips: null, lotSizePer1Pct: null,
      sizeMultiplier: 0,
      notes: [
        "Plan not built: v36 pre-classical truth gate failed",
        ...reasons.map(r => `PreGate: ${r}`),
      ],
    },
    risk: {
      passed: false,
      reasons: [`v36_pre_classical_truth_gate: ${reasonText}`],
      atrUsed: null,
      calendarBlocked: false,
      calendarEvents: [],
    },
    verdict: "WAIT",
    opportunityStatus: "NONE",
    bullCase: [],
    bearCase: [],
    summary: `${meta.display} | V36 Pre-Classical Truth Gate: WAIT (${reasonText})`,
    verdictExplanation: {
      headline: `Pre-classical truth gate blocked ${meta.display}: indicators not computed on contaminated data`,
      why: [`V36 truth gate failed before any classical indicator ran`],
      missing: reasons,
      nextSteps: ["Wait until v36 truth gate clears (clean source / fresh data)"],
    },
    warnings,
    indicators: {
      m5:  emptyIndicatorBlock("5m",  m5n),
      m15: emptyIndicatorBlock("15m", m15n),
      h1:  emptyIndicatorBlock("1h",  h1n),
      h4:  emptyIndicatorBlock("4h",  h4n),
      d1:  emptyIndicatorBlock("1d",  d1n),
    },
    generatedUtc: new Date().toISOString(),
    ...({
      v36: {
        preGateFailed: true,
        truth,
        court: null,
        oldConfidence: 0,
        newConfidence: 0,
        witnesses: [],
      },
    } as any),
  };
}
