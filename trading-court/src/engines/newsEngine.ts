// ============================================================================
// News scoring engine — v3.3.0
//
// FIX from v3.2:
//   - v3.2 treated all news the same (5-min-old intervention warning ≡ 1h-old data print)
//   - v3.2 had no special handling for INTERVENTION items (where direction is
//     known from policy stance, not from sentiment lexicon)
//
// What's new in v3.3:
//   1. Three-tier weighting:
//        - Calendar surprise:  0.55  (hard data — highest weight)
//        - Breaking news:      0.30  (intervention/policy shock — fast signal)
//        - General headlines:  0.15  (context only)
//   2. INTERVENTION items inject explicit currency direction:
//        Japan MOF intervention warning  → JPY +50 (BoJ wants stronger JPY)
//        SNB intervention threat         → CHF +50
//        EM CB intervention              → not applicable here
//   3. Breaking news that conflicts with setup direction is reported via
//      breakingScore so the court can apply a hard veto.
// ============================================================================
import { INSTRUMENTS, RULES } from "../config.js";
import type { NewsItem, NewsReport } from "../types/index.js";

// ─── Freshness curve — v4.5: exponential decay + velocity boost ───────────
// Was: linear 1.0 → 0.1 over 24h. Problem: a 6h-old item still carried 0.75,
// which over-weighted stale headlines vs fresh ones.
//
// New: exponential half-life of 90 minutes. Items < 15min get a 1.4× velocity
// boost ("just hit the wire" effect). Items > 24h floor at 0.05.
//
//   t (min)    raw      with velocity boost (≤15min)
//   0          1.00     1.40
//   15         0.89     1.24
//   30         0.79
//   60         0.63
//   90         0.50
//   180        0.25
//   360        0.06
//   1440       0.0017 → 0.05 floor
function freshnessWeight(hours: number | null): number {
  if (hours == null) return 0.4;
  if (hours <= 0) return 1.4;  // future-stamped (rare) or just-published
  const min = hours * 60;
  const halfLife = 90;
  const decayed = Math.pow(0.5, min / halfLife);
  // Velocity boost for items ≤ 15min
  const boost = min <= 15 ? 1.4 : 1.0;
  return Math.max(0.05, decayed * boost);
}

// ─── Source quality multiplier (v4.5) ─────────────────────────────────────
// Some sources are higher signal-to-noise than others. CB direct (forexlive_cb)
// gets the highest weight because it's primary intervention/policy material.
// LiveSquawk gets a boost because it publishes very fast (within seconds of
// wire releases). General ForexLive feed gets baseline.
function sourceQualityMultiplier(source: string): number {
  const s = (source || "").toLowerCase();
  if (s.includes("forexlive cb") || s.includes("centralbank") || s.startsWith("cb:")) return 1.30;
  if (s.includes("livesquawk"))                                                       return 1.20;
  if (s.includes("forexlive") || s.includes("investinglive"))                         return 1.00;
  return 0.80;  // unknown / fallback source
}

// ─── Intervention direction map (v3.5.1 — full G10 table) ─────────────────
// PROBLEM in v3.5.0:
//   Only JPY (+60) and CHF (-50) had defined bias values. For GBP/EUR/AUD/
//   NZD/CAD intervention scenarios (real historical events like BoE 2022,
//   ECB 2000), MSID would correctly detect the regime AND fire the veto via
//   pair-currency overlap, BUT breakingScore stayed 0 because no implicit
//   bias was applied. The court still blocked the trade (good) but couldn't
//   tell the user *which direction* the bias points (bad UX).
//
// FIX in v3.5.1:
//   Centralized bias table in RULES.msidImpliedBias covers all G10 currencies
//   with empirically-grounded values. Both this function and applyMSIDBias
//   read from the same table, so no drift.
//
// Returns: positive = currency benefits (appreciates).
//          negative = currency suffers (depreciates).
function interventionBiasForCurrency(ccy: string, _title: string): number {
  return RULES.msidImpliedBias[ccy] ?? 0;
}

