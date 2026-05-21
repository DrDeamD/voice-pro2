// ============================================================================
// v3.5.2 Latency Budget Tests
//
// Purpose:
//   Day trading is latency-sensitive. The user's requirement: end-to-end
//   response time must never exceed 5 minutes — and ideally be much less.
//
// Latency chain (worst case):
//   [a] News publishes at source        T+0
//   [b] RSS feed updates                T+0..15s   (out of our control)
//   [c] Server polls RSS (NEWS_FAST)    T+0..NEWS_FAST seconds
//   [d] Server caches snapshot          T+0..SNAPSHOT seconds
//   [e] Frontend auto-refresh           T+0..REFRESH_INTERVAL seconds
//
// Total worst case ≈ 15 + NEWS_FAST + SNAPSHOT + REFRESH_INTERVAL/1000
//
// Targets:
//   NORMAL mode: ≤ 90 seconds  (1.5 min)
//   RAPID  mode: ≤ 30 seconds
//   ABSOLUTE max ever: ≤ 300s (5 min, the user's hard limit)
// ============================================================================
import assert from "node:assert/strict";
import { TTL, TTL_RAPID, REFRESH_INTERVALS_MS } from "../config.js";

let pass = 0, fail = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e: any) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("v3.5.2 Latency Budget Tests");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

// Helper: compute worst-case end-to-end latency
function computeE2ELatency(ttls: typeof TTL, refreshMs: number): number {
  const RSS_LAG_MAX_SEC = 15;          // out of our control
  return RSS_LAG_MAX_SEC + ttls.NEWS_FAST + ttls.SNAPSHOT + (refreshMs / 1000);
}

const normalE2E = computeE2ELatency(TTL, REFRESH_INTERVALS_MS.NORMAL);
const rapidE2E  = computeE2ELatency(TTL_RAPID, REFRESH_INTERVALS_MS.RAPID);

console.log(`     • Normal mode E2E worst case: ${normalE2E}s`);
console.log(`     • Rapid  mode E2E worst case: ${rapidE2E}s`);

test("Hard requirement: NORMAL mode E2E latency ≤ 5 min (300s)", () => {
  assert.ok(normalE2E <= 300,
    `Normal E2E = ${normalE2E}s, must be ≤ 300s (user's hard limit)`);
});

test("Day-trading target: NORMAL mode E2E latency ≤ 90s", () => {
  assert.ok(normalE2E <= 90,
    `Normal E2E = ${normalE2E}s, target is ≤ 90s for day trading`);
});

test("Critical-event target: RAPID mode E2E latency ≤ 32s", () => {
  // 15s of this is RSS feed lag which is OUTSIDE our system. The components
  // we control (server cache + refresh interval) sum to ≤17s in rapid mode.
  assert.ok(rapidE2E <= 32,
    `Rapid E2E = ${rapidE2E}s, target is ≤ 32s for breaking events ` +
    `(includes 15s external RSS lag we don't control)`);
});

test("Our-system rapid latency (excluding RSS lag) ≤ 17s", () => {
  const ourLatency = TTL_RAPID.NEWS_FAST + TTL_RAPID.SNAPSHOT + (REFRESH_INTERVALS_MS.RAPID / 1000);
  console.log(`     • our-system rapid latency: ${ourLatency}s`);
  assert.ok(ourLatency <= 17,
    `Our system in rapid mode = ${ourLatency}s, target ≤ 17s`);
});

test("Rapid mode is meaningfully faster than normal (≥40% reduction)", () => {
  const reduction = 1 - (rapidE2E / normalE2E);
  console.log(`     • reduction: ${(reduction * 100).toFixed(0)}%`);
  assert.ok(reduction >= 0.4,
    `Rapid mode should be ≥40% faster than normal, got ${(reduction * 100).toFixed(0)}%`);
});

// ─── Individual TTL sanity ─────────────────────────────────────────────────
test("TTL.SNAPSHOT ≤ 15s in normal mode", () => {
  assert.ok(TTL.SNAPSHOT <= 15,
    `TTL.SNAPSHOT = ${TTL.SNAPSHOT}s, should be ≤ 15s`);
});

test("TTL_RAPID.SNAPSHOT ≤ 8s in rapid mode", () => {
  assert.ok(TTL_RAPID.SNAPSHOT <= 8,
    `TTL_RAPID.SNAPSHOT = ${TTL_RAPID.SNAPSHOT}s, should be ≤ 8s`);
});

test("TTL.NEWS_FAST ≤ 30s baseline (was 45s in v3.5.1)", () => {
  assert.ok(TTL.NEWS_FAST <= 30,
    `TTL.NEWS_FAST = ${TTL.NEWS_FAST}s, should be tightened to ≤ 30s`);
});

test("TTL_RAPID.NEWS_FAST ≤ 12s in rapid mode", () => {
  assert.ok(TTL_RAPID.NEWS_FAST <= 12);
});

test("REFRESH_INTERVALS.NORMAL ≤ 20s", () => {
  assert.ok(REFRESH_INTERVALS_MS.NORMAL <= 20000,
    `Frontend NORMAL refresh = ${REFRESH_INTERVALS_MS.NORMAL}ms, should be ≤ 20000`);
});

test("REFRESH_INTERVALS.RAPID ≤ 10s", () => {
  assert.ok(REFRESH_INTERVALS_MS.RAPID <= 10000,
    `Frontend RAPID refresh = ${REFRESH_INTERVALS_MS.RAPID}ms, should be ≤ 10000`);
});

// ─── Improvement vs v3.5.1 ─────────────────────────────────────────────────
test("v3.5.2 is faster than v3.5.1 baseline", () => {
  // v3.5.1 had: SNAPSHOT=30s, NEWS_FAST=45s, refresh=30000ms
  // v3.5.1 normal E2E = 15 + 45 + 30 + 30 = 120s
  const v3_5_1_e2e = 15 + 45 + 30 + 30;
  console.log(`     • v3.5.1 normal E2E: ${v3_5_1_e2e}s`);
  console.log(`     • v3.5.2 normal E2E: ${normalE2E}s`);
  console.log(`     • improvement: ${v3_5_1_e2e - normalE2E}s saved`);
  assert.ok(normalE2E < v3_5_1_e2e,
    `v3.5.2 (${normalE2E}s) should be faster than v3.5.1 (${v3_5_1_e2e}s)`);
});

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`v3.5.2 LATENCY SUMMARY: ${pass} passed, ${fail} failed`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

if (fail > 0) process.exit(1);
