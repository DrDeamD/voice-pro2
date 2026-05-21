import { evaluateJudgeOverride } from "../engines/v36/judgeOverride.js";

const analysis = {
  verdict: "BUY",
  scores: { direction: "LONG", confidence: 82, composite: 74 },
  regime: { label: "TREND_DOWN" },
  bullCase: [
    "VWAP: price above daily VWAP",
    "PDH_BREAK(B): Broke PDH 0.78199",
    "ASIA_RANGE_BREAK(B): Broke Asia high 0.78152",
    "Market structure +41.0: CHOCH_BULL@0.78216, BOS_BULL@0.78290",
    "Price at 96.9% of H4 range [0.77914 → 0.78290]",
    "High-impact macro pending"
  ],
  bearCase: [
    "H4 regime TREND_DOWN, ADX 39.9",
    "BREAKING bias -29"
  ],
  warnings: [],
  summary: "test",
} as any;

const out = evaluateJudgeOverride(analysis);

if (!out.active) throw new Error("judge override should be active");
if (out.to !== "WAIT") throw new Error("judge override should convert BUY to WAIT");
if (!out.messages.every((m: any) => m.en && m.ar)) throw new Error("all judge messages must be bilingual");

console.log(JSON.stringify(out, null, 2));
