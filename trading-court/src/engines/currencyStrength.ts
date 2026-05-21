// ============================================================================
// Currency Strength Meter — v4.2 Phase 1
//
// Aggregates per-currency strength across all instruments in a snapshot.
// For each pair, the % change attribution flows to the BASE currency as
// positive (or quote as negative) when the pair is up, and vice versa.
//
// Sources of % change, in priority order per pair:
//   1. quote.changePct (when the data source supplied it — TradingView does)
//   2. computed from D1 candles (last close vs prior close)
//   3. computed from H4 candles (last 6 H4 = 24h window)
//   4. skip pair if no usable change signal
//
// Output: per-currency net change score plus a ranked list. Used by:
//   - Dashboard: top-of-page strength bar
//   - Judge override: "currency_strength_alignment" rule (Phase 2)
// ============================================================================

import type { PairAnalysis } from "../types/index.js";
import { INSTRUMENTS } from "../config.js";

export interface CurrencyStrengthEntry {
  currency: string;
  /** Aggregated strength score, normalised to [-100, +100]. */
  score: number;
  /** Number of pairs that contributed (more = more reliable). */
  contributingPairs: number;
  /** Raw sum of change %s (before normalisation). */
  rawSum: number;
}

export interface CurrencyStrengthReport {
  /** Map by currency code. */
  byCurrency: Record<string, CurrencyStrengthEntry>;
  /** Ranked strongest → weakest. */
  ranked: string[];
  /** Top + bottom (helpful for "best pair" inference). */
  strongest: string | null;
  weakest: string | null;
  /** Total pairs that had a usable change reading. */
  pairsUsed: number;
  /** v4.6.21 — tradeable pair with the largest strength spread (base − quote). */
  bestPair: { symbol: string; base: string; quote: string; direction: "BUY" | "SELL"; spread: number } | null;
  reasoning: string;
}

function extractChangePct(p: PairAnalysis): number | null {
  // 0) v4.6.19 — intraday window (H1 ~8h) attached by runCourt. Preferred for an
  // INTRADAY strength meter; reflects the current session's move, not the full
  // prior-day change which made the meter useless past the open.
  const intraday = (p as any).intradayChangePct;
  if (typeof intraday === "number" && Number.isFinite(intraday)) return intraday;

  // 1) Direct from quote (daily change — fallback only)
  const qchg = p.quote?.changePct;
  if (typeof qchg === "number" && Number.isFinite(qchg)) return qchg;

  // 2) Compute from D1 candles (yesterday's close vs prior day's close).
  // The pair has indicators.d1 but we don't carry the raw prev candle. The
  // analysis does expose `marketStructure.swingsH4` and other H4 history but
  // the cleanest fallback is to compute from quote.mid vs D1 close.
  const d1Close = (p as any).indicators?.d1?.lastClose;
  const mid = p.quote?.mid;
  if (typeof d1Close === "number" && Number.isFinite(d1Close) && d1Close > 0 &&
      typeof mid === "number" && Number.isFinite(mid) && mid > 0) {
    return ((mid - d1Close) / d1Close) * 100;
  }

  // 3) Last resort: H4 first vs last close (24h proxy). The analysis doesn't
  // currently surface this, so we skip. To enable, runCourt could attach
  // change24h alongside the indicators block.
  return null;
}

export function computeCurrencyStrength(
  pairs: PairAnalysis[],
): CurrencyStrengthReport {
  return computeCurrencyStrengthWith(pairs, extractChangePct);
}

// v4.6.20 — parameterised core so the same averaging+normalisation logic powers
// both the default intraday meter and the per-session ranking tables (each just
// supplies a different change extractor).
export function computeCurrencyStrengthWith(
  pairs: PairAnalysis[],
  extractor: (p: PairAnalysis) => number | null,
): CurrencyStrengthReport {
  const byCurrency: Record<string, CurrencyStrengthEntry> = {};
  let pairsUsed = 0;

  for (const p of pairs) {
    const meta = INSTRUMENTS[p.symbol];
    if (!meta) continue;
    const chg = extractor(p);
    if (chg == null || !Number.isFinite(chg)) continue;
    pairsUsed++;

    // For "EURUSD up 0.5%" → EUR +0.5, USD -0.5
    const { base, quote } = meta;
    if (!byCurrency[base]) byCurrency[base] = { currency: base, score: 0, contributingPairs: 0, rawSum: 0 };
    if (!byCurrency[quote]) byCurrency[quote] = { currency: quote, score: 0, contributingPairs: 0, rawSum: 0 };
    byCurrency[base].rawSum += chg;
    byCurrency[base].contributingPairs++;
    byCurrency[quote].rawSum -= chg;
    byCurrency[quote].contributingPairs++;
  }

  // v4.6.19 — score by the AVERAGE change per contributing pair, then normalise.
  // Summing (the old way) structurally amplified currencies that appear in MANY
  // pairs (EUR in 6, USD in 7) and muted ones in few (GBP/CHF/CAD in 2), so the
  // extremes were a pair-count artefact, not real relative strength.
  const avgByCcy: Record<string, number> = {};
  for (const k of Object.keys(byCurrency)) {
    const e = byCurrency[k];
    avgByCcy[k] = e.contributingPairs > 0 ? e.rawSum / e.contributingPairs : 0;
  }
  let maxAbs = 0;
  for (const k of Object.keys(avgByCcy)) {
    if (Math.abs(avgByCcy[k]) > maxAbs) maxAbs = Math.abs(avgByCcy[k]);
  }
  for (const k of Object.keys(byCurrency)) {
    byCurrency[k].score = maxAbs > 0
      ? Math.round((avgByCcy[k] / maxAbs) * 100)
      : 0;
  }

  const ranked = Object.values(byCurrency)
    .sort((a, b) => b.score - a.score)
    .map(e => e.currency);

  const strongest = ranked.length > 0 ? ranked[0]! : null;
  const weakest = ranked.length > 0 ? ranked[ranked.length - 1]! : null;

  // v4.6.21 — strongest tradeable pair = the instrument whose base/quote
  // strength spread is largest. spread>0 → base stronger → BUY; spread<0 → SELL.
  // This always resolves to a pair in our universe (unlike naively pairing the
  // single strongest vs weakest currency, which may not have a direct market).
  let bestPair: CurrencyStrengthReport["bestPair"] = null;
  for (const sym of Object.keys(INSTRUMENTS)) {
    const m = INSTRUMENTS[sym];
    const eb = byCurrency[m.base];
    const eq = byCurrency[m.quote];
    if (!eb || !eq || eb.contributingPairs === 0 || eq.contributingPairs === 0) continue;
    const spread = eb.score - eq.score;
    if (!bestPair || Math.abs(spread) > Math.abs(bestPair.spread)) {
      bestPair = { symbol: sym, base: m.base, quote: m.quote, direction: spread >= 0 ? "BUY" : "SELL", spread };
    }
  }

  const reasoning = pairsUsed === 0
    ? "No change data available — currency strength unavailable"
    : `Strongest: ${strongest} (${byCurrency[strongest!]?.score}), ` +
      `weakest: ${weakest} (${byCurrency[weakest!]?.score}). ` +
      `Based on ${pairsUsed} pair change-readings.`;

  return {
    byCurrency,
    ranked,
    strongest,
    weakest,
    pairsUsed,
    bestPair,
    reasoning,
  };
}
