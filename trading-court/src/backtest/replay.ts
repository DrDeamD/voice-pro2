// ============================================================================
// Backtest Replay — v3.8
//
// Walks through historical M1 candles, asks runCourt() for a verdict at each
// chosen replay step, then computes the actual forward outcome from the
// data we already loaded. This gives us a real PnL trajectory for every
// historical decision the engine would have made.
//
// What it does NOT do (Phase 1 limitation, documented honestly):
//   - News engine input is stubbed to []. Historical news archives are not
//     in scope; integrating one is Phase 2. Today the technical engines
//     (MTF, regime, momentum, vwap, marketStructure, manipulation, divergence)
//     are calibrated faithfully, but the news contribution to composite is
//     zero in the backtest. The reported win-rate is therefore for "technical
//     setup only" decisions.
//   - Calendar events likewise stubbed.
//   - Context (DXY/VIX/Oil/Gold/US10Y) stubbed to neutral. Adding FRED
//     historical is Phase 2.
//
// Outcome model:
//   For each verdict in {BUY, SELL}, scan the M1 candles AFTER the decision.
//   - WIN if TP1 (from plan.tp1) is touched before SL.
//   - LOSS if SL is touched first.
//   - TIMEOUT if neither is touched within `holdMaxBars` bars (default 720
//     M1 bars = 12 hours). Treated as a small-magnitude loss for the
//     win-rate denominator (configurable).
// ============================================================================

import type { Candle, CandleSeries, Quote, Verdict } from "../types/index.js";
import { runCourt } from "../engines/court.js";
import { INSTRUMENTS } from "../config.js";

export interface ReplayOptions {
  symbol: string;
  m1: Candle[];
  /** Replay every Nth M1 bar. Default 15 (decisions every 15 minutes). */
  stepM1: number;
  /** Skip the first K M1 bars to allow indicator warmup. Default 1500
   *  (~25h on M1, enough for D1 EMA200 if multi-day data, otherwise enough
   *  for H4/H1 EMA stacks). */
  warmupM1: number;
  /** Max forward bars to search for SL/TP hit. Default 720 (12h). */
  holdMaxBars: number;
}

export interface BacktestVerdictRecord {
  tsUtc: string;
  verdict: Verdict;
  composite: number;
  confidence: number;
  confidenceTier: string;
  direction: string;
  entry: number | null;
  stopLoss: number | null;
  tp1: number | null;
  rr1: number | null;
  outcome: "WIN" | "LOSS" | "TIMEOUT" | "NONE";
  outcomeBars: number | null;
  outcomePips: number | null;
  /** Source-of-truth list of risk reasons that produced WAIT (if any). Lets
   *  the user inspect WHY the system held off. */
  riskReasons: string[];
}

function buildSyntheticQuote(symbol: string, c: Candle): Quote {
  // Backtest uses the close as both bid and ask (no spread). Honest because
  // HistData does not include spread. If spread modelling matters, the user
  // can post-process records to apply a fixed cost.
  return {
    symbol,
    available: true,
    bid: c.c,
    ask: c.c,
    mid: c.c,
    spread: 0,
    source: "histdata",
    // Production convention: quote.ts is milliseconds (Date.now()-derived).
    // c.t is unix seconds. Multiply to match production unit so the truth
    // gate's quote-age math is consistent.
    ts: c.t * 1000,
  } as Quote;
}

function seriesAtBarIndex(allSeries: Record<string, CandleSeries>, m1Idx: number, m1: Candle[]): Record<string, CandleSeries> {
  // For each timeframe, slice candles to those whose bucket-end is ≤ current
  // M1 timestamp. This prevents leak-from-future.
  const cutoffT = m1[m1Idx].t;
  const out: Record<string, CandleSeries> = {};
  for (const tf of Object.keys(allSeries)) {
    const fullSeries = allSeries[tf];
    const slice = fullSeries.candles.filter(c => c.t <= cutoffT);
    out[tf] = { ...fullSeries, candles: slice, available: slice.length > 0 };
  }
  return out;
}

