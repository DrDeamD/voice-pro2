// ============================================================================
// VWAP Engine — Volume-Weighted Average Price (Intraday + Rolling)
//
// NEW — Priorität 2
//
// VWAP ist der wichtigste institutionelle Intraday-Anker.
// Berechnet aus Kraken M5-Daten (OHLCV — volume ist verfügbar).
//
// Drei Varianten:
//   1) Tages-VWAP    — reset 00:00 UTC täglich
//   2) Session-VWAP  — reset bei Sessionsstart (London 07:00, NY 13:00)
//   3) Rolling-VWAP  — letzten 48 M5-Bars (=4h gleitend)
//
// Score-Logik:
//   Price >> VWAP (+) → bullisch (institutionelle Käufe)
//   Price << VWAP (-) → bärisch (institutionelle Verkäufe)
//   Price @ VWAP      → neutral / Entscheidungszone
// ============================================================================
import type { Candle } from "../types/index.js";

export interface VwapBand {
  vwap: number;
  upper1: number;   // VWAP + 1σ
  lower1: number;   // VWAP - 1σ
  upper2: number;   // VWAP + 2σ
  lower2: number;   // VWAP - 2σ
}

export interface VwapReport {
  daily: VwapBand | null;
  session: VwapBand | null;          // London or NY depending on current time
  rolling4h: number | null;          // Simple rolling VWAP (48 bars)
  currentPrice: number | null;
  positionVsDaily: "ABOVE" | "BELOW" | "AT" | null;
  positionVsSession: "ABOVE" | "BELOW" | "AT" | null;
  distancePct: number | null;        // % distance from daily VWAP
  score: number;                     // -100..+100
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Core VWAP computation with standard deviation bands
//
// REQUIRES real volume. If any candle lacks a positive volume, this returns
// null — VWAP is not defined without volume, and falling back to v=1 would
// silently degrade the output into a non-volume-weighted typical-price mean
// while still labeling it "VWAP". That would be a calculation lie.
// ---------------------------------------------------------------------------
function computeVwapBands(candles: Candle[]): VwapBand | null {
  if (!candles.length) return null;

  // Volume integrity check: VWAP is meaningless without real volume.
  for (const c of candles) {
    if (c.v == null || !Number.isFinite(c.v) || c.v <= 0) return null;
  }

  let cumPV = 0;   // Σ(typical_price × volume)
  let cumV = 0;    // Σ(volume)
  let cumPV2 = 0;  // Σ(typical_price² × volume) for variance

  for (const c of candles) {
    const tp = (c.h + c.l + c.c) / 3;   // typical price
    const v = c.v as number;             // guaranteed > 0 by check above
    cumPV += tp * v;
    cumV += v;
    cumPV2 += tp * tp * v;
  }

  if (cumV <= 0) return null;

  const vwap = cumPV / cumV;
  // Population variance: E[x²] - E[x]²
  const variance = Math.max(0, cumPV2 / cumV - vwap * vwap);
  const sd = Math.sqrt(variance);

  return {
    vwap,
    upper1: vwap + sd,
    lower1: vwap - sd,
    upper2: vwap + 2 * sd,
    lower2: vwap - 2 * sd,
  };
}

// ---------------------------------------------------------------------------
// Classify position relative to VWAP with tolerance band (±0.02%)
// ---------------------------------------------------------------------------
function classifyPosition(price: number, vwap: number): "ABOVE" | "BELOW" | "AT" {
  const tol = vwap * 0.0002;
  if (price > vwap + tol) return "ABOVE";
  if (price < vwap - tol) return "BELOW";
  return "AT";
}

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------
export function computeVwap(m5: Candle[], currentPrice: number): VwapReport {
  const empty: VwapReport = {
    daily: null, session: null, rolling4h: null,
    currentPrice, positionVsDaily: null, positionVsSession: null,
    distancePct: null, score: 0, reasoning: "Insufficient M5 data for VWAP",
  };

  if (!m5 || m5.length < 10) return empty;

  const nowTs = m5[m5.length - 1].t;
  const nowUtc = new Date(nowTs * 1000);
  const y = nowUtc.getUTCFullYear(), mo = nowUtc.getUTCMonth(), d = nowUtc.getUTCDate();

  // ----- Daily VWAP (00:00 UTC reset) -----
  const dayStartTs = Date.UTC(y, mo, d) / 1000;
  const dailyBars = m5.filter(c => c.t >= dayStartTs);
  const daily = computeVwapBands(dailyBars);

  // If the daily window had no real volume, return an honest empty report
  // instead of silently degrading downstream signals.
  if (!daily) {
    return {
      ...empty,
      reasoning: "VWAP unavailable: candle volume missing or non-positive",
    };
  }

  // ----- Session VWAP -----
  const h = nowUtc.getUTCHours();
  let sessionStartTs: number;
  if (h >= 13) {
    // NY session: reset at 13:00 UTC
    sessionStartTs = Date.UTC(y, mo, d, 13) / 1000;
  } else if (h >= 7) {
    // London session: reset at 07:00 UTC
    sessionStartTs = Date.UTC(y, mo, d, 7) / 1000;
  } else {
    // Asia session: reset at 00:00 UTC (same as daily)
    sessionStartTs = dayStartTs;
  }
  const sessionBars = m5.filter(c => c.t >= sessionStartTs);
  const session = computeVwapBands(sessionBars);

  // ----- Rolling 4h VWAP (last 48 M5 bars) -----
  const rolling48 = m5.slice(-48);
  const rollingBand = computeVwapBands(rolling48);
  const rolling4h = rollingBand?.vwap ?? null;

  // ----- Score calculation -----
  let score = 0;
  const parts: string[] = [];

  if (daily) {
    const posD = classifyPosition(currentPrice, daily.vwap);
    const distPct = ((currentPrice - daily.vwap) / daily.vwap) * 100;

    // Distance contribution: further above/below = stronger signal (max ±40)
    const distScore = Math.max(-40, Math.min(40, distPct * 8000));
    score += distScore;

    if (posD === "ABOVE") {
      parts.push(`Price ABOVE daily VWAP ${daily.vwap.toFixed(5)} (+${distPct.toFixed(3)}%) → bullish bias`);
      // Extra: price between VWAP and +1σ = ideal long zone
      if (currentPrice <= daily.upper1) parts.push("In VWAP +1σ zone — institutional buy zone");
      // Overextended: price above +2σ = potential mean reversion
      if (currentPrice > daily.upper2) { score -= 15; parts.push("CAUTION: price above VWAP +2σ (overextended)"); }
    } else if (posD === "BELOW") {
      parts.push(`Price BELOW daily VWAP ${daily.vwap.toFixed(5)} (${distPct.toFixed(3)}%) → bearish bias`);
      if (currentPrice >= daily.lower1) parts.push("In VWAP -1σ zone — institutional sell zone");
      if (currentPrice < daily.lower2) { score += 15; parts.push("CAUTION: price below VWAP -2σ (overextended)"); }
    } else {
      parts.push(`Price AT daily VWAP ${daily.vwap.toFixed(5)} — equilibrium / decision point`);
    }

    // Session VWAP alignment bonus
    if (session && session !== daily) {
      const posS = classifyPosition(currentPrice, session.vwap);
      if (posD === posS && posD !== "AT") {
        // Both VWAPs agree — stronger conviction
        score += posD === "ABOVE" ? 15 : -15;
        parts.push(`Session VWAP ${session.vwap.toFixed(5)} confirms ${posD} positioning`);
      } else if (posD !== posS && posS !== "AT") {
        // Conflict between daily and session VWAP — caution
        score *= 0.6;
        parts.push("Daily/Session VWAP conflict — reduce conviction");
      }
    }

    // Rolling VWAP momentum: if rolling > daily VWAP → recent buying pressure
    if (rolling4h != null && daily) {
      if (rolling4h > daily.vwap * 1.0001) {
        score += 8;
        parts.push("Rolling 4h VWAP above daily — recent upward momentum");
      } else if (rolling4h < daily.vwap * 0.9999) {
        score -= 8;
        parts.push("Rolling 4h VWAP below daily — recent downward momentum");
      }
    }

    const distancePct = ((currentPrice - daily.vwap) / daily.vwap) * 100;

    return {
      daily, session, rolling4h, currentPrice,
      positionVsDaily: classifyPosition(currentPrice, daily.vwap),
      positionVsSession: session ? classifyPosition(currentPrice, session.vwap) : null,
      distancePct: Math.round(distancePct * 10000) / 10000,
      score: Math.max(-100, Math.min(100, Math.round(score))),
      reasoning: parts.join(" | "),
    };
  }

  return empty;
}

export const vwapScore = (r: VwapReport): number => r.score;
