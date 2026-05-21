// ============================================================================
// Calibration CLI — v3.10
//
// Usage:
//   # Single symbol, from a backtest --out file (Phase 1 / offline)
//   npm run calibrate -- --pair EURUSD --records ./results/eurusd.json
//
//   # Multiple symbols at once (records dir of *.json files; pair inferred
//   # from each file's `symbol` field)
//   npm run calibrate -- --batch ./results/
//
//   # v3.10 — from live journal (verdict_log.jsonl + outcome_log.jsonl)
//   npm run calibrate -- --from-journal --pair EURUSD
//   npm run calibrate -- --from-journal           # all symbols in journal
//   npm run calibrate -- --from-journal --pair EURUSD --from 2026-04-01
//
//   # Print existing registry without modifying
//   npm run calibrate -- --show
//
//   # Remove a symbol (revert to heuristic)
//   npm run calibrate -- --remove EURUSD
//
// The CLI updates src/calibration/calibrationData.json in place. After
// running, rebuild with `npm run build` for the new calibration to take
// effect in the deployed worker.
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { CalibrationData } from "./types.js";
import { buildCalibrationFromRecords } from "./buildCalibration.js";
import { buildRecordsFromJournal, buildRecordsBySymbol } from "./fromJournal.js";

interface Args {
  pair?: string;
  records?: string;
  batch?: string;
  remove?: string;
  show?: boolean;
  fromJournal?: boolean;
  from?: string;
  to?: string;
}

function parseArgs(argv: string[]): Args | null {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--pair":         out.pair = next(); break;
      case "--records":      out.records = next(); break;
      case "--batch":        out.batch = next(); break;
      case "--remove":       out.remove = next(); break;
      case "--show":         out.show = true; break;
      case "--from-journal": out.fromJournal = true; break;
      case "--from":         out.from = next(); break;
      case "--to":           out.to = next(); break;
      case "-h":
      case "--help":
        return null;
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`
Trading Court Calibration CLI v3.10

Builds the empirical confidence calibration registry from backtest results
or from the live verdict/outcome journal.

Usage:
  npm run calibrate -- --pair <SYMBOL> --records <PATH>
      Update calibration for one symbol from a single backtest JSON file.

  npm run calibrate -- --batch <DIR>
      Update calibration for every *.json file in a directory.

  npm run calibrate -- --from-journal [--pair <SYMBOL>] [--from ISO] [--to ISO]
      v3.10 — Update calibration from the LIVE journal (verdict_log.jsonl +
      outcome_log.jsonl). Without --pair, processes every symbol that has
      ready outcomes. The journal is the post-deployment source of truth;
      this is how calibration drifts from backtest baseline toward
      production reality.

  npm run calibrate -- --show
      Print the current calibration registry (do not modify).

  npm run calibrate -- --remove <SYMBOL>
      Remove calibration for a symbol — reverts that symbol to the
      heuristic confidence.

Workflow (offline / Phase 1):
  1. npm run backtest -- --pair EURUSD --csv ./data/EURUSD --out ./results/eurusd.json
  2. npm run calibrate -- --pair EURUSD --records ./results/eurusd.json
  3. npm run build && deploy

Workflow (live / Phase 3):
  1. Deploy the system; let it run, accumulating verdict_log.jsonl
  2. Run the outcome tracker periodically: npm run tracker:run
  3. After ≥200 trades have terminal outcomes:
       npm run calibrate -- --from-journal --pair EURUSD
       npm run build && redeploy
  4. Repeat (3) on a calendar (weekly/monthly) — calibration tracks drift.
`);
}

function findRegistryPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let cur = here;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(cur, "src", "calibration", "calibrationData.json");
    if (fs.existsSync(candidate)) return candidate;
    cur = path.dirname(cur);
  }
  return path.join(process.cwd(), "src", "calibration", "calibrationData.json");
}

interface RegistryShape {
  $schema?: string;
  $description?: string;
  version: string;
  data: Record<string, CalibrationData>;
}

function readRegistry(file: string): RegistryShape {
  if (!fs.existsSync(file)) {
    return {
      $schema: "Trading Court calibration registry v3.9",
      version: "3.9",
      data: {},
    };
  }
  const raw = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(raw) as RegistryShape;
  if (!parsed.data || typeof parsed.data !== "object") parsed.data = {};
  if (!parsed.version) parsed.version = "3.9";
  return parsed;
}

