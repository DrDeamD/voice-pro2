// ============================================================================
// v4.6 Phase A — Judge integration of Fibonacci + Pivot signals
//
// Deterministic, pure-function tests. Constructs synthetic JudgeEngineV4Input
// objects and verifies the judge applies the 3 new rules correctly:
//   - fib_golden_zone_aligned       (-10 points = bonus)
//   - fib_overstretched_extension   (+15 points)
//   - daily_pivot_pressure_against_trade (+12 points)
// ============================================================================

import { strict as assert } from "node:assert";
import { judgeEngineV4 } from "../engines/judge/judgeEngineV4.js";

let pass = 0, fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  try {
    assert.deepEqual(actual, expected);
    console.log(`PASS ${name}`);
    pass++;
  } catch {
    console.log(`FAIL ${name}\n   expected: ${JSON.stringify(expected)}\n   actual:   ${JSON.stringify(actual)}`);
    fail++;
  }
}
function checkTrue(name: string, cond: any) {
  if (cond) { console.log(`PASS ${name}`); pass++; }
  else      { console.log(`FAIL ${name} — got ${JSON.stringify(cond)}`); fail++; }
}

const baseInput = {
  verdict: "BUY" as const,
  confidence: 70,
  h4Trend: "UP" as const,
  premiumPct: null,
  intradayBias: "BULL" as const,
  newsImpact: "NONE" as const,
  sweptHigh: false,
  sweptLow: false,
  bos: "NONE" as const,
  choch: "NONE" as const,
  newsAlignedWithTrade: false,
  entryConfirmation: false,
};

// ─── Rule 1: fib_golden_zone_aligned ───────────────────────────────────────
console.log("\n=== Rule 1: fib_golden_zone_aligned ===");
{
  const out = judgeEngineV4({ ...baseInput, fibGoldenZoneAligned: true });
  const item = out.riskItems.find(r => r.code === "fib_golden_zone_aligned");
  checkTrue("Item present", !!item);
  check("Item points = -10 (bonus)", item?.points, -10);
}
{
  // Without flag → no item
  const out = judgeEngineV4({ ...baseInput, fibGoldenZoneAligned: false });
  const item = out.riskItems.find(r => r.code === "fib_golden_zone_aligned");
  check("Without flag: no item", item, undefined);
}

// ─── Rule 2: fib_overstretched_extension ──────────────────────────────────
console.log("\n=== Rule 2: fib_overstretched_extension ===");
{
  const out = judgeEngineV4({ ...baseInput, fibExtendedSameDirection: true });
  const item = out.riskItems.find(r => r.code === "fib_overstretched_extension");
  checkTrue("Item present", !!item);
  check("Item points = 15", item?.points, 15);
}

// ─── Rule 3: daily_pivot_pressure_against_trade ────────────────────────────
console.log("\n=== Rule 3: daily_pivot_pressure_against_trade ===");
{
  const out = judgeEngineV4({ ...baseInput, dailyPivotAgainst: true });
  const item = out.riskItems.find(r => r.code === "daily_pivot_pressure_against_trade");
  checkTrue("Item present", !!item);
  check("Item points = 12", item?.points, 12);
}

// ─── Combined effect: aggregate risk score ─────────────────────────────────
console.log("\n=== Combined: bonus + penalty math ===");
{
  // Golden zone (-10) + overstretched (+15) + pivot against (+12) = +17
  const out = judgeEngineV4({
    ...baseInput,
    fibGoldenZoneAligned: true,
    fibExtendedSameDirection: true,
    dailyPivotAgainst: true,
  });
  // riskScore is clamped to [0,100] AFTER the +25 - 10 = +17 sum
  // (no other risks fire because h4Trend=UP, intraday=BULL, etc.)
  check("Aggregate risk = 17", out.riskScore, 17);
}
{
  // Only golden zone bonus → riskScore clamped to 0 (no other risks)
  const out = judgeEngineV4({ ...baseInput, fibGoldenZoneAligned: true });
  // raw = -10, clamped to 0
  check("Only golden bonus → riskScore = 0 (clamp)", out.riskScore, 0);
}
{
  // No new flags → no impact (baseline)
  const out = judgeEngineV4(baseInput);
  check("No new flags → riskScore = 0", out.riskScore, 0);
}

// ─── Mode classification — golden zone alone keeps NO_OVERRIDE ──────────────
console.log("\n=== Mode classification ===");
{
  // Just golden bonus on aligned trade → mode stays NO_OVERRIDE
  const out = judgeEngineV4({ ...baseInput, fibGoldenZoneAligned: true });
  check("Mode = NO_OVERRIDE on bonus-only", out.mode, "NO_OVERRIDE");
}
{
  // Overstretched + pivot against = 27 → CONFIDENCE_ADJUST (< 40)
  const out = judgeEngineV4({
    ...baseInput,
    fibExtendedSameDirection: true,
    dailyPivotAgainst: true,
  });
  check("riskScore = 27", out.riskScore, 27);
  check("Mode = CONFIDENCE_ADJUST", out.mode, "CONFIDENCE_ADJUST");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
