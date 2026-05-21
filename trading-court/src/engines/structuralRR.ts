// ============================================================================
// Structural Risk/Reward Engine (NEW)
//
// Fixes audit flaw #3: original RR was always ≈1.67 because it was hard-coded
// from ATR × multipliers. True institutional RR is derived from STRUCTURE:
//   • SL = behind the last protecting swing (HL for long, LH for short)
//   • TP = at the nearest institutional magnet (liquidity pool, swing)
//
// This produces realistic, market-aware trade plans that respect the
// actual battlefield rather than a mathematical multiplier.
// ============================================================================
import type { Quote } from "../types/index.js";
import type { Swing, OrderBlock, LiquidityPool } from "./marketStructure.js";
import { INSTRUMENTS } from "../config.js";
import { computeCrossPipUSD } from "./pipValueCache.js";

export interface StructuralPlan {
  direction: "LONG" | "SHORT";
  entry: number;
  stopLoss: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  rr1: number | null;
  rr2: number | null;
  rr3: number | null;
  stopDistancePips: number | null;
  slAnchor: string;           // what the SL is based on
  tp1Anchor: string;
  tp2Anchor: string;
  tp3Anchor: string;
  notes: string[];
  valid: boolean;             // is the plan geometrically valid?
}

interface BuildCtx {
  pip: number;
  direction: "LONG" | "SHORT";
  quote: Quote;
  swings: Swing[];
  orderBlocks: OrderBlock[];
  liquidityPools: LiquidityPool[];
  atr: number | null;
  h4High: number | null;
  h4Low: number | null;
}

/**
 * Pick the SL anchor:
 *   Long  → last HL (or bottom of nearest bullish OB, or ATR-buffered recent low)
 *   Short → last LH (or top of nearest bearish OB, or ATR-buffered recent high)
 */
function pickSLAnchor(ctx: BuildCtx): { price: number | null; anchor: string } {
  const { direction, swings, orderBlocks, atr, quote } = ctx;
  const buffer = (atr ?? 0) * 0.15;   // tight buffer below swing

  if (direction === "LONG") {
    const hls = swings.filter(s => s.kind === "HL" || s.kind === "SL");
    if (hls.length) {
      const last = hls[hls.length - 1];
      // Must be below current entry
      if (last.price < quote.mid) {
        return { price: last.price - buffer, anchor: `Below last HL ${last.price.toFixed(5)} − ${(buffer).toFixed(5)} buffer` };
      }
    }
    // Fallback to nearest bullish OB bottom
    const ob = orderBlocks.filter(z => z.kind === "OB_BULL" && z.bottom < quote.mid).slice(-1)[0];
    if (ob) return { price: ob.bottom - buffer, anchor: `Below bullish OB bottom ${ob.bottom.toFixed(5)}` };
    // Fallback to ATR × 1.5 below entry
    if (atr) return { price: quote.mid - atr * 1.5, anchor: "ATR × 1.5 below entry (no structural anchor)" };
    return { price: null, anchor: "No SL anchor available" };
  }

  // SHORT
  const lhs = swings.filter(s => s.kind === "LH" || s.kind === "SH");
  if (lhs.length) {
    const last = lhs[lhs.length - 1];
    if (last.price > quote.mid) {
      return { price: last.price + buffer, anchor: `Above last LH ${last.price.toFixed(5)} + ${(buffer).toFixed(5)} buffer` };
    }
  }
  const ob = orderBlocks.filter(z => z.kind === "OB_BEAR" && z.top > quote.mid).slice(-1)[0];
  if (ob) return { price: ob.top + buffer, anchor: `Above bearish OB top ${ob.top.toFixed(5)}` };
  if (atr) return { price: quote.mid + atr * 1.5, anchor: "ATR × 1.5 above entry (no structural anchor)" };
  return { price: null, anchor: "No SL anchor available" };
}

/**
 * Pick TP anchors by distance from entry:
 *   TP1 = nearest opposing liquidity pool (EQH/EQL) or swing
 *   TP2 = further magnet (next liquidity, prior swing extreme, H4 range edge)
 *   TP3 = range target
 */
