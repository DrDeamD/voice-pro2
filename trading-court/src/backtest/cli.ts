// ============================================================================
// Backtest CLI — v3.8
//
// Usage:
//   npm run backtest -- --pair EURUSD --csv ./data/EURUSD --from 2026-04-01 --to 2026-04-30
//   npm run backtest -- --pair XAUUSD --csv ./data/XAUUSD/HISTDATA_M1.csv
//
// Options:
//   --pair <SYMBOL>    Required. One of: EURUSD, GBPUSD, USDJPY, AUDUSD,
//                      USDCAD, USDCHF, XAUUSD
//   --csv <PATH>       Required. CSV file or directory of monthly CSVs in
//                      HistData M1 format (YYYYMMDD HHMMSS;O;H;L;C;V).
//   --from <ISO>       Optional. Start date filter (e.g. 2026-04-01).
//   --to <ISO>         Optional. End date filter.
//   --step <N>         Replay every Nth M1 bar. Default 15 (=15min decisions).
//   --warmup <N>       M1 bars to skip at start. Default 1500.
//   --hold <N>         Max M1 bars to hold each trade. Default 720 (12h).
//   --out <PATH>       Optional. Write full records JSON to this path.
//
// Output:
//   - Console table with calibration summary (per composite bin).
//   - Optional JSON dump of every verdict record (when --out provided).
//
// Exit codes:
//   0 = success
//   1 = invalid arguments / no data found
//   2 = internal error during replay
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { loadHistdataM1, buildSeriesFromM1 } from "./loadHistdata.js";
import { replayBacktest } from "./replay.js";
import { calibrate } from "./calibrate.js";

interface ParsedArgs {
  pair: string;
  csv: string;
  from?: string;
  to?: string;
  step: number;
  warmup: number;
  hold: number;
  out?: string;
}

function parseArgs(argv: string[]): ParsedArgs | null {
  const out: Partial<ParsedArgs> = { step: 15, warmup: 1500, hold: 720 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--pair":   out.pair = next(); break;
      case "--csv":    out.csv = next(); break;
      case "--from":   out.from = next(); break;
      case "--to":     out.to = next(); break;
      case "--step":   out.step = Number(next()); break;
      case "--warmup": out.warmup = Number(next()); break;
      case "--hold":   out.hold = Number(next()); break;
      case "--out":    out.out = next(); break;
      case "-h":
      case "--help":
        return null;
    }
  }
  if (!out.pair || !out.csv) return null;
  if (!Number.isFinite(out.step) || out.step! < 1) out.step = 15;
  if (!Number.isFinite(out.warmup) || out.warmup! < 0) out.warmup = 1500;
  if (!Number.isFinite(out.hold) || out.hold! < 1) out.hold = 720;
  return out as ParsedArgs;
}

function printHelp(): void {
  console.log(`
Trading Court Backtest CLI v3.8

Usage:
  npm run backtest -- --pair <SYMBOL> --csv <PATH> [options]

Required:
  --pair <SYMBOL>    EURUSD | GBPUSD | USDJPY | AUDUSD |
                     USDCAD | USDCHF | XAUUSD
  --csv <PATH>       HistData M1 CSV file or directory of monthlies

Optional:
  --from <ISO>       Start date filter (e.g. 2026-04-01)
  --to <ISO>         End date filter
  --step <N>         Decision interval in M1 bars (default 15 = 15min)
  --warmup <N>       Skip leading bars for indicator warmup (default 1500)
  --hold <N>         Max bars per trade for outcome scan (default 720 = 12h)
  --out <PATH>       Write full records JSON to this path

Example:
  npm run backtest -- --pair EURUSD --csv ./data/EURUSD --from 2026-04-01

HistData download (free, no key):
  https://www.histdata.com/download-free-forex-historical-data/?/ascii/1-minute-bar-quotes/eurusd
`);
}

