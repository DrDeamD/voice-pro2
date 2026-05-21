// ============================================================================
// RSI Divergence Detector (NEW) — fixes audit flaw #9
//
// Detects regular (reversal) and hidden (continuation) divergences between
// price and RSI. Operates on H1 / M15 candles with a rolling pivot window.
//
//   REGULAR_BULL : price makes lower low, RSI makes higher low → reversal UP
//   REGULAR_BEAR : price makes higher high, RSI makes lower high → reversal DOWN
//   HIDDEN_BULL  : price makes higher low, RSI makes lower low  → trend UP continuation
//   HIDDEN_BEAR  : price makes lower high, RSI makes higher high → trend DN continuation
// ============================================================================
import type { Candle } from "../types/index.js";

/** Build the full RSI series (Wilder). Returns array with RSI at each index (NaN where insufficient). */
function rsiSeries(closes: number[], period = 14): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgG = gain / period, avgL = loss / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d >= 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

const computeRsi = rsiSeries;

export type DivergenceKind = "REGULAR_BULL" | "REGULAR_BEAR" | "HIDDEN_BULL" | "HIDDEN_BEAR";

export interface Divergence {
  kind: DivergenceKind;
  priceFrom: number;
  priceTo: number;
  rsiFrom: number;
  rsiTo: number;
  barsApart: number;
  strength: number;           // 0..100
  note: string;
}

export interface DivergenceReport {
  signals: Divergence[];
  score: number;              // -100 .. +100 (bullish positive)
  reasoning: string;
}

/**
 * Detect local pivots in a 1D series (simple fractal, window = 2).
 */
function pivots(series: number[], window = 2): { i: number; v: number; hi: boolean }[] {
  const out: { i: number; v: number; hi: boolean }[] = [];
  for (let i = window; i < series.length - window; i++) {
    let isHi = true, isLo = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      if (series[j] >= series[i]) isHi = false;
      if (series[j] <= series[i]) isLo = false;
    }
    if (isHi) out.push({ i, v: series[i], hi: true });
    if (isLo) out.push({ i, v: series[i], hi: false });
  }
  return out;
}

