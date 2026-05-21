// ============================================================================
// Trading Court Pro - Central Configuration  (v3.3.0)
// ============================================================================
import type { InstrumentMeta } from "./types/index.js";

export const VERSION = "4.6.22-bestpair-verdict-link";

export const INSTRUMENTS: Record<string, InstrumentMeta> = {
  EURUSD: {
    symbol: "EURUSD", display: "EUR/USD", base: "EUR", quote: "USD",
    pip: 0.0001, decimals: 5,
    yahoo: "EURUSD=X", tv: "FX_IDC:EURUSD", swissquote: "EUR/USD",
    kraken: "EURUSD", stooq: "eurusd",
    keywords: ["EUR", "EURO", "EUROZONE", "ECB", "LAGARDE"],
  },
  GBPUSD: {
    symbol: "GBPUSD", display: "GBP/USD", base: "GBP", quote: "USD",
    pip: 0.0001, decimals: 5,
    yahoo: "GBPUSD=X", tv: "FX_IDC:GBPUSD", swissquote: "GBP/USD",
    kraken: "GBPUSD", stooq: "gbpusd",
    keywords: ["GBP", "POUND", "STERLING", "BOE", "BAILEY", "BRITAIN"],
  },
  USDJPY: {
    symbol: "USDJPY", display: "USD/JPY", base: "USD", quote: "JPY",
    pip: 0.01, decimals: 3,
    yahoo: "USDJPY=X", tv: "FX_IDC:USDJPY", swissquote: "USD/JPY",
    kraken: "USDJPY", stooq: "usdjpy",
    keywords: ["JPY", "YEN", "BOJ", "UEDA", "JAPAN", "MIMURA", "MOF", "KANDA", "SUZUKI", "KATO"],
  },
  AUDUSD: {
    symbol: "AUDUSD", display: "AUD/USD", base: "AUD", quote: "USD",
    pip: 0.0001, decimals: 5,
    yahoo: "AUDUSD=X", tv: "FX_IDC:AUDUSD", swissquote: "AUD/USD",
    kraken: "AUDUSD", stooq: "audusd",
    keywords: ["AUD", "AUSSIE", "RBA", "AUSTRALIA"],
  },
  USDCAD: {
    symbol: "USDCAD", display: "USD/CAD", base: "USD", quote: "CAD",
    pip: 0.0001, decimals: 5,
    yahoo: "USDCAD=X", tv: "FX_IDC:USDCAD", swissquote: "USD/CAD",
    kraken: "USDCAD", stooq: "usdcad",
    keywords: ["CAD", "LOONIE", "BOC", "CANADA"],
  },
  // NZDUSD removed in v3.11. Kraken does not list NZDUSD; Investing.com
  // pairId=8 fails on most server egress; Dukascopy BI5 (tried in
  // v3.10.1/v3.10.2) is too slow and unreliable for our 30-second
  // analysis cycle. No remaining free real-time source worked on the
  // production deployment. The honest move is to omit it entirely.
  // The system runs with 7 reliable instruments.
  USDCHF: {
    symbol: "USDCHF", display: "USD/CHF", base: "USD", quote: "CHF",
    pip: 0.0001, decimals: 5,
    yahoo: "USDCHF=X", tv: "FX_IDC:USDCHF", swissquote: "USD/CHF",
    kraken: "USDCHF", stooq: "usdchf",
    keywords: ["CHF", "FRANC", "SNB", "SWITZERLAND", "SWISS", "JORDAN"],
  },
  XAUUSD: {
    symbol: "XAUUSD", display: "XAU/USD", base: "XAU", quote: "USD",
    pip: 0.1, decimals: 2,
    yahoo: "GC=F", tv: "OANDA:XAUUSD", swissquote: "XAU/USD",
    kraken: "PAXGUSD", stooq: "xauusd",
    keywords: ["GOLD", "XAU", "BULLION", "PRECIOUS METAL"],
  },
  // ─── v4.1 Phase 1 — EUR Crosses (no-USD) ────────────────────────────────
  // We start with EUR pairs because:
  //   1. Lower volatility than JPY crosses → calibration easier
  //   2. Highest cross-pair coverage across our free sources (Kraken, Stooq,
  //      Swissquote, TradingView all support EUR/JPY and EUR/GBP natively)
  //   3. The helper-rate dependency is well-anchored: USDJPY and GBPUSD are
  //      already analysed every snapshot, so the pipValueCache will be hot.
  // For full design see PLAN_COURT_UPGRADE_v4.1.md section 3.1.
  EURJPY: {
    symbol: "EURJPY", display: "EUR/JPY", base: "EUR", quote: "JPY",
    pip: 0.01, decimals: 3,
    yahoo: "EURJPY=X", tv: "FX_IDC:EURJPY", swissquote: "EUR/JPY",
    kraken: "EURJPY", stooq: "eurjpy",
    keywords: ["EUR", "JPY", "EURO", "YEN", "EUROZONE", "JAPAN", "BOJ", "ECB"],
  },
  EURGBP: {
    symbol: "EURGBP", display: "EUR/GBP", base: "EUR", quote: "GBP",
    pip: 0.0001, decimals: 5,
    yahoo: "EURGBP=X", tv: "FX_IDC:EURGBP", swissquote: "EUR/GBP",
    kraken: "EURGBP", stooq: "eurgbp",
    keywords: ["EUR", "GBP", "EURO", "POUND", "EUROZONE", "BRITAIN", "ECB", "BOE"],
  },
  // ─── v4.1 Phase 2 — crosses verified working on production deploy ──────
  // Selected by BIS Triennial 2022 turnover + production-verified data
  // sources (Kraken/Swissquote/TradingView/Stooq all return real candles).
  //
  // REMOVED after first production deploy (2026-05-20):
  //   GBPJPY  → all candle sources returned empty / UNKNOWN regime
  //   CADJPY  → same — no usable candle stream from any free source
  //   GBPCHF  → same
  // Drop dead pairs rather than show permanent UNKNOWN. Same philosophy as
  // NZDUSD removal in v3.11. If a reliable free source emerges, they can be
  // re-added.
  //
  // Kept (verified working):
  //   AUDJPY  → Kraken native + Stooq backup
  //   EURCHF  → Kraken native + Stooq
  //   EURAUD  → Kraken native + Stooq
  //   EURCAD  → Kraken native + Stooq
  AUDJPY: {
    symbol: "AUDJPY", display: "AUD/JPY", base: "AUD", quote: "JPY",
    pip: 0.01, decimals: 3,
    yahoo: "AUDJPY=X", tv: "FX_IDC:AUDJPY", swissquote: "AUD/JPY",
    kraken: "AUDJPY", stooq: "audjpy",
    keywords: ["AUD", "JPY", "AUSSIE", "YEN", "AUSTRALIA", "RBA", "BULLOCK", "JAPAN", "BOJ"],
  },
  EURCHF: {
    symbol: "EURCHF", display: "EUR/CHF", base: "EUR", quote: "CHF",
    pip: 0.0001, decimals: 5,
    yahoo: "EURCHF=X", tv: "FX_IDC:EURCHF", swissquote: "EUR/CHF",
    kraken: "EURCHF", stooq: "eurchf",
    keywords: ["EUR", "CHF", "EURO", "FRANC", "EUROZONE", "SNB", "SWITZERLAND", "ECB", "LAGARDE", "JORDAN", "SCHLEGEL"],
  },
  EURAUD: {
    symbol: "EURAUD", display: "EUR/AUD", base: "EUR", quote: "AUD",
    pip: 0.0001, decimals: 5,
    yahoo: "EURAUD=X", tv: "FX_IDC:EURAUD", swissquote: "EUR/AUD",
    kraken: "EURAUD", stooq: "euraud",
    keywords: ["EUR", "AUD", "EURO", "AUSSIE", "EUROZONE", "AUSTRALIA", "ECB", "RBA", "LAGARDE", "BULLOCK"],
  },
  EURCAD: {
    symbol: "EURCAD", display: "EUR/CAD", base: "EUR", quote: "CAD",
    pip: 0.0001, decimals: 5,
    yahoo: "EURCAD=X", tv: "FX_IDC:EURCAD", swissquote: "EUR/CAD",
    kraken: "EURCAD", stooq: "eurcad",
    keywords: ["EUR", "CAD", "EURO", "LOONIE", "EUROZONE", "CANADA", "ECB", "BOC", "LAGARDE", "MACKLEM"],
  },
};

