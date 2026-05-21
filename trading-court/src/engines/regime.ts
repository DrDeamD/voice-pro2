// ============================================================================
// Regime Engine — trend/range/volatile/dead classifier
//
// v4.0 priority 3a-bis (D4) — added MARKET_CLOSED detection helpers for XAU/USD.
//   Spot gold markets close on retail FX brokers during a daily low-liquidity
//   window (21:00-23:00 UTC). Our PAXG-based candle sources (Kraken, Coinbase)
//   trade 24/7, but spot quote sources (swissquote) freeze during this window,
//   leaving the regime classifier with stale price data → emits UNKNOWN.
//   The new helpers let callers tag these verdicts as MARKET_CLOSED instead,
//   which is honest labeling and keeps the journal cleaner for later analysis.
// ============================================================================
import { RULES } from "../config.js";
import type { IndicatorBlock, RegimeReport } from "../types/index.js";

export function classifyRegime(ind: IndicatorBlock): RegimeReport {
  const { adx14: adx, atr14: atr, lastClose: price, bbWidth: bbw, ema20, ema50, ema200 } = ind;

  const atrPct = atr != null && price ? (atr / price) * 100 : null;
  const bbPct = bbw != null ? bbw * 100 : null;

  if (adx == null || price == null || ema50 == null) {
    return { label: "UNKNOWN", adx, atrPct, bbWidthPct: bbPct, reasoning: "Indicator data insufficient." };
  }

  const deadAdx = adx < RULES.adxDeadBelow;
  const deadAtr = atrPct != null && atrPct < RULES.atrDeadPct;
  const deadBb = bbPct != null && bbPct < RULES.bbDeadPct;

  if (deadAdx && (deadAtr || deadBb)) {
    return {
      label: "DEAD", adx, atrPct, bbWidthPct: bbPct,
      reasoning: `Dead market: ADX ${adx.toFixed(1)} < ${RULES.adxDeadBelow}, ATR ${atrPct?.toFixed(3)}% / BB ${bbPct?.toFixed(2)}% compressed.`,
    };
  }
  if (deadAdx && atrPct != null && atrPct > RULES.atrDeadPct * 10) {
    return {
      label: "VOLATILE", adx, atrPct, bbWidthPct: bbPct,
      reasoning: `Choppy volatility: ATR ${atrPct.toFixed(3)}% high but ADX ${adx.toFixed(1)} low.`,
    };
  }
  if (adx >= RULES.adxTrendAbove && ema20 != null && ema200 != null) {
    if (ema20 > ema50 && ema50 > ema200 && price > ema50) {
      return {
        label: "TREND_UP", adx, atrPct, bbWidthPct: bbPct,
        reasoning: `Trending up: ADX ${adx.toFixed(1)}, EMA stack bullish, price above EMA50.`,
      };
    }
    if (ema20 < ema50 && ema50 < ema200 && price < ema50) {
      return {
        label: "TREND_DOWN", adx, atrPct, bbWidthPct: bbPct,
        reasoning: `Trending down: ADX ${adx.toFixed(1)}, EMA stack bearish, price below EMA50.`,
      };
    }
  }
  return {
    label: "RANGE", adx, atrPct, bbWidthPct: bbPct,
    reasoning: `Range/indecision: ADX ${adx.toFixed(1)}, EMA structure mixed.`,
  };
}

/**
 * Regime score — GRADUAL (NEW Priorität 3):
 * Replaces binary ±70 with ADX-proportional value.
 * Formula: score = (adx / 50) × 80 × direction
 * ADX 50 → ±80, ADX 25 → ±40, ADX 15 → ±24
 * RANGE/VOLATILE/DEAD/UNKNOWN/MARKET_CLOSED → 0 (unchanged)
 */
export function regimeScore(r: RegimeReport): number {
  const adx = r.adx ?? 0;
  const adxClamped = Math.max(0, Math.min(50, adx));
  const magnitude = (adxClamped / 50) * 80;

  switch (r.label) {
    case "TREND_UP":   return Math.round(magnitude);
    case "TREND_DOWN": return -Math.round(magnitude);
    default:           return 0;
  }
}

// ============================================================================
// v4.0 priority 3a-bis (D4) — MARKET_CLOSED detection for XAU/USD
//
// Background:
//   Production journal showed XAU/USD producing regime=UNKNOWN for ~35% of
//   ASIA-session verdicts (19/54 in 2-day sample). Investigation chased
//   four wrong hypotheses (timeout, kraken config, etc.) before user
//   provided the actual root cause: retail FX brokers (MT5, swissquote)
//   close spot gold trading during a daily low-liquidity window. PAXG
//   crypto-backed candles (Kraken, Coinbase) work fine 24/7, but our spot
//   quote source freezes, leaving the indicator pipeline with stale price.
//
// Empirical evidence:
//   - User MT5 screenshot (Wed 2026-05-06 23:42 CEST): XAU last update at
//     23:49:59, FX pairs all updating at 00:42:xx. XAU was frozen ~52
//     minutes despite the broker still serving the symbol.
//   - Production journal: 19 ASIA UNKNOWN verdicts, all timestamps in
//     21:04-21:37 UTC. Last NON-UNKNOWN before window: 18:48 UTC.
//   - Pre-D4 fix: regime=UNKNOWN was emitted with no distinguishing
//     metadata, contaminating the baseline corpus for analysis.
//
// Window selection:
//   Conservative: 21:00 UTC to 23:00 UTC (2-hour window).
//   - Lower bound 21:00: matches NY equities close + spot gold maintenance
//   - Upper bound 23:00: ASIA Tokyo opens, liquidity returns
//   - Buffer at both ends keeps us out of edge-case mislabels
//
// Note on robustness:
//   This is a TIME-based heuristic. A more robust check would compare
//   quote.timestamp to (now - 5min) to detect actual freshness. That
//   requires plumbing quote into classifyRegime, which is a larger
//   refactor. Time-of-day is sufficient for v1 — the broker closure is
//   schedule-driven, not event-driven, so time is a good proxy.
//
// Symbol scope:
//   Only XAUUSD currently. Other instruments either trade 24/5 (FX majors,
//   no daily closure) or are not in the universe (futures, indices). When
//   we add new instruments, the closure logic per-symbol will need
//   per-instrument tuning.
// ============================================================================

/**
 * Returns true if the symbol is in a known low-liquidity / broker-closure
 * window. Currently only XAUUSD between 21:00 and 23:00 UTC.
 */
export function isInClosureWindow(symbol: string, now: Date): boolean {
  if (symbol !== "XAUUSD") return false;
  const utcMinutesOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  // 21:00 UTC = 1260 minutes, 23:00 UTC = 1380 minutes
  return utcMinutesOfDay >= 1260 && utcMinutesOfDay < 1380;
}

/**
 * Constructs a synthetic RegimeReport with label=MARKET_CLOSED for use
 * when the broker has frozen spot quotes during a closure window. We
 * preserve indicator data (especially adx) for downstream debugging,
 * but null out volatility metrics that would mislead during stale data.
 */
export function makeMarketClosedRegime(ind: IndicatorBlock): RegimeReport {
  return {
    label: "MARKET_CLOSED",
    adx: ind.adx14,        // preserved for diagnostics
    atrPct: null,          // null — volatility unreliable during stale data
    bbWidthPct: null,      // null — same reason
    reasoning: "XAU/USD spot market in low-liquidity closure window (21:00-23:00 UTC). Quote sources frozen.",
  };
}
