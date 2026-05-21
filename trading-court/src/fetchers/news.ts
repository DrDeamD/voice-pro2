// ============================================================================
// News Fetcher v4.3 — slimmed to two sources
//
// HISTORY OF SOURCE MIGRATIONS:
//   v3.3 (added):    ForexLive /feed + /feed/centralbank
//   v3.5.4 (drop):   FXStreet (Cloudflare blocks server IPs)
//   v4.3 (rebrand):  ForexLive → InvestingLive (investinglive.com).
//                    Try new domain first, fall back to legacy forexlive.com.
//   v4.3 (add):      LiveSquawk RSS (was previously incorrectly noted as paid;
//                    they publish a public news RSS at /rss/news).
//   v4.3 (delete):   Google News, Investing.com RSS, direct CB feeds (×8).
//
// Active sources after v4.3 trim:
//   1. InvestingLive general feed
//   2. InvestingLive Central Bank feed
//   3. LiveSquawk latest news
// ============================================================================
import { httpText } from "../http.js";
import {
  INSTRUMENTS, CURRENCY_KEYWORDS, TTL,
  INTERVENTION_KEYWORDS, POLICY_KEYWORDS, GEOPOLITICS_KEYWORDS,
  RULES,
} from "../config.js";
import type { NewsItem } from "../types/index.js";
// v4.3 — centralBanks.ts kept on disk for archival reference but no longer
// imported into the news pipeline (per user directive to slim sources).

// ─── Source URLs (v4.3 — slimmed pipeline) ──────────────────────────────────
// Active sources (only two, per user directive):
//   1. InvestingLive (formerly ForexLive)  — primary FX & CB news
//   2. LiveSquawk                          — fast-headline secondary
//
// COMPLETELY REMOVED in v4.3 (deleted, not parked):
//   - Google News           (noisy, broad index)
//   - Investing.com RSS     (slow, redundant)
//   - Direct CB RSS × 8     (Fed/ECB/BoE/BoJ/SNB/RBA/BoC/RBNZ — replaced by
//                            InvestingLive CB feed which aggregates them)
//
// REMOVED in v3.4.2: DailyFX (domain moved to IG)
// REMOVED in v3.5.4: FXStreet (Cloudflare blocks server IPs)
//
// DOMAIN MIGRATION (v4.3):
//   ForexLive rebranded to InvestingLive (investinglive.com). We try the new
//   domain first; if it doesn't resolve from this VPS, we fall back to the
//   legacy forexlive.com URLs via dual-attempt fetch.
const INVESTINGLIVE_FEED    = "https://www.investinglive.com/feed";
const INVESTINGLIVE_CB      = "https://www.investinglive.com/feed/centralbank";
const FOREXLIVE_LEGACY      = "https://www.forexlive.com/feed";
const FOREXLIVE_LEGACY_CB   = "https://www.forexlive.com/feed/centralbank";
// LiveSquawk — fast-news outlet. Public RSS endpoint as of 2026.
const LIVESQUAWK_URL        = "https://www.livesquawk.com/rss/news";

// ─── Sentiment lexicon ──────────────────────────────────────────────────────
const BULL_WORDS = [
  "BEATS", "STRONG", "SURGE", "RALLY", "JUMP", "HAWKISH", "HIKE", "TIGHTEN",
  "BETTER THAN EXPECTED", "ABOVE FORECAST", "ROBUST", "RESILIENT",
  "SAFE HAVEN", "INFLATION HOT", "CPI HOT", "RECORD HIGH",
  "OUTPERFORM", "UPGRADE", "BULLISH",
];
const BEAR_WORDS = [
  "MISSES", "WEAK", "SLUMP", "PLUNGE", "DROP", "DOVISH", "CUT",
  "EASE", "EASING", "RATE CUT", "WORSE THAN EXPECTED", "BELOW FORECAST",
  "RECESSION", "CONTRACTION", "SLOWDOWN", "PROFIT WARNING", "DOWNGRADE",
  "BEARISH", "TUMBLE", "CRASH",
];
const HIGH_IMPACT_TOKENS = [
  "FOMC", "NFP", "CPI", "PAYROLLS", "PAYROLL", "RATE DECISION", "RATE STATEMENT",
  "POWELL", "ECB DECISION", "BOE DECISION", "BOJ DECISION", "JACKSON HOLE",
  "NON-FARM", "UNEMPLOYMENT RATE", "GDP", "PCE", "CORE CPI",
];

