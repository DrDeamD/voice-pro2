// ============================================================================
// Context Fetcher v3.8 — TradingView primary + FRED fallback
//
// Strategy:
//   1. Run TradingView scanner first (fast, gives weekly % change directly).
//   2. For any indicator that came back null, fall back to FRED.
//   3. FRED is daily-frequency, so when used we compute change from
//      day-over-day instead of week-over-week. This is a different metric
//      but still directionally informative; we tag the source on the output.
//
// The sourceUsed map lets the dashboard show which provider produced each
// indicator. If TradingView is degraded (rate limit / format change), the
// system continues to operate on FRED data with no silent failure.
// ============================================================================
import { httpJSON } from "../http.js";
import { TTL } from "../config.js";
import { fetchFredContext } from "./fred.js";

const TV_GLOBAL = "https://scanner.tradingview.com/global/scan";

export interface ContextChanges {
  dxy: number | null;
  gold: number | null;
  oil: number | null;
  vix: number | null;
  y10: number | null;
  dxyLevel?: number | null;
  vixLevel?: number | null;
  y10Level?: number | null;
  // v3.8 — provenance per indicator: "tv" | "fred" | "missing"
  sourceUsed?: {
    dxy: "tv" | "fred" | "missing";
    gold: "tv" | "fred" | "missing";
    oil: "tv" | "fred" | "missing";
    vix: "tv" | "fred" | "missing";
    y10: "tv" | "fred" | "missing";
  };
}

async function fetchTradingViewContext(): Promise<ContextChanges> {
  const tickers = [
    "TVC:DXY",
    "TVC:VIX",
    "TVC:US10Y",
    "COMEX:GC1!",
    "NYMEX:CL1!",
  ];
  const body = JSON.stringify({
    symbols: { tickers, query: { types: [] } },
    columns: ["close", "change", "Perf.W", "Perf.1M"],
  });
  const res = await httpJSON<any>(TV_GLOBAL, {
    method: "POST", body,
    headers: { "Content-Type": "application/json" },
    cacheKey: "ctx:tv-global", ttlSec: TTL.CONTEXT,
    source: "tv_context", timeoutMs: 5000,
  });

  const out: ContextChanges = {
    dxy: null, gold: null, oil: null, vix: null, y10: null,
    dxyLevel: null, vixLevel: null, y10Level: null,
  };
  if (!res || !Array.isArray(res.data)) return out;

  for (const row of res.data) {
    const s: string = row.s;
    const d: any[] = row.d || [];
    const close = Number(d[0]);
    const perfW = Number(d[2]);
    if (!isFinite(close)) continue;
    if (s === "TVC:DXY") {
      out.dxy = isFinite(perfW) ? perfW : null;
      out.dxyLevel = close;
    } else if (s === "TVC:VIX") {
      out.vix = isFinite(perfW) ? perfW : null;
      out.vixLevel = close;
    } else if (s === "TVC:US10Y") {
      out.y10 = isFinite(perfW) ? perfW : null;
      out.y10Level = close;
    } else if (s === "COMEX:GC1!") {
      out.gold = isFinite(perfW) ? perfW : null;
    } else if (s === "NYMEX:CL1!") {
      out.oil = isFinite(perfW) ? perfW : null;
    }
  }
  return out;
}

/** Public — fetches TV first, falls back to FRED for any missing indicator. */
export async function fetchContext(): Promise<ContextChanges> {
  const tv = await fetchTradingViewContext();
  const sourceUsed: NonNullable<ContextChanges["sourceUsed"]> = {
    dxy: tv.dxy != null ? "tv" : "missing",
    gold: tv.gold != null ? "tv" : "missing",
    oil: tv.oil != null ? "tv" : "missing",
    vix: tv.vix != null ? "tv" : "missing",
    y10: tv.y10 != null ? "tv" : "missing",
  };

  // Fast path: TV gave us everything.
  const allOk =
    tv.dxy != null && tv.gold != null && tv.oil != null &&
    tv.vix != null && tv.y10 != null;
  if (allOk) {
    return { ...tv, sourceUsed };
  }

  // Slow path: pull FRED to fill gaps.
  const fred = await fetchFredContext().catch(() => null);
  if (!fred || !fred.anyAvailable) {
    return { ...tv, sourceUsed };
  }

  const merged: ContextChanges = { ...tv, sourceUsed };

  if (merged.dxy == null && fred.dxyChangePct != null) {
    merged.dxy = fred.dxyChangePct;
    merged.dxyLevel = fred.dxyProxy;
    sourceUsed.dxy = "fred";
  }
  if (merged.vix == null && fred.vixChangePct != null) {
    merged.vix = fred.vixChangePct;
    merged.vixLevel = fred.vix;
    sourceUsed.vix = "fred";
  }
  if (merged.y10 == null && fred.us10yChangePct != null) {
    merged.y10 = fred.us10yChangePct;
    merged.y10Level = fred.us10y;
    sourceUsed.y10 = "fred";
  }
  if (merged.gold == null && fred.goldChangePct != null) {
    merged.gold = fred.goldChangePct;
    sourceUsed.gold = "fred";
  }
  if (merged.oil == null && fred.oilChangePct != null) {
    merged.oil = fred.oilChangePct;
    sourceUsed.oil = "fred";
  }

  return merged;
}
