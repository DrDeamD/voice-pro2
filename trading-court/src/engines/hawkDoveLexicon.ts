// ============================================================================
// Hawkish / Dovish Lexicon & Scorer — v4.2 Phase 2
//
// Converts central-bank text (speeches, statements, press releases) into a
// quantified policy stance: -5 (ultra dovish) to +5 (ultra hawkish).
//
// How it works:
//   1. Hand-curated lexicon of ~120 phrases with weights.
//   2. Title + description scanned case-insensitively. Each match contributes
//      its weight. Multiple matches sum (capped per direction).
//   3. Speaker-authority multiplier: Powell speech weighed more than Bowman.
//   4. Result: { score, phrasesMatched, speakerWeight, effectiveImpact }
//
// Why rule-based, not LLM:
//   - Deterministic, reproducible
//   - No API cost
//   - The phrases that move markets are well-known finite set
//   - Failure mode is FALSE NEGATIVE (miss a phrase) not FALSE POSITIVE
//     (which is what we want — under-react is safer than over-react)
//
// Calibration note:
//   Weights are educated from typical central-bank language semantics. After
//   ~3 months of journal data we can re-derive empirically by correlating
//   speech timestamps with subsequent currency moves.
// ============================================================================

export interface HawkDoveResult {
  /** -5 (ultra dovish) to +5 (ultra hawkish). 0 = neutral / no signal. */
  score: number;
  /** Raw phrase matches before clamping. */
  phrasesMatched: { phrase: string; weight: number }[];
  /** Speaker authority multiplier 0..1. 1.0 for highest-impact speakers. */
  speakerWeight: number;
  /** score × 10 × speakerWeight — what gets injected into news sentiment */
  effectiveImpact: number;
  /** Which speaker (if found) drove the speakerWeight */
  speaker: string | null;
}

interface LexEntry { phrase: string; weight: number; }

// Phrases listed in CAPS for direct comparison after toUpperCase().
const HAWKISH: LexEntry[] = [
  // Ultra hawkish (weight +4..+5)
  { phrase: "MUST RAISE RATES",            weight: +5 },
  { phrase: "DECISIVE ACTION NEEDED",      weight: +4 },
  { phrase: "EMERGENCY HIKE",              weight: +5 },
  { phrase: "INFLATION OUT OF CONTROL",    weight: +5 },
  { phrase: "ACCELERATE TIGHTENING",       weight: +4 },
  { phrase: "AGGRESSIVE TIGHTENING",       weight: +4 },
  { phrase: "RESTRICTIVE STANCE",          weight: +3 },
  // Strong hawkish (+3)
  { phrase: "STAY HIGHER FOR LONGER",      weight: +3 },
  { phrase: "HIGHER FOR LONGER",           weight: +3 },
  { phrase: "ADDITIONAL FIRMING",          weight: +3 },
  { phrase: "FURTHER RATE INCREASES",      weight: +3 },
  { phrase: "INFLATION IS TOO HIGH",       weight: +3 },
  { phrase: "BALANCE SHEET RUNOFF",        weight: +3 },
  { phrase: "QUANTITATIVE TIGHTENING",     weight: +3 },
  { phrase: "PIVOT POSTPONED",             weight: +3 },
  { phrase: "WAGES RISING RAPIDLY",        weight: +3 },
  { phrase: "RATE HIKES NOT FINISHED",     weight: +3 },
  { phrase: "MORE WORK TO DO",             weight: +2 },
  // Moderate hawkish (+2)
  { phrase: "TIGHT LABOR MARKET",          weight: +2 },
  { phrase: "TIGHT LABOUR MARKET",         weight: +2 },
  { phrase: "INFLATION REMAINS ELEVATED",  weight: +2 },
  { phrase: "STICKY INFLATION",            weight: +2 },
  { phrase: "INFLATION PERSISTENCE",       weight: +2 },
  { phrase: "CONSIDERATION OF FURTHER",    weight: +2 },
  { phrase: "RESILIENT ECONOMY",           weight: +2 },
  { phrase: "STRONG JOBS REPORT",          weight: +2 },
  { phrase: "TIGHTENING BIAS",             weight: +2 },
  // Light hawkish (+1)
  { phrase: "PATIENT BUT VIGILANT",        weight: +1 },
  { phrase: "INFLATION ABOVE TARGET",      weight: +1 },
  { phrase: "CAUTIOUS ABOUT CUTS",         weight: +1 },
  { phrase: "EARLY TO CUT",                weight: +1 },
  { phrase: "PREMATURE TO EASE",           weight: +1 },
  { phrase: "DATA-DEPENDENT",              weight: +1 },  // ambiguous but usually leans hawk vs market expectation
  { phrase: "VIGILANT",                    weight: +1 },
  { phrase: "HAWKISH",                     weight: +1 },
];

