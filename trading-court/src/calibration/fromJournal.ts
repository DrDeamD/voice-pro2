// ============================================================================
// Journal → Calibration Bridge — v3.10
//
// Reads the live verdict_log.jsonl + outcome_log.jsonl produced by the
// existing measurement system (v3.5.6+) and converts the joined records
// into the same BacktestVerdictRecord shape that buildCalibrationFromRecords
// already understands. This unifies offline (HistData backtest) and online
// (live journal) calibration paths through a single ingestion function.
//
// Design notes:
//   - A verdict is "ready" for calibration when its latest outcome is
//     terminal: TP, SL, or EXPIRED. OPEN verdicts are excluded — we don't
//     yet know the outcome. FETCH_FAILED records are also excluded because
//     they have no usable price reference.
//   - When a verdict has multiple outcome records (1h, 4h, 24h checkpoints),
//     we use the latest record. The tracker writes terminal records once;
//     pre-terminal OPEN/FETCH_FAILED records get superseded.
//   - Outcome status mapping:
//        TP       → WIN
//        SL       → LOSS
//        EXPIRED  → TIMEOUT
//   - Pip count: drawn from `current_pnl_pips` of the latest outcome record.
//     Already pip-scaled by the tracker.
//   - For WAIT verdicts (no plan), we still emit a record with outcome=NONE
//     so the calibrator can count the bin density. WAIT records contribute
//     to `count` but not to `wins/losses`.
// ============================================================================

import {
  readAllVerdicts,
  type VerdictRecord,
} from "../measurement/verdictLog.js";
import {
  readAllOutcomes,
  type OutcomeRecord,
  type OutcomeStatus,
} from "../measurement/outcomeTracker.js";
import type { BacktestVerdictRecord } from "../backtest/replay.js";

export interface JournalQueryOptions {
  /** Filter to a single symbol (case-insensitive). Undefined = all. */
  symbol?: string;
  /** ISO timestamp. Verdicts strictly before this are dropped. */
  fromUtc?: string;
  /** ISO timestamp. Verdicts at or after this are dropped. */
  toUtc?: string;
}

export interface JournalIngestionResult {
  /** BacktestVerdictRecord-shaped entries ready for buildCalibrationFromRecords. */
  records: BacktestVerdictRecord[];
  /** Total verdicts read from journal (before filter). */
  totalVerdicts: number;
  /** Total outcomes read from journal. */
  totalOutcomes: number;
  /** Verdicts kept after symbol/date filter. */
  matchedVerdicts: number;
  /** Per-reason skip counts for honest reporting. */
  skipped: Record<string, number>;
  /** Distinct symbols in the produced records. */
  symbols: string[];
}

function pickLatestOutcomePerVerdict(outcomes: OutcomeRecord[]): Map<string, OutcomeRecord> {
  const map = new Map<string, OutcomeRecord>();
  for (const o of outcomes) {
    const cur = map.get(o.verdictId);
    if (!cur) {
      map.set(o.verdictId, o);
      continue;
    }
    // Prefer terminal over pre-terminal. Among same kind, prefer later checked_at.
    const curIsTerminal = isTerminal(cur.outcome_status);
    const newIsTerminal = isTerminal(o.outcome_status);
    if (newIsTerminal && !curIsTerminal) {
      map.set(o.verdictId, o);
    } else if (newIsTerminal === curIsTerminal) {
      const curT = Date.parse(cur.checked_at) || 0;
      const newT = Date.parse(o.checked_at) || 0;
      if (newT > curT) map.set(o.verdictId, o);
    }
  }
  return map;
}

function isTerminal(s: OutcomeStatus): boolean {
  return s === "TP" || s === "SL" || s === "EXPIRED";
}

function mapOutcome(s: OutcomeStatus): "WIN" | "LOSS" | "TIMEOUT" | null {
  if (s === "TP") return "WIN";
  if (s === "SL") return "LOSS";
  if (s === "EXPIRED") return "TIMEOUT";
  return null; // OPEN / FETCH_FAILED — not ready
}

