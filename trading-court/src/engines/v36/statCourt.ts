// ============================================================================
// Trading Court Pro v3.6 — Statistical Court Overlay
// Directly wraps old analyzePair() output using the real candles already fetched.
// No new API source. No dummy values. Missing/invalid data => WAIT.
// ============================================================================

import type {
  CandleSeries,
  Direction,
  EngineScores,
  PairAnalysis,
  Quote,
  Verdict,
} from "../../types/index.js";

import { classifyConfidence } from "../tradePlan.js";
import { v36TruthGate } from "./truth.js";
import {
  realizedVolBipowerWitness,
  hurstWitness,
  garchWitness,
  hawkesLiteWitness,
} from "./statMath.js";
import type { V36StatCourtResult, V36WitnessResult } from "./statTypes.js";
import { applyJudgeOverride } from "./judgeOverride.js";

// v4.0 priority 6.5-main — MIN_TRUST_SCORE lowered from 60 to 50.
//
// Empirical justification from priority 3b-prep journal data (12h, 686 verdicts):
//   trustScore p25: 45.6
//   trustScore p50: 45.6   ← single mode
//   trustScore p75: 52.3
//   100% of verdicts had trustScore < 60 → trust gate NEVER passed
//
// At threshold 60, the gate is effectively a permanent block, defeating
// the entire purpose of having a confidence-graduated decision system.
// At 50, ~25% of verdicts pass naturally (those at p75 = 52.3+), enabling
// the rest of the v36 pipeline to actually contribute. Verdicts in RANGE
// regime continue to use the lower trustFloor=45 (priority 3.7b), unchanged.
//
// This is paired with the Option D delta change below — together they form
// priority 6.5-main. Lowering threshold without softening delta would let
// weakly-trusted verdicts pass with full -13 penalty, defeating the fix.
const MIN_CONFIDENCE = 77;
const MIN_TRUST_SCORE = 50;
const MIN_DIRECTIONAL_WITNESSES = 2;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function directionToSignal(d: Direction, magnitude: number): number {
  if (d === "LONG") return magnitude;
  if (d === "SHORT") return -magnitude;
  return 0;
}

function signalToDirection(score: number): Direction {
  if (score >= 45) return "LONG";
  if (score <= -45) return "SHORT";
  return "FLAT";
}

function directionToVerdict(d: Direction): Verdict {
  if (d === "LONG") return "BUY";
  if (d === "SHORT") return "SELL";
  return "WAIT";
}

function weightedAverage(items: { value: number; weight: number }[]): number {
  const valid = items.filter(x => Number.isFinite(x.value) && x.weight > 0);
  if (!valid.length) return 0;
  const w = valid.reduce((s, x) => s + x.weight, 0);
  return valid.reduce((s, x) => s + x.value * x.weight, 0) / w;
}

function classicalDirectionalWitnesses(analysis: PairAnalysis): V36WitnessResult[] {
  const out: V36WitnessResult[] = [];

  // Old system evidence, but only as directional witnesses.
  const mtfMag = Math.min(100, Math.abs(analysis.mtf.alignment || 0));
  if (analysis.mtf.direction !== "FLAT" && mtfMag >= 25) {
    out.push({
      name: "HawkesLite", // directional bucket name is not used externally here
      signal: directionToSignal(analysis.mtf.direction, mtfMag),
      confidence: clamp(mtfMag / 100, 0.25, 0.95),
      reliable: true,
      reasons: [`old_mtf=${analysis.mtf.direction}`, `alignment=${analysis.mtf.alignment}`],
      metrics: { source: "old_mtf" },
    });
  }

  const comp = analysis.scores?.composite ?? 0;
  const oldDir = analysis.scores?.direction ?? "FLAT";
  if (oldDir !== "FLAT" && Math.abs(comp) >= 25) {
    out.push({
      name: "HawkesLite",
      signal: directionToSignal(oldDir, Math.min(100, Math.abs(comp))),
      confidence: clamp((analysis.scores.confidence ?? 0) / 100, 0.25, 0.95),
      reliable: true,
      reasons: [`old_composite_dir=${oldDir}`, `old_composite=${comp}`],
      metrics: { source: "old_composite" },
    });
  }

  return out;
}

function hasConflict(witnesses: V36WitnessResult[]): boolean {
  const strong = witnesses.filter(w => w.reliable && Math.abs(w.signal) >= 30);
  return strong.some(w => w.signal > 0) && strong.some(w => w.signal < 0);
}

