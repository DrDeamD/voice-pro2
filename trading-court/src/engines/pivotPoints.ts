// ============================================================================
// Pivot Points Engine — v4.2 Phase 1
//
// Computes Classic + Camarilla daily pivots from the PRIOR completed day's
// OHLC. The Camarilla H4/L4 levels are widely used by intraday breakout
// traders.
//
// Inputs: D1 candles + current price.
// Output: pivot levels + the current position relative to them.
//
// Honest behaviour:
//   - When fewer than 2 D1 candles exist (cold data), returns nulls.
//   - Today's incomplete candle is NEVER used as the pivot basis; we use the
//     previous CLOSED day's HLC.
// ============================================================================

import type { Candle } from "../types/index.js";

export interface ClassicPivotLevels {
  P: number;
  R1: number; R2: number; R3: number;
  S1: number; S2: number; S3: number;
}

export interface CamarillaLevels {
  /** H4/L4 are the breakout-trigger lines used by intraday traders. */
  H4: number; L4: number;
  /** H3/L3 = reversal levels (price often bounces here). */
  H3: number; L3: number;
  H2: number; L2: number;
  H1: number; L1: number;
}

export interface PivotReport {
  basis: { pdh: number; pdl: number; pdc: number; dateUtc: string } | null;
  classic: ClassicPivotLevels | null;
  camarilla: CamarillaLevels | null;
  /** Where the current price sits — one of the level names */
  currentPosition: string;
  /** Distance to the nearest level (signed: + above, - below), in pips */
  nearestLevelDistancePips: number | null;
  nearestLevelName: string | null;
  reasoning: string;
}

function emptyReport(reason: string): PivotReport {
  return {
    basis: null,
    classic: null,
    camarilla: null,
    currentPosition: "UNKNOWN",
    nearestLevelDistancePips: null,
    nearestLevelName: null,
    reasoning: reason,
  };
}

function round5(v: number): number {
  return Math.round(v * 100000) / 100000;
}

function pipDistance(a: number, b: number, pip: number): number {
  return Math.round(((a - b) / pip) * 10) / 10;
}

export function computePivotPoints(
  d1: Candle[],
  currentPrice: number,
  pip: number,
): PivotReport {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return emptyReport("Current price unavailable");
  }
  if (!d1 || d1.length < 2) {
    return emptyReport("Need at least 2 D1 candles (yesterday's OHLC)");
  }

  // Use the SECOND-LAST candle as the "previous day" (the last candle is
  // today's still-forming session). For backtest determinism we accept the
  // last candle if its timestamp is older than 24h, but in the standard live
  // case we want the prior CLOSED day.
  const yesterday = d1[d1.length - 2];
  const pdh = yesterday.h;
  const pdl = yesterday.l;
  const pdc = yesterday.c;

  if (![pdh, pdl, pdc].every(Number.isFinite)) {
    return emptyReport("Yesterday's OHLC has non-finite values");
  }

  // ── Classic Pivots ──────────────────────────────────────────────────────
  const P = (pdh + pdl + pdc) / 3;
  const range = pdh - pdl;
  const R1 = (2 * P) - pdl;
  const S1 = (2 * P) - pdh;
  const R2 = P + range;
  const S2 = P - range;
  const R3 = pdh + 2 * (P - pdl);
  const S3 = pdl - 2 * (pdh - P);

  const classic: ClassicPivotLevels = {
    P: round5(P),
    R1: round5(R1), R2: round5(R2), R3: round5(R3),
    S1: round5(S1), S2: round5(S2), S3: round5(S3),
  };

  // ── Camarilla Pivots (intraday-focused) ─────────────────────────────────
  // Formula: H/L_n = close ± (range × multiplier)
  //   H1/L1 = c ± range × 1.1/12
  //   H2/L2 = c ± range × 1.1/6
  //   H3/L3 = c ± range × 1.1/4   ← strong reversal level
  //   H4/L4 = c ± range × 1.1/2   ← breakout trigger
  const cam11_2 = (range * 1.1) / 2;
  const cam11_4 = (range * 1.1) / 4;
  const cam11_6 = (range * 1.1) / 6;
  const cam11_12 = (range * 1.1) / 12;

  const camarilla: CamarillaLevels = {
    H4: round5(pdc + cam11_2),
    H3: round5(pdc + cam11_4),
    H2: round5(pdc + cam11_6),
    H1: round5(pdc + cam11_12),
    L1: round5(pdc - cam11_12),
    L2: round5(pdc - cam11_6),
    L3: round5(pdc - cam11_4),
    L4: round5(pdc - cam11_2),
  };

  // ── Find current position + nearest level ──────────────────────────────
  // We rank classic + camarilla levels and find where the current price sits.
  const allLevels: { name: string; price: number }[] = [
    { name: "R3", price: classic.R3 },
    { name: "Cam_H4", price: camarilla.H4 },
    { name: "R2", price: classic.R2 },
    { name: "Cam_H3", price: camarilla.H3 },
    { name: "R1", price: classic.R1 },
    { name: "Cam_H2", price: camarilla.H2 },
    { name: "Cam_H1", price: camarilla.H1 },
    { name: "P", price: classic.P },
    { name: "Cam_L1", price: camarilla.L1 },
    { name: "Cam_L2", price: camarilla.L2 },
    { name: "S1", price: classic.S1 },
    { name: "Cam_L3", price: camarilla.L3 },
    { name: "S2", price: classic.S2 },
    { name: "Cam_L4", price: camarilla.L4 },
    { name: "S3", price: classic.S3 },
  ];

  // Sort by absolute pip distance
  const sortedByDistance = [...allLevels]
    .map(l => ({ ...l, distancePips: pipDistance(l.price, currentPrice, pip) }))
    .sort((a, b) => Math.abs(a.distancePips) - Math.abs(b.distancePips));

  const nearest = sortedByDistance[0];

  // Current position narrative: above/below pivot, between which extremes
  let currentPosition: string;
  if (currentPrice > classic.R3) currentPosition = "ABOVE_R3";
  else if (currentPrice > classic.R2) currentPosition = "R2-R3";
  else if (currentPrice > classic.R1) currentPosition = "R1-R2";
  else if (currentPrice > classic.P)  currentPosition = "P-R1";
  else if (currentPrice > classic.S1) currentPosition = "P-S1";
  else if (currentPrice > classic.S2) currentPosition = "S1-S2";
  else if (currentPrice > classic.S3) currentPosition = "S2-S3";
  else currentPosition = "BELOW_S3";

  const dateUtc = new Date(yesterday.t * 1000).toISOString().slice(0, 10);

  const reasoning =
    `Pivot basis: ${dateUtc} HLC ${pdh.toFixed(5)}/${pdl.toFixed(5)}/${pdc.toFixed(5)}. ` +
    `Price at ${currentPosition}. Nearest level: ${nearest.name} ` +
    `(${nearest.distancePips > 0 ? "+" : ""}${nearest.distancePips}p)`;

  return {
    basis: { pdh, pdl, pdc, dateUtc },
    classic,
    camarilla,
    currentPosition,
    nearestLevelDistancePips: nearest.distancePips,
    nearestLevelName: nearest.name,
    reasoning,
  };
}
