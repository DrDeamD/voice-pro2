// ============================================================================
// Pre-News Volatility Expansion Warning — v4.2 Phase 2
//
// Looks ahead in the economic calendar for HIGH-impact events that affect the
// pair's currencies. If one is imminent (< 30 min), we emit a warning. If
// very imminent (< 15 min), we recommend BLOCKER — the spread will widen and
// price may jump 50+ pips on release.
//
// This is a SOFT recommendation that the risk gate translates into a veto for
// fresh entries. Existing positions are NOT affected (we're not a trader).
// ============================================================================

import type { CalendarEvent } from "../types/index.js";

export type PreNewsLevel = "BLOCKER" | "WARNING" | "INFO" | "NONE";

export interface PreNewsResult {
  level: PreNewsLevel;
  /** Minutes until the nearest qualifying event. null when level=NONE */
  minutesUntil: number | null;
  /** The event itself */
  event: CalendarEvent | null;
  /** Pair currencies affected */
  affectedCcys: string[];
  /** Human-readable summary in Arabic */
  reasoningAr: string;
  /** Human-readable summary in English */
  reasoningEn: string;
}

const BLOCKER_WINDOW_MIN = 15;
const WARNING_WINDOW_MIN = 30;
const INFO_WINDOW_MIN = 60;

export function checkPreNewsVolatility(
  events: CalendarEvent[],
  base: string,
  quote: string,
): PreNewsResult {
  const ccys = new Set<string>([base, quote]);
  if (base === "XAU") ccys.add("USD");

  const candidates = events.filter(e =>
    e.impact === "HIGH" &&
    e.minutesFromNow > 0 &&
    e.minutesFromNow <= INFO_WINDOW_MIN &&
    ccys.has(e.country)
  );

  if (candidates.length === 0) {
    return {
      level: "NONE",
      minutesUntil: null,
      event: null,
      affectedCcys: [],
      reasoningAr: "لا أحداث HIGH وشيكة",
      reasoningEn: "No imminent HIGH-impact events",
    };
  }

  candidates.sort((a, b) => a.minutesFromNow - b.minutesFromNow);
  const nearest = candidates[0]!;
  const m = Math.round(nearest.minutesFromNow);

  let level: PreNewsLevel;
  if (m <= BLOCKER_WINDOW_MIN) level = "BLOCKER";
  else if (m <= WARNING_WINDOW_MIN) level = "WARNING";
  else level = "INFO";

  const ccyLabel = nearest.country;
  const reasoningAr =
    level === "BLOCKER"
      ? `⚠️ ${m} دقيقة فقط حتى "${nearest.title}" (${ccyLabel}). السبريد سيتضاعف، السعر قد يقفز ±50p. لا دخول جديد.`
      : level === "WARNING"
      ? `${m} دقيقة حتى "${nearest.title}" (${ccyLabel}). توقّع توسّع تذبذب، قلّل حجم الصفقة.`
      : `${m} دقيقة حتى "${nearest.title}" (${ccyLabel}). انتبه للتقلّبات.`;

  const reasoningEn =
    level === "BLOCKER"
      ? `Only ${m} min to "${nearest.title}" (${ccyLabel}). Spread will widen, price may jump ±50p. Hold new entries.`
      : level === "WARNING"
      ? `${m} min to "${nearest.title}" (${ccyLabel}). Expect volatility expansion, reduce size.`
      : `${m} min to "${nearest.title}" (${ccyLabel}). Stay alert for volatility.`;

  return {
    level,
    minutesUntil: m,
    event: nearest,
    affectedCcys: [...ccys].filter(c => c === nearest.country),
    reasoningAr,
    reasoningEn,
  };
}
