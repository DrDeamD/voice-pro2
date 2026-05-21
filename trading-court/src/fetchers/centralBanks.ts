// ============================================================================
// Central Bank Direct Feeds — v3.8
//
// Primary-source news from 8 central banks covering all currencies in the
// system (USD/EUR/GBP/JPY/AUD/CAD/NZD/CHF). Bypasses Reuters/Bloomberg/Google
// News intermediaries — items here arrive without aggregator delay or
// editorial reframing.
//
// All URLs are public, no API key, no auth.
//
// ─── Source verification status ─────────────────────────────────────────────
// VERIFIED columns: items appearing in the feedspot.com central-bank index
// (independent third-party RSS catalog updated 2023-2025) and in the bank's
// own published RSS documentation page.
//
// REQUIRES_FIRST_RUN_CHECK: format is correct per documentation but the URL
// has not been hit from a Cloudflare Workers egress IP. If a feed shows
// persistent red on the source-health bar after deploy, follow the bank's
// /rss listing page (linked in each comment) to find the current canonical
// URL.
//
// ─── Architecture ───────────────────────────────────────────────────────────
// Each fetcher returns NewsItem[]. They reuse the existing http.ts cache and
// source-health tracking. The aggregator function fetchCentralBankNews()
// runs all 8 in parallel, dedupes by title, and tags each item with the
// originating bank for audit.
// ============================================================================

import { httpText } from "../http.js";
import { TTL, CURRENCY_KEYWORDS, INTERVENTION_KEYWORDS, POLICY_KEYWORDS, RULES } from "../config.js";
import type { NewsItem } from "../types/index.js";

// ─── Feed registry ──────────────────────────────────────────────────────────
// Each entry maps bank → (URL, primary currency, fallback URL or null).
// Currency is the primary one the bank's monetary policy moves; bank releases
// often impact multiple currencies (e.g. Fed → USD but pulls EUR/JPY/GBP),
// so the news classifier still uses the full keyword lexicon.
interface CentralBankFeed {
  id: string;
  label: string;
  url: string;
  fallbackUrl?: string;
  primaryCurrency: string;
  // documentation page where the user can find the current URL if this one
  // breaks. NEVER auto-discovered — kept for human reference.
  docsUrl: string;
  status: "VERIFIED" | "REQUIRES_FIRST_RUN_CHECK";
}

export const CENTRAL_BANK_FEEDS: CentralBankFeed[] = [
  {
    id: "fed",
    label: "Federal Reserve",
    url: "https://www.federalreserve.gov/feeds/press_all.xml",
    primaryCurrency: "USD",
    docsUrl: "https://www.federalreserve.gov/feeds/feeds.htm",
    status: "VERIFIED",
  },
  {
    id: "ecb",
    label: "European Central Bank",
    url: "https://www.ecb.europa.eu/rss/press.html",
    primaryCurrency: "EUR",
    docsUrl: "https://www.ecb.europa.eu/home/html/rss.en.html",
    status: "VERIFIED",
  },
  {
    id: "boe",
    label: "Bank of England",
    url: "https://www.bankofengland.co.uk/rss/news",
    primaryCurrency: "GBP",
    docsUrl: "https://www.bankofengland.co.uk/rss",
    status: "VERIFIED",
  },
  {
    id: "boj",
    label: "Bank of Japan",
    url: "https://www.boj.or.jp/en/rss/whatsnew.xml",
    primaryCurrency: "JPY",
    docsUrl: "https://www.boj.or.jp/en/tips.htm",
    status: "VERIFIED",
  },
  {
    id: "rba",
    label: "Reserve Bank of Australia",
    url: "https://www.rba.gov.au/rss/rss-cb-media-releases.xml",
    fallbackUrl: "https://www.rba.gov.au/rss/rss-cb-rdp.xml",
    primaryCurrency: "AUD",
    docsUrl: "https://www.rba.gov.au/rss/",
    status: "VERIFIED",
  },
  {
    id: "boc",
    label: "Bank of Canada",
    url: "https://www.bankofcanada.ca/feed/",
    primaryCurrency: "CAD",
    docsUrl: "https://www.bankofcanada.ca/rss-feeds/",
    status: "VERIFIED",
  },
  {
    id: "rbnz",
    label: "Reserve Bank of New Zealand",
    url: "https://www.rbnz.govt.nz/-/feed/rss/news",
    primaryCurrency: "NZD",
    docsUrl: "https://www.rbnz.govt.nz/news-and-events/rss-feeds",
    // RBNZ has changed RSS endpoints multiple times historically — keep flag
    // until first-run telemetry confirms.
    status: "REQUIRES_FIRST_RUN_CHECK",
  },
  {
    id: "snb",
    label: "Swiss National Bank",
    url: "https://www.snb.ch/public/en/rss/news",
    primaryCurrency: "CHF",
    docsUrl: "https://www.snb.ch/en/iabout/rss",
    status: "VERIFIED",
  },
];