export function detectRsiDivergence(
  candles: Candle[],
  lookback = 60,
  rsiPeriod = 14,
): DivergenceReport {
  if (candles.length < rsiPeriod + 10) {
    return { signals: [], score: 0, reasoning: "Not enough bars for RSI divergence." };
  }
  const closes = candles.map(c => c.c);
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const rsiSeries = computeRsi(closes, rsiPeriod);

  const start = Math.max(0, closes.length - lookback);
  const tail = { highs: highs.slice(start), lows: lows.slice(start), rsi: rsiSeries.slice(start) };

  // Price pivots: highs / lows separately
  const priceHiPivs = pivots(tail.highs, 2).filter(p => p.hi).slice(-4);
  const priceLoPivs = pivots(tail.lows, 2).filter(p => !p.hi).slice(-4);
  const rsiPivs = pivots(tail.rsi, 2);
  const rsiHiPivs = rsiPivs.filter(p => p.hi);
  const rsiLoPivs = rsiPivs.filter(p => !p.hi);

  const signals: Divergence[] = [];

  // Pair last two price pivots
  const pairLastTwo = <T extends { i: number; v: number }>(arr: T[]) =>
    arr.length >= 2 ? [arr[arr.length - 2], arr[arr.length - 1]] : null;

  const matchRsiAt = (arr: { i: number; v: number }[], targetI: number, tol = 3) => {
    // v4.6.23 — pick the NEAREST RSI pivot within tolerance, not the first in
    // array order (which could mis-pair when two RSI pivots sit close together).
    let best: { i: number; v: number } | null = null;
    let bestD = Infinity;
    for (const p of arr) {
      const d = Math.abs(p.i - targetI);
      if (d <= tol && d < bestD) { best = p; bestD = d; }
    }
    return best;
  };

  // Bullish checks (on lows)
  const loPair = pairLastTwo(priceLoPivs);
  if (loPair) {
    const [p1, p2] = loPair;
    const r1 = matchRsiAt(rsiLoPivs, p1.i);
    const r2 = matchRsiAt(rsiLoPivs, p2.i);
    if (r1 && r2) {
      // REGULAR_BULL: price LL, RSI HL
      if (p2.v < p1.v && r2.v > r1.v) {
        const strength = Math.min(100, 40 + Math.round((r2.v - r1.v) * 3) + Math.round(((p1.v - p2.v) / p1.v) * 5000));
        signals.push({
          kind: "REGULAR_BULL",
          priceFrom: p1.v, priceTo: p2.v, rsiFrom: r1.v, rsiTo: r2.v,
          barsApart: p2.i - p1.i, strength,
          note: `Regular bullish divergence: price ${p1.v.toFixed(5)}→${p2.v.toFixed(5)}, RSI ${r1.v.toFixed(1)}→${r2.v.toFixed(1)}.`,
        });
      }
      // HIDDEN_BULL: price HL, RSI LL
      if (p2.v > p1.v && r2.v < r1.v) {
        const strength = Math.min(100, 30 + Math.round((r1.v - r2.v) * 3));
        signals.push({
          kind: "HIDDEN_BULL",
          priceFrom: p1.v, priceTo: p2.v, rsiFrom: r1.v, rsiTo: r2.v,
          barsApart: p2.i - p1.i, strength,
          note: `Hidden bullish divergence: uptrend continuation — price HL ${p2.v.toFixed(5)}, RSI LL ${r2.v.toFixed(1)}.`,
        });
      }
    }
  }

  // Bearish checks (on highs)
  const hiPair = pairLastTwo(priceHiPivs);
  if (hiPair) {
    const [p1, p2] = hiPair;
    const r1 = matchRsiAt(rsiHiPivs, p1.i);
    const r2 = matchRsiAt(rsiHiPivs, p2.i);
    if (r1 && r2) {
      // REGULAR_BEAR: price HH, RSI LH
      if (p2.v > p1.v && r2.v < r1.v) {
        const strength = Math.min(100, 40 + Math.round((r1.v - r2.v) * 3) + Math.round(((p2.v - p1.v) / p1.v) * 5000));
        signals.push({
          kind: "REGULAR_BEAR",
          priceFrom: p1.v, priceTo: p2.v, rsiFrom: r1.v, rsiTo: r2.v,
          barsApart: p2.i - p1.i, strength,
          note: `Regular bearish divergence: price ${p1.v.toFixed(5)}→${p2.v.toFixed(5)}, RSI ${r1.v.toFixed(1)}→${r2.v.toFixed(1)}.`,
        });
      }
      // HIDDEN_BEAR: price LH, RSI HH
      if (p2.v < p1.v && r2.v > r1.v) {
        const strength = Math.min(100, 30 + Math.round((r2.v - r1.v) * 3));
        signals.push({
          kind: "HIDDEN_BEAR",
          priceFrom: p1.v, priceTo: p2.v, rsiFrom: r1.v, rsiTo: r2.v,
          barsApart: p2.i - p1.i, strength,
          note: `Hidden bearish divergence: downtrend continuation — price LH ${p2.v.toFixed(5)}, RSI HH ${r2.v.toFixed(1)}.`,
        });
      }
    }
  }

  // Score: regular > hidden; sum capped
  let score = 0;
  for (const s of signals) {
    const sign = s.kind.includes("BULL") ? 1 : -1;
    const weight = s.kind.startsWith("REGULAR") ? 1.0 : 0.5;
    score += sign * s.strength * weight;
  }
  score = Math.max(-100, Math.min(100, Math.round(score)));

  return {
    signals,
    score,
    reasoning: signals.length
      ? signals.map(s => s.note).join(" • ")
      : "No RSI divergence detected.",
  };
}
