// ============================================================================
// HistData CSV Loader — v3.8
//
// Loads M1 OHLC CSV files in HistData.com Generic ASCII format and converts
// them into Candle[] compatible with the rest of the system.
//
// HistData free download URL pattern:
//   https://www.histdata.com/download-free-forex-historical-data/?/ascii/1-minute-bar-quotes/eurusd
//   → returns ZIP files named e.g. HISTDATA_COM_ASCII_EURUSD_M1202604.zip
//   (one ZIP per month)
//
// CSV format inside the ZIP:
//   YYYYMMDD HHMMSS;OPEN;HIGH;LOW;CLOSE;VOLUME
//   20240102 000000;1.10402;1.10405;1.10402;1.10405;0
//
// VOLUME is always 0 in HistData free data. We use M1 bar count as a synthetic
// volume proxy after resampling. Marked as such to avoid pretending we have
// real volume.
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { Candle, CandleSeries } from "../types/index.js";

export interface HistDataLoadOptions {
  /** Path to a CSV file or a directory containing multiple monthly CSVs. */
  pathOrDir: string;
  /** Filter inclusive start. ISO string or "YYYY-MM-DD". */
  fromUtc?: string;
  /** Filter inclusive end. */
  toUtc?: string;
}

/**
 * Parse a single HistData M1 line to a Candle, or null if malformed.
 * Format: "YYYYMMDD HHMMSS;O;H;L;C;V"
 */
function parseLine(line: string): Candle | null {
  const parts = line.trim().split(";");
  if (parts.length < 5) return null;
  const dt = parts[0];
  if (!/^\d{8} \d{6}$/.test(dt)) return null;
  const o = Number(parts[1]);
  const h = Number(parts[2]);
  const l = Number(parts[3]);
  const c = Number(parts[4]);
  const v = parts.length >= 6 ? Number(parts[5]) : 0;
  if (![o, h, l, c].every(Number.isFinite)) return null;

  // Build epoch seconds. HistData timestamps are EST without DST adjustment
  // (i.e. UTC-5 year-round). Convert to UTC by adding 5 hours.
  const Y = Number(dt.slice(0, 4));
  const M = Number(dt.slice(4, 6));
  const D = Number(dt.slice(6, 8));
  const hh = Number(dt.slice(9, 11));
  const mm = Number(dt.slice(11, 13));
  const ss = Number(dt.slice(13, 15));
  const utcMs = Date.UTC(Y, M - 1, D, hh, mm, ss) + 5 * 3600 * 1000;
  return { t: Math.floor(utcMs / 1000), o, h, l, c, v: Number.isFinite(v) ? v : 0 };
}

async function readCsvFile(file: string): Promise<Candle[]> {
  const candles: Candle[] = [];
  const rs = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: rs, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const c = parseLine(line);
    if (c) candles.push(c);
  }
  return candles;
}

/** Load M1 candles from a single CSV or all CSVs in a directory. */
export async function loadHistdataM1(opts: HistDataLoadOptions): Promise<Candle[]> {
  const { pathOrDir, fromUtc, toUtc } = opts;
  const stat = await fs.promises.stat(pathOrDir);

  let files: string[];
  if (stat.isDirectory()) {
    const entries = await fs.promises.readdir(pathOrDir);
    files = entries
      .filter(e => e.toLowerCase().endsWith(".csv"))
      .map(e => path.join(pathOrDir, e))
      .sort();
  } else {
    files = [pathOrDir];
  }

  let all: Candle[] = [];
  for (const f of files) {
    const part = await readCsvFile(f);
    all = all.concat(part);
  }

  // Sort by time and dedupe by timestamp.
  all.sort((a, b) => a.t - b.t);
  const dedup: Candle[] = [];
  let lastT = -1;
  for (const c of all) {
    if (c.t === lastT) continue;
    dedup.push(c);
    lastT = c.t;
  }

  if (fromUtc || toUtc) {
    const fromS = fromUtc ? Math.floor(new Date(fromUtc).getTime() / 1000) : -Infinity;
    const toS = toUtc ? Math.floor(new Date(toUtc).getTime() / 1000) : Infinity;
    return dedup.filter(c => c.t >= fromS && c.t <= toS);
  }
  return dedup;
}

// ─── Resampling: M1 → M5/M15/H1/H4/D1 ───────────────────────────────────────
const TF_SECONDS: Record<string, number> = {
  "5m":  5 * 60,
  "15m": 15 * 60,
  "1h":  60 * 60,
  "4h":  4 * 3600,
  "1d":  24 * 3600,
};

/**
 * Aggregate M1 candles into a higher-timeframe series. Bucket boundary is
 * floor(t / interval) * interval — same convention as Kraken/TradingView.
 *
 * Because backtest data is gap-prone (weekends, holidays), we don't fabricate
 * empty buckets. Each output candle corresponds to a bucket that had at
 * least one M1 input.
 */
export function resampleM1(m1: Candle[], tfKey: string): Candle[] {
  const interval = TF_SECONDS[tfKey];
  if (!interval) throw new Error(`Unknown timeframe: ${tfKey}`);

  const buckets = new Map<number, Candle[]>();
  for (const c of m1) {
    const bucketStart = Math.floor(c.t / interval) * interval;
    let list = buckets.get(bucketStart);
    if (!list) {
      list = [];
      buckets.set(bucketStart, list);
    }
    list.push(c);
  }

  const out: Candle[] = [];
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  for (const key of keys) {
    const list = buckets.get(key)!;
    const o = list[0].o;
    const c = list[list.length - 1].c;
    let h = -Infinity, l = Infinity, v = 0;
    for (const x of list) {
      if (x.h > h) h = x.h;
      if (x.l < l) l = x.l;
      v += x.v ?? 0;
    }
    // For HistData where v is always 0 we use the M1 bar count as a proxy.
    if (v === 0) v = list.length;
    out.push({ t: key, o, h, l, c, v });
  }
  return out;
}

/** Build a CandleSeries record for all timeframes the engines need. */
export function buildSeriesFromM1(m1: Candle[]): Record<string, CandleSeries> {
  const tfs = ["5m", "15m", "1h", "4h", "1d"];
  const out: Record<string, CandleSeries> = {};
  for (const tf of tfs) {
    const candles = resampleM1(m1, tf);
    out[tf] = {
      timeframe: tf,
      candles,
      available: candles.length > 0,
      source: "histdata",
    } as CandleSeries;
  }
  return out;
}

/** Convenience: load + resample in one call. */
export async function loadHistdataAsSeries(opts: HistDataLoadOptions): Promise<{
  m1: Candle[];
  series: Record<string, CandleSeries>;
}> {
  const m1 = await loadHistdataM1(opts);
  const series = buildSeriesFromM1(m1);
  return { m1, series };
}
