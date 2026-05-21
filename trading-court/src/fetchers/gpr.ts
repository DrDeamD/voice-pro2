// ============================================================================
// Geopolitical Risk Index (GPR) — v4.2 Phase 2
//
// Source: GDELT v2.1 — global event database, free, CC0 license. Updated
// every 15 minutes.
//
// API: https://api.gdeltproject.org/api/v2/doc/doc
//   query: combination of conflict/sanctions/war keywords
//   mode: timelinevolinfo or artlist
//   timespan: 24h
//
// What we compute:
//   - Article volume on geopolitical keywords (proxy for "tension density")
//   - Compare to 7-day rolling average to detect spikes
//   - Output a 0-100 index with components breakdown
//
// Honest behaviour:
//   - When GDELT is unreachable (network issue / API down), return null with
//     `available: false`. The downstream code treats this as "no signal" not
//     "no tension" — different from synthesising a fake value.
//   - The 0-100 normalisation is calibrated to typical 2024-2026 levels.
//     Drift expected over years; review annually.
// ============================================================================

import { httpJSON } from "../http.js";

const GDELT_TIMELINE = "https://api.gdeltproject.org/api/v2/doc/doc";

// Hot-fix: GDELT may be unreachable from some VPS edges. Cache the
// "unavailable" verdict for 5 minutes so we don't block snapshots while
// re-probing it on every refresh.
const UNAVAILABLE_CACHE_MS = 5 * 60 * 1000;
let lastUnavailableUntil = 0;

// Three component queries (each scored 0-100, then combined)
const COMPONENT_QUERIES = {
  conflict: '(missile OR airstrike OR invasion OR "armed conflict" OR "military strike") sourcelang:eng',
  sanctions: '("new sanctions" OR "export ban" OR "asset freeze" OR "oil embargo") sourcelang:eng',
  energy:   '("oil supply" OR "pipeline attack" OR "refinery hit" OR "strait of hormuz" OR "red sea") sourcelang:eng',
};

// Baselines — typical article volume per 24h on each component during calm
// periods. Calibrated rough values; refresh annually.
const COMPONENT_BASELINE = {
  conflict: 800,
  sanctions: 300,
  energy: 120,
};

// Components weight in the final 0-100 score
const COMPONENT_WEIGHT = {
  conflict: 0.50,
  sanctions: 0.20,
  energy: 0.30,
};

export interface GPRComponent {
  name: string;
  volume24h: number;
  baseline: number;
  ratio: number;       // volume / baseline
  score: number;       // 0..100
}

export interface GPRReport {
  available: boolean;
  /** 0..100 combined geopolitical risk score. */
  score: number;
  /** Trend vs the prior pull (RISING / FALLING / STABLE) — requires cache history */
  trend: "RISING" | "FALLING" | "STABLE" | "UNKNOWN";
  components: GPRComponent[];
  /** Top 5 article titles seen in the last pull (informational) */
  sampleTitles: string[];
  /** ISO of when this was computed */
  computedUtc: string;
  reasoning: string;
}

interface GdeltTimelineResp {
  timeline?: Array<{
    series?: string;
    data?: Array<{ date?: string; value?: number }>;
  }>;
}

interface GdeltArtListResp {
  articles?: Array<{ title?: string; url?: string; seendate?: string }>;
}

async function fetchComponentVolume(query: string, sourceTag: string): Promise<number | null> {
  // GDELT v2.1 valid modes: ArtList | TimelineVol | TimelineVolRaw | TimelineTone | ...
  // We use TimelineVolRaw which returns the percent-of-all-articles series.
  // FAIL-FAST: 3s timeout, no retries. The snapshot pipeline cannot wait
  // multiple seconds on a flaky external dependency. If GDELT is reachable,
  // it responds in <1s typically; if it's blocked at our edge, we want to
  // know immediately, not 36 seconds later.
  const url = `${GDELT_TIMELINE}?` +
    `query=${encodeURIComponent(query)}&` +
    `mode=TimelineVolRaw&` +
    `timespan=24h&` +
    `format=json`;
  const data = await httpJSON<GdeltTimelineResp>(url, {
    cacheKey: `gpr:${sourceTag}`,
    ttlSec: 900,
    source: `gdelt_${sourceTag}`,
    timeoutMs: 3000,
    retries: 0,
    headers: { "Accept": "application/json, text/plain, */*" },
  });
  if (!data || !Array.isArray(data.timeline) || data.timeline.length === 0) return null;
  const series = data.timeline[0];
  if (!series?.data || series.data.length === 0) return null;
  // Sum percent values across timeline points and convert to article count
  let pctSum = 0;
  let validPoints = 0;
  for (const point of series.data) {
    if (typeof point.value === "number" && Number.isFinite(point.value)) {
      pctSum += point.value;
      validPoints++;
    }
  }
  if (validPoints === 0) return null;
  // GDELT global daily article volume ≈ 3.5M; per 15-min slice ≈ 36K.
  // pctSum is in percent-of-global-articles; multiply by global/period.
  // For 24h timespan we get ~96 points × pct_average. Reasonable proxy:
  // article count = pctSum × 35000 (rough scaling)
  const estimatedArticles = pctSum * 35000;
  return estimatedArticles;
}