// ─── Compute breaking-news currency bias ────────────────────────────────────
function breakingBias(items: NewsItem[]): Record<string, number> {
  const bias: Record<string, number> = {};
  for (const it of items) {
    if (!it.breaking) continue;
    if (it.category === "INTERVENTION") {
      // Currency-specific bias from policy stance
      for (const ccy of it.impactCurrencies) {
        const b = interventionBiasForCurrency(ccy, it.title);
        if (b !== 0) bias[ccy] = (bias[ccy] ?? 0) + b;
      }
    } else if (it.category === "POLICY") {
      // Hawkish/dovish from sentiment lexicon
      const w = (it.velocityScore ?? 50) / 100;
      const s = it.sentiment * 50 * w;   // -50..+50
      for (const ccy of it.impactCurrencies) {
        bias[ccy] = (bias[ccy] ?? 0) + s;
      }
    }
  }
  // Cap at ±80
  for (const k of Object.keys(bias)) {
    bias[k] = Math.max(-80, Math.min(80, Math.round(bias[k])));
  }
  return bias;
}

// ─── v3.5 INNOVATION: Multi-Source Intervention Detection (MSID) ───────────
// THE PROBLEM v3.5 SOLVES:
//   In production we observed 4 INTERVENTION news items from 4 different sources
//   (Reuters, FXStreet, FOREX.com, investingLive) — but the breaking-news veto
//   did NOT fire. Why? The freshest item was 0.9h = 54min old. Our threshold
//   was 15min. So `breaking=false` for every individual item, despite the
//   market clearly being in an active intervention regime.
//
// THE INSIGHT:
//   A human trader watching the same screen would say: "Four independent
//   agencies are reporting Japan intervention. Even if the freshest headline
//   is 54 minutes old, this IS a breaking regime. Stand down on USDJPY longs."
//
// THE ALGORITHM:
//   For each currency:
//     1. Collect all INTERVENTION items affecting it within msidWindowHours
//     2. Count UNIQUE sources (different `source` field values)
//     3. Mark currency as "regime-active" if EITHER:
//          a) sourceCount ≥ msidMinSources (default 2)
//          b) any single item ≤ msidSingleItemFreshMin minutes (default 30)
//     4. Apply implied bias (JPY=+60, CHF=-50) to breakingScore
//
// This bypasses RSS feed lag entirely and mirrors the way real traders
// process consensus signals.
function detectInterventionRegime(items: NewsItem[]): {
  active: boolean;
  currencies: string[];
  sourceCount: number;
  sourceCountByCcy: Record<string, number>;
  oldestHours: number;
  reasoning: string;
} {
  const windowH = RULES.msidWindowHours;
  const minSources = RULES.msidMinSources;
  const freshSingleH = RULES.msidSingleItemFreshMin / 60;

  // Group INTERVENTION items by currency, tracking unique sources
  const byCcy: Record<string, { sources: Set<string>; items: NewsItem[] }> = {};
  for (const it of items) {
    if (it.category !== "INTERVENTION") continue;
    const age = it.freshnessHours ?? 999;
    if (age > windowH) continue;
    for (const ccy of it.impactCurrencies) {
      if (!byCcy[ccy]) byCcy[ccy] = { sources: new Set(), items: [] };
      byCcy[ccy].sources.add(it.source);
      byCcy[ccy].items.push(it);
    }
  }

  const active: string[] = [];
  const sourceCountByCcy: Record<string, number> = {};
  let maxSourceCount = 0;
  let maxOldestH = 0;
  const debugLines: string[] = [];

  for (const [ccy, group] of Object.entries(byCcy)) {
    const srcCount = group.sources.size;
    sourceCountByCcy[ccy] = srcCount;
    const freshestH = Math.min(...group.items.map(i => i.freshnessHours ?? 999));
    const oldestH = Math.max(...group.items.map(i => i.freshnessHours ?? 0));
    const consensusOk = srcCount >= minSources;
    const freshOk = freshestH <= freshSingleH;

    if (consensusOk || freshOk) {
      active.push(ccy);
      maxSourceCount = Math.max(maxSourceCount, srcCount);
      maxOldestH = Math.max(maxOldestH, oldestH);
      const why = consensusOk
        ? `${srcCount} sources (consensus ≥${minSources})`
        : `freshest ${(freshestH * 60).toFixed(0)}min ≤ ${RULES.msidSingleItemFreshMin}min`;
      debugLines.push(`${ccy}: ${why}`);
    }
  }

  return {
    active: active.length > 0,
    currencies: active,
    sourceCount: maxSourceCount,
    sourceCountByCcy,
    oldestHours: maxOldestH,
    reasoning: active.length
      ? `Intervention regime detected — ${debugLines.join("; ")}`
      : "no intervention regime",
  };
}

