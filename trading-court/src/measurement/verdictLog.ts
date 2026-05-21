// ============================================================================
// v3.5.6 — Verdict Logger
//
// Purpose:
//   Append-only JSONL log of every verdict the court issues. This is the
//   FOUNDATION of self-measurement — without this log there's no way to
//   answer "is the system actually accurate?"
//
// Critical guarantees:
//   1. Append-only: existing lines NEVER mutate
//   2. Concurrency-safe: 8 simultaneous writes (NFP burst) all succeed
//   3. Self-healing: missing file/dir created on first write
//   4. Resilient: malformed lines from past don't crash future writes
//   5. Idempotent: uses fs.appendFile (atomic for <4KB writes; verdict ~600B)
//
// File path: ./data/verdict_log.jsonl  (see config — outside dist/, gitignored)
// ============================================================================
import { promises as fs } from "node:fs";
import * as path from "node:path";

// Resolved at boot from config.MEASUREMENT.verdictLogPath. We read it lazily
// to avoid circular imports (config imports nothing from measurement).
let logPathCache: string | null = null;

function getLogPath(): string {
  if (logPathCache) return logPathCache;
  // Default — overridable for tests via setLogPath()
  logPathCache = path.resolve(process.cwd(), "data", "verdict_log.jsonl");
  return logPathCache;
}

/** Test-only: redirect logger to a different file. */
export function setLogPath(p: string): void {
  logPathCache = path.resolve(p);
}

/** Test-only: reset cache so getLogPath() re-resolves from cwd. */
export function resetLogPath(): void {
  logPathCache = null;
}

// ─── Verdict record schema (v3.5.6) ─────────────────────────────────────────
export interface VerdictComponents {
  marketStructure: number;
  mtfAlignment:    number;
  momentum:        number;
  vwap:            number;
  priceAction:     number;
  regime:          string;            // "TREND_UP" | "RANGE" | etc.
  correlation:     number;
  newsScore:       number;
}

export interface VerdictTradePlan {
  entry: number;
  sl:    number;
  tp:    number;
  rr:    number;
}

export interface VerdictNewsContext {
  breakingActive: boolean;
  breakingScore:  number;
  msidActive:     boolean;
  // v4.0 priority 3a (R6) — highImpactPending observability.
  //
  // This field is the DIRECT input to risk.ts:62-64 which emits the visible
  // veto reason "High-impact event recently released / pending – stand down".
  // It is computed in newsEngine.ts:305 from `highImpact || breakingActive`,
  // where `highImpact` is true when ANY news item has highImpact=true within
  // RULES.highImpactPendingWindowMin (60 min, set by priority 1.8).
  //
  // Pre-3a, the journal logged breakingActive and msidActive but NOT
  // highImpactPending. As a result, post-hoc analysis could see "veto fired"
  // but could not distinguish between:
  //   (a) legitimate fresh high-impact event (highImpactPending=true,
  //       breakingActive=false): the priority 1.8 window logic firing as
  //       designed
  //   (b) priority 1.7 keyword filter missing an opinion piece, causing a
  //       false-positive highImpactPending=true
  //   (c) a different bug entirely (which earlier I incorrectly hypothesised
  //       as a "third veto source" — see CHANGES doc D1 walkback)
  //
  // With this field, post-3a journal data answers (a) vs (b) directly:
  // count records where highImpactPending=true && breakingActive=false &&
  // calendar.blockedBy=null, then sample-audit the news items at that
  // timestamp.
  //
  // Optional for backwards compat with pre-3a records (5,400+ already in
  // production journal at deploy time).
  highImpactPending?: boolean;
}

export interface VerdictCalendarContext {
  blockedBy: string | null;   // event description that blocked the trade, or null
  // v3.5.6: nearestEventMin / nearestEventImpact deferred to v3.5.7.
  // analyzePair() does not currently expose these fields explicitly. Logging
  // them as null today would create a misleading record ("trade was far from
  // events") when the truth is "we never measured proximity". Re-add when
  // analyzePair surfaces them as first-class fields.
}

