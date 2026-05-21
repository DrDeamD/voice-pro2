# Smart Judge Override Layer

## What was added

File:

```text
src/engines/v36/judgeOverride.ts
```

The layer adds:

```ts
analysis.judgeOverride
```

with bilingual messages:

```ts
{ en: "...", ar: "..." }
```

Arabic translation is only inside the Judge Override object.

## Integration

In `src/engines/v36/statCourt.ts`:

```ts
import { applyJudgeOverride } from "./judgeOverride.js";
```

At the final return of `applyV36StatisticalCourt`, wrap the final `PairAnalysis`:

```ts
return applyJudgeOverride({
  ...analysis,
  scores,
  plan,
  verdict: nextVerdict,
  warnings,
  summary,
  verdictExplanation,
  ...
});
```

If this ZIP already patched your `statCourt.ts`, no manual change is needed.

## Main blocker rule

BUY is changed to WAIT when:

```text
H4 = bearish / TREND_DOWN
Intraday = bullish
Price is in H4 premium >= 85%
High-impact macro is pending
```

SELL is changed to WAIT when:

```text
H4 = bullish / TREND_UP
Intraday = bearish
Price is in H4 discount <= 15%
High-impact macro is pending
```

## Acceptance

- Judge Override never creates prices.
- Judge Override never creates spread.
- Judge Override never changes WAIT into BUY/SELL.
- Every judge sentence has EN and AR.
