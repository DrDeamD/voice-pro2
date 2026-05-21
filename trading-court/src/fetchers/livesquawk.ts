// ============================================================================
// LiveSquawk Multi-Endpoint Fetcher — v4.5
//
// LiveSquawk publishes a public latest-news page but their RSS endpoint is
// inconsistent across deployments. We try a chain of likely URLs and
// fall back to HTML scraping of /latest-news as a last resort.
//
// Honest behaviour:
//   - Each URL tried with 5s timeout, no retries (fail-fast).
//   - HTML scrape uses 3 regex strategies (article tags, news-card divs,
//     timeline-item divs) and returns the first that yields items.
//   - When all strategies return empty, source-health shows red.
//   - Output is normalised NewsItem[] with proper timestamps & dedupe-ready
//     titles.
// ============================================================================

import { httpText } from "../http.js";
import { TTL } from "../config.js";
import type { NewsItem } from "../types/index.js";

// Re-uses the lexicon helpers from news.ts via module exports; to avoid
// circular imports we keep parsing local here.
const BULL_WORDS = [
  "BEATS", "STRONG", "SURGE", "RALLY", "JUMP", "HAWKISH", "HIKE", "TIGHTEN",
  "BETTER THAN EXPECTED", "ABOVE FORECAST", "ROBUST", "RESILIENT",
];
const BEAR_WORDS = [
  "MISSES", "WEAK", "SLUMP", "PLUNGE", "DROP", "DOVISH", "CUT",
  "EASE", "EASING", "WORSE THAN EXPECTED", "BELOW FORECAST",
];

const ENDPOINTS = [
  "https://www.livesquawk.com/rss/news",
  "https://www.livesquawk.com/feed",
  "https://livesquawk.com/rss",
  "https://www.livesquawk.com/latest-news",   // HTML fallback
];

function decodeHtml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDate(s: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function isRssLike(text: string): boolean {
  const t = text.slice(0, 500).toLowerCase();
  return t.includes("<rss") || t.includes("<feed") || t.includes("<channel");
}

function parseRss(xml: string): Array<{ title: string; link: string; desc: string; pub: Date | null }> {
  const out: Array<{ title: string; link: string; desc: string; pub: Date | null }> = [];
  const re = /<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi;
  let m;
  while ((m = re.exec(xml)) !== null && out.length < 25) {
    const block = m[0];
    const titleM = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!titleM) continue;
    const title = decodeHtml(titleM[1]);
    if (!title) continue;
    const linkM = block.match(/<link[^>]*?(?:href="([^"]*)"|>([\s\S]*?)<\/link>)/i);
    const link = decodeHtml((linkM && (linkM[1] || linkM[2])) || "");
    const descM = block.match(/<description[^>]*>([\s\S]*?)<\/description>|<summary[^>]*>([\s\S]*?)<\/summary>/i);
    const desc = decodeHtml((descM && (descM[1] || descM[2])) || "");
    const pubM = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>|<dc:date[^>]*>([\s\S]*?)<\/dc:date>|<published[^>]*>([\s\S]*?)<\/published>|<updated[^>]*>([\s\S]*?)<\/updated>/i);
    const pub = parseDate((pubM && (pubM[1] || pubM[2] || pubM[3] || pubM[4])) || "");
    out.push({ title, link, desc, pub });
  }
  return out;
}

