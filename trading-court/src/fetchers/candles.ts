// ============================================================================
// Candles Fetcher — v3.2
//
// Source priority chain (per symbol):
//   1) Kraken OHLC       — primary, free, real volume, M5-D1
//   2) Coinbase PAXG-USD — XAU/USD fallback only
//   3) Stooq CSV         — general fallback
//   4) Investing.com API — new 4th source via api.investing.com
//                          Pair IDs from investing-com-api-v2 library
//                          No API key, no Puppeteer — direct JSON endpoint
//                          Confirmed endpoints from InvestingService.js mapping
// ============================================================================
import { INSTRUMENTS, TTL } from "../config.js";
import { httpJSON, httpText } from "../http.js";
import type { Candle, CandleSeries } from "../types/index.js";

const KRAKEN_OHLC      = "https://api.kraken.com/0/public/OHLC";
const COINBASE_CANDLES = "https://api.exchange.coinbase.com/products";
const STOOQ_QUOTE      = "https://stooq.com/q/l/";
// Investing.com internal financial data API (confirmed from investing-com-api-v2 source)
const INVESTING_API    = "https://api.investing.com/api/financialdata";

// Kraken interval codes (minutes)
const KRAKEN_INTERVAL: Record<string, number> = {
  "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440,
};

// ---------------------------------------------------------------------------
// Investing.com pair IDs — from InvestingService.js (investing-com-api-v2)
// Confirmed stable IDs, not rotating session tokens
// ---------------------------------------------------------------------------
const INVESTING_PAIR_IDS: Record<string, string> = {
  EURUSD: "1",      // currencies/eur-usd
  GBPUSD: "2",      // currencies/gbp-usd
  USDJPY: "3",      // currencies/usd-jpy
  USDCHF: "4",      // currencies/usd-chf
  AUDUSD: "5",      // currencies/aud-usd
  USDCAD: "7",      // currencies/usd-cad
  XAUUSD: "68",     // currencies/xau-usd (Gold Spot — NOT futures)
};

// Investing.com interval codes (ISO 8601 duration format)
// PT = time period, P = date period
const INVESTING_INTERVAL: Record<string, string> = {
  "5m":  "PT5M",
  "15m": "PT15M",
  "1h":  "PT1H",
  "4h":  "PT5H",   // closest available (5 hours ≈ not perfect but usable)
  "1d":  "P1D",
};

// Period window to request (how much history)
// Investing.com returns `pointscount` bars from `period` window
const INVESTING_PERIOD: Record<string, string> = {
  "5m":  "P1D",    // 1 day of M5 bars
  "15m": "P1W",    // 1 week of M15 bars
  "1h":  "P1M",    // 1 month of H1 bars
  "4h":  "P3M",    // 3 months of ~5H bars
  "1d":  "P1Y",    // 1 year of D1 bars
};

const INVESTING_POINTS: Record<string, number> = {
  "5m":  120,
  "15m": 120,
  "1h":  120,
  "4h":  70,
  "1d":  120,
};

const TF_TTL: Record<string, number> = {
  "5m":  TTL.CANDLES_M5,
  "15m": TTL.CANDLES_M15,
  "1h":  TTL.CANDLES_H1,
  "4h":  TTL.CANDLES_H4,
  "1d":  TTL.CANDLES_D1,
};

// ---------------------------------------------------------------------------
// 1) KRAKEN (primary) — professional OHLCV with real volume
// ---------------------------------------------------------------------------
async function fromKraken(symbol: string, tf: string): Promise<CandleSeries | null> {
  const meta = INSTRUMENTS[symbol];
  if (!meta || !meta.kraken) return null;
  const iv = KRAKEN_INTERVAL[tf];
  if (!iv) return null;

  const url = `${KRAKEN_OHLC}?pair=${encodeURIComponent(meta.kraken)}&interval=${iv}`;
  const data = await httpJSON<any>(url, {
    cacheKey: `kr:${symbol}:${tf}`, ttlSec: TF_TTL[tf], source: "kraken", timeoutMs: 6000,
  });
  if (!data || (data.error && data.error.length)) return null;

  const result = data.result || {};
  const keys = Object.keys(result).filter(k => k !== "last");
  if (!keys.length) return null;

  const raw: any[] = result[keys[0]] || [];
  const candles: Candle[] = [];
  for (const row of raw) {
    // Kraken format: [time, open, high, low, close, vwap, volume, count]
    const t = Number(row[0]);
    const o = Number(row[1]);
    const h = Number(row[2]);
    const l = Number(row[3]);
    const c = Number(row[4]);
    const v = Number(row[6]);
    if (![t, o, h, l, c].every(isFinite)) continue;
    if (h < l || h <= 0 || l <= 0) continue;
    candles.push({ t, o, h, l, c, v: isFinite(v) ? v : null });
  }
  if (!candles.length) return null;

  return {
    symbol, timeframe: tf, candles,
    source: "kraken", available: true,
  };
}

