// ============================================================================
// v4.0 priority 3b-prep — comprehensive audit logging integration test.
//
// Verifies that buildRecord() correctly extracts all v3b fields from a
// production-shaped PairAnalysis, including:
//   - 10 raw component scores
//   - session weight and pre-multiplier composite
//   - v36 court state (trustScore, sideScore, caps, delta)
//   - 4 witness outputs with metrics
//
// Fixtures are derived from real production verdicts:
//   - USDJPY 2026-05-05T15:00 (RANGE, all components present)
//   - XAUUSD pre-3b legacy (no v36 attached, must default gracefully)
//   - EURUSD truth-gate-failed scenario (v36.truth.ok=false)
//
// No manufactured smoke data. All values traceable to live PairAnalysis output.
// ============================================================================

import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { buildRecord } from "../measurement/recorder.js";
import {
  appendVerdict,
  readAllVerdicts,
  setLogPath,
  resetLogPath,
  type VerdictRecord,
  type VerdictV3bAudit,
} from "../measurement/verdictLog.js";

// ─── Fixture builders — production-shaped PairAnalysis stubs ────────────────

/** Full pair with v36 attached. Mirrors USDJPY at 2026-05-05T15:00. */
function makeFullPair(): any {
  return {
    symbol: "USDJPY",
    verdict: "WAIT",
    quote: { bid: 153.245, ask: 153.265, mid: 153.255 },
    scores: {
      // 10 raw components — these are how composeScores stores them on
      // EngineScores after the `as any` cast in court.ts:138.
      marketStructure: -20,
      mtf:             20,         // mtfAlignment in v3b
      momentum:        -6.2,
      vwap:            0,
      priceAction:     0,
      manipulation:    -3,
      divergence:      5,
      regime:          -10,        // numeric regimeScore
      correlation:     0,
      news:            -46.6,      // newsScore in v3b
      sessionWeight:   1.08,       // NY weight
      compositeRaw:    -22,        // before applySession
      composite:       -23.76,     // after applySession (-22 * 1.08)
      confidence:      0,
      direction:       "FLAT",
      confidenceTier:  "REJECT",
    },
    session: { name: "NY" },
    regime: { regime: "TREND_DOWN", label: "TREND_DOWN", adx: 53.0 },
    plan: { notes: [] },
    risk: { reasons: [] },
    verdictExplanation: { missing: [], headline: "", why: [], nextSteps: [] },
    news: { breakingActive: false, breakingScore: 0, interventionRegime: { active: false } },
    // v36 attached — full state from applyV36StatisticalCourt.
    v36: {
      truth: { ok: true, reasons: [], warnings: [] },
      court: {
        allowed:         false,
        side:            "FLAT",
        sideScore:       30,
        trustScore:      55,        // typical production value (per priority 3 audit)
        confidenceCap:   72,        // GARCH unstable cap
        confidenceDelta: -13,       // trust < 60, cap < 100 → -8 -5
        witnesses: [],              // populated below
        reasons: ["v36_garch_unstable", "v36_trust_score_below_60"],
        warnings: [],
      },
      oldConfidence: 27,
      newConfidence: 14,
      witnesses: [
        {
          name: "RealizedVolBipower",
          signal: 20,
          confidence: 0.6,
          reliable: true,
          reasons: ["jumpRatio=0.0832"],
          metrics: { rv: 0.0042, bv: 0.0040, jumpRatio: 0.0832 },
        },
        {
          name: "HurstExponent",
          signal: 0,
          confidence: 0.35,
          reliable: true,
          reasons: ["hurst=0.5234", "r2=0.4156"],
          metrics: { hurst: 0.5234, r2: 0.4156 },
        },
        {
          name: "GARCH",
          signal: -35,
          confidence: 0.85,
          reliable: true,
          reasons: ["alpha=0.05", "beta=0.92", "persistence=0.97", "high_persistence"],
          metrics: { alpha: 0.05, beta: 0.92, persistence: 0.97 },
        },
        {
          name: "HawkesLite",
          signal: 12,
          confidence: 0.45,
          reliable: true,
          reasons: ["longEvents=8", "shortEvents=4"],
          metrics: { longEvents: 8, shortEvents: 4, longAlpha: 0.42, shortAlpha: 0.18 },
        },
      ],
    },
  };
}

