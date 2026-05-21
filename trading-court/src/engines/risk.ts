// ============================================================================
// Risk Engine — multi-gate veto system
// ============================================================================
import { RULES } from "../config.js";
import type {
  CalendarEvent, Direction, EngineScores, MTFReport, NewsReport, RegimeReport,
  RiskReport, TradePlan,
} from "../types/index.js";
import { eventsAffecting } from "../fetchers/calendar.js";

export function evaluateRisk(
  base: string,
  quote: string,
  direction: Direction,
  scores: EngineScores,
  regime: RegimeReport,
  news: NewsReport,
  plan: TradePlan,
  atrValue: number | null,
  calendarEvents: CalendarEvent[],
  rrFloor: number = RULES.minRR,
): RiskReport {
  const reasons: string[] = [];
  let passed = true;
  let calendarBlocked = false;
  const calLines: string[] = [];

  if (scores.confidence < RULES.minConfidence) {
    passed = false;
    reasons.push(`Composite confidence ${scores.confidence.toFixed(0)} < threshold ${RULES.minConfidence.toFixed(0)}`);
  }

  if (direction === "FLAT") {
    passed = false;
    reasons.push("No clear directional bias (FLAT)");
  }

  const rr = plan.rr1;
  if (rr == null || rr < rrFloor) {
    passed = false;
    reasons.push(`RR ${rr == null ? "n/a" : rr.toFixed(2)} below minimum ${rrFloor.toFixed(2)}`);
  }

  if (regime.label === "DEAD" || regime.label === "UNKNOWN") {
    passed = false;
    reasons.push(`Regime ${regime.label} – no tradable structure`);
  }
  if (regime.label === "VOLATILE") {
    passed = false;
    reasons.push("Regime VOLATILE – chop without trend, stand down");
  }

  if (direction === "LONG" && news.pairScore <= -40) {
    passed = false;
    reasons.push(`News strongly bearish (${news.pairScore.toFixed(0)}) while setup is LONG – conflict veto`);
  }
  if (direction === "SHORT" && news.pairScore >= 40) {
    passed = false;
    reasons.push(`News strongly bullish (${news.pairScore.toFixed(0)}) while setup is SHORT – conflict veto`);
  }

  if (news.highImpactPending) {
    passed = false;
    reasons.push("High-impact event recently released / pending – stand down");
  }

  // Calendar gate v3.3.1:
  //   1) HIGH events within ±90min  → BLOCK
  //   2) MEDIUM events within ±30min → BLOCK (soft)
  const highBlocking = eventsAffecting(
    calendarEvents, base, quote,
    RULES.calendarBlockMinutes,
    RULES.calendarBlockImpactFloor,
  );
  const mediumBlocking = eventsAffecting(
    calendarEvents, base, quote,
    RULES.calendarSoftBlockMinutes,
    RULES.calendarSoftBlockImpactFloor,
  ).filter(e => e.impact === "MEDIUM"); // exclude HIGH (already covered above)

  const affecting = [...highBlocking, ...mediumBlocking];
  if (affecting.length > 0) {
    calendarBlocked = true;
    passed = false;
    for (const e of affecting.slice(0, 5)) {
      const mins = Math.round(e.minutesFromNow);
      const tag = mins >= 0 ? `in ${mins}min` : `${-mins}min ago`;
      calLines.push(`${e.impact} ${e.country} ${e.title} (${tag})`);
    }
    reasons.push(`Calendar block: ${affecting.length} event(s) within window: ${calLines.join("; ")}`);
  }

  if (atrValue == null || atrValue <= 0) {
    passed = false;
    reasons.push("ATR unavailable – cannot size risk");
  }

  if (direction === "LONG" && regime.label === "TREND_DOWN") {
    passed = false;
    reasons.push("Trading LONG against TREND_DOWN regime – veto");
  }
  if (direction === "SHORT" && regime.label === "TREND_UP") {
    passed = false;
    reasons.push("Trading SHORT against TREND_UP regime – veto");
  }

  return {
    passed, reasons,
    atrUsed: atrValue,
    calendarBlocked,
    calendarEvents: calLines,
  };
}
