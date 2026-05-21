# Trading Court Pro v3.10.0

**Professional FX & XAU Daytrading Decision Engine**
Edge-native · Open data sources only · No paid APIs · ICT/SMC methodology

This release wires empirical confidence calibration into the live decision
loop. After running a backtest and a one-line calibration command, the
system replaces its `confidence = |composite|` heuristic with bin-level
win-rates measured on real historical data — `confidence` is now an
empirical probability instead of a weight.

See `CHANGES_v3.7c.md` → `CHANGES_v3.9.md` for the full evolution.

---


## What's new in v3.10

| # | Change | File | Why |
|---|--------|------|-----|
| 1 | Live calibration loop | `src/calibration/fromJournal.ts` (NEW) | Bridge from journal (verdict_log + outcome_log) into calibration registry |
| 2 | `--from-journal` CLI mode | `src/calibration/cli.ts` | One command refreshes calibration from production data |
| 3 | Journal calibration audit | `src/measurement/verdictLog.ts` + `recorder.ts` | Every new verdict logs which bin produced its confidence and whether it was empirical/heuristic |
| 4 | VERSION → 3.10.0 | `src/config.ts` | Tag new journal lines so post-v3.10 records can be filtered |

After deploying for ~1-2 weeks (until each pair has ≥20 trades per bin), refresh calibration from live data:

```bash
npm run calibrate -- --from-journal --pair EURUSD
npm run build
# redeploy
```

This unlocks calibration that drifts toward production reality, not just backtest baseline. See `CHANGES_v3.10.md`.

## What's new in v3.9

| # | Change | File | Why |
|---|--------|------|-----|
| 1 | Empirical confidence calibration | `src/calibration/` (NEW module) | Replaces heuristic with bin-level win-rates from backtest |
| 2 | Calibration CLI | `npm run calibrate` | One-line calibration update from backtest results |
| 3 | court.ts wiring | `src/engines/court.ts` | composeScores + m5Bonus paths consult calibration |
| 4 | Audit trail | `scores.calibration` field | Every verdict shows source: empirical or heuristic |
| 5 | Build fix | tsconfig.node.json + tsconfig.test.json | v3.8 forgot to include backtest/ in build — fixed |
| 6 | Unit test | `src/tests/calibration.smoke.ts` | Real test of bin math + low-sample fallback |

## How calibration works

1. Run a backtest:
   ```bash
   npm run backtest -- --pair EURUSD --csv ./data/EURUSD --out results/eurusd.json
   ```
2. Build the calibration:
   ```bash
   npm run calibrate -- --pair EURUSD --records results/eurusd.json
   ```
3. Rebuild and deploy:
   ```bash
   npm run build
   ```

After deploy, every verdict for EURUSD whose `|composite|` falls in a
bin with ≥20 historical trades will use the empirical win-rate as its
confidence. Other bins (sparse) and unsupported symbols continue using
the v3.8 heuristic — fully backwards compatible.

Audit any decision via the `warnings` field:
- `Confidence: empirical (bin |comp| 25-40, 124 trades, win-rate 64.3%)`
- `Confidence: heuristic (matched bin has <20 trades)`

## Architecture

```
src/
├── config.ts                    # Instruments, weights, rules, TTLs
├── http.ts                      # Resilient HTTP client
├── index.tsx                    # Hono app + HTML dashboard
│
├── types/index.ts               # Central TypeScript types
│
├── fetchers/
│   ├── quote.ts                 # Swissquote → TradingView → Stooq
│   ├── candles.ts               # Kraken OHLCV → Coinbase fallback
│   ├── context.ts               # TV primary + FRED fallback (v3.8)
│   ├── news.ts                  # +CB direct feeds (v3.8)
│   ├── calendar.ts              # FairEconomy JSON
│   ├── centralBanks.ts          # 8 central banks direct RSS (v3.8)
│   └── fred.ts                  # FRED CSV macro context (v3.8)
│
├── engines/
│   ├── ...                      # MTF, regime, momentum, vwap, marketStructure, manipulation, divergence, priceAction, killZone, dayTradingGate, structuralRR, etc.
│   ├── judge/judgeEngineV4.ts
│   ├── v36/                     # statCourt, judgeOverride, truth, preGate, statMath
│   └── court.ts                 # runCourt(pure) + analyzePair(async wrapper)
│                                # v3.9: composeScores reads calibration
│
├── calibration/                 # [v3.9] NEW
│   ├── types.ts
│   ├── calibrationData.json     # bundled registry (populated by CLI)
│   ├── registry.ts
│   ├── applyCalibration.ts      # decision-time function
│   ├── buildCalibration.ts      # records → calibration data
│   └── cli.ts                   # `npm run calibrate`
│
└── backtest/                    # (v3.8) NEW — used as input to calibration
    ├── loadHistdata.ts
    ├── replay.ts
    ├── calibrate.ts
    └── cli.ts                   # `npm run backtest`
```

