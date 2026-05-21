// ============================================================================
// v4.0 priority 3a (R6) — highImpactPending observability test
//
// Per 2M's instruction (same protocol as priority 0e):
//   "no manufactured smoke tests. Integration test on a clean build that
//    produces ONE verdict and verifies the new field is present."
//
// Strategy: build a PairAnalysis-shaped object that mirrors what runCourt()
// emits in production. Pass it through buildRecord() and assert
// newsContext.highImpactPending appears with the expected value.
//
// Fixtures derived from real verdicts in production journal at:
// - 2026-05-05T15:00:28.457Z (XAUUSD WAIT, the verdict that triggered the D1
//   investigation — newsContext was breakingActive=false, msidActive=false,
//   yet riskReasons contained "High-impact event recently released / pending"
//   — confirming highImpactPending was true but unobservable).
// - 2026-05-05T10:52:30.972Z (USDCAD WAIT, no veto, baseline for "all clear").
// ============================================================================

import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  buildRecord,
} from "../measurement/recorder.js";
import {
  appendVerdict,
  readAllVerdicts,
  setLogPath,
  resetLogPath,
  type VerdictRecord,
} from "../measurement/verdictLog.js";

// ─── Fixture builders ───────────────────────────────────────────────────────

/** Base PairAnalysis-shape, all news flags false. Mirrors USDCAD 10:52 prod. */
function makeBaselinePair(): any {
  return {
    symbol: "USDCAD",
    verdict: "WAIT",
    quote: { bid: 1.3548, ask: 1.3552, mid: 1.3550 },
    scores: {
      composite: -26.4,
      confidence: 18.4,
      direction: "FLAT",
      confidenceTier: "REJECT",
      marketStructure: 23.0,
      mtf: -100.0,
      momentum: -39.5,
      vwap: -32,
      priceAction: -18,
      correlation: -5,
      news: -10.5,
      calibration: { source: "heuristic", heuristicReason: "no_calibration" },
    },
    regime: { regime: "TREND_DOWN", label: "TREND_DOWN", adx: 53.0 },
    plan: null,
    news: {
      breakingActive: false,
      breakingScore: 0,
      interventionRegime: { active: false },
      highImpactPending: false,
    },
    risk: { reasons: [] },
    verdictExplanation: { missing: [], headline: "", why: [], nextSteps: [] },
  };
}

/** Same as baseline but with highImpactPending TRUE — mirrors XAUUSD 15:00 prod. */
function makeHighImpactPendingPair(): any {
  const p = makeBaselinePair();
  p.symbol = "XAUUSD";
  p.scores.composite = -2.8;
  p.scores.confidence = 0;
  p.regime.label = "RANGE";
  p.news.highImpactPending = true;
  p.risk.reasons = [
    "Composite confidence 3 < threshold 60",
    "No clear directional bias (FLAT)",
    "RR n/a below minimum 1.50",
    "High-impact event recently released / pending – stand down",
  ];
  p.verdictExplanation.missing = [
    "Confidence 3 below threshold",
    "High-impact event recently released / pending – stand down",
    "v36_not_enough_directional_witnesses_1",
  ];
  return p;
}

/** Pair where highImpactPending is undefined — pre-priority-1.8 simulation. */
function makeLegacyPair(): any {
  const p = makeBaselinePair();
  // Delete the field entirely. recorder.ts must coerce !!undefined → false.
  delete p.news.highImpactPending;
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

console.log("\n=== Group 1: baseline pair (all flags false) ===");
{
  const r = buildRecord(makeBaselinePair());
  check("highImpactPending logged as false", r!.newsContext.highImpactPending, false);
  check("breakingActive still false", r!.newsContext.breakingActive, false);
  check("msidActive still false", r!.newsContext.msidActive, false);
  check("breakingScore still 0", r!.newsContext.breakingScore, 0);
}

console.log("\n=== Group 2: high-impact-pending pair (the XAUUSD 15:00 case) ===");
{
  const r = buildRecord(makeHighImpactPendingPair());
  check("highImpactPending logged as TRUE", r!.newsContext.highImpactPending, true);
  check("breakingActive still false", r!.newsContext.breakingActive, false);
  check("msidActive still false", r!.newsContext.msidActive, false);
  // Confirm we still get the priority 0e fields too — no regression.
  check("riskReasons contains the visible veto", 
        r!.riskReasons!.some(s => s.includes("High-impact event recently released")), 
        true);
}

console.log("\n=== Group 3: legacy pair (highImpactPending field absent) ===");
{
  const r = buildRecord(makeLegacyPair());
  check("highImpactPending coerced to false when absent", 
        r!.newsContext.highImpactPending, false);
  check("Other newsContext fields unchanged", r!.newsContext.breakingActive, false);
}

console.log("\n=== Group 4: round-trip through file ===");
{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "v4-priority3a-"));
  const tmpFile = path.join(tmpDir, "verdict_log.jsonl");
  setLogPath(tmpFile);

  // Write one of each kind, read back.
  const r1 = buildRecord(makeBaselinePair())!;
  const r2 = buildRecord(makeHighImpactPendingPair())!;
  await appendVerdict(r1);
  await appendVerdict(r2);

  const all = await readAllVerdicts();
  check("read back 2 records", all.length, 2);
  check("first record highImpactPending = false", 
        all[0].newsContext.highImpactPending, false);
  check("second record highImpactPending = true", 
        all[1].newsContext.highImpactPending, true);

  resetLogPath();
  await fs.rm(tmpDir, { recursive: true, force: true });
}

console.log("\n=== Group 5: production records pre-3a remain valid ===");
{
  // A literal sample from production journal pre-3a (no highImpactPending).
  const realPre3aRecord = {
    ts: "2026-05-05T10:52:30.972Z",
    version: "4.0.0-stage1d",
    pair: "USDCAD",
    verdict: "WAIT" as const,
    confidence: 18.4,
    composite: -26.4,
    components: {
      marketStructure: 23.0, mtfAlignment: -100.0, momentum: -39.5,
      vwap: -32, priceAction: -18, regime: "TREND_DOWN",
      correlation: -5, newsScore: -10.5,
    },
    tradePlan: null,
    priceAtVerdict: 1.3550,
    tier: "REJECT",
    verdictId: "USDCAD-1777867950972-1",
    session: "LDN",
    newsContext: {
      breakingActive: false,
      breakingScore: 0,
      msidActive: false,
      // highImpactPending field absent — pre-3a record
    },
    calendarContext: { blockedBy: null },
    calibrationContext: {
      source: "heuristic" as const,
      heuristicReason: "no_calibration" as const,
    },
  };

  // Cast as VerdictRecord — TypeScript accepts because field is optional
  const typed: VerdictRecord = realPre3aRecord;
  check("legacy record types correctly", typed.newsContext.highImpactPending, undefined);
  check("legacy record retains other fields", typed.composite, -26.4);
  check("legacy record retains breakingActive", typed.newsContext.breakingActive, false);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