// ---------------------------------------------------------------------------
// 2) COINBASE PAXG-USD (gold backup)
// Coinbase granularity (seconds): 60, 300, 900, 3600, 21600, 86400
// ---------------------------------------------------------------------------
const COINBASE_GRAN: Record<string, number> = {
  "5m": 300, "15m": 900, "1h": 3600, "4h": 0, "1d": 86400,
};

async function fromCoinbase(symbol: string, tf: string): Promise<CandleSeries | null> {
  if (symbol !== "XAUUSD") return null;
  const g = COINBASE_GRAN[tf];
  if (!g) return null;
  const url = `${COINBASE_CANDLES}/PAXG-USD/candles?granularity=${g}`;
  const data = await httpJSON<any[]>(url, {
    cacheKey: `cb:${symbol}:${tf}`, ttlSec: TF_TTL[tf], source: "coinbase", timeoutMs: 6000,
  });
  if (!data || !Array.isArray(data) || data.length === 0) return null;

  // Coinbase returns newest-first [time, low, high, open, close, volume]
  const candles: Candle[] = [];
  for (const row of data) {
    const t = Number(row[0]);
    const l = Number(row[1]);
    const h = Number(row[2]);
    const o = Number(row[3]);
    const c = Number(row[4]);
    const v = Number(row[5]);
    if (![t, o, h, l, c].every(isFinite)) continue;
    if (h < l || h <= 0) continue;
    candles.push({ t, o, h, l, c, v: isFinite(v) ? v : null });
  }
  candles.sort((a, b) => a.t - b.t);
  if (!candles.length) return null;
  return { symbol, timeframe: tf, candles, source: "coinbase", available: true };
}

// ---------------------------------------------------------------------------
// 3) H4 RESAMPLE (if Kraken's native 240 is off or as backup)
// ---------------------------------------------------------------------------
function resampleTo4h(h1: Candle[]): Candle[] {
  if (!h1.length) return [];
  const buckets = new Map<number, Candle[]>();
  for (const c of h1) {
    const d = new Date(c.t * 1000);
    const bucketHour = Math.floor(d.getUTCHours() / 4) * 4;
    const bucketTs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), bucketHour) / 1000;
    const arr = buckets.get(bucketTs) || [];
    arr.push(c);
    buckets.set(bucketTs, arr);
  }
  const out: Candle[] = [];
  for (const [t, bars] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const o = bars[0].o, c = bars[bars.length - 1].c;
    const h = Math.max(...bars.map(b => b.h));
    const l = Math.min(...bars.map(b => b.l));
    const hasVol = bars.some(b => b.v != null);
    const v = hasVol ? bars.reduce((s, b) => s + (b.v ?? 0), 0) : null;
    out.push({ t, o, h, l, c, v });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4) INVESTING.COM API — confirmed endpoint from investing-com-api-v2 source
