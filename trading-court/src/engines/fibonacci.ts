// ============================================================================
// Fibonacci Engine — v4.2 Phase 1
//
// Computes Fibonacci retracements + extensions from the most recent impulse
// leg identified by marketStructure swings. Reports current price position
// against the levels, with Golden Zone detection (50%-61.8% retracement).
//
// Why this exists for intraday:
//   Every intraday trader watches fib retracements on the last visible
//   impulse. We extract this automatically instead of leaving the user to
//   eyeball a chart.
//
// What this is NOT:
//   - A signal generator on its own (that's the judge's role)
//   - A magic level predictor — we report measured levels only
//   - Cluster analysis with other tools (Phase 2 might add fib confluence)
// ============================================================================

import type { Swing } from "./marketStructure.js";

export type FibLegType = "BULL_LEG" | "BEAR_LEG" | "UNKNOWN";

export interface FibLevel {
  /** Level name e.g. "0.236", "0.5", "0.618", "1.272", "1.618" */
  name: string;
  /** Ratio value (0.236, 0.5, 0.618, 1.272, ...) */
  ratio: number;
  /** Actual price at this level */
  price: number;
  /** Pip distance from current price (signed: positive = above, negative = below) */
  distancePips: number;
  /** Is this a retracement (0-1) or extension (>1)? */
  kind: "RETRACEMENT" | "EXTENSION";
}

export interface FibReport {
  legType: FibLegType;
  legHigh: number | null;
  legLow: number | null;
  legRangePips: number | null;
  current: number | null;
  /** Position 0-1 relative to leg (0 = at start, 1 = at end). Can exceed [0,1]
   *  on extensions. */
  positionRatio: number | null;
  positionLevel: string;
  inGoldenZone: boolean;
  /** Closest 3 levels to current price, sorted by distance ascending */
  nearbyLevels: FibLevel[];
  reasoning: string;
}

const RETRACE_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.786, 0.886];
const EXTENSION_RATIOS = [1.272, 1.382, 1.5, 1.618, 2.0, 2.618, 3.618, 4.236];

function emptyReport(reason: string): FibReport {
  return {
    legType: "UNKNOWN",
    legHigh: null, legLow: null, legRangePips: null,
    current: null, positionRatio: null,
    positionLevel: "UNKNOWN",
    inGoldenZone: false,
    nearbyLevels: [],
    reasoning: reason,
  };
}

/**
 * Identify the most recent impulse leg from swings. The leg is anchored to
 * the last swing pivot and extends backward to the opposite-direction pivot
 * that preceded it.
 *
 * Returns null when we can't find two opposite-direction swings.
 */
function findLastImpulseLeg(swings: Swing[]): {
  type: FibLegType;
  high: number;
  low: number;
  highIdx: number;
  lowIdx: number;
} | null {
  if (swings.length < 2) return null;

  const isHigh = (s: Swing) => s.kind === "HH" || s.kind === "LH" || s.kind === "SH";
  const isLow = (s: Swing) => s.kind === "HL" || s.kind === "LL" || s.kind === "SL";

  // Walk backwards from the last swing
  const last = swings[swings.length - 1];

  if (isHigh(last)) {
    // Last is a high → impulse was UP. Find the preceding low.
    for (let i = swings.length - 2; i >= 0; i--) {
      if (isLow(swings[i])) {
        return {
          type: "BULL_LEG",
          high: last.price,
          low: swings[i].price,
          highIdx: last.index,
          lowIdx: swings[i].index,
        };
      }
    }
  } else if (isLow(last)) {
    // Last is a low → impulse was DOWN.
    for (let i = swings.length - 2; i >= 0; i--) {
      if (isHigh(swings[i])) {
        return {
          type: "BEAR_LEG",
          high: swings[i].price,
          low: last.price,
          highIdx: swings[i].index,
          lowIdx: last.index,
        };
      }
    }
  }

  return null;
}

function pipDistance(a: number, b: number, pip: number): number {
  return Math.round(((a - b) / pip) * 10) / 10;
}

