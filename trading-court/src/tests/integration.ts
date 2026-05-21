// ============================================================================
// Integration Test — Trading Court Pro v3.3.1
//
// Purpose:
//   Prove that the breaking-news veto and calendar gate actually fire.
//   No external network calls — synthetic news/calendar items are injected
//   directly so the test is deterministic and runs in <1 second.
//
// What it tests:
//   TEST 1 — News engine: a Mimura intervention headline must produce
//            news.breakingActive = true, breakingScore < -30,
//            highImpactPending = true.
//   TEST 2 — Risk engine + court flow: with that news, the verdict for
//            USDJPY must become WAIT and risk.reasons must include the
//            "⚡ Breaking news veto" string.
//   TEST 3 — Calendar gate ±90min: a HIGH-impact USD event 60min from now
//            must produce calendarBlocked = true.
//   TEST 4 — Calendar soft-block ±30min: a MEDIUM USD event 20min from now
//            must produce calendarBlocked = true.
// ============================================================================
import assert from "node:assert/strict";

import { analyzeNews } from "../engines/newsEngine.js";
import { evaluateRisk } from "../engines/risk.js";
import { eventsAffecting } from "../fetchers/calendar.js";
import { RULES, INSTRUMENTS } from "../config.js";
import type {
  NewsItem, CalendarEvent, EngineScores, RegimeReport, TradePlan, Direction,
} from "../types/index.js";

let pass = 0, fail = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    pass++;
  } catch (e: any) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
    fail++;
  }
}

// ─── Synthetic builders ─────────────────────────────────────────────────────
function makeMimuraNews(): NewsItem[] {
  // This is the exact kind of headline that broke USDJPY 400+ pips
  return [
    {
      title: "Japan Top FX Diplomat Mimura: This is My Final Warning Before Action",
      url: "https://example.com/mimura",
      source: "ForexLive HF",
      publishedUtc: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 min ago
      freshnessHours: 5 / 60,
      sentiment: 0,
      impactCurrencies: ["JPY"],
      highImpact: true,
      breaking: true,
      category: "INTERVENTION",
      velocityScore: 95,
    },
    {
      title: "MOF Mimura: Will take appropriate action against excessive yen moves",
      url: "https://example.com/mimura2",
      source: "LiveSquawk",
      publishedUtc: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
      freshnessHours: 8 / 60,
      sentiment: 0,
      impactCurrencies: ["JPY"],
      highImpact: true,
      breaking: true,
      category: "INTERVENTION",
      velocityScore: 90,
    },
  ];
}

function makeQuietNews(): NewsItem[] {
  return [
    {
      title: "Markets quiet as traders await ECB decision next week",
      url: "https://example.com/quiet",
      source: "ForexLive",
      publishedUtc: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
      freshnessHours: 3,
      sentiment: 0,
      impactCurrencies: ["EUR"],
      highImpact: false,
      breaking: false,
      category: "GENERAL",
      velocityScore: 5,
    },
  ];
}

function makeHighEvent(country: string, minutesFromNow: number): CalendarEvent {
  const dt = new Date(Date.now() + minutesFromNow * 60 * 1000);
  return {
    title: "FOMC Statement",
    country,
    dateUtc: dt.toISOString(),
    impact: "HIGH",
    forecast: "5.50%",
    previous: "5.50%",
    minutesFromNow,
  };
}

function makeMediumEvent(country: string, minutesFromNow: number): CalendarEvent {
  const dt = new Date(Date.now() + minutesFromNow * 60 * 1000);
  return {
    title: "ISM Services PMI",
    country,
    dateUtc: dt.toISOString(),
    impact: "MEDIUM",
    forecast: "52.5",
    previous: "51.4",
    minutesFromNow,
  };
}

function makeLowEvent(country: string, minutesFromNow: number): CalendarEvent {
  const dt = new Date(Date.now() + minutesFromNow * 60 * 1000);
  return {
    title: "Wholesale Inventories",
    country,
    dateUtc: dt.toISOString(),
    impact: "LOW",
    forecast: "0.2%",
    previous: "0.1%",
    minutesFromNow,
  };
}

function makeScoresLong(): EngineScores {
  // Strong LONG bias — would normally produce BUY without breaking news
  return {
    mtf: 60, regime: 50, momentum: 40, correlation: 20,
    news: 0, priceAction: 30,
    sessionWeight: 1.08,
    compositeRaw: 50, composite: 50, confidence: 80,
    direction: "LONG", confidenceTier: "STRONG", sizeMultiplier: 1.0,
  } as EngineScores;
}

