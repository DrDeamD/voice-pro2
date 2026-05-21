// ============================================================================
// Confluence Counter — v4.2 Phase 1
//
// Decomposes composite into per-engine contributions so the dashboard can
// show "7 of 10 engines support BUY" as a transparent breakdown.
//
// This is a PURE function over EngineScores. It does not change the verdict
// or trigger any new behaviour — it only produces an audit-friendly view of
// what the existing scoring already says.
// ============================================================================

import { WEIGHTS, DYNAMIC_WEIGHTS } from "../config.js";
import type { Direction, EngineScores } from "../types/index.js";

export interface EngineContribution {
  engine: string;
  /** Raw engine score, -100..+100 */
  score: number;
  /** Effective weight after dynamic-weight overrides */
  weight: number;
  /** Signed contribution to composite (score × weight) */
  contribution: number;
  /** Does this engine support the current direction? */
  supports: "YES" | "NO" | "NEUTRAL";
}

export interface ConfluenceReport {
  direction: Direction;
  totalEngines: number;
  /** Number of engines whose contribution moves composite in the direction's sign */
  supporting: number;
  opposing: number;
  neutral: number;
  /** Engines listed by absolute contribution descending */
  breakdown: EngineContribution[];
  /** "7/10 engines support BUY" */
  summary: string;
}

const ENGINE_KEYS: Array<{ key: string; weightKey: keyof typeof WEIGHTS }> = [
  { key: "marketStructure", weightKey: "marketStructure" },
  { key: "mtf",             weightKey: "mtf" },
  { key: "momentum",        weightKey: "momentum" },
  { key: "vwap",            weightKey: "vwap" },
  { key: "priceAction",     weightKey: "priceAction" },
  { key: "manipulation",    weightKey: "manipulation" },
  { key: "divergence",      weightKey: "divergence" },
  { key: "regime",          weightKey: "regime" },
  { key: "correlation",     weightKey: "correlation" },
  { key: "news",            weightKey: "news" },
];

const NEUTRAL_THRESHOLD = 2; // |contribution| below this counts as NEUTRAL

export function computeConfluence(
  scores: EngineScores,
  highImpactActive: boolean = false,
  breakingActive: boolean = false,
): ConfluenceReport {
  // Determine effective weights (same logic as resolveWeights in court.ts)
  const effective: Record<string, number> = { ...WEIGHTS };
  if (breakingActive) Object.assign(effective, DYNAMIC_WEIGHTS.breakingNews);
  else if (highImpactActive) Object.assign(effective, DYNAMIC_WEIGHTS.highImpactNews);

  const direction = scores.direction;
  const dirSign = direction === "LONG" ? +1 : direction === "SHORT" ? -1 : 0;

  const breakdown: EngineContribution[] = [];
  let supporting = 0, opposing = 0, neutral = 0;

  for (const { key } of ENGINE_KEYS) {
    const score = Number((scores as any)[key] ?? 0);
    const weight = Number(effective[key] ?? 0);
    const contribution = Math.round(score * weight * 100) / 100;

    let supports: EngineContribution["supports"] = "NEUTRAL";
    if (Math.abs(contribution) >= NEUTRAL_THRESHOLD && dirSign !== 0) {
      const sign = Math.sign(contribution);
      if (sign === dirSign) { supports = "YES"; supporting++; }
      else { supports = "NO"; opposing++; }
    } else {
      neutral++;
    }

    breakdown.push({
      engine: key,
      score: Math.round(score * 10) / 10,
      weight: Math.round(weight * 1000) / 1000,
      contribution,
      supports,
    });
  }

  // Sort by absolute contribution descending — most influential engines first
  breakdown.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  const totalEngines = ENGINE_KEYS.length;
  const summary = direction === "FLAT"
    ? `Direction FLAT — no clear consensus (${neutral} neutral, ${supporting + opposing} active)`
    : `${supporting}/${totalEngines} engines support ${direction === "LONG" ? "BUY" : "SELL"}, ` +
      `${opposing} oppose, ${neutral} neutral. ` +
      `Top contributor: ${breakdown[0]?.engine ?? "n/a"} (${breakdown[0]?.contribution ?? 0})`;

  return {
    direction,
    totalEngines,
    supporting,
    opposing,
    neutral,
    breakdown,
    summary,
  };
}
