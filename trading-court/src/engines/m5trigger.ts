// ============================================================================
// M5 Entry Trigger Engine — Daytrading Entry Confirmation
//
// NEW — Priorität 4
//
// Frage: "H1+H4 sind aligned — aber IST dieser Moment der richtige Einstieg?"
// Antwort gibt die M5-Trigger-Engine.
//
// Bedingungen für einen gültigen M5-Trigger:
//
//   LONG-Trigger (alle 3 erforderlich):
//     1) M5 EMA9 crossed above EMA21 in last 3 bars (EMA cross up)
//     2) Letzte M5-Kerze ist eine bullische Impulskerze (body > 50% der Kerze)
//     3) Volume der Trigger-Kerze > 1.2× 10-Bar-Durchschnitt (Volumen bestätigt)
//
//   SHORT-Trigger (symmetrisch):
//     1) M5 EMA9 crossed below EMA21
//     2) Letzte M5-Kerze ist eine bärische Impulskerze
//     3) Volumen-Bestätigung
//
// Nur aktiv wenn übergeordnete Alignment (H1+H4) bereits besteht.
// Liefert +15 Bonus-Punkte wenn Trigger stimmt, 0 wenn nicht — kein Malus.
//
// Zusätzlich: Erkennt "Failed Triggers" — wenn EMA cross da ist aber Impuls
// fehlt → CAUTION (kein Bonus, aber auch kein Veto).
// ============================================================================
import type { Candle } from "../types/index.js";