// Exported as a test seam: lets unit tests verify the decision logic of
// Improvements 1+2 without going through the full witness-math pipeline.
// Production callers should still use `applyV36StatisticalCourt` only.
export function _testOnly_computeV36Court(
  analysis: PairAnalysis,
  statWitnesses: V36WitnessResult[],
): V36StatCourtResult {
  return computeV36Court(analysis, statWitnesses);
}

function computeV36Court(
  analysis: PairAnalysis,
  statWitnesses: V36WitnessResult[],
): V36StatCourtResult {
  const reasons: string[] = [];
  const warnings: string[] = [];

  const classical = classicalDirectionalWitnesses(analysis);
  const directional = [
    ...classical,
    ...statWitnesses.filter(w => w.name === "HawkesLite"),
  ].filter(w => w.reliable);

  const trust = statWitnesses.filter(w =>
    w.reliable &&
    (w.name === "RealizedVolBipower" || w.name === "HurstExponent" || w.name === "GARCH")
  );

  if (directional.length < MIN_DIRECTIONAL_WITNESSES) {
    return {
      allowed: false,
      side: "FLAT",
      sideScore: 0,
      trustScore: 0,
      confidenceCap: 0,
      confidenceDelta: 0,
      witnesses: statWitnesses,
      reasons: [`v36_not_enough_directional_witnesses_${directional.length}`],
      warnings,
    };
  }

  if (hasConflict(directional)) {
    return {
      allowed: false,
      side: "FLAT",
      sideScore: 0,
      trustScore: 0,
      confidenceCap: 0,
      confidenceDelta: 0,
      witnesses: statWitnesses,
      reasons: ["v36_direction_conflict"],
      warnings,
    };
  }

  const sideScore = clamp(
    weightedAverage(directional.map(w => ({ value: w.signal, weight: w.confidence }))),
    -100,
    100,
  );

  const trustRaw = weightedAverage(trust.map(w => ({ value: w.signal, weight: w.confidence })));
  let trustScore = clamp(50 + trustRaw * 0.5, 0, 100);

  // v3.7b — Range-aware trust floor.
  // The fixed trustScore floor of 60 implicitly required Hurst > 0.58 (trending
  // market) which silently killed every clean range setup, even ones with
  // perfect MTF alignment. In a RANGE regime, mean-reverting behavior is the
  // signal itself, not a defect — so we accept a lower trustFloor (45) and we
  // do NOT treat "mean_reverting_environment" as a blocking risk.
  // Truth gate is unchanged. This only relaxes opportunity assessment.
  const isRangeRegime = analysis.regime?.label === "RANGE";

  let confidenceCap = 100;

  for (const w of trust) {
    if (w.name === "RealizedVolBipower" && w.signal <= -35) {
      confidenceCap = Math.min(confidenceCap, 65);
      reasons.push("v36_jump_or_spike_risk");
    }
    if (w.name === "GARCH" && w.signal <= -35) {
      confidenceCap = Math.min(confidenceCap, 72);
      reasons.push("v36_garch_unstable");
    }
    if (w.name === "HurstExponent" && w.signal < 0) {
      if (isRangeRegime) {
        // In RANGE regime, mean-reverting Hurst is consistent with the regime,
        // not a risk signal. Record the observation but do NOT cap confidence —
        // otherwise the 72 cap silently blocks every range trade below the
        // 77 MIN_CONFIDENCE threshold.
        reasons.push("v36_mean_reverting_consistent_with_range");
      } else {
        confidenceCap = Math.min(confidenceCap, 72);
        reasons.push("v36_mean_reverting_environment");
      }
    }
  }

  const side = signalToDirection(sideScore);
  if (side === "FLAT") reasons.push("v36_side_score_too_weak");

  // v3.7b — Range-aware trust floor.
  // (isRangeRegime declared above when computing the cap.) RANGE accepts a
  // lower trustFloor of 45 because mean-reverting Hurst is the regime signal,
  // not a defect.
  const trustFloor = isRangeRegime ? 45 : MIN_TRUST_SCORE;

  if (trustScore < trustFloor) {
    reasons.push(isRangeRegime ? "v36_trust_score_below_45_range" : "v36_trust_score_below_60");
  }

  // v4.0 priority 6.5-main — Option D: linear trustMargin × sideMag formula.
  //
  // PROBLEM IDENTIFIED (experiment a + experiment c, May 5 2026):
  //   Production confidence p99 = 26, max = 36, threshold = 77. Zero verdicts
  //   ever reached BUY/SELL because the v3.7b delta produced -13 in the
  //   typical case (trustScore<60 → -8, cap fires → -5), compressing all
  //   confidence values into [0, 36] regardless of input strength.
  //
  // EVIDENCE FROM 3b-prep DATA (May 7, 686 verdicts):
  //   trustScore is essentially binary per pair: either ~45.6 or ~52.3.
  //   Both modes below the old MIN_TRUST_SCORE=60. Trust gate never passed.
  //
  // OPTION D RATIONALE:
  //   Replace the tier-based delta {+6, +4, -8, -5} with a continuous
  //   function of (trustScore - trustFloor) × |sideScore|. Properties:
  //     - No cliffs at trust 60/70 (which were never reached in prod)
  //     - Penalty smoothly proportional to deficit AND directional weakness
  //     - Boost smoothly proportional to surplus AND directional strength
  //     - Clamped to [-10, +15] to prevent over-correction either way
  //     - Cap penalty reduced from -5 to -2 (too harsh empirically)
  //
  // CALIBRATION CHECK on real production scenarios:
  //   trust=45.6, side=30, cap fires (typical):
  //     old: -8 -5 = -13
  //     new: clamp((45.6-50)*30/250, -10, +15) - 2 = -0.53 - 2 = -2.53
  //   trust=52, side=70, no cap (good aligned):
  //     old: 0 (locked out by trust<60 boost gate)
  //     new: clamp((52-50)*70/250, -10, +15) - 0 = +0.56
  //   trust=40, side=20, cap fires (very weak):
  //     old: -8 -5 = -13
  //     new: clamp((40-50)*20/250, -10, +15) - 2 = -0.8 - 2 = -2.8
  //
  // The 250 constant is the calibration knob: it sets the rate at which
  // (margin × sideMag) translates to confidence units. Picked so that
  // the typical aligned case (margin=10, sideMag=50) yields ~+2 boost.
  // Smaller value (e.g. 100) would amplify the formula's effect.
  const trustMargin = trustScore - trustFloor;
  const sideMag = Math.abs(sideScore);
  let confidenceDelta = clamp((trustMargin * sideMag) / 250, -10, +15);
  if (confidenceCap < 100) confidenceDelta -= 2;

  const oldConf = analysis.scores.confidence ?? 0;
  const newConf = Math.min(confidenceCap, clamp(oldConf + confidenceDelta, 0, 100));

  // Build blocking-reason filter:
  //   - jump risk and GARCH instability ALWAYS block (environmental danger)
  //   - mean_reverting blocks only OUTSIDE a range regime
  const blockingReasons = reasons.filter(r => {
    if (r.includes("risk") || r.includes("unstable")) return true;
    if (r.includes("mean_reverting")) return !isRangeRegime; // allowed inside RANGE
    return false;
  });

  const allowed =
    side !== "FLAT" &&
    newConf >= MIN_CONFIDENCE &&
    trustScore >= trustFloor &&
    blockingReasons.length === 0;

  return {
    allowed,
    side,
    sideScore,
    trustScore,
    confidenceCap,
    confidenceDelta,
    witnesses: statWitnesses,
    reasons,
    warnings,
  };
}

