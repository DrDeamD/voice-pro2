# Trading Court v3.6 — Direct Integration Patch

This patch is designed for the existing v3.5.6 project.

It does **not** create dummy candles.  
It does **not** fetch new external APIs.  
It does **not** fabricate values.  
It uses the real `quote` and `series` already fetched inside `src/engines/court.ts`.

## Files to copy

Copy this folder into the project root:

```text
src/engines/v36/statTypes.ts
src/engines/v36/statMath.ts
src/engines/v36/truth.ts
src/engines/v36/statCourt.ts
```

These files are included by `tsconfig.node.json` because it already includes `src/engines/**/*`.

## Patch `src/engines/court.ts`

### 1) Add this import near the other imports

```ts
import { applyV36StatisticalCourt } from "./v36/statCourt.js";
```

### 2) Replace the final return object

Find the existing final return near the end of `analyzePair()`:

```ts
return {
  symbol, display: meta.display,
  quote, regime, mtf, correlation: corr, news, priceAction: pa, session,
  scores, plan, risk,
  verdict, opportunityStatus: oppStatus,
  bullCase, bearCase, summary, verdictExplanation,
  warnings,
  indicators: { m5: indM5, m15: indM15, h1: indH1, h4: indH4, d1: indD1 },
  marketStructure, killZone, manipulation,
  structuralPlan,
  divergenceH1, divergenceM15,
  freshness,
  ...({ vwap, m5Trigger, calendarFeedback: calFeedback } as any),
  generatedUtc: new Date().toISOString(),
};
```

Replace it with:

```ts
const baseAnalysis: PairAnalysis = {
  symbol, display: meta.display,
  quote, regime, mtf, correlation: corr, news, priceAction: pa, session,
  scores, plan, risk,
  verdict, opportunityStatus: oppStatus,
  bullCase, bearCase, summary, verdictExplanation,
  warnings,
  indicators: { m5: indM5, m15: indM15, h1: indH1, h4: indH4, d1: indD1 },
  marketStructure, killZone, manipulation,
  structuralPlan,
  divergenceH1, divergenceM15,
  freshness,
  ...({ vwap, m5Trigger, calendarFeedback: calFeedback } as any),
  generatedUtc: new Date().toISOString(),
};

return applyV36StatisticalCourt(baseAnalysis, {
  symbol,
  quote,
  series,
});
```

## Why this is direct

The old code already fetches:

```ts
const [quote, series, ctx, newsItems] = await Promise.all([
  fetchQuote(symbol),
  fetchAllTimeframes(symbol),
  fetchContext(),
  fetchNewsForPair(symbol),
]);
```

So v3.6 receives the real values directly from the old fetchers.

## Data honesty rules enforced

The v3.6 truth gate blocks:

- unavailable quote
- invalid bid/ask
- stale quote > 120s
- missing 5m / 15m / 1h / 4h candles
- malformed OHLC
- non-monotonic timestamps
- synthetic NZDUSD fallback
- Investing PT5H pretending to be H4

## Important note

The old `fetchers/candles.ts` contains a synthetic NZDUSD fallback and an Investing PT5H H4 approximation. v3.6 does not modify that file in this patch; instead it blocks those sources at the truth gate.

That means:
- old v3.5.6 can still display its normal analysis
- v3.6 can force WAIT when the data source violates the stricter truth contract


## v36 Patch Fix 1 — Synthetic NZDUSD hard block

`truth.ts` now blocks:

```text
kraken:synth(AUD)
kraken:synth(AUD×ratio)
Using AUDUSD proxy (no anchor)
```

This closes the false-negative case where `synth(AUD)` did not contain the word `synthetic` and did not include `nzd` in the note.