// ─── Tiny XML helpers ───────────────────────────────────────────────────────
function extractTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!m) return "";
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}
function* iterateItems(xml: string): Generator<string> {
  const re = /<item[\s>][\s\S]*?<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) yield m[0];
}
function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x2F;/g, "/")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function parsePubDate(s: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// ─── Classification ─────────────────────────────────────────────────────────
// ─── Opinion / preview / forecast / wrap filter (v4.0 priority 1.7) ────────
//
// Background: news classifier matches keywords like "Fed", "RBA", "intervention"
// to assign POLICY/INTERVENTION/DATA categories. This catches REAL events
// (rate decisions, interventions) but ALSO catches ANALYTICAL ARTICLES that
// only MENTION those words.
//
// Production failures observed:
//
//   "Gold's outlook remains neutral-to-bearish amid prolonged US-Iran
//    stalemate and neutral Fed"             [classified POLICY because "Fed"]
//
//   "USD/JPY treads with caution amid fear of incurring another
//    intervention hit"                     [classified INTERVENTION]
//
//   "What are the main events for today?"  [classified DATA — meta preview]
//
//   "investingLive Asia-Pacific FX news wrap: Awaiting the RBA"
//                                          [classified POLICY because "RBA"]
//
// Each is opinion / preview / wrap content, NOT an event. Their POLICY/
// INTERVENTION/DATA tags promoted them to highImpact=true and kept the
// risk-gate veto active (or, in the wrap case, contaminated breaking news
// score before priority 1.5 closed that leak).
//
// Approach: keyword-based override, run BEFORE existing classifier. When a
// title contains any of these markers, force category=GENERAL and
// highImpact=false. Sentiment still computes (analyst tone is information),
// but the item no longer triggers pending-veto or breaking flags.
//
// Conservative by design. Better miss some opinion pieces than wrongly
// re-classify real events. NO semantic / conditional / probabilistic
// language detection — that is a separate priority if ever needed.
const OPINION_PREVIEW_KEYWORDS = [
  // Outlook / forecast prefixes
  "OUTLOOK",
  "FORECAST",
  "PREVIEW",
  "PROJECTION",
  // Wrap / summary articles
  "WRAP:",
  "WRAP ",         // trailing space avoids "WRAPPING UP"
  "ROUNDUP",
  "RECAP",
  "DAILY REVIEW",
  "DAILY BRIEFING",
  "MORNING REPORT",
  "MARKET WRAP",
  "NEWS WRAP",
  // Speculation phrasing — distinctive multi-word patterns
  "AMID FEAR",
  "AMID FEARS",
  "AMID CONCERNS",
  "AMID UNCERTAINTY",
  "SET TO HIKE",
  "SET TO CUT",
  "SET TO RAISE",
  "EXPECTED TO HIKE",
  "EXPECTED TO CUT",
  "EXPECTED TO RAISE",
  "COULD SEE",
  "MAY FACE",
  // Q&A / meta / preview
  "WHAT ARE THE MAIN",
  "WHAT TO WATCH",
  "WHAT TO EXPECT",
  "THINGS TO KNOW",
  "WATCHLIST",
  "AHEAD OF",
  "AWAITING THE",
  // Analyst-view markers
  "ANALYSTS SEE",
  "ANALYSTS EXPECT",
  "STRATEGISTS SEE",
  "STRATEGISTS EXPECT",
  "TRADERS SEE",
  "MARKET SEES",
  "TREADS WITH CAUTION",   // caught the production fixture exactly
];

function isOpinionOrPreview(text: string): boolean {
  const u = text.toUpperCase();
  return OPINION_PREVIEW_KEYWORDS.some(k => u.includes(k));
}

function classifyCategory(text: string): NewsItem["category"] {
  // v4.0 priority 1.7: opinion/preview articles never get a "real event"
  // classification, regardless of which currency/topic keywords they mention.
  if (isOpinionOrPreview(text)) return "GENERAL";
  const u = text.toUpperCase();
  if (INTERVENTION_KEYWORDS.some(k => u.includes(k))) return "INTERVENTION";
  if (POLICY_KEYWORDS.some(k => u.includes(k))) return "POLICY";
  if (HIGH_IMPACT_TOKENS.some(k => u.includes(k))) return "DATA";
  if (GEOPOLITICS_KEYWORDS.some(k => u.includes(k))) return "GEOPOLITICS";
  return "GENERAL";
}

function sentimentScore(text: string, category?: NewsItem["category"]): number {
  if (category === "INTERVENTION") return 0;
  const u = text.toUpperCase();
  const bulls = BULL_WORDS.filter(w => u.includes(w)).length;
  const bears = BEAR_WORDS.filter(w => u.includes(w)).length;
  if (bulls === 0 && bears === 0) return 0;
  const s = (bulls - bears) / (bulls + bears);
  return Math.max(-1, Math.min(1, s));
}

function isHighImpactText(text: string, category?: NewsItem["category"]): boolean {
  // v4.0 priority 1.7: opinion/preview/wrap articles are never high-impact,
  // even if their text contains tokens like "RBA", "FED", "CPI". This
  // prevents an analyst's "RBA expected to hike" article from triggering
  // the same risk-gate stand-down as an actual rate decision.
  if (isOpinionOrPreview(text)) return false;
  if (category === "INTERVENTION" || category === "POLICY") return true;
  const u = text.toUpperCase();
  return HIGH_IMPACT_TOKENS.some(t => u.includes(t));
}

function matchKeywords(text: string, keywords: string[]): string[] {
  const u = text.toUpperCase();
  return keywords.filter(k => u.includes(k.toUpperCase()));
}

function computeVelocityScore(
  freshnessHours: number | null,
  category: NewsItem["category"],
  highImpact: boolean,
): number {
  if (freshnessHours == null) return 0;
  const fresh = Math.max(0, 1 - freshnessHours / 6);
  const catMult: Record<NonNullable<NewsItem["category"]>, number> = {
    INTERVENTION: 1.0, POLICY: 0.9, DATA: 0.7, GEOPOLITICS: 0.6, GENERAL: 0.3,
  };
  const cat = catMult[category ?? "GENERAL"];
  const imp = highImpact ? 1.0 : 0.5;
  return Math.round(fresh * cat * imp * 100);
}

// ─── Build a NewsItem with full v3.3+ metadata ──────────────────────────────
function buildItem(
  title: string,
  link: string,
  desc: string,
  pub: Date | null,
  source: string,
  pairBaseQuote?: { base: string; quote: string },
): NewsItem {
  const now = Date.now();
  const freshnessH = pub ? Math.max(0, (now - pub.getTime()) / 3600_000) : null;
  const full = `${title} ${desc}`;
  const category = classifyCategory(full);

  const impactCcys = new Set<string>();
  if (pairBaseQuote) {
    const baseKws  = CURRENCY_KEYWORDS[pairBaseQuote.base]  || [];
    const quoteKws = CURRENCY_KEYWORDS[pairBaseQuote.quote] || [];
    if (matchKeywords(full, baseKws).length)  impactCcys.add(pairBaseQuote.base);
    if (matchKeywords(full, quoteKws).length) impactCcys.add(pairBaseQuote.quote);
  } else {
    for (const ccy of Object.keys(CURRENCY_KEYWORDS)) {
      if (matchKeywords(full, CURRENCY_KEYWORDS[ccy]).length) impactCcys.add(ccy);
    }
  }

  const highImpact = isHighImpactText(full, category);
  const breaking = (
    (category === "INTERVENTION" || category === "POLICY") &&
    freshnessH !== null &&
    freshnessH * 60 <= RULES.breakingNewsMaxAgeMin
  );

  return {
    title, url: link, source,
    publishedUtc: pub?.toISOString() ?? null,
    freshnessHours: freshnessH,
    sentiment: sentimentScore(full, category),
    impactCurrencies: [...impactCcys],
    highImpact,
    breaking,
    category,
    velocityScore: computeVelocityScore(freshnessH, category, highImpact),
  };
}

// ─── Generic RSS parser ─────────────────────────────────────────────────────
async function fetchRssFeed(
  url: string,
  cacheKey: string,
  ttlSec: number,
  sourceTag: string,
  defaultSource: string,
  maxItems = 25,
): Promise<NewsItem[]> {
  const xml = await httpText(url, {
    cacheKey,
    ttlSec,
    source: sourceTag,
    timeoutMs: 6000,
    retries: 1,
  });
  if (!xml) return [];
  const items: NewsItem[] = [];
  for (const block of iterateItems(xml)) {
    const title = decodeHtml(extractTag(block, "title"));
    if (!title) continue;
    const link = decodeHtml(extractTag(block, "link"));
    const desc = decodeHtml(extractTag(block, "description"));
    const pub  = parsePubDate(extractTag(block, "pubDate"));
    items.push(buildItem(title, link, desc, pub, defaultSource));
    if (items.length >= maxItems) break;
  }
  return items;
}

// ─── SOURCE 1: InvestingLive general feed (was ForexLive) ──────────────────
// Tries the new domain first, falls back to legacy forexlive.com if needed.
async function fetchInvestingLive(): Promise<NewsItem[]> {
  // Try new domain
  const newDomain = await fetchRssFeed(
    INVESTINGLIVE_FEED, "news:il_feed", TTL.NEWS_FAST, "forexlive", "InvestingLive", 25,
  );
  if (newDomain.length > 0) return newDomain;
  // Legacy fallback (forexlive.com still resolves on most edges)
  return fetchRssFeed(
    FOREXLIVE_LEGACY, "news:fl_legacy", TTL.NEWS_FAST, "forexlive", "ForexLive (legacy)", 25,
  );
}

// ─── SOURCE 2: InvestingLive Central Bank feed (best for breaking) ─────────
async function fetchInvestingLiveCB(): Promise<NewsItem[]> {
  const newDomain = await fetchRssFeed(
    INVESTINGLIVE_CB, "news:il_cb", TTL.NEWS_FAST, "forexlive_cb", "InvestingLive CB", 25,
  );
  if (newDomain.length > 0) return newDomain;
  return fetchRssFeed(
    FOREXLIVE_LEGACY_CB, "news:fl_cb_legacy", TTL.NEWS_FAST, "forexlive_cb", "ForexLive CB (legacy)", 25,
  );
}

// ─── SOURCE 3: LiveSquawk (v4.5 — multi-endpoint smart fetcher) ────────────
// Tries RSS endpoints first, falls back to HTML scraping of /latest-news.
import { fetchLiveSquawkSmart } from "./livesquawk.js";
async function fetchLiveSquawk(): Promise<NewsItem[]> {
  // Re-classify each item with the same lexicon that news.ts uses so they
  // get proper category/highImpact/breaking flags and currency keyword
  // matches.
  const raw = await fetchLiveSquawkSmart();
  return raw.map(it => buildItem(it.title, it.url, "", it.publishedUtc ? new Date(it.publishedUtc) : null, "LiveSquawk"));
}

// ─── Filter generic items by pair currencies ────────────────────────────────
//
// FIX (v4.0-stage1b) — removed the `|| it.breaking` bypass.
//
// Original intent (v3.3): "let global breaking events through to all pairs
// even if currency keywords don't match."
//
// Production failure: the bypass let CURRENCY-SPECIFIC breaking events
// through to UNRELATED pairs. Verified at 06:16 UTC on May 5, 2026:
// "Heads up: RBA monetary policy decision set for the bottom of the hour"
// (impactCurrencies = [AUD, NZD], breaking = true) was passing the filter
// for EUR/USD, USD/JPY, USD/CAD, USD/CHF, XAU/USD because of `|| it.breaking`.
// The newsEngine then set highImpactPending = true on each, and the risk
// gate vetoed all five with "High-impact event recently released / pending –
// stand down". The RBA event affects AUD pairs only; the other five had
// no business being blocked.
//
// New behaviour: an item passes the pair filter ONLY if its impactCurrencies
// list intersects the pair's currencies. The breaking flag carries forward
// untouched (still drives breakingActive, dynamic weights, etc.) — but now
// only for pairs that are actually exposed to the event.
//
// Trade-off: a TRULY global event (e.g. World Bank statement, geopolitical
// shock without specific currency keywords) with empty impactCurrencies
// will be filtered out for all pairs. This is acceptable because:
//   1. The item's downstream contribution to scoring requires impactCurrencies
//      anyway (newsEngine aggregates per-currency); without them, the item
//      never produced a pairScore signal.
//   2. The classifier in news.ts:buildItem matches against the full currency
//      keyword lexicon. A genuinely global event will, in practice, mention
//      at least one major currency.
//   3. Geopolitical events get GEOPOLITICS category; the currency exposure
//      for those is via correlation engine (DXY/Gold/Oil/VIX), not news.
function filterByPair(items: NewsItem[], base: string, quote: string): NewsItem[] {
  const ccys = new Set([base, quote]);
  if (base === "XAU") ccys.add("USD");
  return items.filter(it => it.impactCurrencies.some(c => ccys.has(c)));
}

function dedupe(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const it of items) {
    const k = it.title.toLowerCase().slice(0, 80);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function sortItems(items: NewsItem[]): NewsItem[] {
  return items.sort((a, b) => {
    if (a.breaking !== b.breaking) return a.breaking ? -1 : 1;
    const av = a.velocityScore ?? 0;
    const bv = b.velocityScore ?? 0;
    if (Math.abs(av - bv) > 2) return bv - av;
    return (a.freshnessHours ?? 999) - (b.freshnessHours ?? 999);
  });
}

// ─── PUBLIC API: fetchNewsForPair ───────────────────────────────────────────
// v4.3 — slimmed to TWO sources only:
//   1. InvestingLive (general + central-bank feeds; ex-ForexLive)
//   2. LiveSquawk    (fast headlines)
//
// Completely deleted from the code: Google News, direct CB feeds, Investing.com.
// Rationale: lighter snapshot, less dedupe noise, more accurate signal.
export async function fetchNewsForPair(symbol: string, maxItems = 15): Promise<NewsItem[]> {
  const meta = INSTRUMENTS[symbol];
  if (!meta) return [];

  const [il, ilCB, ls] = await Promise.all([
    fetchInvestingLive().catch(() => []),
    fetchInvestingLiveCB().catch(() => []),
    fetchLiveSquawk().catch(() => []),
  ]);

  // All three sources are generic (not pair-scoped). Filter to pair currencies.
  const ilPair   = filterByPair(il,   meta.base, meta.quote);
  const ilCBPair = filterByPair(ilCB, meta.base, meta.quote);
  const lsPair   = filterByPair(ls,   meta.base, meta.quote);

  // Order in dedupe matters: earlier wins. InvestingLive CB first (primary
  // CB signal), then LiveSquawk (fast-news), then InvestingLive general.
  const merged = dedupe([...ilCBPair, ...lsPair, ...ilPair]);

  return sortItems(merged).slice(0, maxItems);
}

// ─── PUBLIC API: fetchBreakingNews — global (no pair filter) ───────────────
// v4.3 — same trim: InvestingLive + LiveSquawk only.
export async function fetchBreakingNews(): Promise<NewsItem[]> {
  const [il, ilCB, ls] = await Promise.all([
    fetchInvestingLive().catch(() => []),
    fetchInvestingLiveCB().catch(() => []),
    fetchLiveSquawk().catch(() => []),
  ]);
  const all = dedupe([...ilCB, ...ls, ...il]);
  return all.filter(it => it.breaking).slice(0, 10);
}
