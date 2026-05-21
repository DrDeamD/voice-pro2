// ============================================================================
// v3.5.6 — Verdict Recorder
//
// Single integration point between analyzePair() output and verdict_log.jsonl.
// Keeping this in its own file means:
//   - server.ts barely changes (just one call after analyzePair)
//   - the mapping from PairAnalysis → VerdictRecord is testable in isolation
//   - any future change to either schema is contained here
//
// Failure policy: never throws. Verdict logging is best-effort; the trading
// decision pipeline is more important than the measurement pipeline.
// ============================================================================
import { VERSION, RULES } from "../config.js";
import {
  appendVerdict, makeVerdictId, detectSession,
  type VerdictRecord, type VerdictComponents,
} from "./verdictLog.js";

/**
 * Convert an analyzePair() result into a VerdictRecord and append.
 * Returns the record (for tests/observability), or null on failure.
 */
export async function recordVerdict(pair: any): Promise<VerdictRecord | null> {
  try {
    const record = buildRecord(pair);
    if (!record) return null;
    const ok = await appendVerdict(record);
    return ok ? record : null;
  } catch (err: any) {
    process.stderr.write(`[recorder] build/write failed: ${err?.message}\n`);
    return null;
  }
}

/** Pure mapping from PairAnalysis to VerdictRecord. Exported for testing. */
export function buildRecord(pair: any): VerdictRecord | null {
  if (!pair || !pair.symbol || !pair.verdict || !pair.scores) return null;

  const verdict = pair.verdict as "BUY" | "SELL" | "WAIT";
  if (verdict !== "BUY" && verdict !== "SELL" && verdict !== "WAIT") return null;

  const tsMillis = Date.now();
  const isoTs = new Date(tsMillis).toISOString();
  const session = detectSession(new Date(tsMillis));

  const components: VerdictComponents = {
    marketStructure: numOr0(pair.scores.marketStructure ?? pair.marketStructure?.score),
    mtfAlignment:    numOr0(pair.scores.mtf),
    momentum:        numOr0(pair.scores.momentum),
    vwap:            numOr0(pair.scores.vwap ?? pair.vwap?.score),
    priceAction:     numOr0(pair.scores.priceAction),
    regime:          String(pair.regime?.regime ?? pair.regime?.label ?? "UNKNOWN"),
    correlation:     numOr0(pair.scores.correlation),
    newsScore:       numOr0(pair.scores.news),
  };

  const tradePlan = (verdict === "BUY" || verdict === "SELL") && pair.plan ? {
    entry: numOrNaN(pair.plan.entry),
    sl:    numOrNaN(pair.plan.stopLoss ?? pair.plan.sl),
    tp:    numOrNaN(pair.plan.tp1 ?? pair.plan.tp),
    rr:    numOr0(pair.plan.rr1 ?? pair.plan.rr),
  } : null;
  // If actionable but plan numbers are missing/NaN, drop the plan rather than
  // store garbage — outcome tracker would FETCH_FAILED forever otherwise.
  const safeTradePlan = tradePlan && Number.isFinite(tradePlan.entry)
                              && Number.isFinite(tradePlan.sl)
                              && Number.isFinite(tradePlan.tp)
    ? tradePlan : null;

  const priceAtVerdict = numOrNaN(pair.quote?.bid ?? pair.quote?.mid ?? pair.quote?.ask);
  if (!Number.isFinite(priceAtVerdict)) return null;  // no price → log is useless

  // News context — best-effort; defaults are safe.
  // v4.0 priority 3a (R6) — added highImpactPending for journal observability.
  // See verdictLog.ts VerdictNewsContext for full rationale.
  const news = pair.news ?? {};
  const newsContext = {
    breakingActive: !!news.breakingActive,
    breakingScore:  numOr0(news.breakingScore),
    msidActive:     !!(news.interventionRegime && news.interventionRegime.active),
    highImpactPending: !!news.highImpactPending,
  };

  // Calendar context — read from risk.reasons + nearest event metadata if present
  const calendarContext = extractCalendarContext(pair);

  // v3.10 — calibration audit. scores.calibration is set in court.ts
  // composeScores when the symbol has registry data; otherwise heuristic.
  let calibrationContext: import("./verdictLog.js").VerdictCalibrationContext | undefined;
  const cal = pair.scores?.calibration;
  if (cal && (cal.source === "calibrated" || cal.source === "heuristic")) {
    if (cal.source === "calibrated" && cal.bin) {
      calibrationContext = {
        source: "calibrated",
        binLoAbs: numOr0(cal.bin.loAbs),
        binHiAbs: numOr0(cal.bin.hiAbs),
        binWinRate: numOr0(cal.bin.winRate),
        binSampleSize: numOr0(cal.bin.sampleSize),
      };
    } else {
      calibrationContext = {
        source: "heuristic",
        heuristicReason: cal.heuristicReason,
      };
    }
  }

  // v4.0 priority 0e — extract veto reasons from PairAnalysis.
  //
  // Both lists are sourced from pair output that already exists. We only
  // copy them into the record. We sanitise to ensure they are arrays of
  // strings (defensive against pair shape drift).
  //
  // riskReasons        — pair.risk.reasons (engineering-facing, raw)
  // missingReasons     — pair.verdictExplanation.missing (user-facing,
  //                      paraphrased + deduplicated by court.ts)
  //
  // We prefer the explanation.missing for "what the user saw" and keep
  // risk.reasons for "what the engine actually emitted". They are NOT
  // redundant — explanation.missing collapses synonyms (e.g. "confidence
  // 9 below threshold 60" and "confidence 14 below threshold 60" both
  // become "Confidence X below threshold").
  const riskReasonsRaw = pair?.risk?.reasons;
  const riskReasons: string[] | undefined = Array.isArray(riskReasonsRaw)
    ? riskReasonsRaw.filter((r: unknown): r is string => typeof r === "string")
    : undefined;
  const missingRaw = pair?.verdictExplanation?.missing;
  const missingReasons: string[] | undefined = Array.isArray(missingRaw)
    ? missingRaw.filter((r: unknown): r is string => typeof r === "string")
    : undefined;

  // v4.0 priority 3b-prep — comprehensive audit object.
  //
  // Build the v3b nested object from data already in PairAnalysis. No code
  // path changes; this is observability only.
  //
  // Source map:
  //   v3b.components.*       → pair.scores.{...} (some cast as any in court.ts)
  //   v3b.session.*          → pair.session.* + pair.scores.compositeRaw
  //   v3b.v36.*              → pair.v36.court.* + pair.v36.{old,new}Confidence
  //   v3b.v36.witnesses.*    → pair.v36.witnesses[] (array of V36WitnessResult)
  //
  // Defensive against pair.v36 being absent (truth gate hard-failed before
  // applyV36 ran) — in that case all v36.* fields default to 0/null, but
  // truthOk=false explicitly distinguishes from a "ran but rejected" verdict.
  //
  // Witness extraction uses byName() helper because the witnesses array is
  // ordered by computation but consumers want them by name. Each witness's
  // metric extraction tries the canonical key first, falls back to null.
  const v36 = (pair as any)?.v36;
  const witnessByName = (name: string) => {
    const arr = v36?.witnesses;
    if (!Array.isArray(arr)) return null;
    return arr.find((w: any) => w?.name === name) ?? null;
  };
  const numOrNull = (x: any): number | null => {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  };

  const wHurst  = witnessByName("HurstExponent");
  const wGarch  = witnessByName("GARCH");
  const wRvb    = witnessByName("RealizedVolBipower");
  const wHawkes = witnessByName("HawkesLite");

  const v3b: import("./verdictLog.js").VerdictV3bAudit = {
    components: {
      marketStructure: numOr0((pair.scores as any)?.marketStructure),
      mtfAlignment:    numOr0(pair.scores?.mtf),
      momentum:        numOr0(pair.scores?.momentum),
      vwap:            numOr0((pair.scores as any)?.vwap),
      priceAction:     numOr0(pair.scores?.priceAction),
      manipulation:    numOr0((pair.scores as any)?.manipulation),
      divergence:      numOr0((pair.scores as any)?.divergence),
      regimeScore:     numOr0(pair.scores?.regime),
      correlation:     numOr0(pair.scores?.correlation),
      newsScore:       numOr0(pair.scores?.news),
    },
    session: {
      name:                   String(pair?.session?.name ?? "UNKNOWN"),
      weight:                 numOr0(pair.scores?.sessionWeight),
      compositeBeforeSession: numOr0(pair.scores?.compositeRaw),
    },
    v36: {
      truthOk:         !!(v36?.truth?.ok),
      trustScore:      numOr0(v36?.court?.trustScore),
      sideScore:       numOr0(v36?.court?.sideScore),
      // trustFloor is computed inside computeV36Court but not returned. We
      // re-derive: if regime label is RANGE, floor is 45 (priority 3.7b),
      // else MIN_TRUST_SCORE (50 since priority 6.5-main; was 60 pre-6.5).
      // This mirrors the logic at statCourt.ts:203. If the trustFloor logic
      // changes again in statCourt, this MUST update too — captured as
      // technical debt to be removed when trustFloor becomes a first-class
      // field in the v36 court return.
      trustFloor:      pair?.regime?.label === "RANGE" ? 45 : 50,
      confidenceCap:   numOr0(v36?.court?.confidenceCap),
      confidenceDelta: numOr0(v36?.court?.confidenceDelta),
      oldConfidence:   numOr0(v36?.oldConfidence),
      newConfidence:   numOr0(v36?.newConfidence),
      witnesses: {
        hurst: {
          signal:     numOr0(wHurst?.signal),
          confidence: numOr0(wHurst?.confidence),
          reliable:   !!(wHurst?.reliable),
          h:          numOrNull(wHurst?.metrics?.hurst),
          r2:         numOrNull(wHurst?.metrics?.r2),
        },
        garch: {
          signal:      numOr0(wGarch?.signal),
          confidence:  numOr0(wGarch?.confidence),
          reliable:    !!(wGarch?.reliable),
          persistence: numOrNull(wGarch?.metrics?.persistence),
        },
        rvb: {
          signal:    numOr0(wRvb?.signal),
          confidence: numOr0(wRvb?.confidence),
          reliable:  !!(wRvb?.reliable),
          jumpRatio: numOrNull(wRvb?.metrics?.jumpRatio),
        },
        hawkes: {
          signal:      numOr0(wHawkes?.signal),
          confidence:  numOr0(wHawkes?.confidence),
          reliable:    !!(wHawkes?.reliable),
          longEvents:  numOrNull(wHawkes?.metrics?.longEvents),
          shortEvents: numOrNull(wHawkes?.metrics?.shortEvents),
        },
      },
    },
  };

  return {
    ts: isoTs,
    version: VERSION,
    pair: pair.symbol,
    verdict,
    confidence: numOr0(pair.scores.confidence),
    composite:  numOr0(pair.scores.composite),
    components,
    tradePlan: safeTradePlan,
    priceAtVerdict,
    tier: String(pair.scores.confidenceTier ?? "UNKNOWN"),
    verdictId: makeVerdictId(pair.symbol, tsMillis),
    session,
    newsContext,
    calendarContext,
    calibrationContext,
    riskReasons,
    missingReasons,
    v3b,
  };
}

function numOr0(x: any): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}
function numOrNaN(x: any): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

function extractCalendarContext(pair: any) {
  // v3.5.6: only blockedBy is reliably extractable. nearestEventMin /
  // nearestEventImpact would require analyzePair to expose them as first-
  // class fields; deferred to v3.5.7. Logging null fields today would mislead
  // the operator after 30 days of data ("trade was far from events" when
  // we actually never measured).
  const reasons: string[] = pair?.risk?.reasons ?? [];
  let blockedBy: string | null = null;
  for (const r of reasons) {
    if (typeof r !== "string") continue;
    if (r.toLowerCase().includes("calendar") && r.toLowerCase().includes("block")) {
      blockedBy = r.slice(0, 120);
      break;
    }
  }
  return { blockedBy };
}

// ─── Convenience: record many in parallel without blocking pipeline ────────
/**
 * Record multiple pair analyses concurrently.
 * Used by server.ts after Promise.allSettled(analyzePair).
 * Failures are absorbed — never propagates to caller.
 */
export async function recordVerdicts(pairs: any[]): Promise<void> {
  await Promise.allSettled(pairs.map(p => recordVerdict(p)));
}
