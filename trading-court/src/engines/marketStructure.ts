// ============================================================================
// Market Structure Engine — v3.7d
//
// CHANGES from v3.6:
//   1. NEW: computeDealingRange() — ICT-correct dealing range derived from
//      the swing high/low that bracketed the most recent BOS event. Replaces
//      the heuristic "last 3 swings" range used by computePremiumDiscount.
//   2. MarketStructureReport now exposes:
//        - dealingRange: { basis, high, low, positionPct } | null
//        - lastBosKind:  "BOS_BULL" | "BOS_BEAR" | "CHOCH_BULL" | "CHOCH_BEAR" | null
//        - lastBosFresh: boolean    (ageBars <= 3)
//        - lastChochKind: same shape, restricted to CHOCH events
//      These are the structured fields that the Judge consumes — no string
//      parsing on bullCase/summary anywhere downstream.
//   3. premiumDiscount.positionPct kept (0..1 range, unchanged) to preserve
//      backward compatibility with any code reading the legacy field.
//
// All else identical to the v3.6 file. The original swing/event/OB/pool logic
// is untouched — this patch only adds new derivations.
// ============================================================================
import type { Candle } from "../types/index.js";

// ─── existing types preserved verbatim ───────────────────────────────────────
export type SwingKind = "HH" | "HL" | "LH" | "LL" | "SH" | "SL";

export interface Swing {
  kind: SwingKind;
  price: number;
  index: number;
  tsUtc: string;
}

export function detectSwings(candles: Candle[], window = 2): Swing[] {
  const swings: Swing[] = [];
  if (candles.length < window * 2 + 1) return swings;

  const rawHighs: { i: number; p: number }[] = [];
  const rawLows: { i: number; p: number }[] = [];
  for (let i = window; i < candles.length - window; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      if (candles[j].h >= candles[i].h) isHigh = false;
      if (candles[j].l <= candles[i].l) isLow = false;
    }
    if (isHigh) rawHighs.push({ i, p: candles[i].h });
    if (isLow) rawLows.push({ i, p: candles[i].l });
  }

  let prevHigh: number | null = null;
  let prevLow: number | null = null;
  const all: { i: number; p: number; side: "H" | "L" }[] = [
    ...rawHighs.map(x => ({ ...x, side: "H" as const })),
    ...rawLows.map(x => ({ ...x, side: "L" as const })),
  ].sort((a, b) => a.i - b.i);

  for (const piv of all) {
    const ts = new Date(candles[piv.i].t * 1000).toISOString();
    if (piv.side === "H") {
      const kind: SwingKind = prevHigh == null ? "SH" : (piv.p > prevHigh ? "HH" : "LH");
      swings.push({ kind, price: piv.p, index: piv.i, tsUtc: ts });
      prevHigh = piv.p;
    } else {
      const kind: SwingKind = prevLow == null ? "SL" : (piv.p > prevLow ? "HL" : "LL");
      swings.push({ kind, price: piv.p, index: piv.i, tsUtc: ts });
      prevLow = piv.p;
    }
  }
  return swings;
}

export type StructureEventKind = "BOS_BULL" | "BOS_BEAR" | "CHOCH_BULL" | "CHOCH_BEAR";

export interface StructureEvent {
  kind: StructureEventKind;
  price: number;
  candleIdx: number;
  tsUtc: string;
  ageBars: number;
  ageMinutes: number;
  fresh: boolean;
}

