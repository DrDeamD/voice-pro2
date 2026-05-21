// ============================================================================
// v3.5.6 — Outcome Tracker
//
// Purpose:
//   For every verdict in the log that hasn't yet hit TP or SL or expired,
//   fetch the M5 candles between verdict_ts and now, compute:
//     - max favorable excursion (MFE)
//     - max adverse excursion  (MAE)
//     - exact tp_hit_at / sl_hit_at if either was reached
//     - current PnL in pips
//   Append a record to outcome_log.jsonl.
//
// Design constraints (per agreement):
//   - Sequential fetches with FETCH_DELAY_MS=1500 between calls
//   - Max MAX_OPEN_VERDICTS_PER_RUN=16 verdicts per cron run
//   - Per-verdict failure → outcome_status="FETCH_FAILED", retry next run
//   - Never throw; always continue the batch
//
// Cron schedule: every 4h. Checkpoints recorded: 1h, 4h, 24h after verdict_ts.
// A verdict is "EXPIRED" after 24h if never hit TP or SL.
// ============================================================================
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fetchSeries } from "../fetchers/candles.js";
import { readAllVerdicts } from "./verdictLog.js";
import type { VerdictRecord } from "./verdictLog.js";

// ─── Config ─────────────────────────────────────────────────────────────────
const MAX_OPEN_VERDICTS_PER_RUN = 16;
const FETCH_DELAY_MS = 1500;
const EXPIRY_HOURS = 24;

let outcomePathCache: string | null = null;

function getOutcomePath(): string {
  if (outcomePathCache) return outcomePathCache;
  outcomePathCache = path.resolve(process.cwd(), "data", "outcome_log.jsonl");
  return outcomePathCache;
}

export function setOutcomePath(p: string): void { outcomePathCache = path.resolve(p); }
export function resetOutcomePath(): void { outcomePathCache = null; }

// ─── Outcome record schema ──────────────────────────────────────────────────
export type OutcomeStatus = "OPEN" | "TP" | "SL" | "EXPIRED" | "FETCH_FAILED";

export interface OutcomeRecord {
  verdictId:        string;
  verdict_ts:       string;
  checked_at:       string;
  hours_elapsed:    number;
  checkpoint:       "1h" | "4h" | "24h" | "intermediate";
  price_now:        number | null;
  tp_hit:           boolean;
  sl_hit:           boolean;
  tp_hit_at:        string | null;
  sl_hit_at:        string | null;
  max_favorable:    number | null;
  max_adverse:      number | null;
  current_pnl_pips: number | null;
  outcome_status:   OutcomeStatus;
}

// ─── Append outcome record (same atomicity guarantees as verdict log) ──────
export async function appendOutcome(record: OutcomeRecord): Promise<boolean> {
  const line = JSON.stringify(record) + "\n";
  const filePath = getOutcomePath();
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, line, "utf8");
    return true;
  } catch (err: any) {
    process.stderr.write(`[measurement] outcome log append failed: ${err.message}\n`);
    return false;
  }
}

export async function readAllOutcomes(): Promise<OutcomeRecord[]> {
  const filePath = getOutcomePath();
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out: OutcomeRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as OutcomeRecord); }
    catch { /* skip malformed */ }
  }
  return out;
}

// ─── Determine which verdicts still need tracking ──────────────────────────
/**
 * A verdict needs tracking if:
 *   - It was BUY or SELL (WAIT verdicts have no outcome to track)
 *   - Its most recent outcome (if any) is OPEN or FETCH_FAILED
 *   - Its age is ≤ EXPIRY_HOURS (after which it becomes EXPIRED, no more tracking)
 */
