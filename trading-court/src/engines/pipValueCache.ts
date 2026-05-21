// ============================================================================
// Pip Value Cache — v4.1 Phase 1
//
// Why this exists:
//   For cross-pairs (EUR/JPY, EUR/GBP, ...), the pip value in USD depends on
//   the USD-rate of the QUOTE currency. Examples:
//     EUR/JPY 1 pip = 0.01 JPY × 100,000 = 1000 JPY → USD = 1000 / USDJPY
//     EUR/GBP 1 pip = 0.0001 GBP × 100,000 = 10 GBP → USD = 10 × GBPUSD
//
//   The previous lot-size code in tradePlan.ts and structuralRR.ts returned
//   `null` for crosses, which forced lot sizing to be skipped entirely. With
//   real cross-pair support, we need a live source of helper rates.
//
// How it works:
//   1. fetchQuote() calls recordQuote() after every successful fetch.
//   2. The cache stores {symbol → {quote, recordedTs}} with a 2-minute TTL.
//   3. computeCrossPipUSD() looks up the helper pair (USDJPY for JPY-quoted
//      crosses, GBPUSD for GBP-quoted, etc.) and computes pip value.
//
// Failure policy:
//   - Helper rate missing or stale → returns null. Caller (buildPlan etc.)
//     must set lotSizePer1Pct = null and add an explanatory note. NEVER
//     fabricates a value.
//   - Cold start: first snapshot may have null lot size for crosses. By the
//     second snapshot (15s later), all helper rates are cached. This is
//     documented behavior, not a bug.
//
// Threading:
//   Single-process Node.js — no concurrent writes to the Map.
// ============================================================================

import type { Quote } from "../types/index.js";

interface CacheEntry {
  quote: Quote;
  recordedTs: number;
}

const cache = new Map<string, CacheEntry>();

// 2 minutes. Snapshot cycle is 15s default / 4s rapid mode, so a helper rate
// that was fetched within the last 8 cycles is acceptable. Beyond that the
// price has likely moved enough to make the pip-value calc misleading.
const MAX_AGE_MS = 120_000;

/** Called by fetchQuote on every successful fetch. */
export function recordQuote(symbol: string, quote: Quote): void {
  if (!quote || !quote.available) return;
  if (!Number.isFinite(quote.mid) || quote.mid <= 0) return;
  cache.set(symbol.toUpperCase(), { quote, recordedTs: Date.now() });
}

/** Returns latest cached quote for a symbol, or null if missing/stale. */
export function getCachedQuote(
  symbol: string,
  now: number = Date.now(),
): { mid: number; ageSec: number } | null {
  const entry = cache.get(symbol.toUpperCase());
  if (!entry) return null;
  const ageMs = now - entry.recordedTs;
  if (ageMs > MAX_AGE_MS) return null;
  return { mid: entry.quote.mid, ageSec: Math.round(ageMs / 1000) };
}

export interface CrossPipResult {
  /** USD value of one pip per one standard lot (100k base units). */
  pipUsdPerLot: number;
  /** Always "computed_from_usdpair" when this returns a value. */
  source: "computed_from_usdpair";
  /** Which helper pair was used (e.g. "USDJPY"). */
  helperPair: string;
  /** Mid rate of the helper pair used in the calculation. */
  helperRate: number;
  /** Age in seconds of the helper rate. */
  helperAgeSec: number;
}

/**
 * Compute pip value in USD for one standard lot of a cross-pair.
 *
 * Returns null when:
 *   - base or quote is USD (caller should use the existing direct-pair logic)
 *   - the helper rate is not cached or has expired
 *   - the computation produces a non-finite or non-positive value
 *
 * The caller MUST treat null as "lot size cannot be determined right now" and
 * surface that to the user honestly, not substitute a default.
 */
export function computeCrossPipUSD(
  base: string,
  quote: string,
  pip: number,
  now: number = Date.now(),
): CrossPipResult | null {
  // Refuse if either side is USD — caller should use direct logic.
  if (base === "USD" || quote === "USD") return null;
  // Refuse for XAU (different contract size, handled separately).
  if (base === "XAU" || quote === "XAU") return null;

  // Pick helper pair based on QUOTE currency. The rule:
  //   - If quote is one of {JPY, CHF, CAD}, the USD pair is USD<QUOTE>
  //     and we DIVIDE (pip is denominated in quote → convert to USD by
  //     dividing by units-of-quote-per-USD which equals USD<QUOTE>).
  //   - If quote is one of {GBP, EUR, AUD, NZD}, the USD pair is <QUOTE>USD
  //     and we MULTIPLY.
  let helperPair: string;
  let mode: "div" | "mul";
  switch (quote) {
    case "JPY": helperPair = "USDJPY"; mode = "div"; break;
    case "CHF": helperPair = "USDCHF"; mode = "div"; break;
    case "CAD": helperPair = "USDCAD"; mode = "div"; break;
    case "GBP": helperPair = "GBPUSD"; mode = "mul"; break;
    case "EUR": helperPair = "EURUSD"; mode = "mul"; break;
    case "AUD": helperPair = "AUDUSD"; mode = "mul"; break;
    default: return null;  // unsupported quote currency
  }

  const helper = getCachedQuote(helperPair, now);
  if (!helper) return null;

  let pipUsdPerLot: number;
  if (mode === "div") {
    pipUsdPerLot = (pip * 100_000) / helper.mid;
  } else {
    pipUsdPerLot = pip * 100_000 * helper.mid;
  }

  if (!Number.isFinite(pipUsdPerLot) || pipUsdPerLot <= 0) return null;

  return {
    pipUsdPerLot,
    source: "computed_from_usdpair",
    helperPair,
    helperRate: helper.mid,
    helperAgeSec: helper.ageSec,
  };
}

// ─── Test helpers (do not call from production code) ────────────────────────
/** Test-only: clear the cache between unit tests. */
export function _clearCache(): void {
  cache.clear();
}

/** Test-only: inspect current cache contents. */
export function _cacheSnapshot(): Array<{ symbol: string; mid: number; ageMs: number }> {
  const now = Date.now();
  return Array.from(cache.entries()).map(([symbol, entry]) => ({
    symbol,
    mid: entry.quote.mid,
    ageMs: now - entry.recordedTs,
  }));
}
