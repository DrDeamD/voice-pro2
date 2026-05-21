// ============================================================================
// Volume Profile — v4.2 Phase 3
//
// Computes POC (Point of Control), VAH (Value Area High), VAL (Value Area
// Low) from M5 candles within the current UTC day.
//
// Honest behaviour:
//   - When candles have no volume → returns null. We do not synthesise.
//   - When fewer than 12 bars exist (1 hour into day) → returns null.
// ============================================================================

import type { Candle } from "../types/index.js";

export interface VolumeProfileBin {
  priceLow: number;
  priceHigh: number;
  priceMid: number;
  volume: number;
}

export interface VolumeProfileReport {
  available: boolean;
  poc: number | null;          // Price level with highest volume
  vah: number | null;          // Value Area High (upper 70% bound)
  val: number | null;          // Value Area Low (lower 70% bound)
  rangeHigh: number | null;
  rangeLow: number | null;
  /** Where the current price sits */
  position: "ABOVE_VAH" | "INSIDE_VA" | "BELOW_VAL" | "AT_POC" | null;
  /** Distance from POC in pips */
  pocDistancePips: number | null;
  bins: VolumeProfileBin[];
  reasoning: string;
}

const BIN_COUNT = 30;
const VALUE_AREA_PCT = 0.70;

function emptyReport(reason: string): VolumeProfileReport {
  return {
    available: false,
    poc: null, vah: null, val: null,
    rangeHigh: null, rangeLow: null,
    position: null, pocDistancePips: null,
    bins: [],
    reasoning: reason,
  };
}

export function computeVolumeProfile(
  m5: Candle[],
  currentPrice: number,
  pip: number,
): VolumeProfileReport {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return emptyReport("Current price unavailable");
  }
  if (!m5 || m5.length === 0) {
    return emptyReport("No M5 candles");
  }

  // Filter to today's UTC bars
  const last = m5[m5.length - 1]!;
  const nowDate = new Date(last.t * 1000);
  const dayStartTs = Date.UTC(
    nowDate.getUTCFullYear(),
    nowDate.getUTCMonth(),
    nowDate.getUTCDate(),
  ) / 1000;
  const todayBars = m5.filter(c => c.t >= dayStartTs);

  if (todayBars.length < 12) {
    return emptyReport(`Only ${todayBars.length} M5 bars today (need ≥12)`);
  }

  // Require volume on every bar — VWAP-style discipline
  for (const c of todayBars) {
    if (c.v == null || !Number.isFinite(c.v) || c.v <= 0) {
      return emptyReport("Some today bars lack volume — volume profile unavailable");
    }
  }

  const high = Math.max(...todayBars.map(c => c.h));
  const low  = Math.min(...todayBars.map(c => c.l));
  if (high <= low) return emptyReport("Degenerate day range");

  const binSize = (high - low) / BIN_COUNT;
  if (binSize <= 0) return emptyReport("Degenerate bin size");

  const bins: VolumeProfileBin[] = [];
  for (let i = 0; i < BIN_COUNT; i++) {
    const lo = low + i * binSize;
    const hi = lo + binSize;
    bins.push({ priceLow: lo, priceHigh: hi, priceMid: (lo + hi) / 2, volume: 0 });
  }

  // Distribute each candle's volume across the bins it overlaps with
  for (const c of todayBars) {
    const v = c.v as number;
    const cHigh = c.h, cLow = c.l;
    if (cHigh <= cLow) continue;
    const totalRange = cHigh - cLow;
    for (const bin of bins) {
      const overlapLo = Math.max(bin.priceLow, cLow);
      const overlapHi = Math.min(bin.priceHigh, cHigh);
      const overlap = overlapHi - overlapLo;
      if (overlap > 0) {
        bin.volume += v * (overlap / totalRange);
      }
    }
  }

  // Total volume
  const totalVol = bins.reduce((s, b) => s + b.volume, 0);
  if (totalVol <= 0) return emptyReport("Zero total volume after distribution");

  // POC = bin with highest volume
  let pocBin = bins[0]!;
  for (const b of bins) {
    if (b.volume > pocBin.volume) pocBin = b;
  }
  const poc = pocBin.priceMid;

  // Value Area = expand around POC until 70% of total volume captured
  const targetVol = totalVol * VALUE_AREA_PCT;
  let pocIdx = bins.indexOf(pocBin);
  let vaLow = pocIdx, vaHigh = pocIdx;
  let accVol = pocBin.volume;

  while (accVol < targetVol && (vaLow > 0 || vaHigh < bins.length - 1)) {
    const above = vaHigh < bins.length - 1 ? bins[vaHigh + 1]!.volume : -1;
    const below = vaLow > 0 ? bins[vaLow - 1]!.volume : -1;
    if (above >= below && above >= 0) {
      vaHigh++;
      accVol += bins[vaHigh]!.volume;
    } else if (below >= 0) {
      vaLow--;
      accVol += bins[vaLow]!.volume;
    } else break;
  }

  const val = bins[vaLow]!.priceLow;
  const vah = bins[vaHigh]!.priceHigh;

  // Position of current price
  let position: VolumeProfileReport["position"];
  if (Math.abs(currentPrice - poc) < binSize * 0.5) position = "AT_POC";
  else if (currentPrice > vah) position = "ABOVE_VAH";
  else if (currentPrice < val) position = "BELOW_VAL";
  else position = "INSIDE_VA";

  const pocDistancePips = Math.round(((currentPrice - poc) / pip) * 10) / 10;

  const reasoning =
    `Day VP: ${todayBars.length} M5 bars. POC ${poc.toFixed(5)}, ` +
    `VA [${val.toFixed(5)} → ${vah.toFixed(5)}] (70%). ` +
    `Price ${position} (${pocDistancePips >= 0 ? "+" : ""}${pocDistancePips}p from POC).`;

  return {
    available: true,
    poc, vah, val,
    rangeHigh: high, rangeLow: low,
    position, pocDistancePips,
    bins,
    reasoning,
  };
}
