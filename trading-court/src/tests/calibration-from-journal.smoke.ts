// ============================================================================
// Calibration-from-Journal Smoke Test — v3.10
//
// Verifies the bridge that joins verdict_log.jsonl + outcome_log.jsonl and
// produces BacktestVerdictRecord[] consumable by buildCalibrationFromRecords.
//
// Strategy: write controlled fixture journal files into a temp dir, point
// the verdictLog/outcomeTracker modules at them via setLogPath/setOutcomePath,
// then call buildRecordsFromJournal and assert on the result shape.
// ============================================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  appendVerdict, setLogPath, resetLogPath,
  type VerdictRecord,
} from "../measurement/verdictLog.js";
import {
  appendOutcome, setOutcomePath, resetOutcomePath,
  type OutcomeRecord,
} from "../measurement/outcomeTracker.js";
import { buildRecordsFromJournal } from "../calibration/fromJournal.js";
import { buildCalibrationFromRecords } from "../calibration/buildCalibration.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

// ─── Setup temp dir ─────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "v310-cal-journal-"));
const verdictPath = path.join(tmp, "verdict_log.jsonl");
const outcomePath = path.join(tmp, "outcome_log.jsonl");
setLogPath(verdictPath);
setOutcomePath(outcomePath);

// ─── Fixture: 200 EURUSD verdicts + matching outcomes ──────────────────────
// Distribution:
//   bin 25-40 (composite=30): 100 BUY trades, 60% win-rate (mapped to TP/SL)
//   bin 40-55 (composite=-48): 100 SELL trades, 75% win-rate
// Plus:
//   10 WAIT verdicts at composite=10 (bin 0-15) — should appear in records
//   10 BUY verdicts at composite=50 still OPEN — should be skipped
//   5 BUY verdicts at composite=70 with FETCH_FAILED outcome — skipped

function nowSec(offset: number): string {
  return new Date(Date.now() + offset * 1000).toISOString();
}

let verdictCounter = 0;
async function writeVerdict(symbol: string, composite: number, verdict: "BUY" | "SELL" | "WAIT"): Promise<VerdictRecord> {
  verdictCounter += 1;
  const tsMillis = Date.now() + verdictCounter; // unique
  const ts = new Date(tsMillis).toISOString();
  const tier = Math.abs(composite) >= 72 ? "STRONG" : Math.abs(composite) >= 60 ? "VALID" : Math.abs(composite) >= 50 ? "WEAK" : "REJECT";
  const rec: VerdictRecord = {
    ts,
    version: "3.10.0",
    pair: symbol,
    verdict,
    confidence: Math.abs(composite),
    composite,
    components: {
      marketStructure: 0, mtfAlignment: 0, momentum: 0,
      vwap: 0, priceAction: 0, regime: "TREND_UP",
      correlation: 0, newsScore: 0,
    },
    tradePlan: verdict === "WAIT" ? null : {
      entry: 1.10, sl: 1.099, tp: 1.103, rr: 3,
    },
    priceAtVerdict: 1.10,
    tier,
    verdictId: `${symbol}-${tsMillis}-${verdictCounter}`,
    session: "NY",
    newsContext: { breakingActive: false, breakingScore: 0, msidActive: false },
    calendarContext: { blockedBy: null },
  };
  await appendVerdict(rec);
  return rec;
}

async function writeOutcome(verdictId: string, status: "TP" | "SL" | "EXPIRED" | "OPEN" | "FETCH_FAILED", pips: number | null = null): Promise<void> {
  const rec: OutcomeRecord = {
    verdictId,
    verdict_ts: nowSec(-3600),
    checked_at: nowSec(0),
    hours_elapsed: 1,
    checkpoint: "1h",
    price_now: 1.103,
    tp_hit: status === "TP",
    sl_hit: status === "SL",
    tp_hit_at: status === "TP" ? nowSec(-1800) : null,
    sl_hit_at: status === "SL" ? nowSec(-1800) : null,
    max_favorable: status === "TP" ? 30 : 5,
    max_adverse: status === "SL" ? -10 : -2,
    current_pnl_pips: pips,
    outcome_status: status,
  };
  await appendOutcome(rec);
}

// 100 BUY @ composite 30, 60% TP : 40% SL
let winsBin1 = 0, lossesBin1 = 0;
for (let i = 0; i < 100; i++) {
  const v = await writeVerdict("EURUSD", 30, "BUY");
  if (i < 60) {
    await writeOutcome(v.verdictId, "TP", 30);
    winsBin1++;
  } else {
    await writeOutcome(v.verdictId, "SL", -10);
    lossesBin1++;
  }
}

// 100 SELL @ composite -48 (|comp|=48), 75% TP : 25% SL
let winsBin2 = 0, lossesBin2 = 0;
for (let i = 0; i < 100; i++) {
  const v = await writeVerdict("EURUSD", -48, "SELL");
  if (i < 75) {
    await writeOutcome(v.verdictId, "TP", 30);
    winsBin2++;
  } else {
    await writeOutcome(v.verdictId, "SL", -10);
    lossesBin2++;
  }
}