function verdictToRecord(
  v: VerdictRecord,
  o: OutcomeRecord | null,
): { record: BacktestVerdictRecord | null; skipReason: string | null } {
  const isTrade = v.verdict === "BUY" || v.verdict === "SELL";

  // WAIT records don't have plans/outcomes but still contribute to bin density.
  if (!isTrade) {
    return {
      record: {
        tsUtc: v.ts,
        verdict: v.verdict,
        composite: v.composite,
        confidence: v.confidence,
        confidenceTier: v.tier,
        direction: v.composite > 0 ? "LONG" : v.composite < 0 ? "SHORT" : "FLAT",
        entry: null,
        stopLoss: null,
        tp1: null,
        rr1: null,
        outcome: "NONE",
        outcomeBars: null,
        outcomePips: null,
        riskReasons: [],
      },
      skipReason: null,
    };
  }

  // BUY/SELL — need a terminal outcome to be useful.
  if (!o) return { record: null, skipReason: "no_outcome" };
  const mapped = mapOutcome(o.outcome_status);
  if (!mapped) {
    return { record: null, skipReason: o.outcome_status === "OPEN" ? "still_open" : "fetch_failed" };
  }

  // Trade plan must have the SL/TP we logged at decision time.
  if (!v.tradePlan) {
    return { record: null, skipReason: "no_plan" };
  }

  return {
    record: {
      tsUtc: v.ts,
      verdict: v.verdict,
      composite: v.composite,
      confidence: v.confidence,
      confidenceTier: v.tier,
      direction: v.verdict === "BUY" ? "LONG" : "SHORT",
      entry: v.tradePlan.entry,
      stopLoss: v.tradePlan.sl,
      tp1: v.tradePlan.tp,
      rr1: v.tradePlan.rr,
      outcome: mapped,
      // We don't know exact bar count from the tracker — leave null.
      // Calibration math doesn't require it.
      outcomeBars: null,
      outcomePips: typeof o.current_pnl_pips === "number" ? o.current_pnl_pips : null,
      riskReasons: [],
    },
    skipReason: null,
  };
}

/** Main ingestion entry point. Reads journal+outcomes, joins by verdictId,
 *  filters per options, returns records suitable for the calibration builder. */
export async function buildRecordsFromJournal(
  opts: JournalQueryOptions = {},
): Promise<JournalIngestionResult> {
  const [verdicts, outcomes] = await Promise.all([
    readAllVerdicts(),
    readAllOutcomes(),
  ]);

  const totalVerdicts = verdicts.length;
  const totalOutcomes = outcomes.length;

  const symbolFilter = opts.symbol?.toUpperCase();
  const fromMs = opts.fromUtc ? Date.parse(opts.fromUtc) : Number.NEGATIVE_INFINITY;
  const toMs = opts.toUtc ? Date.parse(opts.toUtc) : Number.POSITIVE_INFINITY;

  const filtered = verdicts.filter(v => {
    if (symbolFilter && v.pair.toUpperCase() !== symbolFilter) return false;
    const t = Date.parse(v.ts);
    if (!Number.isFinite(t)) return false;
    return t >= fromMs && t < toMs;
  });

  const latestOutcomes = pickLatestOutcomePerVerdict(outcomes);

  const skipped: Record<string, number> = {};
  const records: BacktestVerdictRecord[] = [];
  const symbols = new Set<string>();

  for (const v of filtered) {
    const o = latestOutcomes.get(v.verdictId) ?? null;
    const { record, skipReason } = verdictToRecord(v, o);
    if (record) {
      records.push(record);
      symbols.add(v.pair.toUpperCase());
    } else if (skipReason) {
      skipped[skipReason] = (skipped[skipReason] ?? 0) + 1;
    }
  }

  return {
    records,
    totalVerdicts,
    totalOutcomes,
    matchedVerdicts: filtered.length,
    skipped,
    symbols: [...symbols].sort(),
  };
}

/** Per-symbol breakdown for the CLI to handle multi-symbol journals. */
export async function buildRecordsBySymbol(
  opts: Omit<JournalQueryOptions, "symbol"> = {},
): Promise<Record<string, BacktestVerdictRecord[]>> {
  const all = await buildRecordsFromJournal(opts);
  const out: Record<string, BacktestVerdictRecord[]> = {};
  // We have records but they don't carry symbol on the BacktestVerdictRecord
  // type. Re-read raw verdicts to map records back to their pair. This is
  // strictly cosmetic — we want one CalibrationData per symbol.
  // Faster path: re-run the ingestion per-symbol since journal reads are
  // cached in memory by the OS page cache.
  for (const sym of all.symbols) {
    const r = await buildRecordsFromJournal({ ...opts, symbol: sym });
    out[sym] = r.records;
  }
  return out;
}
