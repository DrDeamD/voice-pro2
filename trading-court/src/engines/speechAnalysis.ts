// ============================================================================
// Speech Analysis — v4.2 Phase 2
//
// Walks news items (already fetched by existing news.ts + centralBanks.ts),
// identifies which ones are CB speeches (by source tag CB:* and speaker
// presence in the title/description), applies hawkDoveLexicon scoring, and
// produces:
//   1. A "recent speeches" feed for the dashboard
//   2. Per-currency aggregated hawkishness drift
//
// What this is NOT:
//   - An LLM. Pure rule-based lexicon match.
//   - An upcoming-speech radar (we have past speeches in RSS; upcoming
//     calendars are HTML and not yet scraped — that's optional Phase 3).
// ============================================================================

import type { NewsItem } from "../types/index.js";
import { scoreHawkishness, BANK_PRIMARY_CCY, type HawkDoveResult } from "./hawkDoveLexicon.js";

export interface ScoredSpeech {
  title: string;
  url: string;
  source: string;         // raw source tag e.g. "CB:fed"
  publishedUtc: string | null;
  freshnessHours: number | null;
  primaryCurrency: string;
  hawkDove: HawkDoveResult;
}

export interface CurrencyStanceEntry {
  currency: string;
  /** Aggregate score in [-50, +50] across speeches in the last 24h. */
  stanceScore: number;
  speechCount: number;
  /** Most influential speech in the period */
  topSpeech: ScoredSpeech | null;
}

export interface SpeechReport {
  recent: ScoredSpeech[];             // sorted by absolute effective impact descending
  byCurrency: Record<string, CurrencyStanceEntry>;
  /** Was there a high-impact speech within the last 60 minutes? */
  highImpactRecent: boolean;
  reasoning: string;
}

function isFromCB(source: string): boolean {
  const s = source.toLowerCase();
  // v4.6.2: the RSS parser tags items with the human label ("InvestingLive CB",
  // "ForexLive CB (legacy)") rather than the sourceKey "forexlive_cb", so we
  // also accept any label that ends in / contains a "cb" / "central bank" token.
  return (
    s.startsWith("cb:") ||
    s.includes("centralbank") ||
    s.includes("central bank") ||
    s.includes("forexlive_cb") ||
    s.includes(" cb")
  );
}

function extractBankId(source: string): string | null {
  if (source.startsWith("CB:")) return source.slice(3).toLowerCase();
  return null;
}

// v4.6.2: keyword → currency map so headlines from the generic CB feed (which
// carry no bank id) still attribute to the right currency. Longest/most-specific
// keys are checked via insertion order below.
// NOTE: order matters — includes() is substring-based, so the most-specific /
// collision-prone keys must come first. e.g. "PBOC" contains "BOC" (Bank of
// Canada), so CNY must be tested before CAD or every PBOC headline mis-maps.
const CB_KEYWORD_CCY: Array<[string, string]> = [
  ["PEOPLE'S BANK", "CNY"], ["PBOC", "CNY"],
  ["EUROPEAN CENTRAL", "EUR"], ["ECB", "EUR"], ["LAGARDE", "EUR"], ["EUROZONE", "EUR"],
  ["FEDERAL RESERVE", "USD"], ["FOMC", "USD"], ["POWELL", "USD"], ["FED ", "USD"],
  ["BANK OF ENGLAND", "GBP"], ["BOE", "GBP"], ["BAILEY", "GBP"],
  ["BANK OF JAPAN", "JPY"], ["BOJ", "JPY"], ["UEDA", "JPY"], ["KOEDA", "JPY"],
  ["SWISS NATIONAL", "CHF"], ["SNB", "CHF"], ["JORDAN", "CHF"], ["SCHLEGEL", "CHF"],
  ["RESERVE BANK OF AUSTRALIA", "AUD"], ["RBA", "AUD"], ["BULLOCK", "AUD"],
  ["BANK OF CANADA", "CAD"], ["BOC", "CAD"], ["MACKLEM", "CAD"],
];

function detectCcyFromText(text: string): string | null {
  const up = text.toUpperCase();
  for (const [kw, ccy] of CB_KEYWORD_CCY) {
    if (up.includes(kw)) return ccy;
  }
  return null;
}

export function analyzeSpeeches(newsItems: NewsItem[]): SpeechReport {
  const scored: ScoredSpeech[] = [];

  for (const item of newsItems) {
    const src = item.source ?? "";
    if (!isFromCB(src)) continue;

    const full = `${item.title} ${(item as any).description ?? ""}`;

    // Currency attribution: explicit bank id (CB:fed) → BANK_PRIMARY_CCY,
    // otherwise infer from headline keywords, defaulting to USD only as a last
    // resort. This keeps ECB headlines on EUR pairs, BOE on GBP, etc.
    const bankId = extractBankId(src);
    const primaryCurrency = bankId
      ? (BANK_PRIMARY_CCY[bankId] ?? "USD")
      : (detectCcyFromText(full) ?? "USD");

    const hd = scoreHawkishness(full);

    // v4.6.1: keep ALL CB-sourced items so the dashboard surfaces central-bank
    // activity even when the headline is operational/neutral (e.g. reference-rate
    // fixings). Hawk/Dove scoring still drives byCurrency stance — neutral items
    // contribute effectiveImpact 0, so the aggregation is undistorted. Items are
    // sorted by |impact| so scored speeches always rank above neutral chatter.

    scored.push({
      title: item.title,
      url: item.url,
      source: src,
      publishedUtc: item.publishedUtc,
      freshnessHours: item.freshnessHours,
      primaryCurrency,
      hawkDove: hd,
    });
  }

  // Sort by effective impact magnitude descending
  scored.sort((a, b) => Math.abs(b.hawkDove.effectiveImpact) - Math.abs(a.hawkDove.effectiveImpact));

  // Per-currency aggregation
  const byCurrency: Record<string, CurrencyStanceEntry> = {};
  for (const s of scored) {
    const ccy = s.primaryCurrency;
    if (!byCurrency[ccy]) {
      byCurrency[ccy] = { currency: ccy, stanceScore: 0, speechCount: 0, topSpeech: null };
    }
    // Sum impacts, capped at ±50 final
    byCurrency[ccy].stanceScore += s.hawkDove.effectiveImpact;
    byCurrency[ccy].speechCount += 1;
    if (!byCurrency[ccy].topSpeech ||
        Math.abs(s.hawkDove.effectiveImpact) > Math.abs(byCurrency[ccy].topSpeech!.hawkDove.effectiveImpact)) {
      byCurrency[ccy].topSpeech = s;
    }
  }
  // Clamp aggregated scores
  for (const k of Object.keys(byCurrency)) {
    const v = byCurrency[k].stanceScore;
    byCurrency[k].stanceScore = Math.max(-50, Math.min(50, v));
  }

  // High-impact recent: speech with |effectiveImpact| ≥ 25 in last 60 minutes
  const highImpactRecent = scored.some(s =>
    Math.abs(s.hawkDove.effectiveImpact) >= 25 &&
    (s.freshnessHours ?? Infinity) <= 1
  );

  const reasoning = scored.length === 0
    ? "No scored CB speeches in news pool"
    : `${scored.length} CB speeches scored. Top: ${scored[0]!.hawkDove.speaker ?? "?"} ` +
      `${scored[0]!.hawkDove.effectiveImpact >= 0 ? "+" : ""}${scored[0]!.hawkDove.effectiveImpact} ` +
      `→ ${scored[0]!.primaryCurrency}`;

  return {
    recent: scored.slice(0, 20),
    byCurrency,
    highImpactRecent,
    reasoning,
  };
}
