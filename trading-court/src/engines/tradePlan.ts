// ============================================================================
// Trade Plan Builder — with spread awareness + real position sizing
//
// v4.1: cross-pair pip-value math via engines/pipValueCache. When neither side
// is USD, we resolve pipUSD from the helper rate (USDJPY for JPY-quoted, etc.).
// ============================================================================
import { INSTRUMENTS, RULES } from "../config.js";
import type {
  ConfidenceTier, Direction, IndicatorBlock, Quote, Tier, TradePlan,
} from "../types/index.js";
import { computeCrossPipUSD } from "./pipValueCache.js";

export function classifyConfidence(conf: number): [ConfidenceTier, number] {
  if (conf < RULES.tierRejectBelow) return ["REJECT", RULES.sizeMultReject];
  if (conf < RULES.tierWeakBelow)   return ["WEAK", RULES.sizeMultWeak];
  if (conf < RULES.tierValidBelow)  return ["VALID", RULES.sizeMultValid];
  return ["STRONG", RULES.sizeMultStrong];
}

export function buildPlan(
  symbol: string,
  direction: Direction,
  quote: Quote,
  indM15: IndicatorBlock,
  indH1: IndicatorBlock,
  indH4: IndicatorBlock,
  confidence: number,
): TradePlan {
  const [confTier, sizeMult] = classifyConfidence(confidence);
  const meta = INSTRUMENTS[symbol];

  const plan: TradePlan = {
    direction,
    tier: "REJECTED",
    confidenceTier: confTier,
    entry: null, stopLoss: null,
    tp1: null, tp2: null, tp3: null,
    rr1: null, rr2: null,
    spreadCost: null, stopDistancePips: null, lotSizePer1Pct: null,
    notes: [],
    sizeMultiplier: sizeMult,
  };

  if (!quote.available) { plan.notes.push("No live quote – plan not computable"); return plan; }
  if (direction === "FLAT") { plan.notes.push("Direction FLAT – no plan"); return plan; }

  // Entry accounts for spread (BUY at ask, SELL at bid)
  const entry = direction === "LONG" ? quote.ask : quote.bid;
  // Use M15 ATR for entry-level stops, H1/H4 for wider stops
  const atrShort = indM15.atr14 ?? indH1.atr14;
  const atrWide = indH1.atr14 ?? indH4.atr14;
  const atr = atrShort && atrWide ? (atrShort * 0.6 + atrWide * 0.4) : (atrShort ?? atrWide);
  if (atr == null || atr <= 0) { plan.entry = entry; plan.notes.push("ATR unavailable"); return plan; }

  const swingHigh = indH4.structHigh;
  const swingLow = indH4.structLow;
  const decimals = meta?.decimals ?? 5;

  const slAtr = atr * RULES.slAtrMult;
  const tp1Atr = atr * RULES.tp1AtrMult;
  const tp2Atr = atr * RULES.tp2AtrMult;
  const tp3Atr = atr * RULES.tp3AtrMult;

  let stopLoss: number, tp1: number, tp2: number, tp3: number;
  if (direction === "LONG") {
    let slCand = entry - slAtr;
    if (swingLow != null && swingLow < entry) slCand = Math.min(slCand, swingLow - atr * 0.2);
    stopLoss = slCand;
    tp1 = entry + tp1Atr; tp2 = entry + tp2Atr; tp3 = entry + tp3Atr;
    if (stopLoss >= entry) { plan.notes.push("Invalid LONG stop geometry"); return plan; }
  } else {
    let slCand = entry + slAtr;
    if (swingHigh != null && swingHigh > entry) slCand = Math.max(slCand, swingHigh + atr * 0.2);
    stopLoss = slCand;
    tp1 = entry - tp1Atr; tp2 = entry - tp2Atr; tp3 = entry - tp3Atr;
    if (stopLoss <= entry) { plan.notes.push("Invalid SHORT stop geometry"); return plan; }
  }

  const risk = Math.abs(entry - stopLoss);
  if (risk <= 0) { plan.notes.push("Non-positive risk distance"); return plan; }
  const reward1 = Math.abs(tp1 - entry);
  const reward2 = Math.abs(tp2 - entry);

  const stopDistancePips = risk / (meta?.pip ?? 0.0001);
  const spreadPips = quote.spread; // already in pips

  plan.entry = round(entry, decimals);
  plan.stopLoss = round(stopLoss, decimals);
  plan.tp1 = round(tp1, decimals);
  plan.tp2 = round(tp2, decimals);
  plan.tp3 = round(tp3, decimals);
  plan.rr1 = round(reward1 / risk, 2);
  plan.rr2 = round(reward2 / risk, 2);
  plan.spreadCost = round(spreadPips, 1);
  plan.stopDistancePips = round(stopDistancePips, 1);

  // Position size per 1% of $100 balance (generic pip value per 1 std lot for quote=USD)
  // For quote=USD pairs: 1 pip = $10 per standard lot
  // For JPY quote: 1 pip = ~$6.3 per standard lot (varies with rate)
  // For XAU/USD: 1 pip (0.1) = $1 per 1oz
  const lotSize = computeLotSize(symbol, entry, risk, 100, 1.0);
  plan.lotSizePer1Pct = lotSize ? round(lotSize, 3) : null;

  plan.tier = assignTier(confidence, plan.rr1);
  plan.notes.push(
    `Entry at ${direction === "LONG" ? "ask" : "bid"} ${plan.entry} (spread cost ${spreadPips.toFixed(1)} pips)`,
    `SL = ${RULES.slAtrMult}×ATR, TP1 = ${RULES.tp1AtrMult}×ATR, TP2 = ${RULES.tp2AtrMult}×ATR, TP3 = ${RULES.tp3AtrMult}×ATR`,
    `Signal Quality tier: ${confTier} (size multiplier x${sizeMult.toFixed(2)})`,
  );
  if (direction === "LONG" && swingLow != null) plan.notes.push(`Stop respects H4 swing low ${round(swingLow, decimals)}`);
  if (direction === "SHORT" && swingHigh != null) plan.notes.push(`Stop respects H4 swing high ${round(swingHigh, decimals)}`);
  return plan;
}

