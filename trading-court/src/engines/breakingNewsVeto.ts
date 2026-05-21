// ============================================================================
// Breaking News Veto (v3.7b)
//
// Replaces v3.3.1's unconditional WAIT-on-any-breaking with direction-aware
// logic:
//   - CONFLICT (direction LONG with bearish breaking, or SHORT with bullish):
//     hard veto — risk.passed=false. The whipsaw risk in this case is real
//     because the setup will be fighting the news flow.
//   - ALIGNED or NEUTRAL: do NOT veto. Apply a confidence penalty (-8) to
//     acknowledge the volatility, and recompute plan tier/size so downstream
//     consumers see the dampened signal honestly.
//
// Pure function: takes inputs, returns a result object describing what to do.
// court.ts is responsible for applying the result. This makes the logic
// directly testable without spinning up analyzePair().
// ============================================================================

import { RULES } from "../config.js";
import { classifyConfidence, assignTier } from "./tradePlan.js";
import type {
  ConfidenceTier,
  Direction,
  EngineScores,
  NewsReport,
  Tier,
  TradePlan,
} from "../types/index.js";

export interface BreakingVetoInput {
  direction: Direction;
  confidence: number;
  rr1: number | null;
  news: NewsReport;
  pairCcys: Set<string>;
}

export interface BreakingVetoResult {
  applied: boolean;            // any change at all
  vetoed: boolean;             // hard WAIT
  affectedCcys: string[];
  breakingScore: number;
  newConfidence: number;
  newConfidenceTier: ConfidenceTier;
  newSizeMultiplier: number;
  newPlanTier: Tier;
  reason?: string;             // for risk.reasons (veto only)
  warning?: string;            // for warnings (always when applied)
}

const NO_OP = (
  confidence: number,
  rr1: number | null,
): Pick<
  BreakingVetoResult,
  "applied" | "vetoed" | "affectedCcys" | "breakingScore" | "newConfidence"
  | "newConfidenceTier" | "newSizeMultiplier" | "newPlanTier"
> => {
  const [tier, mult] = classifyConfidence(confidence);
  return {
    applied: false,
    vetoed: false,
    affectedCcys: [],
    breakingScore: 0,
    newConfidence: confidence,
    newConfidenceTier: tier,
    newSizeMultiplier: mult,
    newPlanTier: assignTier(confidence, rr1),
  };
};

const ALIGNED_PENALTY = 8;

/**
 * Pure decision function. court.ts wires the result into scores/plan/risk.
 */
export function evaluateBreakingNewsVeto(input: BreakingVetoInput): BreakingVetoResult {
  const { direction, confidence, rr1, news, pairCcys } = input;

  if (!news.breakingActive) return NO_OP(confidence, rr1);

  const affectedCcys = (news.breakingCurrencies ?? []).filter(c => pairCcys.has(c));
  if (affectedCcys.length === 0) return NO_OP(confidence, rr1);

  const brk = news.breakingScore ?? 0;
  const threshold = RULES.breakingNewsConflictThreshold; // 45

  const conflicts =
    (direction === "LONG"  && brk <= -threshold) ||
    (direction === "SHORT" && brk >=  threshold);

  if (conflicts) {
    // Hard veto: news directly contradicts the setup direction.
    const [tier, mult] = classifyConfidence(confidence);
    return {
      applied: true,
      vetoed: true,
      affectedCcys,
      breakingScore: brk,
      newConfidence: confidence,        // unchanged on veto path
      newConfidenceTier: tier,
      newSizeMultiplier: mult,
      newPlanTier: "REJECTED",
      reason:
        `⚡ Breaking news CONFLICT veto: ${affectedCcys.join(",")} ` +
        `(breakingScore ${brk >= 0 ? "+" : ""}${brk}) ` +
        `vs ${direction} setup — stand down`,
      warning:
        `⚡ Breaking news CONFLICT veto on ${affectedCcys.join(",")} ` +
        `(score ${brk >= 0 ? "+" : ""}${brk})`,
    };
  }

  // Aligned or neutral: apply confidence penalty, no veto.
  const newConfidence = Math.max(0, confidence - ALIGNED_PENALTY);
  const [newTier, newMult] = classifyConfidence(newConfidence);
  const newPlanTier = assignTier(newConfidence, rr1);

  const alignmentWord =
    (direction === "LONG"  && brk >=  0) ||
    (direction === "SHORT" && brk <=  0)
      ? "ALIGNED"
      : "NEUTRAL";

  return {
    applied: true,
    vetoed: false,
    affectedCcys,
    breakingScore: brk,
    newConfidence,
    newConfidenceTier: newTier,
    newSizeMultiplier: newMult,
    newPlanTier,
    warning:
      `⚡ Breaking news ${alignmentWord}: confidence ${confidence}→${newConfidence} ` +
      `(${affectedCcys.join(",")}, breakingScore ${brk >= 0 ? "+" : ""}${brk}) — no veto`,
  };
}

/**
 * Convenience: apply the result to scores+plan in place. Caller still pushes
 * `result.reason` to risk.reasons / `result.warning` to warnings as needed.
 */
export function applyBreakingVetoResult(
  scores: EngineScores,
  plan: TradePlan,
  result: BreakingVetoResult,
): void {
  if (!result.applied || result.vetoed) {
    // On veto we don't mutate scores — verdict logic will see risk.passed=false
    // and produce WAIT directly. Keeping scores intact preserves the audit
    // trail of "what the engines actually saw before the news veto".
    return;
  }
  scores.confidence = result.newConfidence;
  scores.confidenceTier = result.newConfidenceTier;
  scores.sizeMultiplier = result.newSizeMultiplier;
  plan.confidenceTier = result.newConfidenceTier;
  plan.sizeMultiplier = result.newSizeMultiplier;
  plan.tier = result.newPlanTier;
}
