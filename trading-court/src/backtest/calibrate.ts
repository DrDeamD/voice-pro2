// ============================================================================
// Backtest Calibration — v3.8
//
// Takes the raw verdict records produced by replay.ts and aggregates them
// into per-bin statistics. Output is the empirical win-rate at each
// composite-score bucket — the data needed to replace the current
// `confidence = |composite|` heuristic with an actual probability.
//
// Output shape is intentionally simple JSON so it can be consumed by:
//   - the existing court.ts scoring (after we wire calibration in P2)
//   - any external dashboard or notebook
// ============================================================================

import type { BacktestVerdictRecord } from "./replay.js";

export interface CompositeBin {
  /** Inclusive lower bound of |composite| range. */
  loAbs: number;
  /** Exclusive upper bound. The last bin uses Infinity. */
  hiAbs: number;
}

export const DEFAULT_BINS: CompositeBin[] = [
  { loAbs: 0,  hiAbs: 15 },   // FLAT — no trade
  { loAbs: 15, hiAbs: 25 },
  { loAbs: 25, hiAbs: 40 },
  { loAbs: 40, hiAbs: 55 },
  { loAbs: 55, hiAbs: 70 },
  { loAbs: 70, hiAbs: 85 },
  { loAbs: 85, hiAbs: 200 },  // open-ended top
];

export interface BinStats {
  bin: CompositeBin;
  count: number;
  trades: number;       // BUY + SELL (excludes WAIT/FLAT)
  wins: number;
  losses: number;
  timeouts: number;
  winRate: number | null;       // wins / (wins + losses)
  netPips: number;
  avgPipsPerTrade: number | null;
  expectancy: number | null;    // avg pips × win-rate confidence
}

export interface CalibrationReport {
  symbol: string;
  totalRecords: number;
  totalTrades: number;
  overall: BinStats;
  byCompositeBin: BinStats[];
  byVerdict: { BUY: BinStats; SELL: BinStats; WAIT: BinStats };
  byConfidenceTier: Record<string, BinStats>;
  notes: string[];
}

function emptyStats(bin: CompositeBin): BinStats {
  return {
    bin,
    count: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    timeouts: 0,
    winRate: null,
    netPips: 0,
    avgPipsPerTrade: null,
    expectancy: null,
  };
}

function addToStats(s: BinStats, r: BacktestVerdictRecord): void {
  s.count += 1;
  if (r.verdict === "BUY" || r.verdict === "SELL") {
    s.trades += 1;
    if (r.outcome === "WIN") s.wins += 1;
    else if (r.outcome === "LOSS") s.losses += 1;
    else if (r.outcome === "TIMEOUT") s.timeouts += 1;
    if (Number.isFinite(r.outcomePips ?? NaN)) s.netPips += r.outcomePips!;
  }
}

function finalizeStats(s: BinStats): void {
  s.netPips = Math.round(s.netPips * 10) / 10;
  const decided = s.wins + s.losses;
  s.winRate = decided > 0 ? Math.round((s.wins / decided) * 1000) / 1000 : null;
  s.avgPipsPerTrade = s.trades > 0 ? Math.round((s.netPips / s.trades) * 10) / 10 : null;
  // Expectancy = avg pips × ratio of decided trades. Useful as a single
  // number for ranking bins.
  s.expectancy = s.trades > 0
    ? Math.round((s.netPips / s.trades) * (s.winRate ?? 0) * 100) / 100
    : null;
}

function findBin(absComp: number, bins: CompositeBin[]): CompositeBin | null {
  for (const b of bins) {
    if (absComp >= b.loAbs && absComp < b.hiAbs) return b;
  }
  return null;
}

export function calibrate(symbol: string, records: BacktestVerdictRecord[], bins: CompositeBin[] = DEFAULT_BINS): CalibrationReport {
  const overall = emptyStats({ loAbs: 0, hiAbs: 200 });
  const byBin = bins.map(b => emptyStats(b));
  const byVerdict = {
    BUY: emptyStats({ loAbs: 0, hiAbs: 200 }),
    SELL: emptyStats({ loAbs: 0, hiAbs: 200 }),
    WAIT: emptyStats({ loAbs: 0, hiAbs: 200 }),
  };
  const byTier: Record<string, BinStats> = {};

  for (const r of records) {
    addToStats(overall, r);
    const bin = findBin(Math.abs(r.composite), bins);
    if (bin) {
      const idx = bins.indexOf(bin);
      addToStats(byBin[idx], r);
    }
    if (r.verdict === "BUY") addToStats(byVerdict.BUY, r);
    else if (r.verdict === "SELL") addToStats(byVerdict.SELL, r);
    else addToStats(byVerdict.WAIT, r);

    const tier = r.confidenceTier || "UNKNOWN";
    if (!byTier[tier]) byTier[tier] = emptyStats({ loAbs: 0, hiAbs: 200 });
    addToStats(byTier[tier], r);
  }

  finalizeStats(overall);
  for (const s of byBin) finalizeStats(s);
  finalizeStats(byVerdict.BUY);
  finalizeStats(byVerdict.SELL);
  finalizeStats(byVerdict.WAIT);
  for (const k of Object.keys(byTier)) finalizeStats(byTier[k]);

  const notes: string[] = [];
  if (overall.trades < 30) {
    notes.push(`Only ${overall.trades} trades in sample — win-rate has high variance. Backtest a longer period for reliable calibration.`);
  }
  notes.push("Backtest uses technical engines only. News/calendar impact is stubbed (Phase 2).");

  return {
    symbol,
    totalRecords: records.length,
    totalTrades: overall.trades,
    overall,
    byCompositeBin: byBin,
    byVerdict,
    byConfidenceTier: byTier,
    notes,
  };
}
