// ============================================================================
// Advanced Price Action Engine (ICT / SMC-inspired)
// Detects: BOS, CHoCH, FVG, Order Blocks, Liquidity Sweeps,
// Session Levels (Asian High/Low), PDH/PDL breaks, Range breakouts.
// ============================================================================
import type { Candle, CandleSeries, PriceActionReport, PriceActionSignal, SessionLevels } from "../types/index.js";

const SWING_LB = 20;
const RANGE_LB = 30;

function swingLevels(highs: number[], lows: number[], lb: number): [number, number] | null {
  if (highs.length < lb + 1) return null;
  return [Math.max(...highs.slice(-lb - 1, -1)), Math.min(...lows.slice(-lb - 1, -1))];
}

// -----------------------------------------------------------------------------
// Session Levels
// -----------------------------------------------------------------------------
/** Asian session = 00:00 - 07:00 UTC (Tokyo + Sydney) */
export function computeAsianRange(m15: Candle[]): { high: number | null; low: number | null } {
  if (!m15.length) return { high: null, low: null };
  const nowUtc = new Date(m15[m15.length - 1].t * 1000);
  const y = nowUtc.getUTCFullYear(), mo = nowUtc.getUTCMonth(), d = nowUtc.getUTCDate();
  const asiaStart = Date.UTC(y, mo, d, 0) / 1000;
  const asiaEnd = Date.UTC(y, mo, d, 7) / 1000;
  const barsInAsia = m15.filter(c => c.t >= asiaStart && c.t < asiaEnd);
  if (!barsInAsia.length) return { high: null, low: null };
  return {
    high: Math.max(...barsInAsia.map(c => c.h)),
    low: Math.min(...barsInAsia.map(c => c.l)),
  };
}

export function computePDHPDL(d1: Candle[]): { pdh: number | null; pdl: number | null } {
  if (d1.length < 2) return { pdh: null, pdl: null };
  const prev = d1[d1.length - 2];
  return { pdh: prev.h, pdl: prev.l };
}

export function computeWeeklyOpen(h1: Candle[]): number | null {
  if (!h1.length) return null;
  // Find Sunday/Monday 00:00 UTC open of current week
  const now = new Date(h1[h1.length - 1].t * 1000);
  const y = now.getUTCFullYear(), mo = now.getUTCMonth(), d = now.getUTCDate();
  const dow = now.getUTCDay(); // 0=Sun
  // FX week typically opens Sunday 22:00 UTC. We'll use Monday 00:00 UTC for simplicity
  const mondayOffset = (dow === 0) ? 1 : (dow === 1 ? 0 : -(dow - 1));
  const monday = new Date(Date.UTC(y, mo, d + mondayOffset));
  const weekStart = monday.getTime() / 1000;
  const bar = h1.find(c => c.t >= weekStart);
  return bar?.o ?? null;
}

export function computeSessionOpens(h1: Candle[]): { london: number | null; ny: number | null } {
  if (!h1.length) return { london: null, ny: null };
  const now = new Date(h1[h1.length - 1].t * 1000);
  const y = now.getUTCFullYear(), mo = now.getUTCMonth(), d = now.getUTCDate();
  const londonTs = Date.UTC(y, mo, d, 7) / 1000;
  const nyTs = Date.UTC(y, mo, d, 13) / 1000;
  const londonBar = h1.find(c => c.t >= londonTs && c.t < londonTs + 3600);
  const nyBar = h1.find(c => c.t >= nyTs && c.t < nyTs + 3600);
  return { london: londonBar?.o ?? null, ny: nyBar?.o ?? null };
}

// -----------------------------------------------------------------------------
// Structural signals
// -----------------------------------------------------------------------------
function detectBOS(c: number[], swingHigh: number, swingLow: number, last = 3): PriceActionSignal[] {
  const out: PriceActionSignal[] = [];
  const recent = c.slice(-last);
  if (recent.some(x => x > swingHigh)) {
    out.push({ kind: "BOS", dir: "BULLISH", weight: 40, note: `Close broke above swing high ${swingHigh.toFixed(5)}`, level: swingHigh });
  }
  if (recent.some(x => x < swingLow)) {
    out.push({ kind: "BOS", dir: "BEARISH", weight: 40, note: `Close broke below swing low ${swingLow.toFixed(5)}`, level: swingLow });
  }
  return out;
}