async function fetchSampleTitles(): Promise<string[]> {
  const q = COMPONENT_QUERIES.conflict;
  const url = `${GDELT_TIMELINE}?` +
    `query=${encodeURIComponent(q)}&` +
    `mode=ArtList&maxrecords=8&sort=hybridrel&` +
    `timespan=24h&format=json`;
  const data = await httpJSON<GdeltArtListResp>(url, {
    cacheKey: "gpr:samples",
    ttlSec: 900,
    source: "gdelt_samples",
    timeoutMs: 3000,
    retries: 0,
  });
  if (!data || !Array.isArray(data.articles)) return [];
  return data.articles
    .filter(a => typeof a.title === "string")
    .map(a => a.title as string)
    .slice(0, 5);
}

// In-memory previous score for trend detection
let lastScore: number | null = null;

export async function fetchGPR(): Promise<GPRReport> {
  // Short-circuit: if we just declared unavailable, skip re-probing for 5 min
  if (Date.now() < lastUnavailableUntil) {
    return {
      available: false,
      score: 0,
      trend: "UNKNOWN",
      components: [],
      sampleTitles: [],
      computedUtc: new Date().toISOString(),
      reasoning: "GDELT marked unreachable — re-probe in 5 min",
    };
  }
  try {
    const [conflictVol, sanctionsVol, energyVol, samples] = await Promise.all([
      fetchComponentVolume(COMPONENT_QUERIES.conflict, "conflict"),
      fetchComponentVolume(COMPONENT_QUERIES.sanctions, "sanctions"),
      fetchComponentVolume(COMPONENT_QUERIES.energy,    "energy"),
      fetchSampleTitles().catch(() => [] as string[]),
    ]);

    // If ALL three failed, report unavailable AND remember it for 5 min
    if (conflictVol == null && sanctionsVol == null && energyVol == null) {
      lastUnavailableUntil = Date.now() + UNAVAILABLE_CACHE_MS;
      return {
        available: false,
        score: 0,
        trend: "UNKNOWN",
        components: [],
        sampleTitles: [],
        computedUtc: new Date().toISOString(),
        reasoning: "GDELT v2.1 unreachable — GPR unavailable (re-probe in 5 min)",
      };
    }

    const components: GPRComponent[] = [];

    function comp(name: string, vol: number | null, baseline: number): GPRComponent {
      if (vol == null) {
        return { name, volume24h: 0, baseline, ratio: 0, score: 0 };
      }
      const ratio = vol / baseline;
      // Score 0..100 — at 1× baseline = 30, at 3× = 80, at 5× = 100
      let score = 0;
      if (ratio <= 0.5) score = 0;
      else if (ratio <= 1.0) score = Math.round((ratio - 0.5) * 60);     // 0..30
      else if (ratio <= 2.0) score = Math.round(30 + (ratio - 1) * 30);  // 30..60
      else if (ratio <= 3.0) score = Math.round(60 + (ratio - 2) * 20);  // 60..80
      else if (ratio <= 5.0) score = Math.round(80 + (ratio - 3) * 10);  // 80..100
      else score = 100;
      return { name, volume24h: vol, baseline, ratio: Math.round(ratio * 100) / 100, score };
    }

    components.push(comp("conflict", conflictVol, COMPONENT_BASELINE.conflict));
    components.push(comp("sanctions", sanctionsVol, COMPONENT_BASELINE.sanctions));
    components.push(comp("energy", energyVol, COMPONENT_BASELINE.energy));

    // Combined weighted score
    const total = components.reduce(
      (s, c) => s + c.score * (COMPONENT_WEIGHT as any)[c.name],
      0
    );
    const finalScore = Math.round(total);

    // Trend
    let trend: GPRReport["trend"] = "UNKNOWN";
    if (lastScore != null) {
      const diff = finalScore - lastScore;
      if (diff >= 5) trend = "RISING";
      else if (diff <= -5) trend = "FALLING";
      else trend = "STABLE";
    }
    lastScore = finalScore;

    const reasoning =
      `GPR ${finalScore}/100 (${trend}). ` +
      `conflict ${components[0]!.score}, sanctions ${components[1]!.score}, energy ${components[2]!.score}. ` +
      `Volumes vs baseline: ${components.map(c => `${c.name} ${c.ratio}×`).join(", ")}.`;

    return {
      available: true,
      score: finalScore,
      trend,
      components,
      sampleTitles: samples,
      computedUtc: new Date().toISOString(),
      reasoning,
    };
  } catch (err: any) {
    return {
      available: false,
      score: 0,
      trend: "UNKNOWN",
      components: [],
      sampleTitles: [],
      computedUtc: new Date().toISOString(),
      reasoning: `GPR fetch failed: ${err?.message ?? String(err)}`,
    };
  }
}
