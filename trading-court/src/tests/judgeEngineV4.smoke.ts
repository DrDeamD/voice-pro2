import { judgeEngineV4 } from "../engines/judge/judgeEngineV4.js";

const onlyNews = judgeEngineV4({
  verdict: "BUY",
  confidence: 82,
  h4Trend: "UP",
  premiumPct: 55,
  intradayBias: "BULL",
  newsImpact: "HIGH",
  newsAlignedWithTrade: true,
});

if (onlyNews.to !== "BUY") {
  throw new Error("Aligned high-impact news alone must not kill the trade.");
}

const trap = judgeEngineV4({
  verdict: "BUY",
  confidence: 82,
  h4Trend: "DOWN",
  premiumPct: 96.9,
  intradayBias: "BULL",
  newsImpact: "HIGH",
  sweptHigh: true,
  bos: "BULL",
});

if (trap.to !== "WAIT") {
  throw new Error("Combined premium + HTF conflict + news + sweep must become WAIT.");
}

const moderate = judgeEngineV4({
  verdict: "SELL",
  confidence: 80,
  h4Trend: "UP",
  premiumPct: 25,
  intradayBias: "BEAR",
  newsImpact: "NONE",
});

if (moderate.mode !== "WAIT_FOR_CONFIRMATION") {
  throw new Error("Moderate risk must ask for confirmation, not hard kill everything.");
}

console.log(JSON.stringify({ onlyNews, trap, moderate }, null, 2));
