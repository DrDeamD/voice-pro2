// ============================================================================
// v4.0 priority 2-alt — Baseline runner (synthetic data)
//
// Runs replayBacktest on the three pairs 2M asked about (EURUSD, GBPUSD,
// USDJPY) using 60 days of synthetic M1 candles, and produces the four
// metrics requested:
//   1. Number of verdicts issued
//   2. Distribution (BUY/SELL/WAIT)
//   3. WAIT rate
//   4. |composite| distribution — does it reach >= 50?
//
// HONEST LIMITATIONS (must be repeated to user):
//   - Synthetic data, not real market history
//   - News/calendar/context all stubbed (Phase 1 limitation of replay.ts)
//   - The verdict distribution depends on regime mix; synthetic regime mix
//     may not match real market over the same period
//   - Composite distribution IS reliable (math doesn't depend on data origin)
//
// What this DOES tell us:
//   - Whether |composite| can mathematically reach >= 50 with current weights
//   - Whether the risk-gate logic systematically rejects setups even with
//     no calendar/news interference (backtestMode=true skips those gates)
//   - Whether v36 statistical layer fires "garch_unstable / mean_reverting"
//     on technically clean trending data
//
// What this does NOT tell us:
//   - The real BUY/SELL ratio expected on actual EURUSD over the next 60 days
//   - Win-rate (synthetic data has no realistic edge structure)
//   - Whether risk-gate rejections in Live (which include news vetoes) match
//     this baseline
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { loadHistdataM1 } from "../backtest/loadHistdata.js";
import { replayBacktest, type BacktestVerdictRecord } from "../backtest/replay.js";

interface Metrics {
  symbol: string;
  totalVerdicts: number;
  byVerdict: Record<string, number>;
  waitRatePct: number;
  compositeStats: {
    min: number; max: number; mean: number; stdev: number;
    p50: number; p90: number; p95: number; p99: number;
    countAbs50plus: number;
    countAbs70plus: number;
  };
  reasonHistogram: Record<string, number>;
  outcomeOnTrades: { wins: number; losses: number; timeouts: number };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(sorted.length * q);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function computeMetrics(symbol: string, records: BacktestVerdictRecord[]): Metrics {
  const byVerdict: Record<string, number> = {};
  for (const r of records) {
    byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
  }
  const waitCount = byVerdict["WAIT"] ?? 0;
  const waitRatePct = records.length > 0 ? (waitCount / records.length) * 100 : 0;

  const composites = records.map(r => Math.abs(r.composite ?? 0));
  composites.sort((a, b) => a - b);
  const sum = composites.reduce((s, x) => s + x, 0);
  const mean = composites.length ? sum / composites.length : 0;
  const variance = composites.length
    ? composites.reduce((s, x) => s + (x - mean) ** 2, 0) / composites.length
    : 0;
  const stdev = Math.sqrt(variance);

  const reasonHistogram: Record<string, number> = {};
  for (const r of records) {
    for (const reason of r.riskReasons ?? []) {
      // Normalize reasons: strip numeric suffixes for grouping
      const normalized = reason
        .replace(/\d+/g, "N")
        .replace(/below threshold.*/, "below threshold")
        .replace(/below floor.*/, "below floor")
        .replace(/below minimum.*/, "below minimum")
        .replace(/_\d+$/, "_N");
      reasonHistogram[normalized] = (reasonHistogram[normalized] ?? 0) + 1;
    }
  }

  const outcomeOnTrades = { wins: 0, losses: 0, timeouts: 0 };
  for (const r of records) {
    if (r.outcome === "WIN") outcomeOnTrades.wins++;
    else if (r.outcome === "LOSS") outcomeOnTrades.losses++;
    else if (r.outcome === "TIMEOUT") outcomeOnTrades.timeouts++;
  }

  return {
    symbol,
    totalVerdicts: records.length,
    byVerdict,
    waitRatePct,
    compositeStats: {
      min: composites[0] ?? 0,
      max: composites[composites.length - 1] ?? 0,
      mean,
      stdev,
      p50: quantile(composites, 0.50),
      p90: quantile(composites, 0.90),
      p95: quantile(composites, 0.95),
      p99: quantile(composites, 0.99),
      countAbs50plus: composites.filter(c => c >= 50).length,
      countAbs70plus: composites.filter(c => c >= 70).length,
    },
    reasonHistogram,
    outcomeOnTrades,
  };
}

function formatTable(metrics: Metrics[]): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("=".repeat(80));
  lines.push("  v4.0 Priority 2-alt — Synthetic-data Baseline");
  lines.push(`  60 days M1, 3 pairs, replay step 15min, warmup 1500 bars, hold 720 bars`);
  lines.push(`  Backtest framework: news/calendar/context stubbed`);
  lines.push("=".repeat(80));

