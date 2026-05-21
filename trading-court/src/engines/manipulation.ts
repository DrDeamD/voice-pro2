// ============================================================================
// Manipulation / Judas Swing Detector (NEW)
//
// Fixes audit flaw #5: original _detect_manipulation compared last candle vs
// a rolling 6-candle window, which generated noise. ICT-style manipulation
// (Judas Swing / stop hunt) is detected against the PRIOR SESSION's H/L
// (24-48 hour window) and prior H4 swings.
//
// Signals:
//   • BULLISH_SWEEP : price wicks BELOW prior session low, closes above it
//                     with a large lower wick → stop hunt, likely bullish reversal.
//   • BEARISH_SWEEP : price wicks ABOVE prior session high, closes below it
//                     with a large upper wick → stop hunt, likely bearish reversal.
//
// Plus: London Judas Swing detection — first 90 min of London pushes one way
//       then reverses hard → classic institutional trap.
// ============================================================================
import type { Candle } from "../types/index.js";
import type { Swing } from "./marketStructure.js";

export interface ManipulationSignal {
  kind: "BULLISH_SWEEP" | "BEARISH_SWEEP" | "JUDAS_BULL" | "JUDAS_BEAR" | "NONE";
  detected: boolean;
  strength: number;           // 0..100
  level: number | null;       // the swept level
  note: string;
}

