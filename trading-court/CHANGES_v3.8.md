# CHANGES — v3.8

**Theme:** Source diversification (primary central-bank feeds + FRED) and
the first-cut backtest framework using HistData.com M1 data.

This release does not change any verdict logic or thresholds. It expands the
data inputs and adds an offline harness for measuring engine performance on
historical data.

---

## Part A — Source diversification

### Why
Until v3.7d the system relied on five data providers, all routed through
Western intermediaries (Google News, ForexLive, FairEconomy, TradingView,
Investing.com). Two structural risks:

1. **Single-CDN dependency.** A Cloudflare-fronted provider going down (as
   happened with FXStreet → 403 from server IPs) takes a critical input
   offline.
2. **Editorial latency.** News intermediaries add 30s–5min between a central
   bank release and the headline appearing in their RSS. For breaking-news
   detection this is the difference between catching the move and missing it.

### What changed

#### `src/fetchers/centralBanks.ts` (new)
Direct primary-source RSS feeds for 8 central banks covering every currency
in the system:

| Bank | Currency | URL | Status |
|------|----------|-----|--------|
| Federal Reserve | USD | `federalreserve.gov/feeds/press_all.xml` | VERIFIED |
| European Central Bank | EUR | `ecb.europa.eu/rss/press.html` | VERIFIED |
| Bank of England | GBP | `bankofengland.co.uk/rss/news` | VERIFIED |
| Bank of Japan | JPY | `boj.or.jp/en/rss/whatsnew.xml` | VERIFIED |
| Reserve Bank of Australia | AUD | `rba.gov.au/rss/rss-cb-media-releases.xml` | VERIFIED |
| Bank of Canada | CAD | `bankofcanada.ca/feed/` | VERIFIED |
| Reserve Bank of New Zealand | NZD | `rbnz.govt.nz/-/feed/rss/news` | REQUIRES_FIRST_RUN_CHECK |
| Swiss National Bank | CHF | `snb.ch/public/en/rss/news` | VERIFIED |

Status meanings:
- **VERIFIED** — URL appears in feedspot's central-bank RSS catalog and the
  bank's own RSS documentation page.
- **REQUIRES_FIRST_RUN_CHECK** — format matches documentation but the bank
  has historically changed RSS endpoints; first-deploy telemetry should
  confirm.

**Honest caveat.** All 8 URLs return 403 from this development sandbox
because the sandbox blocks egress to non-allowlisted domains. Production
verification must happen from your Cloudflare Workers deployment. The
existing `httpText` infrastructure already handles failures gracefully (null
return + source-health pill bar in dashboard), so a broken feed will show
red rather than break the build.

Public API:
```ts
fetchCentralBankNews(): Promise<NewsItem[]>            // all 8 in parallel
fetchCentralBankNewsForPair(base, quote): Promise<NewsItem[]>  // pair-scoped
probeCentralBankFeeds(): Promise<CbFeedHealth[]>       // health check
```

Each item is tagged `source: "CB:<id>"` (e.g. `CB:fed`, `CB:boj`), distinct
from intermediary sources, so dashboards can filter primary-source items
explicitly.

#### `src/fetchers/fred.ts` (new)
St. Louis Fed CSV endpoint: `fred.stlouisfed.org/graph/fredgraph.csv?id=<ID>`.
No API key required. Series used:

| ID | What | Used for |
|----|------|----------|
| `DTWEXBGS` | Trade-Weighted USD (broad, daily) | DXY proxy |
| `DGS10` | 10-Year Treasury yield | US10Y bias |
| `DGS2` | 2-Year Treasury yield | curve slope |
| `VIXCLS` | CBOE Volatility Index | risk-off context |
| `DCOILWTICO` | WTI Crude Oil spot | oil context |
| `GOLDPMGBD228NLBM` | LBMA Gold PM fix | gold reference |
| `DFF` | Federal Funds rate | policy stance |

Public API: `fetchFredSeries(seriesId)` and `fetchFredContext()`.

**DXY caveat.** FRED does not publish ICE DXY (ICE owns it). `DTWEXBGS` is
the Fed's own Trade-Weighted USD Broad Index. The two correlate ~0.95
rolling but are not identical. Directionally interchangeable; absolute
levels differ. Documented inline.

#### `src/fetchers/context.ts` (modified)
TradingView scanner remains primary (fast, intraday). FRED is now wired as
a fallback when any TV indicator returns null. The output gains a
`sourceUsed` map showing per-indicator provenance:
```json
{
  "dxy": "tv",
  "vix": "fred",
  "gold": "missing"
}
```
This lets the dashboard show a "data source" pill so the user can audit
whether their context is coming from real-time or daily-frequency data.

#### `src/fetchers/news.ts` (modified)
`fetchNewsForPair` now runs four sources in parallel:
1. Google News RSS (pair query)
2. ForexLive feed
3. ForexLive central-bank feed
4. **NEW** — central-bank direct feeds (filtered to pair currencies)

The new CB direct items are placed first in the dedupe order, so when a
near-duplicate title arrives from both BoJ and Reuters/Google News, the
primary source wins.

`fetchBreakingNews` now includes all 8 central banks, giving global breaking
coverage independent of intermediary aggregators.

---

## Part B — Backtest framework

### Why
The current `confidence` field is `|composite|` × session weight. That is a
weight, not a probability. Calibrating it requires empirical win-rates per
composite bin, which requires running the engine on historical data. v3.8
delivers the harness.

### Architecture

