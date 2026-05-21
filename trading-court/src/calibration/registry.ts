// ============================================================================
// Calibration Registry — v3.9
//
// Loads bundled per-symbol calibration data from calibrationData.json.
// The CLI (`npm run calibrate`) writes this file; the build inlines it.
// Production reads are O(1) lookups against an in-memory map — no I/O.
//
// If you redeploy with a new calibration JSON, the worker picks it up at
// the next build. There is no runtime hot-reload by design — calibration
// is meant to change on a calendar of weeks/months, not seconds, and
// pinning it to deploy events makes the audit trail tractable.
// ============================================================================

import calibrationFile from "./calibrationData.json" with { type: "json" };
import type { CalibrationData } from "./types.js";

interface RegistryShape {
  version: string;
  data: Record<string, CalibrationData>;
}

const REGISTRY: RegistryShape = calibrationFile as unknown as RegistryShape;

/** Returns the calibration record for a symbol, or null when absent. */
export function getCalibration(symbol: string): CalibrationData | null {
  const sym = symbol.toUpperCase();
  return REGISTRY.data?.[sym] ?? null;
}

/** Returns all symbols with calibration data. Useful for dashboard display
 *  ("symbols using empirical confidence: EURUSD, GBPUSD"). */
export function getCalibratedSymbols(): string[] {
  return Object.keys(REGISTRY.data ?? {}).sort();
}

/** Registry version (for diagnostics). */
export function getRegistryVersion(): string {
  return REGISTRY.version ?? "unknown";
}