export interface ManipulationReport {
  signals: ManipulationSignal[];
  primary: ManipulationSignal;
  score: number;              // -100..+100 (positive = bullish, negative = bearish)
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Helper: detect last-candle session sweep
// ---------------------------------------------------------------------------
function detectSessionSweep(
  h1: Candle[],
  swingsH4: Swing[] = [],
): ManipulationSignal[] {
  const out: ManipulationSignal[] = [];
  if (h1.length < 12) return out;

  // Use prior 24-48 H1 bars as "session window"
  const n = h1.length;
  const windowSize = Math.min(48, n - 1);
  const priorWindow = h1.slice(-windowSize - 1, -1); // exclude current bar

  let sessionHigh = Math.max(...priorWindow.map(c => c.h));
  let sessionLow = Math.min(...priorWindow.map(c => c.l));

  // Reinforce with H4 swings if available
  if (swingsH4.length) {
    const highs = swingsH4.filter(s => s.kind === "HH" || s.kind === "LH" || s.kind === "SH");
    const lows  = swingsH4.filter(s => s.kind === "HL" || s.kind === "LL" || s.kind === "SL");
    if (highs.length) sessionHigh = Math.max(sessionHigh, ...highs.slice(-3).map(s => s.price));
    if (lows.length)  sessionLow  = Math.min(sessionLow,  ...lows.slice(-3).map(s => s.price));
  }

  const last = h1[n - 1];
  const rng = last.h - last.l;
  if (rng <= 0) return out;

  const body = Math.abs(last.c - last.o);
  const upperWick = last.h - Math.max(last.o, last.c);
  const lowerWick = Math.min(last.o, last.c) - last.l;

  // BULLISH SWEEP — swept below session low and closed back above
  if (last.l < sessionLow && last.c > sessionLow) {
    const sweepPips = sessionLow - last.l;
    const sweepRatio = sweepPips / rng;
    if (lowerWick > body * 1.4 && sweepRatio > 0.12) {
      const strength = Math.min(100, Math.round(50 + sweepRatio * 300 + (lowerWick / rng) * 40));
      out.push({
        kind: "BULLISH_SWEEP",
        detected: true,
        strength,
        level: sessionLow,
        note: `🎯 Stop Hunt BULLISH: wick ${sweepPips.toFixed(5)} below session low ${sessionLow.toFixed(5)}, strong close above. Reversal likely.`,
      });
    }
  }

  // BEARISH SWEEP — swept above session high and closed back below
  if (last.h > sessionHigh && last.c < sessionHigh) {
    const sweepPips = last.h - sessionHigh;
    const sweepRatio = sweepPips / rng;
    if (upperWick > body * 1.4 && sweepRatio > 0.12) {
      const strength = Math.min(100, Math.round(50 + sweepRatio * 300 + (upperWick / rng) * 40));
      out.push({
        kind: "BEARISH_SWEEP",
        detected: true,
        strength,
        level: sessionHigh,
        note: `🎯 Stop Hunt BEARISH: wick ${sweepPips.toFixed(5)} above session high ${sessionHigh.toFixed(5)}, strong close below. Reversal likely.`,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Judas Swing — classic London Open trap
// In the first 60-90 min of London (07:00-08:30 UTC), price pushes one way
// then reverses hard. Detect by looking at Asia close → London first bars.
// ---------------------------------------------------------------------------
function detectJudasSwing(
  m15: Candle[],
  nowUtc: Date,
): ManipulationSignal[] {
  const out: ManipulationSignal[] = [];
  if (m15.length < 30) return out;

  const h = nowUtc.getUTCHours();
  const m = nowUtc.getUTCMinutes();
  const londonMinute = h * 60 + m;

  // Only check during or right after London Open (07:30 - 10:00 UTC)
  if (londonMinute < 7 * 60 + 30 || londonMinute > 10 * 60) return out;

  // Locate candles from Asia close (06:00 UTC) and London open (07:00 UTC)
  const today = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate()));
  const asiaCloseTs = today.getTime() / 1000 + 6 * 3600;
  const londonOpenTs = today.getTime() / 1000 + 7 * 3600;
  const checkEndTs = today.getTime() / 1000 + londonMinute * 60;

  const asiaBars = m15.filter(c => c.t >= asiaCloseTs && c.t < londonOpenTs);
  const londonBars = m15.filter(c => c.t >= londonOpenTs && c.t <= checkEndTs);
  if (asiaBars.length < 2 || londonBars.length < 3) return out;

  const asiaClose = asiaBars[asiaBars.length - 1].c;
  const londonHigh = Math.max(...londonBars.map(c => c.h));
  const londonLow = Math.min(...londonBars.map(c => c.l));
  const londonLast = londonBars[londonBars.length - 1].c;

  const rangeUp = londonHigh - asiaClose;
  const rangeDown = asiaClose - londonLow;

  // JUDAS BEAR: London pushed UP above Asia close, then reversed hard below it
  if (rangeUp > rangeDown * 1.5 && londonLast < asiaClose) {
    const pushRatio = rangeUp / (asiaClose || 1);
    const reverseMagnitude = (londonHigh - londonLast) / (asiaClose || 1);
    if (pushRatio > 0.0015 && reverseMagnitude > 0.002) {
      out.push({
        kind: "JUDAS_BEAR",
        detected: true,
        strength: Math.min(100, 55 + Math.round(reverseMagnitude * 8000)),
        level: londonHigh,
        note: `🎯 London Judas BEAR: price spiked to ${londonHigh.toFixed(5)} then reversed below Asia close. Institutional distribution.`,
      });
    }
  }

  // JUDAS BULL: London pushed DOWN below Asia close, then reversed hard above it
  if (rangeDown > rangeUp * 1.5 && londonLast > asiaClose) {
    const pushRatio = rangeDown / (asiaClose || 1);
    const reverseMagnitude = (londonLast - londonLow) / (asiaClose || 1);
    if (pushRatio > 0.0015 && reverseMagnitude > 0.002) {
      out.push({
        kind: "JUDAS_BULL",
        detected: true,
        strength: Math.min(100, 55 + Math.round(reverseMagnitude * 8000)),
        level: londonLow,
        note: `🎯 London Judas BULL: price dipped to ${londonLow.toFixed(5)} then reversed above Asia close. Institutional accumulation.`,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------
export function analyzeManipulation(
  h1: Candle[],
  m15: Candle[],
  swingsH4: Swing[] = [],
  nowUtc: Date = new Date(),
): ManipulationReport {
  const sweeps = detectSessionSweep(h1, swingsH4);
  const judas = detectJudasSwing(m15, nowUtc);
  const all = [...sweeps, ...judas];

  if (!all.length) {
    return {
      signals: [],
      primary: { kind: "NONE", detected: false, strength: 0, level: null, note: "لا إشارات تلاعب نشطة." },
      score: 0,
      reasoning: "No manipulation pattern detected against prior session levels.",
    };
  }

  // Primary = strongest
  all.sort((a, b) => b.strength - a.strength);
  const primary = all[0];

  // Score: sign = direction, magnitude = strength
  const bull = all.find(s => s.kind === "BULLISH_SWEEP" || s.kind === "JUDAS_BULL");
  const bear = all.find(s => s.kind === "BEARISH_SWEEP" || s.kind === "JUDAS_BEAR");
  let score = 0;
  if (bull && (!bear || bull.strength > bear.strength)) score = bull.strength;
  if (bear && (!bull || bear.strength > bull.strength)) score = -bear.strength;

  return {
    signals: all,
    primary,
    score,
    reasoning: all.map(s => s.note).join(" • "),
  };
}

export const manipulationScore = (r: ManipulationReport) => r.score;