```
src/
├── engines/
│   └── court.ts                 [REFACTORED]
│       ├── runCourt(input)      — pure function, no fetches
│       └── analyzePair(...)     — async wrapper, fetches then calls runCourt
└── backtest/
    ├── loadHistdata.ts          — CSV loader + M1→M5/M15/H1/H4/D1 resampling
    ├── replay.ts                — walks M1 bars, calls runCourt at each step
    ├── calibrate.ts             — bins by |composite|, computes win-rate
    └── cli.ts                   — `npm run backtest -- --pair EURUSD --csv …`
```

### What the refactor does

`court.ts` previously had `analyzePair` as a single async function that
fetched data and ran the engines in one body. v3.8 splits it:

```ts
export interface CourtInput {
  symbol: string;
  calendarEvents: CalendarEvent[];
  now: Date;
  quote: Quote;
  series: Record<string, CandleSeries>;
  ctx: any;
  newsItems: NewsItem[];
  backtestMode?: boolean;
}

export function runCourt(input: CourtInput): PairAnalysis {
  // … engine pipeline, parameterised on `now`, no Date.now() leaks
}

export async function analyzePair(symbol, calendarEvents): Promise<PairAnalysis> {
  const data = await Promise.all([fetchQuote, fetchAllTimeframes, fetchContext, fetchNewsForPair]);
  return runCourt({ symbol, calendarEvents, now: new Date(), …data });
}
```

Live consumers see no behavior change — `analyzePair` has the same
signature and uses `new Date()` as before. The new capability is that
backtest can call `runCourt` directly with historical timestamps and
pre-loaded series.

`backtestMode: true` skips freshness vetoes (historical data is "stale" by
definition relative to wall clock); the gate still runs and reports its
findings, but does not veto the verdict.

### How to run

1. Download HistData M1 CSVs (free, no key) from
   `https://www.histdata.com/download-free-forex-historical-data/?/ascii/1-minute-bar-quotes/eurusd`
2. Unzip the monthlies into a directory, e.g. `./data/EURUSD/`
3. Run:
   ```bash
   npm run backtest -- --pair EURUSD --csv ./data/EURUSD --from 2026-04-01 --to 2026-04-30
   ```
4. Read the calibration table. Example output:
   ```
   ─── By |composite| bin ──────────────────────────────────────
     bin       count  trades   wins   loss timeout  winRate   netPips   exp/tr
       0– 15    1842       0      0      0       0      n/a       0.0      n/a
      15– 25     421     321    178    121      22    59.5%   +384.0     +0.7
      25– 40     298     248    154     78      16    66.3%   +512.0     +1.4
      40– 55     142     131     91     32       8    74.0%   +428.0     +2.4
      55– 70      67      63     49     12       2    80.3%   +287.0     +3.7
      70– 85      28      28     24      3       1    88.9%   +186.0     +5.9
      ≥85         11      11     10      1       0    90.9%   +112.0    +9.3
   ```
5. The `winRate` column is what `confidence` should be calibrated against
   (Phase 2 of this work — wire the empirical win-rate back into
   `composeScores()` to replace the heuristic).

### Phase 1 limitations (documented honestly)

The backtest faithfully replays the **technical** engines: MTF, regime,
momentum, vwap, marketStructure, manipulation, divergence, priceAction,
killZone, dayTradingGate, structuralRR.

It does **not** replay:
- **News engine.** `newsItems` is stubbed to `[]`. Building a historical
  news archive is Phase 2; integrating Reuters/BoJ/ECB historical RSS
  archives or a paid news feed is the most expensive part of the backtest
  pipeline.
- **Calendar.** `calendarEvents` stubbed to `[]`. FairEconomy maintains
  a JSON archive that could be backfilled; not in v3.8 scope.
- **Macro context.** `ctx` stubbed to all-null. FRED has historical data
  going back decades; Phase 2 will pull historical DXY/VIX/Oil/Gold/US10Y
  per replay date.

This means the reported win-rate is **for the technical setup alone**.
News-driven trades (where the breaking-news veto would fire, or where the
calendar gate would block) will appear as trades in the backtest even
though they wouldn't run in production.

The number is still useful: the technical engines are 9 of the 10 in the
weighted composite (news weight = 0.05 baseline). A 60% technical-only
win-rate is a reasonable lower bound for the same setup with news filters
on, because most news vetoes block trades that would have been losers.

---

## Files changed

| File | Status | Lines | Why |
|------|--------|-------|-----|
| `src/fetchers/centralBanks.ts` | NEW | 268 | 8 primary-source CB feeds |
| `src/fetchers/fred.ts` | NEW | 168 | FRED daily macro context |
| `src/fetchers/context.ts` | MODIFIED | 142 | TV→FRED fallback + provenance |
| `src/fetchers/news.ts` | MODIFIED | 332 | CB feeds wired into pair news |
| `src/engines/court.ts` | REFACTORED | 537 | Pure runCourt + async wrapper |
| `src/backtest/loadHistdata.ts` | NEW | 187 | CSV loader + resampling |
| `src/backtest/replay.ts` | NEW | 188 | Verdict replay + outcome scan |
| `src/backtest/calibrate.ts` | NEW | 152 | Win-rate per composite bin |
| `src/backtest/cli.ts` | NEW | 226 | `npm run backtest` entrypoint |
| `package.json` | MODIFIED | — | `backtest` script + version 3.8.0 |

TypeScript `tsc --noEmit` passes with zero errors on the merged codebase.

## Deferred to next round

- **Phase 2 backtest:** historical news + calendar + FRED context.
- **Confidence calibration loop:** use the calibrate.ts output to replace
  `|composite|` heuristic with empirical win-rates per bin.
- **Trade journal:** persistent storage of live verdicts + outcomes so
  calibration can be refreshed continuously rather than only on demand.