// v3.10 — calibration audit. These fields let the journal-to-calibration
// bridge (calibration/fromJournal.ts) reconstruct exactly which bin each
// verdict came from, and whether that confidence was empirical or heuristic.
// Optional for backwards compat with pre-v3.10 logs.
export interface VerdictCalibrationContext {
  source: "calibrated" | "heuristic";
  // Only present when source === "calibrated"
  binLoAbs?: number;
  binHiAbs?: number;
  binWinRate?: number;
  binSampleSize?: number;
  // Only present when source === "heuristic"
  heuristicReason?: "no_calibration" | "low_sample" | "no_match" | "out_of_range";
}

// ============================================================================
// v4.0 priority 3b-prep — comprehensive audit for priority 6.5 decisions.
//
// Why this exists:
//   Experiment (a) [code archaeology] and experiment (c) [threshold lowering
//   simulation on 2,114 verdicts] in the priority 6.5 design draft identified
//   `applyV36StatisticalCourt`'s confidenceDelta as the dominant compression
//   bottleneck. To select between options A/B/C/D for the delta fix, we need
//   per-verdict visibility into:
//
//   1) The 10 raw component scores that go INTO composeScores (currently the
//      journal logs only 7; manipulation, divergence, and regime-numeric are
//      missing).
//   2) The session weight multiplier and pre-multiplier composite.
//   3) The v36 statistical court state (trustScore, sideScore, caps, delta).
//   4) Per-witness output (signal, confidence, key metric) for all 4
//      stat-court witnesses (Hurst, GARCH, RV-B, Hawkes).
//
//   Without this data, choosing between options is guess-by-design (which 2M
//   classified as synthetic reasoning).
//
// What this is NOT:
//   - Behavioral change. No witness output, no court output, no verdict
//     output is altered.
//   - Required for backwards compat. All fields are optional. Pre-3b-prep
//     records (5,400+ in production) parse cleanly with v3b = undefined.
//   - The patch for the bottleneck. That is priority 6.5-main, ships AFTER
//     this data accumulates 24-36 hours.
//
// Schema rationale for nesting:
//   2M's directive: "use nested structure to keep schema-evolution localized
//   per area". `v3b.components` for raw scores, `v3b.session` for session
//   state, `v3b.v36` for statistical court — each can grow independently
//   without touching the others.
// ============================================================================

export interface VerdictV3bAudit {
  // ─── 10 raw component scores (input to composeScores) ──────────────────
  // Currently the journal logs 7 of these in `components` (top-level field).
  // We re-log them here for two reasons:
  //   (a) explicit consistency — all composite inputs in one nested object
  //   (b) regime here is the NUMERIC score, not the regime LABEL string
  //       that's already in components.regime. They are different fields.
  components: {
    marketStructure: number;
    mtfAlignment:    number;
    momentum:        number;
    vwap:            number;
    priceAction:     number;
    manipulation:    number;
    divergence:      number;
    regimeScore:     number;     // numeric, distinguish from existing regime label
    correlation:     number;
    newsScore:       number;
  };

  // ─── Session weight + pre-multiplier composite ──────────────────────────
  // composeScores applies sessionWeight (0.75-1.15) AFTER calibration but
  // BEFORE deriveDecision. compositeBeforeSession captures the value before
  // the multiplier — needed to disentangle session compression from
  // chain compression in priority 6.5 analysis.
  session: {
    name:                   string;     // "ASIA" | "LDN" | "NY" | "OFF" | "OVERLAP"
    weight:                 number;     // sessionWeight, range 0.75-1.15
    compositeBeforeSession: number;     // compositeRaw before applySession
  };

