// ============================================================================
// v4.0-stage1c Priority 1.8 — Smoke Test
//
// Verifies the highImpactPending sliding window in newsEngine.ts.
//
// Before fix: highImpactPending was set to true if ANY item in the items
// list had highImpact=true, regardless of how old. A CPI release from 90
// minutes ago kept vetoing trades for hours.
//
// After fix: highImpactPending requires at least one high-impact item
// fresher than RULES.highImpactPendingWindowMin (default 60 min). Stale
// items still feed sentiment scoring but don't trigger the risk-gate
// stand-down.
//
// We exercise the patched code path through the public analyzeNews()
// entry point with synthetic NewsItem fixtures.
// ============================================================================

import { strict as assert } from "node:assert";
import { analyzeNews } from "../engines/newsEngine.js";
import type { NewsItem } from "../types/index.js";
import { RULES } from "../config.js";

// ─── Fixture builder ────────────────────────────────────────────────────────
function mk(opts: {
  title: string;
  ccys: string[];
  freshnessH: number | null;
  highImpact: boolean;
  breaking?: boolean;
  category?: NewsItem["category"];
  sentiment?: number;
}): NewsItem {
  return {
    title: opts.title,
    url: "https://test.example/" + encodeURIComponent(opts.title),
    source: "test",
    publishedUtc: opts.freshnessH != null
      ? new Date(Date.now() - opts.freshnessH * 3600 * 1000).toISOString()
      : null,
    freshnessHours: opts.freshnessH,
    sentiment: opts.sentiment ?? 0,
    impactCurrencies: opts.ccys,
    highImpact: opts.highImpact,
    breaking: opts.breaking ?? false,
    category: opts.category ?? "DATA",
    velocityScore: opts.breaking ? 8 : 2,
  };
}

let pass = 0, fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  try {
    assert.deepEqual(actual, expected);
    console.log(`✅ ${name}`);
    pass++;
  } catch {
    console.log(`❌ ${name}`);
    console.log(`   expected: ${JSON.stringify(expected)}`);
    console.log(`   actual:   ${JSON.stringify(actual)}`);
    fail++;
  }
}

console.log(`\nRULES.highImpactPendingWindowMin = ${RULES.highImpactPendingWindowMin}`);
console.log(`(window in hours: ${(RULES.highImpactPendingWindowMin / 60).toFixed(2)})\n`);

// ─── Group 1: production scenario (CPI from 1.7h ago) ──────────────────────
console.log("=== Group 1: Production scenario reproduced ===");

{
  // Switzerland April CPI from 1.7 hours ago, USD/CHF analysis. Before fix,
  // this single item set highImpactPending=true and vetoed USD/CHF.
  const items = [
    mk({
      title: "Switzerland April CPI +0.6% vs +0.6% y/y expected",
      ccys: ["CHF"],
      freshnessH: 1.7,
      highImpact: true,
      category: "DATA",
    }),
  ];
  const r = analyzeNews("USDCHF", items);
  check("CPI 1.7h ago: highImpactPending = false (was true)", r.highImpactPending, false);
}

{
  // Same event but only 30 min ago — should still veto.
  const items = [
    mk({
      title: "Switzerland April CPI +0.6%",
      ccys: ["CHF"],
      freshnessH: 0.5,
      highImpact: true,
      category: "DATA",
    }),
  ];
  const r = analyzeNews("USDCHF", items);
  check("CPI 0.5h ago: highImpactPending = true", r.highImpactPending, true);
}

{
  // Right at the boundary: exactly 60 min (1.0h) — the edge case
  const items = [
    mk({
      title: "CPI release",
      ccys: ["USD"],
      freshnessH: 1.0,
      highImpact: true,
      category: "DATA",
    }),
  ];
  const r = analyzeNews("EURUSD", items);
  // Window is INCLUSIVE at 1.0, so: 1.0 <= 1.0 → still pending
  check("CPI exactly 1.0h ago (inclusive boundary): pending = true", r.highImpactPending, true);
}

{
  // Just past the boundary: 1.01h
  const items = [
    mk({
      title: "CPI release",
      ccys: ["USD"],
      freshnessH: 1.01,
      highImpact: true,
      category: "DATA",
    }),
  ];
  const r = analyzeNews("EURUSD", items);
  check("CPI 1.01h ago (just past boundary): pending = false", r.highImpactPending, false);
}

// ─── Group 2: imminent (future) events should NOT trigger pending ──────────
console.log("\n=== Group 2: Future-dated items should not trigger ===");

