// ============================================================================
// v3.5.6 — Performance Aggregator
//
// Purpose:
//   Compute hit-rate statistics from verdict_log + outcome_log. Powers
//   /api/performance.
//
// Caching:
//   5-minute TTL (per agreement). Forced bypass via ?force=1.
//   Cache lives in memory only; survives until server restart.
//
// Definitions:
//   - "Closed" verdict = latest outcome has status TP, SL, or EXPIRED
//   - "Win"            = outcome_status === "TP"
//   - "Loss"           = outcome_status === "SL"
//   - "Expired"        = outcome_status === "EXPIRED" (counted as neither)
//   - Win-rate         = wins / (wins + losses)        — excludes expired
//   - 4h-hit-rate      = wins where the TP was hit within 4h of verdict
// ============================================================================
import { readAllVerdicts } from "./verdictLog.js";
import { readAllOutcomes } from "./outcomeTracker.js";
import type { VerdictRecord } from "./verdictLog.js";
import type { OutcomeRecord } from "./outcomeTracker.js";

// ─── Cache ──────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000;   // 5 minutes (per agreement)
let cache: { data: PerformanceReport; expires: number } | null = null;

// ─── Report shape ───────────────────────────────────────────────────────────
export interface BucketStats {
  total:    number;     // verdicts in bucket
  closed:   number;     // verdicts that closed (TP/SL/EXPIRED)
  wins:     number;
  losses:   number;
  expired:  number;
  winRate:  number;     // wins / (wins + losses), null-safe → 0
}

export interface PerformanceReport {
  generatedAt:        string;
  cacheTtlSec:        number;
  totalVerdicts:      number;
  buyCount:           number;
  sellCount:          number;
  waitCount:          number;
  trackedActionables: number;     // BUY+SELL with at least one outcome record
  closed:             number;
  wins:               number;
  losses:             number;
  expired:            number;
  fetchFailed:        number;
  winRate:            number;     // overall, 0–1

  byPair:             Record<string, BucketStats>;
  byConfidenceBand:   Record<string, BucketStats>;  // "60-70" | "70-80" | "80+" | "<60"
  bySession:          Record<string, BucketStats>;  // ASIA | LDN | NY | OFF