export function selectOpenVerdicts(
  verdicts: VerdictRecord[],
  outcomes: OutcomeRecord[],
  nowMs: number = Date.now()
): VerdictRecord[] {
  // Index latest outcome per verdictId
  const latestByVerdict = new Map<string, OutcomeRecord>();
  for (const o of outcomes) {
    const cur = latestByVerdict.get(o.verdictId);
    if (!cur || Date.parse(o.checked_at) > Date.parse(cur.checked_at)) {
      latestByVerdict.set(o.verdictId, o);
    }
  }

  const open: VerdictRecord[] = [];
  for (const v of verdicts) {
    if (v.verdict !== "BUY" && v.verdict !== "SELL") continue;
    if (!v.tradePlan) continue;

    const ageH = (nowMs - Date.parse(v.ts)) / 3600000;
    if (ageH > EXPIRY_HOURS) {
      // Already past expiry; only track once if no outcome yet to mark EXPIRED
      const last = latestByVerdict.get(v.verdictId);
      if (!last) open.push(v);  // never tracked → mark expired in this run
      continue;
    }

    const last = latestByVerdict.get(v.verdictId);
    if (!last) { open.push(v); continue; }                  // never checked
    if (last.outcome_status === "TP")            continue;   // closed: hit TP
    if (last.outcome_status === "SL")            continue;   // closed: hit SL
    if (last.outcome_status === "EXPIRED")       continue;   // closed: timed out
    open.push(v);  // OPEN or FETCH_FAILED → re-check
  }
  return open;
}

// ─── Compute MFE/MAE/TP/SL from M5 candles ─────────────────────────────────
/**
 * Given a verdict and an array of M5 candles (any covering the verdict_ts→now
 * range), compute the outcome.
 *
 * Pure function — no I/O. Tested directly with fixture candles.
 */
export interface M5Candle {
  ts: number;     // unix millis
  open:  number;
  high:  number;
  low:   number;
  close: number;
}