// ─── USD baseline + speakers ────────────────────────────────────────────────
export const USD_KEYWORDS = [
  "USD", "DOLLAR", "GREENBACK", "FED", "FOMC", "POWELL", "WALLER", "WILLIAMS",
  "JEFFERSON", "BARR", "BOWMAN", "TREASURY", "YELLEN", "BESSENT",
  "CPI", "NFP", "JOBLESS", "PAYROLL", "ISM", "PMI", "PCE",
];

export const CURRENCY_KEYWORDS: Record<string, string[]> = {
  USD: USD_KEYWORDS,
  EUR: ["EUR", "EURO", "EUROZONE", "ECB", "LAGARDE", "DE GUINDOS", "GERMANY", "FRANCE", "ITALY", "SPAIN"],
  GBP: ["GBP", "POUND", "STERLING", "BOE", "BAILEY", "BRITAIN", "UK ", "BRITISH", "BREXIT"],
  JPY: ["JPY", "YEN", "BOJ", "UEDA", "JAPAN", "JAPANESE", "MIMURA", "KANDA", "SUZUKI", "KATO", "MOF",
        "FINANCE MINISTRY", "TOP FX", "FX DIPLOMAT", "VICE FINANCE"],
  AUD: ["AUD", "AUSSIE", "RBA", "AUSTRALIA", "AUSTRALIAN", "BULLOCK"],
  CAD: ["CAD", "LOONIE", "BOC", "CANADA", "CANADIAN", "MACKLEM"],
  NZD: ["NZD", "KIWI", "RBNZ", "NEW ZEALAND", "ORR"],
  CHF: ["CHF", "FRANC", "SNB", "SWITZERLAND", "SWISS", "JORDAN", "SCHLEGEL"],
  XAU: ["GOLD", "XAU", "BULLION", "PRECIOUS METAL"],
};