  avgPlannedRR:       number | null;
  avgRealizedPipsWin: number | null;
  avgRealizedPipsLoss:number | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function emptyBucket(): BucketStats {
  return { total: 0, closed: 0, wins: 0, losses: 0, expired: 0, winRate: 0 };
}

function finalizeBucket(b: BucketStats): BucketStats {
  const decided = b.wins + b.losses;
  b.winRate = decided > 0 ? b.wins / decided : 0;
  return b;
}

function confidenceBand(c: number): string {
  if (c >= 80) return "80+";
  if (c >= 70) return "70-80";
  if (c >= 60) return "60-70";
  return "<60";
}

/** Index latest outcome per verdictId. */
function latestOutcomes(outcomes: OutcomeRecord[]): Map<string, OutcomeRecord> {
  const m = new Map<string, OutcomeRecord>();
  for (const o of outcomes) {
    const cur = m.get(o.verdictId);
    if (!cur || Date.parse(o.checked_at) > Date.parse(cur.checked_at)) {
      m.set(o.verdictId, o);
    }
  }
  return m;
}

// ─── Aggregation core ───────────────────────────────────────────────────────
export function aggregate(
  verdicts: VerdictRecord[],
  outcomes: OutcomeRecord[],
): PerformanceReport {
  const latest = latestOutcomes(outcomes);

  const report: PerformanceReport = {
    generatedAt: new Date().toISOString(),
    cacheTtlSec: CACHE_TTL_MS / 1000,
    totalVerdicts: verdicts.length,
    buyCount: 0, sellCount: 0, waitCount: 0,
    trackedActionables: 0,
    closed: 0, wins: 0, losses: 0, expired: 0, fetchFailed: 0,
    winRate: 0,
    byPair: {}, byConfidenceBand: {}, bySession: {},
    avgPlannedRR: null,
    avgRealizedPipsWin: null,
    avgRealizedPipsLoss: null,
  };

  let plannedRRSum = 0, plannedRRCount = 0;
  let winPipsSum   = 0, winPipsCount   = 0;
  let lossPipsSum  = 0, lossPipsCount  = 0;

  for (const v of verdicts) {
    if (v.verdict === "BUY")  report.buyCount++;
    if (v.verdict === "SELL") report.sellCount++;
    if (v.verdict === "WAIT") report.waitCount++;

    // Buckets
    const pairBucket = report.byPair[v.pair] ??= emptyBucket();
    const sessBucket = report.bySession[v.session ?? "OFF"] ??= emptyBucket();
    const confKey    = confidenceBand(v.confidence);
    const confBucket = report.byConfidenceBand[confKey] ??= emptyBucket();
    pairBucket.total++; sessBucket.total++; confBucket.total++;

    // Outcome only meaningful for actionable verdicts
    if (v.verdict === "WAIT" || !v.tradePlan) continue;
    plannedRRSum += v.tradePlan.rr; plannedRRCount++;

    const out = latest.get(v.verdictId);
    if (!out) continue;
    report.trackedActionables++;

    if (out.outcome_status === "FETCH_FAILED") {
      report.fetchFailed++;
      continue;
    }

    // Mutate buckets only on closed outcomes
    const isWin     = out.outcome_status === "TP";
    const isLoss    = out.outcome_status === "SL";
    const isExpired = out.outcome_status === "EXPIRED";
    if (!isWin && !isLoss && !isExpired) continue;  // OPEN — skip

    report.closed++;
    pairBucket.closed++; sessBucket.closed++; confBucket.closed++;

    if (isWin) {
      report.wins++; pairBucket.wins++; sessBucket.wins++; confBucket.wins++;
      if (out.current_pnl_pips != null) { winPipsSum += out.current_pnl_pips; winPipsCount++; }
    } else if (isLoss) {
      report.losses++; pairBucket.losses++; sessBucket.losses++; confBucket.losses++;
      if (out.current_pnl_pips != null) { lossPipsSum += out.current_pnl_pips; lossPipsCount++; }
    } else if (isExpired) {
      report.expired++; pairBucket.expired++; sessBucket.expired++; confBucket.expired++;
    }
  }

  // Finalize win rates
  const decided = report.wins + report.losses;
  report.winRate = decided > 0 ? report.wins / decided : 0;
  for (const k of Object.keys(report.byPair))           finalizeBucket(report.byPair[k]);
  for (const k of Object.keys(report.bySession))        finalizeBucket(report.bySession[k]);
  for (const k of Object.keys(report.byConfidenceBand)) finalizeBucket(report.byConfidenceBand[k]);

  report.avgPlannedRR        = plannedRRCount > 0 ? +(plannedRRSum / plannedRRCount).toFixed(2) : null;
  report.avgRealizedPipsWin  = winPipsCount   > 0 ? +(winPipsSum   / winPipsCount).toFixed(2)   : null;
  report.avgRealizedPipsLoss = lossPipsCount  > 0 ? +(lossPipsSum  / lossPipsCount).toFixed(2)  : null;

  return report;
}

// ─── Public API: cached or forced ──────────────────────────────────────────
export async function getPerformance(force: boolean = false): Promise<PerformanceReport> {
  if (!force && cache && cache.expires > Date.now()) return cache.data;
  const [verdicts, outcomes] = await Promise.all([
    readAllVerdicts(),
    readAllOutcomes(),
  ]);
  const report = aggregate(verdicts, outcomes);
  cache = { data: report, expires: Date.now() + CACHE_TTL_MS };
  return report;
}

/** Test-only: clear in-memory cache between tests. */
export function clearPerformanceCache(): void { cache = null; }
