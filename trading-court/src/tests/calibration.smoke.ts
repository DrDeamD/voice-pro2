// ============================================================================
// Calibration Smoke Test — v3.9
//
// Verifies the applyCalibration logic without spinning up the full court.
// Covers:
//   1. Returns heuristic when registry is empty.
//   2. Returns calibrated value when bin matches and has enough samples.
//   3. Returns heuristic when bin matches but has <20 samples.
//   4. Returns heuristic when composite is outside the bin schedule.
//   5. m5Bonus path: shifting composite into a different bin produces a
//      different confidence.
// ============================================================================

import { applyCalibration } from "../calibration/applyCalibration.js";
import { buildCalibrationFromRecords } from "../calibration/buildCalibration.js";
import type { BacktestVerdictRecord } from "../backtest/replay.js";
import { MIN_BIN_SAMPLE_SIZE } from "../calibration/types.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

// 1) Empty registry → heuristic.
const emptyResult = applyCalibration("XXXYYY", 50, 50);
assert(emptyResult.source === "heuristic", "empty registry should be heuristic");
assert(emptyResult.confidence === 50, "heuristic should pass-through fallback");
assert(emptyResult.heuristicReason === "no_calibration", "should flag no_calibration");

// 2) Build a synthetic calibration from fake backtest records and confirm
//    the bin lookup math. We craft records so |composite|=30 lands in the
//    25-40 bin with 30 trades, 20 wins, 10 losses → win-rate 0.667.
const synthRecords: BacktestVerdictRecord[] = [];
for (let i = 0; i < 20; i++) {
  synthRecords.push({
    tsUtc: new Date(2026, 0, 1, 12, i).toISOString(),
    verdict: "BUY",
    composite: 30,
    confidence: 30,
    confidenceTier: "VALID",
    direction: "LONG",
    entry: 1.1, stopLoss: 1.099, tp1: 1.102, rr1: 2,
    outcome: "WIN",
    outcomeBars: 50, outcomePips: 20,
    riskReasons: [],
  });
}
for (let i = 0; i < 10; i++) {
  synthRecords.push({
    tsUtc: new Date(2026, 0, 2, 12, i).toISOString(),
    verdict: "BUY",
    composite: 30,
    confidence: 30,
    confidenceTier: "VALID",
    direction: "LONG",
    entry: 1.1, stopLoss: 1.099, tp1: 1.102, rr1: 2,
    outcome: "LOSS",
    outcomeBars: 30, outcomePips: -10,
    riskReasons: [],
  });
}

// Also seed a sparse 40-55 bin (only 5 trades — should NOT calibrate).
for (let i = 0; i < 5; i++) {
  synthRecords.push({
    tsUtc: new Date(2026, 0, 3, 12, i).toISOString(),
    verdict: "BUY",
    composite: 50,
    confidence: 50,
    confidenceTier: "VALID",
    direction: "LONG",
    entry: 1.1, stopLoss: 1.099, tp1: 1.102, rr1: 2,
    outcome: i < 4 ? "WIN" : "LOSS",
    outcomeBars: 30, outcomePips: 20,
    riskReasons: [],
  });
}

const calData = buildCalibrationFromRecords({
  symbol: "TESTPAIR",
  records: synthRecords,
  fromUtc: "2026-01-01",
  toUtc: "2026-01-03",
});

const bin25_40 = calData.bins.find(b => b.loAbs === 25 && b.hiAbs === 40);
assert(bin25_40 != null, "should have 25-40 bin");
assert(bin25_40!.trades === 30, `bin 25-40 should have 30 trades, got ${bin25_40!.trades}`);
assert(bin25_40!.wins === 20, `bin 25-40 should have 20 wins, got ${bin25_40!.wins}`);
assert(bin25_40!.losses === 10, `bin 25-40 should have 10 losses, got ${bin25_40!.losses}`);
assert(Math.abs(bin25_40!.winRate! - 0.667) < 0.001, `bin 25-40 win-rate ~0.667, got ${bin25_40!.winRate}`);

const bin40_55 = calData.bins.find(b => b.loAbs === 40 && b.hiAbs === 55);
assert(bin40_55 != null, "should have 40-55 bin");
assert(bin40_55!.trades === 5, `bin 40-55 should have 5 trades`);

// 3) Inject calibration into registry by mutating the bundled JSON object
//    in memory. (For the smoke test we patch the registry directly.)
import calibrationFile from "../calibration/calibrationData.json" with { type: "json" };
(calibrationFile as any).data = (calibrationFile as any).data ?? {};
(calibrationFile as any).data["TESTPAIR"] = calData;

// Re-import applyCalibration to ensure registry is read fresh.
const { applyCalibration: applyAgain } = await import("../calibration/applyCalibration.js");

// 4) Composite = 30 → 25-40 bin with 30 trades → calibrated, conf=67.
const r1 = applyAgain("TESTPAIR", 30, 30);
assert(r1.source === "calibrated", `composite 30 should be calibrated, got ${r1.source} (${r1.heuristicReason})`);
assert(r1.confidence === 67, `composite 30 calibrated conf should be 67, got ${r1.confidence}`);
assert(r1.bin?.sampleSize === 30, "bin sample size 30");

// 5) Composite = 50 → 40-55 bin with only 5 trades → heuristic (low sample).
const r2 = applyAgain("TESTPAIR", 50, 50);
assert(r2.source === "heuristic", `composite 50 (5 trades < ${MIN_BIN_SAMPLE_SIZE}) should be heuristic, got ${r2.source}`);
assert(r2.heuristicReason === "low_sample", `should flag low_sample, got ${r2.heuristicReason}`);

// 6) Composite = 5 → 0-15 bin with 0 trades → heuristic (low sample).
const r3 = applyAgain("TESTPAIR", 5, 5);
assert(r3.source === "heuristic", "composite 5 should be heuristic");

// 7) m5Bonus simulation: scores at composite 28 → bin 25-40 (calibrated, 67).
//    M5 trigger adds +12 → composite 40 → bin 40-55 (low_sample) → heuristic.
const beforeBonus = applyAgain("TESTPAIR", 28, 28);
const afterBonus  = applyAgain("TESTPAIR", 40, 40);
assert(beforeBonus.source === "calibrated", "before-bonus should be calibrated");
assert(afterBonus.source === "heuristic", "after-bonus (bin moved) should be heuristic for sparse bin");
assert(afterBonus.confidence !== beforeBonus.confidence, "confidence should change when bin changes");

// 8) Symbol case-insensitivity.
const lc = applyAgain("testpair", 30, 30);
assert(lc.source === "calibrated", "symbol lookup should be case-insensitive");

console.log("calibration smoke test PASSED");
console.log(JSON.stringify({
  bins_in_calibration: calData.bins.length,
  trades_total: calData.totalTrades,
  bin_25_40: { trades: bin25_40!.trades, winRate: bin25_40!.winRate },
  bin_40_55: { trades: bin40_55!.trades, status: "should be heuristic in apply" },
  result_at_30: r1,
  result_at_50: r2,
}, null, 2));
