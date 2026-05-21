// ============================================================================
// v3.4 Source Health Tests
// Verifies the v3.4 cleanup of dead sources + TTL reduction
// ============================================================================
import assert from "node:assert/strict";
import { KNOWN_SOURCES, TTL, VERSION, RULES } from "../config.js";

let pass = 0, fail = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e: any) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("v3.4 Source Health & TTL Tests");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

test("VERSION is 3.5.x", () => {
  assert.match(VERSION, /^3\.5\.\d+$/, `VERSION should be 3.5.x, got ${VERSION}`);
});

// ─── v3.5.1: full G10 bias coverage ────────────────────────────────────────
test("v3.5.1 — RULES.msidImpliedBias covers all G10 currencies", () => {
  const bias = (RULES as any).msidImpliedBias;
  assert.ok(bias, "msidImpliedBias table must exist");
  for (const ccy of ["JPY", "CHF", "GBP", "EUR", "AUD", "NZD", "CAD", "USD"]) {
    assert.ok(typeof bias[ccy] === "number", `bias[${ccy}] must be defined`);
  }
});

test("v3.5.1 — JPY bias is positive (BoJ wants stronger yen)", () => {
  assert.ok((RULES as any).msidImpliedBias.JPY > 0,
    "JPY bias should be positive (BoJ intervenes to strengthen yen)");
});

test("v3.5.1 — CHF bias is negative (SNB wants weaker franc)", () => {
  assert.ok((RULES as any).msidImpliedBias.CHF < 0,
    "CHF bias should be negative (SNB intervenes to weaken franc)");
});

test("v3.5.1 — GBP bias is positive (BoE 2022 defended pound)", () => {
  assert.ok((RULES as any).msidImpliedBias.GBP > 0,
    "GBP bias should be positive (BoE intervenes to support pound from collapse)");
});

test("v3.5.1 — AUD/NZD bias is negative (RBA/RBNZ talk down strength)", () => {
  assert.ok((RULES as any).msidImpliedBias.AUD < 0);
  assert.ok((RULES as any).msidImpliedBias.NZD < 0);
});

// ─── DEAD sources must be removed ───────────────────────────────────────────
test("forexfactory (dead) removed from KNOWN_SOURCES", () => {
  assert.equal(KNOWN_SOURCES.forexfactory, undefined,
    "forexfactory direct endpoint blocks server IPs — should be removed");
});

test("investing (dead POST scrape) removed from KNOWN_SOURCES", () => {
  assert.equal(KNOWN_SOURCES.investing, undefined,
    "investing POST scrape requires CSRF — should be removed");
});

test("myfxbook (auth required) removed from KNOWN_SOURCES", () => {
  assert.equal(KNOWN_SOURCES.myfxbook, undefined);
});

test("livesquawk (paywall) removed from KNOWN_SOURCES", () => {
  assert.equal(KNOWN_SOURCES.livesquawk, undefined,
    "livesquawk has no public RSS — should be removed");
});

// ─── New v3.4 sources added ─────────────────────────────────────────────────
test("forexlive_cb (new in v3.4) added", () => {
  assert.ok(KNOWN_SOURCES.forexlive_cb, "ForexLive central bank feed must be registered");
  assert.equal(KNOWN_SOURCES.forexlive_cb.group, "NEWS");
});

test("fxstreet removed in v3.5.4 (Cloudflare blocks server IPs — HTTP 403)", () => {
  // v3.4.2 kept fxstreet on the assumption /rss/news worked; v3.5.4 audit
  // (web_fetch) confirmed both /rss/news (403) and /news/feed (HTML) are
  // unusable from server IPs. Same fate as forexfactory/dailyfx/tradingeconomics.
  assert.equal(KNOWN_SOURCES.fxstreet, undefined,
    "fxstreet should be removed: Cloudflare blocks server-side fetches");
});

// ─── v3.4.2 specific: removed unverified sources ────────────────────────────
test("tradingeconomics removed in v3.4.2 (RSS endpoint returns HTML index)", () => {
  assert.equal(KNOWN_SOURCES.tradingeconomics, undefined,
    "TE RSS doesn't deliver structured calendar data — should be dropped");
});

test("dailyfx removed in v3.4.2 (domain merged into IG, URL unreliable)", () => {
  assert.equal(KNOWN_SOURCES.dailyfx, undefined);
});

// ─── Surviving sources still present ────────────────────────────────────────
test("faireconomy still present (it works!)", () => {
  assert.ok(KNOWN_SOURCES.faireconomy);
  assert.equal(KNOWN_SOURCES.faireconomy.group, "CALENDAR");
});

test("gnews, swissquote, kraken, stooq still present", () => {
  for (const k of ["gnews", "swissquote", "kraken", "stooq"]) {
    assert.ok(KNOWN_SOURCES[k], `${k} must remain`);
  }
});

// ─── TTL must be aggressive enough for actuals to flow ──────────────────────
test("CALENDAR_STRUCTURE TTL ≤ 60s (was 600s in v3.3)", () => {
  assert.ok(TTL.CALENDAR_STRUCTURE <= 60,
    `TTL.CALENDAR_STRUCTURE = ${TTL.CALENDAR_STRUCTURE}, must be ≤60s to avoid stuck "جاري..."`);
});

test("CALENDAR_NEXTWEEK TTL still relaxed (next week rarely changes)", () => {
  assert.ok(TTL.CALENDAR_NEXTWEEK >= 600);
});

// ─── v3.5 MSID configuration ────────────────────────────────────────────────
test("v3.5 — RULES.msidMinSources is configured", () => {
  assert.ok((RULES as any).msidMinSources >= 2,
    `msidMinSources should be ≥2 (consensus threshold), got ${(RULES as any).msidMinSources}`);
});

test("v3.5 — RULES.msidWindowHours is configured", () => {
  assert.ok((RULES as any).msidWindowHours >= 4 && (RULES as any).msidWindowHours <= 12,
    `msidWindowHours should be in [4, 12], got ${(RULES as any).msidWindowHours}`);
});

test("v3.5 — breakingNewsMaxAgeMin widened from 15 to 60", () => {
  assert.ok((RULES as any).breakingNewsMaxAgeMin >= 30,
    `breakingNewsMaxAgeMin should be ≥30 in v3.5 (was 15), got ${(RULES as any).breakingNewsMaxAgeMin}`);
});

// ─── Total source count ─────────────────────────────────────────────────────
test("KNOWN_SOURCES contains the v3.5.4 working sources (9 entries, fxstreet dropped)", () => {
  const count = Object.keys(KNOWN_SOURCES).length;
  console.log(`     • count: ${count}`);
  // v3.5.4: 9 sources (was 10 in v3.4.2-v3.5.3 with fxstreet)
  // 9 = swissquote + kraken + stooq + tradingview + tv_context +
  //     faireconomy + gnews + forexlive + forexlive_cb
  assert.equal(count, 9,
    `v3.5.4 expects exactly 9 sources after fxstreet removal, got ${count}`);
});

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`v3.4 SUMMARY: ${pass} passed, ${fail} failed`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

if (fail > 0) process.exit(1);