// v4.6.15 — LiveSquawk /latest-news specific parser. Their markup uses
// SINGLE-quoted class attributes (class='latest__news__each ...'), which the
// generic double-quote regex never matched — the root cause of "0 LiveSquawk
// items". Structure:
//   <div class='latest__news__each ...'>
//     <div class='latest_news_each_title'>HEADLINE</div>
//     <div class='latest_news__each__body'><p>detail</p></div>
function parseLiveSquawkLatest(html: string): Array<{ title: string; link: string; desc: string; pub: Date | null }> {
  const out: Array<{ title: string; link: string; desc: string; pub: Date | null }> = [];
  const titleRe = /<div\s+class=['"]latest_news_each_title['"]>([\s\S]*?)<\/div>/gi;
  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(html)) !== null && out.length < 30) {
    const title = decodeHtml(m[1]);
    if (!title || title.length < 6) continue;
    const after = html.slice(m.index, m.index + 1500);
    const bodyM = after.match(/<div\s+class=['"]latest_news__each__body['"]>([\s\S]*?)<\/div>/i);
    const desc = bodyM ? decodeHtml(bodyM[1]) : "";
    out.push({ title, link: "", desc, pub: null });
  }
  return out;
}

function parseHtmlNewsBlocks(html: string): Array<{ title: string; link: string; desc: string; pub: Date | null }> {
  const out: Array<{ title: string; link: string; desc: string; pub: Date | null }> = [];
  const patterns = [
    /<article\b[^>]*>([\s\S]*?)<\/article>/gi,
    /<div\b[^>]*class="[^"]*(?:news|squawk|headline|timeline-item)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
    /<li\b[^>]*class="[^"]*(?:news|squawk|headline)[^"]*"[^>]*>([\s\S]*?)<\/li>/gi,
  ];
  for (const re of patterns) {
    let m;
    let localCount = 0;
    while ((m = re.exec(html)) !== null && localCount < 25) {
      const block = m[1];
      // Title: prefer h1/h2/h3/h4
      const titleM = block.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i) ||
                     block.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
      if (!titleM) continue;
      const title = decodeHtml(titleM[1]);
      if (!title || title.length < 10) continue;
      // Link
      const linkM = block.match(/<a[^>]*href="([^"]*)"/i);
      const link = linkM ? linkM[1] : "";
      // Description: first <p>
      const descM = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      const desc = descM ? decodeHtml(descM[1]) : "";
      // Date: <time datetime=""> or <time>...</time> or any datetime-like attribute
      const dateAttr = block.match(/datetime="([^"]*)"/i);
      const timeM = block.match(/<time[^>]*>([\s\S]*?)<\/time>/i);
      const pub = parseDate((dateAttr && dateAttr[1]) || (timeM && timeM[1]) || "");
      out.push({ title, link, desc, pub });
      localCount++;
    }
    if (out.length > 0) return out;  // first matching strategy wins
  }
  return out;
}

function sentimentScore(text: string): number {
  const u = text.toUpperCase();
  const bulls = BULL_WORDS.filter(w => u.includes(w)).length;
  const bears = BEAR_WORDS.filter(w => u.includes(w)).length;
  if (bulls === 0 && bears === 0) return 0;
  return Math.max(-1, Math.min(1, (bulls - bears) / (bulls + bears)));
}

function buildLiveSquawkItem(
  raw: { title: string; link: string; desc: string; pub: Date | null },
): NewsItem {
  const now = Date.now();
  const ageMs = raw.pub ? now - raw.pub.getTime() : null;
  const isFresh = ageMs !== null && ageMs >= 0;
  const freshnessHours: number | null = isFresh ? ageMs! / 3600_000 : null;
  return {
    title: raw.title,
    url: raw.link.startsWith("http") ? raw.link : ("https://www.livesquawk.com" + raw.link),
    source: "LiveSquawk",
    publishedUtc: raw.pub ? raw.pub.toISOString() : null,
    freshnessHours,
    sentiment: sentimentScore(raw.title + " " + raw.desc),
    impactCurrencies: [],  // filled by news engine via keyword match
    highImpact: false,
    breaking: false,
    category: "GENERAL",
    description: raw.desc,   // v4.6.15 — keep body for keyword match + display
  } as NewsItem;
}

export async function fetchLiveSquawkSmart(): Promise<NewsItem[]> {
  for (const url of ENDPOINTS) {
    try {
      const text = await httpText(url, {
        cacheKey: `ls:${url}`,
        ttlSec: TTL.NEWS_FAST,
        source: "livesquawk",
        timeoutMs: 5000,
        retries: 0,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept": "application/rss+xml, application/xml, text/html, */*",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      if (!text) continue;
      // RSS first; otherwise try the LiveSquawk-specific parser, then generic.
      let items: Array<{ title: string; link: string; desc: string; pub: Date | null }>;
      if (isRssLike(text)) {
        items = parseRss(text);
      } else {
        items = parseLiveSquawkLatest(text);
        if (items.length === 0) items = parseHtmlNewsBlocks(text);
      }
      if (items.length === 0) continue;
      return items.map(buildLiveSquawkItem);
    } catch { /* try next */ }
  }
  return [];
}
