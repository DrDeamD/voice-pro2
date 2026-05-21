// ============================================================================
// v3.7 — Three-fix verification test
//   1) Pre-classical truth gate blocks indicators on contaminated data
//   2) VWAP refuses to compute without real volume (no v=1 fallback)
//   3) Pip value for USDCAD / USDCHF / USDJPY is correct (no $10 default)
// ============================================================================

import type { Candle, CandleSeries, Quote } from "../types/index.js";
import { v36TruthGate } from "../engines/v36/truth.js";
import { buildPreGateWaitAnalysis } from "../engines/v36/preGate.js";
import { computeVwap } from "../engines/vwap.js";
import { computeLotSize } from "../engines/tradePlan.js";
import { classifySession } from "../engines/session.js";
import { INSTRUMENTS } from "../config.js";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`✅ ${name}${detail ? ` — ${detail}` : ""}`); pass++; }
  else      { console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`); fail++; }
}

function approx(a: number, b: number, tol = 0.02): boolean {
  return Math.abs(a - b) / Math.abs(b) <= tol;
}

function candles(n: number, withVolume: boolean, interval = 300): Candle[] {
  const now = Math.floor(Date.now() / 1000);
  const out: Candle[] = [];
  let p = 1.1;
  for (let i = 0; i < n; i++) {
    const o = p, c = p + 0.0001;
    out.push({
      t: now - (n - 1 - i) * interval,
      o, h: Math.max(o, c) + 0.0001, l: Math.min(o, c) - 0.0001, c,
      v: withVolume ? 1000 + i * 5 : null,
    });
    p = c;
  }
  return out;
}

function buildSeries(tf: string, interval: number, source: string, note?: string): CandleSeries {
  return { symbol: "TEST", timeframe: tf, candles: candles(160, true, interval), source, available: true, note };
}

const cleanSeries = {
  "5m":  buildSeries("5m",  300,   "kraken"),
  "15m": buildSeries("15m", 900,   "kraken"),
  "1h":  buildSeries("1h",  3600,  "kraken"),
  "4h":  buildSeries("4h",  14400, "kraken"),
};

const synthSeries = {
  "5m":  buildSeries("5m",  300,   "kraken:synth(AUD)", "Using AUDUSD proxy (no anchor)"),
  "15m": buildSeries("15m", 900,   "kraken:synth(AUD)", "Using AUDUSD proxy (no anchor)"),
  "1h":  buildSeries("1h",  3600,  "kraken:synth(AUD)", "Using AUDUSD proxy (no anchor)"),
  "4h":  buildSeries("4h",  14400, "kraken:synth(AUD)", "Using AUDUSD proxy (no anchor)"),
};

const pt5hSeries = {
  "5m":  buildSeries("5m",  300,   "kraken"),
  "15m": buildSeries("15m", 900,   "kraken"),
  "1h":  buildSeries("1h",  3600,  "kraken"),
  "4h":  buildSeries("4h",  14400, "investing(pairId=1)", "Investing.com PT5H interval (closest to H4)"),
};

const baseQuote: Quote = {
  symbol: "EURUSD", bid: 1.115, ask: 1.1151, mid: 1.11505, spread: 1,
  source: "test", ts: Date.now(), available: true,
};

const meta = INSTRUMENTS["EURUSD"];
const session = classifySession();

// ──────────────────────────────────────────────────────────────────────────
// FIX 1: Pre-classical truth gate
// ──────────────────────────────────────────────────────────────────────────
console.log("\n=== Fix 1: Pre-Classical Truth Gate ===");

{
  // Synthetic series must trip the gate; helper must build a clean WAIT shape.
  // (Originally tested with NZDUSD; pair removed in v3.11 but the gate's
  // synthetic-detection logic is symbol-agnostic, so we test via EURUSD now.)
  const truth = v36TruthGate("EURUSD", baseQuote, synthSeries);
  ok("synthetic series trips gate", !truth.ok);

  const wait = buildPreGateWaitAnalysis({
    symbol: "EURUSD", meta, quote: baseQuote, session, series: synthSeries, truth,
  });

  ok("verdict = WAIT", wait.verdict === "WAIT");
  ok("direction = FLAT", wait.scores.direction === "FLAT");
  ok("confidence = 0", wait.scores.confidence === 0);
  ok("composite = 0", wait.scores.composite === 0);
  ok("plan tier REJECTED", wait.plan.tier === "REJECTED");
  ok("plan entry null (not computed)", wait.plan.entry === null);
  ok("plan rr1 null (not computed)", wait.plan.rr1 === null);

  // Critical: NO classical indicator was computed
  ok("indH1.rsi14 is null (no RSI on synth)", wait.indicators.h1.rsi14 === null);
  ok("indH1.atr14 is null (no ATR on synth)", wait.indicators.h1.atr14 === null);
  ok("indH1.ema20 is null (no EMA on synth)", wait.indicators.h1.ema20 === null);
  ok("indH4.bbWidth is null (no BB on synth)", wait.indicators.h4.bbWidth === null);
  ok("MTF direction FLAT", wait.mtf.direction === "FLAT");
  ok("MTF alignment 0", wait.mtf.alignment === 0);
  ok("regime UNKNOWN", wait.regime.label === "UNKNOWN");
  ok("priceAction NEUTRAL", wait.priceAction.direction === "NEUTRAL");
  ok("opportunityStatus NONE", wait.opportunityStatus === "NONE");
  ok("risk.passed false", wait.risk.passed === false);
  ok("warnings include preGate marker",
     wait.warnings.some(w => w.includes("PRE-CLASSICAL TRUTH GATE FAILED")));
  ok("v36 metadata flags preGateFailed", (wait as any).v36?.preGateFailed === true);
  ok("session preserved", wait.session.name === session.name);
  ok("indicator block n preserves candle count", wait.indicators.h1.n === 160);
}

{
  // Investing PT5H-as-H4 also trips the gate
  const truth = v36TruthGate("EURUSD", baseQuote, pt5hSeries);
  ok("PT5H-as-H4 trips gate", !truth.ok);
  ok("PT5H reason mentions 4h source",
     truth.reasons.some(r => r.includes("4h_source_not_truth_contract")));
}

{
  // Clean kraken passes the gate
  const truth = v36TruthGate("EURUSD", baseQuote, cleanSeries);
  ok("clean kraken passes gate", truth.ok);
}

// ──────────────────────────────────────────────────────────────────────────
// FIX 2: VWAP requires real volume
// ──────────────────────────────────────────────────────────────────────────
console.log("\n=== Fix 2: VWAP Volume Requirement ===");

{
  const m5WithVol = candles(60, true);
  const m5WithoutVol = candles(60, false);
  const price = 1.1051;

  const reportWithVol    = computeVwap(m5WithVol,    price);
  const reportWithoutVol = computeVwap(m5WithoutVol, price);

  ok("VWAP computed when volume present", reportWithVol.daily !== null);
  ok("VWAP daily.vwap is finite", Number.isFinite(reportWithVol.daily?.vwap ?? NaN));

  ok("VWAP refused when volume null", reportWithoutVol.daily === null);
  ok("VWAP score = 0 without volume", reportWithoutVol.score === 0);
  ok("VWAP reasoning explicit about cause",
     reportWithoutVol.reasoning.includes("volume missing"));

  // Mixed: one bar with v=null among many — must still refuse (strict)
  const m5Mixed = candles(60, true);
  m5Mixed[30].v = null;
  const reportMixed = computeVwap(m5Mixed, price);
  ok("VWAP refused when even one bar lacks volume", reportMixed.daily === null);

  // v=0 must also be rejected
  const m5Zero = candles(60, true);
  m5Zero[10].v = 0;
  const reportZero = computeVwap(m5Zero, price);
  ok("VWAP refused when any bar has v=0", reportZero.daily === null);

  // Negative volume rejected
  const m5Neg = candles(60, true);
  m5Neg[5].v = -100;
  const reportNeg = computeVwap(m5Neg, price);
  ok("VWAP refused when any bar has negative volume", reportNeg.daily === null);
}

// ──────────────────────────────────────────────────────────────────────────
// FIX 3: Pip value correctness for USDCAD / USDCHF / USDJPY
// ──────────────────────────────────────────────────────────────────────────
console.log("\n=== Fix 3: Pip Value Correctness ===");

{
  // Use deterministic balance + risk to back-derive pipValueUsd from lot output:
  //   lot = riskAmount / (pipsRisked × pipValueUsd)
  //   pipValueUsd = riskAmount / (pipsRisked × lot)
  // We give riskDistance = 1 pip so pipsRisked = 1, and balance/riskPct giving
  // riskAmount = $1 → pipValueUsd = 1 / lot.
  const balance = 100, riskPct = 1.0; // riskAmount = $1

  function pipValueFromLot(symbol: string, entry: number): number {
    const meta = INSTRUMENTS[symbol];
    const oneP = meta.pip; // riskDistance of exactly 1 pip
    const lot = computeLotSize(symbol, entry, oneP, balance, riskPct);
    if (lot == null) return NaN;
    return 1 / lot;
  }

  // USD-quote pairs: $10/pip
  ok("EURUSD pip = $10",  approx(pipValueFromLot("EURUSD", 1.10), 10));
  ok("GBPUSD pip = $10",  approx(pipValueFromLot("GBPUSD", 1.27), 10));
  ok("AUDUSD pip = $10",  approx(pipValueFromLot("AUDUSD", 0.65), 10));

  // USDJPY @ 150 → expected $6.67
  const jpyExpected = (0.01 * 100000) / 150;  // = 6.6667
  ok(`USDJPY @ 150 pip ≈ $${jpyExpected.toFixed(2)}`,
     approx(pipValueFromLot("USDJPY", 150.00), jpyExpected),
     `got $${pipValueFromLot("USDJPY", 150.00).toFixed(4)}`);

  // USDCAD @ 1.40 → expected $7.14 (was $10 in v3.5.6 = +40% wrong)
  const cadExpected = (0.0001 * 100000) / 1.40;  // = 7.1429
  ok(`USDCAD @ 1.40 pip ≈ $${cadExpected.toFixed(2)} (v3.5.6 was $10)`,
     approx(pipValueFromLot("USDCAD", 1.40), cadExpected),
     `got $${pipValueFromLot("USDCAD", 1.40).toFixed(4)}`);

  // USDCHF @ 0.90 → expected $11.11 (was $10 in v3.5.6 = -10% wrong, OVER-LEVERAGE)
  const chfExpected = (0.0001 * 100000) / 0.90;  // = 11.1111
  ok(`USDCHF @ 0.90 pip ≈ $${chfExpected.toFixed(2)} (v3.5.6 was $10 → over-leverage!)`,
     approx(pipValueFromLot("USDCHF", 0.90), chfExpected),
     `got $${pipValueFromLot("USDCHF", 0.90).toFixed(4)}`);

  // XAUUSD: pip = 0.1, contract 100oz → $10/pip
  ok("XAUUSD pip = $10", approx(pipValueFromLot("XAUUSD", 2400), 10));

  // Edge: zero entry must return null (no fabricated number)
  const zeroEntryLot = computeLotSize("USDCAD", 0, 0.0001, 100, 1.0);
  ok("USDCAD with entry=0 returns null (no fabrication)", zeroEntryLot === null);
}

// ──────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