## Data Sources (open, no API key)

| Tier | Source | Data |
|------|--------|------|
| Primary | Kraken OHLC | M5/M15/H1/H4/D1 candles + volume |
| Primary | Swissquote BBO | Real bid/ask quotes |
| Primary | TradingView Scanner | Real-time DXY/VIX/Oil/US10Y |
| Primary | 8 Central Banks RSS | Fed/ECB/BoE/BoJ/RBA/BoC/RBNZ/SNB primary-source policy news |
| Fallback | Stooq CSV | Universal quote fallback |
| Fallback | Coinbase PAXG-USD | Gold spot fallback |
| Fallback | FRED CSV | Daily DXY/VIX/Oil/Gold/US10Y/Fed funds |
| Sentiment | Google News RSS | Pair-scoped news |
| Sentiment | ForexLive RSS | General + central-bank streams |
| Calendar | FairEconomy JSON | Economic calendar |
| Backtest | HistData.com | Historical M1 OHLC (free download) |

## Installation

```bash
npm install
npm run build
npm run start
# health check
curl http://localhost:3000/healthz
curl 'http://localhost:3000/api/snapshot?force=1' | jq '.pairs[0].judgeOverride.inputs'
```

## Calibration workflow

```bash
# 1. Download HistData M1 CSVs (free, no key) from
#    https://www.histdata.com/download-free-forex-historical-data/?/ascii/1-minute-bar-quotes/eurusd
# 2. Backtest each pair
npm run backtest -- --pair EURUSD --csv ./data/EURUSD --out results/eurusd.json

# 3. Build calibration
npm run calibrate -- --pair EURUSD --records results/eurusd.json

# 4. Inspect the registry
npm run calibrate -- --show

# 5. Rebuild and redeploy
npm run build
```

## Trading Logic — Daytrading Flow

1. **D1/H4** — Regime classification + Premium/Discount on real dealing range
2. **H1** — BOS/CHoCH freshness check (≤3 bars)
3. **Kill Zone** — London KZ (07-10 UTC) or NY AM KZ (13-15 UTC)
4. **Calendar** — HIGH-impact event ±30min veto
5. **M15** — Judas Swing or stop-hunt detection
6. **VWAP** — Institutional anchor confirmation
7. **M5 Trigger** — EMA9/21 cross + impulse + volume
8. **EOD Gate** — Sufficient time before NY close (21:00 UTC)
9. **Composite + Calibrated Confidence** — confidence = empirical win-rate when available
10. **Judge v4** — Soft Risk Score on structured fields
11. **Plan** — Structural SL/TP with R:R ≥ 1.5

> **Decision support only. Does not place orders.**

## Supported Instruments

EUR/USD · GBP/USD · USD/JPY · AUD/USD · USD/CAD · NZD/USD · USD/CHF · XAU/USD

## What this version does NOT do (yet)

- **Backtest does not yet include news/calendar/macro context.** Phase 2B
  will integrate historical FairEconomy + a news archive + FRED
  historical context per replay date. Until then, calibration win-rates
  reflect technical-setup-only decisions; production decisions still
  apply news/calendar filters on top.
- **No live trade journal.** Verdicts are observable via the API but
  outcome tracking requires the user's exchange data. Phase 3 will add
  a persistent journal that feeds continuous calibration refresh.
- **Friday cut-off uses fixed 19:00 UTC.** Not DST-aware.

---

*Trading Court Pro v3.9.0 — Built with Hono + Cloudflare Workers + TypeScript*