function fmtPct(n: number | null): string {
  if (n == null) return "  n/a";
  return (n * 100).toFixed(1).padStart(5, " ") + "%";
}
function fmtNum(n: number | null, w = 6): string {
  if (n == null) return "n/a".padStart(w, " ");
  return n.toFixed(1).padStart(w, " ");
}
function fmtInt(n: number, w = 5): string {
  return String(n).padStart(w, " ");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    printHelp();
    return 1;
  }

  const symbol = args.pair.toUpperCase();
  console.log(`\n[backtest] symbol=${symbol}  csv=${args.csv}  from=${args.from ?? "all"}  to=${args.to ?? "all"}`);
  console.log(`[backtest] step=${args.step}m  warmup=${args.warmup} bars  hold=${args.hold} bars\n`);

  // --- Load M1 ----------------------------------------------------------
  let m1;
  try {
    m1 = await loadHistdataM1({
      pathOrDir: args.csv,
      fromUtc: args.from,
      toUtc: args.to,
    });
  } catch (err) {
    console.error(`[error] failed to load CSV: ${(err as Error).message}`);
    return 1;
  }
  if (m1.length < args.warmup + 100) {
    console.error(`[error] only ${m1.length} M1 bars after filter; need at least ${args.warmup + 100}`);
    return 1;
  }
  const tFirst = new Date(m1[0].t * 1000).toISOString();
  const tLast = new Date(m1[m1.length - 1].t * 1000).toISOString();
  console.log(`[loaded] ${m1.length} M1 bars  (${tFirst} → ${tLast})`);

  // Quick sanity report on resampled timeframes.
  const series = buildSeriesFromM1(m1);
  for (const tf of ["5m", "15m", "1h", "4h", "1d"]) {
    console.log(`[resample] ${tf.padEnd(4)} → ${String(series[tf].candles.length).padStart(5, " ")} candles`);
  }
  console.log("");

  // --- Replay -----------------------------------------------------------
  let records;
  try {
    records = await replayBacktest({
      symbol,
      m1,
      stepM1: args.step,
      warmupM1: args.warmup,
      holdMaxBars: args.hold,
    });
  } catch (err) {
    console.error(`[error] replay failed: ${(err as Error).message}`);
    if ((err as Error).stack) console.error((err as Error).stack);
    return 2;
  }
  console.log(`[replay] produced ${records.length} verdict records\n`);

  // --- Calibrate --------------------------------------------------------
  const report = calibrate(symbol, records);

  // --- Print summary tables --------------------------------------------
  console.log("─── Overall ─────────────────────────────────────────────────");
  console.log(`  Records: ${report.totalRecords}    Trades: ${report.totalTrades}`);
  console.log(`  Wins:    ${fmtInt(report.overall.wins)}    Losses: ${fmtInt(report.overall.losses)}    Timeouts: ${fmtInt(report.overall.timeouts)}`);
  console.log(`  Win-rate: ${fmtPct(report.overall.winRate)}    Net pips: ${fmtNum(report.overall.netPips, 8)}    Expectancy: ${fmtNum(report.overall.expectancy, 6)} pips/trade`);
  console.log("");

  console.log("─── By |composite| bin ──────────────────────────────────────");
  console.log("  bin       count  trades   wins   loss timeout  winRate   netPips   exp/tr");
  for (const s of report.byCompositeBin) {
    const label = s.bin.hiAbs >= 200
      ? `≥${String(s.bin.loAbs).padStart(3, " ")}    `
      : `${String(s.bin.loAbs).padStart(3, " ")}–${String(s.bin.hiAbs).padStart(3, " ")} `;
    console.log(
      `  ${label}  ${fmtInt(s.count)}  ${fmtInt(s.trades)}  ${fmtInt(s.wins)}  ${fmtInt(s.losses)}  ${fmtInt(s.timeouts)}   ${fmtPct(s.winRate)}  ${fmtNum(s.netPips, 8)}   ${fmtNum(s.expectancy, 6)}`,
    );
  }
  console.log("");

  console.log("─── By verdict ──────────────────────────────────────────────");
  for (const v of ["BUY", "SELL", "WAIT"] as const) {
    const s = report.byVerdict[v];
    console.log(`  ${v.padEnd(4)}  count=${fmtInt(s.count)}  trades=${fmtInt(s.trades)}  win-rate=${fmtPct(s.winRate)}  net=${fmtNum(s.netPips, 8)}`);
  }
  console.log("");

  console.log("─── By confidence tier ──────────────────────────────────────");
  for (const tier of Object.keys(report.byConfidenceTier).sort()) {
    const s = report.byConfidenceTier[tier];
    console.log(`  ${tier.padEnd(10)} count=${fmtInt(s.count)}  trades=${fmtInt(s.trades)}  win-rate=${fmtPct(s.winRate)}  net=${fmtNum(s.netPips, 8)}`);
  }
  console.log("");

  console.log("─── Notes ───────────────────────────────────────────────────");
  for (const n of report.notes) console.log(`  • ${n}`);
  console.log("");

  // --- Optional JSON dump ----------------------------------------------
  if (args.out) {
    const outDir = path.dirname(args.out);
    if (outDir && outDir !== ".") {
      await fs.promises.mkdir(outDir, { recursive: true });
    }
    const payload = {
      symbol,
      generatedUtc: new Date().toISOString(),
      input: {
        csv: args.csv,
        from: args.from ?? null,
        to: args.to ?? null,
        step: args.step,
        warmup: args.warmup,
        hold: args.hold,
      },
      m1Count: m1.length,
      m1RangeUtc: { first: tFirst, last: tLast },
      report,
      records,
    };
    await fs.promises.writeFile(args.out, JSON.stringify(payload, null, 2));
    console.log(`[written] full results → ${args.out}`);
  }

  return 0;
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error(`[fatal] ${(err as Error).message}`);
    if ((err as Error).stack) console.error((err as Error).stack);
    process.exit(2);
  });
