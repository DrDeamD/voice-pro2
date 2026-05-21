// ============================================================================
// Momentum Engine — EMA stack + RSI + ADX amplification on M15/H1/H4
//
// v4.6.24 — INTRADAY rebalance: fast frames lead. Was H4×0.45 (heaviest),
// M15×0.20 (lightest) — inverted for a minutes-to-hours system. Now M15 leads.
// ============================================================================
import type { IndicatorBlock } from "../types/index.js";

export function momentumScore(m15: IndicatorBlock, h1: IndicatorBlock, h4: IndicatorBlock): number {
  const parts: { blk: IndicatorBlock; weight: number }[] = [
    { blk: m15, weight: 0.45 },
    { blk: h1,  weight: 0.35 },
    { blk: h4,  weight: 0.20 },
  ];

  let total = 0;
  let totalWeight = 0;
  for (const { blk, weight } of parts) {
    const { lastClose: p, ema20, ema50, rsi14: rsi, adx14: adx } = blk;
    if (p == null || ema50 == null || rsi == null) continue;
    let local = 0;
    if (ema20 != null) {
      if (ema20 > ema50 && p > ema50) local += 40;
      else if (ema20 < ema50 && p < ema50) local -= 40;
    }
    local += (rsi - 50) * 1.2;
    let adxFactor = 1.0;
    if (adx != null) adxFactor = Math.max(0.4, Math.min(1.3, adx / 25));
    local *= adxFactor;
    total += local * weight;
    totalWeight += weight;
  }
  if (totalWeight === 0) return 0;
  return Math.max(-100, Math.min(100, total / totalWeight * (totalWeight / 1.0)));
}