export function computeOutcome(
  verdict: VerdictRecord,
  candles: M5Candle[],
  nowMs: number,
  pipSize: number = 0.0001  // FX default; XAUUSD/JPY callers pass their own
): Omit<OutcomeRecord, "verdictId" | "verdict_ts" | "checked_at" | "checkpoint"> {
  const plan = verdict.tradePlan!;
  const verdictMs = Date.parse(verdict.ts);
  const ageHours = (nowMs - verdictMs) / 3600000;
  const isLong = verdict.verdict === "BUY";

  // Filter candles that fall within [verdict_ts, now]
  const relevant = candles.filter(c => c.ts >= verdictMs && c.ts <= nowMs);

  if (relevant.length === 0) {
    return {
      hours_elapsed: round2(ageHours),
      price_now: null,
      tp_hit: false, sl_hit: false,
      tp_hit_at: null, sl_hit_at: null,
      max_favorable: null, max_adverse: null,
      current_pnl_pips: null,
      outcome_status: "FETCH_FAILED",
    };
  }

  // Walk candles in time order; track MFE/MAE and first TP/SL touch
  let mfe = isLong ? -Infinity : +Infinity;  // most favourable price reached
  let mae = isLong ? +Infinity : -Infinity;  // most adverse price reached
  let tpHitAt: string | null = null;
  let slHitAt: string | null = null;

  for (const c of relevant) {
    if (isLong) {
      if (c.high > mfe) mfe = c.high;
      if (c.low  < mae) mae = c.low;
      // TP hit if high reaches/exceeds tp; SL hit if low reaches/breaks sl
      if (!tpHitAt && c.high >= plan.tp) tpHitAt = new Date(c.ts).toISOString();
      if (!slHitAt && c.low  <= plan.sl) slHitAt = new Date(c.ts).toISOString();
    } else {
      if (c.low  < mfe) mfe = c.low;        // for SHORT, "favourable" = lower
      if (c.high > mae) mae = c.high;
      if (!tpHitAt && c.low  <= plan.tp) tpHitAt = new Date(c.ts).toISOString();
      if (!slHitAt && c.high >= plan.sl) slHitAt = new Date(c.ts).toISOString();
    }
  }

  const last = relevant[relevant.length - 1];
  const priceNow = last.close;
  const pnlPips = isLong
    ? (priceNow - plan.entry) / pipSize
    : (plan.entry - priceNow) / pipSize;

  // Determine outcome_status
  let status: OutcomeStatus;
  if (tpHitAt && slHitAt) {
    // Both touched in same window — earlier one wins
    status = Date.parse(tpHitAt) <= Date.parse(slHitAt) ? "TP" : "SL";
  } else if (tpHitAt) {
    status = "TP";
  } else if (slHitAt) {
    status = "SL";
  } else if (ageHours >= EXPIRY_HOURS) {
    status = "EXPIRED";
  } else {
    status = "OPEN";
  }

  return {
    hours_elapsed: round2(ageHours),
    price_now: priceNow,
    tp_hit: !!tpHitAt,
    sl_hit: !!slHitAt,
    tp_hit_at: tpHitAt,
    sl_hit_at: slHitAt,
    max_favorable: mfe === -Infinity || mfe === +Infinity ? null : mfe,
    max_adverse:   mae === -Infinity || mae === +Infinity ? null : mae,
    current_pnl_pips: round2(pnlPips),
    outcome_status: status,
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

// ─── Pip size per symbol (JPY pairs and XAUUSD differ from majors) ─────────
function pipSizeFor(symbol: string): number {
  if (symbol.endsWith("JPY")) return 0.01;
  if (symbol === "XAUUSD")    return 0.10;
  return 0.0001;
}

// ─── Determine checkpoint label ─────────────────────────────────────────────
function checkpointLabel(hoursElapsed: number): "1h" | "4h" | "24h" | "intermediate" {
  if (hoursElapsed >= 23 && hoursElapsed <= 25) return "24h";
  if (hoursElapsed >=  3.5 && hoursElapsed <=  4.5) return "4h";
  if (hoursElapsed >=  0.75 && hoursElapsed <=  1.25) return "1h";
  return "intermediate";
}

// ─── Main cron entry point ──────────────────────────────────────────────────
/**
 * Run one tracking pass. Designed to be called every 4h via cron.
 *
 * Returns a summary of what happened so cron-runner can log.
 */
export interface TrackerRunSummary {
  checked:        number;
  closed:         number;
  failed:         number;
  expired:        number;
  skippedOverCap: number;
}

export async function runOutcomeTracker(
  candleFetcher: (symbol: string) => Promise<M5Candle[]> = defaultCandleFetcher,
  nowMs: number = Date.now(),
): Promise<TrackerRunSummary> {
  const verdicts = await readAllVerdicts();
  const outcomes = await readAllOutcomes();
  const open = selectOpenVerdicts(verdicts, outcomes, nowMs);

  const summary: TrackerRunSummary = {
    checked: 0, closed: 0, failed: 0, expired: 0, skippedOverCap: 0,
  };

  if (open.length > MAX_OPEN_VERDICTS_PER_RUN) {
    summary.skippedOverCap = open.length - MAX_OPEN_VERDICTS_PER_RUN;
  }
  const batch = open.slice(0, MAX_OPEN_VERDICTS_PER_RUN);

  for (let i = 0; i < batch.length; i++) {
    const v = batch[i];
    summary.checked++;
    let candles: M5Candle[] = [];
    try {
      candles = await candleFetcher(v.pair);
    } catch (err: any) {
      process.stderr.write(`[tracker] fetch failed for ${v.pair}: ${err.message}\n`);
    }
    const computed = computeOutcome(v, candles, nowMs, pipSizeFor(v.pair));
    const record: OutcomeRecord = {
      verdictId:    v.verdictId,
      verdict_ts:   v.ts,
      checked_at:   new Date(nowMs).toISOString(),
      checkpoint:   checkpointLabel(computed.hours_elapsed),
      ...computed,
    };
    await appendOutcome(record);

    if (record.outcome_status === "TP" || record.outcome_status === "SL") summary.closed++;
    else if (record.outcome_status === "EXPIRED") summary.expired++;
    else if (record.outcome_status === "FETCH_FAILED") summary.failed++;

    // Sequential delay (rate-limit respect); skip after last
    if (i < batch.length - 1) {
      await new Promise(res => setTimeout(res, FETCH_DELAY_MS));
    }
  }

  return summary;
}

// ─── Default candle fetcher: uses our existing fetchers/candles.ts ─────────
async function defaultCandleFetcher(symbol: string): Promise<M5Candle[]> {
  const series = await fetchSeries(symbol, "5m");
  if (!series.available || series.candles.length === 0) return [];
  return series.candles.map(c => ({
    ts:    c.t,
    open:  c.o,
    high:  c.h,
    low:   c.l,
    close: c.c,
  }));
}
