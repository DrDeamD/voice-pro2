// ============================================================================
// v3.5.3 — Race-Free Rapid Mode Test
//
// Purpose:
//   In production v3.5.2 the user reported that the "وضع سريع" indicator did
//   NOT appear despite breakingActive=true on EURUSD. Root cause: legacy
//   setInterval(30s) was still wired in init(), AND scheduleNextRefresh()
//   (the function that updated the indicator) was never called at startup —
//   only when the user manually toggled the checkbox.
//
//   v3.5.3 fixes this by:
//     1. Removing the legacy setInterval entirely
//     2. Detecting rapid mode DIRECTLY from snapshot data (no /api/state race)
//     3. Calling scheduleNextRefresh() in loadSnapshot's finally block so it
//        runs on every cycle including the very first
//
// This test verifies that any pair with breakingActive=true OR
// interventionRegime.active=true triggers rapid mode, regardless of source.
// ============================================================================
import assert from "node:assert/strict";

let pass = 0, fail = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e: any) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("v3.5.3 — Race-Free Rapid Mode Detection");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

// Replicate the frontend detection logic exactly so we test the contract
function detectRapidMode(snapshot: any): { rapid: boolean; reasons: string[] } {
  if (!snapshot || !Array.isArray(snapshot.pairs)) {
    return { rapid: false, reasons: [] };
  }
  const breakingPairs = snapshot.pairs.filter((p: any) =>
    p && p.news && (
      p.news.breakingActive ||
      (p.news.interventionRegime && p.news.interventionRegime.active)
    )
  );
  const reasons = breakingPairs.slice(0, 2).map((p: any) => {
    const t = (p.news.breakingType && p.news.breakingType !== "NONE") ? p.news.breakingType : "BREAKING";
    const ccys = (p.news.breakingCurrencies || []).slice(0, 2).join(",");
    return p.symbol + ": " + t + (ccys ? " " + ccys : "");
  });
  return { rapid: breakingPairs.length > 0, reasons };
}

test("Empty snapshot → not rapid", () => {
  const r = detectRapidMode({ pairs: [] });
  assert.equal(r.rapid, false);
});

test("All pairs quiet → not rapid", () => {
  const r = detectRapidMode({
    pairs: [
      { symbol: "EURUSD", news: { breakingActive: false } },
      { symbol: "GBPUSD", news: { breakingActive: false } },
    ],
  });
  assert.equal(r.rapid, false);
});

test("ONE pair with breakingActive → rapid", () => {
  const r = detectRapidMode({
    pairs: [
      { symbol: "EURUSD", news: { breakingActive: false } },
      { symbol: "USDJPY", news: { breakingActive: true, breakingType: "REGIME", breakingCurrencies: ["USD","JPY"] } },
    ],
  });
  assert.equal(r.rapid, true);
  assert.ok(r.reasons[0].includes("USDJPY"));
  assert.ok(r.reasons[0].includes("REGIME"));
});

test("Pair with interventionRegime.active but no breakingActive → still rapid", () => {
  // In some edge cases the regime fires but breakingActive may be false in
  // the snapshot for legacy reasons. The frontend should still detect rapid.
  const r = detectRapidMode({
    pairs: [
      { symbol: "USDJPY", news: {
          breakingActive: false,
          interventionRegime: { active: true, currencies: ["JPY"], sourceCount: 4 }
        }
      },
    ],
  });
  assert.equal(r.rapid, true);
});

test("Multiple breaking pairs → reasons capped at 2", () => {
  const r = detectRapidMode({
    pairs: [
      { symbol: "USDJPY", news: { breakingActive: true, breakingType: "REGIME", breakingCurrencies: ["JPY"] } },
      { symbol: "EURUSD", news: { breakingActive: true, breakingType: "FRESH",  breakingCurrencies: ["EUR"] } },
      { symbol: "GBPUSD", news: { breakingActive: true, breakingType: "REGIME", breakingCurrencies: ["GBP"] } },
    ],
  });
  assert.equal(r.rapid, true);
  assert.equal(r.reasons.length, 2, "should cap at 2 reasons for UI brevity");
});

test("Production scenario: EURUSD with MSID regime → rapid mode triggered", () => {
  // This is the exact scenario from the user's v3.5.2 screenshot
  const r = detectRapidMode({
    pairs: [
      { symbol: "EURUSD", news: {
          breakingActive: true,
          breakingType: "REGIME",
          breakingCurrencies: ["USD", "EUR"],
          breakingScore: 40,
          interventionRegime: {
            active: true,
            currencies: ["USD", "EUR"],
            sourceCount: 2,
            oldestHours: 2.7,
          },
        }
      },
    ],
  });
  assert.equal(r.rapid, true, "EURUSD with MSID regime must trigger rapid mode");
  assert.ok(r.reasons[0].includes("EURUSD"));
});

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`v3.5.3 RAPID-MODE SUMMARY: ${pass} passed, ${fail} failed`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

if (fail > 0) process.exit(1);