// ─── Apply MSID-implied bias when a currency is regime-active ──────────────
// v3.5.1: pulls from the same RULES.msidImpliedBias table as breakingBias()
// so we cover the full G10 set without code drift.
function applyMSIDBias(
  bias: Record<string, number>,
  regime: ReturnType<typeof detectInterventionRegime>,
): void {
  if (!regime.active) return;
  for (const ccy of regime.currencies) {
    if (bias[ccy] !== undefined) continue;  // already set by per-item breaking
    const implied = RULES.msidImpliedBias[ccy] ?? 0;
    if (implied !== 0) bias[ccy] = implied;
  }
}

// ─── analyzeNews — main entry point ─────────────────────────────────────────
export function analyzeNews(
  symbol: string,
  items: NewsItem[],
  calendarBonus: Record<string, number> = {},
): NewsReport {
  const meta = INSTRUMENTS[symbol];
  if (!meta) {
    return {
      items: [], baseScore: 0, quoteScore: 0, pairScore: 0,
      highImpactPending: false, reasoning: "Unknown symbol",
      breakingScore: 0, breakingActive: false, breakingCurrencies: [],
    };
  }

  // ─── 1. Aggregate per-currency sentiment from headlines ────────────────────
  const perCcy: Record<string, { sum: number; weight: number }> = {};
  let highImpact = false;
  // v4.0-stage1c — only items fresher than the configured window may
  // promote highImpactPending. Stale high-impact items (e.g. CPI from 90
  // min ago) still feed sentiment scoring but no longer trigger the
  // risk-gate stand-down veto. See RULES.highImpactPendingWindowMin.
  const windowH = RULES.highImpactPendingWindowMin / 60;
  for (const it of items) {
    const w = freshnessWeight(it.freshnessHours);
    // Boost weight for breaking-category items
    const catBoost = it.breaking ? 1.6 : 1.0;
    // v4.5 — source quality multiplier (forexlive_cb > livesquawk > forexlive)
    const srcQ = sourceQualityMultiplier(it.source);
    const wEff = w * catBoost * srcQ;
    for (const ccy of it.impactCurrencies) {
      if (!perCcy[ccy]) perCcy[ccy] = { sum: 0, weight: 0 };
      perCcy[ccy].sum += it.sentiment * wEff;
      perCcy[ccy].weight += wEff;
    }
    if (
      it.highImpact &&
      it.freshnessHours !== null &&
      it.freshnessHours >= 0 &&
      it.freshnessHours <= windowH
    ) {
      highImpact = true;
    }
  }

  const norm = (c: string) => {
    const p = perCcy[c];
    if (!p || p.weight <= 0) return 0;
    return (p.sum / p.weight) * 100;
  };

  let baseScore = norm(meta.base);
  let quoteScore = norm(meta.quote);

  // ─── 2. Breaking-news bias ─────────────────────────────────────────────────
  const breakBias = breakingBias(items);

  // ─── 2b. v3.5 — MSID: promote regime to "breaking" even if items are stale ─
  const regime = detectInterventionRegime(items);
  applyMSIDBias(breakBias, regime);

  // breakingActive fires for EITHER classical breaking items OR MSID regime
  const breakingItems = items.filter(it => it.breaking);
  const fromFresh = breakingItems.length > 0;
  const fromRegime = regime.active;
  const breakingActive = fromFresh || fromRegime;

  // Classify why we fired (used by court for clearer veto reason)
  let breakingType: NewsReport["breakingType"] = "NONE";
  if (fromFresh && fromRegime)      breakingType = "MULTI_SOURCE";
  else if (fromFresh)               breakingType = "FRESH";
  else if (fromRegime)              breakingType = "REGIME";

  // breakingCurrencies = union of per-item breaking + regime currencies
  const breakingCurrencies = [...new Set([
    ...breakingItems.flatMap(it => it.impactCurrencies),
    ...regime.currencies,
  ])];

  const breakBase  = breakBias[meta.base]  ?? 0;
  const breakQuote = breakBias[meta.quote] ?? 0;
  const breakingScore = Math.max(-100, Math.min(100, breakBase - breakQuote));

  // ─── 3. Calendar surprise bonus ────────────────────────────────────────────
  const calBase  = calendarBonus[meta.base]  ?? 0;
  const calQuote = calendarBonus[meta.quote] ?? 0;

  // ─── 4. Three-tier blend (v3.3) ────────────────────────────────────────────
  // Weights: 0.55 calendar | 0.30 breaking | 0.15 headlines
  // BUT: when none of the higher tiers fire, headlines fill the space.
  function blendCcy(rawSent: number, brk: number, cal: number): number {
    let totalW = 0;
    let acc = 0;
    if (cal !== 0)  { acc += cal * 0.55; totalW += 0.55; }
    if (brk !== 0)  { acc += brk * 0.30; totalW += 0.30; }
    if (rawSent !== 0) { acc += rawSent * 0.15; totalW += 0.15; }
    if (totalW === 0) return 0;
    return acc / totalW;
  }
  const baseFinal  = blendCcy(baseScore,  breakBase,  calBase);
  const quoteFinal = blendCcy(quoteScore, breakQuote, calQuote);

  const pairScore = Math.max(-100, Math.min(100, baseFinal - quoteFinal));

  // ─── 5. Reasoning narrative ────────────────────────────────────────────────
  const parts: string[] = [];
  if (breakingType === "MULTI_SOURCE") {
    parts.push(`⚡ BREAKING+REGIME: ${breakingItems.length} fresh + ${regime.sourceCount}-source consensus on ${regime.currencies.join(",")}`);
  } else if (breakingType === "REGIME") {
    parts.push(`⚡ MSID REGIME: ${regime.sourceCount} sources on ${regime.currencies.join(",")} (oldest ${regime.oldestHours.toFixed(1)}h)`);
  } else if (breakingType === "FRESH") {
    parts.push(`⚡ BREAKING: ${breakingItems.length} item(s) — ${breakingItems.slice(0, 2).map(i => i.title.slice(0, 50)).join("; ")}`);
  }
  if (calBase  !== 0) parts.push(`${meta.base} cal surprise ${calBase > 0 ? "+" : ""}${calBase}`);
  if (calQuote !== 0) parts.push(`${meta.quote} cal surprise ${calQuote > 0 ? "+" : ""}${calQuote}`);
  if (breakBase  !== 0) parts.push(`${meta.base} breaking ${breakBase > 0 ? "+" : ""}${breakBase}`);
  if (breakQuote !== 0) parts.push(`${meta.quote} breaking ${breakQuote > 0 ? "+" : ""}${breakQuote}`);
  if (perCcy[meta.base])  parts.push(`${meta.base} headlines ${baseScore.toFixed(0)}`);
  if (perCcy[meta.quote]) parts.push(`${meta.quote} headlines ${quoteScore.toFixed(0)}`);
  if (highImpact && !breakingActive) parts.push("HIGH-IMPACT event in window");
  if (!parts.length) parts.push("No relevant recent news");

  return {
    items,
    baseScore: baseFinal,
    quoteScore: quoteFinal,
    pairScore,
    highImpactPending: highImpact || breakingActive,
    reasoning: parts.join("; "),
    breakingScore,
    breakingActive,
    breakingCurrencies,
    interventionRegime: regime,
    breakingType,
  };
}

export const newsScore = (r: NewsReport) => r.pairScore;
