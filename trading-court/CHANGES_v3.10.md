# CHANGES — v3.10

**Theme:** Phase 3 — Live calibration loop. Bridges the existing journal
(verdict_log.jsonl + outcome_log.jsonl, both shipped since v3.5.6) into
the v3.9 calibration registry, so calibration can drift from a backtest
baseline toward production reality.

---

## What changed

### `src/calibration/fromJournal.ts` (new)

The bridge module. Two public functions:

```ts
buildRecordsFromJournal(opts: JournalQueryOptions): Promise<JournalIngestionResult>
buildRecordsBySymbol(opts): Promise<Record<string, BacktestVerdictRecord[]>>
```

What it does:
1. Reads `verdict_log.jsonl` via the existing `readAllVerdicts()`.
2. Reads `outcome_log.jsonl` via the existing `readAllOutcomes()`.
3. For each verdict, picks the latest outcome record (preferring terminal
   over pre-terminal so an EXPIRED status correctly supersedes an
   earlier OPEN checkpoint).
4. Maps outcome status:
   - `TP` → `WIN`
   - `SL` → `LOSS`
   - `EXPIRED` → `TIMEOUT`
   - `OPEN` → skipped, reason `still_open`
   - `FETCH_FAILED` → skipped, reason `fetch_failed`
   - `BUY/SELL` without any outcome → skipped, reason `no_outcome`
   - `WAIT` verdicts → emitted with outcome `NONE` (contributes to bin
     density but not win-rate)
5. Filters by symbol/date range.
6. Returns a `BacktestVerdictRecord[]` consumable by the existing
   `buildCalibrationFromRecords` from v3.9.

The output shape is identical to what `replayBacktest` produces, so the
two ingestion paths (offline backtest, online journal) feed through a
single calibration builder. No code duplication.

### `src/calibration/cli.ts` — new `--from-journal` mode

```bash
# Single symbol from live journal
npm run calibrate -- --from-journal --pair EURUSD

# All symbols in journal
npm run calibrate -- --from-journal

# With date filter
npm run calibrate -- --from-journal --pair EURUSD --from 2026-04-01 --to 2026-04-30
```

The CLI reports honest skip statistics:
```
[journal-stats] verdicts=420 outcomes=380 matched(EURUSD)=420 usable=320
[journal-stats] skipped: {"still_open":85,"fetch_failed":12,"no_outcome":3}
```

### `src/measurement/verdictLog.ts` — calibration audit field

`VerdictRecord` now carries an optional `calibrationContext`:

```ts
calibrationContext?: {
  source: "calibrated" | "heuristic";
  binLoAbs?: number;
  binHiAbs?: number;
  binWinRate?: number;
  binSampleSize?: number;
  heuristicReason?: "no_calibration" | "low_sample" | "no_match" | "out_of_range";
}
```