function pickTPs(
  ctx: BuildCtx,
  entry: number,
): { tp1: number | null; tp2: number | null; tp3: number | null; anchors: [string, string, string] } {
  const { direction, liquidityPools, swings, h4High, h4Low } = ctx;

  const candidates: { price: number; label: string }[] = [];

  if (direction === "LONG") {
    // Liquidity pools ABOVE entry
    for (const p of liquidityPools.filter(pl => pl.kind === "EQH" && pl.price > entry)) {
      candidates.push({ price: p.price, label: `EQH ×${p.touches} @ ${p.price.toFixed(5)}` });
    }
    // Swing highs above entry
    for (const s of swings.filter(sw => (sw.kind === "HH" || sw.kind === "LH" || sw.kind === "SH") && sw.price > entry)) {
      candidates.push({ price: s.price, label: `${s.kind} @ ${s.price.toFixed(5)}` });
    }
    // H4 range high
    if (h4High != null && h4High > entry) {
      candidates.push({ price: h4High, label: `H4 range high ${h4High.toFixed(5)}` });
    }
  } else {
    for (const p of liquidityPools.filter(pl => pl.kind === "EQL" && pl.price < entry)) {
      candidates.push({ price: p.price, label: `EQL ×${p.touches} @ ${p.price.toFixed(5)}` });
    }
    for (const s of swings.filter(sw => (sw.kind === "LL" || sw.kind === "HL" || sw.kind === "SL") && sw.price < entry)) {
      candidates.push({ price: s.price, label: `${s.kind} @ ${s.price.toFixed(5)}` });
    }
    if (h4Low != null && h4Low < entry) {
      candidates.push({ price: h4Low, label: `H4 range low ${h4Low.toFixed(5)}` });
    }
  }

  // Sort by distance from entry (nearest first for LONG = smallest price first going up)
  candidates.sort((a, b) =>
    direction === "LONG" ? (a.price - entry) - (b.price - entry) : (entry - a.price) - (entry - b.price)
  );
  // Deduplicate very close anchors (< 0.05% apart)
  const filtered: { price: number; label: string }[] = [];
  for (const c of candidates) {
    const last = filtered[filtered.length - 1];
    if (!last || Math.abs(c.price - last.price) / entry > 0.0005) filtered.push(c);
  }

  const tp1 = filtered[0]?.price ?? null;
  const tp2 = filtered[1]?.price ?? null;
  const tp3 = filtered[2]?.price ?? null;

  return {
    tp1, tp2, tp3,
    anchors: [
      filtered[0]?.label ?? "No TP1 anchor found",
      filtered[1]?.label ?? "No TP2 anchor found",
      filtered[2]?.label ?? "No TP3 anchor found",
    ],
  };
}

/**
 * Build a full structural trade plan.
 */
