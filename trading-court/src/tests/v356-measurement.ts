// ============================================================================
// v3.5.6 — Self-Measurement Tests (7 cases)
//
// Coverage:
//   1. verdict_log.jsonl is written correctly when a verdict is generated
//   2. Append-only: existing lines NEVER mutate (file size monotonic; old lines unchanged)
//   3. outcome_tracker computes TP/SL hits accurately from M5 fixtures
//   4. /api/performance returns correct hit-rate from synthetic verdicts+outcomes
//   5. Resilience triple: missing file, malformed line, missed cron run all handled
//   6. Idempotency: appendVerdict uses fs.appendFile; lines never overwritten
//   7. Concurrency: 8 simultaneous verdicts (NFP burst) → 8 valid JSON lines
// ============================================================================
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  appendVerdict, readAllVerdicts, makeVerdictId, detectSession, setLogPath,
  type VerdictRecord,
} from "../measurement/verdictLog.js";
import {
  appendOutcome, readAllOutcomes, computeOutcome, selectOpenVerdicts,
  setOutcomePath, type OutcomeRecord, type M5Candle,
} from "../measurement/outcomeTracker.js";
import {
  aggregate, getPerformance, clearPerformanceCache,
} from "../measurement/performance.js";
import { buildRecord } from "../measurement/recorder.js";

