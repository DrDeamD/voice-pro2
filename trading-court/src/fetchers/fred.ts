// ============================================================================
// FRED (Federal Reserve Economic Data) Fetcher — v3.8
//
// Provides daily-frequency context indicators directly from the St. Louis
// Federal Reserve. NO API KEY REQUIRED for the public CSV graph endpoint:
//   https://fred.stlouisfed.org/graph/fredgraph.csv?id=<SERIES_ID>
//
// Why this exists in v3.8:
//   1. TradingView Scanner is the current primary for DXY/VIX/Oil/Gold/US10Y.
//      It works but is a third-party redirect through TV's scanner API. When
//      it fails (rate limit, format change), the system loses cross-market
//      context entirely.
//   2. FRED is the underlying data source for many of those indicators in
//      the first place — going direct removes a redundant hop.
//   3. Daily frequency is sufficient for context (DXY/US10Y are not used
//      for intraday triggers; they set bias).
//
// FRED series IDs used:
//   DTWEXBGS   Trade-Weighted U.S. Dollar Index (broad, daily) — DXY proxy
//   DGS10      10-Year Treasury Constant Maturity Rate
//   DGS2       2-Year Treasury (curve slope context)
//   VIXCLS     CBOE Volatility Index
//   DCOILWTICO WTI Crude Oil Spot Price
//   GOLDPMGBD228NLBM   Gold Fixing Price (London PM, USD)
//   DFF        Federal Funds Effective Rate
//
// Note on DXY: FRED does NOT publish ICE DXY directly (ICE owns it). DTWEXBGS
// is the Fed's own Trade-Weighted USD Broad Index. The two are correlated
// (~0.95 rolling) but not identical. For directional bias they are
// interchangeable; for absolute level they are not. Documented honestly.
// ============================================================================

import { httpText } from "../http.js";
import { TTL } from "../config.js";

const FRED_BASE = "https://fred.stlouisfed.org/graph/fredgraph.csv";

export interface FredObservation {
  date: string;       // "YYYY-MM-DD"
  value: number | null; // null when FRED returned "."
}

export interface FredSeries {
  seriesId: string;
  observations: FredObservation[];
  latestValue: number | null;
  latestDate: string | null;
  changePctDayOverDay: number | null; // last vs previous valid observation
}

/** Fetch a single FRED series as parsed observations. */
export async function fetchFredSeries(seriesId: string): Promise<FredSeries | null> {
  const url = `${FRED_BASE}?id=${encodeURIComponent(seriesId)}`;
  const csv = await httpText(url, {
    cacheKey: `fred:${seriesId}`,
    ttlSec: TTL.CONTEXT,
    source: `fred_${seriesId.toLowerCase()}`,
    timeoutMs: 8000,
    retries: 1,
  });
  if (!csv) return null;

  // CSV header is "DATE,<seriesId>" then observations.
  // Missing values are encoded as ".".
  const lines = csv.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;

  // First line is header — skip.
  const observations: FredObservation[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length < 2) continue;
    const date = parts[0].trim();
    const raw = parts[1].trim();
    const value = raw === "." || raw === "" ? null : Number(raw);
    if (raw !== "." && raw !== "" && !Number.isFinite(value)) continue;
    observations.push({ date, value: Number.isFinite(value) ? (value as number) : null });
  }

  // Latest = last observation with a finite value.
  let latestValue: number | null = null;
  let latestDate: string | null = null;
  let prevValue: number | null = null;
  for (let i = observations.length - 1; i >= 0; i--) {
    if (observations[i].value != null) {
      if (latestValue == null) {
        latestValue = observations[i].value;
        latestDate = observations[i].date;
      } else {
        prevValue = observations[i].value;
        break;
      }
    }
  }

  let changePct: number | null = null;
  if (latestValue != null && prevValue != null && prevValue !== 0) {
    changePct = ((latestValue - prevValue) / Math.abs(prevValue)) * 100;
  }

  return {
    seriesId,
    observations,
    latestValue,
    latestDate,
    changePctDayOverDay: changePct,
  };
}

// ─── Series registry ────────────────────────────────────────────────────────
export const FRED_SERIES = {
  DXY_PROXY: "DTWEXBGS",
  US10Y: "DGS10",
  US2Y: "DGS2",
  VIX: "VIXCLS",
  OIL_WTI: "DCOILWTICO",
  GOLD_LBMA_PM: "GOLDPMGBD228NLBM",
  FED_FUNDS: "DFF",
} as const;

// ─── Bundle fetcher ─────────────────────────────────────────────────────────
export interface FredContextBundle {
  dxyProxy: number | null;
  dxyChangePct: number | null;
  us10y: number | null;
  us10yChangePct: number | null;
  us2y: number | null;
  curveSlope2s10s: number | null;
  vix: number | null;
  vixChangePct: number | null;
  oil: number | null;
  oilChangePct: number | null;
  goldLbmaPm: number | null;
  goldChangePct: number | null;
  fedFunds: number | null;
  /** Map seriesId → ISO date of latest observation. Allows the dashboard to
   *  show a freshness pill (e.g. "FRED data: 2026-05-04 — 1 day stale"). */
  latestDates: Record<string, string | null>;
  /** True when at least one core series fetched successfully. */
  anyAvailable: boolean;
}

export async function fetchFredContext(): Promise<FredContextBundle> {
  const ids = Object.values(FRED_SERIES);
  const results = await Promise.all(ids.map(id => fetchFredSeries(id).catch(() => null)));
  const map = new Map<string, FredSeries | null>();
  for (let i = 0; i < ids.length; i++) map.set(ids[i], results[i]);

  const get = (key: keyof typeof FRED_SERIES): FredSeries | null =>
    map.get(FRED_SERIES[key]) ?? null;

  const dxy = get("DXY_PROXY");
  const us10y = get("US10Y");
  const us2y = get("US2Y");
  const vix = get("VIX");
  const oil = get("OIL_WTI");
  const gold = get("GOLD_LBMA_PM");
  const ff = get("FED_FUNDS");

  const slope = us10y?.latestValue != null && us2y?.latestValue != null
    ? Number((us10y.latestValue - us2y.latestValue).toFixed(3))
    : null;

  const latestDates: Record<string, string | null> = {};
  for (const id of ids) latestDates[id] = map.get(id)?.latestDate ?? null;

  const anyAvailable =
    dxy?.latestValue != null ||
    us10y?.latestValue != null ||
    vix?.latestValue != null ||
    oil?.latestValue != null ||
    gold?.latestValue != null;

  return {
    dxyProxy: dxy?.latestValue ?? null,
    dxyChangePct: dxy?.changePctDayOverDay ?? null,
    us10y: us10y?.latestValue ?? null,
    us10yChangePct: us10y?.changePctDayOverDay ?? null,
    us2y: us2y?.latestValue ?? null,
    curveSlope2s10s: slope,
    vix: vix?.latestValue ?? null,
    vixChangePct: vix?.changePctDayOverDay ?? null,
    oil: oil?.latestValue ?? null,
    oilChangePct: oil?.changePctDayOverDay ?? null,
    goldLbmaPm: gold?.latestValue ?? null,
    goldChangePct: gold?.changePctDayOverDay ?? null,
    fedFunds: ff?.latestValue ?? null,
    latestDates,
    anyAvailable,
  };
}
