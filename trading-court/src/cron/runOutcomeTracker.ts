// ============================================================================
// v3.5.6 — Outcome Tracker Cron Runner
//
// Runs the outcome tracker once and exits. Wire to cron:
//   0 */4 * * *  cd /path/to/trading-court-pro && node dist/cron/runOutcomeTracker.js
//
// Or via systemd timer / pm2 cron. The script:
//   - reads verdict_log.jsonl
//   - reads outcome_log.jsonl (latest per verdict)
//   - selects open verdicts (BUY/SELL not yet TP/SL/EXPIRED)
//   - fetches M5 candles sequentially with 1.5s delay
//   - appends one outcome record per verdict
//   - prints a summary
//
// Exits with code 0 always (cron must not page on transient fetch failures).
// ============================================================================
import { runOutcomeTracker } from "../measurement/outcomeTracker.js";

async function main() {
  const start = Date.now();
  console.log(`[tracker] starting at ${new Date(start).toISOString()}`);
  try {
    const summary = await runOutcomeTracker();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[tracker] done in ${elapsed}s — checked=${summary.checked} closed=${summary.closed} expired=${summary.expired} failed=${summary.failed} skipped=${summary.skippedOverCap}`);
  } catch (err: any) {
    console.error(`[tracker] FATAL: ${err?.message ?? err}`);
    // Still exit 0 — cron should not retry storm
  }
  process.exit(0);
}

main();