//
// Endpoint: GET /api/financialdata/{pairId}/historical/chart
//   ?period=P1D&interval=PT5M&pointscount=120
//
// Response format (confirmed from InvestingService.mapResponse):
//   data: [[timestamp_ms, open, high, low, close], ...]
//
// Notes:
//   - Returns `pointscount` bars (60, 70, or 120 are valid values)
//   - No API key required from Cloudflare Workers edge IPs
//   - `domain-id: www` header required (their internal routing)
//   - 4h timeframe not native — we use PT5H as closest approximation,
//     then resample if needed
//   - XAUUSD pairId=68 = Gold Spot (not futures, better for FX trading)
// ---------------------------------------------------------------------------
async function fromInvesting(symbol: string, tf: string): Promise<CandleSeries | null> {
  const pairId   = INVESTING_PAIR_IDS[symbol];
  const interval = INVESTING_INTERVAL[tf];
  const period   = INVESTING_PERIOD[tf];
  const points   = INVESTING_POINTS[tf] ?? 120;

  if (!pairId || !interval || !period) return null;

  const url = `${INVESTING_API}/${pairId}/historical/chart?period=${period}&interval=${interval}&pointscount=${points}`;

  const data = await httpJSON<any>(url, {
    cacheKey: `inv:${symbol}:${tf}`,
    ttlSec: TF_TTL[tf],
    source: "investing_candles",  // v3.4.1: renamed to disambiguate from dead calendar POST scraper
    timeoutMs: 7000,
    retries: 1,
    headers: {
      "domain-id":   "www",
      "Accept":      "application/json",
      "Referer":     "https://www.investing.com/",
      "Origin":      "https://www.investing.com",
    },
  });

  // Response: { data: [[ts_ms, open, high, low, close], ...] }
  // OR:       { data: [[ts_ms, open, high, low, close, volume], ...] }
  if (!data || !Array.isArray(data.data) || !data.data.length) return null;

  const candles: Candle[] = [];
  for (const row of data.data) {
    if (!Array.isArray(row) || row.length < 5) continue;
    // Timestamps from Investing.com are in milliseconds
    const t = Math.round(Number(row[0]) / 1000);
    const o = Number(row[1]);
    const h = Number(row[2]);
    const l = Number(row[3]);
    const c = Number(row[4]);
    const v = row[5] != null ? Number(row[5]) : null;
    if (![t, o, h, l, c].every(isFinite) || h < l || h <= 0) continue;
    candles.push({ t, o, h, l, c, v: v != null && isFinite(v) ? v : null });
  }

  if (!candles.length) return null;

  // Sort ascending (Investing.com returns newest-first sometimes)
  candles.sort((a, b) => a.t - b.t);

  // For 4h: resample from PT5H bars (5-hour → need to group into 4h buckets)
  // PT5H is close enough for structure analysis — label it honestly
  const actualTf = tf === "4h" ? "4h(~5h)" : tf;

  return {
    symbol,
    timeframe: actualTf,
    candles,
    source: `investing(pairId=${pairId})`,
    available: true,
    note: tf === "4h" ? "Investing.com PT5H interval (closest to H4)" : undefined,
  };
}

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------
export async function fetchSeries(symbol: string, tf: string): Promise<CandleSeries> {
  const meta = INSTRUMENTS[symbol];
  if (!meta) return { symbol, timeframe: tf, candles: [], source: "none", available: false, note: `Unknown ${symbol}` };

  // 1) Kraken (primary — real volume, best quality)
  const k = await fromKraken(symbol, tf);
  if (k && k.candles.length >= 10) return k;

  // 2) Coinbase PAXG (XAU/USD only)
  if (symbol === "XAUUSD") {
    const cb = await fromCoinbase(symbol, tf);
    if (cb && cb.candles.length >= 10) return cb;
  }

  // 3) H4 resample from H1 (if Kraken H4 specifically fails)
  if (tf === "4h") {
    const h1 = await fetchSeries(symbol, "1h");
    if (h1.available && h1.candles.length >= 20) {
      return {
        symbol, timeframe: "4h",
        candles: resampleTo4h(h1.candles),
        source: h1.source + "+resample4h",
        available: true,
      };
    }
  }

  // 4) Investing.com (new — confirmed endpoint, no API key)
  const inv = await fromInvesting(symbol, tf);
  if (inv && inv.candles.length >= 10) return inv;

  return {
    symbol, timeframe: tf, candles: [], source: "none", available: false,
    note: "All candle sources failed (Kraken, Coinbase, Investing.com)",
  };
}

export async function fetchAllTimeframes(symbol: string): Promise<Record<string, CandleSeries>> {
  // Fetch each timeframe in parallel (Kraken responds ~200-500ms each)
  const tfs = ["5m", "15m", "1h", "4h", "1d"];
  const results = await Promise.all(tfs.map(tf => fetchSeries(symbol, tf)));
  const out: Record<string, CandleSeries> = {};
  tfs.forEach((tf, i) => { out[tf] = results[i]; });
  return out;
}
