// ============================================================================
// applyCalibration — v3.9
//
// Pure decision-time function. Given a symbol and a composite score, returns
// the empirical confidence (as % win-rate) when a sufficiently-sampled
// calibration bin matches, and falls back to the heuristic |composite|
// otherwise. The CalibrationResult carries the source tag so every verdict
// can document whether its confidence is empirical or heuristic.
// ============================================================================

import { getCalibration } from "./registry.js";
import { MIN_BIN_SAMPLE_SIZE, type CalibrationBin, type CalibrationResult } from "./types.js";

/**
 * @param symbol            instrument symbol (case-insensitive)
 * @param composite         the raw composite score (-100 to +100)
 * @param heuristicFallback the value to return when calibration cannot be
 *                          applied. Typically Math.min(100, |composite|).
 */
export function applyCalibration(
  symbol: string,
  composite: number,
  heuristicFallback: number,
): CalibrationResult {
  const data = getCalibration(symbol);
  if (!data) {
    return {
      source: "heuristic",
      confidence: heuristicFallback,
      heuristicReason: "no_calibration",
    };
  }

  const absComp = Math.abs(composite);

  // Find the matching bin. Bins are [loAbs, hiAbs) — half-open intervals.
  let matched: CalibrationBin | null = null;
  for (const bin of data.bins) {
    if (absComp >= bin.loAbs && absComp < bin.hiAbs) {
      matched = bin;
      break;
    }
  }

  if (!matched) {
    return {
      source: "heuristic",
      confidence: heuristicFallback,
      heuristicReason: "no_match",
    };
  }

  // Reject low-sample bins to avoid acting on statistical noise.
  if (matched.trades < MIN_BIN_SAMPLE_SIZE || matched.winRate == null) {
    return {
      source: "heuristic",
      confidence: heuristicFallback,
      heuristicReason: "low_sample",
    };
  }

  // Convert win-rate (0-1) to confidence (0-100). Round to integer for
  // tier classification stability.
  const confidence = Math.round(matched.winRate * 100);

  return {
    source: "calibrated",
    confidence,
    bin: {
      loAbs: matched.loAbs,
      hiAbs: matched.hiAbs,
      winRate: matched.winRate,
      sampleSize: matched.trades,
    },
  };
}
