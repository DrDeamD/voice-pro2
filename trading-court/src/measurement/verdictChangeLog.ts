// ============================================================================
// Verdict Change Log — v4.2 Phase 3
//
// In-memory tracker of per-symbol verdict transitions. Used by:
//   1. Dashboard: "/api/changes" endpoint shows last N transitions
//   2. Telegram bot: emits notification on verdict change
//   3. Sound alerts: front-end listens to changes
//
// In-memory only (resets on server restart). Long-term audit is the
// verdict_log.jsonl on disk (handled by measurement/recorder.ts).
// ============================================================================

import type { Verdict } from "../types/index.js";

export interface VerdictChangeEvent {
  symbol: string;
  fromVerdict: Verdict;
  toVerdict: Verdict;
  composite: number;
  confidence: number;
  tsUtc: string;
  /** Optional headline for context — usually verdictExplanation.headline */
  headline: string;
}

const MAX_LOG_ENTRIES = 200;
const lastVerdictBySymbol = new Map<string, Verdict>();
const changeLog: VerdictChangeEvent[] = [];

export interface DetectionResult {
  changes: VerdictChangeEvent[];
}

/**
 * Process a fresh snapshot's pairs, detect verdict transitions, and append
 * to the in-memory log.
 *
 * @returns Array of changes detected in THIS snapshot (could be empty)
 */
export function detectVerdictChanges(pairs: any[]): DetectionResult {
  const changes: VerdictChangeEvent[] = [];
  const now = new Date().toISOString();

  for (const p of pairs) {
    if (!p?.symbol || !p?.verdict) continue;
    const sym = p.symbol as string;
    const current = p.verdict as Verdict;
    const prev = lastVerdictBySymbol.get(sym);

    if (prev != null && prev !== current) {
      const ev: VerdictChangeEvent = {
        symbol: sym,
        fromVerdict: prev,
        toVerdict: current,
        composite: typeof p.scores?.composite === "number" ? p.scores.composite : 0,
        confidence: typeof p.scores?.confidence === "number" ? p.scores.confidence : 0,
        tsUtc: now,
        headline: p.verdictExplanation?.headline ?? p.summary ?? "",
      };
      changes.push(ev);
      changeLog.unshift(ev);
    }

    lastVerdictBySymbol.set(sym, current);
  }

  // Trim to MAX_LOG_ENTRIES
  if (changeLog.length > MAX_LOG_ENTRIES) {
    changeLog.length = MAX_LOG_ENTRIES;
  }

  return { changes };
}

export function getChangeLog(limit: number = 50): VerdictChangeEvent[] {
  return changeLog.slice(0, limit);
}

/** Test helper: clear in-memory state */
export function _resetChangeLog(): void {
  lastVerdictBySymbol.clear();
  changeLog.length = 0;
}