export function buildStructuralPlan(
  direction: "LONG" | "SHORT",
  quote: Quote,
  pip: number,
  swings: Swing[],
  orderBlocks: OrderBlock[],
  liquidityPools: LiquidityPool[],
  atr: number | null,
  h4High: number | null,
  h4Low: number | null,
): StructuralPlan {
  const notes: string[] = [];
  if (!quote.available || quote.mid <= 0) {
    return {
      direction, entry: 0,
      stopLoss: null, tp1: null, tp2: null, tp3: null,
      rr1: null, rr2: null, rr3: null,
      stopDistancePips: null,
      slAnchor: "Quote unavailable",
      tp1Anchor: "-", tp2Anchor: "-", tp3Anchor: "-",
      notes: ["Quote unavailable"],
      valid: false,
    };
  }

  const entry = direction === "LONG" ? quote.ask : quote.bid;
  const ctx: BuildCtx = { pip, direction, quote, swings, orderBlocks, liquidityPools, atr, h4High, h4Low };

  const slPick = pickSLAnchor(ctx);
  const tps = pickTPs(ctx, entry);

  const sl = slPick.price;
  const risk = sl != null ? Math.abs(entry - sl) : null;
  const pipRisk = risk != null ? risk / pip : null;

  const rr = (tp: number | null) => {
    if (sl == null || tp == null || risk == null || risk <= 0) return null;
    const reward = Math.abs(tp - entry);
    // Must be in favourable direction
    if (direction === "LONG" && tp <= entry) return null;
    if (direction === "SHORT" && tp >= entry) return null;
    return Math.round((reward / risk) * 100) / 100;
  };
  const rr1 = rr(tps.tp1);
  const rr2 = rr(tps.tp2);
  const rr3 = rr(tps.tp3);

  // Validity checks
  let valid = true;
  if (sl == null) { valid = false; notes.push("No valid SL anchor"); }
  if (tps.tp1 == null) { notes.push("No valid TP1 anchor — consider waiting for cleaner setup"); }
  if (direction === "LONG" && sl != null && sl >= entry) {
    valid = false; notes.push(`Invalid geometry: SL ${sl.toFixed(5)} above LONG entry ${entry.toFixed(5)}`);
  }
  if (direction === "SHORT" && sl != null && sl <= entry) {
    valid = false; notes.push(`Invalid geometry: SL ${sl.toFixed(5)} below SHORT entry ${entry.toFixed(5)}`);
  }
  if (rr1 != null && rr1 < 1.0) {
    notes.push(`⚠️ TP1 gives RR ${rr1.toFixed(2)} < 1.0 — consider a pullback entry or next liquidity as TP1`);
  }

  return {
    direction, entry,
    stopLoss: sl,
    tp1: tps.tp1, tp2: tps.tp2, tp3: tps.tp3,
    rr1, rr2, rr3,
    stopDistancePips: pipRisk != null ? Math.round(pipRisk * 10) / 10 : null,
    slAnchor: slPick.anchor,
    tp1Anchor: tps.anchors[0], tp2Anchor: tps.anchors[1], tp3Anchor: tps.anchors[2],
    notes,
    valid,
  };
}

/**
 * Position sizing: given balance + risk% + SL distance, return lot size.
 *
 * Pip value per standard lot, derived from INSTRUMENTS metadata + live rates:
 *   - quote === USD          → $10 (e.g. EUR/USD, GBP/USD, XAU/USD)
 *   - base  === USD          → (pip × 100k) / current quote (e.g. USD/JPY)
 *   - cross (no USD, v4.1)   → via pipValueCache helper rate (returns null
 *                              when helper rate is cold/stale)
 *   - everything else        → null (refuse to fabricate)
 */
export function computeLotSize(
  symbol: string,
  balanceUSD: number,
  riskPct: number,
  stopDistancePips: number | null,
  quote: Quote,
  pip: number,
): number | null {
  if (stopDistancePips == null || stopDistancePips <= 0) return null;
  if (balanceUSD <= 0 || riskPct <= 0) return null;
  const riskUSD = balanceUSD * (riskPct / 100);
  const meta = INSTRUMENTS[symbol];
  if (!meta) return null;

  let pipValuePerLot: number;

  if (symbol === "XAUUSD") {
    // Gold: standard lot = 100 oz, pip 0.1 → $10 per pip.
    pipValuePerLot = 10.0;
  } else if (meta.quote === "USD") {
    // Direct USD-quoted pair: pip in USD = $10/lot (standard 100k).
    pipValuePerLot = 10.0;
  } else if (meta.base === "USD") {
    // USD-base, foreign quote (USDJPY/USDCAD/USDCHF): pip value in USD =
    // (pip × 100k) / current quote. quote.mid must be live & positive.
    if (!(quote.mid > 0)) return null;
    pipValuePerLot = (pip * 100_000) / quote.mid;
  } else {
    // v4.1 — cross pair (neither side is USD). Use the cache populated by
    // fetchQuote earlier in this snapshot. Returns null on cold start /
    // stale helper rate.
    const cross = computeCrossPipUSD(meta.base, meta.quote, pip);
    if (!cross) return null;
    pipValuePerLot = cross.pipUsdPerLot;
  }

  if (!Number.isFinite(pipValuePerLot) || pipValuePerLot <= 0) return null;

  const lotSize = riskUSD / (stopDistancePips * pipValuePerLot);
  // Round to 2 decimal places (micro lot resolution)
  return lotSize > 0 && Number.isFinite(lotSize)
    ? Math.round(lotSize * 100) / 100
    : null;
}