Optional for backwards compat — pre-v3.10 journal entries don't have it
and are still readable. New entries from v3.10+ deployments will record
exactly which bin produced their confidence value, enabling forensic
analysis ("show me all verdicts where confidence came from the 40-55 bin
and the trade lost").

### `src/measurement/recorder.ts` — captures `scores.calibration`

`buildRecord()` now reads `pair.scores.calibration` (set in v3.9
court.ts) and folds it into the journal record. Gracefully handles
missing/malformed values — never throws.

### `src/config.ts` — VERSION bumped

`VERSION` constant raised from `3.5.6` → `3.10.0`. This tag appears in
every journal record's `version` field. After deploying v3.10, you can
filter the journal to "post-v3.10 records only" if you ever need to
distinguish what the deployment knew about calibration:

```bash
jq 'select(.version | startswith("3.10"))' data/verdict_log.jsonl
```

### `src/tests/calibration-from-journal.smoke.ts` (new)

Real unit test that:
1. Writes a controlled fixture journal (228 verdicts: 200 trades + 10 WAIT
   + 10 OPEN + 5 FETCH_FAILED + 3 GBPUSD).
2. Runs the bridge with `symbol: "EURUSD"` filter.
3. Asserts:
   - Total counts match (228 verdicts read, 218 outcomes read).
   - EURUSD filter matches 225 (228 - 3 GBPUSD).
   - 210 usable records (200 trades + 10 WAIT).
   - Skipped: exactly 10 still_open + 5 fetch_failed.
   - Bin 25-40: 100 trades, 60 wins, 40 losses, win-rate 0.60 (matches
     fixture exactly).
   - Bin 40-55: 100 trades, 75 wins, 25 losses, win-rate 0.75 (matches).
   - Bin 0-15: 10 records, 0 trades (WAIT verdicts).

All assertions PASSED during the build.

`tsc -p tsconfig.node.json` → 0 errors.
`tsc -p tsconfig.test.json` → 0 errors.
`node dist/tests/calibration-from-journal.smoke.js` → PASSED.

---

## How to use this in production

### Step 1 — Let the system run

The journal accumulates automatically. `recordVerdicts()` is wired in
`server.ts` line 92, fire-and-forget after every snapshot.

### Step 2 — Periodically run the outcome tracker

```bash
npm run tracker:run
```

This compares each open BUY/SELL verdict's plan against subsequent
candles and records TP/SL/EXPIRED. Schedule via cron:

```cron
*/15 * * * * cd /path/to/trading-court-pro && npm run tracker:run
```

### Step 3 — Refresh calibration from journal

After ≥200 trades have terminal outcomes for a symbol:

```bash
npm run calibrate -- --from-journal --pair EURUSD
npm run build
# redeploy
```

The next decision for EURUSD uses the LIVE-data win-rates instead of the
backtest baseline.

### Step 4 — Iterate

Run step 3 on a calendar — weekly or monthly. The calibration drifts
toward production reality. Backtest-derived calibration is your starting
point; live-driven calibration is your steady state.

### Hybrid: both sources

You can mix sources per symbol. EURUSD might come from `--from-journal`
once it has enough data; XAUUSD might still be on its backtest
calibration if live volume hasn't accumulated. The registry holds them
side-by-side; each entry's `notes` field documents which source produced
it.

---

## Honest limitations

1. **Journal-driven calibration carries the same Phase 1 caveat as
   backtest-driven**, sort of. The verdicts in the journal WERE made
   with full news/calendar/macro context (live system has all of those),
   so the live calibration win-rates are MORE realistic than backtest
   ones. This is the architectural win of Phase 3.

2. **MIN_BIN_SAMPLE_SIZE = 20.** Until a bin has 20 trades, that bin
   continues using the heuristic. With realistic verdict density (~8
   pairs × ~4 verdicts/hour × 24h = ~768 verdicts/day, of which maybe
   100-200 are trades), you can expect a populated EURUSD bin to reach
   threshold within 1-2 weeks of live operation.

3. **Tracker latency.** A trade's outcome only enters the calibration
   when the tracker has marked it terminal. Default tracker checkpoints
   are 1h/4h/24h. So same-day trades (per the day-trading-gate) reach
   terminal at ≤24h via EXPIRED if neither TP nor SL hit. Calibration
   refresh is therefore at least 24h behind live trading.

4. **Outcome bar count is null for journal-derived records.** The
   tracker doesn't record "took N M5 bars to hit TP". Calibration math
   doesn't need it; it stays null for now.

5. **Cloudflare Workers deployment.** The journal+tracker subsystem
   relies on Node.js filesystem writes (`./data/*.jsonl`). For a pure
   Workers deployment, you'd swap to KV or D1. The calibration bridge
   itself is filesystem-agnostic — it just calls `readAllVerdicts()`
   and `readAllOutcomes()`, which can be re-implemented over KV/D1
   without touching `fromJournal.ts`.

---

## Files changed

| File | Status | Lines | Why |
|------|--------|-------|-----|
| `src/calibration/fromJournal.ts` | NEW | 188 | Bridge: journal → BacktestVerdictRecord[] |
| `src/calibration/cli.ts` | MODIFIED | +95 | `--from-journal` mode |
| `src/measurement/verdictLog.ts` | MODIFIED | +20 | `VerdictCalibrationContext` field |
| `src/measurement/recorder.ts` | MODIFIED | +25 | Captures `scores.calibration` into log |
| `src/config.ts` | MODIFIED | 1 | VERSION → 3.10.0 |
| `src/tests/calibration-from-journal.smoke.ts` | NEW | 195 | Real unit test |
| `package.json` | MODIFIED | — | v3.10.0; `test:calibration-journal` script |
| `CHANGES_v3.10.md` | NEW | — | This document |

## Deferred to next round (Phase 3B+)

- **Phase 2B/2C** still pending: backtest-side historical
  FairEconomy + news + FRED. Once Phase 3 is in production for ~1 month
  and journal-driven calibration takes over as primary, the backtest
  Phase 1/2 distinction matters less — but the historical context would
  still help cold-start new symbols.
- **Continuous refresh** — current model is "run npm run calibrate
  manually every week or two." A natural follow-up is a scheduled
  background process that runs the bridge nightly and writes to the
  registry, plus a feature flag to toggle "use latest calibration"
  versus "pin calibration to last manual deploy" for safety.
- **Tier-threshold tuning** — `STRONG ≥ 72` etc. were chosen at a time
  when confidence was a heuristic. With ~6 months of journal data, those
  thresholds can be re-derived from observed win-rate distributions.
- **Workers KV adapter** — current journal is Node.js filesystem.
  Moving to a Workers-native store unlocks edge deployment.
