// ============================================================================
// Trading Court Pro - Type Definitions  (v3.3.0)
// ============================================================================

export type Direction = "LONG" | "SHORT" | "FLAT";
export type Verdict = "BUY" | "SELL" | "WAIT";
export type Tier = "A" | "B" | "C" | "REJECTED";
export type ConfidenceTier = "STRONG" | "VALID" | "WEAK" | "REJECT";
export type RegimeLabel =
  | "TREND_UP" | "TREND_DOWN" | "RANGE" | "VOLATILE" | "DEAD" | "UNKNOWN" | "MARKET_CLOSED";

export interface InstrumentMeta {
  symbol: string;
  display: string;
  base: string;
  quote: string;
  pip: number;
  decimals: number;
  yahoo: string;
  tv: string;
  swissquote: string;
  kraken: string;
  stooq: string;
  keywords: string[];
}

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number | null;
}

export interface CandleSeries {
  symbol: string;
  timeframe: string;
  candles: Candle[];
  source: string;
  available: boolean;
  note?: string;
}

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  source: string;
  ts: number;
  available: boolean;
  change?: number | null;
  changePct?: number | null;
  dayHigh?: number | null;
  dayLow?: number | null;
  note?: string;
}

export interface IndicatorBlock {
  tf: string;
  n: number;
  lastClose: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  sma50: number | null;
  rsi14: number | null;
  atr14: number | null;
  adx14: number | null;
  bbWidth: number | null;
  structHigh: number | null;
  structLow: number | null;
}

export interface RegimeReport {
  label: RegimeLabel;
  adx: number | null;
  atrPct: number | null;
  bbWidthPct: number | null;
  reasoning: string;
}

export interface MTFReport {
  m15Dir: Direction;
  h1Dir: Direction;
  h4Dir: Direction;
  d1Dir: Direction;
  alignment: number;
  direction: Direction;
  reasoning: string;
}

export interface CorrelationReport {
  dxyChange: number | null;
  goldChange: number | null;
  oilChange: number | null;
  vixChange: number | null;
  yield10yChange: number | null;
  score: number;
  available: boolean;
  reasoning: string;
}

// ─── NewsItem — extended for v3.3 breaking-news detection ──────────────────
export interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedUtc: string | null;
  freshnessHours: number | null;
  sentiment: number;          // -1..+1
  impactCurrencies: string[];
  highImpact: boolean;
  // NEW v3.3
  breaking?: boolean;         // true = ≤15min old AND intervention/policy/CB-speak keywords
  category?: "INTERVENTION" | "POLICY" | "DATA" | "GEOPOLITICS" | "GENERAL";
  velocityScore?: number;     // 0..100 — combined freshness + impact
}

export interface NewsReport {
  items: NewsItem[];
  baseScore: number;
  quoteScore: number;
  pairScore: number;
  highImpactPending: boolean;
  reasoning: string;
  // NEW v3.3
  breakingScore?: number;     // -100..+100 directional bias from breaking news ONLY
  breakingActive?: boolean;   // any breaking item present
  breakingCurrencies?: string[]; // currencies with active breaking news
  // NEW v3.5 — Multi-Source Intervention Detection (MSID)
  interventionRegime?: {
    active: boolean;             // 2+ independent sources OR a single very-fresh item
    currencies: string[];        // affected currencies
    sourceCount: number;         // unique news source count (peak across currencies)
    sourceCountByCcy: Record<string, number>;  // detailed per-currency breakdown
    oldestHours: number;         // age of oldest qualifying item
    reasoning: string;           // human-readable explanation
  };
  breakingType?: "FRESH" | "REGIME" | "MULTI_SOURCE" | "NONE";  // why breakingActive fired
}

export interface CalendarEvent {
  title: string;
  country: string;
  dateUtc: string;
  impact: "LOW" | "MEDIUM" | "HIGH";
  forecast: string;
  previous: string;
  actual?: string;
  surprise?: number | null;
  deltaAbs?: number | null;
  surpriseDir?: "BETTER" | "WORSE" | "INLINE" | null;
  minutesFromNow: number;
  // NEW v3.3
  actualSource?: string;      // v3.4: 'faireconomy' | 'tradingeconomics'
  pendingActual?: boolean;    // released > 5min ago but no actual yet
}

export interface PriceActionReport {
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  score: number;
  signals: PriceActionSignal[];
  sessionLevels: SessionLevels;
  reasoning: string;
}

export interface PriceActionSignal {
  kind: "BOS" | "CHoCH" | "FVG" | "OB" | "LIQUIDITY_SWEEP" | "RANGE_BREAKOUT" | "FAKE_BREAKOUT" | "PDH_BREAK" | "PDL_BREAK" | "ASIA_RANGE_BREAK";
  dir: "BULLISH" | "BEARISH";
  weight: number;
  note: string;
  level?: number;
}

export interface SessionLevels {
  asiaHigh: number | null;
  asiaLow: number | null;
  pdh: number | null;
  pdl: number | null;
  weeklyOpen: number | null;
  londonOpen: number | null;
  nyOpen: number | null;
}

export interface SessionReport {
  name: "ASIA" | "LONDON" | "NY" | "LONDON_NY_OVERLAP" | "QUIET";
  active: string[];
  weight: number;
  utcHour: number;
  reasoning: string;
}

export interface EngineScores {
  mtf: number;
  regime: number;
  momentum: number;
  correlation: number;
  news: number;
  priceAction: number;
  sessionWeight: number;
  compositeRaw: number;
  composite: number;
  confidence: number;
  direction: Direction;
  confidenceTier: ConfidenceTier;
  sizeMultiplier: number;
}

export interface TradePlan {
  direction: Direction;
  tier: Tier;
  confidenceTier: ConfidenceTier;
  entry: number | null;
  stopLoss: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  rr1: number | null;
  rr2: number | null;
  spreadCost: number | null;
  stopDistancePips: number | null;
  lotSizePer1Pct: number | null;
  notes: string[];
  sizeMultiplier: number;
}

export interface RiskReport {
  passed: boolean;
  reasons: string[];
  atrUsed: number | null;
  calendarBlocked: boolean;
  calendarEvents: string[];
}

export interface PairAnalysis {
  symbol: string;
  display: string;
  quote: Quote;
  regime: RegimeReport;
  mtf: MTFReport;
  correlation: CorrelationReport;
  news: NewsReport;
  priceAction: PriceActionReport;
  session: SessionReport;
  scores: EngineScores;
  plan: TradePlan;
  risk: RiskReport;
  verdict: Verdict;
  opportunityStatus: "TRADABLE" | "NEAR" | "WATCHLIST" | "NONE";
  bullCase: string[];
  bearCase: string[];
  summary: string;
  verdictExplanation: {
    headline: string;
    why: string[];
    missing: string[];
    nextSteps: string[];
  };
  warnings: string[];
  indicators: {
    m5?: IndicatorBlock;
    m15: IndicatorBlock;
    h1: IndicatorBlock;
    h4: IndicatorBlock;
    d1: IndicatorBlock;
  };
  marketStructure?: any;
  killZone?: any;
  manipulation?: any;
  structuralPlan?: any;
  divergenceH1?: any;
  divergenceM15?: any;
  freshness?: any;
  generatedUtc: string;
}

export interface Snapshot {
  generatedUtc: string;
  pairs: PairAnalysis[];
  errors: Record<string, string>;
  calendarEvents: CalendarEvent[];
  dataSourceHealth: Record<string, { ok: boolean; lastSuccess: number; note?: string; lastSuccessAgoSec?: number }>;
}