const DOVISH: LexEntry[] = [
  // Ultra dovish (-4..-5)
  { phrase: "EMERGENCY CUT",               weight: -5 },
  { phrase: "MUST CUT RATES",              weight: -5 },
  { phrase: "EASE MONETARY POLICY",        weight: -4 },
  { phrase: "AGGRESSIVE EASING",           weight: -4 },
  { phrase: "BALANCE SHEET EXPANSION",     weight: -4 },
  { phrase: "QUANTITATIVE EASING",         weight: -4 },
  { phrase: "ZERO LOWER BOUND",            weight: -4 },
  { phrase: "RECESSION RISK",              weight: -4 },
  // Strong dovish (-3)
  { phrase: "READY TO CUT",                weight: -3 },
  { phrase: "ROOM TO CUT",                 weight: -3 },
  { phrase: "EASING CYCLE",                weight: -3 },
  { phrase: "DOWNSIDE RISKS",              weight: -3 },
  { phrase: "ECONOMY SLOWING",             weight: -3 },
  { phrase: "GROWTH SLOWING",              weight: -3 },
  { phrase: "BELOW TARGET",                weight: -3 },
  { phrase: "COOLING INFLATION",           weight: -3 },
  { phrase: "INFLATION COMING DOWN",       weight: -3 },
  { phrase: "DISINFLATION",                weight: -3 },
  { phrase: "LABOR MARKET COOLING",        weight: -3 },
  { phrase: "LABOUR MARKET COOLING",       weight: -3 },
  { phrase: "SOFTEN LABOR MARKET",         weight: -3 },
  { phrase: "EASE LABOR MARKET",           weight: -3 },
  { phrase: "WAGE GROWTH SLOWING",         weight: -3 },
  // Moderate dovish (-2)
  { phrase: "PATIENT STANCE",              weight: -2 },
  { phrase: "TRANSITORY",                  weight: -2 },
  { phrase: "ACKNOWLEDGE PROGRESS",        weight: -2 },
  { phrase: "INFLATION DECLINING",         weight: -2 },
  { phrase: "GROWTH RISKS",                weight: -2 },
  { phrase: "BELOW POTENTIAL",             weight: -2 },
  { phrase: "WORSE THAN EXPECTED",         weight: -2 },
  { phrase: "WEAKENING ECONOMY",           weight: -2 },
  { phrase: "ACCOMMODATIVE",               weight: -2 },
  { phrase: "DOVISH",                      weight: -2 },
  // Light dovish (-1)
  { phrase: "GRADUAL APPROACH",            weight: -1 },
  { phrase: "FLEXIBLE",                    weight: -1 },
  { phrase: "MONITOR DEVELOPMENTS",        weight: -1 },
  { phrase: "MIXED SIGNALS",               weight: -1 },
  { phrase: "UNCERTAINTY",                 weight: -1 },
];

