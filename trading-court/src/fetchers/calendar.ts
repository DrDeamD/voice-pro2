// ============================================================================
// Economic Calendar Fetcher v3.4.2 — FairEconomy only (proven)
//
// FIX from v3.4.1:
//   - DROPPED tradingeconomics RSS — `/calendar/rss/` returns the HTML index
//     page, not an XML feed. We can't parse calendar actuals from it. The user
//     saw te_calendar permanently red in production for this reason.
//   - WIDENED pendingActual window 180min → 360min so events 200-300min old
//     also display "مُتأخر" instead of falling through to em-dash.
//
// Rationale: a focused single-source pipeline with aggressive 60s TTL beats a
// multi-source pipeline where the secondaries are dead weight.
// ============================================================================

import { httpJSON } from "../http.js";
import { TTL } from "../config.js";
import type { CalendarEvent } from "../types/index.js";

// ─── Source URLs (verified working in v3.4.2) ───────────────────────────────
const FF_THIS_WEEK = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const FF_NEXT_WEEK = "https://nfs.faireconomy.media/ff_calendar_nextweek.json";

// ─── Impact mapping ─────────────────────────────────────────────────────────
function parseImpact(raw: string): "LOW" | "MEDIUM" | "HIGH" {
  const s = (raw || "").toLowerCase();
  if (s.startsWith("h") || s === "3" || s === "high") return "HIGH";
  if (s.startsWith("m") || s === "2" || s === "medium") return "MEDIUM";
  return "LOW";
}

function toUtcIso(dateStr: string): string | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function isHigherBetterEvent(title: string): boolean {
  const t = title.toLowerCase();
  if (/\b(cpi|ppi|rpi|inflation|unemploy|jobless|claims|deficit|debt|borrowing)\b/.test(t)) return false;
  return true;
}

function computeSurprise(
  actualStr: string | undefined,
  forecastStr: string,
  title: string,
): { surprise: number | null; deltaAbs: number | null; surpriseDir: "BETTER" | "WORSE" | "INLINE" | null } {
  if (!actualStr) return { surprise: null, deltaAbs: null, surpriseDir: null };
  const actualNum   = parseFloat(actualStr.replace(/[%$,KMBk]/g, ""));
  const forecastNum = parseFloat(forecastStr.replace(/[%$,KMBk]/g, ""));
  if (isNaN(actualNum) || isNaN(forecastNum)) {
    return { surprise: null, deltaAbs: null, surpriseDir: null };
  }
  const deltaAbs = actualNum - forecastNum;
  if (Math.abs(deltaAbs) < 0.0001) {
    return { surprise: 0, deltaAbs: 0, surpriseDir: "INLINE" };
  }
  const higherIsBetter = isHigherBetterEvent(title);
  const surpriseDir: "BETTER" | "WORSE" =
    (higherIsBetter && deltaAbs > 0) || (!higherIsBetter && deltaAbs < 0) ? "BETTER" : "WORSE";
  const surprise = higherIsBetter ? deltaAbs : -deltaAbs;
  return { surprise, deltaAbs, surpriseDir };
}

// ─── SOURCE 1: FairEconomy (primary structure + actuals) ────────────────────
async function fromFairEconomy(): Promise<CalendarEvent[]> {
  const nowMs = Date.now();
  const [thisWeek, nextWeek] = await Promise.all([
    httpJSON<any[]>(FF_THIS_WEEK, {
      cacheKey: "ff:thisweek",
      ttlSec: TTL.CALENDAR_STRUCTURE,   // 60s in v3.4 (was 600s in v3.3.1)
      source: "faireconomy",
      timeoutMs: 7000,
      retries: 2,
    }),
    httpJSON<any[]>(FF_NEXT_WEEK, {
      cacheKey: "ff:nextweek",
      ttlSec: TTL.CALENDAR_NEXTWEEK,    // 15min — next week rarely changes
      source: "_ff_nextweek",            // hidden from health pills
      timeoutMs: 5000,
      retries: 0,
    }).catch(() => null),
  ]);
  const raw = [...(thisWeek || []), ...(nextWeek || [])];
  return parseFFArray(raw, nowMs, "faireconomy");
}

function parseFFArray(raw: any[], nowMs: number, srcTag: string): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const e of raw) {
    const iso = toUtcIso(e.date);
    if (!iso) continue;
    const evMs = new Date(iso).getTime();
    const title    = String(e.title || "").trim();
    const forecast = String(e.forecast || "");
    const previous = String(e.previous || "");
    const actual   = e.actual ? String(e.actual).trim() : undefined;

    const { surprise, deltaAbs, surpriseDir } = computeSurprise(actual, forecast, title);
    const minutesFromNow = (evMs - nowMs) / 60000;

    out.push({
      title,
      country: String(e.country || "").toUpperCase(),
      dateUtc: iso,
      impact: parseImpact(e.impact),
      forecast,
      previous,
      actual,
      surprise,
      deltaAbs,
      surpriseDir,
      minutesFromNow,
      actualSource: actual ? srcTag : undefined,
      // v3.4.2: widened from -180 to -360 so 200-300min old events also
      // display "مُتأخر" in the UI rather than falling through to em-dash.
      pendingActual: !actual && minutesFromNow < -5 && minutesFromNow > -360,
    } as CalendarEvent);
  }
  out.sort((a, b) => new Date(a.dateUtc).getTime() - new Date(b.dateUtc).getTime());
  return out;
}

// ─── PUBLIC API: fetchCalendar (v3.4.2 — FairEconomy only, no TE backup) ───
// FairEconomy mirrors ForexFactory's JSON including actuals. With TTL=60s
// in v3.4, actuals appear within ~1 min of the upstream CDN updating.
// We dropped the TradingEconomics fallback because the public RSS endpoint
// doesn't return structured calendar data — it returns the website's HTML
// index page.
export async function fetchCalendar(): Promise<CalendarEvent[]> {
  return fromFairEconomy().catch(() => [] as CalendarEvent[]);
}

// ─── eventsAffecting — used by risk gate ────────────────────────────────────
export function eventsAffecting(
  events: CalendarEvent[],
  base: string,
  quote: string,
  withinMinutes = 30,
  impactFloor: "LOW" | "MEDIUM" | "HIGH" = "HIGH",
): CalendarEvent[] {
  const pairCurrencies = new Set([base, quote]);
  if (base === "XAU") pairCurrencies.add("USD");
  const sev = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  const floor = sev[impactFloor];
  return events.filter(e =>
    pairCurrencies.has(e.country) &&
    sev[e.impact] >= floor &&
    Math.abs(e.minutesFromNow) <= withinMinutes,
  );
}

// ─── upcomingFor — used by the dashboard pair detail view ───────────────────
export function upcomingFor(
  events: CalendarEvent[],
  base: string,
  quote: string,
  withinHours = 24,
): CalendarEvent[] {
  const ccys = new Set([base, quote]);
  if (base === "XAU") ccys.add("USD");
  return events
    .filter(e => ccys.has(e.country))
    .filter(e => {
      if (e.minutesFromNow < -5 && e.minutesFromNow >= -180) {
        return e.impact === "HIGH" || e.impact === "MEDIUM";
      }
      return e.minutesFromNow > -5 && e.minutesFromNow <= withinHours * 60;
    })
    .sort((a, b) => a.minutesFromNow - b.minutesFromNow)
    .slice(0, 20);
}
