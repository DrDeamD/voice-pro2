# Judge Engine v4 — Soft Risk Scoring

## Problem solved

Previous judge logic could make the system over-filtered: one risk = WAIT.
That produced days where every setup became WAIT.

## New logic

```text
Risk < 40      → keep verdict and reduce confidence slightly
Risk 40–69     → WAIT_FOR_CONFIRMATION unless entry confirmation exists
Risk >= 70     → HARD_WAIT
```

## Main principle

A single risk does not kill the trade.
A cluster of risks does.

## Examples

High-impact aligned news alone:
```text
risk = 12
verdict stays BUY/SELL
```

Full liquidity trap:
```text
H4 conflict 30 + premium trap 25 + high-impact news 25 + sweep 25 = 100
verdict = WAIT
```

## Bilingual rule

Only `judgeOverride.messages` contains EN/AR translation pairs.
