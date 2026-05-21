// ============================================================================
// Calendar Surprise → News Feedback Engine
//
// NEW — Priorität 1 (höchste Wirkung, geringster Aufwand)
//
// PROBLEM bisher:
//   calendar.ts erkennt ob ein Event "BETTER/WORSE" war.
//   newsEngine.ts ignoriert diese Information komplett.
//   Ein FOMC-Überraschung → News-Score bleibt bei 0.
//
// LÖSUNG:
//   Diese Engine liest vergangene Calendar-Events mit bekanntem Actual-Wert,
//   bewertet die Surprise-Magnitude und generiert einen Währungs-Bias der
//   in analyzeNews() injiziert wird.
//
// Decay-Funktion:
//   Surprise-Wirkung dauert 2h bei HIGH-Impact, 1h bei MEDIUM, 30min bei LOW.
//   Lineare Abklingkurve bis 0.
//
// Gewichtung:
//   HIGH + großes Delta   → ±50 Bonus auf Pair-Score
//   HIGH + kleines Delta  → ±20
//   MEDIUM + Delta        → ±15
//   INLINE (unverändert)  → 0 (kein Einfluss)
// ============================================================================
import type { CalendarEvent } from "../types/index.js";

export interface SurpriseSignal {
  currency: string;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  magnitude: number;          // 0..100 — Stärke des Impulses
  decayFactor: number;        // 0..1 — verbleibende Stärke nach Zeit-Decay
  eventTitle: string;
  minutesAgo: number;
  reasoning: string;
}

export interface CalendarFeedbackReport {
  signals: SurpriseSignal[];
  currencyBonus: Record<string, number>;  // currency → score bonus (-100..+100)
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Wie lange wirkt eine Überraschung?
// ---------------------------------------------------------------------------
function halfLifeMinutes(impact: "LOW" | "MEDIUM" | "HIGH"): number {
  return impact === "HIGH" ? 120 : impact === "MEDIUM" ? 60 : 30;
}

// ---------------------------------------------------------------------------
// Basis-Magnitude der Überraschung (unabhängig von Decay)
// ---------------------------------------------------------------------------
function baseMagnitude(
  impact: "LOW" | "MEDIUM" | "HIGH",
  surpriseDir: string | null | undefined,
): number {
  if (!surpriseDir || surpriseDir === "INLINE") return 0;
  switch (impact) {
    case "HIGH":   return 50;
    case "MEDIUM": return 20;
    case "LOW":    return 8;
  }
}

// ---------------------------------------------------------------------------
// PUBLIC API — Analysiert vergangene Calendar-Events und gibt Currency-Bonus
// ---------------------------------------------------------------------------
export function computeCalendarFeedback(events: CalendarEvent[]): CalendarFeedbackReport {
  const signals: SurpriseSignal[] = [];
  const currencyBonus: Record<string, number> = {};

  // Nur vergangene Events mit bekanntem Actual-Wert
  const completed = events.filter(e =>
    e.actual &&
    e.minutesFromNow < 0 &&                // in der Vergangenheit
    e.minutesFromNow >= -240 &&            // max 4h zurück
    e.surpriseDir != null,
  );

  for (const ev of completed) {
    const minutesAgo = Math.abs(ev.minutesFromNow);
    const halfLife = halfLifeMinutes(ev.impact);
    const mag = baseMagnitude(ev.impact, ev.surpriseDir);
    if (mag === 0) continue;

    // Linearer Decay über 2× die Halbwertszeit
    const maxAge = halfLife * 2;
    const decayFactor = Math.max(0, 1 - minutesAgo / maxAge);
    if (decayFactor < 0.05) continue;   // vernachlässigbar klein

    const effectiveMag = Math.round(mag * decayFactor);
    if (effectiveMag < 2) continue;

    // Richtung: BETTER = gut für die Währung, WORSE = schlecht
    const dir: "BULLISH" | "BEARISH" | "NEUTRAL" =
      ev.surpriseDir === "BETTER" ? "BULLISH" :
      ev.surpriseDir === "WORSE"  ? "BEARISH" : "NEUTRAL";

    const scoreContrib = dir === "BULLISH" ? effectiveMag : dir === "BEARISH" ? -effectiveMag : 0;

    // Kumuliere pro Währung
    const ccy = ev.country;
    currencyBonus[ccy] = (currencyBonus[ccy] ?? 0) + scoreContrib;

    signals.push({
      currency: ccy,
      direction: dir,
      magnitude: effectiveMag,
      decayFactor: Math.round(decayFactor * 100) / 100,
      eventTitle: ev.title,
      minutesAgo: Math.round(minutesAgo),
      reasoning: `${ev.impact} ${ccy} "${ev.title}" ${minutesAgo.toFixed(0)}min ago: ${ev.surpriseDir} (decay ${(decayFactor * 100).toFixed(0)}%)`,
    });
  }

  // Cap per Währung bei ±80 um Extremwerte zu vermeiden
  for (const ccy of Object.keys(currencyBonus)) {
    currencyBonus[ccy] = Math.max(-80, Math.min(80, Math.round(currencyBonus[ccy])));
  }

  const summaryParts = signals.map(s =>
    `${s.currency} ${s.direction} +${s.magnitude}pts (${s.minutesAgo}m ago)`,
  );

  return {
    signals,
    currencyBonus,
    reasoning: summaryParts.length
      ? `Calendar feedback: ${summaryParts.join(" | ")}`
      : "No recent calendar surprises with active decay",
  };
}