{
  // After priority 1's fix, future-dated items should have freshnessH = null,
  // not negative. Let's exercise the safety check anyway.
  const items = [
    mk({
      title: "Boxing Day (future)",
      ccys: ["CAD"],
      freshnessH: null,  // simulating priority-1-patched output
      highImpact: false,  // priority 1 also forces highImpact=false for these
      category: "GENERAL",
    }),
  ];
  const r = analyzeNews("USDCAD", items);
  check("Future holiday: pending = false", r.highImpactPending, false);
}

{
  // Defense-in-depth: even if a buggy upstream sent freshnessH = -0.5
  // (future), the new guard `it.freshnessHours >= 0` rejects it.
  const items = [
    mk({
      title: "Future event with bad data",
      ccys: ["USD"],
      freshnessH: -0.5,
      highImpact: true,
      category: "POLICY",
    }),
  ];
  const r = analyzeNews("EURUSD", items);
  check("Future event with negative freshnessH: pending = false", r.highImpactPending, false);
}

// ─── Group 3: stale items keep contributing to sentiment ───────────────────
console.log("\n=== Group 3: Stale items still affect sentiment ===");

{
  // Stale CPI item with sentiment +30 should still influence baseScore,
  // even though it no longer triggers the pending veto.
  const items = [
    mk({
      title: "USD CPI +30 sentiment from 3h ago",
      ccys: ["USD"],
      freshnessH: 3.0,
      highImpact: true,
      category: "DATA",
      sentiment: +30,
    }),
  ];
  const r = analyzeNews("EURUSD", items);
  check("Stale item: pending = false", r.highImpactPending, false);
  check("Stale item: still contributes to scoring (quoteScore != 0)",
        r.quoteScore !== 0, true);
}

// ─── Group 4: breaking items still pass via breakingActive ─────────────────
console.log("\n=== Group 4: Breaking flag preserves veto ===");

{
  // Breaking flag should still trigger pending via breakingActive,
  // independent of the highImpact window. (breaking=true items are
  // already constrained to <=30min by buildItem — they're always fresh.)
  const items = [
    mk({
      title: "Fed emergency cut",
      ccys: ["USD"],
      freshnessH: 0.2,
      highImpact: true,
      breaking: true,
      category: "POLICY",
    }),
  ];
  const r = analyzeNews("EURUSD", items);
  check("Breaking item 12min ago: pending = true", r.highImpactPending, true);
  check("Breaking item 12min ago: breakingActive = true", r.breakingActive, true);
}

// ─── Group 5: multiple items, mixed freshness ──────────────────────────────
console.log("\n=== Group 5: Mixed freshness — newest item determines pending ===");

{
  // One stale CPI (2h) + one fresh data (45 min). Should pending fire?
  // YES — because the fresh one is within window AND highImpact.
  const items = [
    mk({ title: "Old CPI",      ccys: ["USD"], freshnessH: 2.0,  highImpact: true,  category: "DATA" }),
    mk({ title: "Fresh data",   ccys: ["USD"], freshnessH: 0.75, highImpact: true,  category: "DATA" }),
  ];
  const r = analyzeNews("EURUSD", items);
  check("Mixed: fresh+stale → pending true (because of fresh)", r.highImpactPending, true);
}

{
  // Two stale items (both > 1h). Should be false.
  const items = [
    mk({ title: "Old1", ccys: ["USD"], freshnessH: 2.0, highImpact: true, category: "DATA" }),
    mk({ title: "Old2", ccys: ["USD"], freshnessH: 3.5, highImpact: true, category: "DATA" }),
  ];
  const r = analyzeNews("EURUSD", items);
  check("Two stale items → pending = false", r.highImpactPending, false);
}

{
  // Items with highImpact=false should never trigger pending regardless
  // of freshness. (sanity check, behavior unchanged from before)
  const items = [
    mk({ title: "Routine", ccys: ["USD"], freshnessH: 0.2, highImpact: false, category: "GENERAL" }),
  ];
  const r = analyzeNews("EURUSD", items);
  check("Non-highImpact items: pending = false", r.highImpactPending, false);
}

// ─── Group 6: edge cases ───────────────────────────────────────────────────
console.log("\n=== Group 6: Edge cases ===");

{
  const r = analyzeNews("EURUSD", []);
  check("Empty items: pending = false", r.highImpactPending, false);
}

{
  // freshnessH = 0 (right now)
  const items = [
    mk({ title: "Just now", ccys: ["USD"], freshnessH: 0, highImpact: true, category: "POLICY" }),
  ];
  const r = analyzeNews("EURUSD", items);
  check("Item at freshnessH=0: pending = true", r.highImpactPending, true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
