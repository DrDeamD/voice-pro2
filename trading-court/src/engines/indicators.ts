// ============================================================================
// Technical Indicators (pure TS, sanitized outputs)
// ============================================================================
import { IND } from "../config.js";
import type { Candle, CandleSeries, IndicatorBlock } from "../types/index.js";

const clip = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const finite = (x: number): number | null => (isFinite(x) ? x : null);

export function sma(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const w = values.slice(-period);
  return finite(w.reduce((a, b) => a + b, 0) / period);
}

export function ema(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return finite(e);
}

export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgG = gains / period, avgL = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return clip(100 - 100 / (1 + rs), 0, 100);
}

function trueRanges(h: number[], l: number[], c: number[]): number[] {
  const tr: number[] = [];
  for (let i = 0; i < h.length; i++) {
    if (i === 0) tr.push(h[i] - l[i]);
    else {
      const hl = h[i] - l[i];
      const hc = Math.abs(h[i] - c[i - 1]);
      const lc = Math.abs(l[i] - c[i - 1]);
      tr.push(Math.max(hl, hc, lc));
    }
  }
  return tr;
}

export function atr(h: number[], l: number[], c: number[], period = 14): number | null {
  if (h.length < period + 1) return null;
  const tr = trueRanges(h, l, c);
  let a = tr.slice(1, period + 1).reduce((x, y) => x + y, 0) / period;
  for (let i = period + 1; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period;
  return a < 0 ? 0 : finite(a);
}

export function adx(h: number[], l: number[], c: number[], period = 14): number | null {
  const n = h.length;
  if (n < period * 2 + 1) return null;
  const pdm = [0], mdm = [0], tr = [h[0] - l[0]];
  for (let i = 1; i < n; i++) {
    const upMove = h[i] - h[i - 1];
    const downMove = l[i - 1] - l[i];
    pdm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    mdm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    const hl = h[i] - l[i];
    const hc = Math.abs(h[i] - c[i - 1]);
    const lc = Math.abs(l[i] - c[i - 1]);
    tr.push(Math.max(hl, hc, lc));
  }
  const wilder = (s: number[]): number[] => {
    const out: number[] = Array(period).fill(0);
    let init = 0;
    for (let i = 1; i <= period; i++) init += s[i];
    out.push(init);
    for (let i = period + 1; i < s.length; i++) out.push(out[out.length - 1] - (out[out.length - 1] / period) + s[i]);
    return out;
  };
  const trS = wilder(tr), pdmS = wilder(pdm), mdmS = wilder(mdm);
  const dx: number[] = [];
  for (let i = period; i < n; i++) {
    if (trS[i] === 0) { dx.push(0); continue; }
    const pDi = 100 * pdmS[i] / trS[i];
    const mDi = 100 * mdmS[i] / trS[i];
    const s = pDi + mDi;
    dx.push(s === 0 ? 0 : 100 * Math.abs(pDi - mDi) / s);
  }
  if (dx.length < period) return null;
  let a = dx.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < dx.length; i++) a = (a * (period - 1) + dx[i]) / period;
  return clip(a, 0, 100);
}

export function bbWidth(closes: number[], period = 20, stddev = 2.0): number | null {
  if (closes.length < period) return null;
  const w = closes.slice(-period);
  const mid = w.reduce((a, b) => a + b, 0) / period;
  const variance = w.reduce((a, b) => a + (b - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = mid + stddev * sd, lower = mid - stddev * sd;
  if (mid <= 0) return null;
  const width = (upper - lower) / mid;
  return width < 0 ? 0 : finite(width);
}

export function swingHighLow(h: number[], l: number[], lookback: number): [number | null, number | null] {
  if (!h.length || !l.length) return [null, null];
  const lb = Math.min(lookback, h.length);
  return [Math.max(...h.slice(-lb)), Math.min(...l.slice(-lb))];
}

export function computeBlock(series: CandleSeries): IndicatorBlock {
  const tf = series.timeframe;
  const blk: IndicatorBlock = {
    tf, n: series.candles.length,
    lastClose: null, ema20: null, ema50: null, ema200: null, sma50: null,
    rsi14: null, atr14: null, adx14: null, bbWidth: null,
    structHigh: null, structLow: null,
  };
  if (!series.candles.length) return blk;
  const c = series.candles.map(x => x.c);
  const h = series.candles.map(x => x.h);
  const l = series.candles.map(x => x.l);
  blk.lastClose = finite(c[c.length - 1]);
  blk.ema20 = ema(c, IND.emaFast);
  blk.ema50 = ema(c, IND.emaMid);
  blk.ema200 = ema(c, IND.emaSlow);
  blk.sma50 = sma(c, IND.emaMid);
  blk.rsi14 = rsi(c, IND.rsiPeriod);
  blk.atr14 = atr(h, l, c, IND.atrPeriod);
  blk.adx14 = adx(h, l, c, IND.adxPeriod);
  blk.bbWidth = bbWidth(c, IND.bbPeriod, IND.bbStdDev);
  const [sh, sl] = swingHighLow(h, l, IND.structureLookback);
  blk.structHigh = sh; blk.structLow = sl;
  return blk;
}