// ─── BREAKING-NEWS classification keywords (v3.3 — Priority 1) ──────────────
// These are short fast-moving phrases that DO NOT appear in normal data feeds
// but DO move markets violently within seconds.
export const INTERVENTION_KEYWORDS = [
  "INTERVENTION", "VERBAL INTERVENTION", "FX INTERVENTION", "INTERVENE",
  "FINAL WARNING", "WARNING BEFORE ACTION", "READY TO ACT",
  "TAKE ACTION", "TAKE STEPS", "TAKE MEASURES", "TAKE APPROPRIATE",
  "RAPID MOVE", "EXCESSIVE MOVE", "EXCESSIVE VOLATILITY", "ONE-SIDED",
  "DECISIVE ACTION", "BOLD ACTION", "FOREX OPERATION",
  "SPECULATIVE", "SPECULATORS", "DISORDERLY",
  "JAWBONING", "FX AGREEMENT", "G7 STATEMENT",
  "CHECK RATES", "RATE CHECK",  // BoJ pre-intervention signal
];

export const POLICY_KEYWORDS = [
  "EMERGENCY", "EMERGENCY MEETING", "UNSCHEDULED",
  "RATE HIKE", "RATE CUT", "PIVOT", "HAWKISH PIVOT", "DOVISH PIVOT",
  "GUIDANCE", "FORWARD GUIDANCE",
];

export const GEOPOLITICS_KEYWORDS = [
  "WAR", "STRIKE", "MISSILE", "ATTACK", "INVASION", "SANCTIONS",
  "OPEC", "OIL CUT", "SUPPLY DISRUPTION",
];

// ─── Context instruments ────────────────────────────────────────────────────
export const CONTEXT = {
  DXY:   { yahoo: "DX-Y.NYB", tv: "TVC:DXY"   },
  GOLD:  { yahoo: "GC=F",     tv: "OANDA:XAUUSD" },
  OIL:   { yahoo: "CL=F",     tv: "NYMEX:CL1!" },
  VIX:   { yahoo: "^VIX",     tv: "TVC:VIX"   },
  US10Y: { yahoo: "^TNX",     tv: "TVC:US10Y" },
};

