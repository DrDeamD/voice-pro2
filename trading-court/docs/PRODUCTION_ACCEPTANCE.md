# Trading Court v37b-final — Production Acceptance Checklist

Status: dry-run / shadow-mode candidate, not live-trading approval.

## Required checks before deploy

- [ ] `npm install` completed without dependency surprises.
- [ ] `npx tsc --noEmit -p tsconfig.node.json` passes.
- [ ] `npx tsc --noEmit -p tsconfig.test.json` passes.
- [ ] v36 Truth Gate runs before classical indicators.
- [ ] Synthetic NZDUSD fallback is blocked before indicators and before v36 statistical court.
- [ ] Investing PT5H-as-H4 is blocked.
- [ ] H4 resample from real H1 is allowed only with warning.
- [ ] VWAP refuses to compute without real candle volume.
- [ ] USDCAD/USDCHF pip value uses `(pip * 100000) / entry`, not flat $10.
- [ ] Breaking news veto is conflict-based: conflict = WAIT, aligned = confidence penalty.
- [ ] Range regime uses `trustFloor=45`, including confidence delta penalty.
- [ ] No `Math.random()` in trading logic.
- [ ] No synthetic spread fallback in replay or live trading logic.
- [ ] `verdict_log.jsonl` writes during shadow mode.
- [ ] `outcome_tracker` runs without crash.

## Shadow-mode acceptance

Run for 3–5 market days without executing trades.
Record:

- verdicts per day
- BUY / SELL / WAIT distribution
- WAIT reasons distribution
- confidence histogram
- trustScore histogram
- average spread by pair
- v36 gate blocks by reason
- win/loss only after enough completed outcomes

## Do not approve live trading if

- trades/day is near zero for all active sessions without clear macro reason
- WAIT reasons are dominated by a single overly broad gate
- any dashboard number is based on synthetic or unavailable data
- VWAP appears while source volume is missing
- NZDUSD uses AUDUSD proxy anywhere downstream
