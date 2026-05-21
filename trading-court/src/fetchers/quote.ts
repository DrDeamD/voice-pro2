// ============================================================================
// Quote Fetcher — Swissquote (primary, real bid/ask) + TV scanner + Stooq
// Yahoo Finance REMOVED (permanently rate-limited from edge IPs)
//
// v4.1 — Every successful fetch is recorded into pipValueCache so cross-pair
// pip-value math (engines/pipValueCache.ts) has live helper rates without an
// additional round-trip.
// ============================================================================
import { INSTRUMENTS, TTL } from "../config.js";
import { httpJSON, httpText } from "../http.js";
import type { Quote } from "../types/index.js";
import { recordQuote } from "../engines/pipValueCache.js";

const SQ_URL = "https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument";
const TV_SCANNER = "https://scanner.tradingview.com/forex/scan";
const STOOQ_LIGHT = "https://stooq.com/q/l/";

// ---------------------------------------------------------------------------
// 1) Swissquote (PRIMARY) — real institutional bid/ask, ~1s fresh
// ---------------------------------------------------------------------------
async function fromSwissquote(symbol: string): Promise<Quote | null> {
  const meta = INSTRUMENTS[symbol];
  if (!meta) return null;
  // Do NOT encodeURIComponent the full string — the slash in "EUR/USD" must stay literal
  const parts = meta.swissquote.split("/");
  const url = `${SQ_URL}/${parts.map(p => encodeURIComponent(p)).join("/")}`;
  const data = await httpJSON<any[]>(url, {
    cacheKey: `sq:${symbol}`, ttlSec: TTL.QUOTE, source: "swissquote", timeoutMs: 4000,
  });
  if (!data || !Array.isArray(data) || data.length === 0) return null;
  // Choose the 'Standard' profile (or first available)
  const first = data[0];
  const profiles = first?.spreadProfilePrices || [];
  // Prefer 'Standard' profile which has realistic retail spread; fall back to first
  const profile = profiles.find((p: any) => p?.spreadProfile?.toLowerCase?.().includes("standard")) || profiles[0];
  if (!profile || !profile.bid || !profile.ask) return null;

  const bid = Number(profile.bid), ask = Number(profile.ask);
  if (!isFinite(bid) || !isFinite(ask) || bid <= 0 || ask <= 0) return null;
  const mid = (bid + ask) / 2;
  return {
    symbol, bid, ask, mid,
    spread: Math.abs(ask - bid) / meta.pip,
    source: "swissquote",
    ts: Number(first.ts) || Date.now(),
    available: true,
  };
}

// ---------------------------------------------------------------------------
// 2) TradingView scanner (FALLBACK 1) — batch for multiple pairs, real-time
// ---------------------------------------------------------------------------
let tvBatchCache: { data: Record<string, any>; expires: number } | null = null;

async function ensureTvBatch(symbols: string[]): Promise<Record<string, any>> {
  if (tvBatchCache && tvBatchCache.expires > Date.now()) return tvBatchCache.data;
  const tickers = symbols.map(s => INSTRUMENTS[s]?.tv).filter(Boolean);
  const body = JSON.stringify({
    symbols: { tickers, query: { types: [] } },
    columns: ["close", "change", "change_abs", "high", "low", "open", "volume"],
  });
  const res = await httpJSON<any>(TV_SCANNER, {
    method: "POST", body,
    headers: { "Content-Type": "application/json" },
    source: "tradingview", timeoutMs: 5000,
  });
  const out: Record<string, any> = {};
  if (res && Array.isArray(res.data)) {
    for (const row of res.data) {
      for (const sym of symbols) {
        if (INSTRUMENTS[sym]?.tv === row.s) {
          const d = row.d;
          out[sym] = {
            close: d[0], change: d[1], changeAbs: d[2],
            high: d[3], low: d[4], open: d[5], volume: d[6],
          };
        }
      }
    }
  }
  tvBatchCache = { data: out, expires: Date.now() + TTL.QUOTE * 1000 };
  return out;
}

function fromTv(symbol: string, row: any): Quote | null {
  const meta = INSTRUMENTS[symbol];
  if (!meta || !row || !row.close) return null;
  const mid = Number(row.close);
  if (!isFinite(mid) || mid <= 0) return null;
  // TV gives mid-only, synthesize bid/ask with 1-pip spread
  const est = meta.pip * 1.0;
  return {
    symbol,
    bid: mid - est / 2,
    ask: mid + est / 2,
    mid,
    spread: 1.0,
    source: "tradingview",
    ts: Date.now(),
    available: true,
    change: row.changeAbs,
    changePct: row.change,
    dayHigh: row.high,
    dayLow: row.low,
  };
}

// ---------------------------------------------------------------------------
// 3) Stooq light quote (FALLBACK 2) — CSV, all pairs supported
// ---------------------------------------------------------------------------
async function fromStooq(symbol: string): Promise<Quote | null> {
  const meta = INSTRUMENTS[symbol];
  if (!meta?.stooq) return null;
  const url = `${STOOQ_LIGHT}?s=${meta.stooq}&f=sd2t2ohlcv&h&e=csv`;
  const txt = await httpText(url, {
    cacheKey: `stq:${symbol}`, ttlSec: TTL.QUOTE, source: "stooq", timeoutMs: 4000,
  });
  if (!txt) return null;
  const lines = txt.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const cols = lines[1].split(",");
  // Format: Symbol,Date,Time,Open,High,Low,Close,Volume
  const open = Number(cols[3]);
  const high = Number(cols[4]);
  const low = Number(cols[5]);
  const close = Number(cols[6]);
  if (!isFinite(close) || close <= 0) return null;
  const mid = close;
  const est = meta.pip * 2.0; // Stooq is 15-min delayed so wider spread
  return {
    symbol,
    bid: mid - est / 2, ask: mid + est / 2, mid,
    spread: 2.0,
    source: "stooq",
    ts: Date.now(),
    available: true,
    dayHigh: high, dayLow: low,
    change: close - open,
  };
}

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------
export async function fetchQuote(symbol: string): Promise<Quote> {
  // Priority: Swissquote → TradingView → Stooq
  const sq = await fromSwissquote(symbol);
  if (sq) { recordQuote(symbol, sq); return sq; }

  const tvBatch = await ensureTvBatch([symbol]);
  const tvQ = fromTv(symbol, tvBatch[symbol]);
  if (tvQ) { recordQuote(symbol, tvQ); return tvQ; }

  const st = await fromStooq(symbol);
  if (st) { recordQuote(symbol, st); return st; }

  const meta = INSTRUMENTS[symbol];
  return {
    symbol, bid: 0, ask: 0, mid: 0, spread: 0,
    source: "none", ts: Date.now(), available: false,
    note: "All quote sources failed (Swissquote, TV, Stooq)",
  };
}

export async function fetchQuotes(symbols: string[]): Promise<Record<string, Quote>> {
  // Warm TV batch once for efficiency
  try { await ensureTvBatch(symbols); } catch { /* ignore */ }

  const results = await Promise.all(symbols.map(s => fetchQuote(s)));
  const out: Record<string, Quote> = {};
  results.forEach((q, i) => { out[symbols[i]] = q; });
  return out;
}
