// ============================================================================
// Session Engine — FX session classifier with proper overlap handling
// ============================================================================
import { SESSION_WEIGHTS } from "../config.js";
import type { SessionReport } from "../types/index.js";

// Corrected sessions (UTC, standard time):
// - Sydney:  21:00 - 06:00 (spans midnight)
// - Tokyo:   00:00 - 09:00
// - London:  07:00 - 16:00
// - NY:      12:00 - 21:00
// - Overlap London/NY: 12:00 - 16:00 (most liquid)
const SESSIONS: { name: string; start: number; end: number }[] = [
  { name: "SYDNEY", start: 21, end: 30 },   // end 30 means 06:00 next day via modulo
  { name: "TOKYO",  start: 0,  end: 9 },
  { name: "LONDON", start: 7,  end: 16 },
  { name: "NY",     start: 12, end: 21 },
];

const OVERLAP: [number, number] = [12, 16];

function inWindow(hour: number, start: number, end: number): boolean {
  if (end <= 24) return hour >= start && hour < end;
  // spans midnight
  return hour >= start || hour < (end - 24);
}

export function classifySession(nowUtc?: Date): SessionReport {
  const now = nowUtc ?? new Date();
  const h = now.getUTCHours();

  const active = SESSIONS.filter(s => inWindow(h, s.start, s.end)).map(s => s.name);
  const inOverlap = h >= OVERLAP[0] && h < OVERLAP[1];

  let name: SessionReport["name"];
  if (inOverlap) name = "LONDON_NY_OVERLAP";
  else if (active.includes("NY")) name = "NY";
  else if (active.includes("LONDON")) name = "LONDON";
  else if (active.includes("TOKYO") || active.includes("SYDNEY")) name = "ASIA";
  else name = "QUIET";

  const weight = SESSION_WEIGHTS[name];

  let reasoning: string;
  if (name === "LONDON_NY_OVERLAP") {
    reasoning = `UTC ${String(h).padStart(2, "0")}h – London/NY overlap (deepest liquidity), weight x${weight.toFixed(2)}`;
  } else if (name === "LONDON" || name === "NY") {
    reasoning = `UTC ${String(h).padStart(2, "0")}h – ${name} session, weight x${weight.toFixed(2)}`;
  } else if (name === "ASIA") {
    reasoning = `UTC ${String(h).padStart(2, "0")}h – Asia session, thin book, weight x${weight.toFixed(2)}`;
  } else {
    reasoning = `UTC ${String(h).padStart(2, "0")}h – between sessions, weight x${weight.toFixed(2)}`;
  }

  return {
    name,
    active: active.length ? active : ["NONE"],
    weight,
    utcHour: h,
    reasoning,
  };
}

export function applySession(composite: number, confidence: number, weight: number): [number, number] {
  return [
    Math.max(-100, Math.min(100, composite * weight)),
    Math.max(0, Math.min(100, confidence * weight)),
  ];
}
