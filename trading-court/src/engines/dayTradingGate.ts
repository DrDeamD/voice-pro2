// ============================================================================
// Day-Trading EOD Gate (v3.7c)
// Hard rule of the system: every trade must close in the same UTC trading day.
// Therefore: do not open a new position if it cannot realistically reach TP1
// before NY close (21:00 UTC).
//
// Design:
//   1. timeToCloseHours = (21:00 UTC today - now)
//   2. < 1.5h → hard veto, no exceptions. Slippage on close is worse than skip.
//   3. < 3.0h → require STRONG/VALID tier AND tight setup (stopPips ≤ 30 for FX,
//              ≤ 80 for XAU). Rationale: only fast-moving setups realistic.
//   4. ≥ 3.0h → no constraint from this gate.
//
// Friday cut-off: after 19:00 UTC Friday, hard veto regardless of hours-left,
// because weekend gap risk dominates. The user closes everything before
// weekend per his stated rules.
//
// This gate runs AFTER evaluateRisk and AFTER breakingNews/killZone vetoes.
// It can only veto further; it cannot un-veto.
// ============================================================================
import type {
  ConfidenceTier,
  Direction,
  TradePlan,
} from "../types/index.js";

export interface DayTradingGateInput {
  now: Date;
  direction: Direction;
  confidenceTier: ConfidenceTier;
  stopDistancePips: number | null;
  symbol: string;
}

export interface DayTradingGateResult {
  vetoed: boolean;
  reason: string | null;
  hoursToClose: number;
  warning: string | null;
}

// NY equity close ≈ 16:00 ET ≈ 21:00 UTC (DST shifts handled below).
// We use 21:00 UTC year-round as the policy cut-off because the user's rule
// is "same UTC trading day", not "follow NYSE DST". A simpler rule that the
// user can verify by clock is more useful than a perfectly DST-aware one.
const NY_CLOSE_HOUR_UTC = 21;

// Friday hard cut-off — after this, weekend gap risk eats RR1.
const FRIDAY_CUTOFF_HOUR_UTC = 19;

function hoursUntilNyClose(now: Date): number {
  const todayClose = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    NY_CLOSE_HOUR_UTC, 0, 0, 0,
  ));
  const diffMs = todayClose.getTime() - now.getTime();
  return diffMs / (1000 * 60 * 60);
}

function isFriday(now: Date): boolean {
  return now.getUTCDay() === 5;
}

function isWeekend(now: Date): boolean {
  const d = now.getUTCDay();
  return d === 0 || d === 6;
}

function tightSetupAllowed(stopPips: number | null, symbol: string): boolean {
  if (stopPips == null || stopPips <= 0) return false;
  if (symbol === "XAUUSD") return stopPips <= 80;
  return stopPips <= 30; // FX pairs
}

export function evaluateDayTradingGate(input: DayTradingGateInput): DayTradingGateResult {
  const { now, direction, confidenceTier, stopDistancePips, symbol } = input;

  if (direction === "FLAT") {
    return { vetoed: false, reason: null, hoursToClose: 0, warning: null };
  }

  if (isWeekend(now)) {
    return {
      vetoed: true,
      reason: "Day-trading gate: market is in weekend close — no entries.",
      hoursToClose: 0,
      warning: null,
    };
  }

  const h = hoursUntilNyClose(now);

  if (isFriday(now) && now.getUTCHours() >= FRIDAY_CUTOFF_HOUR_UTC) {
    return {
      vetoed: true,
      reason: `Day-trading gate: Friday after ${FRIDAY_CUTOFF_HOUR_UTC}:00 UTC — weekend gap risk veto.`,
      hoursToClose: h,
      warning: null,
    };
  }

  if (h <= 0) {
    return {
      vetoed: true,
      reason: "Day-trading gate: NY close already passed — same-day exit impossible.",
      hoursToClose: h,
      warning: null,
    };
  }

  if (h < 1.5) {
    return {
      vetoed: true,
      reason: `Day-trading gate: only ${h.toFixed(1)}h to NY close — insufficient time for TP1 to fill.`,
      hoursToClose: h,
      warning: null,
    };
  }

  if (h < 3.0) {
    const tierOk = confidenceTier === "STRONG" || confidenceTier === "VALID";
    const setupOk = tightSetupAllowed(stopDistancePips, symbol);

    if (!tierOk) {
      return {
        vetoed: true,
        reason: `Day-trading gate: ${h.toFixed(1)}h to close requires STRONG/VALID tier (got ${confidenceTier}).`,
        hoursToClose: h,
        warning: null,
      };
    }

    if (!setupOk) {
      const limit = symbol === "XAUUSD" ? 80 : 30;
      return {
        vetoed: true,
        reason: `Day-trading gate: ${h.toFixed(1)}h to close requires stop ≤ ${limit}p (got ${stopDistancePips ?? "n/a"}p).`,
        hoursToClose: h,
        warning: null,
      };
    }

    return {
      vetoed: false,
      reason: null,
      hoursToClose: h,
      warning: `Day-trading window: ${h.toFixed(1)}h to NY close — managing toward early TP1 recommended.`,
    };
  }

  return { vetoed: false, reason: null, hoursToClose: h, warning: null };
}

/** Attach the gate result onto the risk report and the plan notes. */
export function applyDayTradingGate(
  gate: DayTradingGateResult,
  risk: { passed: boolean; reasons: string[] },
  plan: TradePlan,
  warnings: string[],
): void {
  if (gate.vetoed && gate.reason) {
    risk.passed = false;
    risk.reasons.push(gate.reason);
    plan.notes.push(`EOD gate veto: ${gate.reason}`);
  }
  if (gate.warning) warnings.push(gate.warning);
}
