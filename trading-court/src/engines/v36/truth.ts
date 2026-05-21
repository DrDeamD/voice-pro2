// ============================================================================
// Trading Court Pro v3.6 — Data Truth Gate
// Blocks fake/synthetic/stale/malformed candle streams before statistical use.
// ============================================================================

import type { CandleSeries, Quote } from "../../types/index.js";
import type { V36TruthResult } from "./statTypes.js";

const REQUIRED = ["5m", "15m", "1h", "4h"] as const;

function validCandles(series: CandleSeries | undefined): boolean {
  if (!series?.available || !Array.isArray(series.candles) || series.candles.length === 0) return false;

  for (let i = 0; i < series.candles.length; i++) {
    const c = series.candles[i];
    if (![c.t, c.o, c.h, c.l, c.c].every(Number.isFinite)) return false;
    if (c.o <= 0 || c.h <= 0 || c.l <= 0 || c.c <= 0) return false;
    if (c.h < c.l) return false;
    if (c.o > c.h || c.o < c.l || c.c > c.h || c.c < c.l) return false;
    if (i > 0 && c.t <= series.candles[i - 1].t) return false;
  }

  return true;
}

function isSyntheticOrPseudo(series: CandleSeries | undefined): boolean {
  const source = `${series?.source ?? ""} ${series?.note ?? ""}`.toLowerCase();
  return (
    source.includes("synthetic") ||
    source.includes("synth(") ||
    source.includes("audusd proxy") ||
    (source.includes("audusd") && source.includes("nzd")) ||
    source.includes("pt5h") ||
    source.includes("closest to h4")
  );
}

export function v36TruthGate(
  symbol: string,
  quote: Quote,
  series: Record<string, CandleSeries>,
  nowMs?: number,
): V36TruthResult {
  // nowMs (v4.0 priority 2-alt): when provided, freshness checks are
  // anchored to this timestamp instead of Date.now(). Used by the
  // backtest replay so historical candles are not flagged stale.
  // Production callers do not pass nowMs, so behavior is unchanged.
  const now = nowMs ?? Date.now();
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (!quote.available) reasons.push("v36_quote_unavailable");
  if (!Number.isFinite(quote.bid) || !Number.isFinite(quote.ask) || quote.bid <= 0 || quote.ask <= 0 || quote.ask < quote.bid) {
    reasons.push("v36_quote_invalid_bid_ask");
  }

  const quoteAgeSec = quote.available ? Math.max(0, (now - quote.ts) / 1000) : Infinity;
  if (quoteAgeSec > 120) reasons.push(`v36_quote_stale_${Math.round(quoteAgeSec)}s`);

  for (const tf of REQUIRED) {
    const s = series[tf];

    if (!validCandles(s)) {
      reasons.push(`v36_${tf}_candles_invalid_or_missing`);
      continue;
    }

    if (isSyntheticOrPseudo(s)) {
      reasons.push(`v36_${tf}_source_not_truth_contract:${s?.source ?? "unknown"}`);
      continue;
    }

    const last = s.candles[s.candles.length - 1];
    const ageSec = Math.max(0, now / 1000 - last.t);

    const maxAge =
      tf === "5m" ? 15 * 60 :
      tf === "15m" ? 40 * 60 :
      tf === "1h" ? 3 * 60 * 60 :
      8 * 60 * 60;

    if (ageSec > maxAge) reasons.push(`v36_${tf}_stale_${Math.round(ageSec / 60)}m`);
  }

  // H4 from Investing PT5H is blocked by isSyntheticOrPseudo. H4 resample from real H1 is allowed
  // because it is deterministic and source-labelled "+resample4h".
  for (const tf of REQUIRED) {
    const s = series[tf];
    if (s?.source?.includes("+resample4h")) warnings.push(`v36_${tf}_resampled_from_real_h1`);
  }

  return {
    ok: reasons.length === 0,
    reasons,
    warnings,
  };
}