function writeRegistry(file: string, reg: RegistryShape): void {
  fs.writeFileSync(file, JSON.stringify(reg, null, 2) + "\n", "utf8");
}

interface BacktestDump {
  symbol?: string;
  generatedUtc?: string;
  input?: { from?: string | null; to?: string | null };
  m1RangeUtc?: { first?: string; last?: string };
  records?: any[];
}

async function processFile(file: string, registry: RegistryShape, explicitPair?: string): Promise<{ symbol: string; trades: number }> {
  const raw = await fs.promises.readFile(file, "utf8");
  const dump = JSON.parse(raw) as BacktestDump;

  const symbol = (explicitPair ?? dump.symbol ?? "").toUpperCase();
  if (!symbol) {
    throw new Error(`No symbol in ${file} and --pair not supplied`);
  }
  const records = dump.records ?? [];
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`File ${file} has no records[] (run backtest --out first)`);
  }

  const data = buildCalibrationFromRecords({
    symbol,
    records,
    fromUtc: dump.input?.from ?? dump.m1RangeUtc?.first ?? null,
    toUtc: dump.input?.to ?? dump.m1RangeUtc?.last ?? null,
    notes: [
      `Built from backtest dump: ${path.basename(file)}`,
      `Source backtest generated: ${dump.generatedUtc ?? "unknown"}`,
      "Phase 1 backtest: news/calendar/macro context stubbed.",
    ],
  });

  registry.data[symbol] = data;
  return { symbol, trades: data.totalTrades };
}

