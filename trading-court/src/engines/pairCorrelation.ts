// ============================================================================
// Pair Correlation Heatmap — v4.2 Phase 3
//
// Computes pair-vs-pair Pearson correlations on the last N=96 M15 log-returns
// (~24 hours). Used by:
//   1. Dashboard heatmap visualisation
//   2. Argument cards: "double exposure" warning when correlated pairs both
//      have the same verdict
//
// Honest behaviour:
//   - When a pair has fewer than 30 valid log-returns → correlations involving
//     it are null, not zero
// ============================================================================

import type { Candle } from "../types/index.js";

export interface PairCorrelationReport {
  symbols: string[];
  /** Matrix[symA][symB] = correlation in [-1, +1] or null when undefined */
  matrix: Record<string, Record<string, number | null>>;
  /** Per-pair top 3 most-correlated other pairs (absolute) */
  topCorrelated: Record<string, Array<{ symbol: string; corr: number }>>;
  lookback: number;
  reasoning: string;
}

function logReturns(candles: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const p0 = candles[i - 1]!.c;
    const p1 = candles[i]!.c;
    if (Number.isFinite(p0) && Number.isFinite(p1) && p0 > 0 && p1 > 0) {
      out.push(Math.log(p1 / p0));
    }
  }
  return out;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 30) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]!; sy += ys[i]!; }
  const mx = sx / n, my = sy / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  if (dx2 <= 0 || dy2 <= 0) return null;
  const c = num / Math.sqrt(dx2 * dy2);
  if (!Number.isFinite(c)) return null;
  return Math.round(c * 100) / 100;
}

export function computePairCorrelations(
  candlesBySymbol: Record<string, Candle[]>,
  lookback: number = 96,
): PairCorrelationReport {
  const seriesBySymbol: Record<string, number[]> = {};
  const symbols: string[] = [];

  for (const [sym, candles] of Object.entries(candlesBySymbol)) {
    if (!candles || candles.length < 31) continue;
    const ret = logReturns(candles.slice(-lookback - 1));
    if (ret.length >= 30) {
      seriesBySymbol[sym] = ret;
      symbols.push(sym);
    }
  }

  const matrix: Record<string, Record<string, number | null>> = {};
  for (const a of symbols) {
    matrix[a] = {};
    for (const b of symbols) {
      if (a === b) { matrix[a]![b] = 1; continue; }
      matrix[a]![b] = pearson(seriesBySymbol[a]!, seriesBySymbol[b]!);
    }
  }

  const topCorrelated: Record<string, Array<{ symbol: string; corr: number }>> = {};
  for (const a of symbols) {
    const arr: Array<{ symbol: string; corr: number }> = [];
    for (const b of symbols) {
      if (a === b) continue;
      const c = matrix[a]![b];
      if (c == null) continue;
      arr.push({ symbol: b, corr: c });
    }
    arr.sort((x, y) => Math.abs(y.corr) - Math.abs(x.corr));
    topCorrelated[a] = arr.slice(0, 3);
  }

  const reasoning = symbols.length === 0
    ? "No pair has enough M15 history to compute correlations"
    : `Correlations computed over last ${lookback} M15 candles across ${symbols.length} pairs.`;

  return { symbols, matrix, topCorrelated, lookback, reasoning };
}
