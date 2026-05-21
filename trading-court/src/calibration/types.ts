// ============================================================================
// Calibration Types — v3.9
//
// Defines the persistent data shape for empirical confidence calibration.
//
// The calibration registry maps |composite| bins → win-rate observed in
// historical backtest. At decision time, applyCalibration() looks up the
// bin matching the current composite score and returns the empirical
// win-rate (as a 0-100 confidence value), replacing the v3.7d/v3.8
// heuristic of confidence = |composite| × session weight.
//
// When no calibration exists for a symbol, or the matching bin has too few
// samples to be trusted, the system falls back to the heuristic — fully
// backwards compatible with pre-calibration deployments.
// ============================================================================

/** Single composite-magnitude bin with its observed outcomes. */
export interface CalibrationBin {
  /** Inclusive lower bound on |composite|. */
  loAbs: number;
  /** Exclusive upper bound on |composite|. */
  hiAbs: number;
  /** All decision records that fell in this bin (BUY+SELL+WAIT). */
  count: number;
  /** Decision records that produced an actual trade (BUY or SELL). */
  trades: number;
  wins: number;
  losses: number;
  timeouts: number;
  /** wins / (wins + losses). Ignores timeouts. Null when decided=0. */
  winRate: number | null;
  /** Average pips per trade across this bin (signed). Null when trades=0. */
  avgPipsPerTrade: number | null;
}

/** Full calibration record for one symbol. */
export interface CalibrationData {
  symbol: string;
  /** When this calibration was generated. ISO UTC. */
  generatedUtc: string;
  /** Backtest data range used. */
  fromUtc: string | null;
  toUtc: string | null;
  /** Total decision records (all verdicts) ingested. */
  totalRecords: number;
  /** Total trades (BUY+SELL only). */
  totalTrades: number;
  /** Per-|composite| bin results. */
  bins: CalibrationBin[];
  /** Notes about caveats — e.g. "news engine stubbed in source backtest". */
  notes: string[];
}

/** Result of applying calibration to a single decision. */
export interface CalibrationResult {
  /** "calibrated" when a sufficient-sample bin was matched.
   *  "heuristic"  when no calibration exists, or the matched bin is too
   *               sparse to trust. */
  source: "calibrated" | "heuristic";
  /** Effective confidence value (0-100) after calibration logic. */
  confidence: number;
  /** Audit detail. Only populated when source = "calibrated". */
  bin?: {
    loAbs: number;
    hiAbs: number;
    winRate: number;
    sampleSize: number;
  };
  /** Why the heuristic was used (when applicable). */
  heuristicReason?: "no_calibration" | "low_sample" | "no_match" | "out_of_range";
}

/** Minimum trades a bin must contain before its win-rate is trusted as a
 *  probability. Below this, the bin's value is statistically noisy.
 *  Documented choice; can be tuned via configuration if data volume
 *  permits in the future. */
export const MIN_BIN_SAMPLE_SIZE = 20;