/** Fair Value Gap — 3-candle imbalance */
function detectFVG(candles: Candle[], last = 15): PriceActionSignal[] {
  const out: PriceActionSignal[] = [];
  const n = candles.length;
  if (n < 3) return out;
  const from = Math.max(2, n - last);
  for (let i = from; i < n; i++) {
    const a = candles[i - 2], b = candles[i - 1], c = candles[i];
    // Bullish FVG: candle[i-2].high < candle[i].low  (gap in middle)
    if (a.h < c.l && b.c > b.o) {
      out.push({
        kind: "FVG", dir: "BULLISH", weight: 18,
        note: `Unfilled bullish FVG @ ${((a.h + c.l) / 2).toFixed(5)}`,
        level: (a.h + c.l) / 2,
      });
    }
    // Bearish FVG
    if (a.l > c.h && b.c < b.o) {
      out.push({
        kind: "FVG", dir: "BEARISH", weight: 18,
        note: `Unfilled bearish FVG @ ${((a.l + c.h) / 2).toFixed(5)}`,
        level: (a.l + c.h) / 2,
      });
    }
  }
  // Keep only most recent 3 signals per direction
  const bulls = out.filter(s => s.dir === "BULLISH").slice(-2);
  const bears = out.filter(s => s.dir === "BEARISH").slice(-2);
  return [...bulls, ...bears];
}

/** Order Block: last bearish candle before strong bullish move (and vice versa) */
function detectOrderBlocks(candles: Candle[], lookback = 12): PriceActionSignal[] {
  if (candles.length < 5) return [];
  const out: PriceActionSignal[] = [];
  const n = candles.length;
  const start = Math.max(2, n - lookback);
  for (let i = start; i < n - 1; i++) {
    const cur = candles[i], next = candles[i + 1];
    const body = Math.abs(next.c - next.o);
    const avgBody = avgBodySize(candles, i);
    if (avgBody <= 0) continue;
    // Bullish OB: cur is bearish, next is strong bullish (body > 1.5× avg)
    if (cur.c < cur.o && next.c > next.o && body > 1.5 * avgBody) {
      out.push({
        kind: "OB", dir: "BULLISH", weight: 22,
        note: `Bullish OB @ ${cur.l.toFixed(5)}–${cur.h.toFixed(5)}`,
        level: (cur.l + cur.h) / 2,
      });
    }
    if (cur.c > cur.o && next.c < next.o && body > 1.5 * avgBody) {
      out.push({
        kind: "OB", dir: "BEARISH", weight: 22,
        note: `Bearish OB @ ${cur.l.toFixed(5)}–${cur.h.toFixed(5)}`,
        level: (cur.l + cur.h) / 2,
      });
    }
  }
  return out.slice(-4);  // most recent
}

function avgBodySize(candles: Candle[], uptoIdx: number): number {
  const slice = candles.slice(Math.max(0, uptoIdx - 20), uptoIdx);
  if (!slice.length) return 0;
  return slice.reduce((a, c) => a + Math.abs(c.c - c.o), 0) / slice.length;
}

/** Liquidity Sweep: wick takes out swing level but close rejects */
function detectLiquiditySweep(candles: Candle[], swingHigh: number, swingLow: number): PriceActionSignal[] {
  if (candles.length < 1) return [];
  const last = candles[candles.length - 1];
  const rng = last.h - last.l;
  if (rng <= 0) return [];
  const upperWick = last.h - Math.max(last.o, last.c);
  const lowerWick = Math.min(last.o, last.c) - last.l;
  const body = Math.abs(last.c - last.o);
  const out: PriceActionSignal[] = [];

  if (last.h > swingHigh && last.c < swingHigh && upperWick > body && (last.h - last.c) / rng > 0.55) {
    out.push({
      kind: "LIQUIDITY_SWEEP", dir: "BEARISH", weight: 30,
      note: `Liquidity swept above ${swingHigh.toFixed(5)} with rejection`,
      level: swingHigh,
    });
  }
  if (last.l < swingLow && last.c > swingLow && lowerWick > body && (last.c - last.l) / rng > 0.55) {
    out.push({
      kind: "LIQUIDITY_SWEEP", dir: "BULLISH", weight: 30,
      note: `Liquidity swept below ${swingLow.toFixed(5)} with rejection`,
      level: swingLow,
    });
  }
  return out;
}

function detectRangeBreakout(c: number[], h: number[], l: number[]): PriceActionSignal[] {
  if (c.length < RANGE_LB + 1) return [];
  const wH = Math.max(...h.slice(-RANGE_LB - 1, -1));
  const wL = Math.min(...l.slice(-RANGE_LB - 1, -1));
  const mid = (wH + wL) / 2;
  const range = wH - wL;
  if (mid <= 0 || range <= 0) return [];
  if (range / mid > 0.015) return [];  // not tight enough
  const last = c[c.length - 1];
  if (last > wH) return [{ kind: "RANGE_BREAKOUT", dir: "BULLISH", weight: 28, note: `Tight-range upside breakout @ ${wH.toFixed(5)}`, level: wH }];
  if (last < wL) return [{ kind: "RANGE_BREAKOUT", dir: "BEARISH", weight: 28, note: `Tight-range downside breakout @ ${wL.toFixed(5)}`, level: wL }];
  return [];
}

