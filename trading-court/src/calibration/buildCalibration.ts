// ============================================================================
// buildCalibration — v3.9
//
// Converts the output of `npm run backtest` (the JSON dump of
// BacktestVerdictRecord[]) into a CalibrationData record suitable for
// inclusion in calibrationData.json.
//
// The bin schedule matches DEFAULT_BINS in src/backtest/calibrate.ts so the
// two artefacts are mutually consistent and easy to audit side-by-side.
// ============================================================================

import type { BacktestVerdictRecord } from "../backtest/replay.js";
import type { CalibrationData, CalibrationBin } from "./types.js";

const BIN_SCHEDULE = [
  { loAbs: 0,  hiAbs: 15  },
  { loAbs: 15, hiAbs: 25  },
  { loAbs: 25, hiAbs: 40  },
  { loAbs: 40, hiAbs: 55  },
  { loAbs: 55, hiAbs: 70  },
  { loAbs: 70, hiAbs: 85  },
  { loAbs: 85, hiAbs: 200 },
];

interface BinAccumulator {
  loAbs: number;
  hiAbs: number;
  count: number;
  trades: number;
  wins: number;
  losses: number;
  timeouts: number;
  pipsSum: number;
}

export interface BuildOptions {
  symbol: string;
  records: BacktestVerdictRecord[];
  fromUtc: string | null;
  toUtc: string | null;
  /** Extra notes describing how the source backtest was generated. */
  notes?: string[];
}

export function buildCalibrationFromRecords(opts: BuildOptions): CalibrationData {
  const { symbol, records, fromUtc, toUtc, notes = [] } = opts;
  const sym = symbol.toUpperCase();

  const accs: BinAccumulator[] = BIN_SCHEDULE.map(b => ({
    ...b, count: 0, trades: 0, wins: 0, losses: 0, timeouts: 0, pipsSum: 0,
  }));

  let totalTrades = 0;
  for (const r of records) {
    const absComp = Math.abs(r.composite);
    const bin = accs.find(b => absComp >= b.loAbs && absComp < b.hiAbs);
    if (!bin) continue;

    bin.count += 1;
    if (r.verdict === "BUY" || r.verdict === "SELL") {
      bin.trades += 1;
      totalTrades += 1;
      if (r.outcome === "WIN") bin.wins += 1;
      else if (r.outcome === "LOSS") bin.losses += 1;
      else if (r.outcome === "TIMEOUT") bin.timeouts += 1;
      if (typeof r.outcomePips === "number" && Number.isFinite(r.outcomePips)) {
        bin.pipsSum += r.outcomePips;
      }
    }
  }

  const bins: CalibrationBin[] = accs.map(a => {
    const decided = a.wins + a.losses;
    const winRate = decided > 0 ? Math.round((a.wins / decided) * 1000) / 1000 : null;
    const avgPips = a.trades > 0 ? Math.round((a.pipsSum / a.trades) * 10) / 10 : null;
    return {
      loAbs: a.loAbs,
      hiAbs: a.hiAbs,
      count: a.count,
      trades: a.trades,
      wins: a.wins,
      losses: a.losses,
      timeouts: a.timeouts,
      winRate,
      avgPipsPerTrade: avgPips,
    };
  });

  const finalNotes = [...notes];
  if (totalTrades < 200) {
    finalNotes.push(
      `Total sample size ${totalTrades} is below 200 — calibration will only ` +
      `take effect for bins with ≥20 trades. Other bins continue to use the ` +
      `heuristic. Run a longer backtest to populate sparse bins.`,
    );
  }

  return {
    symbol: sym,
    generatedUtc: new Date().toISOString(),
    fromUtc,
    toUtc,
    totalRecords: records.length,
    totalTrades,
    bins,
    notes: finalNotes,
  };
}