// ─── HTTP ───────────────────────────────────────────────────────────────────
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent": USER_AGENT,
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

export const HTTP_TIMEOUT_MS = 8000;

// ─── TTLs (seconds) — v3.5.2: tightened baseline + adaptive rapid mode ─────
// Two profiles share the same shape. The orchestrator picks one per request:
//   - DEFAULT: normal market state (current TTLs were already aggressive)
//   - RAPID:   activated when news.breakingActive is true on ANY pair
// In rapid mode, refresh cycles tighten ~3x. Frontend reads system state from
// /api/state and adjusts its own setInterval accordingly.
export const TTL = {
  // Quotes / candles unchanged — these are about market structure, not events
  QUOTE: 5,
  CANDLES_M5: 60,
  CANDLES_M15: 120,
  CANDLES_H1: 180,
  CANDLES_H4: 300,
  CANDLES_D1: 900,

  // News — v3.5.2: NEWS_FAST tightened 45 → 25s baseline
  NEWS_FAST: 25,
  NEWS_SLOW: 120,

  // Calendar — v3.4.2: FairEconomy only
  CALENDAR_STRUCTURE: 60,
  CALENDAR_NEXTWEEK:  900,
  CALENDAR_ACTUALS:   30,
  CALENDAR_PENDING:   15,

  CONTEXT: 120,
  // SNAPSHOT — v3.5.2: tightened 30 → 15s baseline
  SNAPSHOT: 15,
};

// Rapid-mode overrides — applied when adaptive polling triggers
export const TTL_RAPID = {
  ...TTL,
  NEWS_FAST: 8,            // (was 25 baseline; rapid hits feeds every 8s)
  NEWS_SLOW:  30,           // (was 120)
  CALENDAR_STRUCTURE: 30,   // (was 60)
  SNAPSHOT: 4,              // (was 15) — server cache near pass-through
};

// Frontend refresh intervals (milliseconds) — read by the dashboard
export const REFRESH_INTERVALS_MS = {
  NORMAL: 15000,    // 15s in calm market (was 30s)
  RAPID:   5000,    // 5s when breaking active
  CALENDAR_PENDING: 15000,
};

// Backwards-compat alias for any older imports
(TTL as any).NEWS = TTL.NEWS_FAST;
(TTL as any).CALENDAR = TTL.CALENDAR_STRUCTURE;

// ─── Indicator parameters ───────────────────────────────────────────────────
export const IND = {
  emaFast: 20,
  emaMid: 50,
  emaSlow: 200,
  rsiPeriod: 14,
  atrPeriod: 14,
  adxPeriod: 14,
  bbPeriod: 20,
  bbStdDev: 2.0,
  structureLookback: 20,
  minBars: 210,
};

// ─── Engine weights (must sum ~1.0) ─────────────────────────────────────────
export const WEIGHTS = {
  marketStructure: 0.22,
  mtf:             0.17,
  momentum:        0.13,
  vwap:            0.07,
  priceAction:     0.09,
  manipulation:    0.08,
  divergence:      0.05,
  regime:          0.07,
  correlation:     0.07,
  news:            0.05,
};

// ─── Dynamic weight overrides ───────────────────────────────────────────────
export const DYNAMIC_WEIGHTS = {
  // During HIGH-impact events: news takes priority, structure weight reduced
  highImpactNews: {
    news:            0.16,
    marketStructure: 0.16,
    vwap:            0.05,
    manipulation:    0.06,
    divergence:      0.04,
  },
  // NEW v3.3: Breaking news (intervention/policy shock) — even more aggressive
  // News dominates because structure becomes meaningless during a 200-pip squeeze
  // v4.6.17 — news 0.25→0.30 so the merged map sums to 1.00. The previous set
  // summed to 0.95 (carried-over priceAction 0.09 + regime 0.07 + correlation
  // 0.07 were not rescaled), silently shrinking composite magnitude ~5% in
  // breaking mode — exactly when news should dominate.
  breakingNews: {
    news:            0.30,
    marketStructure: 0.12,
    mtf:             0.13,
    momentum:        0.10,
    vwap:            0.04,
    manipulation:    0.05,
    divergence:      0.03,
  },
};