  for (const m of metrics) {
    lines.push("");
    lines.push(`### ${m.symbol}`);
    lines.push("-".repeat(60));
    lines.push(`Total verdicts:        ${m.totalVerdicts}`);
    lines.push("Verdict distribution:");
    for (const [v, n] of Object.entries(m.byVerdict).sort()) {
      const pct = (n / m.totalVerdicts * 100).toFixed(1);
      lines.push(`  ${v.padEnd(10)} ${String(n).padStart(6)}  (${pct}%)`);
    }
    lines.push(`WAIT rate:             ${m.waitRatePct.toFixed(1)}%`);
    lines.push("");
    lines.push("|composite| distribution:");
    lines.push(`  min  / max:           ${m.compositeStats.min.toFixed(1)}  /  ${m.compositeStats.max.toFixed(1)}`);
    lines.push(`  mean (stdev):         ${m.compositeStats.mean.toFixed(1)}  (${m.compositeStats.stdev.toFixed(1)})`);
    lines.push(`  median (p50):         ${m.compositeStats.p50.toFixed(1)}`);
    lines.push(`  p90 / p95 / p99:      ${m.compositeStats.p90.toFixed(1)}  /  ${m.compositeStats.p95.toFixed(1)}  /  ${m.compositeStats.p99.toFixed(1)}`);
    lines.push(`  count >= 50:          ${m.compositeStats.countAbs50plus}  (${(m.compositeStats.countAbs50plus / m.totalVerdicts * 100).toFixed(2)}%)`);
    lines.push(`  count >= 70:          ${m.compositeStats.countAbs70plus}  (${(m.compositeStats.countAbs70plus / m.totalVerdicts * 100).toFixed(2)}%)`);
    lines.push("");

    if (m.outcomeOnTrades.wins + m.outcomeOnTrades.losses + m.outcomeOnTrades.timeouts > 0) {
      const total = m.outcomeOnTrades.wins + m.outcomeOnTrades.losses + m.outcomeOnTrades.timeouts;
      lines.push(`Outcomes on issued trades (BUY/SELL only):`);
      lines.push(`  WIN:     ${m.outcomeOnTrades.wins}  (${(m.outcomeOnTrades.wins/total*100).toFixed(1)}%)`);
      lines.push(`  LOSS:    ${m.outcomeOnTrades.losses}  (${(m.outcomeOnTrades.losses/total*100).toFixed(1)}%)`);
      lines.push(`  TIMEOUT: ${m.outcomeOnTrades.timeouts}  (${(m.outcomeOnTrades.timeouts/total*100).toFixed(1)}%)`);
    } else {
      lines.push("Outcomes on issued trades: NONE — no BUY/SELL verdicts");
    }
    lines.push("");

    lines.push("Top 12 risk-gate rejection reasons:");
    const reasons = Object.entries(m.reasonHistogram).sort((a, b) => b[1] - a[1]).slice(0, 12);
    for (const [reason, n] of reasons) {
      lines.push(`  ${String(n).padStart(6)}  ${reason}`);
    }
  }

  // Cross-pair summary
  lines.push("");
  lines.push("=".repeat(80));
  lines.push("  CROSS-PAIR ANSWER TO 2M's QUESTION");
  lines.push("=".repeat(80));
  const totalVerdicts = metrics.reduce((s, m) => s + m.totalVerdicts, 0);
  const totalAbs50 = metrics.reduce((s, m) => s + m.compositeStats.countAbs50plus, 0);
  const totalAbs70 = metrics.reduce((s, m) => s + m.compositeStats.countAbs70plus, 0);
  const maxComposite = Math.max(...metrics.map(m => m.compositeStats.max));
  lines.push("");
  lines.push(`Total verdicts across 3 pairs:           ${totalVerdicts}`);
  lines.push(`Verdicts with |composite| >= 50:         ${totalAbs50}  (${(totalAbs50/totalVerdicts*100).toFixed(2)}%)`);
  lines.push(`Verdicts with |composite| >= 70:         ${totalAbs70}  (${(totalAbs70/totalVerdicts*100).toFixed(2)}%)`);
  lines.push(`Max |composite| observed in 60 days:     ${maxComposite.toFixed(1)}`);
  lines.push("");
  lines.push("Discovery B — engine weights cap composite — verdict:");
  if (maxComposite < 50) {
    lines.push("  CONFIRMED. |composite| never reached 50 across 60 days × 3 pairs.");
    lines.push("  Engine weights re-calibration is mathematically required.");
  } else if (maxComposite < 70) {
    lines.push("  PARTIALLY CONFIRMED. |composite| can reach 50 occasionally");
    lines.push("  but never 70 (the threshold needed for v36 confidence >= 77).");
    lines.push("  Re-calibration recommended but not strictly mandatory.");
  } else {
    lines.push("  REFUTED. |composite| does reach 70+ on the strongest setups.");
    lines.push("  No re-calibration needed; the bottleneck is elsewhere.");
  }
  lines.push("");

  return lines.join("\n");
}

async function main() {
  const dataDir = path.resolve(process.cwd(), "data", "synthetic");
  const pairs = ["EURUSD", "GBPUSD", "USDJPY"];

  const allMetrics: Metrics[] = [];
  for (const pair of pairs) {
    const csv = path.join(dataDir, `${pair}.csv`);
    if (!fs.existsSync(csv)) {
      console.error(`Missing: ${csv}`);
      process.exit(1);
    }
    process.stderr.write(`Replaying ${pair}... `);
    const m1 = await loadHistdataM1({ pathOrDir: csv });
    process.stderr.write(`${m1.length} M1 bars... `);
    const records = await replayBacktest({
      symbol: pair,
      m1,
      stepM1: 15,
      warmupM1: 1500,
      holdMaxBars: 720,
    });
    process.stderr.write(`${records.length} verdicts.\n`);
    const m = computeMetrics(pair, records);
    allMetrics.push(m);

    // Persist records for inspection
    const outPath = path.join(dataDir, `${pair}-verdicts.json`);
    fs.writeFileSync(outPath, JSON.stringify(records, null, 2), "utf8");
  }

  console.log(formatTable(allMetrics));

  // Persist summary
  const summary = path.join(dataDir, "baseline-summary.json");
  fs.writeFileSync(summary, JSON.stringify(allMetrics, null, 2), "utf8");
  process.stderr.write(`\nFull records → ${dataDir}/${pairs.map(p => `${p}-verdicts.json`).join(", ")}\n`);
  process.stderr.write(`Summary    → ${summary}\n`);
}

main().catch(e => {
  console.error("FATAL:", e);
  process.exit(2);
});