let pass = 0, fail = 0;
function test(name: string, fn: () => Promise<void> | void) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✅ ${name}`); pass++; })
    .catch(e => { console.log(`  ❌ ${name}\n     ${e?.message ?? e}`); fail++; });
}

async function tmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "tcp-v356-"));
}

function makeSyntheticPair(symbol: string, verdict: "BUY" | "SELL" | "WAIT", confidence: number): any {
  return {
    symbol, display: symbol,
    verdict,
    quote: { bid: 1.0825, ask: 1.0826, mid: 1.08255 },
    scores: {
      composite: 65, confidence, confidenceTier: "VALID",
      marketStructure: 70, mtf: 100, momentum: 50, vwap: 60,
      priceAction: 40, correlation: 30, news: 20,
    },
    regime: { regime: "TREND_UP" },
    plan: verdict === "WAIT" ? null : {
      entry: 1.0825, stopLoss: 1.0810, tp1: 1.0855, rr1: 2.0,
    },
    news: { breakingActive: false, breakingScore: 0 },
    risk: { reasons: [] },
  };
}

async function main() {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("v3.5.6 — Self-Measurement Module Tests");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // ────────────────────────────────────────────────────────────────────────
  // TEST 1: verdict_log.jsonl is written correctly on verdict generation
  // ────────────────────────────────────────────────────────────────────────
  await test("1. verdict written to JSONL with all required fields", async () => {
    const dir = await tmpDir();
    setLogPath(path.join(dir, "verdict_log.jsonl"));

    const pair = makeSyntheticPair("EURUSD", "BUY", 67);
    const rec = buildRecord(pair)!;
    assert.ok(rec, "buildRecord should succeed");
    const ok = await appendVerdict(rec);
    assert.equal(ok, true, "appendVerdict must succeed");

    const all = await readAllVerdicts();
    assert.equal(all.length, 1);
    const v = all[0];
    assert.equal(v.pair, "EURUSD");
    assert.equal(v.verdict, "BUY");
    assert.equal(v.confidence, 67);
    assert.ok(v.verdictId.startsWith("EURUSD-"));
    assert.ok(["ASIA", "LDN", "NY", "OFF"].includes(v.session));
    assert.equal(v.tradePlan?.rr, 2.0);
    assert.ok(v.components.mtfAlignment === 100);
    assert.ok(typeof v.newsContext === "object");
    assert.ok("blockedBy" in v.calendarContext);
    // v3.5.6: only blockedBy is logged. nearestEventMin/Impact deferred to v3.5.7.
    assert.ok(!("nearestEventMin" in v.calendarContext),
      "nearestEventMin must NOT be logged (deferred to v3.5.7 — would be null-misleading)");
  });

  // ────────────────────────────────────────────────────────────────────────
  // TEST 2: Append-only — existing lines never mutate
  // ────────────────────────────────────────────────────────────────────────
  await test("2. append-only: line N stays byte-identical after N more writes", async () => {
    const dir = await tmpDir();
    const filePath = path.join(dir, "verdict_log.jsonl");
    setLogPath(filePath);

    // Write 5 verdicts
    const recs: VerdictRecord[] = [];
    for (let i = 0; i < 5; i++) {
      const r = buildRecord(makeSyntheticPair("EURUSD", "BUY", 60 + i))!;
      recs.push(r);
      await appendVerdict(r);
    }
    const after5 = await fs.readFile(filePath, "utf8");
    const linesAfter5 = after5.split("\n").filter(Boolean);

    // Write 5 more
    for (let i = 0; i < 5; i++) {
      const r = buildRecord(makeSyntheticPair("USDJPY", "SELL", 70 + i))!;
      await appendVerdict(r);
    }
    const after10 = await fs.readFile(filePath, "utf8");
    const linesAfter10 = after10.split("\n").filter(Boolean);

    assert.equal(linesAfter10.length, 10, `should have 10 lines, got ${linesAfter10.length}`);
    // First 5 lines must be byte-identical
    for (let i = 0; i < 5; i++) {
      assert.equal(linesAfter10[i], linesAfter5[i],
        `line ${i} mutated: \n  before: ${linesAfter5[i]}\n  after:  ${linesAfter10[i]}`);
    }
    // File grew, didn't shrink
    assert.ok(after10.length > after5.length);
  });

  // ────────────────────────────────────────────────────────────────────────
  // TEST 3: outcome_tracker computes TP/SL hits accurately
  // ────────────────────────────────────────────────────────────────────────
  await test("3. computeOutcome detects TP, SL, MFE, MAE from M5 candles", async () => {
    // BUY EURUSD entry=1.0825, sl=1.0810 (15 pips), tp=1.0855 (30 pips)
    const verdict: VerdictRecord = {
      ts: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),  // 3h ago
      version: "3.5.6", pair: "EURUSD", verdict: "BUY",
      confidence: 65, composite: 65,
      components: {} as any,
      tradePlan: { entry: 1.0825, sl: 1.0810, tp: 1.0855, rr: 2.0 },
      priceAtVerdict: 1.0825, tier: "VALID",
      verdictId: "EURUSD-test-1", session: "NY",
      newsContext: { breakingActive: false, breakingScore: 0, msidActive: false },
      calendarContext: { blockedBy: null },
    };
    const verdictMs = Date.parse(verdict.ts);
    // Candles: price ranges up to 1.0860 (TP hit at candle 3) but also dips to 1.0815 first
    const candles: M5Candle[] = [
      { ts: verdictMs +  5*60000, open: 1.0825, high: 1.0830, low: 1.0815, close: 1.0820 },
      { ts: verdictMs + 10*60000, open: 1.0820, high: 1.0840, low: 1.0818, close: 1.0838 },
      { ts: verdictMs + 15*60000, open: 1.0838, high: 1.0860, low: 1.0835, close: 1.0855 },
      { ts: verdictMs + 20*60000, open: 1.0855, high: 1.0858, low: 1.0850, close: 1.0852 },
    ];
    const out = computeOutcome(verdict, candles, Date.now(), 0.0001);
    assert.equal(out.tp_hit, true, "TP=1.0855 should be hit (high reached 1.0860)");
    assert.equal(out.sl_hit, false, "SL=1.0810 should NOT be hit (low only 1.0815)");
    assert.equal(out.outcome_status, "TP");
    assert.ok(out.max_favorable === 1.0860, `MFE expected 1.0860, got ${out.max_favorable}`);
    assert.ok(out.max_adverse === 1.0815, `MAE expected 1.0815, got ${out.max_adverse}`);
    assert.ok(out.tp_hit_at !== null);

    // Now SELL with SL hit
    const sellVerdict: VerdictRecord = {
      ...verdict, verdictId: "EURUSD-test-2", verdict: "SELL",
      tradePlan: { entry: 1.0825, sl: 1.0840, tp: 1.0795, rr: 2.0 },
    };
    const sellCandles: M5Candle[] = [
      { ts: verdictMs +  5*60000, open: 1.0825, high: 1.0845, low: 1.0820, close: 1.0843 },
    ];
    const sellOut = computeOutcome(sellVerdict, sellCandles, Date.now(), 0.0001);
    assert.equal(sellOut.sl_hit, true, "SHORT SL=1.0840 hit when high=1.0845");
    assert.equal(sellOut.outcome_status, "SL");
  });

  // ────────────────────────────────────────────────────────────────────────
  // TEST 4: /api/performance returns correct hit-rate
  // ────────────────────────────────────────────────────────────────────────
  await test("4. aggregate() returns correct win-rate by pair / confidence / session", async () => {
    const dir = await tmpDir();
    setLogPath(path.join(dir, "verdict_log.jsonl"));
    setOutcomePath(path.join(dir, "outcome_log.jsonl"));
    clearPerformanceCache();

    // Synthesize 4 BUY verdicts, 2 win, 1 loss, 1 expired
    const baseTs = Date.now() - 6 * 3600 * 1000;
    const verdicts: VerdictRecord[] = [];
    for (let i = 0; i < 4; i++) {
      verdicts.push({
        ts: new Date(baseTs + i * 1000).toISOString(),
        version: "3.5.6", pair: i < 2 ? "EURUSD" : "GBPUSD", verdict: "BUY",
        confidence: 65 + i * 5,    // 65, 70, 75, 80
        composite: 70,
        components: {} as any,
        tradePlan: { entry: 1.0, sl: 0.99, tp: 1.02, rr: 2.0 },
        priceAtVerdict: 1.0, tier: "VALID",
        verdictId: `V-${i}`, session: "NY",
        newsContext: { breakingActive: false, breakingScore: 0, msidActive: false },
        calendarContext: { blockedBy: null },
      });
    }
    for (const v of verdicts) await appendVerdict(v);

    // Outcomes: V-0 TP, V-1 TP, V-2 SL, V-3 EXPIRED
    const statuses: Array<"TP" | "SL" | "EXPIRED"> = ["TP", "TP", "SL", "EXPIRED"];
    for (let i = 0; i < 4; i++) {
      await appendOutcome({
        verdictId: `V-${i}`, verdict_ts: verdicts[i].ts,
        checked_at: new Date().toISOString(),
        hours_elapsed: 6, checkpoint: "4h",
        price_now: 1.01, tp_hit: statuses[i] === "TP", sl_hit: statuses[i] === "SL",
        tp_hit_at: statuses[i] === "TP" ? new Date().toISOString() : null,
        sl_hit_at: statuses[i] === "SL" ? new Date().toISOString() : null,
        max_favorable: 1.02, max_adverse: 0.99, current_pnl_pips: 0,
        outcome_status: statuses[i],
      });
    }

    const allV = await readAllVerdicts();
    const allO = await readAllOutcomes();
    const report = aggregate(allV, allO);

    assert.equal(report.totalVerdicts, 4);
    assert.equal(report.buyCount, 4);
    assert.equal(report.closed, 4);
    assert.equal(report.wins, 2);
    assert.equal(report.losses, 1);
    assert.equal(report.expired, 1);
    // win-rate excludes expired: 2/(2+1) = 0.6667
    assert.ok(Math.abs(report.winRate - (2/3)) < 0.001, `winRate=${report.winRate}`);

    // by pair
    assert.equal(report.byPair.EURUSD.wins, 2);
    assert.equal(report.byPair.EURUSD.losses, 0);
    assert.equal(report.byPair.GBPUSD.wins, 0);
    assert.equal(report.byPair.GBPUSD.losses, 1);

    // by confidence band
    assert.equal(report.byConfidenceBand["60-70"]?.total, 1);  // V-0 conf 65
    assert.equal(report.byConfidenceBand["70-80"]?.total, 2);  // V-1 (70), V-2 (75)
    assert.equal(report.byConfidenceBand["80+"]?.total, 1);    // V-3 (80)
  });

  // ────────────────────────────────────────────────────────────────────────
  // TEST 5: Resilience triple — missing file, malformed line, missed cron
  // ────────────────────────────────────────────────────────────────────────
  await test("5a. missing verdict_log.jsonl → readAllVerdicts returns []", async () => {
    const dir = await tmpDir();
    setLogPath(path.join(dir, "does-not-exist.jsonl"));
    const all = await readAllVerdicts();
    assert.equal(all.length, 0);
  });

  await test("5b. malformed line in log → skipped without crash", async () => {
    const dir = await tmpDir();
    const filePath = path.join(dir, "verdict_log.jsonl");
    setLogPath(filePath);
    // Write valid line + malformed line + valid line
    const v1 = buildRecord(makeSyntheticPair("EURUSD", "BUY", 65))!;
    await appendVerdict(v1);
    await fs.appendFile(filePath, "{this is not valid json\n", "utf8");
    const v2 = buildRecord(makeSyntheticPair("GBPUSD", "SELL", 70))!;
    await appendVerdict(v2);
    const all = await readAllVerdicts();
    assert.equal(all.length, 2, `expected 2 valid records (malformed skipped), got ${all.length}`);
    assert.equal(all[0].pair, "EURUSD");
    assert.equal(all[1].pair, "GBPUSD");
  });

  await test("5c. selectOpenVerdicts: missed cron 24h → still re-checks OPEN verdicts", async () => {
    // Verdict from 12h ago, latest outcome 8h ago = OPEN; no new check despite gap
    const v: VerdictRecord = {
      ts: new Date(Date.now() - 12 * 3600 * 1000).toISOString(),
      version: "3.5.6", pair: "EURUSD", verdict: "BUY",
      confidence: 65, composite: 70, components: {} as any,
      tradePlan: { entry: 1.0, sl: 0.99, tp: 1.02, rr: 2.0 },
      priceAtVerdict: 1.0, tier: "VALID", verdictId: "V-old",
      session: "NY",
      newsContext: { breakingActive: false, breakingScore: 0, msidActive: false },
      calendarContext: { blockedBy: null },
    };
    const o: OutcomeRecord = {
      verdictId: "V-old", verdict_ts: v.ts,
      checked_at: new Date(Date.now() - 8 * 3600 * 1000).toISOString(),
      hours_elapsed: 4, checkpoint: "4h",
      price_now: 1.005, tp_hit: false, sl_hit: false,
      tp_hit_at: null, sl_hit_at: null,
      max_favorable: 1.01, max_adverse: 0.995, current_pnl_pips: 5,
      outcome_status: "OPEN",
    };
    const open = selectOpenVerdicts([v], [o], Date.now());
    assert.equal(open.length, 1, "missed-cron OPEN verdict must still be re-tracked");
  });

  // ────────────────────────────────────────────────────────────────────────
  // TEST 6: Idempotency — fs.appendFile, no overwrite
  // ────────────────────────────────────────────────────────────────────────
  await test("6. multiple appends produce N lines, not 1 overwritten line", async () => {
    const dir = await tmpDir();
    const filePath = path.join(dir, "verdict_log.jsonl");
    setLogPath(filePath);
    for (let i = 0; i < 12; i++) {
      const r = buildRecord(makeSyntheticPair("EURUSD", "BUY", 60 + (i % 5)))!;
      await appendVerdict(r);
    }
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    assert.equal(lines.length, 12, `expected 12 lines, got ${lines.length} (overwrite bug?)`);
    // Each line is independently valid JSON
    for (const l of lines) JSON.parse(l);
  });

  // ────────────────────────────────────────────────────────────────────────
  // TEST 7: Concurrency — 8 simultaneous verdicts (NFP burst) all write
  // ────────────────────────────────────────────────────────────────────────
  await test("7. 8 concurrent appendVerdict() calls produce 8 valid JSON lines", async () => {
    const dir = await tmpDir();
    const filePath = path.join(dir, "verdict_log.jsonl");
    setLogPath(filePath);
    const PAIRS = ["EURUSD","GBPUSD","USDJPY","AUDUSD","USDCAD","USDCHF","XAUUSD"];
    await Promise.all(PAIRS.map(p => {
      const r = buildRecord(makeSyntheticPair(p, "BUY", 65))!;
      return appendVerdict(r);
    }));
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    assert.equal(lines.length, 8, `expected 8 lines from concurrent burst, got ${lines.length}`);
    const seenPairs = new Set<string>();
    for (const l of lines) {
      const obj = JSON.parse(l);
      seenPairs.add(obj.pair);
    }
    assert.equal(seenPairs.size, 8, `expected 8 unique pairs, got ${seenPairs.size}`);
  });

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`v3.5.6 MEASUREMENT SUMMARY: ${pass} passed, ${fail} failed`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  if (fail > 0) process.exit(1);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
