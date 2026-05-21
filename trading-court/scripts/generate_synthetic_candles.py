#!/usr/bin/env python3
"""
Synthetic HistData-format M1 generator for backtest baseline.

Limitations honestly stated:
  - Synthetic, NOT real market data. Cannot prove the engine's verdict
    distribution on real markets.
  - DOES exercise every code path (truth gate, indicators, MTF, regime,
    market structure, momentum, composite weighting, v36 layer).
  - Random-walk + regime-switching: trends and ranges are plausible but
    not historically calibrated.
  - News/calendar/context all stubbed by replay.ts (Phase 1 limitation).

Output format (HistData Generic ASCII):
  YYYYMMDD HHMMSS;OPEN;HIGH;LOW;CLOSE;VOLUME

Use:
  python3 generate_synthetic_candles.py EURUSD 60 > synthetic_eurusd.csv
"""
import sys
import math
import random
from datetime import datetime, timedelta, timezone

# Per-pair config: starting price, M1 vol (stdev of log return), regime mix
PAIRS = {
    "EURUSD": dict(start=1.0850, vol_m1=0.00012, decimals=5),
    "GBPUSD": dict(start=1.2650, vol_m1=0.00015, decimals=5),
    "USDJPY": dict(start=148.50, vol_m1=0.00018, decimals=3),
    "AUDUSD": dict(start=0.6580, vol_m1=0.00018, decimals=5),
    "USDCAD": dict(start=1.3550, vol_m1=0.00012, decimals=5),
    "USDCHF": dict(start=0.8920, vol_m1=0.00013, decimals=5),
    "XAUUSD": dict(start=2050.0, vol_m1=0.00050, decimals=2),
}

# Regime cycle: each regime lasts random(60min, 360min)
REGIMES = [
    # name, drift (per M1, log-return), vol_multiplier
    ("TREND_UP",      +0.000020, 1.0),
    ("TREND_DOWN",    -0.000020, 1.0),
    ("RANGE_QUIET",    0.0,      0.5),
    ("RANGE_NORMAL",   0.0,      1.0),
    ("RANGE_VOLATILE", 0.0,      1.6),
    ("CHOPPY",         0.0,      1.2),
]

REGIME_WEIGHTS = [3, 3, 2, 4, 1, 2]  # TREND more common, super-volatile rare


def pick_regime(rng: random.Random):
    return rng.choices(REGIMES, weights=REGIME_WEIGHTS)[0]


def generate(pair: str, days: int, seed: int = 42) -> None:
    if pair not in PAIRS:
        raise SystemExit(f"Unknown pair: {pair}")
    cfg = PAIRS[pair]
    rng = random.Random(seed)

    # Start at midnight UTC, n days ago
    start_dt = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    start_dt -= timedelta(days=days)

    price = cfg["start"]
    vol = cfg["vol_m1"]
    decimals = cfg["decimals"]
    n_bars = days * 24 * 60  # M1 bars

    # Regime state
    regime_name, drift, vol_mult = pick_regime(rng)
    regime_remaining = rng.randint(60, 360)

    # OUTPUT to stdout
    for i in range(n_bars):
        # Switch regime when timer expires
        if regime_remaining <= 0:
            regime_name, drift, vol_mult = pick_regime(rng)
            regime_remaining = rng.randint(60, 360)
        regime_remaining -= 1

        # Hour-of-day liquidity profile (Asia quiet, London/NY active)
        ts = start_dt + timedelta(minutes=i)
        h = ts.hour
        if 0 <= h < 7:    liq = 0.6   # Asia
        elif 7 <= h < 12: liq = 1.2   # London open
        elif 12 <= h < 17: liq = 1.4  # London/NY overlap
        elif 17 <= h < 22: liq = 1.0  # NY
        else:             liq = 0.5   # late NY / Asia transition

        # Log return for this bar
        eff_vol = vol * vol_mult * liq
        r = rng.gauss(drift, eff_vol)
        new_close = price * math.exp(r)

        # OHLC: open = previous close, intra-bar high/low based on volatility
        o = price
        c = new_close
        # range = abs(o-c) + extra wick proportional to volatility
        wick = abs(rng.gauss(0, eff_vol * price * 0.5))
        h_price = max(o, c) + wick
        l_price = min(o, c) - wick

        # Format: HistData ASCII
        ts_str = ts.strftime("%Y%m%d %H%M%S")
        if decimals == 5:
            print(f"{ts_str};{o:.5f};{h_price:.5f};{l_price:.5f};{c:.5f};0")
        elif decimals == 3:
            print(f"{ts_str};{o:.3f};{h_price:.3f};{l_price:.3f};{c:.3f};0")
        else:
            print(f"{ts_str};{o:.2f};{h_price:.2f};{l_price:.2f};{c:.2f};0")

        price = c


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: generate_synthetic_candles.py PAIR DAYS [SEED]", file=sys.stderr)
        sys.exit(1)
    pair = sys.argv[1]
    days = int(sys.argv[2])
    seed = int(sys.argv[3]) if len(sys.argv) > 3 else 42
    generate(pair, days, seed)
