// ============================================================================
// Trading Court Pro v3.6 — Statistical Court Types
// Direct integration with existing v3.5.6 types.
// No dummy data. No synthetic prices. No random numbers.
// ============================================================================

import type { Candle } from "../../types/index.js";

export type V36WitnessName =
  | "RealizedVolBipower"
  | "HurstExponent"
  | "GARCH"
  | "HawkesLite"
  | "ForbesRigobon";

export type V36Side = "LONG" | "SHORT" | "FLAT";

export interface V36WitnessResult {
  name: V36WitnessName;
  signal: number;       // -100..+100
  confidence: number;   // 0..1
  reliable: boolean;
  reasons: string[];
  metrics?: Record<string, number | string | boolean | null>;
}

export interface V36TruthResult {
  ok: boolean;
  reasons: string[];
  warnings: string[];
}

export interface V36StatCourtResult {
  allowed: boolean;
  side: V36Side;
  sideScore: number;
  trustScore: number;
  confidenceCap: number;
  confidenceDelta: number;
  witnesses: V36WitnessResult[];
  reasons: string[];
  warnings: string[];
}

export interface V36CandleBundle {
  m5: Candle[];
  m15: Candle[];
  h1: Candle[];
  h4: Candle[];
}