function computeOutcome(
  m1: Candle[],
  startIdx: number,
  direction: "LONG" | "SHORT",
  entry: number,
  sl: number,
  tp1: number,
  pip: number,
  holdMaxBars: number,
): { outcome: "WIN" | "LOSS" | "TIMEOUT"; bars: number; pips: number } {
  const endIdx = Math.min(startIdx + holdMaxBars, m1.length - 1);
  for (let i = startIdx + 1; i <= endIdx; i++) {
    const c = m1[i];
    if (direction === "LONG") {
      if (c.l <= sl) {
        return { outcome: "LOSS", bars: i - startIdx, pips: -(entry - sl) / pip };
      }
      if (c.h >= tp1) {
        return { outcome: "WIN", bars: i - startIdx, pips: (tp1 - entry) / pip };
      }
    } else {
      if (c.h >= sl) {
        return { outcome: "LOSS", bars: i - startIdx, pips: -(sl - entry) / pip };
      }
      if (c.l <= tp1) {
        return { outcome: "WIN", bars: i - startIdx, pips: (entry - tp1) / pip };
      }
    }
  }
  // Timeout — close at last available bar, mark as small loss equal to the
  // observed close-to-entry distance to keep PnL accounting honest.
  const lastClose = m1[endIdx].c;
  const pips = direction === "LONG"
    ? (lastClose - entry) / pip
    : (entry - lastClose) / pip;
  return { outcome: "TIMEOUT", bars: endIdx - startIdx, pips };
}

export async function replayBacktest(opts: ReplayOptions): Promise<BacktestVerdictRecord[]> {
  const { symbol, m1, stepM1, warmupM1, holdMaxBars } = opts;
  const meta = INSTRUMENTS[symbol];
  if (!meta) throw new Error(`Unknown symbol: ${symbol}`);

  // Build the full timeframe series ONCE; sliced per-bar inside the loop.
  const { buildSeriesFromM1 } = await import("./loadHistdata.js");
  const fullSeries = buildSeriesFromM1(m1);

  const records: BacktestVerdictRecord[] = [];

  for (let i = warmupM1; i < m1.length; i += stepM1) {
    const bar = m1[i];
    const quote = buildSyntheticQuote(symbol, bar);
    const series = seriesAtBarIndex(fullSeries, i, m1);

    let analysis;
    try {
      analysis = runCourt({
        symbol,
        calendarEvents: [],
        now: new Date(bar.t * 1000),
        quote,
        series,
        ctx: {
          dxy: null, gold: null, oil: null, vix: null, y10: null,
          dxyLevel: null, vixLevel: null, y10Level: null,
        },
        newsItems: [],
        backtestMode: true,
      });
    } catch (err) {
      // If runCourt throws (e.g. truth-gate insufficiency early in dataset),
      // skip this bar — not a verdict, no record.
      continue;
    }

    let outcome: BacktestVerdictRecord["outcome"] = "NONE";
    let outcomeBars: number | null = null;
    let outcomePips: number | null = null;

    if ((analysis.verdict === "BUY" || analysis.verdict === "SELL") &&
        analysis.plan.entry != null &&
        analysis.plan.stopLoss != null &&
        analysis.plan.tp1 != null) {
      const dir: "LONG" | "SHORT" = analysis.verdict === "BUY" ? "LONG" : "SHORT";
      const r = computeOutcome(
        m1, i, dir,
        analysis.plan.entry,
        analysis.plan.stopLoss,
        analysis.plan.tp1,
        meta.pip,
        holdMaxBars,
      );
      outcome = r.outcome;
      outcomeBars = r.bars;
      outcomePips = Math.round(r.pips * 10) / 10;
    }

    records.push({
      tsUtc: new Date(bar.t * 1000).toISOString(),
      verdict: analysis.verdict,
      composite: analysis.scores.composite,
      confidence: analysis.scores.confidence,
      confidenceTier: analysis.scores.confidenceTier,
      direction: analysis.scores.direction,
      entry: analysis.plan.entry,
      stopLoss: analysis.plan.stopLoss,
      tp1: analysis.plan.tp1,
      rr1: analysis.plan.rr1,
      outcome,
      outcomeBars,
      outcomePips,
      riskReasons: analysis.risk?.reasons ?? [],
    });
  }

  return records;
}