  // ─── v36 statistical court state ────────────────────────────────────────
  // The full state of applyV36StatisticalCourt for this verdict. This is
  // the layer that experiment (a) identified as the dominant compression.
  //
  // truthOk = false means the truth gate failed before any stat witness ran.
  //           In that case, court fields default to 0 (system-emitted, not
  //           computed). The witnesses object will have 4 entries with
  //           reliable=false.
  //
  // confidenceDelta is the SUM of:
  //   +6 if trustScore≥60 AND |sideScore|≥50
  //   +4 if trustScore≥70 AND |sideScore|≥70
  //   −8 if trustScore<trustFloor
  //   −5 if confidenceCap<100
  //
  // Range observed: -13 to +10 (rare). Most production verdicts: -8 to -13.
  v36: {
    truthOk:         boolean;
    trustScore:      number;         // 0-100, post-clamp
    sideScore:       number;         // -100 to +100
    trustFloor:      number;         // 60 default, 45 in RANGE regime
    confidenceCap:   number;         // 100 default, 65/72 when caps fire
    confidenceDelta: number;         // -13 to +10 typical
    oldConfidence:   number;         // confidence BEFORE v36 transform
    newConfidence:   number;         // confidence AFTER v36 transform

    // Per-witness state. All 4 witnesses always logged. When truth gate
    // failed or witness's reliable=false, fields are 0/null.
    witnesses: {
      hurst: {
        signal:     number;          // {-30, 0, +30} step function, see priority 3b
        confidence: number;          // 0-1, capped at 0.35 when r²<0.50
        reliable:   boolean;
        h:          number | null;   // Hurst exponent value (null if insufficient)
        r2:         number | null;   // regression r² (null if insufficient)
      };
      garch: {
        signal:      number;         // {+20, 0, -35, -80}
        confidence:  number;         // 0-1
        reliable:    boolean;
        persistence: number | null;  // alpha + beta from GARCH(1,1)
      };
      rvb: {
        signal:    number;           // {+20, -35, -70}
        confidence: number;          // 0-1
        reliable:  boolean;
        jumpRatio: number | null;    // (rv-bv)/(rv+EPS), 0-1
      };
      hawkes: {
        signal:      number;         // -100 to +100, continuous (only directional witness)
        confidence:  number;         // 0-1
        reliable:    boolean;
        longEvents:  number | null;  // count of long-direction events detected
        shortEvents: number | null;  // count of short-direction events detected
      };
    };
  };
}

export interface VerdictRecord {
  ts:                 string;           // ISO-8601 with ms
  version:            string;           // e.g. "3.5.6"
  pair:               string;           // e.g. "EURUSD"
  verdict:            "BUY" | "SELL" | "WAIT";
  confidence:         number;
  composite:          number;
  components:         VerdictComponents;
  tradePlan:          VerdictTradePlan | null;   // null when WAIT
  priceAtVerdict:     number;
  tier:               string;           // "STRONG" | "VALID" | "WEAK" | "REJECT"

  // v3.5.6 additions
  verdictId:          string;           // {pair}-{tsMillis}-{counter}
  session:            string;           // "ASIA" | "LDN" | "NY" | "OFF"
  newsContext:        VerdictNewsContext;
  calendarContext:    VerdictCalendarContext;

  // v3.10 — calibration audit (optional for backwards compat)
  calibrationContext?: VerdictCalibrationContext;

  // v4.0 priority 0e — veto/rejection reasoning (optional for backwards compat).
  //
  // Why this was missing: verdictLog.ts shipped in v3.5.6 captured composite
  // and confidence and tier, but NOT the human-readable reasons that drove
  // the WAIT verdict. The dashboard had this information (from
  // pair.risk.reasons and pair.verdictExplanation.missing) but the journal
  // did not. Result: post-hoc analysis of the journal could see WHAT the
  // verdict was, but not WHY.
  //
  // Why now: the production baseline analysis (May 2026, 5,467 verdicts)
  // could not answer "what veto reason dominated?" because the field was
  // absent. Adding it before priority 3 (statMath audit) and priority 6.5
  // (engine weight recalibration) ensures those analyses have the data
  // they need.
  //
  // Field semantics:
  //   riskReasons     — raw strings from pair.risk.reasons. Engineering-facing.
  //                     Examples: "Composite confidence 27 < threshold 60",
  //                     "RR 0.46 below floor 1.50", "v36_garch_unstable".
  //   missingReasons  — user-facing strings from pair.verdictExplanation.missing.
  //                     De-duplicated, paraphrased for the dashboard.
  //                     Examples: "Confidence 27 below threshold",
  //                     "RR 0.46 below floor 1.50",
  //                     "High-impact event recently released / pending – stand down".
  //
  // Both are kept because they answer different questions. riskReasons preserves
  // the v36/internal flag names exactly (useful for grep), missingReasons
  // preserves what the user actually saw on the dashboard at decision time.
  //
  // Both default to undefined (not empty array) when absent, to distinguish
  // pre-0e records (no information) from post-0e WAIT-with-no-reasons (which
  // would itself be a bug worth flagging).
  riskReasons?:       string[];
  missingReasons?:    string[];