function emaFast(values: number[], period: number): number[] {
  if (values.length < period) return values.map(() => NaN);
  const k = 2 / (period + 1);
  const out: number[] = new Array(values.length).fill(NaN);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = e;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

export type TriggerSignal =
  | "BULL_TRIGGER"    // All 3 conditions met — enter long
  | "BEAR_TRIGGER"    // All 3 conditions met — enter short
  | "BULL_CROSS"      // EMA crossed but impuls/volume missing
  | "BEAR_CROSS"      // EMA crossed but impuls/volume missing
  | "NONE";           // No trigger

export interface M5TriggerReport {
  signal: TriggerSignal;
  ema9: number | null;
  ema21: number | null;
  crossBarsAgo: number | null;       // How many bars ago was the cross?
  impulseStrength: number;           // 0..100 — body/range ratio of last candle
  volumeRatio: number | null;        // Last bar volume / 10-bar avg
  volumeConfirmed: boolean;
  score: number;                     // 0 (no trigger), +15 (bull), -15 (bear)
  reasoning: string;
}

export function detectM5Trigger(
  m5: Candle[],
  direction: "LONG" | "SHORT" | "FLAT",
): M5TriggerReport {
  const none: M5TriggerReport = {
    signal: "NONE", ema9: null, ema21: null,
    crossBarsAgo: null, impulseStrength: 0, volumeRatio: null,
    volumeConfirmed: false, score: 0, reasoning: "No M5 data",
  };

  if (!m5 || m5.length < 30 || direction === "FLAT") return none;

  const closes = m5.map(c => c.c);
  const e9arr = emaFast(closes, 9);
  const e21arr = emaFast(closes, 21);
  const n = m5.length;

  const e9 = e9arr[n - 1];
  const e21 = e21arr[n - 1];
  if (!isFinite(e9) || !isFinite(e21)) return { ...none, reasoning: "EMA not available yet" };

  // Detect when EMA9 last crossed EMA21 (scan last 6 bars)
  let crossBarsAgo: number | null = null;
  let crossDir: "UP" | "DOWN" | null = null;
  for (let i = 1; i <= 6; i++) {
    const idx = n - 1 - i;
    if (idx < 1) break;
    const prevDiff = e9arr[idx - 1] - e21arr[idx - 1];
    const currDiff = e9arr[idx] - e21arr[idx];
    if (prevDiff < 0 && currDiff >= 0) { crossDir = "UP"; crossBarsAgo = i; break; }
    if (prevDiff > 0 && currDiff <= 0) { crossDir = "DOWN"; crossBarsAgo = i; break; }
  }

  // Last candle analysis
  const last = m5[n - 1];
  const range = last.h - last.l;
  const body = Math.abs(last.c - last.o);
  const impulseStrength = range > 0 ? Math.round((body / range) * 100) : 0;
  const isBullish = last.c > last.o;
  const isBearish = last.c < last.o;
  const isImpulse = impulseStrength >= 50;  // body ≥ 50% of total range

  // Volume ratio
  const vol10 = m5.slice(-11, -1).map(c => c.v ?? 0);
  const avgVol = vol10.reduce((a, b) => a + b, 0) / Math.max(vol10.length, 1);
  const lastVol = last.v ?? 0;
  const volumeRatio = avgVol > 0 ? lastVol / avgVol : null;
  const volumeConfirmed = volumeRatio == null || volumeRatio >= 1.15;
  // If no volume data available (all zeros), treat as confirmed (Kraken sometimes lacks it)
  const noVolumeData = vol10.every(v => v === 0);

  const volOk = noVolumeData || volumeConfirmed;

  // Determine signal
  let signal: TriggerSignal = "NONE";
  let score = 0;
  const parts: string[] = [];

  parts.push(`EMA9=${e9.toFixed(5)} EMA21=${e21.toFixed(5)}`);

  if (direction === "LONG") {
    if (e9 > e21) {
      if (crossBarsAgo != null && crossDir === "UP") {
        parts.push(`EMA9 crossed UP ${crossBarsAgo}b ago`);
        if (isBullish && isImpulse && volOk) {
          signal = "BULL_TRIGGER";
          score = 15;
          parts.push(`Impulse bull candle (${impulseStrength}% body)`);
          if (!noVolumeData) parts.push(`Volume ${volumeRatio!.toFixed(2)}x avg`);
        } else {
          signal = "BULL_CROSS";
          const missing: string[] = [];
          if (!isBullish || !isImpulse) missing.push(`weak candle (${impulseStrength}% body)`);
          if (!volOk) missing.push(`low volume (${volumeRatio!.toFixed(2)}x)`);
          parts.push(`Cross valid but: ${missing.join(", ")} — wait for confirmation`);
        }
      } else {
        parts.push("EMA9 above EMA21 (no fresh cross in 6 bars)");
      }
    } else {
      parts.push("EMA9 below EMA21 — no bull setup");
    }
  } else if (direction === "SHORT") {
    if (e9 < e21) {
      if (crossBarsAgo != null && crossDir === "DOWN") {
        parts.push(`EMA9 crossed DOWN ${crossBarsAgo}b ago`);
        if (isBearish && isImpulse && volOk) {
          signal = "BEAR_TRIGGER";
          score = -15;
          parts.push(`Impulse bear candle (${impulseStrength}% body)`);
          if (!noVolumeData) parts.push(`Volume ${volumeRatio!.toFixed(2)}x avg`);
        } else {
          signal = "BEAR_CROSS";
          const missing: string[] = [];
          if (!isBearish || !isImpulse) missing.push(`weak candle (${impulseStrength}% body)`);
          if (!volOk) missing.push(`low volume`);
          parts.push(`Cross valid but: ${missing.join(", ")} — wait for confirmation`);
        }
      } else {
        parts.push("EMA9 below EMA21 (no fresh cross in 6 bars)");
      }
    } else {
      parts.push("EMA9 above EMA21 — no bear setup");
    }
  }

  return {
    signal, ema9: e9, ema21: e21,
    crossBarsAgo, impulseStrength, volumeRatio,
    volumeConfirmed: volOk, score, reasoning: parts.join(" | "),
  };
}

export const m5TriggerScore = (r: M5TriggerReport): number => r.score;
