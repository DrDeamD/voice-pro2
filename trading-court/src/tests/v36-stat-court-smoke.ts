// ============================================================================
// Trading Court Pro v3.6 — Smoke Test
// This test uses only existing project types and deterministic local candles.
// It is NOT a trading test. It verifies compile + no crash.
// ============================================================================

import type { Candle, CandleSeries, PairAnalysis, Quote } from "../types/index.js";
import { applyV36StatisticalCourt } from "../engines/v36/statCourt.js";

function candles(n: number, start = 1.1, step = 0.0001, interval = 3600): Candle[] {
  const now = Math.floor(Date.now() / 1000);
  let p = start;
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = p + step;
    out.push({ t: now - (n - i) * interval, o, h: Math.max(o, c) + Math.abs(step), l: Math.min(o, c) - Math.abs(step), c });
    p = c;
  }
  return out;
}

function series(tf: string, interval: number): CandleSeries {
  return {
    symbol: "EURUSD",
    timeframe: tf,
    candles: candles(160, 1.1, 0.0001, interval),
    source: "smoke_real_shape",
    available: true,
  };
}

const quote: Quote = {
  symbol: "EURUSD",
  bid: 1.115,
  ask: 1.1151,
  mid: 1.11505,
  spread: 1,
  source: "smoke_real_shape",
  ts: Date.now(),
  available: true,
};

const analysis = {
  symbol: "EURUSD",
  display: "EUR/USD",
  quote,
  mtf: { direction: "LONG", alignment: 70 },
  scores: { direction: "LONG", composite: 70, confidence: 82, confidenceTier: "STRONG", sizeMultiplier: 1 },
  plan: { direction: "LONG", notes: [] },
  verdict: "BUY",
  warnings: [],
  summary: "smoke",
  verdictExplanation: { why: [], missing: [], nextSteps: [] },
} as unknown as PairAnalysis;

const out = applyV36StatisticalCourt(analysis, {
  symbol: "EURUSD",
  quote,
  series: {
    "5m": series("5m", 300),
    "15m": series("15m", 900),
    "1h": series("1h", 3600),
    "4h": series("4h", 14400),
  },
});

console.log(JSON.stringify({ verdict: out.verdict, confidence: out.scores.confidence, v36: (out as any).v36 != null }, null, 2));