// ─── Rules ──────────────────────────────────────────────────────────────────
export const RULES = {
  // v3.5.5 CALIBRATION — research-backed thresholds for intraday trading
  //
  // Mathematical foundation:
  //   Expected Value = (P_win × RR) - (P_loss × 1)
  //   With RR=1.5: P_win=50% → EV=+0.25 (break-even+)
  //                P_win=60% → EV=+0.50 (profitable)
  //   Therefore Confidence 60 = profitable system, no need for 72.
  //
  // Research references:
  //   - Tom Hougaard ($25M intraday): "If you wait for everything to align,
  //     you trade nothing"
  //   - Linda Raschke: 4-5 of 8 conditions = enter, don't wait for 7/8
  //   - Brett Steenbarger: 2-5 trades/day is optimal for day traders
  //   - ICT methodology: 3 confirmations enough (structure + liquidity + zone)
  //
  // Production evidence (v3.5.4):
  //   8 pairs × full day = 0 trades. EUR/USD scored 31 with MTF+100/VWAP+63.
  //   Threshold 72 was effectively a closed gate, not intelligent filtering.
  minConfidence: 60.0,                       // v3.5.5: was 72 — see math above
  minRR: 1.5,
  minRRStrongTrend: 1.3,

  adxDeadBelow: 15.0,
  adxTrendAbove: 22.0,

  atrDeadPct: 0.05,
  bbDeadPct: 0.30,

  rsiOverbought: 70.0,
  rsiOversold: 30.0,

  slAtrMult: 1.5,
  tp1AtrMult: 1.5,
  tp2AtrMult: 3.0,
  tp3AtrMult: 5.0,

  // v3.5.5: calendar block widths reduced to institutional-standard ±30min
  // Was 90min (3-hour total exclusion) which over-penalized neutral periods
  calendarBlockMinutes: 30,                  // v3.5.5: was 90 — now ±30min around HIGH
  calendarBlockImpactFloor: "HIGH" as const,
  calendarSoftBlockMinutes: 15,              // v3.5.5: was 30 — strict zone tightened
  calendarSoftBlockImpactFloor: "MEDIUM" as const,

  // v3.5.5: tier ladder rebalanced to match new minConfidence=60
  tierRejectBelow: 50.0,                     // v3.5.5: was 65 — below 50 = noise
  tierWeakBelow:   60.0,                     // v3.5.5: was 72 — matches minConfidence
  tierValidBelow:  72.0,                     // v3.5.5: was 82 — old "weak" zone now "valid"

  sizeMultStrong: 1.00,
  sizeMultValid: 0.70,
  sizeMultWeak: 0.40,
  sizeMultReject: 0.00,

  // v3.5.5 — breaking news rules CALIBRATED
  // Old: any |score|≥30 vetoed → too aggressive; |score|=30 means weak signal
  // New: |score|≥45 = strong enough to veto; below = soft penalty via confidence
  breakingNewsMaxAgeMin: 30,                 // v3.5.5: was 60 — true breaking ≤30min
  breakingNewsConflictThreshold: 45,         // v3.5.5: was 30 — separates noise from signal
  breakingNewsBoostFactor: 1.6,

  // v4.0-stage1c — highImpactPending sliding window.
  //
  // Problem: highImpactPending was a permanent boolean. Any item with
  // highImpact=true in the items list set it to true forever, regardless
  // of how old the item was. Switzerland CPI from 1.7 hours ago kept
  // vetoing USD/CHF at 10:13 UTC — yesterday's news, market already digested.
  //
  // Rule: highImpactPending = true ONLY when at least one high-impact
  // item is fresher than this window. Stale items keep contributing to
  // sentiment scoring (they ARE real events, their effect lingers in price)
  // but they no longer trigger the risk-gate stand-down veto.
  //
  // 60 minutes covers:
  //   - 0-15 min after release: spreads wide, spikes, definitely stand down
  //   - 15-45 min: market digesting, news engine measures real reaction
  //   - 45-60 min: tail of immediate impact, generous margin
  //   - >60 min: stale, downstream sentiment scoring continues but no veto
  //
  // ⚠️ TODO (calibration): the value 60 is an EDUCATED GUESS, not measured.
  // It is the median of common practitioner guidance ("wait an hour after
  // major data"). The empirically optimal value depends on the specific
  // event (NFP differs from CPI differs from ECB Q&A) and the pair's
  // typical liquidity recovery time. After priority 9 (live calibration
  // warmup) accumulates ~6 weeks of journal data, this constant should
  // be re-derived per-event-type from outcome distributions.
  //
  // Acceptable range until then: 45–90. Outside that window, signal that
  // we are guessing wildly. The default 60 is conservative-mid.
  highImpactPendingWindowMin: 60,

  // NEW v3.5 — Multi-Source Intervention Detection (MSID)
  // The user's production showed 4 INTERVENTION items from 4 sources but breaking
  // didn't fire because the FRESHEST was 54min old (>15min threshold).
  // MSID solves this: if K different sources report intervention on the same
  // currency within W hours, the regime is "active" regardless of freshness.
  msidMinSources: 2,                // ≥2 different sources reporting same currency
  msidWindowHours: 6,               // within last 6 hours
  msidSingleItemFreshMin: 30,       // a single source with item ≤30min also triggers

  // v3.5.1 — Per-currency intervention bias (full G10 coverage)
  // Sign convention: positive = currency benefits (appreciates) from intervention
  //                  negative = currency suffers (depreciates) from intervention
  // Each value is calibrated from historical central-bank intervention behavior.
  msidImpliedBias: {
    JPY: +60,   // BoJ/MOF intervenes when JPY too WEAK → wants stronger JPY
    CHF: -50,   // SNB intervenes when CHF too STRONG → wants weaker CHF (2011, 2015)
    GBP: +40,   // BoE 2022 emergency gilt-buying defended GBP from collapse
    EUR: +40,   // ECB G7 2000 verbal intervention to support a weak EUR
    AUD: -30,   // RBA verbal warnings typically aimed at curbing AUD strength
    NZD: -30,   // RBNZ similar pattern to RBA — talk down strength
    CAD: -20,   // BoC rarely intervenes; usually mild dovish lean
    USD:   0,   // Fed avoids verbal FX intervention; no implicit bias
  } as Record<string, number>,
};