  // v4.0 priority 3b-prep — comprehensive audit nested object.
  // See VerdictV3bAudit interface for full rationale + field semantics.
  // Optional for backwards compat with all pre-3b-prep records (5,400+).
  v3b?:               VerdictV3bAudit;
}

// ─── Counter for verdictId disambiguation within same millisecond ───────────
// 8 pairs analysed in same Date.now() must produce unique IDs.
let counter = 0;
function nextCounter(): number {
  counter = (counter + 1) % 1_000_000;
  return counter;
}

export function makeVerdictId(pair: string, tsMillis: number): string {
  return `${pair}-${tsMillis}-${nextCounter()}`;
}

// ─── Session detection (UTC-based, FX market hours) ────────────────────────
// We use UTC hour because the server timezone is unknown. FX sessions:
//   ASIA: 23:00–08:00 UTC  (Tokyo+Sydney)
//   LDN:  07:00–16:00 UTC  (London)
//   NY:   12:00–21:00 UTC  (New York)
// Overlaps resolved by precedence: NY > LDN > ASIA > OFF
export function detectSession(date: Date = new Date()): string {
  const h = date.getUTCHours();
  if (h >= 12 && h < 21) return "NY";
  if (h >=  7 && h < 12) return "LDN";   // pure London (before NY overlap)
  if (h >= 21 || h <  7) return "ASIA";  // wraps midnight
  return "OFF";
}

// ─── Append-only writer ────────────────────────────────────────────────────
/**
 * Append a verdict record as a single JSON line.
 *
 * Concurrency: relies on fs.appendFile atomicity for <4KB writes. A typical
 * verdict line is ~600 bytes including all components, so this is safe.
 * Tested in v356-measurement.ts test 7 (concurrent burst).
 *
 * Error policy: never throws. If write fails (disk full, permissions), logs
 * to stderr and returns false. The caller continues — losing one log line
 * is preferable to crashing the verdict pipeline.
 */
export async function appendVerdict(record: VerdictRecord): Promise<boolean> {
  const line = JSON.stringify(record) + "\n";
  const filePath = getLogPath();
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, line, "utf8");
    return true;
  } catch (err: any) {
    process.stderr.write(`[measurement] verdict log append failed: ${err.message}\n`);
    return false;
  }
}

// ─── Reader (used by /api/performance and outcome_tracker) ─────────────────
/**
 * Read all verdicts. Skips malformed lines silently — resilience first.
 * Returns empty array if file missing.
 */
export async function readAllVerdicts(): Promise<VerdictRecord[]> {
  const filePath = getLogPath();
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out: VerdictRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as VerdictRecord);
    } catch {
      // Malformed line — skip without crashing. We log a warning once per file
      // read so the operator notices but the system keeps running.
      process.stderr.write(`[measurement] skipping malformed verdict line\n`);
    }
  }
  return out;
}

/** Read only verdicts whose ts is within the last `hoursBack` hours. */
export async function readRecentVerdicts(hoursBack: number): Promise<VerdictRecord[]> {
  const all = await readAllVerdicts();
  const cutoff = Date.now() - hoursBack * 3600 * 1000;
  return all.filter(v => Date.parse(v.ts) >= cutoff);
}