export function applyV36StatisticalCourt(
  analysis: PairAnalysis,
  input: {
    symbol: string;
    quote: Quote;
    series: Record<string, CandleSeries>;
  },
): PairAnalysis {
  const truth = v36TruthGate(input.symbol, input.quote, input.series);

  // v4.0 priority 7 (D5) — switched statistical witnesses from H1 to M15.
  //
  // BACKGROUND:
  //   Production analysis on 1456 stage1h verdicts (May 7-8 2026) revealed
  //   that trustScore had stdev=0.0 for 6 of 7 pairs over a 22-hour sample.
  //   Root cause: all 4 witnesses (RV-B, Hurst, GARCH, Hawkes) computed on
  //   H1 candles. H1 updates once per hour; with poll cadence of ~10s, this
  //   meant 50+ verdicts within a single H1 produced identical witness
  //   outputs → identical trustScore → duplicate VALID/REJECT verdicts.
  //
  //   The 35 USDCHF VALID verdicts (May 8 retrospective) were a single
  //   trade snapshot repeated 35 times across one TREND_DOWN H1 in NY
  //   session. Without D5 fix, priority 8 (MIN_CONFIDENCE tuning) would
  //   produce duplicate-spam BUY/SELL signals.
  //
  // DECISION: M15
  //   - M15 = 4 candles per hour, fresh witness output every 15 minutes
  //   - Sample sizes still healthy: 1 week of M15 = 672 candles vs 128
  //     required by Hurst (the strictest witness)
  //   - Series already fetched (used by priceAction, divergence, MTF)
  //   - Truth gate already validates M15 (truth.ts REQUIRED includes "15m")
  //   - Alternatives rejected: M5 (too noisy, microstructure dominates),
  //     M30 (still too coarse — 64h for Hurst's 128 minimum)
  //
  // RISK ACKNOWLEDGED:
  //   GARCH persistence (alpha+beta) tends to be higher at finer timescales
  //   (well-known stylized fact: volatility clustering is more pronounced
  //   intraday). The threshold persistence > 0.97 = "non_stationary_risk"
  //   may fire more often at M15 than H1. We accept this risk for the
  //   single-variable change discipline; if false-firing emerges in 48h
  //   data, we tune persistence bands in a follow-up patch.
  //
  // FORMULA CHANGES: NONE.
  //   Witness math (jumpRatio bands, hurst bands, persistence bands) is
  //   unchanged from priority 6.5. We change ONE variable: the input
  //   timeframe. This isolates the measurement signal: any difference in
  //   trustScore distribution is attributable to timeframe granularity,
  //   not threshold tuning.
  const m15 = input.series["15m"]?.candles ?? [];

  const statWitnesses: V36WitnessResult[] = truth.ok ? [
    realizedVolBipowerWitness(m15),
    hurstWitness(m15),
    garchWitness(m15),
    hawkesLiteWitness(m15),
  ] : [];

  const court = truth.ok
    ? computeV36Court(analysis, statWitnesses)
    : {
        allowed: false,
        side: "FLAT" as Direction,
        sideScore: 0,
        trustScore: 0,
        confidenceCap: 0,
        confidenceDelta: 0,
        witnesses: statWitnesses,
        reasons: truth.reasons,
        warnings: truth.warnings,
      };

  const oldConfidence = analysis.scores.confidence ?? 0;
  const newConfidence = truth.ok
    ? Math.min(court.confidenceCap, clamp(oldConfidence + court.confidenceDelta, 0, 100))
    : 0;

  const [confidenceTier, sizeMultiplier] = classifyConfidence(newConfidence);

  let nextVerdict: Verdict = analysis.verdict;
  let nextDirection: Direction = analysis.scores.direction;

  // Hard truth failure always WAIT.
  if (!truth.ok) {
    nextVerdict = "WAIT";
    nextDirection = "FLAT";
  } else if (!court.allowed) {
    nextVerdict = "WAIT";
    nextDirection = "FLAT";
  } else {
    nextDirection = court.side;
    nextVerdict = directionToVerdict(court.side);
  }

  const v36Reasons = [
    ...truth.reasons,
    ...court.reasons,
  ];

  const warnings = [
    ...analysis.warnings,
    ...truth.warnings.map(w => `V36 Truth: ${w}`),
    ...court.warnings.map(w => `V36: ${w}`),
    ...v36Reasons.map(r => `V36 Gate: ${r}`),
  ];

  const scores: EngineScores = {
    ...analysis.scores,
    direction: nextDirection,
    confidence: newConfidence,
    confidenceTier,
    sizeMultiplier,
  };

  const plan = {
    ...analysis.plan,
    direction: nextDirection,
    confidenceTier,
    sizeMultiplier,
    notes: [
      ...analysis.plan.notes,
      ...v36Reasons.map(r => `V36: ${r}`),
    ],
  };

  return applyJudgeOverride({
    ...analysis,
    scores,
    plan,
    verdict: nextVerdict,
    warnings,
    summary: nextVerdict === "WAIT"
      ? `${analysis.summary} | V36 Statistical Court: WAIT (${v36Reasons.join(", ") || "risk/truth gate"})`
      : `${analysis.summary} | V36 Statistical Court: confirmed`,
    verdictExplanation: {
      ...analysis.verdictExplanation,
      why: [
        ...analysis.verdictExplanation.why,
        `V36 trustScore ${court.trustScore.toFixed(0)}, sideScore ${court.sideScore.toFixed(1)}, confidenceCap ${court.confidenceCap}`,
      ],
      missing: nextVerdict === "WAIT"
        ? [...analysis.verdictExplanation.missing, ...v36Reasons]
        : analysis.verdictExplanation.missing,
      nextSteps: nextVerdict === "WAIT"
        ? [...analysis.verdictExplanation.nextSteps, "Wait until V36 truth/statistical gates clear"]
        : analysis.verdictExplanation.nextSteps,
    },
    ...({
      v36: {
        truth,
        court,
        oldConfidence,
        newConfidence,
        witnesses: statWitnesses,
      },
    } as any),
  });
}