// Speaker authority multiplier. Higher = more market-moving.
export const SPEAKER_WEIGHT: Record<string, number> = {
  // ── Federal Reserve ──
  "POWELL":     1.00,
  "WILLIAMS":   0.75,    // NY Fed President = #2 in influence
  "JEFFERSON":  0.70,    // Vice Chair
  "WALLER":     0.65,
  "BOWMAN":     0.50,
  "BARR":       0.55,
  "JACKSON":    0.50,
  "KUGLER":     0.50,
  "DALY":       0.55,
  "BOSTIC":     0.55,
  "GOOLSBEE":   0.55,
  "KASHKARI":   0.55,
  "LOGAN":      0.50,
  "COOK":       0.45,
  // ── ECB ──
  "LAGARDE":    1.00,
  "DE GUINDOS": 0.70,
  "LANE":       0.65,
  "SCHNABEL":   0.55,
  "ELDERSON":   0.40,
  "CIPOLLONE":  0.40,
  // ── BoE ──
  "BAILEY":     1.00,
  "BROADBENT":  0.55,
  "RAMSDEN":    0.50,
  "PILL":       0.55,    // Chief Economist
  "MANN":       0.50,
  "DHINGRA":    0.45,
  "GREENE":     0.45,
  // ── BoJ ──
  "UEDA":       1.00,
  "HIMINO":     0.60,
  "UCHIDA":     0.60,
  // ── SNB ──
  "SCHLEGEL":   1.00,
  "JORDAN":     0.85,    // ex-chair but still moves CHF
  "TSCHUDIN":   0.55,
  "MOSER":      0.45,
  // ── RBA ──
  "BULLOCK":    1.00,
  "KENT":       0.55,
  "HAUSER":     0.55,
  // ── BoC ──
  "MACKLEM":    1.00,
  "ROGERS":     0.60,
  "GRAVELLE":   0.50,
  "KOZICKI":    0.50,
};

const CAP_PER_DIRECTION = 8;  // raw sum cap before normalisation to [-5, +5]

function findSpeaker(text: string): { speaker: string; weight: number } | null {
  const upper = text.toUpperCase();
  // Longest match wins (e.g. "DE GUINDOS" beats "DE")
  let best: { speaker: string; weight: number } | null = null;
  for (const [name, weight] of Object.entries(SPEAKER_WEIGHT)) {
    if (upper.includes(name)) {
      if (!best || name.length > best.speaker.length) {
        best = { speaker: name, weight };
      }
    }
  }
  return best;
}

/**
 * Score a piece of text for hawkishness/dovishness.
 *
 * @param text  Full text — usually title + description
 * @param explicitSpeaker  Optional: if you already know the speaker, pass it
 *                         to avoid the name-detection pass.
 */
export function scoreHawkishness(text: string, explicitSpeaker?: string): HawkDoveResult {
  if (!text) {
    return { score: 0, phrasesMatched: [], speakerWeight: 0, effectiveImpact: 0, speaker: null };
  }
  const upper = text.toUpperCase();

  const matches: { phrase: string; weight: number }[] = [];
  let rawSum = 0;
  for (const e of HAWKISH) {
    if (upper.includes(e.phrase)) {
      matches.push(e);
      rawSum += e.weight;
    }
  }
  for (const e of DOVISH) {
    if (upper.includes(e.phrase)) {
      matches.push(e);
      rawSum += e.weight;
    }
  }
  // Cap raw sum
  rawSum = Math.max(-CAP_PER_DIRECTION, Math.min(CAP_PER_DIRECTION, rawSum));
  // Normalise to [-5, +5]
  const score = Math.round((rawSum / CAP_PER_DIRECTION) * 5);

  // Speaker
  let speakerWeight = 0;
  let speaker: string | null = null;
  if (explicitSpeaker) {
    const w = SPEAKER_WEIGHT[explicitSpeaker.toUpperCase()];
    if (w != null) { speaker = explicitSpeaker.toUpperCase(); speakerWeight = w; }
  } else {
    const found = findSpeaker(text);
    if (found) { speaker = found.speaker; speakerWeight = found.weight; }
  }

  // Effective impact — how much this should move currency sentiment
  // Range: -50 to +50 (5 × 10 × 1.0)
  const effectiveImpact = Math.round(score * 10 * speakerWeight);

  return { score, phrasesMatched: matches, speakerWeight, effectiveImpact, speaker };
}

/** Map a CB-feed source ID (e.g. "fed", "ecb") to the currency it primarily impacts */
export const BANK_PRIMARY_CCY: Record<string, string> = {
  fed: "USD", ecb: "EUR", boe: "GBP", boj: "JPY",
  snb: "CHF", rba: "AUD", boc: "CAD", rbnz: "NZD",
};