// 10 WAIT verdicts (no plan, no outcome)
for (let i = 0; i < 10; i++) {
  await writeVerdict("EURUSD", 10, "WAIT");
}

// 10 BUY @ composite 50 still OPEN → should skip
for (let i = 0; i < 10; i++) {
  const v = await writeVerdict("EURUSD", 50, "BUY");
  await writeOutcome(v.verdictId, "OPEN");
}

// 5 BUY @ composite 70 FETCH_FAILED → should skip
for (let i = 0; i < 5; i++) {
  const v = await writeVerdict("EURUSD", 70, "BUY");
  await writeOutcome(v.verdictId, "FETCH_FAILED");
}

// 3 verdicts for OTHER symbol — should not appear in EURUSD filter
for (let i = 0; i < 3; i++) {
  const v = await writeVerdict("GBPUSD", 30, "BUY");
  await writeOutcome(v.verdictId, "TP", 25);
}

// ─── Run the bridge ─────────────────────────────────────────────────────────
const result = await buildRecordsFromJournal({ symbol: "EURUSD" });

console.log(JSON.stringify({
  totalVerdicts: result.totalVerdicts,
  totalOutcomes: result.totalOutcomes,
  matchedVerdicts: result.matchedVerdicts,
  recordCount: result.records.length,
  skipped: result.skipped,
  symbols: result.symbols,
}, null, 2));

// ─── Assertions ─────────────────────────────────────────────────────────────

// Total counts
assert(result.totalVerdicts === 228, `expected 228 total verdicts (200+10+10+5+3), got ${result.totalVerdicts}`);
assert(result.totalOutcomes === 218, `expected 218 outcomes, got ${result.totalOutcomes}`);

// Symbol filter
assert(result.matchedVerdicts === 225, `EURUSD filter should match 225 verdicts (228-3 GBPUSD), got ${result.matchedVerdicts}`);

// Records: 100 + 100 + 10 (WAIT) = 210 ready records
// Skipped: 10 OPEN + 5 FETCH_FAILED = 15
assert(result.records.length === 210, `expected 210 usable records, got ${result.records.length}`);
assert((result.skipped["still_open"] ?? 0) === 10, `expected 10 still_open, got ${result.skipped["still_open"]}`);
assert((result.skipped["fetch_failed"] ?? 0) === 5, `expected 5 fetch_failed, got ${result.skipped["fetch_failed"]}`);

// Run through buildCalibrationFromRecords and check the bins
const calData = buildCalibrationFromRecords({
  symbol: "EURUSD",
  records: result.records,
  fromUtc: null, toUtc: null,
});

const bin25_40 = calData.bins.find(b => b.loAbs === 25 && b.hiAbs === 40)!;
const bin40_55 = calData.bins.find(b => b.loAbs === 40 && b.hiAbs === 55)!;
const bin0_15  = calData.bins.find(b => b.loAbs === 0  && b.hiAbs === 15)!;

assert(bin25_40.trades === 100, `bin 25-40 should have 100 trades, got ${bin25_40.trades}`);
assert(bin25_40.wins === winsBin1, `bin 25-40 wins should be ${winsBin1}, got ${bin25_40.wins}`);
assert(bin25_40.losses === lossesBin1, `bin 25-40 losses should be ${lossesBin1}, got ${bin25_40.losses}`);
assert(Math.abs(bin25_40.winRate! - 0.60) < 0.001, `bin 25-40 win-rate should be 0.60, got ${bin25_40.winRate}`);

assert(bin40_55.trades === 100, `bin 40-55 should have 100 trades, got ${bin40_55.trades}`);
assert(bin40_55.wins === winsBin2, `bin 40-55 wins should be ${winsBin2}, got ${bin40_55.wins}`);
assert(Math.abs(bin40_55.winRate! - 0.75) < 0.001, `bin 40-55 win-rate should be 0.75, got ${bin40_55.winRate}`);

// WAIT verdicts went to bin 0-15 (composite 10)
assert(bin0_15.count === 10, `bin 0-15 should have 10 WAIT records, got ${bin0_15.count}`);
assert(bin0_15.trades === 0, `bin 0-15 should have 0 trades (all WAIT), got ${bin0_15.trades}`);

// Cleanup
resetLogPath();
resetOutcomePath();
fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log("calibration-from-journal smoke test PASSED");
console.log(`  EURUSD bin 25-40: ${bin25_40.trades} trades, ${(bin25_40.winRate! * 100).toFixed(1)}% win-rate`);
console.log(`  EURUSD bin 40-55: ${bin40_55.trades} trades, ${(bin40_55.winRate! * 100).toFixed(1)}% win-rate`);
console.log(`  EURUSD bin 0-15:  ${bin0_15.count} WAIT records (no trades)`);
console.log(`  Skipped: ${JSON.stringify(result.skipped)}`);