// ─── Local RSS parser (kept here rather than re-imported from news.ts to ─────
// keep this module independently consumable by the verifier CLI without
// pulling the full sentiment/keyword engine into a shell script).
function extractTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!m) return "";
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}

function* iterateItems(xml: string): Generator<string> {
  // RSS 2.0 uses <item>; some Atom-style feeds use <entry>. Try both.
  const reItem = /<item[\s>][\s\S]*?<\/item>/gi;
  const reEntry = /<entry[\s>][\s\S]*?<\/entry>/gi;
  let m;
  while ((m = reItem.exec(xml)) !== null) yield m[0];
  while ((m = reEntry.exec(xml)) !== null) yield m[0];
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x2F;/g, "/")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDate(s: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// ─── News-item construction ────────────────────────────────────────────────
// Mirrors the buildItem logic in fetchers/news.ts but adds primaryCurrency
// boosting: when a Fed item mentions JPY, the impact list includes JPY but
// USD is still primary. This means a BoJ Mimura intervention warning gets
// JPY in the impact list with HIGH priority even if the lexical match is weak.
function matchKeywords(text: string, keywords: string[]): string[] {
  const upper = text.toUpperCase();
  return keywords.filter(k => upper.includes(k));
}

// ─── Operational keyword filter (v4.0-stage1) ───────────────────────────────
// Central-bank RSS feeds leak two classes of items that have no directional
// content but, before this patch, polluted news scoring:
//
//   1. Holidays — Boxing Day, Christmas Day, Remembrance Day, Bank Holiday,
//      Good Friday, Easter, Canada Day, Victoria Day, etc. These are static
//      calendar events. The bank publishes them as RSS items (often dated to
//      the future, sometimes with no proper date at all) so the public can
//      see when offices close.
//
//   2. Forward-calendar entries — "Publication: Summary of Deliberations",
//      "Interest Rate Announcement" (scheduled), "MPC Meeting Schedule".
//      These are placeholders for upcoming releases, NOT the releases
//      themselves. The actual release will arrive later as a separate item.
//
// Both classes require an explicit `GENERAL` classification so that downstream
// logic (highImpact, breaking, dynamic weights) does not amplify them.
//
// Production evidence: user dashboard at 02:49 UTC showed five Bank of Canada
// items tagged BREAKING POLICY with "0m ago": Boxing Day, Christmas Day,
// Publication: Summary of Deliberations, Interest Rate Announcement,
// Remembrance Day. None of these were published 0m ago — they were
// future-dated calendar entries. The combination of Math.max(0, negative)
// clamping the age to zero and the default `POLICY` classification produced
// fake breaking news that vetoed every CAD-paired analysis.
const OPERATIONAL_KEYWORDS = [
  // Bank holidays (G10 + global)
  "BOXING DAY",
  "CHRISTMAS DAY", "CHRISTMAS EVE",
  "REMEMBRANCE DAY", "VETERANS DAY", "MEMORIAL DAY",
  "BANK HOLIDAY", "PUBLIC HOLIDAY", "STAT HOLIDAY", "STATUTORY HOLIDAY",
  "GOOD FRIDAY", "EASTER MONDAY",
  "NEW YEAR", "NEW YEAR'S DAY", "NEW YEARS DAY",
  "INDEPENDENCE DAY", "JULY 4",
  "THANKSGIVING",
  "VICTORIA DAY", "CANADA DAY",
  "LABOUR DAY", "LABOR DAY",
  "FAMILY DAY",
  "DAY OF MOURNING",
  "GOLDEN WEEK",
  // Forward-schedule entries (announcements of upcoming announcements)
  "PUBLICATION:",
  "MEETING SCHEDULE", "MPC SCHEDULE", "FOMC SCHEDULE",
  // Operational notices
  "OFFICE CLOSED", "CLOSED FOR",
  "OBSERVED",
];

function isOperationalNotice(text: string): boolean {
  const upper = text.toUpperCase();
  return OPERATIONAL_KEYWORDS.some(k => upper.includes(k));
}

function buildCbNewsItem(
  title: string,
  link: string,
  desc: string,
  pub: Date | null,
  feed: CentralBankFeed,
): NewsItem {
  const now = Date.now();

  // FIX (v4.0-stage1) — future-date detection.
  // Old code: `Math.max(0, (now - pub.getTime()) / 3600_000)` clamped negative
  // ages (i.e. future-dated items) to zero, which downstream logic then read
  // as "published 0 minutes ago = freshly breaking". RSS feeds of central
  // banks routinely include future-dated holiday/schedule entries; without
  // this fix, every such entry registered as breaking news.
  const ageMs: number | null = pub ? now - pub.getTime() : null;
  const isFresh = ageMs !== null && ageMs >= 0;
  const freshnessHours: number | null = isFresh ? ageMs! / 3600_000 : null;

  const full = `${title} ${desc}`;
  const upper = full.toUpperCase();

  // Primary currency is always added — this is the bank's home currency.
  const impactCcys = new Set<string>([feed.primaryCurrency]);

  // Add any other currency whose keywords appear in the headline/desc.
  for (const ccy of Object.keys(CURRENCY_KEYWORDS)) {
    if (ccy === feed.primaryCurrency) continue;
    if (matchKeywords(full, CURRENCY_KEYWORDS[ccy]).length) impactCcys.add(ccy);
  }

  // FIX (v4.0-stage1) — category classification.
  //
  // Old behaviour (v3.8): default = "POLICY" (line 189 commented "even routine
  // items move pricing"). This was wrong for two reasons:
  //   (a) "Routine items" includes holidays and schedule placeholders that
  //       move nothing.
  //   (b) Even genuine routine bank statements are better classified GENERAL
  //       and only escalated to POLICY when policy keywords match. The
  //       lexicon already captures the relevant verbs (HIKE/CUT/HIKE/etc.).
  //
  // New behaviour: GENERAL by default, POLICY only when explicit keywords
  // match, INTERVENTION when intervention-class keywords match, and a
  // hard-override to GENERAL for known operational notices (holidays etc.)
  // even if the title accidentally contains a policy keyword.
  let category: NewsItem["category"];
  if (isOperationalNotice(full)) {
    category = "GENERAL";
  } else if (INTERVENTION_KEYWORDS.some(k => upper.includes(k))) {
    category = "INTERVENTION";
  } else if (POLICY_KEYWORDS.some(k => upper.includes(k))) {
    category = "POLICY";
  } else {
    category = "GENERAL";
  }

  // FIX (v4.0-stage1) — breaking now requires `isFresh`, not `freshnessHours
  // !== null`. With future-date detection above, freshnessHours is null for
  // future items, so the old condition would have already failed; but making
  // the dependency explicit prevents regressions if freshnessHours is ever
  // re-derived in a different code path.
  const breaking = (
    (category === "INTERVENTION" || category === "POLICY") &&
    isFresh &&
    freshnessHours! * 60 <= RULES.breakingNewsMaxAgeMin
  );

  // Sentiment lexicon — kept minimal here; news.ts has a richer set, but for
  // central-bank items the action verbs are typically explicit (HIKE/CUT/HOLD).
  let sentiment = 0;
  if (/\b(HIKE|HAWKISH|TIGHTEN|RAISE)/i.test(full)) sentiment = +35;
  else if (/\b(CUT|DOVISH|EASE|EASING|LOWER)/i.test(full)) sentiment = -35;
  else if (/\b(HOLD|UNCHANGED|MAINTAIN)/i.test(full)) sentiment = 0;
  else if (/\b(INTERVEN|EMERGENCY|UNSCHEDULED)/i.test(full)) {
    // Direction depends on context — leave to interventionRegime in newsEngine.
    sentiment = 0;
  }

  // FIX (v4.0-stage1) — highImpact tied to category, no longer unconditional.
  //
  // Old behaviour (v3.8): `const highImpact = true;` for ALL items from CB
  // feeds, with the rationale that "every routine statement from these
  // institutions can move 50+ pips". This was the deepest part of the bug:
  //   - newsEngine.ts sets `highImpactPending = true` if ANY item has
  //     highImpact=true.
  //   - risk.ts vetoes any pair with highImpactPending=true (line 62).
  //   - Therefore: a single Boxing Day RSS entry on the BoC feed marked
  //     highImpact=true caused EVERY CAD-paired analysis to fail risk gate
  //     with "High-impact event recently released / pending — stand down".
  //
  // New behaviour: highImpact requires the same evidence as the news.ts
  // fetcher uses for non-CB items — INTERVENTION or POLICY classification.
  // Operational/holiday items classified GENERAL no longer trigger
  // highImpactPending or the risk-gate veto.
  const highImpact = category === "INTERVENTION" || category === "POLICY";

  // Velocity score: fresh + high-impact + breaking → highest priority.
  let velocity = 0;
  if (freshnessHours != null) {
    if (freshnessHours <= 0.5) velocity += 5;
    else if (freshnessHours <= 2) velocity += 3;
    else if (freshnessHours <= 6) velocity += 1;
  }
  if (breaking) velocity += 4;
  if (category === "INTERVENTION") velocity += 3;

  return {
    title,
    url: link,
    source: `CB:${feed.id}`,
    publishedUtc: pub?.toISOString() ?? null,
    freshnessHours,
    sentiment,
    impactCurrencies: [...impactCcys],
    highImpact,
    breaking,
    category,
    velocityScore: velocity,
  };
}

// ─── Per-feed fetcher ───────────────────────────────────────────────────────
async function fetchCbFeed(feed: CentralBankFeed, maxItems = 12): Promise<NewsItem[]> {
  const sourceTag = `cb_${feed.id}`;

  let xml = await httpText(feed.url, {
    cacheKey: `cb:${feed.id}`,
    ttlSec: TTL.NEWS_FAST,
    source: sourceTag,
    timeoutMs: 7000,
    retries: 1,
  });

  if (!xml && feed.fallbackUrl) {
    xml = await httpText(feed.fallbackUrl, {
      cacheKey: `cb:${feed.id}:fb`,
      ttlSec: TTL.NEWS_FAST,
      source: sourceTag,
      timeoutMs: 7000,
      retries: 1,
    });
  }

  if (!xml) return [];

  const items: NewsItem[] = [];
  const seen = new Set<string>();
  for (const block of iterateItems(xml)) {
    const title = decodeHtml(extractTag(block, "title"));
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());

    const link = decodeHtml(extractTag(block, "link"));
    const desc = decodeHtml(extractTag(block, "description") || extractTag(block, "summary"));
    const pubRaw =
      extractTag(block, "pubDate") ||
      extractTag(block, "dc:date") ||
      extractTag(block, "published") ||
      extractTag(block, "updated");
    const pub = parseDate(pubRaw);

    items.push(buildCbNewsItem(title, link, desc, pub, feed));
    if (items.length >= maxItems) break;
  }
  return items;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Fetch all 8 central banks in parallel. Failed feeds yield []; the
 *  source-health bar will show their status to the user. */
export async function fetchCentralBankNews(): Promise<NewsItem[]> {
  const results = await Promise.all(
    CENTRAL_BANK_FEEDS.map(f => fetchCbFeed(f).catch(() => [])),
  );
  // Flatten and dedupe by title — different banks sometimes echo each other's
  // statements (e.g. G7 joint statement) and we want one item per topic.
  const seen = new Set<string>();
  const flat: NewsItem[] = [];
  for (const arr of results) {
    for (const it of arr) {
      const k = it.title.toLowerCase().slice(0, 80);
      if (seen.has(k)) continue;
      seen.add(k);
      flat.push(it);
    }
  }
  return flat;
}

/** Fetch only the central banks whose primary currency is in the pair. */
export async function fetchCentralBankNewsForPair(base: string, quote: string): Promise<NewsItem[]> {
  const ccys = new Set<string>([base, quote]);
  if (base === "XAU") ccys.add("USD");

  const relevant = CENTRAL_BANK_FEEDS.filter(f => ccys.has(f.primaryCurrency));
  if (!relevant.length) return [];

  const results = await Promise.all(
    relevant.map(f => fetchCbFeed(f).catch(() => [])),
  );
  return results.flat();
}

/** Health probe used by the verifier CLI / dashboard. Returns one record per
 *  feed showing whether the URL produced parseable XML on the latest run. */
export interface CbFeedHealth {
  id: string;
  label: string;
  url: string;
  primaryCurrency: string;
  ok: boolean;
  itemCount: number;
  freshestAgeHours: number | null;
  status: CentralBankFeed["status"];
  docsUrl: string;
}

export async function probeCentralBankFeeds(): Promise<CbFeedHealth[]> {
  const probes = await Promise.all(
    CENTRAL_BANK_FEEDS.map(async (f): Promise<CbFeedHealth> => {
      try {
        const items = await fetchCbFeed(f, 5);
        const freshest = items
          .map(i => i.freshnessHours)
          .filter((x): x is number => x != null)
          .sort((a, b) => a - b)[0] ?? null;
        return {
          id: f.id,
          label: f.label,
          url: f.url,
          primaryCurrency: f.primaryCurrency,
          ok: items.length > 0,
          itemCount: items.length,
          freshestAgeHours: freshest,
          status: f.status,
          docsUrl: f.docsUrl,
        };
      } catch {
        return {
          id: f.id,
          label: f.label,
          url: f.url,
          primaryCurrency: f.primaryCurrency,
          ok: false,
          itemCount: 0,
          freshestAgeHours: null,
          status: f.status,
          docsUrl: f.docsUrl,
        };
      }
    }),
  );
  return probes;
}