/** Pair with no v36 attached. Pre-3b-prep simulation, or truth gate hard-failed. */
function makeLegacyPair(): any {
  const p = makeFullPair();
  delete p.v36;  // No v36 at all
  return p;
}

/** Pair with truth gate failed. v36 attached but court fields are 0. */
function makeTruthFailedPair(): any {
  const p = makeFullPair();
  p.v36 = {
    truth: { ok: false, reasons: ["insufficient_h1_candles"], warnings: [] },
    court: {
      allowed: false,
      side: "FLAT",
      sideScore: 0,
      trustScore: 0,
      confidenceCap: 0,
      confidenceDelta: 0,
      witnesses: [],
      reasons: ["insufficient_h1_candles"],
      warnings: [],
    },
    oldConfidence: 0,
    newConfidence: 0,
    witnesses: [],  // No witnesses ran
  };
  return p;
}

/** Pair in RANGE regime with trustFloor=45 (priority 3.7b range-aware). */
function makeRangePair(): any {
  const p = makeFullPair();
  p.regime = { regime: "RANGE", label: "RANGE", adx: 18.0 };
  p.v36.court.trustScore = 50;  // would fail 60 floor, passes 45 floor
  return p;
}

// ─── Test runner ────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  try {
    assert.deepEqual(actual, expected);
    console.log(`PASS ${name}`);
    pass++;
  } catch {
    console.log(`FAIL ${name}`);
    console.log(`   expected: ${JSON.stringify(expected)}`);
    console.log(`   actual:   ${JSON.stringify(actual)}`);
    fail++;
  }
}

console.log("\n=== Group 1: Full pair — all 10 components extracted ===");
{
  const r = buildRecord(makeFullPair());
  const c = r!.v3b!.components;
  check("marketStructure",  c.marketStructure, -20);
  check("mtfAlignment",     c.mtfAlignment, 20);
  check("momentum",         c.momentum, -6.2);
  check("vwap",             c.vwap, 0);
  check("priceAction",      c.priceAction, 0);
  check("manipulation",     c.manipulation, -3);
  check("divergence",       c.divergence, 5);
  check("regimeScore",      c.regimeScore, -10);
  check("correlation",      c.correlation, 0);
  check("newsScore",        c.newsScore, -46.6);
}

console.log("\n=== Group 2: Session state ===");
{
  const r = buildRecord(makeFullPair());
  const s = r!.v3b!.session;
  check("session.name",                   s.name, "NY");
  check("session.weight",                 s.weight, 1.08);
  check("session.compositeBeforeSession", s.compositeBeforeSession, -22);
}

console.log("\n=== Group 3: v36 court state ===");
{
  const r = buildRecord(makeFullPair());
  const v = r!.v3b!.v36;
  check("v36.truthOk",          v.truthOk, true);
  check("v36.trustScore",       v.trustScore, 55);
  check("v36.sideScore",        v.sideScore, 30);
  check("v36.trustFloor",       v.trustFloor, 50);     // 6.5-main: was 60 in v3.7b, now 50 (TREND_DOWN regime)
  check("v36.confidenceCap",    v.confidenceCap, 72);
  check("v36.confidenceDelta",  v.confidenceDelta, -13);
  check("v36.oldConfidence",    v.oldConfidence, 27);
  check("v36.newConfidence",    v.newConfidence, 14);
}

console.log("\n=== Group 4: Witness outputs ===");
{
  const r = buildRecord(makeFullPair());
  const w = r!.v3b!.v36.witnesses;

  check("hurst.signal",     w.hurst.signal, 0);
  check("hurst.confidence", w.hurst.confidence, 0.35);
  check("hurst.reliable",   w.hurst.reliable, true);
  check("hurst.h",          w.hurst.h, 0.5234);
  check("hurst.r2",         w.hurst.r2, 0.4156);

  check("garch.signal",      w.garch.signal, -35);
  check("garch.confidence",  w.garch.confidence, 0.85);
  check("garch.reliable",    w.garch.reliable, true);
  check("garch.persistence", w.garch.persistence, 0.97);

  check("rvb.signal",     w.rvb.signal, 20);
  check("rvb.confidence", w.rvb.confidence, 0.6);
  check("rvb.reliable",   w.rvb.reliable, true);
  check("rvb.jumpRatio",  w.rvb.jumpRatio, 0.0832);

  check("hawkes.signal",      w.hawkes.signal, 12);
  check("hawkes.confidence",  w.hawkes.confidence, 0.45);
  check("hawkes.reliable",    w.hawkes.reliable, true);
  check("hawkes.longEvents",  w.hawkes.longEvents, 8);
  check("hawkes.shortEvents", w.hawkes.shortEvents, 4);
}