export function assignTier(confidence: number, rr: number | null): Tier {
  if (rr == null) return "REJECTED";
  if (confidence >= 85 && rr >= 2.0) return "A";
  if (confidence >= RULES.minConfidence && rr >= RULES.minRR) return "B";
  if (rr >= 1.2) return "C";
  return "REJECTED";
}

function round(v: number, d: number): number {
  const m = Math.pow(10, d);
  return Math.round(v * m) / m;
}

/**
 * Compute standard lot size (1 lot = 100k base units for FX, 100oz for XAU).
 * Returns lot count for given balance, riskPct, stop distance.
 */
export function computeLotSize(
  symbol: string, entry: number, riskDistance: number,
  balance: number, riskPct: number,
): number | null {
  const meta = INSTRUMENTS[symbol];
  if (!meta || riskDistance <= 0) return null;
  const riskAmount = balance * (riskPct / 100);
  // Pip value in USD per 1 lot
  let pipValueUsd: number;
  if (symbol === "XAUUSD") {
    pipValueUsd = 10; // pip=0.1, 100oz contract → $0.10 × 100 = $10/pip
  } else if (meta.quote === "USD") {
    pipValueUsd = 10; // standard 100k lot, pip in USD = $10
  } else if (meta.base === "USD") {
    // USD-base / foreign-quote (USDJPY, USDCAD, USDCHF):
    //   pip value in quote ccy = pip × 100,000
    //   pip value in USD       = (pip × 100,000) / quote-rate (= entry)
    // Examples:
    //   USDJPY @ 150 → (0.01 × 100k) / 150  = $6.67
    //   USDCAD @ 1.4 → (0.0001 × 100k)/ 1.4 = $7.14
    //   USDCHF @ 0.9 → (0.0001 × 100k)/ 0.9 = $11.11
    if (entry > 0) {
      pipValueUsd = (meta.pip * 100000) / entry;
    } else {
      return null; // cannot compute without a valid entry price
    }
  } else {
    // v4.1 — cross-pair (neither side is USD). Resolve via pipValueCache. If
    // helper rate (USDJPY for JPY-quoted, GBPUSD for GBP-quoted, etc.) is not
    // cached yet (cold start) or stale, return null — the caller must surface
    // "lot size unavailable" rather than fabricate a number.
    const cross = computeCrossPipUSD(meta.base, meta.quote, meta.pip);
    if (!cross) return null;
    pipValueUsd = cross.pipUsdPerLot;
  }
  const pipsRisked = riskDistance / meta.pip;
  const lot = riskAmount / (pipsRisked * pipValueUsd);
  return lot > 0 && isFinite(lot) ? lot : null;
}