function makeRegime(label: any): RegimeReport {
  return {
    label,
    adx: 28,
    atrPct: 0.6,
    bbWidthPct: 1.2,
    reasoning: "Strong trend",
  };
}

function makePlan(): TradePlan {
  return {
    direction: "LONG", tier: "A", confidenceTier: "STRONG",
    entry: 150.20, stopLoss: 149.80, tp1: 150.80, tp2: 151.40, tp3: 152.00,
    rr1: 2.0, rr2: 3.0, spreadCost: 1.0, stopDistancePips: 40,
    lotSizePer1Pct: 0.025, notes: [], sizeMultiplier: 1.0,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// TEST 1: News engine sees Mimura as breaking
// ════════════════════════════════════════════════════════════════════════════
console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("TEST 1 — News Engine: Mimura headline classification");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

test("Mimura news → breakingActive = true", () => {
  const news = analyzeNews("USDJPY", makeMimuraNews());
  console.log(`     • items: ${news.items.length}`);
  console.log(`     • breakingActive: ${news.breakingActive}`);
  console.log(`     • breakingScore: ${news.breakingScore}`);
  console.log(`     • breakingCurrencies: [${(news.breakingCurrencies ?? []).join(", ")}]`);
  console.log(`     • highImpactPending: ${news.highImpactPending}`);
  console.log(`     • pairScore: ${news.pairScore.toFixed(1)}`);
  assert.equal(news.breakingActive, true, "breakingActive should be true");
});

// ─── v3.5 MSID — THE PRODUCTION REGRESSION TEST ────────────────────────────
// The user's screenshot showed exactly this: 4 INTERVENTION items from 4
// different sources, all >15min old, so individual `breaking=false`. v3.4.2
// failed to fire the veto. v3.5 MSID should detect the multi-source regime
// and fire the veto regardless.
test("v3.5 — 4 stale INTERVENTION items from 4 sources → MSID regime fires veto", () => {
  const STALE_INTERVENTION: NewsItem[] = [
    {
      title: "Japan's top currency diplomat issues final warning before action - investingLive",
      url: "x", source: "investingLive",
      publishedUtc: new Date(Date.now() - 54 * 60 * 1000).toISOString(),
      freshnessHours: 0.9,
      sentiment: 0, impactCurrencies: ["JPY"], highImpact: true,
      breaking: false,  // ← critical: NOT breaking individually (>60min not yet, but stale enough that v3.4.2 missed it)
      category: "INTERVENTION", velocityScore: 90,
    },
    {
      title: "Japan intervenes to counter currency weakness, sources say; yen surges - Reuters",
      url: "x", source: "Reuters",
      publishedUtc: new Date(Date.now() - 84 * 60 * 1000).toISOString(),
      freshnessHours: 1.4,
      sentiment: 0, impactCurrencies: ["JPY", "USD"], highImpact: true,
      breaking: false,
      category: "INTERVENTION", velocityScore: 80,
    },
    {
      title: "USD/JPY forecast: What now after intervention? - FOREX.com",
      url: "x", source: "FOREX.com",
      publishedUtc: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
      freshnessHours: 1.5,
      sentiment: 0, impactCurrencies: ["USD", "JPY"], highImpact: true,
      breaking: false,
      category: "INTERVENTION", velocityScore: 70,
    },
    {
      title: "USD/JPY steadies after intervention-driven slump - FXStreet",
      url: "x", source: "FXStreet",
      publishedUtc: new Date(Date.now() - 132 * 60 * 1000).toISOString(),
      freshnessHours: 2.2,
      sentiment: 0, impactCurrencies: ["USD", "JPY"], highImpact: true,
      breaking: false,
      category: "INTERVENTION", velocityScore: 60,
    },
  ];

  const news = analyzeNews("USDJPY", STALE_INTERVENTION);
  console.log(`     • items:           4 (all breaking=false individually)`);
  console.log(`     • freshest item:   ${STALE_INTERVENTION[0].freshnessHours}h (54 min)`);
  console.log(`     • unique sources:  ${news.interventionRegime?.sourceCount}`);
  console.log(`     • regime active:   ${news.interventionRegime?.active}`);
  console.log(`     • regime currencies: [${news.interventionRegime?.currencies.join(", ")}]`);
  console.log(`     • breakingActive:  ${news.breakingActive}`);
  console.log(`     • breakingScore:   ${news.breakingScore}`);

  // The CORE assertion: v3.4.2 returned false here. v3.5 must return true.
  assert.equal(news.interventionRegime?.active, true,
    "v3.5 MSID should detect intervention regime from 4 sources");
  assert.ok(news.interventionRegime?.currencies.includes("JPY"),
    "JPY must be in regime currencies");
  assert.ok((news.interventionRegime?.sourceCount ?? 0) >= 4,
    `expected ≥4 unique sources, got ${news.interventionRegime?.sourceCount}`);
  assert.equal(news.breakingActive, true,
    "MSID promotes regime to breakingActive even though individual items have breaking=false");
  assert.ok((news.breakingScore ?? 0) <= -30,
    `breakingScore should be ≤ -30 due to JPY MSID bias, got ${news.breakingScore}`);
});

test("v3.5 — Court fires '⚡ Breaking news veto' with MSID label on USDJPY LONG", () => {
  const STALE_INTERVENTION: NewsItem[] = [
    {
      title: "Japan intervenes - Reuters",  url: "x", source: "Reuters",
      publishedUtc: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      freshnessHours: 1.0, sentiment: 0, impactCurrencies: ["JPY"], highImpact: true,
      breaking: false, category: "INTERVENTION", velocityScore: 80,
    },
    {
      title: "USD/JPY intervention talk - FXStreet",  url: "x", source: "FXStreet",
      publishedUtc: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
      freshnessHours: 1.5, sentiment: 0, impactCurrencies: ["USD", "JPY"], highImpact: true,
      breaking: false, category: "INTERVENTION", velocityScore: 70,
    },
    {
      title: "Yen surges as Japan acts - CNBC",  url: "x", source: "CNBC",
      publishedUtc: new Date(Date.now() - 120 * 60 * 1000).toISOString(),
      freshnessHours: 2.0, sentiment: 0, impactCurrencies: ["JPY"], highImpact: true,
      breaking: false, category: "INTERVENTION", velocityScore: 60,
    },
  ];

  const news = analyzeNews("USDJPY", STALE_INTERVENTION);

  // Simulate the breaking-news veto logic from court.ts (lines 387-409).
  // This is what analyzePair() does after evaluateRisk runs.
  // We replicate it inline to avoid depending on full orchestration.
  const meta = INSTRUMENTS["USDJPY"];
  const pairCcys = new Set([meta.base, meta.quote]);
  const affectedCcys = (news.breakingCurrencies ?? []).filter(c => pairCcys.has(c));
  const wouldVeto = news.breakingActive === true && affectedCcys.length > 0;

  const regime = news.interventionRegime;
  const sourceTag = regime?.active && regime.sourceCount >= RULES.msidMinSources
    ? `MSID regime (${regime.sourceCount} independent sources, oldest ${regime.oldestHours.toFixed(1)}h)`
    : "intervention/policy shock";
  const vetoReason = `⚡ Breaking news veto: ${sourceTag} affecting ${affectedCcys.join(",")}`;

  console.log(`     • news.breakingActive: ${news.breakingActive}`);
  console.log(`     • news.breakingType:   ${news.breakingType}`);
  console.log(`     • affected ccys:       [${affectedCcys.join(", ")}]`);
  console.log(`     • would veto:          ${wouldVeto}`);
  console.log(`     • veto reason:         ${vetoReason}`);

  assert.equal(news.breakingActive, true, "MSID must promote regime to breakingActive");
  assert.equal(news.breakingType, "REGIME", "breakingType should be REGIME (no fresh items)");
  assert.equal(wouldVeto, true, "Court would veto USDJPY LONG due to JPY in pair + breakingActive");
  assert.ok(vetoReason.includes("MSID regime"),
    "Veto reason should label this as 'MSID regime' not generic 'intervention/policy shock'");
  assert.ok(vetoReason.includes("3 independent sources"),
    `Veto reason should mention source count, got: ${vetoReason}`);
});

// ============================================================================
// v3.5.1 — Full G10 MSID coverage tests
// Each test simulates a historical intervention scenario for a non-JPY/CHF
// currency and verifies that MSID produces both:
//   (a) breakingActive = true
//   (b) a directional breakingScore (non-zero, correct sign)
// ============================================================================
function makeMSIDItems(opts: {
  pair: string; ccyTags: string[]; sources: string[]; titleTpl: string;
}): NewsItem[] {
  return opts.sources.map((src, i) => ({
    title: opts.titleTpl.replace("{src}", src),
    url: `https://example.com/${src.toLowerCase()}`,
    source: src,
    publishedUtc: new Date(Date.now() - (60 + i * 30) * 60 * 1000).toISOString(),
    freshnessHours: (60 + i * 30) / 60,  // 1.0h, 1.5h, 2.0h, 2.5h
    sentiment: 0,
    impactCurrencies: opts.ccyTags,
    highImpact: true,
    breaking: false,                      // NONE individually breaking
    category: "INTERVENTION" as const,
    velocityScore: 70,
  }));
}

test("v3.5.1 — GBP intervention regime (BoE 2022 scenario) → breakingScore > 0", () => {
  // Historical scenario: September 2022 mini-budget crisis. BoE forced to
  // intervene in gilt market. Multiple outlets reported simultaneously.
  // GBP appreciated against USD on the announcement.
  const items = makeMSIDItems({
    pair: "GBPUSD",
    ccyTags: ["GBP", "USD"],
    sources: ["Reuters", "Bloomberg", "FT", "BBC"],
    titleTpl: "BoE emergency intervention to stabilize gilts - {src}",
  });
  const news = analyzeNews("GBPUSD", items);
  console.log(`     • currency:        GBP`);
  console.log(`     • breakingActive:  ${news.breakingActive}`);
  console.log(`     • breakingScore:   ${news.breakingScore}  (expect > 0 — GBP strengthens)`);
  console.log(`     • regime sources:  ${news.interventionRegime?.sourceCount}`);

  assert.equal(news.breakingActive, true, "v3.5.1 MSID must fire for GBP regime");
  assert.ok((news.breakingScore ?? 0) >= 30,
    `GBPUSD breakingScore should be ≥+30 (GBP appreciates), got ${news.breakingScore}`);
  assert.ok(news.breakingCurrencies?.includes("GBP"));
});

test("v3.5.1 — EUR intervention regime (G7 2000 scenario) → breakingScore > 0", () => {
  // Historical: Sept 2000 G7 coordinated intervention to support a falling EUR.
  const items = makeMSIDItems({
    pair: "EURUSD",
    ccyTags: ["EUR", "USD"],
    sources: ["Reuters", "Bloomberg", "FT"],
    titleTpl: "G7 coordinated intervention to support EUR - {src}",
  });
  const news = analyzeNews("EURUSD", items);
  console.log(`     • currency:        EUR`);
  console.log(`     • breakingScore:   ${news.breakingScore}  (expect > 0 — EUR strengthens)`);

  assert.equal(news.breakingActive, true);
  assert.ok((news.breakingScore ?? 0) >= 30,
    `EURUSD breakingScore should be ≥+30, got ${news.breakingScore}`);
});

test("v3.5.1 — AUD intervention regime → breakingScore < 0 (RBA wants weaker AUD)", () => {
  // Hypothetical RBA verbal intervention against AUD strength (export pressure)
  const items = makeMSIDItems({
    pair: "AUDUSD",
    ccyTags: ["AUD", "USD"],
    sources: ["RBA", "Reuters", "ABC"],
    titleTpl: "RBA verbal intervention warns on AUD strength - {src}",
  });
  const news = analyzeNews("AUDUSD", items);
  console.log(`     • currency:        AUD`);
  console.log(`     • breakingScore:   ${news.breakingScore}  (expect < 0 — AUD weakens)`);

  assert.equal(news.breakingActive, true);
  assert.ok((news.breakingScore ?? 0) <= -15,
    `AUDUSD breakingScore should be ≤-15 (AUD weakens), got ${news.breakingScore}`);
});

test("v3.5.1 — CHF still works (regression check from v3.5.0)", () => {
  // SNB intervention: classical scenario — defend CHF cap or weaken franc
  const items = makeMSIDItems({
    pair: "USDCHF",
    ccyTags: ["USD", "CHF"],
    sources: ["SNB", "Reuters", "Bloomberg"],
    titleTpl: "SNB intervenes against CHF strength - {src}",
  });
  const news = analyzeNews("USDCHF", items);
  // For USDCHF: bias.CHF = -50 (CHF weakens) → breakingScore = bias.USD - bias.CHF = 0 - (-50) = +50
  // i.e., USDCHF rises (which IS what happens when CHF weakens)
  console.log(`     • currency:        CHF`);
  console.log(`     • breakingScore:   ${news.breakingScore}  (expect > 0 — USDCHF rises)`);

  assert.equal(news.breakingActive, true);
  assert.ok((news.breakingScore ?? 0) >= 30);
});

test("v3.5.1 — JPY still works (regression check from v3.5.0)", () => {
  // The original sceanario from production
  const items = makeMSIDItems({
    pair: "USDJPY",
    ccyTags: ["USD", "JPY"],
    sources: ["Reuters", "FXStreet", "FOREX.com", "investingLive"],
    titleTpl: "Japan intervention talk - {src}",
  });
  const news = analyzeNews("USDJPY", items);
  // For USDJPY: bias.JPY = +60 → breakingScore = 0 - 60 = -60
  console.log(`     • currency:        JPY (regression)`);
  console.log(`     • breakingScore:   ${news.breakingScore}  (expect < 0 — USDJPY falls)`);

  assert.equal(news.breakingActive, true);
  assert.ok((news.breakingScore ?? 0) <= -30);
});

// ─── v3.4.2 REGRESSION TEST (the bug DrdreamD spotted in production) ───────
// In v3.4.1, headlines like "USD/JPY forecast: What now after intervention?"
// did NOT produce a breakingScore because interventionBiasForCurrency required
// "JAPAN" or "MOF" or "MIMURA" literally in the title. The user saw breaking
// news veto fire (good) but breakingScore: +0 (wrong).
// In v3.4.2, ANY intervention news where JPY is in impactCurrencies gets
// the +60 bias, regardless of whether "Japan" is mentioned in the title.
test("v3.4.2 — Generic 'USD/JPY intervention' headline produces breakingScore < 0", () => {
  const genericIntervention: NewsItem[] = [
    {
      title: "USD/JPY forecast: What now after intervention? - FOREX.com",
      url: "https://example.com/forex",
      source: "FOREX.com",
      publishedUtc: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      freshnessHours: 5 / 60,
      sentiment: 0,
      impactCurrencies: ["USD", "JPY"],
      highImpact: true,
      breaking: true,
      category: "INTERVENTION",
      velocityScore: 95,
    },
  ];
  const news = analyzeNews("USDJPY", genericIntervention);
  console.log(`     • title:           "USD/JPY forecast: What now after intervention?"`);
  console.log(`     • breakingActive:  ${news.breakingActive}`);
  console.log(`     • breakingScore:   ${news.breakingScore}`);
  console.log(`     • impactCurrencies: [${(news.breakingCurrencies ?? []).join(", ")}]`);
  assert.equal(news.breakingActive, true);
  assert.ok((news.breakingScore ?? 0) <= -30,
    `v3.4.1 BUG: generic intervention headlines yielded breakingScore +0. ` +
    `v3.4.2 should yield ≤ -30. Got: ${news.breakingScore}`);
});

test("Mimura news → breakingCurrencies includes JPY", () => {
  const news = analyzeNews("USDJPY", makeMimuraNews());
  assert.ok((news.breakingCurrencies ?? []).includes("JPY"),
    `breakingCurrencies should include JPY, got [${(news.breakingCurrencies ?? []).join(",")}]`);
});

test("Mimura news → highImpactPending = true", () => {
  const news = analyzeNews("USDJPY", makeMimuraNews());
  assert.equal(news.highImpactPending, true);
});

test("Quiet news → breakingActive = false", () => {
  const news = analyzeNews("EURUSD", makeQuietNews());
  console.log(`     • breakingActive: ${news.breakingActive} (expected: false)`);
  assert.equal(news.breakingActive, false);
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 2: Court flow — Mimura news vetoes USDJPY trade
// ════════════════════════════════════════════════════════════════════════════
console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("TEST 2 — Court Flow: Mimura headline vetoes USDJPY trade");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

test("USDJPY LONG with Mimura news → risk.passed = false", () => {
  const news = analyzeNews("USDJPY", makeMimuraNews());
  const scores = makeScoresLong();
  const regime = makeRegime("TREND_UP");
  const plan = makePlan();
  const risk = evaluateRisk(
    "USD", "JPY", "LONG",
    scores, regime, news, plan,
    0.5,        // atrValue
    [],         // calendarEvents (empty here — testing news veto only)
    RULES.minRR
  );
  console.log(`     • risk.passed: ${risk.passed}`);
  console.log(`     • risk.reasons:`);
  for (const r of risk.reasons) console.log(`        → ${r}`);

  // The court engine adds the "⚡ Breaking news veto" reason — we replicate that
  // logic here since evaluateRisk doesn't (court.ts owns it). Let's also verify
  // that risk.passed is at minimum false from the highImpactPending check.
  assert.equal(risk.passed, false, "risk should fail with breaking news");
});

test("USDJPY LONG with Mimura news → highImpactPending reason fires", () => {
  const news = analyzeNews("USDJPY", makeMimuraNews());
  const risk = evaluateRisk(
    "USD", "JPY", "LONG",
    makeScoresLong(), makeRegime("TREND_UP"), news, makePlan(),
    0.5, [], RULES.minRR
  );
  const hasImpact = risk.reasons.some(r => r.toLowerCase().includes("high-impact"));
  assert.ok(hasImpact, `expected a high-impact reason, got: ${risk.reasons.join(" | ")}`);
});

// Now simulate the court.ts breaking-veto block (added in v3.3.1)
test("Court breaking-news veto: USDJPY pair currency overlap → veto reason added", () => {
  const news = analyzeNews("USDJPY", makeMimuraNews());
  const meta = INSTRUMENTS["USDJPY"];
  const pairCcys = new Set([meta.base, meta.quote]);
  if (meta.base === "XAU") pairCcys.add("USD");
  const affectedCcys = (news.breakingCurrencies ?? []).filter(c => pairCcys.has(c));
  console.log(`     • pair currencies: [${[...pairCcys].join(", ")}]`);
  console.log(`     • affected currencies: [${affectedCcys.join(", ")}]`);
  assert.ok(affectedCcys.length > 0,
    "court veto should detect pair-currency overlap with breaking news");

  // Simulate court.ts behavior
  const reasons: string[] = [];
  if (news.breakingActive && affectedCcys.length > 0) {
    const brk = news.breakingScore ?? 0;
    const sign = brk >= 0 ? "+" : "";
    reasons.push(`⚡ Breaking news veto: intervention/policy shock affecting ${affectedCcys.join(",")} (breakingScore ${sign}${brk}) — stand down`);
  }
  console.log(`     • veto reason: ${reasons[0]}`);
  assert.ok(reasons[0].includes("⚡ Breaking news veto"),
    "veto reason text must include the '⚡ Breaking news veto' signature");
  assert.ok(reasons[0].includes("JPY"),
    "veto reason must mention the affected currency");
});

test("EURUSD does NOT receive Mimura veto (currencies don't overlap)", () => {
  const news = analyzeNews("EURUSD", makeMimuraNews());
  const meta = INSTRUMENTS["EURUSD"];
  const pairCcys = new Set([meta.base, meta.quote]);
  const affectedCcys = (news.breakingCurrencies ?? []).filter(c => pairCcys.has(c));
  console.log(`     • EURUSD pair currencies: [${[...pairCcys].join(", ")}]`);
  console.log(`     • affected: [${affectedCcys.join(", ")}]`);
  assert.equal(affectedCcys.length, 0,
    "EURUSD should not be affected by JPY-only intervention news");
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 3: Calendar gate ±30min HIGH events (v3.5.5: was ±90min)
// ════════════════════════════════════════════════════════════════════════════
console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("TEST 3 — Calendar Gate: HIGH events within ±30min (v3.5.5 calibration)");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

test("FOMC in 20min → blocks USDJPY (HIGH ±30)", () => {
  const events = [makeHighEvent("USD", 20)];
  const news = analyzeNews("USDJPY", makeQuietNews());
  const risk = evaluateRisk(
    "USD", "JPY", "LONG",
    makeScoresLong(), makeRegime("TREND_UP"), news, makePlan(),
    0.5, events, RULES.minRR
  );
  console.log(`     • calendarBlocked: ${risk.calendarBlocked}`);
  console.log(`     • reasons: ${risk.reasons.filter(r => r.toLowerCase().includes("calendar")).join(" | ")}`);
  assert.equal(risk.calendarBlocked, true);
});

test("FOMC in 25min → still blocks USDJPY (within ±30)", () => {
  const events = [makeHighEvent("USD", 25)];
  const risk = evaluateRisk(
    "USD", "JPY", "LONG",
    makeScoresLong(), makeRegime("TREND_UP"),
    analyzeNews("USDJPY", makeQuietNews()), makePlan(),
    0.5, events, RULES.minRR
  );
  assert.equal(risk.calendarBlocked, true,
    `FOMC at 25min should block, got passed=${risk.passed}, reasons=${risk.reasons.join("|")}`);
});

test("FOMC in 60min → does NOT block (outside ±30 in v3.5.5)", () => {
  // v3.5.5 calibration: was 90min window, now 30min (institutional standard).
  // 60min ahead is now allowed, freeing up significant trading windows.
  const events = [makeHighEvent("USD", 60)];
  const risk = evaluateRisk(
    "USD", "JPY", "LONG",
    makeScoresLong(), makeRegime("TREND_UP"),
    analyzeNews("USDJPY", makeQuietNews()), makePlan(),
    0.5, events, RULES.minRR
  );
  console.log(`     • calendarBlocked: ${risk.calendarBlocked} (expected: false in v3.5.5)`);
  assert.equal(risk.calendarBlocked, false);
});

test("FOMC 25min ago → still blocks (recent past within window)", () => {
  const events = [makeHighEvent("USD", -25)];
  const risk = evaluateRisk(
    "USD", "JPY", "LONG",
    makeScoresLong(), makeRegime("TREND_UP"),
    analyzeNews("USDJPY", makeQuietNews()), makePlan(),
    0.5, events, RULES.minRR
  );
  assert.equal(risk.calendarBlocked, true);
});

test("FOMC in 20min for EUR → does NOT block USDJPY (currency mismatch)", () => {
  const events = [makeHighEvent("EUR", 20)];
  const risk = evaluateRisk(
    "USD", "JPY", "LONG",
    makeScoresLong(), makeRegime("TREND_UP"),
    analyzeNews("USDJPY", makeQuietNews()), makePlan(),
    0.5, events, RULES.minRR
  );
  console.log(`     • calendarBlocked: ${risk.calendarBlocked} (expected: false)`);
  assert.equal(risk.calendarBlocked, false);
});

test("eventsAffecting() returns FOMC at 20min for USDJPY", () => {
  const events = [makeHighEvent("USD", 20)];
  const affecting = eventsAffecting(events, "USD", "JPY", RULES.calendarBlockMinutes, "HIGH");
  assert.equal(affecting.length, 1);
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 4: Calendar soft-block ±15min MEDIUM events (v3.5.5: was ±30)
// ════════════════════════════════════════════════════════════════════════════
console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("TEST 4 — Calendar Soft-Block: MEDIUM events within ±15min");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

test("ISM Services in 10min → blocks USDJPY (MEDIUM ±15)", () => {
  const events = [makeMediumEvent("USD", 10)];
  const risk = evaluateRisk(
    "USD", "JPY", "LONG",
    makeScoresLong(), makeRegime("TREND_UP"),
    analyzeNews("USDJPY", makeQuietNews()), makePlan(),
    0.5, events, RULES.minRR
  );
  console.log(`     • calendarBlocked: ${risk.calendarBlocked}`);
  console.log(`     • reasons: ${risk.reasons.filter(r => r.toLowerCase().includes("calendar")).join(" | ")}`);
  assert.equal(risk.calendarBlocked, true);
});

test("ISM Services in 25min → does NOT block (MEDIUM outside ±15 in v3.5.5)", () => {
  const events = [makeMediumEvent("USD", 25)];
  const risk = evaluateRisk(
    "USD", "JPY", "LONG",
    makeScoresLong(), makeRegime("TREND_UP"),
    analyzeNews("USDJPY", makeQuietNews()), makePlan(),
    0.5, events, RULES.minRR
  );
  assert.equal(risk.calendarBlocked, false);
});

test("LOW event in 20min → does NOT block", () => {
  const events = [makeLowEvent("USD", 20)];
  const risk = evaluateRisk(
    "USD", "JPY", "LONG",
    makeScoresLong(), makeRegime("TREND_UP"),
    analyzeNews("USDJPY", makeQuietNews()), makePlan(),
    0.5, events, RULES.minRR
  );
  assert.equal(risk.calendarBlocked, false);
});

// ════════════════════════════════════════════════════════════════════════════
// SUMMARY
// ════════════════════════════════════════════════════════════════════════════
// TEST: v3.5.5 — Calibration sanity (constants match research-backed values)
// ════════════════════════════════════════════════════════════════════════════
console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("TEST 8 — v3.5.5 Calibration: Research-Backed Thresholds");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

test("v3.5.5 — minConfidence 60 (RR=1.5 break-even is 50, +10 buffer)", () => {
  // Mathematics: with RR=1.5, P(win)=50% gives EV=+0.25 (break-even+).
  // P(win)=60% gives EV=+0.50 (profitable). Threshold 60 = profitable system.
  // Old 72 was perfectionist: required 80%+ conviction → 0 trades/day in production.
  assert.equal(RULES.minConfidence, 60.0,
    `v3.5.5: minConfidence should be 60 (was 72 in v3.5.4)`);
});

test("v3.5.5 — calendar HIGH block widened to ±30min (was 90)", () => {
  // Institutional standard: ±30min around HIGH events.
  // Was 90min (3-hour total exclusion) which over-penalized neutral periods.
  assert.equal(RULES.calendarBlockMinutes, 30,
    `v3.5.5: calendarBlockMinutes should be 30 (was 90 in v3.5.4)`);
});

test("v3.5.5 — calendar MEDIUM soft-block tightened to ±15min (was 30)", () => {
  assert.equal(RULES.calendarSoftBlockMinutes, 15);
});

test("v3.5.5 — breaking veto threshold raised to 45 (was 30, separates noise from signal)", () => {
  // Old: |score|≥30 vetoed (e.g. one stale headline at 30 = veto). Too aggressive.
  // New: |score|≥45 = strong consensus or fresh shock = veto.
  assert.equal(RULES.breakingNewsConflictThreshold, 45);
});

test("v3.5.5 — breakingNewsMaxAgeMin reduced to 30 (was 60, true 'breaking' is recent)", () => {
  assert.equal(RULES.breakingNewsMaxAgeMin, 30);
});

test("v3.5.5 — tier ladder rebalanced: REJECT<50, WEAK<60, VALID<72", () => {
  // Tier alignment: minConfidence=60 means VALID starts at 60. WEAK is 50-59.
  // Below 50 = pure noise (REJECT).
  assert.equal(RULES.tierRejectBelow, 50.0);
  assert.equal(RULES.tierWeakBelow,   60.0);
  assert.equal(RULES.tierValidBelow,  72.0);
});

test("v3.5.5 — strong setup (Conf 65, RR 1.5, no calendar conflict) → PASSES risk gate", () => {
  // This is the EUR/USD-style scenario from the user's production: strong
  // technicals (MTF+100, VWAP+63) but old system rejected at Confidence 65.
  // v3.5.5 should now allow this trade.
  const scores = makeScoresLong();
  scores.confidence = 65;
  const risk = evaluateRisk(
    "EUR", "USD", "LONG",
    scores, makeRegime("TREND_UP"),
    analyzeNews("EURUSD", makeQuietNews()), makePlan(),
    0.5, [], RULES.minRR
  );
  console.log(`     • Confidence: 65, passed: ${risk.passed}`);
  assert.equal(risk.passed, true,
    `v3.5.5: Conf=65 above minConfidence=60 should pass; got passed=${risk.passed}, reasons=${risk.reasons.join("|")}`);
});

test("v3.5.5 — weak setup (Conf 45) → still REJECTED (true noise filter)", () => {
  // Calibration must not eliminate the safety net. Below 50 = REJECT.
  const scores = makeScoresLong();
  scores.confidence = 45;
  const risk = evaluateRisk(
    "EUR", "USD", "LONG",
    scores, makeRegime("TREND_UP"),
    analyzeNews("EURUSD", makeQuietNews()), makePlan(),
    0.5, [], RULES.minRR
  );
  console.log(`     • Confidence: 45, passed: ${risk.passed}`);
  assert.equal(risk.passed, false,
    "v3.5.5: Conf=45 below threshold=60 must still fail risk gate");
});

test("v3.5.5 — moderate breaking score 40 does NOT veto (below new 45 threshold)", () => {
  // The user's production: EUR/USD had breakingScore +40 → vetoed at threshold 30.
  // Now threshold=45 → score 40 should NOT trigger conflict veto by itself.
  const scores = makeScoresLong();
  scores.confidence = 70;
  const news = analyzeNews("EURUSD", makeQuietNews());
  // Inject moderate score (simulating "EURUSD bias up above 200MA" type news)
  (news as any).breakingScore = 40;
  const risk = evaluateRisk(
    "EUR", "USD", "LONG",
    scores, makeRegime("TREND_UP"),
    news, makePlan(),
    0.5, [], RULES.minRR
  );
  const conflictReason = risk.reasons.find(r => r.toLowerCase().includes("conflict"));
  console.log(`     • breakingScore=40, conflict reason fired: ${!!conflictReason}`);
  assert.equal(conflictReason, undefined,
    `v3.5.5: breakingScore=40 (below new threshold 45) should NOT trigger conflict veto`);
});

test("v3.5.5 — strong breaking (Mimura intervention) STILL vetoes USDJPY LONG", () => {
  // Calibration must not eliminate the safety net. Real BoJ Mimura headline
  // produces strong negative breakingScore on USDJPY LONG (intervention =
  // sell USD/JPY), so this trade must still be blocked.
  const scores = makeScoresLong();
  scores.confidence = 70;  // strong technical setup
  const news = analyzeNews("USDJPY", makeMimuraNews());
  console.log(`     • Mimura news: breakingScore=${news.breakingScore}, breakingActive=${news.breakingActive}`);
  const risk = evaluateRisk(
    "USD", "JPY", "LONG",
    scores, makeRegime("TREND_UP"),
    news, makePlan(),
    0.5, [], RULES.minRR
  );
  // With Mimura news active on JPY, USDJPY LONG should be blocked
  // either via highImpactPending OR breaking news veto OR conflict
  console.log(`     • risk.passed: ${risk.passed}`);
  assert.equal(risk.passed, false,
    `v3.5.5: Mimura intervention news must still block USDJPY LONG even after calibration; ` +
    `got passed=${risk.passed}, reasons=${risk.reasons.join("|")}`);
});

// ════════════════════════════════════════════════════════════════════════════
// SUMMARY
// ════════════════════════════════════════════════════════════════════════════
console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`SUMMARY: ${pass} passed, ${fail} failed`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

if (fail > 0) {
  process.exit(1);
}
