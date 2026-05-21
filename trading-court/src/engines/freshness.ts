// ============================================================================
// Freshness & Spread Monitor (NEW) — fixes audit flaws #1 and #10
//
// Guarantees three things before we even consider trading:
//   1. Quote is FRESH (< 60s old)
//   2. Candles are FRESH (last bar within expected bar interval × 2)
//   3. Spread is within acceptable per-instrument limits
//
// Returns VETO if any check fails → court engine rejects the trade.
// ============================================================================
import type { Quote, CandleSeries } from "../types/index.js";

export interface SpreadLimits {
  normal: number;    // typical retail spread in pips
  max: number;       // veto threshold
}

/** Typical retail spreads by instrument (London hours). */
export const SPREAD_LIMITS: Record<string, SpreadLimits> = {
  EURUSD: { normal: 0.5, max: 2.5 },
  GBPUSD: { normal: 0.8, max: 3.0 },
  USDJPY: { normal: 0.8, max: 3.0 },
  AUDUSD: { normal: 0.9, max: 3.5 },
  USDCAD: { normal: 1.0, max: 3.5 },
  USDCHF: { normal: 1.2, max: 4.0 },
  XAUUSD: { normal: 3.5, max: 20.0 },   // gold in pips (0.1 pip unit → $0.35 normal)
  // v4.1 Phase 1 — EUR Crosses. EDUCATED GUESS from typical retail spread
  // tables (Swissquote / IG / Pepperstone aggregated). Will be re-derived from
  // production journal after ~4 weeks of cross-pair traffic. Acceptable range
  // until then: ±50% of values below.
  EURJPY: { normal: 1.5, max: 5.0 },    // JPY cross, medium liquidity
  EURGBP: { normal: 0.8, max: 3.0 },    // tightest cross, very active London
  // v4.1 Phase 2 — verified working crosses only. GBPJPY/CADJPY/GBPCHF
  // were removed after first production deploy showed no usable candle
  // stream from any free source.
  AUDJPY: { normal: 1.8, max: 5.5 },
  EURCHF: { normal: 1.2, max: 4.0 },    // most stable cross
  EURAUD: { normal: 1.5, max: 5.0 },
  EURCAD: { normal: 1.8, max: 5.5 },
};

export interface FreshnessReport {
  quoteAgeSec: number;
  quoteFresh: boolean;
  lastCandleAgeSec: number | null;
  candlesFresh: boolean;
  spread: number;                 // pips
  spreadNormal: boolean;
  spreadVeto: boolean;
  staleVeto: boolean;
  allowed: boolean;               // final: can we trade?
  reasons: string[];
}

export function assessFreshness(
  symbol: string,
  quote: Quote,
  m15: CandleSeries | undefined,
): FreshnessReport {
  const reasons: string[] = [];
  const now = Date.now();
  const quoteAgeSec = quote.available ? Math.max(0, (now - quote.ts) / 1000) : Infinity;
  const quoteFresh = quoteAgeSec < 60;
  if (!quote.available) reasons.push("Quote unavailable");
  else if (!quoteFresh) reasons.push(`Quote stale (${quoteAgeSec.toFixed(0)}s old > 60s limit)`);

  // Candle freshness
  let lastCandleAgeSec: number | null = null;
  let candlesFresh = true;
  if (m15?.candles?.length) {
    const lastBar = m15.candles[m15.candles.length - 1];
    lastCandleAgeSec = Math.max(0, (now / 1000) - lastBar.t);
    // M15 bars should be no more than ~30 min old
    candlesFresh = lastCandleAgeSec < 30 * 60;
    if (!candlesFresh) reasons.push(`M15 candles stale (${Math.round(lastCandleAgeSec / 60)}m old)`);
  } else {
    candlesFresh = false;
    reasons.push("No M15 candles available");
  }

  // Spread check
  const limits = SPREAD_LIMITS[symbol] ?? { normal: 1.0, max: 5.0 };
  const spread = quote.spread || 0;
  const spreadNormal = spread <= limits.normal * 1.5;
  const spreadVeto = spread > limits.max;
  if (spreadVeto) reasons.push(`Spread ${spread.toFixed(2)}p > max ${limits.max}p → VETO`);
  else if (!spreadNormal) reasons.push(`Spread ${spread.toFixed(2)}p > normal ${limits.normal}p (caution)`);

  const staleVeto = !quoteFresh || !candlesFresh;
  const allowed = !spreadVeto && !staleVeto;

  return {
    quoteAgeSec: Math.round(quoteAgeSec),
    quoteFresh,
    lastCandleAgeSec: lastCandleAgeSec != null ? Math.round(lastCandleAgeSec) : null,
    candlesFresh,
    spread,
    spreadNormal,
    spreadVeto,
    staleVeto,
    allowed,
    reasons,
  };
}