function printRegistry(reg: RegistryShape): void {
  console.log("─── Calibration Registry ────────────────────────────────────");
  console.log(`  version: ${reg.version}`);
  const symbols = Object.keys(reg.data).sort();
  console.log(`  symbols: ${symbols.length}`);
  if (symbols.length === 0) {
    console.log("  (empty — all symbols using heuristic confidence)");
    return;
  }
  console.log("");
  for (const sym of symbols) {
    const d = reg.data[sym];
    const usable = d.bins.filter(b => b.trades >= 20 && b.winRate != null).length;
    console.log(`  ${sym}`);
    console.log(`    generated:   ${d.generatedUtc}`);
    console.log(`    range:       ${d.fromUtc ?? "?"} → ${d.toUtc ?? "?"}`);
    console.log(`    records:     ${d.totalRecords}`);
    console.log(`    trades:      ${d.totalTrades}`);
    console.log(`    bins (usable/total): ${usable}/${d.bins.length}`);
    console.log("    bin breakdown:");
    console.log("      bin       count  trades  wins  loss  winRate  status");
    for (const b of d.bins) {
      const label = b.hiAbs >= 200
        ? `≥${String(b.loAbs).padStart(3, " ")}    `
        : `${String(b.loAbs).padStart(3, " ")}–${String(b.hiAbs).padStart(3, " ")} `;
      const wrStr = b.winRate == null ? "  n/a" : (b.winRate * 100).toFixed(1).padStart(5, " ") + "%";
      const status = b.trades >= 20 && b.winRate != null ? "calibrated" : "heuristic";
      console.log(`      ${label}  ${String(b.count).padStart(5, " ")}  ${String(b.trades).padStart(6, " ")}  ${String(b.wins).padStart(4, " ")}  ${String(b.losses).padStart(4, " ")}  ${wrStr}   ${status}`);
    }
    console.log("");
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args || (!args.records && !args.batch && !args.show && !args.remove && !args.fromJournal)) {
    printHelp();
    return args ? 0 : 1;
  }

  const regPath = findRegistryPath();
  console.log(`[registry] ${regPath}`);

  const reg = readRegistry(regPath);

  if (args.show) {
    printRegistry(reg);
    return 0;
  }

  if (args.remove) {
    const sym = args.remove.toUpperCase();
    if (reg.data[sym]) {
      delete reg.data[sym];
      writeRegistry(regPath, reg);
      console.log(`[removed] ${sym} — reverts to heuristic confidence`);
    } else {
      console.log(`[noop] ${sym} not in registry`);
    }
    return 0;
  }

  // v3.10 — journal-driven calibration
  if (args.fromJournal) {
    if (args.pair) {
      // Single symbol mode
      const sym = args.pair.toUpperCase();
      console.log(`[from-journal] reading verdict_log + outcome_log for ${sym}...`);
      const result = await buildRecordsFromJournal({
        symbol: sym, fromUtc: args.from, toUtc: args.to,
      });
      console.log(
        `[journal-stats] verdicts=${result.totalVerdicts} outcomes=${result.totalOutcomes} ` +
        `matched(${sym})=${result.matchedVerdicts} usable=${result.records.length}`,
      );
      if (Object.keys(result.skipped).length) {
        console.log(`[journal-stats] skipped: ${JSON.stringify(result.skipped)}`);
      }
      const tradesIn = result.records.filter(r => r.verdict !== "WAIT").length;
      if (tradesIn === 0) {
        console.error(
          `[error] no trades with terminal outcomes for ${sym}. ` +
          `Run 'npm run tracker:run' to populate outcomes, or wait for live trades to terminate.`,
        );
        return 1;
      }
      const data = buildCalibrationFromRecords({
        symbol: sym,
        records: result.records,
        fromUtc: args.from ?? null,
        toUtc: args.to ?? null,
        notes: [
          `Source: live journal (verdict_log.jsonl + outcome_log.jsonl)`,
          `Total verdicts in journal: ${result.totalVerdicts}`,
          `Total outcomes in journal: ${result.totalOutcomes}`,
          `Skipped: ${JSON.stringify(result.skipped)}`,
        ],
      });
      reg.data[sym] = data;
      writeRegistry(regPath, reg);
      console.log(`[updated] ${sym} from live journal — ${data.totalTrades} trades ingested`);
      return 0;
    }
    // Multi-symbol mode — process every symbol in journal
    console.log(`[from-journal] processing all symbols in journal...`);
    const bySymbol = await buildRecordsBySymbol({
      fromUtc: args.from, toUtc: args.to,
    });
    if (Object.keys(bySymbol).length === 0) {
      console.error(`[error] no symbols found in journal. Run trades first.`);
      return 1;
    }
    let okCount = 0;
    for (const sym of Object.keys(bySymbol).sort()) {
      const records = bySymbol[sym];
      const tradesIn = records.filter(r => r.verdict !== "WAIT").length;
      if (tradesIn === 0) {
        console.log(`  - ${sym}: no terminal trades, skipping`);
        continue;
      }
      const data = buildCalibrationFromRecords({
        symbol: sym, records,
        fromUtc: args.from ?? null,
        toUtc: args.to ?? null,
        notes: [`Source: live journal (verdict_log + outcome_log)`],
      });
      reg.data[sym] = data;
      console.log(`  ✓ ${sym}: ${tradesIn} trades`);
      okCount += 1;
    }
    if (okCount > 0) {
      writeRegistry(regPath, reg);
      console.log(`[written] registry updated with ${okCount} symbol(s) from journal`);
    } else {
      console.log(`[noop] no symbols had terminal trades; registry unchanged`);
      return 1;
    }
    return 0;
  }

  if (args.records) {
    if (!fs.existsSync(args.records)) {
      console.error(`[error] file not found: ${args.records}`);
      return 1;
    }
    try {
      const r = await processFile(args.records, reg, args.pair);
      writeRegistry(regPath, reg);
      console.log(`[updated] ${r.symbol} — ${r.trades} trades ingested`);
    } catch (err) {
      console.error(`[error] ${(err as Error).message}`);
      return 1;
    }
    return 0;
  }

  if (args.batch) {
    if (!fs.existsSync(args.batch) || !fs.statSync(args.batch).isDirectory()) {
      console.error(`[error] not a directory: ${args.batch}`);
      return 1;
    }
    const files = (await fs.promises.readdir(args.batch))
      .filter(f => f.toLowerCase().endsWith(".json"))
      .map(f => path.join(args.batch!, f));
    if (files.length === 0) {
      console.error(`[error] no *.json files in ${args.batch}`);
      return 1;
    }
    let okCount = 0;
    for (const f of files) {
      try {
        const r = await processFile(f, reg);
        console.log(`  ✓ ${path.basename(f)} → ${r.symbol} (${r.trades} trades)`);
        okCount += 1;
      } catch (err) {
        console.log(`  ✗ ${path.basename(f)} — ${(err as Error).message}`);
      }
    }
    if (okCount > 0) {
      writeRegistry(regPath, reg);
      console.log(`[written] registry updated with ${okCount} symbol(s)`);
    } else {
      console.log("[noop] no successful ingests; registry unchanged");
      return 1;
    }
    return 0;
  }

  printHelp();
  return 1;
}

main()
  .then(c => process.exit(c))
  .catch(err => {
    console.error(`[fatal] ${(err as Error).message}`);
    if ((err as Error).stack) console.error((err as Error).stack);
    process.exit(2);
  });
