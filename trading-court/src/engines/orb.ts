// ============================================================================
// Opening Range Breakout (ORB) — v4.2 Phase 1
//
// Identifies the FIRST 60 minutes of the London session (07:00-08:00 UTC)
// and the NY session (13:00-14:00 UTC). Reports the high/low of that range,
// whether the current price has broken out, and the 1× extension target.
//
// Honest behaviour:
//   - If session hasn't started yet → status = "PENDING"
//   - If we're inside the opening hour → status = "FORMING"
//   - If 60 minutes after open and no break yet → "INSIDE"
//   - Detects fake breakouts (broke then returned inside).
// ============================================================================

import type { Candle } from "../types/index.js";

export type ORBStatus = "PENDING" | "FORMING" | "INSIDE" | "BROKE_HIGH" | "BROKE_LOW" | "FAKE_HIGH" | "FAKE_LOW";

export interface ORBSession {
  sessionName: "LONDON" | "NY";
  startUtcHour: number;
  /** Window high (formed during first hour). */
  high: number | null;
  /** Window low. */
  low: number | null;
  rangePips: number | null;
  /** 1× range extension above the high (target on bullish breakout). */
  targetHigh: number | null;
  /** 1× range extension below the low. */
  targetLow: number | null;
  status: ORBStatus;
  breakoutTimeUtc: string | null;
  /** Minutes from now until session window opens (negative if open/passed) */
  minutesUntilOpen: number;
  reasoning: string;
}

export interface ORBReport {
  london: ORBSession;
  ny: ORBSession;
}

function emptySession(name: "LONDON" | "NY", hour: number, minutesUntilOpen: number, reason: string): ORBSession {
  return {
    sessionName: name,
    startUtcHour: hour,
    high: null, low: null, rangePips: null,
    targetHigh: null, targetLow: null,
    status: "PENDING",
    breakoutTimeUtc: null,
    minutesUntilOpen,
    reasoning: reason,
  };
}

function pipDistance(a: number, b: number, pip: number): number {
  return Math.round(((a - b) / pip) * 10) / 10;
}