export function computeFibonacci(
  swings: Swing[],
  currentPrice: number,
  pip: number,
): FibReport {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return emptyReport("Current price unavailable");
  }
  if (!swings || swings.length < 2) {
    return emptyReport("Not enough swings to identify an impulse leg");
  }

  const leg = findLastImpulseLeg(swings);
  if (!leg) return emptyReport("No opposite-direction swing pair found");

  const range = leg.high - leg.low;
  if (range <= 0) return emptyReport("Degenerate leg range");

  const isBull = leg.type === "BULL_LEG";

  // For a BULL_LEG, a retracement is a pullback DOWN from the high. The 0%
  // level is at the high, 100% at the low (the start of the impulse).
  // For a BEAR_LEG, 0% is at the low, 100% at the high.
  const anchor0 = isBull ? leg.high : leg.low;
  const anchor1 = isBull ? leg.low : leg.high;
  const direction = isBull ? -1 : +1;  // direction of retracement from anchor0

  // Position of current price relative to the leg
  // For BULL: ratio = (high - price) / range  → 0 at high, 1 at low
  // For BEAR: ratio = (price - low) / range   → 0 at low,  1 at high
  const positionRatio = isBull
    ? (leg.high - currentPrice) / range
    : (currentPrice - leg.low) / range;

  // Build all level prices
  const buildLevel = (ratio: number, kind: "RETRACEMENT" | "EXTENSION"): FibLevel => {
    const price = anchor0 + direction * ratio * range;
    return {
      name: ratio.toFixed(3).replace(/0+$/, "").replace(/\.$/, ""),
      ratio,
      price: Math.round(price * 100000) / 100000,
      distancePips: pipDistance(price, currentPrice, pip),
      kind,
    };
  };

  const retracements = RETRACE_RATIOS.map(r => buildLevel(r, "RETRACEMENT"));
  const extensions = EXTENSION_RATIOS.map(r => buildLevel(r, "EXTENSION"));
  const allLevels = [...retracements, ...extensions];

  // Find the 3 nearest levels (by absolute pip distance)
  const nearbyLevels = [...allLevels]
    .sort((a, b) => Math.abs(a.distancePips) - Math.abs(b.distancePips))
    .slice(0, 3);

  // Identify the "current position level" — between which two retracements
  let positionLevel = "BEYOND_LEG";
  if (positionRatio < 0) {
    positionLevel = "BEYOND_ANCHOR_0";  // past the impulse end
  } else if (positionRatio < 0.236) {
    positionLevel = "0-0.236";
  } else if (positionRatio < 0.382) {
    positionLevel = "0.236-0.382";
  } else if (positionRatio < 0.5) {
    positionLevel = "0.382-0.5";
  } else if (positionRatio < 0.618) {
    positionLevel = "0.5-0.618";
  } else if (positionRatio < 0.786) {
    positionLevel = "0.618-0.786";
  } else if (positionRatio < 0.886) {
    positionLevel = "0.786-0.886";
  } else if (positionRatio <= 1.0) {
    positionLevel = "0.886-1.0";
  } else if (positionRatio < 1.272) {
    positionLevel = "1.0-1.272-EXT";
  } else if (positionRatio < 1.618) {
    positionLevel = "1.272-1.618-EXT";
  } else {
    positionLevel = "BEYOND-1.618-EXT";
  }

  // Golden Zone = 0.5–0.618 retracement (classic ICT/Fibonacci entry zone)
  const inGoldenZone = positionRatio >= 0.5 && positionRatio <= 0.618;

  const reasoning =
    `${leg.type === "BULL_LEG" ? "Bullish" : "Bearish"} leg ` +
    `${leg.low.toFixed(5)}→${leg.high.toFixed(5)} (${pipDistance(leg.high, leg.low, pip)}p), ` +
    `price at ${(positionRatio * 100).toFixed(1)}% ` +
    `${inGoldenZone ? "← GOLDEN ZONE (50-61.8% retracement)" : `(${positionLevel})`}`;

  return {
    legType: leg.type,
    legHigh: leg.high,
    legLow: leg.low,
    legRangePips: pipDistance(leg.high, leg.low, pip),
    current: currentPrice,
    positionRatio: Math.round(positionRatio * 10000) / 10000,
    positionLevel,
    inGoldenZone,
    nearbyLevels,
    reasoning,
  };
}
