// ============================================================================
// Correlation / Cross-market Context Engine
// Uses DXY / Gold / Oil / VIX / US10Y 10-day % change to bias pair
// ============================================================================
import type { CorrelationReport } from "../types/index.js";
import { INSTRUMENTS } from "../config.js";

type Ctx = { dxy: number | null; gold: number | null; oil: number | null; vix: number | null; y10: number | null };

function bias(pct: number | null, strongThr = 0.5): "UP" | "DOWN" | "FLAT" | null {
  if (pct == null) return null;
  if (pct > strongThr) return "UP";
  if (pct < -strongThr) return "DOWN";
  return "FLAT";
}

export function analyzeCorrelation(symbol: string, ctx: Ctx): CorrelationReport {
  const meta = INSTRUMENTS[symbol];
  if (!meta) return {
    dxyChange: null, goldChange: null, oilChange: null, vixChange: null, yield10yChange: null,
    score: 0, available: false, reasoning: "Unknown symbol",
  };

  const { base, quote } = meta;
  const dxyB = bias(ctx.dxy);
  const goldB = bias(ctx.gold);
  const oilB = bias(ctx.oil);
  const vixB = bias(ctx.vix, 3.0);
  const y10B = bias(ctx.y10, 1.0);

  let score = 0;
  const lines: string[] = [];

  if (dxyB && ctx.dxy != null) {
    const usdStrong = dxyB === "UP";
    const usdWeak = dxyB === "DOWN";
    if (usdStrong) {
      if (quote === "USD") { score -= 25; lines.push(`DXY ${ctx.dxy.toFixed(2)}% → USD strong, bearish ${meta.display}`); }
      else if (base === "USD") { score += 25; lines.push(`DXY ${ctx.dxy.toFixed(2)}% → USD strong, bullish ${meta.display}`); }
    } else if (usdWeak) {
      if (quote === "USD") { score += 25; lines.push(`DXY ${ctx.dxy.toFixed(2)}% → USD weak, bullish ${meta.display}`); }
      else if (base === "USD") { score -= 25; lines.push(`DXY ${ctx.dxy.toFixed(2)}% → USD weak, bearish ${meta.display}`); }
    }
  }

  if (goldB && ctx.gold != null) {
    if (base === "XAU") {
      if (goldB === "UP") { score += 35; lines.push(`Gold ${ctx.gold.toFixed(2)}% higher → bullish XAU/USD`); }
      if (goldB === "DOWN") { score -= 35; lines.push(`Gold ${ctx.gold.toFixed(2)}% lower → bearish XAU/USD`); }
    } else if (base === "AUD" && goldB === "UP") {
      score += 10; lines.push("Gold rising → modest AUD tailwind");
    }
  }

  if (oilB && ctx.oil != null && (base === "CAD" || quote === "CAD")) {
    if (oilB === "UP") {
      if (quote === "CAD") { score -= 15; lines.push(`Oil ${ctx.oil.toFixed(2)}% higher → strong CAD (bearish USD/CAD)`); }
      else { score += 15; lines.push("Oil higher → bullish CAD"); }
    } else if (oilB === "DOWN") {
      if (quote === "CAD") { score += 15; lines.push(`Oil ${ctx.oil.toFixed(2)}% lower → weak CAD (bullish USD/CAD)`); }
      else { score -= 15; }
    }
  }

  if (vixB) {
    const riskOff = vixB === "UP", riskOn = vixB === "DOWN";
    const riskCcys = new Set(["AUD", "NZD", "GBP"]);
    const safeCcys = new Set(["USD", "JPY", "CHF", "XAU"]);
    if (riskOff) {
      if (riskCcys.has(base)) { score -= 10; lines.push("VIX up (risk-off) pressures risk currency"); }
      if (safeCcys.has(base) && riskCcys.has(quote)) score += 10;
      if (base === "XAU") { score += 10; lines.push("Risk-off supportive for gold"); }
    } else if (riskOn) {
      if (riskCcys.has(base)) { score += 10; lines.push("VIX down (risk-on) supports risk currency"); }
      if (base === "XAU") score -= 5;
    }
  }

  if (y10B && ctx.y10 != null) {
    if (y10B === "UP") {
      if (quote === "USD") { score -= 10; lines.push(`US10Y ${ctx.y10.toFixed(2)}% → USD bid`); }
      else if (base === "USD") { score += 10; lines.push(`US10Y ${ctx.y10.toFixed(2)}% → USD bid`); }
    } else if (y10B === "DOWN") {
      if (quote === "USD") score += 10;
      else if (base === "USD") score -= 10;
    }
  }

  score = Math.max(-100, Math.min(100, score));
  return {
    dxyChange: ctx.dxy, goldChange: ctx.gold, oilChange: ctx.oil,
    vixChange: ctx.vix, yield10yChange: ctx.y10,
    score, available: true,
    reasoning: lines.length ? lines.join(". ") : "No strong cross-market signal.",
  };
}

export const correlationScore = (r: CorrelationReport) => r.available ? r.score : 0;