function computeORBSession(
  m15: Candle[],
  currentPrice: number,
  pip: number,
  now: Date,
  sessionName: "LONDON" | "NY",
  startHourUtc: number,
): ORBSession {
  const y = now.getUTCFullYear();
  const mo = now.getUTCMonth();
  const d = now.getUTCDate();
  const sessionStartTs = Date.UTC(y, mo, d, startHourUtc, 0, 0, 0) / 1000;
  const sessionEndTs = sessionStartTs + 3600; // first hour

  const nowTs = Math.floor(now.getTime() / 1000);
  const minutesUntilOpen = Math.round((sessionStartTs - nowTs) / 60);

  // Not yet open
  if (nowTs < sessionStartTs) {
    return emptySession(sessionName, startHourUtc, minutesUntilOpen,
      `${sessionName} session opens in ${minutesUntilOpen} minutes`);
  }

  // Bars that fall inside the opening hour
  const openingBars = m15.filter(c => c.t >= sessionStartTs && c.t < sessionEndTs);
  if (openingBars.length < 1) {
    return emptySession(sessionName, startHourUtc, minutesUntilOpen,
      `${sessionName} session open but no M15 candles in range yet`);
  }

  const high = Math.max(...openingBars.map(c => c.h));
  const low = Math.min(...openingBars.map(c => c.l));
  const range = high - low;
  if (range <= 0) {
    return emptySession(sessionName, startHourUtc, minutesUntilOpen, "Degenerate opening range");
  }
  const targetHigh = high + range;
  const targetLow = low - range;

  // Still inside the opening hour?
  if (nowTs < sessionEndTs) {
    return {
      sessionName, startUtcHour: startHourUtc,
      high, low,
      rangePips: pipDistance(high, low, pip),
      targetHigh, targetLow,
      status: "FORMING",
      breakoutTimeUtc: null,
      minutesUntilOpen,
      reasoning: `${sessionName} ORB forming: ${low.toFixed(5)}-${high.toFixed(5)} ` +
                 `(${pipDistance(high, low, pip)}p so far)`,
    };
  }

  // Post-opening: detect breakout via bars AFTER sessionEndTs
  const postBars = m15.filter(c => c.t >= sessionEndTs && c.t <= nowTs);
  let firstBreakHigh: Candle | null = null;
  let firstBreakLow: Candle | null = null;
  for (const c of postBars) {
    if (!firstBreakHigh && c.h > high) firstBreakHigh = c;
    if (!firstBreakLow && c.l < low) firstBreakLow = c;
    if (firstBreakHigh && firstBreakLow) break;
  }

  // Resolve current status
  let status: ORBStatus = "INSIDE";
  let breakoutTimeUtc: string | null = null;

  if (firstBreakHigh && firstBreakLow) {
    // Both sides broken — whichever happened first is the primary breakout
    if (firstBreakHigh.t < firstBreakLow.t) {
      status = currentPrice > high ? "BROKE_HIGH" : "FAKE_HIGH";
      breakoutTimeUtc = new Date(firstBreakHigh.t * 1000).toISOString();
    } else {
      status = currentPrice < low ? "BROKE_LOW" : "FAKE_LOW";
      breakoutTimeUtc = new Date(firstBreakLow.t * 1000).toISOString();
    }
  } else if (firstBreakHigh) {
    status = currentPrice > high ? "BROKE_HIGH" : "FAKE_HIGH";
    breakoutTimeUtc = new Date(firstBreakHigh.t * 1000).toISOString();
  } else if (firstBreakLow) {
    status = currentPrice < low ? "BROKE_LOW" : "FAKE_LOW";
    breakoutTimeUtc = new Date(firstBreakLow.t * 1000).toISOString();
  } else {
    status = "INSIDE";
  }

  let reasoning: string;
  switch (status) {
    case "BROKE_HIGH":
      reasoning = `${sessionName} ORB broken UPWARD at ${breakoutTimeUtc?.slice(11,16)} UTC. ` +
                  `Target ext ${targetHigh.toFixed(5)} (1× range above high).`;
      break;
    case "BROKE_LOW":
      reasoning = `${sessionName} ORB broken DOWNWARD at ${breakoutTimeUtc?.slice(11,16)} UTC. ` +
                  `Target ext ${targetLow.toFixed(5)} (1× range below low).`;
      break;
    case "FAKE_HIGH":
      reasoning = `${sessionName} ORB FAKE UPSIDE: broke high but price returned inside range. ` +
                  `Watch for downside continuation.`;
      break;
    case "FAKE_LOW":
      reasoning = `${sessionName} ORB FAKE DOWNSIDE: broke low but price returned inside range. ` +
                  `Watch for upside continuation.`;
      break;
    case "INSIDE":
    default:
      reasoning = `${sessionName} ORB ${low.toFixed(5)}-${high.toFixed(5)} ` +
                  `(${pipDistance(high, low, pip)}p) — price still inside range.`;
  }

  return {
    sessionName, startUtcHour: startHourUtc,
    high, low,
    rangePips: pipDistance(high, low, pip),
    targetHigh, targetLow,
    status,
    breakoutTimeUtc,
    minutesUntilOpen,
    reasoning,
  };
}

export function computeORB(m15: Candle[], currentPrice: number, pip: number, now: Date = new Date()): ORBReport {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return {
      london: emptySession("LONDON", 7, 0, "Current price unavailable"),
      ny: emptySession("NY", 13, 0, "Current price unavailable"),
    };
  }
  return {
    london: computeORBSession(m15, currentPrice, pip, now, "LONDON", 7),
    ny: computeORBSession(m15, currentPrice, pip, now, "NY", 13),
  };
}