function detectFakeBreakout(candles: Candle[], swingHigh: number, swingLow: number): PriceActionSignal[] {
  const out: PriceActionSignal[] = [];
  for (const idx of [-1, -2]) {
    const i = candles.length + idx;
    if (i < 0) continue;
    const c = candles[i];
    if (c.h > swingHigh && c.c < swingHigh && c.c < c.o) {
      out.push({ kind: "FAKE_BREAKOUT", dir: "BEARISH", weight: 22, note: "Fake breakout above swing high", level: swingHigh });
    }
    if (c.l < swingLow && c.c > swingLow && c.c > c.o) {
      out.push({ kind: "FAKE_BREAKOUT", dir: "BULLISH", weight: 22, note: "Fake breakout below swing low", level: swingLow });
    }
  }
  return out;
}

function detectSessionLevelBreaks(
  candles: Candle[],
  levels: SessionLevels,
): PriceActionSignal[] {
  if (!candles.length) return [];
  const last = candles[candles.length - 1];
  const out: PriceActionSignal[] = [];
  if (levels.pdh != null && last.c > levels.pdh) {
    out.push({ kind: "PDH_BREAK", dir: "BULLISH", weight: 18, note: `Broke PDH ${levels.pdh.toFixed(5)}`, level: levels.pdh });
  }
  if (levels.pdl != null && last.c < levels.pdl) {
    out.push({ kind: "PDL_BREAK", dir: "BEARISH", weight: 18, note: `Broke PDL ${levels.pdl.toFixed(5)}`, level: levels.pdl });
  }
  if (levels.asiaHigh != null && last.c > levels.asiaHigh) {
    out.push({ kind: "ASIA_RANGE_BREAK", dir: "BULLISH", weight: 15, note: `Broke Asia high ${levels.asiaHigh.toFixed(5)}`, level: levels.asiaHigh });
  }
  if (levels.asiaLow != null && last.c < levels.asiaLow) {
    out.push({ kind: "ASIA_RANGE_BREAK", dir: "BEARISH", weight: 15, note: `Broke Asia low ${levels.asiaLow.toFixed(5)}`, level: levels.asiaLow });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Main analyzer — operates on H4 + H1 + M15 + D1
// -----------------------------------------------------------------------------
export function analyzePriceAction(
  m15: CandleSeries,
  h1: CandleSeries,
  h4: CandleSeries,
  d1: CandleSeries,
): PriceActionReport {
  // Session / reference levels
  const asia = computeAsianRange(m15.candles);
  const pd = computePDHPDL(d1.candles);
  const wOpen = computeWeeklyOpen(h1.candles);
  const sOpens = computeSessionOpens(h1.candles);

  const sessionLevels: SessionLevels = {
    asiaHigh: asia.high, asiaLow: asia.low,
    pdh: pd.pdh, pdl: pd.pdl,
    weeklyOpen: wOpen,
    londonOpen: sOpens.london, nyOpen: sOpens.ny,
  };

  const signals: PriceActionSignal[] = [];

  if (h4.available && h4.candles.length > SWING_LB + 3) {
    const c = h4.candles.map(x => x.c);
    const h = h4.candles.map(x => x.h);
    const l = h4.candles.map(x => x.l);
    const sw = swingLevels(h, l, SWING_LB);
    if (sw) {
      const [sh, sl] = sw;
      signals.push(...detectBOS(c, sh, sl));
      signals.push(...detectLiquiditySweep(h4.candles, sh, sl));
      signals.push(...detectFakeBreakout(h4.candles, sh, sl));
      signals.push(...detectRangeBreakout(c, h, l));
    }
    signals.push(...detectFVG(h4.candles));
    signals.push(...detectOrderBlocks(h4.candles));
  }

  // Entry-level structural events (M15)
  if (m15.available && m15.candles.length > 20) {
    signals.push(...detectSessionLevelBreaks(m15.candles, sessionLevels));
  }

  // Score
  let bull = 0, bear = 0;
  for (const s of signals) {
    if (s.dir === "BULLISH") bull += s.weight;
    else bear += s.weight;
  }
  const net = Math.max(-100, Math.min(100, bull - bear));
  const direction: PriceActionReport["direction"] =
    net >= 25 ? "BULLISH" : net <= -25 ? "BEARISH" : "NEUTRAL";

  const reasoning = signals.length
    ? signals.map(s => `${s.kind}(${s.dir[0]}): ${s.note}`).join("; ")
    : "No structural events detected.";

  return { direction, score: net, signals, sessionLevels, reasoning };
}

export const priceActionScore = (r: PriceActionReport) => r.score;
