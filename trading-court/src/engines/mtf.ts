// ============================================================================
// Multi-Timeframe Alignment Engine
// Adds M15 layer — essential for DAY TRADING entries
// ============================================================================
import type { Direction, IndicatorBlock, MTFReport } from "../types/index.js";

function tfDirection(ind: IndicatorBlock): [Direction, string] {
  const { lastClose: p, ema20, ema50, ema200, rsi14: rsi } = ind;
  if (p == null || ema50 == null) return ["FLAT", "insufficient data"];

  const bull = ema20 != null && ema200 != null && ema20 > ema50 && ema50 > ema200 && p > ema50;
  const bear = ema20 != null && ema200 != null && ema20 < ema50 && ema50 < ema200 && p < ema50;

  if (bull && (rsi == null || rsi >= 45)) return ["LONG", "bullish EMA stack + price above"];
  if (bear && (rsi == null || rsi <= 55)) return ["SHORT", "bearish EMA stack + price below"];

  if (p > ema50 && (rsi == null || rsi > 55)) return ["LONG", "price above EMA50, RSI supportive"];
  if (p < ema50 && (rsi == null || rsi < 45)) return ["SHORT", "price below EMA50, RSI supportive"];

  return ["FLAT", "mixed structure"];
}

const signed = (d: Direction) => d === "LONG" ? 1 : d === "SHORT" ? -1 : 0;

/**
 * Weighted MTF — DAYTRADING OPTIMIZED (NEW Priorität 6):
 *
 * Old (Swing-Trading bias):  M15×1, H1×2, H4×3, D1×4  → Total 10 → D1 dominates
 * New (Daytrading-optimized): M15×2, H1×3, H4×3, D1×2  → Total 10 → H1+H4 dominate
 *
 * Rationale:
 *   D1 dient als Trend-Filter, nicht als Haupt-Entscheidung.
 *   H4+H1 definieren das Setup und den Einstiegsbereich.
 *   M15 bestätigt den Entry-Zeitpunkt.
 *   Für Daytrading auf M15/H1 ist D1 mit ×4 zu dominant.
 */
export function analyzeMTF(m15: IndicatorBlock, h1: IndicatorBlock, h4: IndicatorBlock, d1: IndicatorBlock): MTFReport {
  const [m15d, m15w] = tfDirection(m15);
  const [h1d, h1w] = tfDirection(h1);
  const [h4d, h4w] = tfDirection(h4);
  const [d1d, d1w] = tfDirection(d1);

  // v4.6.24 — INTRADAY: M15×3, H1×3, H4×2, D1×1 → Total 9. Fast frames (M15+H1
  // = 67%) lead; H4 is context, D1 a light filter. Was M15×2,H1×3,H4×3,D1×2
  // where slow frames (H4+D1) still held 50% of the vote.
  const vote = signed(m15d) * 3 + signed(h1d) * 3 + signed(h4d) * 2 + signed(d1d) * 1;
  const score = (vote / 9) * 100;

  let direction: Direction = "FLAT";
  if (score >= 35) direction = "LONG";
  else if (score <= -35) direction = "SHORT";

  const reasoning = [
    `M15 ${m15d} (${m15w}) ×3`,
    `H1 ${h1d} (${h1w}) ×3`,
    `H4 ${h4d} (${h4w}) ×2`,
    `D1 ${d1d} (${d1w}) ×1`,
    `Weighted vote ${vote}/10 → ${score.toFixed(0)}`,
  ].join("; ");

  return { m15Dir: m15d, h1Dir: h1d, h4Dir: h4d, d1Dir: d1d, alignment: score, direction, reasoning };
}

export const mtfScore = (r: MTFReport) => Math.max(-100, Math.min(100, r.alignment));