console.log("\n=== Group 5: Legacy pair (no v36) — defensive defaults ===");
{
  const r = buildRecord(makeLegacyPair());
  const v = r!.v3b!.v36;
  check("legacy: truthOk=false",         v.truthOk, false);
  check("legacy: trustScore=0",          v.trustScore, 0);
  check("legacy: confidenceDelta=0",     v.confidenceDelta, 0);
  check("legacy: hurst.signal=0",        v.witnesses.hurst.signal, 0);
  check("legacy: hurst.h=null",          v.witnesses.hurst.h, null);
  check("legacy: garch.persistence=null", v.witnesses.garch.persistence, null);
  check("legacy: rvb.jumpRatio=null",    v.witnesses.rvb.jumpRatio, null);
  check("legacy: hawkes.longEvents=null", v.witnesses.hawkes.longEvents, null);
  // components still extracted from pair.scores — no v36 dependency
  check("legacy: components still extracted", r!.v3b!.components.marketStructure, -20);
}

console.log("\n=== Group 6: Truth gate failed — v36 attached but court=0 ===");
{
  const r = buildRecord(makeTruthFailedPair());
  const v = r!.v3b!.v36;
  check("truth_failed: truthOk=false",       v.truthOk, false);
  check("truth_failed: trustScore=0",        v.trustScore, 0);
  check("truth_failed: hurst.h=null",        v.witnesses.hurst.h, null);
  check("truth_failed: hurst.signal=0",      v.witnesses.hurst.signal, 0);
}

console.log("\n=== Group 7: RANGE regime — trustFloor=45 ===");
{
  const r = buildRecord(makeRangePair());
  const v = r!.v3b!.v36;
  check("range: trustFloor=45", v.trustFloor, 45);
  check("range: trustScore preserved", v.trustScore, 50);
}

console.log("\n=== Group 8: Round-trip through file ===");
{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "v4-priority3b-prep-"));
  const tmpFile = path.join(tmpDir, "verdict_log.jsonl");
  setLogPath(tmpFile);

  const r = buildRecord(makeFullPair())!;
  await appendVerdict(r);
  const all = await readAllVerdicts();

  check("round-trip: 1 record",            all.length, 1);
  check("round-trip: components preserved", all[0].v3b?.components.marketStructure, -20);
  check("round-trip: v36 preserved",        all[0].v3b?.v36.trustScore, 55);
  check("round-trip: witness h preserved",  all[0].v3b?.v36.witnesses.hurst.h, 0.5234);
  check("round-trip: priority 0e fields preserved", all[0].riskReasons, []);

  resetLogPath();
  await fs.rm(tmpDir, { recursive: true, force: true });
}

console.log("\n=== Group 9: Pre-3b-prep records still valid ===");
{
  // Real production record from before this patch — no v3b field at all.
  const realPre3bRecord = {
    ts: "2026-05-05T15:00:28.457Z",
    version: "4.0.0-stage1f",
    pair: "XAUUSD",
    verdict: "WAIT" as const,
    confidence: 0,
    composite: -2.8,
    components: {
      marketStructure: -15, mtfAlignment: 0, momentum: 4.4, vwap: 0,
      priceAction: -7, regime: "RANGE", correlation: -50, newsScore: 25.2,
    },
    tradePlan: null,
    priceAtVerdict: 4581.82,
    tier: "REJECT",
    verdictId: "XAUUSD-1777993228457-7",
    session: "NY",
    newsContext: {
      breakingActive: false,
      breakingScore: 0,
      msidActive: false,
      highImpactPending: true,
    },
    calendarContext: { blockedBy: null },
    calibrationContext: {
      source: "heuristic" as const,
      heuristicReason: "no_calibration" as const,
    },
    // No v3b field at all.
  };
  const typed: VerdictRecord = realPre3bRecord;
  check("pre-3b: v3b is undefined",      typed.v3b, undefined);
  check("pre-3b: composite preserved",   typed.composite, -2.8);
  check("pre-3b: highImpactPending preserved", typed.newsContext.highImpactPending, true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