function barIntervalMinutes(candles: Candle[]): number {
  if (candles.length < 2) return 60;
  const diffs: number[] = [];
  for (let i = candles.length - 5; i < candles.length - 1; i++) {
    if (i < 1) continue;
    diffs.push((candles[i].t - candles[i - 1].t) / 60);
  }
  if (!diffs.length) return 60;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

export function detectStructureEvents(
  candles: Candle[],
  swings: Swing[],
  lastTrendBefore: "UP" | "DOWN" | null = null,
): StructureEvent[] {
  const events: StructureEvent[] = [];
  if (candles.length < 5 || swings.length < 2) return events;

  const highSwings = swings.filter(s => s.kind === "HH" || s.kind === "LH" || s.kind === "SH");
  const lowSwings = swings.filter(s => s.kind === "HL" || s.kind === "LL" || s.kind === "SL");
  if (!highSwings.length && !lowSwings.length) return events;

  const firstSwingIdx = Math.min(
    highSwings[0]?.index ?? Infinity,
    lowSwings[0]?.index ?? Infinity,
  );
  const alreadyBrokenHighs = new Set<number>();
  const alreadyBrokenLows = new Set<number>();

  let currentTrend: "UP" | "DOWN" | null = lastTrendBefore;
  // intervalMin retained for downstream consumers; not used here directly.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _intervalMin = barIntervalMinutes(candles);
  const nowTs = candles[candles.length - 1].t;

  for (let i = firstSwingIdx + 1; i < candles.length; i++) {
    const c = candles[i].c;

    for (const sh of highSwings) {
      if (sh.index >= i) continue;
      if (alreadyBrokenHighs.has(sh.index)) continue;
      if (c > sh.price) {
        alreadyBrokenHighs.add(sh.index);
        const kind: StructureEventKind = currentTrend === "DOWN" ? "CHOCH_BULL" : "BOS_BULL";
        const ageBars = candles.length - 1 - i;
        events.push({
          kind, price: sh.price, candleIdx: i,
          tsUtc: new Date(candles[i].t * 1000).toISOString(),
          ageBars,
          ageMinutes: Math.round((nowTs - candles[i].t) / 60),
          fresh: ageBars <= 3,
        });
        currentTrend = "UP";
        break;
      }
    }

    for (const sl of lowSwings) {
      if (sl.index >= i) continue;
      if (alreadyBrokenLows.has(sl.index)) continue;
      if (c < sl.price) {
        alreadyBrokenLows.add(sl.index);
        const kind: StructureEventKind = currentTrend === "UP" ? "CHOCH_BEAR" : "BOS_BEAR";
        const ageBars = candles.length - 1 - i;
        events.push({
          kind, price: sl.price, candleIdx: i,
          tsUtc: new Date(candles[i].t * 1000).toISOString(),
          ageBars,
          ageMinutes: Math.round((nowTs - candles[i].t) / 60),
          fresh: ageBars <= 3,
        });
        currentTrend = "DOWN";
        break;
      }
    }
  }
  return events;
}

export interface OrderBlock {
  kind: "OB_BULL" | "OB_BEAR";
  top: number;
  bottom: number;
  mid: number;
  originIdx: number;
  tsUtc: string;
  mitigated: boolean;
  ageBars: number;
  distanceFromPrice: number;
}

export function detectInstitutionalOBs(
  candles: Candle[],
  events: StructureEvent[],
  _currentPrice: number,
): OrderBlock[] {
  const zones: OrderBlock[] = [];
  const n = candles.length;
  if (!n) return zones;

  for (const ev of events) {
    const idx = ev.candleIdx;
    if (idx < 2) continue;

    if (ev.kind === "BOS_BULL" || ev.kind === "CHOCH_BULL") {
      for (let i = idx - 1; i >= Math.max(0, idx - 15); i--) {
        if (candles[i].c < candles[i].o) {
          const top = candles[i].h, bot = candles[i].l;
          let mit = false;
          for (let j = idx + 1; j < n; j++) {
            if (candles[j].l <= top) { mit = true; break; }
          }
          zones.push({
            kind: "OB_BULL", top, bottom: bot, mid: (top + bot) / 2,
            originIdx: i, tsUtc: new Date(candles[i].t * 1000).toISOString(),
            mitigated: mit,
            ageBars: n - 1 - i,
            distanceFromPrice: 0,
          });
          break;
        }
      }
    } else if (ev.kind === "BOS_BEAR" || ev.kind === "CHOCH_BEAR") {
      for (let i = idx - 1; i >= Math.max(0, idx - 15); i--) {
        if (candles[i].c > candles[i].o) {
          const top = candles[i].h, bot = candles[i].l;
          let mit = false;
          for (let j = idx + 1; j < n; j++) {
            if (candles[j].h >= bot) { mit = true; break; }
          }
          zones.push({
            kind: "OB_BEAR", top, bottom: bot, mid: (top + bot) / 2,
            originIdx: i, tsUtc: new Date(candles[i].t * 1000).toISOString(),
            mitigated: mit,
            ageBars: n - 1 - i,
            distanceFromPrice: 0,
          });
          break;
        }
      }
    }
  }

  return zones.filter(z => !z.mitigated).slice(-5);
}

export type PremiumDiscount = "PREMIUM" | "DISCOUNT" | "EQUILIBRIUM" | "UNKNOWN";

export interface PDReport {
  zone: PremiumDiscount;
  positionPct: number;          // 0..1 range — preserved for compat
  rangeHigh: number | null;
  rangeLow: number | null;
  equilibrium: number | null;
  preferredDirection: "LONG" | "SHORT" | "NEUTRAL";
  reasoning: string;
}

export function computePremiumDiscount(
  swings: Swing[],
  currentPrice: number,
): PDReport {
  const highs = swings.filter(s => s.kind === "HH" || s.kind === "LH" || s.kind === "SH");
  const lows  = swings.filter(s => s.kind === "HL" || s.kind === "LL" || s.kind === "SL");

  if (highs.length < 2 || lows.length < 2) {
    return {
      zone: "UNKNOWN", positionPct: 0.5,
      rangeHigh: null, rangeLow: null, equilibrium: null,
      preferredDirection: "NEUTRAL",
      reasoning: "Not enough swings to determine range",
    };
  }

  const rh = Math.max(...highs.slice(-3).map(s => s.price));
  const rl = Math.min(...lows.slice(-3).map(s => s.price));
  const rng = rh - rl;
  if (rng <= 0) {
    return {
      zone: "UNKNOWN", positionPct: 0.5,
      rangeHigh: rh, rangeLow: rl, equilibrium: (rh + rl) / 2,
      preferredDirection: "NEUTRAL",
      reasoning: "Range is zero",
    };
  }

  const pos = (currentPrice - rl) / rng;
  let zone: PremiumDiscount;
  let pref: "LONG" | "SHORT" | "NEUTRAL";
  if (pos > 0.62) { zone = "PREMIUM"; pref = "SHORT"; }
  else if (pos < 0.38) { zone = "DISCOUNT"; pref = "LONG"; }
  else { zone = "EQUILIBRIUM"; pref = "NEUTRAL"; }

  return {
    zone,
    positionPct: Math.round(pos * 1000) / 1000,
    rangeHigh: rh,
    rangeLow: rl,
    equilibrium: (rh + rl) / 2,
    preferredDirection: pref,
    reasoning:
      `Price at ${(pos * 100).toFixed(1)}% of H4 range [${rl.toFixed(5)} → ${rh.toFixed(5)}]. ` +
      (zone === "PREMIUM"
        ? "In PREMIUM (>62%): hunt SHORTS only; longs risk topping pattern."
        : zone === "DISCOUNT"
        ? "In DISCOUNT (<38%): hunt LONGS only; shorts risk reversal."
        : "Equilibrium zone — let price pick a direction before commit."),
  };
}

// -----------------------------------------------------------------------------
// NEW v3.7d — ICT Dealing Range
// -----------------------------------------------------------------------------
// Definition (Inner Circle Trader / Smart Money):
//   The dealing range is the swing high and swing low that bracket the move
//   producing the most recent BOS. Concretely:
//     - last BOS_BULL → dealing range = [most recent swing-low BEFORE the
//                       broken high, the swing-high it broke].
//     - last BOS_BEAR → dealing range = [the swing-low it broke, most recent
//                       swing-high BEFORE that low].
//   CHOCH events are treated like BOS for this purpose.
//
// Why this matters:
//   The legacy computePremiumDiscount uses last-3-swings, which mixes
//   irrelevant pivots from different impulse legs and pollutes the range.
//   The dealing range is anchored to the actual impulse the market just made,
//   so positionPct is a meaningful "where in the current dealing leg" measure.
//
// Returns null if either anchor cannot be located. NEVER returns a guessed
// fallback. Caller is expected to suppress premium/discount logic when null.
export interface DealingRangeReport {
  basis: "ICT_DEALING_RANGE";
  high: number;
  low: number;
  positionPct: number;     // 0..1
  positionPctScaled: number; // 0..100 — convenience for judges/UI
  anchoredEvent: {
    kind: StructureEventKind;
    candleIdx: number;
    tsUtc: string;
    ageBars: number;
  };
  reasoning: string;
}

export function computeDealingRange(
  events: StructureEvent[],
  swings: Swing[],
  currentPrice: number,
): DealingRangeReport | null {
  if (!events.length || !swings.length) return null;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return null;

  // Use the most recent event regardless of fresh flag; "stale" dealing range
  // is still the dealing range until a new BOS fires.
  const last = events[events.length - 1];
  const breakIdx = last.candleIdx;
  const brokenLevel = last.price;

  const highSwings = swings.filter(s => s.kind === "HH" || s.kind === "LH" || s.kind === "SH");
  const lowSwings = swings.filter(s => s.kind === "HL" || s.kind === "LL" || s.kind === "SL");

  let high: number | null = null;
  let low: number | null = null;

  if (last.kind === "BOS_BULL" || last.kind === "CHOCH_BULL") {
    // Broken level was a swing-high. Find the most recent swing-low BEFORE
    // breakIdx. The dealing range = [that swing-low, brokenLevel].
    high = brokenLevel;
    const priorLows = lowSwings.filter(s => s.index < breakIdx);
    if (!priorLows.length) return null;
    low = priorLows[priorLows.length - 1].price;
  } else {
    // BOS_BEAR / CHOCH_BEAR: broken level was a swing-low.
    low = brokenLevel;
    const priorHighs = highSwings.filter(s => s.index < breakIdx);
    if (!priorHighs.length) return null;
    high = priorHighs[priorHighs.length - 1].price;
  }

  if (high == null || low == null) return null;
  if (!(high > low)) return null;
  const range = high - low;

  const rawPct = (currentPrice - low) / range;
  // Allow positionPct to fall outside [0,1] when price has moved beyond the
  // dealing range — that is itself diagnostic information for the judge.
  // We do NOT clamp silently. Consumers handle it.
  const positionPct = Math.round(rawPct * 1000) / 1000;
  const positionPctScaled = Math.round(rawPct * 1000) / 10;

  return {
    basis: "ICT_DEALING_RANGE",
    high,
    low,
    positionPct,
    positionPctScaled,
    anchoredEvent: {
      kind: last.kind,
      candleIdx: breakIdx,
      tsUtc: last.tsUtc,
      ageBars: last.ageBars,
    },
    reasoning:
      `Dealing range anchored to ${last.kind} at ${brokenLevel.toFixed(5)} ` +
      `(${last.ageBars}b ago). Range [${low.toFixed(5)} → ${high.toFixed(5)}], ` +
      `price at ${positionPctScaled.toFixed(1)}%.`,
  };
}

// -----------------------------------------------------------------------------
export interface LiquidityPool {
  kind: "EQH" | "EQL";
  price: number;
  touches: number;
  tsUtc: string;
  ageBars: number;
}

export function detectLiquidityPools(
  candles: Candle[],
  swings: Swing[],
  tolerancePct = 0.0008,
): LiquidityPool[] {
  const pools: LiquidityPool[] = [];
  const highs = swings.filter(s => s.kind === "HH" || s.kind === "LH" || s.kind === "SH");
  const lows = swings.filter(s => s.kind === "HL" || s.kind === "LL" || s.kind === "SL");
  const n = candles.length;

  const groupByTolerance = (arr: Swing[], kind: "EQH" | "EQL") => {
    const used = new Set<number>();
    for (let i = 0; i < arr.length; i++) {
      if (used.has(i)) continue;
      const cluster: Swing[] = [arr[i]];
      for (let j = i + 1; j < arr.length; j++) {
        if (used.has(j)) continue;
        if (Math.abs(arr[j].price - arr[i].price) / arr[i].price < tolerancePct) {
          cluster.push(arr[j]);
          used.add(j);
        }
      }
      if (cluster.length >= 2) {
        const avg = cluster.reduce((s, x) => s + x.price, 0) / cluster.length;
        const last = cluster[cluster.length - 1];
        pools.push({
          kind,
          price: Math.round(avg * 1e6) / 1e6,
          touches: cluster.length,
          tsUtc: last.tsUtc,
          ageBars: n - 1 - last.index,
        });
      }
    }
  };
  groupByTolerance(highs, "EQH");
  groupByTolerance(lows, "EQL");

  pools.sort((a, b) => a.ageBars - b.ageBars);
  return pools.slice(0, 6);
}

// -----------------------------------------------------------------------------
export interface MarketStructureReport {
  swingsH4: Swing[];
  events: StructureEvent[];
  freshEvents: StructureEvent[];
  orderBlocks: OrderBlock[];
  liquidityPools: LiquidityPool[];
  premiumDiscount: PDReport;
  // NEW v3.7d
  dealingRange: DealingRangeReport | null;
  lastBosKind: StructureEventKind | null;
  lastBosFresh: boolean;
  lastChochKind: StructureEventKind | null;
  lastChochFresh: boolean;
  // ─────────────
  currentTrend: "UP" | "DOWN" | "NEUTRAL";
  score: number;
  reasoning: string;
}

export function analyzeMarketStructure(
  h4: Candle[],
  currentPrice: number,
): MarketStructureReport {
  if (!h4 || h4.length < 15) {
    return {
      swingsH4: [], events: [], freshEvents: [],
      orderBlocks: [], liquidityPools: [],
      premiumDiscount: {
        zone: "UNKNOWN", positionPct: 0.5,
        rangeHigh: null, rangeLow: null, equilibrium: null,
        preferredDirection: "NEUTRAL",
        reasoning: "Insufficient H4 data",
      },
      dealingRange: null,
      lastBosKind: null, lastBosFresh: false,
      lastChochKind: null, lastChochFresh: false,
      currentTrend: "NEUTRAL", score: 0,
      reasoning: "Insufficient H4 data for market structure analysis",
    };
  }

  const swings = detectSwings(h4, 2);
  const events = detectStructureEvents(h4, swings);
  const fresh = events.filter(e => e.fresh);
  const obs = detectInstitutionalOBs(h4, events, currentPrice);
  const pools = detectLiquidityPools(h4, swings);
  const pd = computePremiumDiscount(swings, currentPrice);
  const dealingRange = computeDealingRange(events, swings, currentPrice);

  // Last BOS / CHoCH lookup — exact, no string parsing.
  const bosEvents = events.filter(e => e.kind === "BOS_BULL" || e.kind === "BOS_BEAR");
  const chochEvents = events.filter(e => e.kind === "CHOCH_BULL" || e.kind === "CHOCH_BEAR");
  const lastBos = bosEvents.length ? bosEvents[bosEvents.length - 1] : null;
  const lastChoch = chochEvents.length ? chochEvents[chochEvents.length - 1] : null;

  let trend: "UP" | "DOWN" | "NEUTRAL" = "NEUTRAL";
  if (events.length) {
    const last = events[events.length - 1];
    trend = last.kind.includes("BULL") ? "UP" : "DOWN";
  }

  let score = 0;
  for (const e of events.slice(-4)) {
    const dir = e.kind.includes("BULL") ? 1 : -1;
    const base = e.kind.includes("CHOCH") ? 28 : 18;
    const decay = Math.max(0.2, 1 - e.ageBars / 12);
    score += dir * base * decay;
  }
  if (pd.preferredDirection === "LONG" && score > 0) score += 8;
  if (pd.preferredDirection === "SHORT" && score < 0) score -= 8;
  if (pd.preferredDirection === "LONG" && score < 0) score += 5;
  if (pd.preferredDirection === "SHORT" && score > 0) score -= 5;
  score = Math.max(-100, Math.min(100, score));

  const lines: string[] = [];
  if (fresh.length) {
    lines.push(`Fresh events: ${fresh.map(e => `${e.kind}@${e.price.toFixed(5)} (${e.ageBars}b ago)`).join(", ")}`);
  }
  if (obs.length) lines.push(`${obs.length} active ICT Order Block(s)`);
  if (pools.length) lines.push(`${pools.length} liquidity pool(s) visible`);
  if (dealingRange) lines.push(dealingRange.reasoning);
  lines.push(pd.reasoning);

  return {
    swingsH4: swings.slice(-15),
    events: events.slice(-10),
    freshEvents: fresh,
    orderBlocks: obs,
    liquidityPools: pools,
    premiumDiscount: pd,
    dealingRange,
    lastBosKind: lastBos?.kind ?? null,
    lastBosFresh: lastBos?.fresh ?? false,
    lastChochKind: lastChoch?.kind ?? null,
    lastChochFresh: lastChoch?.fresh ?? false,
    currentTrend: trend,
    score: Math.round(score),
    reasoning: lines.join(" | "),
  };
}

export const marketStructureScore = (r: MarketStructureReport) => r.score;