export const SESSION_WEIGHTS = {
  LONDON_NY_OVERLAP: 1.15,
  NY: 1.08,
  LONDON: 1.08,
  ASIA: 0.85,
  QUIET: 0.75,
};

// ─── Source registry — v3.4.2: trimmed to provably-working sources ────────
// Removed in v3.4.2 (verified non-functional from server IPs):
//   - tradingeconomics — RSS endpoint returns HTML index, not feed data
//   - dailyfx          — domain merged into IG, /feeds/all endpoint unreliable
// What remains: every entry below has a reasonable expectation of returning
// usable data from a typical European/US VPS IP.
export const KNOWN_SOURCES: Record<string, { label: string; group: "QUOTE" | "CANDLE" | "CALENDAR" | "NEWS" | "CONTEXT" }> = {
  swissquote:       { label: "swissquote",     group: "QUOTE"    },
  kraken:           { label: "kraken",         group: "QUOTE"    },
  stooq:            { label: "stooq",          group: "QUOTE"    },
  tradingview:      { label: "tv_candles",     group: "CANDLE"   },
  tv_context:       { label: "tv_context",     group: "CONTEXT"  },
  faireconomy:      { label: "faireconomy",    group: "CALENDAR" },
  // v4.6.7 — news pipeline = InvestingLive + LiveSquawk only. Source KEYS stay
  // "forexlive"/"forexlive_cb" for health-tracking continuity, but the LABELS
  // shown to the user now reflect the InvestingLive rebrand.
  forexlive:        { label: "investinglive",    group: "NEWS"     },
  forexlive_cb:     { label: "il_centralbank",   group: "NEWS"     },
  livesquawk:       { label: "livesquawk",       group: "NEWS"     },
  // v4.3 PARKED — gnews removed from active pipeline (still in code as
  // fallback). Hidden from health bar to reduce visual noise.
  // v3.5.4: fxstreet DROPPED — HTTP 403 from server IPs.
};
