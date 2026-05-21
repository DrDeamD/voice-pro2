// ============================================================================
// Trading Court Pro v3.3.0 — Native Node.js HTTP Server
// FIX: renderSources() now actually renders pills with green/red dots.
//      Breaking-news banner shows ⚡ alerts.
//      Calendar source line shows live source label + freshness.
// ============================================================================
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";

import { INSTRUMENTS, KNOWN_SOURCES, VERSION, TTL, TTL_RAPID, REFRESH_INTERVALS_MS } from "./config.js";
// v3.5.6: Self-Measurement
import { recordVerdicts } from "./measurement/recorder.js";
import { getPerformance } from "./measurement/performance.js";
import { analyzePair } from "./engines/court.js";
import { fetchCalendar } from "./fetchers/calendar.js";
import { fetchBreakingNews } from "./fetchers/news.js";
import { sourceHealth } from "./http.js";
// v4.2 Phase 2 — snapshot-level engines
import { computeCurrencyStrength } from "./engines/currencyStrength.js";
import { fetchGPR } from "./fetchers/gpr.js";
// v4.5 — Phase 3 (without Telegram): correlation + change log
import { computePairCorrelations } from "./engines/pairCorrelation.js";
import { detectVerdictChanges, getChangeLog } from "./measurement/verdictChangeLog.js";
import { fetchSeries } from "./fetchers/candles.js";
import type { Snapshot, NewsItem } from "./types/index.js";

const PORT = Number((globalThis as any).process?.env?.PORT || 3555);

// ─── App ─────────────────────────────────────────────────────────────────────
const app = new Hono();
app.use("/api/*", cors());

// ─── Snapshot cache ──────────────────────────────────────────────────────────
let snapshotCache: { data: Snapshot & { breakingNews?: NewsItem[] }; expires: number } | null = null;
// v3.5.2: snapshot TTL is now ADAPTIVE
//   - DEFAULT: 15s in calm market (was 30s)
//   - RAPID:    6s when ANY pair has breakingActive=true
const SNAPSHOT_TTL_NORMAL_MS = TTL.SNAPSHOT * 1000;       // 15s
const SNAPSHOT_TTL_RAPID_MS  = TTL_RAPID.SNAPSHOT * 1000;  // 6s

function pickSnapshotTtl(snap: Snapshot): number {
  // If any pair currently shows breakingActive, use rapid TTL so the next
  // request returns fresher data within seconds, not tens of seconds.
  for (const p of snap.pairs as any[]) {
    if (p?.news?.breakingActive) return SNAPSHOT_TTL_RAPID_MS;
  }
  return SNAPSHOT_TTL_NORMAL_MS;
}

async function getSnapshot(force = false): Promise<Snapshot & { breakingNews?: NewsItem[] }> {
  if (!force && snapshotCache && snapshotCache.expires > Date.now()) {
    return snapshotCache.data;
  }
  const symbols = Object.keys(INSTRUMENTS);

  // v4.2 Phase 2 — GPR with 5s wall-clock cap. If GDELT unreachable
  // (some VPS edges block it), we proceed with gpr=null gracefully.
  const gprWithTimeout = Promise.race([
    fetchGPR().catch(() => null),
    new Promise<null>(resolve => setTimeout(() => resolve(null), 5000)),
  ]);
  const [calendarEvents, breakingNews, gpr] = await Promise.all([
    fetchCalendar(),
    fetchBreakingNews().catch(() => [] as NewsItem[]),
    gprWithTimeout,
  ]);

  const results = await Promise.allSettled(
    symbols.map(s => analyzePair(s, calendarEvents, gpr))
  );
  const pairs: any[] = [];
  const errors: Record<string, string> = {};
  results.forEach((r, i) => {
    if (r.status === "fulfilled") pairs.push(r.value);
    else errors[symbols[i]] = String((r as any).reason).slice(0, 200);
  });

  const now = Date.now();
  const dataSourceHealth: Record<string, any> = {};
  for (const key of Object.keys(KNOWN_SOURCES)) {
    const h = sourceHealth[key];
    if (!h) continue;
    dataSourceHealth[key] = {
      ok: h.ok,
      lastSuccess: h.lastSuccess,
      lastSuccessAgoSec: h.lastSuccess ? Math.round((now - h.lastSuccess) / 1000) : null,
      note: h.note,
      label: KNOWN_SOURCES[key].label,   // v4.6.7 — single source of truth for labels
      group: KNOWN_SOURCES[key].group,
    };
  }

  // v4.2 Phase 2 — currency strength meter computed across all pairs
  const currencyStrength = computeCurrencyStrength(pairs as any);

  // v4.6.5 P1 — global CB Hawk/Dove stance, aggregated from every pair's
  // speechReport.byCurrency. The same speech appears in multiple pairs (ECB
  // news lands on all EUR pairs), so we dedup by title before summing impact.
  const stanceByCcy: Record<string, { currency: string; stanceScore: number; speechCount: number }> = {};
  const seenStanceSpeech = new Set<string>();
  for (const p of pairs as any[]) {
    const sr = p?.speechReport;
    if (!sr?.recent) continue;
    for (const s of sr.recent) {
      const key = String(s.title ?? "").slice(0, 80).toLowerCase();
      if (!key || seenStanceSpeech.has(key)) continue;
      seenStanceSpeech.add(key);
      const ccy = s.primaryCurrency || "USD";
      if (!stanceByCcy[ccy]) stanceByCcy[ccy] = { currency: ccy, stanceScore: 0, speechCount: 0 };
      stanceByCcy[ccy].stanceScore += s.hawkDove?.effectiveImpact ?? 0;
      stanceByCcy[ccy].speechCount += 1;
    }
  }
  for (const k of Object.keys(stanceByCcy)) {
    stanceByCcy[k].stanceScore = Math.max(-50, Math.min(50, stanceByCcy[k].stanceScore));
  }
  const currencyStance = { byCurrency: stanceByCcy };

  // v4.5 — Phase 3: pair correlation matrix (re-uses cached M15 candles)
  const m15ByPair: Record<string, any[]> = {};
  await Promise.all(symbols.map(async s => {
    try {
      const series = await fetchSeries(s, "15m");
      if (series.available && series.candles.length > 0) m15ByPair[s] = series.candles;
    } catch { /* skip */ }
  }));
  const pairCorrelation = computePairCorrelations(m15ByPair as any);

  // v4.5 — verdict change detection (in-memory, drives /api/changes)
  const verdictChanges = detectVerdictChanges(pairs);

  const snap = {
    generatedUtc: new Date().toISOString(),
    pairs, errors, calendarEvents,
    dataSourceHealth,
    breakingNews,
    currencyStrength,              // v4.2 Phase 2
    currencyStance,                // v4.6.5 P1 — CB Hawk/Dove stance
    gpr,                           // v4.2 Phase 2
    pairCorrelation,               // v4.5 Phase 3
    verdictChanges: verdictChanges.changes,  // changes from THIS snapshot
    ts: now,                       // v3.5.2: enable client to compute age
  };
  // v3.5.2: adaptive cache TTL
  const ttlMs = pickSnapshotTtl(snap as any);
  snapshotCache = { data: snap, expires: Date.now() + ttlMs };

  // v3.5.6: Self-Measurement — append every fresh verdict to verdict_log.jsonl.
  // Fire-and-forget: we don't await. recordVerdicts internally swallows errors
  // so it cannot break the snapshot pipeline. Logging happens in background.
  recordVerdicts(pairs).catch(() => { /* logged inside recorder */ });

  return snap;
}

// alias for /api/state usage
const fetchSnapshot = getSnapshot;

// ─── API Routes ───────────────────────────────────────────────────────────────
app.get("/healthz", c => c.json({ ok: true, ts: Date.now(), version: VERSION }));

app.get("/api/snapshot", async c => {
  const force = c.req.query("force") === "1";
  const snap = await getSnapshot(force);
  return c.json(snap);
});

app.get("/api/pair/:symbol", async c => {
  const sym = c.req.param("symbol").toUpperCase().replace(/[\/=X\-]/g, "");
  if (!INSTRUMENTS[sym]) return c.json({ error: `Unknown symbol ${sym}` }, 404);
  const calendarEvents = await fetchCalendar();
  const analysis = await analyzePair(sym, calendarEvents);
  return c.json(analysis);
});

app.get("/api/calendar", async c => {
  const events = await fetchCalendar();
  const horizon = Number(c.req.query("hours") || "24");
  const ccy = c.req.query("ccy");
  const filtered = events.filter(e => {
    if (Math.abs(e.minutesFromNow) > horizon * 60) return false;
    if (ccy && e.country !== ccy.toUpperCase()) return false;
    return true;
  });
  return c.json({ count: filtered.length, events: filtered });
});

app.get("/api/breaking", async c => {
  const news = await fetchBreakingNews().catch(() => [] as NewsItem[]);
  return c.json({ count: news.length, items: news });
});

// v4.2 Phase 2 — currency strength meter
app.get("/api/strength", async c => {
  const snap = await getSnapshot();
  return c.json((snap as any).currencyStrength ?? { byCurrency: {}, ranked: [], pairsUsed: 0 });
});

// v4.2 Phase 2 — geopolitical risk index (GDELT)
app.get("/api/gpr", async c => {
  const snap = await getSnapshot();
  return c.json((snap as any).gpr ?? { available: false, score: 0, components: [] });
});

// v4.5 — Phase 3: pair correlation heatmap
app.get("/api/correlation", async c => {
  const snap = await getSnapshot();
  return c.json((snap as any).pairCorrelation ?? { symbols: [], matrix: {}, topCorrelated: {} });
});

// v4.5 — Phase 3: verdict change log (in-memory, last N transitions)
app.get("/api/changes", c => {
  const limit = Math.max(1, Math.min(200, Number(c.req.query("limit") || "50")));
  return c.json({ count: getChangeLog(limit).length, changes: getChangeLog(limit) });
});

// v4.2 Phase 2 — aggregated CB speeches feed
app.get("/api/speeches", async c => {
  const snap = await getSnapshot();
  const all: any[] = [];
  const seen = new Set<string>();
  for (const p of (snap.pairs as any[])) {
    const sr = p?.speechReport;
    if (!sr?.recent) continue;
    for (const s of sr.recent) {
      const key = (s.title ?? "").slice(0, 80).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(s);
    }
  }
  all.sort((a, b) => Math.abs(b.hawkDove?.effectiveImpact ?? 0) - Math.abs(a.hawkDove?.effectiveImpact ?? 0));
  return c.json({ count: all.length, speeches: all.slice(0, 30), generatedUtc: new Date().toISOString() });
});

app.get("/api/sources", c => {
  const now = Date.now();
  const sources = Object.keys(KNOWN_SOURCES)
    .filter(k => sourceHealth[k])
    .map(k => {
      const s = sourceHealth[k];
      return {
        name: k,
        label: KNOWN_SOURCES[k].label,
        group: KNOWN_SOURCES[k].group,
        ok: s.ok,
        note: s.note ?? "",
        lastSuccessAgoSec: s.lastSuccess ? Math.round((now - s.lastSuccess) / 1000) : null,
      };
    });
  return c.json({
    total: sources.length,
    healthy: sources.filter(s => s.ok).length,
    sources,
  });
});

// ─── v3.5.2: /api/state — system-wide adaptive polling state ────────────────
// Frontend polls this lightweight endpoint to learn whether to use NORMAL or
// RAPID refresh interval. Returns:
//   - rapidMode: boolean (any pair has breakingActive OR interventionRegime)
//   - reason: human-readable why rapid mode fired
//   - refreshMs: which interval frontend should use
//   - latestSnapshotAgeSec: how old current snapshot is
app.get("/api/state", async c => {
  let rapidMode = false;
  const reasons: string[] = [];
  let snapshotAgeSec: number | null = null;

  try {
    const snap = await fetchSnapshot().catch(() => null);
    if (snap) {
      snapshotAgeSec = Math.round((Date.now() - (snap as any).ts) / 1000);
      for (const p of snap.pairs) {
        if (p.news?.breakingActive) {
          rapidMode = true;
          reasons.push(`${p.symbol}: breaking active (${p.news.breakingType})`);
        }
        if (p.news?.interventionRegime?.active) {
          rapidMode = true;
          reasons.push(`${p.symbol}: MSID regime ${p.news.interventionRegime.currencies.join(",")}`);
        }
      }
    }
  } catch { /* fail-soft */ }

  return c.json({
    rapidMode,
    reasons,
    refreshMs: rapidMode ? REFRESH_INTERVALS_MS.RAPID : REFRESH_INTERVALS_MS.NORMAL,
    latestSnapshotAgeSec: snapshotAgeSec,
    serverTime: Date.now(),
  });
});

// ─── v3.5.6: /api/performance — hit-rate stats from verdict_log ─────────────
// Cached for 5 minutes. Pass ?force=1 to bypass cache and recompute.
// Returns aggregated win-rate by pair, confidence band, and session.
// During paper-trading, this is the canonical answer to "is the system right?"
app.get("/api/performance", async c => {
  const force = c.req.query("force") === "1";
  try {
    const report = await getPerformance(force);
    return c.json(report);
  } catch (err: any) {
    return c.json({ error: "performance computation failed", detail: String(err?.message ?? err) }, 500);
  }
});

// ─── Inline CSS ───────────────────────────────────────────────────────────────
const INLINE_CSS = `/* Trading Court Pro v3.3 - Custom Styles */
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { font-family: 'IBM Plex Sans Arabic', 'Inter', 'Segoe UI', Tahoma, sans-serif; }

#pair-rows tr { cursor: pointer; transition: background .15s; }
#pair-rows tr:hover { background: rgba(251, 191, 36, 0.08); }
#pair-rows tr.selected { background: rgba(251, 191, 36, 0.15); }
#pair-rows td { padding: 0.6rem 0.75rem; border-bottom: 1px solid rgba(71, 85, 105, 0.2); }

.regime-up    { color: #4ade80; font-weight: 600; }
.regime-down  { color: #f87171; font-weight: 600; }
.regime-range { color: #fbbf24; }
.regime-dead  { color: #64748b; }

/* Calendar rows */
.cal-row {
  display: grid;
  grid-template-columns: 82px 14px 52px 1fr 88px 88px 110px;
  gap: 6px;
  padding: 6px 8px;
  font-size: 12px;
  border-bottom: 1px solid rgba(71, 85, 105, 0.15);
  align-items: center;
}
.cal-row:hover { background: rgba(71, 85, 105, 0.1); }
.cal-row.cal-past { opacity: 0.65; }
.cal-row.cal-live {
  background: rgba(251, 191, 36, 0.06);
  border-left: 2px solid rgba(251, 191, 36, 0.5);
}
.cal-impact-HIGH   { color: #f87171; font-weight: 700; }
.cal-impact-MEDIUM { color: #fbbf24; font-weight: 600; }
.cal-impact-LOW    { color: #94a3b8; }

.cal-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.cal-dot-HIGH   { background: #f87171; box-shadow: 0 0 5px rgba(248,113,113,0.6); }
.cal-dot-MEDIUM { background: #fbbf24; }
.cal-dot-LOW    { background: #475569; }

.cal-mins-past { color: #64748b; }
.cal-mins-soon { color: #fbbf24; font-weight: 600; }
.cal-mins-now  { color: #ef4444; font-weight: 700; }

.cal-actual-better { color: #4ade80; font-weight: 700; }
.cal-actual-worse  { color: #f87171; font-weight: 700; }
.cal-actual-inline { color: #94a3b8; font-weight: 600; }
.cal-actual-none   { color: #475569; }

.cal-delta {
  display: inline-block;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  margin-top: 2px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.cal-delta-better { background: rgba(34,197,94,0.15); color: #4ade80; border: 1px solid rgba(34,197,94,0.25); }
.cal-delta-worse  { background: rgba(239,68,68,0.15);  color: #f87171; border: 1px solid rgba(239,68,68,0.25); }
.cal-delta-inline { background: rgba(148,163,184,0.1); color: #94a3b8; border: 1px solid rgba(148,163,184,0.2); }

.cal-section-hdr {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #64748b;
  padding: 6px 8px 4px;
  border-bottom: 1px solid rgba(71,85,105,0.2);
  font-weight: 600;
}
.cal-section-hdr.cal-section-upcoming { color: #fbbf24; }

.cal-summary {
  display: flex;
  gap: 12px;
  padding: 6px 8px 8px;
  font-size: 11px;
  border-bottom: 1px solid rgba(71,85,105,0.2);
  flex-wrap: wrap;
}
.cal-stat { display: flex; align-items: center; gap: 5px; color: #94a3b8; }
.cal-stat strong { font-size: 13px; font-weight: 700; }
.cal-stat.better strong { color: #4ade80; }
.cal-stat.worse strong  { color: #f87171; }
.cal-stat.high strong   { color: #f87171; }
.cal-stat.pending strong { color: #f59e0b; }

.cal-ctx { font-size: 10px; color: #64748b; display: block; margin-top: 1px; }
.cal-actual-src { font-size: 9px; color: #64748b; display: block; margin-top: 1px; }

/* ═══════════════════════════════════════════════════════════════════════════
   SOURCE HEALTH PILLS — v3.3 (THE KEY FIX)
   This entire block + the renderSources() function is what was missing in v3.2.
   ═══════════════════════════════════════════════════════════════════════════ */
.src-bar {
  padding: 8px 16px;
  background: #0a0e1a;
  border-bottom: 1px solid #1e2d3d;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.src-summary {
  font-size: 11px;
  color: #94a3b8;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(15,23,42,0.7);
  border: 1px solid rgba(71,85,105,0.4);
  white-space: nowrap;
}
.src-pills { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.src-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: 999px;
  background: rgba(15,23,42,0.8);
  border: 1px solid rgba(71,85,105,0.4);
  font-size: 10.5px;
  font-family: 'SF Mono', 'Consolas', monospace;
  color: #cbd5e1;
  white-space: nowrap;
  cursor: help;
  transition: all .15s;
}
.src-pill:hover { background: rgba(30,41,59,0.95); border-color: rgba(148,163,184,0.5); }
.src-pill.ok    { color: #cbd5e1; }
.src-pill.bad   { color: #f87171; border-color: rgba(248,113,113,0.3); }
.src-pill .src-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
}
.src-pill.ok  .src-dot { background: #22c55e; box-shadow: 0 0 5px rgba(34,197,94,0.7); }
.src-pill.bad .src-dot { background: #ef4444; box-shadow: 0 0 5px rgba(239,68,68,0.7); }
.src-pill .src-age { color: #64748b; font-size: 9.5px; }
.src-group-label {
  font-size: 9.5px;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-inline-end: 2px;
  align-self: center;
}

/* Breaking news banner */
.breaking-banner {
  background: linear-gradient(90deg, rgba(239,68,68,0.18), rgba(239,68,68,0.05));
  border: 1px solid rgba(239,68,68,0.45);
  border-radius: 8px;
  padding: 10px 14px;
  margin: 8px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.breaking-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  color: #fca5a5;
  letter-spacing: 0.05em;
}
.breaking-title::before {
  content: "⚡";
  animation: pulse 1s ease-in-out infinite;
}
.breaking-item {
  font-size: 12px;
  color: #fecaca;
  line-height: 1.5;
}
.breaking-item .b-cat {
  display: inline-block;
  font-size: 9.5px;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(239,68,68,0.2);
  color: #fca5a5;
  margin-inline-end: 6px;
  font-weight: 600;
}
.breaking-item .b-age {
  font-size: 10px;
  color: #f87171;
  margin-inline-start: 6px;
}
@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.4 } }

.pos { color: #4ade80; }
.neg { color: #f87171; }
.neutral { color: #94a3b8; }

.pill {
  display: inline-block;
  padding: 2px 7px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
}
.pill-buy,.verdict-buy.pill   { background: rgba(16,185,129,.15); color: #10b981; border: 1px solid rgba(16,185,129,.3); }
.pill-sell,.verdict-sell.pill { background: rgba(239,68,68,.15);  color: #ef4444; border: 1px solid rgba(239,68,68,.3); }
.pill-wait,.verdict-wait.pill { background: rgba(100,116,139,.1); color: #64748b; border: 1px solid rgba(100,116,139,.2); }
.pill-tradable  { background: rgba(16,185,129,.2); color: #10b981; border: 1px solid rgba(16,185,129,.4); }
.pill-near      { background: rgba(245,158,11,.2); color: #f59e0b; border: 1px solid rgba(245,158,11,.4); }
.pill-watchlist { background: rgba(59,130,246,.15); color: #3b82f6; border: 1px solid rgba(59,130,246,.3); }
.pill-none      { background: rgba(100,116,139,.1); color: #64748b; border: 1px solid rgba(100,116,139,.2); }
.pill-strong    { background: rgba(16,185,129,.2); color: #10b981; border: 1px solid rgba(16,185,129,.4); }
.pill-good      { background: rgba(16,185,129,.1); color: #10b981; border: 1px solid rgba(16,185,129,.2); }
.pill-valid     { background: rgba(245,158,11,.1); color: #f59e0b; border: 1px solid rgba(245,158,11,.2); }
.pill-weak      { background: rgba(245,158,11,.1); color: #f59e0b; border: 1px solid rgba(245,158,11,.2); }
.pill-reject    { background: rgba(239,68,68,.1);  color: #ef4444; border: 1px solid rgba(239,68,68,.2); }

::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: rgba(15, 23, 42, 0.5); }
::-webkit-scrollbar-thumb { background: rgba(251, 191, 36, 0.3); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: rgba(251, 191, 36, 0.5); }

@media (max-width: 768px) {
  .cal-row { grid-template-columns: 60px 10px 42px 1fr 80px; font-size: 11px; }
  .cal-row > :nth-child(n+6) { display: none; }
  .src-pill { font-size: 9.5px; padding: 2px 7px; }
  .src-group-label { display: none; }
}
`;

// ─── Inline JS ────────────────────────────────────────────────────────────────
const INLINE_JS = `// ============================================================================
// Trading Court Pro v3.3 — Dashboard JavaScript
// FIXES: renderSources() implemented (was completely missing in v3.2),
//        breaking-news banner, calendar source line shows actualSource
// ============================================================================
(function () {
  "use strict";

  const $ = s => document.querySelector(s);
  const fmt  = (v, d) => { if (d == null) d = 2; return (typeof v === "number" && isFinite(v)) ? v.toFixed(d) : "—"; };
  const fmtS = (v, d) => { if (d == null) d = 1; if (typeof v !== "number" || !isFinite(v)) return "—"; return (v >= 0 ? "+" : "") + v.toFixed(d); };
  const sign = v => v > 0 ? "pos" : v < 0 ? "neg" : "neutral";
  const esc  = s => String(s == null ? "" : s).replace(/[&<>\\"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
  const dec  = p => { const d = (p && p.display) || ""; return d.indexOf("JPY") >= 0 ? 3 : d.indexOf("XAU") >= 0 ? 2 : 5; };
  const ageStr = secs => {
    if (secs == null) return "?";
    if (secs < 60) return secs + "s";
    if (secs < 3600) return Math.round(secs/60) + "m";
    return Math.round(secs/3600) + "h";
  };

  let currentSymbol = null;
  let snapshotCache = null;
  let autoTimer     = null;
  let autoEnabled   = true;

  function setStatus(txt, ok) {
    const dot = $("#status-dot");
    const msg = $("#status-txt");
    if (dot) dot.className = "status-dot " + (ok === true ? "dot-ok" : ok === false ? "dot-fail" : "dot-loading");
    if (msg) msg.textContent = txt;
  }

  // ════════════════════════════════════════════════════════════════════════
  // renderSources() — THE v3.3 FIX
  // Renders one pill per data source with green/red dot + age tooltip.
  // Was completely missing in v3.2 — explaining the empty source-bar.
  // ════════════════════════════════════════════════════════════════════════
  function renderSources(data) {
    const bar = $("#source-bar");
    if (!bar) return;
    const health = (data && data.dataSourceHealth) || {};
    const keys = Object.keys(health);
    if (!keys.length) {
      bar.innerHTML = '<span class="src-summary" style="color:#64748b">لا بيانات مصادر</span>';
      return;
    }

    // v4.6.7 — labels/groups now come from the snapshot (single source of truth
    // in config.ts KNOWN_SOURCES); no more hardcoded maps that drift out of sync.
    const GROUPS = ["QUOTE", "CANDLE", "CONTEXT", "CALENDAR", "NEWS"];

    const total   = keys.length;
    const healthy = keys.filter(k => health[k].ok).length;
    const summary = '<span class="src-summary">' + healthy + '/' + total + ' مصادر</span>';

    let pillsHtml = '<div class="src-pills">';
    for (let gi = 0; gi < GROUPS.length; gi++) {
      const grp = GROUPS[gi];
      const inGroup = keys.filter(k => ((health[k] && health[k].group) || "OTHER") === grp);
      if (!inGroup.length) continue;
      pillsHtml += '<span class="src-group-label">' + grp + ':</span>';
      for (let i = 0; i < inGroup.length; i++) {
        const k = inGroup[i];
        const s = health[k];
        const okCls = s.ok ? "ok" : "bad";
        const label = (s && s.label) || k;
        const age   = s.lastSuccessAgoSec != null ? ageStr(s.lastSuccessAgoSec) : "?";
        const tip   = (s.note ? esc(s.note) + " · " : "") + "آخر نجاح: " + age + " مضت";
        pillsHtml += '<span class="src-pill ' + okCls + '" title="' + tip + '">' +
          '<span class="src-dot"></span>' +
          '<span>' + esc(label) + '</span>' +
          '<span class="src-age">' + age + '</span>' +
          '</span>';
      }
    }
    pillsHtml += '</div>';

    bar.innerHTML = summary + pillsHtml;
  }

  // ════════════════════════════════════════════════════════════════════════
  // renderGPR() — v4.2 Phase 2
  // ════════════════════════════════════════════════════════════════════════
  function renderGPR(data) {
    var host = document.getElementById("gpr-host");
    if (!host) return;
    var g = data && data.gpr;
    if (!g || !g.available) {
      host.innerHTML = '<div style="padding:6px 16px;color:#64748b;font-size:11px">GPR: غير متاح</div>';
      return;
    }
    var col = g.score >= 75 ? '#ef4444' : g.score >= 50 ? '#f59e0b' : g.score >= 25 ? '#fbbf24' : '#10b981';
    var trendIcon = g.trend === 'RISING' ? '↑' : g.trend === 'FALLING' ? '↓' : '→';
    var compsHtml = (g.components || []).map(function(c){
      return '<span style="font-size:10px;color:#94a3b8;margin-inline-start:6px">'+esc(c.name)+' '+c.score+'</span>';
    }).join('');
    host.innerHTML = '<div style="padding:8px 16px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;border-bottom:1px solid #1e2d3d;background:#0a0e1a">'
      + '<span style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em">المخاطر الجيوسياسية (GPR)</span>'
      + '<span style="display:inline-flex;align-items:center;gap:8px;padding:4px 12px;border:1px solid '+col+'40;border-radius:6px;background:rgba(15,23,42,0.6)">'
        + '<span style="font-size:18px;font-weight:700;color:'+col+';font-family:monospace">'+g.score+'/100</span>'
        + '<span style="color:'+col+';font-size:14px">'+trendIcon+'</span>'
      + '</span>'
      + compsHtml
      + '</div>';
  }

  // ════════════════════════════════════════════════════════════════════════
  // renderCurrencyStrength() — v4.2 Phase 2
  // ════════════════════════════════════════════════════════════════════════
  function renderCurrencyStrength(data) {
    var host = document.getElementById("strength-host");
    if (!host) return;
    var cs = data && data.currencyStrength;
    if (!cs || !cs.byCurrency || cs.pairsUsed === 0) {
      host.innerHTML = '<div style="padding:6px 16px;color:#64748b;font-size:11px">قوة العملات: غير متاحة</div>';
      return;
    }
    var entries = Object.keys(cs.byCurrency).map(function(k){ return cs.byCurrency[k]; });
    entries.sort(function(a,b){ return b.score - a.score; });
    var bars = entries.map(function(e){
      var w = Math.min(100, Math.abs(e.score));
      var col = e.score > 10 ? '#10b981' : e.score < -10 ? '#ef4444' : '#94a3b8';
      var label = e.currency + ' ' + (e.score > 0 ? '+' : '') + e.score;
      return '<div style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border:1px solid '+col+'40;border-radius:6px;background:rgba(15,23,42,0.6)">'
        + '<span style="font-weight:700;color:'+col+';font-family:monospace;font-size:11px">'+label+'</span>'
        + '<div style="width:40px;height:4px;background:#1f2937;border-radius:2px;overflow:hidden">'
        +   '<div style="width:'+w+'%;height:100%;background:'+col+'"></div>'
        + '</div>'
        + '</div>';
    }).join('');
    host.innerHTML = '<div style="padding:8px 16px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;border-bottom:1px solid #1e2d3d;background:#0a0e1a">'
      + '<span style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin-inline-end:8px">قوة العملات</span>'
      + bars
      + '</div>';
  }

  // ════════════════════════════════════════════════════════════════════════
  // renderCBStance() — v4.6.5 P1 — central-bank Hawk/Dove stance per currency
  // Positive = hawkish (tightening bias, red), negative = dovish (easing, blue).
  // ════════════════════════════════════════════════════════════════════════
  function renderCBStance(data) {
    var host = document.getElementById("cbstance-host");
    if (!host) return;
    var cs = data && data.currencyStance;
    var by = cs && cs.byCurrency;
    if (!by) { host.innerHTML = ""; return; }
    var entries = Object.keys(by).map(function(k){ return by[k]; })
      .filter(function(e){ return e && e.speechCount > 0; });
    if (entries.length === 0) { host.innerHTML = ""; return; }
    entries.sort(function(a,b){
      var d = Math.abs(b.stanceScore) - Math.abs(a.stanceScore);
      return d !== 0 ? d : b.speechCount - a.speechCount;
    });
    var bars = entries.map(function(e){
      var sc = e.stanceScore;
      var lean = sc > 4 ? "HAWK" : sc < -4 ? "DOVE" : "NEUTRAL";
      var col  = sc > 4 ? "#f87171" : sc < -4 ? "#60a5fa" : "#94a3b8";
      var w = Math.min(100, Math.abs(sc) * 2);
      return '<div style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border:1px solid ' + col + '40;border-radius:6px;background:rgba(15,23,42,0.6)">'
        + '<span style="font-weight:700;color:' + col + ';font-family:monospace;font-size:11px">' + esc(e.currency) + ' ' + lean + ' ' + (sc >= 0 ? '+' : '') + sc + '</span>'
        + '<div style="width:36px;height:4px;background:#1f2937;border-radius:2px;overflow:hidden"><div style="width:' + w + '%;height:100%;background:' + col + '"></div></div>'
        + '<span style="font-size:9px;color:#64748b">' + e.speechCount + '</span>'
        + '</div>';
    }).join('');
    host.innerHTML = '<div style="padding:8px 16px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;border-bottom:1px solid #1e2d3d;background:#0a0e1a">'
      + '<span style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin-inline-end:8px">موقف البنوك المركزية (Hawk/Dove)</span>'
      + bars
      + '</div>';
  }

  // ════════════════════════════════════════════════════════════════════════
  // renderCorrelationHeatmap() — v4.6.6 P1 #5 — full 13×13 ρ matrix
  // Green = positive, red = negative, intensity ∝ |ρ|. Numbers are ρ×100.
  // ════════════════════════════════════════════════════════════════════════
  function renderCorrelationHeatmap(data) {
    var host = document.getElementById("heatmap-body");
    if (!host) return;
    var pc = data && data.pairCorrelation;
    if (!pc || !pc.symbols || pc.symbols.length === 0 || !pc.matrix) {
      host.innerHTML = '<p style="padding:12px;color:#64748b;font-size:12px">لا بيانات ارتباط</p>';
      return;
    }
    var syms = pc.symbols;
    function cellColor(v) {
      if (v == null) return '#1f2937';
      if (v >= 0) return 'rgba(16,185,129,' + (0.12 + 0.78 * Math.min(1, v)) + ')';
      return 'rgba(239,68,68,' + (0.12 + 0.78 * Math.min(1, -v)) + ')';
    }
    function shortLabel(s) { return s.slice(0,3) + '/' + s.slice(3); }

    var html = '<div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:9px">';
    html += '<tr><th style="padding:3px;position:sticky;left:0;background:#0a0e1a;z-index:2"></th>';
    for (var c = 0; c < syms.length; c++) {
      html += '<th style="padding:2px;color:#94a3b8;font-weight:600;white-space:nowrap;writing-mode:vertical-rl;transform:rotate(180deg);height:50px;font-family:monospace">' + esc(syms[c]) + '</th>';
    }
    html += '</tr>';
    for (var r = 0; r < syms.length; r++) {
      var a = syms[r];
      html += '<tr><th style="padding:3px 6px;text-align:right;color:#cbd5e1;font-weight:600;white-space:nowrap;position:sticky;left:0;background:#0a0e1a;z-index:1;font-family:monospace">' + esc(shortLabel(a)) + '</th>';
      for (var c2 = 0; c2 < syms.length; c2++) {
        var b = syms[c2];
        var v = (pc.matrix[a] && pc.matrix[a][b] != null) ? pc.matrix[a][b] : null;
        if (a === b) {
          html += '<td style="width:30px;height:24px;text-align:center;background:#334155;color:#64748b">·</td>';
        } else {
          var txt = (v == null) ? '' : ((v >= 0 ? '' : '-') + Math.abs(Math.round(v * 100)));
          var fg = (v != null && Math.abs(v) > 0.5) ? '#0a0e1a' : '#cbd5e1';
          var tip = shortLabel(a) + ' vs ' + shortLabel(b) + ': ' + (v == null ? 'n/a' : v.toFixed(2));
          html += '<td title="' + esc(tip) + '" style="width:30px;height:24px;text-align:center;background:' + cellColor(v) + ';color:' + fg + ';font-family:monospace">' + txt + '</td>';
        }
      }
      html += '</tr>';
    }
    html += '</table></div>';
    host.innerHTML = '<p style="font-size:10.5px;color:#64748b;padding:4px 8px">أخضر = ارتباط موجب · أحمر = سالب · الأرقام ρ×100 · |ρ|≥70 = تعرّض مزدوج محتمل (آخر ' + (pc.lookback || '?') + ' شمعة M15)</p>' + html;
  }

  // ════════════════════════════════════════════════════════════════════════
  // renderVerdictChanges() — v4.5 Phase 3
  // Shows last 5 verdict transitions (BUY ↔ SELL ↔ WAIT). Fetched separately
  // from /api/changes (in-memory log on server, persists across snapshots).
  // ════════════════════════════════════════════════════════════════════════
  function renderVerdictChanges(data) {
    var host = document.getElementById("changes-host");
    if (!host) return;
    // Use changes attached to snapshot (this-cycle), or fetch /api/changes async.
    fetch("/api/changes?limit=5", { cache: "no-store" }).then(function(r) {
      return r.ok ? r.json() : null;
    }).then(function(j) {
      if (!j || !j.changes || j.changes.length === 0) {
        host.innerHTML = '';
        return;
      }
      var items = j.changes.slice(0, 5).map(function(ev) {
        var icon = ev.toVerdict === "BUY" ? "🟢" : ev.toVerdict === "SELL" ? "🔴" : "⚪";
        var col  = ev.toVerdict === "BUY" ? "#10b981" : ev.toVerdict === "SELL" ? "#ef4444" : "#94a3b8";
        var ago  = "";
        if (ev.tsUtc) {
          var s = Math.round((Date.now() - new Date(ev.tsUtc).getTime()) / 1000);
          ago = s < 60 ? s + "s" : s < 3600 ? Math.round(s/60) + "m" : Math.round(s/3600) + "h";
        }
        return '<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border:1px solid ' + col + '40;border-radius:5px;background:rgba(15,23,42,0.6);font-size:11px;margin-inline-start:5px">'
          + icon + ' <strong style="color:' + col + '">' + esc(ev.symbol) + '</strong>'
          + ' <span style="color:#94a3b8">' + esc(ev.fromVerdict) + '→' + esc(ev.toVerdict) + '</span>'
          + ' <span style="color:#64748b;font-size:10px">' + ago + '</span>'
          + '</span>';
      }).join('');
      host.innerHTML = '<div style="padding:8px 16px;display:flex;flex-wrap:wrap;align-items:center;border-bottom:1px solid #1e2d3d;background:#0a0e1a">'
        + '<span style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em">آخر تغيّرات</span>'
        + items
        + '</div>';
    }).catch(function() { host.innerHTML = ''; });
  }

  // ════════════════════════════════════════════════════════════════════════
  // renderBreakingBanner() — v3.3 NEW
  // Shows a red flashing banner when intervention/policy news is fresh.
  // ════════════════════════════════════════════════════════════════════════
  function renderBreakingBanner(data) {
    const host = $("#breaking-host");
    if (!host) return;
    const items = ((data && data.breakingNews) || []).filter(n => n.breaking);
    if (!items.length) { host.innerHTML = ""; return; }

    const ageMin = h => h == null ? "?" : (h * 60).toFixed(0) + "m ago";
    const itemsHtml = items.slice(0, 5).map(n => {
      const cat = n.category || "BREAKING";
      const ccys = (n.impactCurrencies || []).join(", ");
      return '<div class="breaking-item">' +
        '<span class="b-cat">' + esc(cat) + '</span>' +
        (ccys ? '<span class="b-cat" style="background:rgba(245,158,11,0.15);color:#fbbf24;">' + esc(ccys) + '</span>' : '') +
        esc(n.title) +
        '<span class="b-age">' + ageMin(n.freshnessHours) + '</span>' +
        '</div>';
    }).join("");

    host.innerHTML =
      '<div class="breaking-banner">' +
        '<div class="breaking-title">أخبار عاجلة — تأثير محتمل على التحليل</div>' +
        itemsHtml +
      '</div>';
  }

  // ── Pairs table ───────────────────────────────────────────────────────────
  function renderTable(data) {
    const tbody = $("#pair-rows");
    if (!tbody) return;
    const pairs = (data && data.pairs) || [];
    if (!pairs.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#64748b;padding:20px">لا بيانات</td></tr>';
      return;
    }

    tbody.innerHTML = pairs.map(p => {
      const d  = dec(p);
      const q  = p.quote || {};
      const priceHtml = q.available
        ? '<div style="font-family:monospace"><span style="color:#e2e8f0">' + fmt(q.mid,d) + '</span><br><span style="font-size:10px;color:#64748b">' + fmt(q.bid,d) + '/' + fmt(q.ask,d) + (q.spread ? ' (' + fmt(q.spread,1) + 'p)' : '') + '</span></div>'
        : '<span style="color:#334155">—</span>';
      const regime = (p.regime && p.regime.label) || "—";
      const regCol = regime === "TREND_UP" ? "#10b981" : regime === "TREND_DOWN" ? "#ef4444" : regime === "RANGE" ? "#f59e0b" : "#64748b";
      const mtf  = (p.mtf && p.mtf.alignment) || 0;
      const conf = (p.scores && p.scores.confidence) || 0;
      const tier = (p.scores && p.scores.confidenceTier) || "REJECT";
      const verdict = p.verdict || "WAIT";
      const vCls = verdict === "BUY" ? "verdict-buy" : verdict === "SELL" ? "verdict-sell" : "verdict-wait";
      const opp = p.opportunityStatus || "NONE";
      const sel = currentSymbol === p.symbol ? ' class="selected"' : '';
      const breakingMark = (p.news && p.news.breakingActive) ? ' <span style="color:#ef4444" title="Breaking news affecting this pair">⚡</span>' : '';
      return '<tr data-sym="' + esc(p.symbol) + '"' + sel + '>' +
        '<td><strong>' + esc(p.display) + '</strong>' + breakingMark + '</td>' +
        '<td>' + priceHtml + '</td>' +
        '<td><span style="color:' + regCol + ';font-weight:600">' + esc(regime) + '</span><br><span style="font-size:10px;color:#64748b">ADX ' + fmt(p.regime && p.regime.adx, 1) + '</span></td>' +
        '<td><span class="' + sign(mtf) + '">' + fmtS(mtf, 0) + '</span></td>' +
        '<td><span class="pill pill-' + tier.toLowerCase() + '">' + esc(tier) + '</span><br><span style="font-size:10px;color:#64748b">' + fmt(conf, 0) + '/100</span></td>' +
        '<td style="font-size:12px">' + esc((p.session && p.session.name) || "—") + '</td>' +
        '<td><span class="pill pill-' + opp.toLowerCase() + '">' + esc(opp) + '</span></td>' +
        '<td><span class="pill ' + vCls + '">' + esc(verdict) + '</span></td>' +
        '</tr>';
    }).join("");

    tbody.querySelectorAll("tr[data-sym]").forEach(tr => {
      tr.addEventListener("click", () => {
        currentSymbol = tr.dataset.sym;
        tbody.querySelectorAll("tr").forEach(r => r.classList.toggle("selected", r === tr));
        const p = pairs.find(x => x.symbol === currentSymbol);
        if (p) renderDetail(p);
      });
    });
  }

  // ── Detail pane ───────────────────────────────────────────────────────────
  function renderDetail(p) {
    const body = $("#detail-body");
    const ts   = $("#detail-ts");
    if (!body) return;
    if (ts) ts.textContent = p.generatedUtc ? new Date(p.generatedUtc).toLocaleTimeString() : "";

    const d    = dec(p);
    const plan = p.plan || {};
    const risk = p.risk || {};
    const news = p.news || {};
    const ve   = p.verdictExplanation || {};
    const pa   = p.priceAction || {};
    const sl   = pa.sessionLevels || {};
    const vwap = p.vwap || {};

    const bars = [
      ["Market Structure", p.scores && p.scores.marketStructure],
      ["MTF",             p.scores && p.scores.mtf],
      ["Momentum",        p.scores && p.scores.momentum],
      ["VWAP",            p.scores && p.scores.vwap],
      ["Price Action",    p.scores && p.scores.priceAction],
      ["Regime",          p.scores && p.scores.regime],
      ["Correlation",     p.scores && p.scores.correlation],
      ["News",            p.scores && p.scores.news]
    ].map(arr => {
      const name = arr[0]; const v = arr[1];
      if (v == null) return "";
      const w = Math.min(100, Math.abs(v));
      const col = v > 0 ? "#10b981" : v < 0 ? "#ef4444" : "#475569";
      return '<div style="margin-bottom:6px">' +
        '<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px">' +
          '<span style="color:#94a3b8">' + name + '</span>' +
          '<span class="' + sign(v) + '" style="font-family:monospace">' + fmtS(v, 1) + '</span>' +
        '</div>' +
        '<div style="height:4px;background:#1f2937;border-radius:2px">' +
          '<div style="width:' + w + '%;height:100%;background:' + col + ';border-radius:2px"></div>' +
        '</div>' +
      '</div>';
    }).join("");

    const planHtml = plan.entry != null ?
      '<div class="kv"><span class="kv-key">الدخول</span><span class="kv-val">' + fmt(plan.entry, d) + '</span></div>' +
      '<div class="kv"><span class="kv-key">وقف الخسارة</span><span class="kv-val neg">' + fmt(plan.stopLoss, d) + ' (' + fmt(plan.stopDistancePips, 1) + 'p)</span></div>' +
      '<div class="kv"><span class="kv-key">TP1 / RR1</span><span class="kv-val pos">' + fmt(plan.tp1, d) + ' / ' + fmt(plan.rr1, 2) + '</span></div>' +
      '<div class="kv"><span class="kv-key">TP2 / RR2</span><span class="kv-val pos">' + fmt(plan.tp2, d) + ' / ' + fmt(plan.rr2, 2) + '</span></div>' +
      '<div class="kv"><span class="kv-key">TP3</span><span class="kv-val pos">' + fmt(plan.tp3, d) + '</span></div>' +
      '<div class="kv"><span class="kv-key">اللوت (1% مخاطرة)</span><span class="kv-val">' + fmt(plan.lotSizePer1Pct, 3) + ' lot</span></div>'
      : '<p style="color:#64748b;font-size:12px">' + esc((plan.notes && plan.notes[0]) || "لا خطة") + '</p>';

    const vwapHtml = vwap.daily ?
      '<div class="kv"><span class="kv-key">Daily VWAP</span><span class="kv-val">' + fmt(vwap.daily.vwap, d) + '</span></div>' +
      '<div class="kv"><span class="kv-key">موقع السعر</span><span class="kv-val ' + (vwap.positionVsDaily === "ABOVE" ? "pos" : vwap.positionVsDaily === "BELOW" ? "neg" : "neutral") + '">' + esc(vwap.positionVsDaily || "—") + '</span></div>' +
      '<div class="kv"><span class="kv-key">المسافة</span><span class="kv-val">' + fmt(vwap.distancePct, 4) + '%</span></div>' +
      '<div class="kv"><span class="kv-key">VWAP Score</span><span class="kv-val ' + sign(vwap.score) + '">' + fmtS(vwap.score, 1) + '</span></div>'
      : '<p style="color:#64748b;font-size:12px">لا بيانات VWAP</p>';

    // News items — show category + breaking flag
    const newsHtml = (news.items || []).slice(0, 6).map(n => {
      const breakBadge = n.breaking ? ' <span style="background:rgba(239,68,68,0.2);color:#fca5a5;font-size:9px;padding:1px 5px;border-radius:3px">⚡BRK</span>' : '';
      const catBadge = n.category && n.category !== "GENERAL" ? ' <span style="background:rgba(100,116,139,0.2);color:#94a3b8;font-size:9px;padding:1px 5px;border-radius:3px">' + esc(n.category) + '</span>' : '';
      const fresh = n.freshnessHours != null ? n.freshnessHours.toFixed(1) + "h" : "?";
      return '<li><a href="' + esc(n.url) + '" target="_blank" rel="noopener" style="color:#cbd5e1;text-decoration:none">' + esc(n.title) + '</a>' + breakBadge + catBadge +
        '<span style="font-size:10px;color:#475569"> · ' + esc(n.source) + ' · ' + fresh + '</span></li>';
    }).join("") || '<li style="color:#475569">لا أخبار</li>';

    // News breaking score line (v3.5: MSID-aware)
    let breakingLine = '';
    if (news.breakingActive) {
      const regime = news.interventionRegime;
      const msidInfo = (regime && regime.active && regime.sourceCount >= 2)
        ? ' · <span style="background:rgba(239,68,68,0.18);padding:1px 5px;border-radius:3px;font-size:10px">MSID ' + regime.sourceCount + ' مصادر · أقدم ' + regime.oldestHours.toFixed(1) + 'h</span>'
        : '';
      breakingLine =
        '<p style="font-size:11px;color:#fca5a5;margin-bottom:4px">' +
          '⚡ Breaking score: <strong>' + fmtS(news.breakingScore, 0) + '</strong> · العملات: ' +
          esc((news.breakingCurrencies || []).join(", ")) + msidInfo +
        '</p>';
    }

    const bullHtml = (p.bullCase || []).map(x => '<li>' + esc(x) + '</li>').join("") || '<li style="color:#475569">—</li>';
    const bearHtml = (p.bearCase || []).map(x => '<li>' + esc(x) + '</li>').join("") || '<li style="color:#475569">—</li>';

    // ── v4.6 Phase A — Argument Cards (Arabic) ─────────────────────────────
    var argReport = p.argumentCards || { buyCards: [], sellCards: [], invalidation: { triggersAr: [] }, summary: '' };
    function cardHtml(c) {
      var bg = c.side === 'BULL' ? 'rgba(16,185,129,0.08)' : c.side === 'BEAR' ? 'rgba(239,68,68,0.08)' : 'rgba(100,116,139,0.08)';
      var bd = c.side === 'BULL' ? '#10b98140' : c.side === 'BEAR' ? '#ef444440' : '#64748b40';
      var sg = c.strength === 'STRONG' ? '⭐⭐⭐' : c.strength === 'MEDIUM' ? '⭐⭐' : '⭐';
      return '<div style="background:' + bg + ';border:1px solid ' + bd + ';border-radius:6px;padding:8px 10px;margin-bottom:6px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">' +
        '<strong style="font-size:12px;color:#e2e8f0">' + esc(c.titleAr) + '</strong>' +
        '<span style="font-size:10px;color:#94a3b8">' + sg + '</span>' +
        '</div>' +
        '<div style="font-size:11.5px;color:#cbd5e1;line-height:1.5">' + esc(c.detailAr) + '</div>' +
        '<div style="font-size:9.5px;color:#475569;margin-top:3px;font-family:monospace">' + esc(c.evidence || '') + '</div>' +
        '</div>';
    }
    var buyCardsHtml  = (argReport.buyCards  || []).map(cardHtml).join('') || '<p style="color:#475569;font-size:11px">لا حجج صعودية</p>';
    var sellCardsHtml = (argReport.sellCards || []).map(cardHtml).join('') || '<p style="color:#475569;font-size:11px">لا حجج هبوطية</p>';
    var invalTriggers = (argReport.invalidation && argReport.invalidation.triggersAr || []).map(function(t) {
      return '<li style="margin:2px 0">' + esc(t) + '</li>';
    }).join('');

    // ── v4.6 Phase A — Confluence breakdown ────────────────────────────────
    var conf = p.confluence;
    var confHtml = '';
    if (conf && conf.breakdown) {
      var bars2 = conf.breakdown.slice(0, 10).map(function(b) {
        var w = Math.min(100, Math.abs(b.contribution) * 8);
        var col = b.supports === 'YES' ? '#10b981' : b.supports === 'NO' ? '#ef4444' : '#475569';
        return '<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;font-size:10.5px">' +
          '<span style="width:90px;color:#94a3b8">' + esc(b.engine) + '</span>' +
          '<div style="flex:1;height:5px;background:#1f2937;border-radius:2px;position:relative">' +
            '<div style="width:' + w + '%;height:100%;background:' + col + ';border-radius:2px"></div>' +
          '</div>' +
          '<span style="width:48px;text-align:left;font-family:monospace;color:' + col + '">' + (b.contribution >= 0 ? '+' : '') + b.contribution.toFixed(1) + '</span>' +
          '</div>';
      }).join('');
      confHtml = '<div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #1e2d3d;margin-bottom:12px">' +
        '<div class="sub-hdr">توافق المحركات (Confluence)</div>' +
        '<p style="font-size:11px;color:#94a3b8;margin-bottom:6px">' + esc(conf.summary || '') + '</p>' +
        bars2 +
        '</div>';
    }

    // ── v4.6 Phase A — Fibonacci ──────────────────────────────────────────
    var fib = p.fibonacci;
    var fibHtml = '';
    if (fib && fib.legType !== 'UNKNOWN' && fib.nearbyLevels && fib.nearbyLevels.length) {
      var nearLvlsHtml = fib.nearbyLevels.map(function(l) {
        var col = l.kind === 'EXTENSION' ? '#f59e0b' : '#10b981';
        return '<div class="kv"><span class="kv-key">Fib ' + l.name + ' (' + l.kind[0] + ')</span><span class="kv-val" style="color:' + col + '">' + fmt(l.price, d) + ' (' + (l.distancePips >= 0 ? '+' : '') + l.distancePips + 'p)</span></div>';
      }).join('');
      fibHtml = '<div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #1e2d3d;margin-bottom:12px">' +
        '<div class="sub-hdr">Fibonacci' + (fib.inGoldenZone ? ' <span style="color:#fbbf24">★ Golden Zone</span>' : '') + '</div>' +
        '<p style="font-size:11px;color:#94a3b8;margin-bottom:6px">' + esc(fib.reasoning || '') + '</p>' +
        nearLvlsHtml +
        '</div>';
    }

    // ── v4.6 Phase A — Pivot Points ───────────────────────────────────────
    var piv = p.pivotPoints;
    var pivHtml = '';
    if (piv && piv.classic) {
      pivHtml = '<div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #1e2d3d;margin-bottom:12px">' +
        '<div class="sub-hdr">Pivot Points</div>' +
        '<p style="font-size:11px;color:#94a3b8;margin-bottom:6px">' + esc(piv.reasoning || '') + '</p>' +
        '<div class="kv"><span class="kv-key">R2 / R1</span><span class="kv-val">' + fmt(piv.classic.R2, d) + ' / ' + fmt(piv.classic.R1, d) + '</span></div>' +
        '<div class="kv"><span class="kv-key">Pivot (P)</span><span class="kv-val" style="color:#fbbf24">' + fmt(piv.classic.P, d) + '</span></div>' +
        '<div class="kv"><span class="kv-key">S1 / S2</span><span class="kv-val">' + fmt(piv.classic.S1, d) + ' / ' + fmt(piv.classic.S2, d) + '</span></div>' +
        (piv.camarilla ? '<div class="kv"><span class="kv-key">Cam H4 / L4</span><span class="kv-val" style="color:#f59e0b">' + fmt(piv.camarilla.H4, d) + ' / ' + fmt(piv.camarilla.L4, d) + '</span></div>' : '') +
        '</div>';
    }

    // ── v4.6 Phase A — Opening Range Breakout ─────────────────────────────
    var orbR = p.orb;
    var orbHtml = '';
    if (orbR && ((orbR.london && orbR.london.status !== 'PENDING') || (orbR.ny && orbR.ny.status !== 'PENDING'))) {
      function orbRow(sess, label) {
        if (!sess || sess.status === 'PENDING') return '';
        var statusCol = sess.status.indexOf('BROKE_HIGH') >= 0 ? '#10b981'
                      : sess.status.indexOf('BROKE_LOW')  >= 0 ? '#ef4444'
                      : sess.status.indexOf('FAKE')       >= 0 ? '#f59e0b' : '#94a3b8';
        return '<div class="kv"><span class="kv-key">' + label + '</span><span class="kv-val" style="color:' + statusCol + '">' + esc(sess.status) + (sess.rangePips ? ' (' + sess.rangePips + 'p)' : '') + '</span></div>';
      }
      orbHtml = '<div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #1e2d3d;margin-bottom:12px">' +
        '<div class="sub-hdr">Opening Range Breakout</div>' +
        orbRow(orbR.london, 'London ORB (07-08 UTC)') +
        orbRow(orbR.ny,     'NY ORB (13-14 UTC)') +
        ((orbR.london && orbR.london.reasoning) ? '<p style="font-size:10.5px;color:#64748b;margin-top:4px">' + esc(orbR.london.reasoning) + '</p>' : '') +
        ((orbR.ny && orbR.ny.reasoning && orbR.ny.status !== 'PENDING') ? '<p style="font-size:10.5px;color:#64748b;margin-top:2px">' + esc(orbR.ny.reasoning) + '</p>' : '') +
        '</div>';
    }

    // ── v4.6.1 P0 — Pre-News Volatility Warning ────────────────────────────
    var pnw = p.preNewsWarning;
    var pnwHtml = '';
    if (pnw && pnw.level && pnw.level !== 'NONE') {
      var pnwCol = pnw.level === 'BLOCKER' ? '#ef4444' : pnw.level === 'WARNING' ? '#f97316' : '#fbbf24';
      var pnwRgb = pnw.level === 'BLOCKER' ? '239,68,68' : pnw.level === 'WARNING' ? '249,115,22' : '251,191,36';
      var pnwIcon = pnw.level === 'BLOCKER' ? '🛑' : pnw.level === 'WARNING' ? '⚠️' : 'ℹ️';
      pnwHtml = '<div style="background:rgba(' + pnwRgb + ',0.10);border:1px solid ' + pnwCol + '70;border-radius:8px;padding:10px 12px;margin-bottom:12px">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">' +
          '<span style="font-size:16px">' + pnwIcon + '</span>' +
          '<strong style="color:' + pnwCol + ';font-size:13px">Pre-News ' + esc(pnw.level) + (pnw.minutesUntil != null ? ' · ' + pnw.minutesUntil + ' دقيقة' : '') + '</strong>' +
        '</div>' +
        '<p style="font-size:12px;color:#e2e8f0;line-height:1.5">' + esc(pnw.reasoningAr || '') + '</p>' +
        '</div>';
    }

    // ── v4.6.1 P0 — Judge Override V4 card ─────────────────────────────────
    var jo = p.judgeOverride;
    var joHtml = '';
    if (jo && jo.mode && jo.mode !== 'NO_OVERRIDE') {
      var joCol = jo.mode === 'HARD_WAIT' ? '#ef4444' :
                  jo.mode === 'WAIT_FOR_CONFIRMATION' ? '#f97316' :
                  jo.mode === 'CONFIDENCE_ADJUST' ? '#fbbf24' : '#64748b';
      var modeLabel = jo.mode === 'HARD_WAIT' ? 'انتظار قسري' :
                      jo.mode === 'WAIT_FOR_CONFIRMATION' ? 'انتظار تأكيد' :
                      jo.mode === 'CONFIDENCE_ADJUST' ? 'تخفيض ثقة' : 'بلا تعديل';
      var msgsAr = (jo.messages || []).filter(function(m){ return m && m.ar; }).slice(0, 8);
      var msgsHtml = msgsAr.map(function(m) {
        return '<li style="font-size:11px;color:#cbd5e1;line-height:1.6;padding:3px 0;border-bottom:1px solid rgba(71,85,105,0.15)">• ' + esc(m.ar) + '</li>';
      }).join('') || '<li style="color:#475569;font-size:11px">—</li>';
      var jin = jo.inputs || {};
      var inputFlags = [];
      if (jin.fibGoldenZoneAligned) inputFlags.push('<span style="color:#10b981">Golden Zone ✓</span>');
      if (jin.fibExtendedSameDirection) inputFlags.push('<span style="color:#f59e0b">Overextended ⚠</span>');
      if (jin.dailyPivotAgainst) inputFlags.push('<span style="color:#f87171">Pivot ضدّ</span>');
      if (jin.newsImpact && jin.newsImpact !== 'NONE') inputFlags.push('<span style="color:#f97316">News ' + esc(jin.newsImpact) + '</span>');
      var flagsLine = inputFlags.length ? '<p style="font-size:10.5px;color:#94a3b8;margin-top:4px">إشارات: ' + inputFlags.join(' · ') + '</p>' : '';
      joHtml = '<div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid ' + joCol + '60;margin-bottom:12px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
          '<div class="sub-hdr" style="color:' + joCol + ';margin:0;padding:0;border:0">⚖️ قرار القاضي V4: ' + esc(modeLabel) + '</div>' +
          '<span style="font-size:10.5px;color:#94a3b8;font-family:monospace">risk=' + (jo.riskScore || 0) + ' · ' + esc(jo.from) + '→' + esc(jo.to) + '</span>' +
        '</div>' +
        (jo.adjustedConfidence != null ? '<p style="font-size:11px;color:#94a3b8;margin-bottom:6px">الثقة المعدّلة: <strong style="color:#e2e8f0">' + jo.adjustedConfidence + '/100</strong> (' + (jo.confidenceAdjustment >= 0 ? '+' : '') + (jo.confidenceAdjustment || 0) + ')</p>' : '') +
        '<ul style="list-style:none;padding:0;margin:0">' + msgsHtml + '</ul>' +
        flagsLine +
        '</div>';
    }

    // ── v4.6.1 P0 — Central Bank Speech Report ─────────────────────────────
    var sr = p.speechReport;
    var srHtml = '';
    if (sr && sr.recent && sr.recent.length > 0) {
      var pairCcys = {};
      pairCcys[(p.symbol || '').slice(0,3)] = true;
      pairCcys[(p.symbol || '').slice(3,6)] = true;
      if ((p.symbol || '').indexOf('XAU') === 0) pairCcys['USD'] = true;
      var releRecent = sr.recent.filter(function(s) { return pairCcys[s.primaryCurrency]; }).slice(0, 6);
      if (releRecent.length === 0) releRecent = sr.recent.slice(0, 4);
      if (releRecent.length > 0) {
        var srItems = releRecent.map(function(s) {
          var ei = (s.hawkDove && s.hawkDove.effectiveImpact) || 0;
          var lean = ei > 5 ? 'HAWKISH' : ei < -5 ? 'DOVISH' : 'NEUTRAL';
          var leanCol = ei > 5 ? '#f87171' : ei < -5 ? '#60a5fa' : '#94a3b8';
          var speakerLabel = (s.hawkDove && s.hawkDove.speaker) ? esc(s.hawkDove.speaker) : 'CB';
          var fr = (s.freshnessHours != null) ? s.freshnessHours.toFixed(1) + 'h' : '?';
          return '<li style="padding:6px 0;border-bottom:1px solid rgba(71,85,105,0.2)">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:2px">' +
              '<span style="font-size:11px;color:#cbd5e1">' + speakerLabel + ' <span style="color:#64748b">· ' + esc(s.primaryCurrency) + ' · ' + fr + '</span></span>' +
              '<span style="font-size:10px;color:' + leanCol + ';font-weight:600;font-family:monospace">' + lean + ' ' + (ei >= 0 ? '+' : '') + ei + '</span>' +
            '</div>' +
            '<a href="' + esc(s.url) + '" target="_blank" rel="noopener" style="font-size:11px;color:#cbd5e1;text-decoration:none;line-height:1.4">' + esc(s.title) + '</a>' +
            '</li>';
        }).join('');
        srHtml = '<div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #1e2d3d;margin-bottom:12px">' +
          '<div class="sub-hdr">🎙️ خطابات البنوك المركزية' + (sr.highImpactRecent ? ' <span style="color:#f87171;font-size:10px">· عالي التأثير حديث</span>' : '') + '</div>' +
          '<p style="font-size:10.5px;color:#64748b;margin-bottom:4px">' + esc(sr.reasoning || '') + '</p>' +
          '<ul style="list-style:none;padding:0;margin:0">' + srItems + '</ul>' +
          '</div>';
      }
    }

    // ── v4.6.8 P1 #7 — confidence calibration provenance ───────────────────
    var cal = p.scores && p.scores.calibration;
    var calLine = '';
    if (cal && cal.source === 'calibrated' && cal.bin) {
      var wr = Math.round((cal.bin.winRate || 0) * 100);
      var hi = cal.bin.hiAbs >= 200 ? '∞' : cal.bin.hiAbs;
      calLine = '<p style="font-size:10.5px;color:#10b981;margin-top:4px">📊 ثقة تجريبية: bin |comp| ' + cal.bin.loAbs + '–' + hi + ' · ' + cal.bin.sampleSize + ' صفقة · فوز ' + wr + '%</p>';
    } else if (cal && cal.source === 'heuristic') {
      var rsn = cal.heuristicReason === 'no_calibration' ? 'لا بيانات معايرة' :
                cal.heuristicReason === 'low_sample'     ? 'عيّنة < 20 صفقة' :
                cal.heuristicReason === 'no_match'       ? 'composite خارج الجدول' :
                cal.heuristicReason === 'out_of_range'   ? 'خارج المدى' : 'احتياطي';
      calLine = '<p style="font-size:10.5px;color:#64748b;margin-top:4px">📊 ثقة تقديرية (' + rsn + ')</p>';
    }

    // ── v4.6.9 P2 #8 — RSI Divergence (H1 + M15) ───────────────────────────
    function divRows(rep, tf) {
      if (!rep || !rep.signals || rep.signals.length === 0) return '';
      return rep.signals.map(function(s) {
        var bull = (s.kind || '').indexOf('BULL') >= 0;
        var col = bull ? '#10b981' : '#ef4444';
        var label = (s.kind || '').replace('_', ' ');
        return '<div class="kv"><span class="kv-key">' + tf + ' · ' + esc(label) + '</span>'
          + '<span class="kv-val" style="color:' + col + '">قوة ' + Math.round(s.strength || 0) + ' · ' + (s.barsApart || 0) + ' شمعة</span></div>'
          + (s.note ? '<p style="font-size:10px;color:#64748b;margin:1px 0 4px">' + esc(s.note) + '</p>' : '');
      }).join('');
    }
    var divInner = divRows(p.divergenceH1, 'H1') + divRows(p.divergenceM15, 'M15');
    var divHtml = '';
    if (divInner) {
      divHtml = '<div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #1e2d3d;margin-bottom:12px">'
        + '<div class="sub-hdr">انحراف RSI (Divergence)</div>'
        + divInner
        + '</div>';
    }

    // ── v4.6.10 P2 #9 — Manipulation / liquidity sweeps ────────────────────
    var manip = p.manipulation;
    var manipHtml = '';
    if (manip && manip.primary && manip.primary.kind && manip.primary.kind !== 'NONE') {
      var mk = manip.primary.kind;
      var mcol = (mk.indexOf('BULL') >= 0) ? '#10b981' : '#ef4444';
      var mlabel = mk.replace('_', ' ');
      manipHtml = '<div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid ' + mcol + '40;margin-bottom:12px">'
        + '<div class="sub-hdr" style="color:' + mcol + '">🎯 تلاعب السيولة: ' + esc(mlabel) + ' · قوة ' + Math.round(manip.primary.strength || 0) + '</div>'
        + ((manip.primary.level != null) ? '<div class="kv"><span class="kv-key">المستوى</span><span class="kv-val">' + fmt(manip.primary.level, d) + '</span></div>' : '')
        + '<p style="font-size:11px;color:#cbd5e1;line-height:1.5">' + esc(manip.primary.note || '') + '</p>'
        + '</div>';
    }

    // ── v4.6.11 P2 #10 — KillZone session context (time-based, global) ─────
    var kz = p.killZone;
    var kzHtml = '';
    if (kz && kz.killZone) {
      var kzMap = { ASIA_KZ: 'نطاق آسيا', LONDON_KZ: 'نطاق لندن', NY_AM_KZ: 'نطاق نيويورك (صباح)', LONDON_CLOSE_KZ: 'إغلاق لندن', NONE: 'خارج النطاقات النشطة' };
      var kzLabel = kzMap[kz.killZone] || kz.killZone;
      var kzCol = kz.vetoed ? '#f59e0b' : (kz.killZone !== 'NONE' ? '#10b981' : '#64748b');
      var q = Math.round(kz.quality || 0);
      var stars = '';
      for (var qi = 0; qi < 3; qi++) stars += (qi < q) ? '★' : '☆';
      kzHtml = '<div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid ' + kzCol + '40;margin-bottom:12px">'
        + '<div class="sub-hdr" style="color:' + kzCol + '">⏱️ نطاق الجلسة: ' + esc(kzLabel) + ' ' + stars + (kz.vetoed ? ' · موقوف' : '') + '</div>'
        + '<div class="kv"><span class="kv-key">الوزن</span><span class="kv-val">×' + (kz.weight != null ? kz.weight.toFixed(2) : '—') + '</span></div>'
        + '<p style="font-size:11px;color:#94a3b8;line-height:1.5">' + esc(kz.reasoning || '') + '</p>'
        + '</div>';
    }

    // ── v4.6.12 P2 #11 — EOD day-trading gate ──────────────────────────────
    var eod = p.eodGate;
    var eodHtml = '';
    if (eod && (eod.vetoed || eod.warning)) {
      var eodCol = eod.vetoed ? '#ef4444' : '#f59e0b';
      var eodTxt = eod.reason || eod.warning || '';
      var hc = (eod.hoursToClose != null && eod.hoursToClose > 0) ? ' · ' + eod.hoursToClose.toFixed(1) + 'س للإغلاق' : '';
      eodHtml = '<div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid ' + eodCol + '40;margin-bottom:12px">'
        + '<div class="sub-hdr" style="color:' + eodCol + '">⏳ بوابة الإغلاق اليومي' + hc + '</div>'
        + '<p style="font-size:11px;color:#cbd5e1;line-height:1.5">' + esc(eodTxt) + '</p>'
        + '</div>';
    }

    // ── v4.6.13 P2 #12 — Calendar feedback (past surprises still moving bias) ─
    var cf = p.calendarFeedback;
    var cfHtml = '';
    if (cf && cf.signals && cf.signals.length > 0) {
      var cfCcys = {};
      cfCcys[(p.symbol || '').slice(0,3)] = true;
      cfCcys[(p.symbol || '').slice(3,6)] = true;
      if ((p.symbol || '').indexOf('XAU') === 0) cfCcys['USD'] = true;
      var rele = cf.signals.filter(function(s){ return cfCcys[s.currency]; });
      if (rele.length === 0) rele = cf.signals.slice(0, 4);
      var cfRows = rele.slice(0, 6).map(function(s){
        var col = s.direction === 'BULLISH' ? '#10b981' : (s.direction === 'BEARISH' ? '#ef4444' : '#94a3b8');
        return '<div style="padding:4px 0;border-bottom:1px solid rgba(71,85,105,0.15)">'
          + '<div style="display:flex;justify-content:space-between;gap:8px">'
            + '<span style="font-size:11px;color:#cbd5e1">' + esc(s.currency) + ' · ' + esc(s.eventTitle) + '</span>'
            + '<span style="font-size:10px;color:' + col + ';font-weight:600;font-family:monospace;white-space:nowrap">' + esc(s.direction) + ' ' + Math.round(s.magnitude || 0) + '</span>'
          + '</div>'
          + '<span style="font-size:9.5px;color:#64748b">' + (s.minutesAgo || 0) + 'د مضت · تلاشٍ ' + Math.round((s.decayFactor || 0) * 100) + '%</span>'
          + '</div>';
      }).join('');
      cfHtml = '<div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #1e2d3d;margin-bottom:12px">'
        + '<div class="sub-hdr">📅 أثر بيانات سابقة (لا يزال يحرّك الانحياز)</div>'
        + cfRows
        + '</div>';
    }

    const vCol = p.verdict === "BUY" ? "#10b981" : p.verdict === "SELL" ? "#ef4444" : "#64748b";

    body.innerHTML =
      '<div class="detail">' +
        // v4.6.1 P0 — Pre-News warning surfaces at the TOP because it's time-critical
        pnwHtml +
        '<div style="background:#0f172a;border-radius:8px;padding:12px;margin-bottom:12px;border:1px solid ' + vCol + '40">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">' +
            '<span style="color:' + vCol + ';font-size:18px;font-weight:700">' + esc(p.verdict) + '</span>' +
            '<span style="font-size:11px;color:#64748b">Composite ' + fmtS(p.scores && p.scores.composite, 1) + ' · Confidence ' + fmt(p.scores && p.scores.confidence, 0) + ' (' + esc((p.scores && p.scores.confidenceTier) || "—") + ')</span>' +
          '</div>' +
          '<p style="font-size:13px;color:#e2e8f0;line-height:1.5">' + esc(ve.headline || (p.summary && p.summary.split("\\n")[0]) || "") + '</p>' +
          calLine +
        '</div>' +

        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">' +
          '<div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #1e2d3d">' +
            '<div class="sub-hdr">توزيع النقاط</div>' + bars +
          '</div>' +
          '<div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #1e2d3d">' +
            '<div class="sub-hdr">خطة التداول</div>' + planHtml +
          '</div>' +
        '</div>' +

        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">' +
          '<div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #1e2d3d">' +
            '<div class="sub-hdr">VWAP</div>' + vwapHtml +
          '</div>' +
          '<div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #1e2d3d">' +
            '<div class="sub-hdr">المستويات المرجعية</div>' +
            '<div class="kv"><span class="kv-key">PDH/PDL</span><span class="kv-val">' + fmt(sl.pdh, d) + ' / ' + fmt(sl.pdl, d) + '</span></div>' +
            '<div class="kv"><span class="kv-key">Asia High/Low</span><span class="kv-val">' + fmt(sl.asiaHigh, d) + ' / ' + fmt(sl.asiaLow, d) + '</span></div>' +
            '<div class="kv"><span class="kv-key">Weekly Open</span><span class="kv-val">' + fmt(sl.weeklyOpen, d) + '</span></div>' +
            '<div class="kv"><span class="kv-key">London Open</span><span class="kv-val">' + fmt(sl.londonOpen, d) + '</span></div>' +
          '</div>' +
        '</div>' +

        // v4.6 Phase A — NEW Argument Cards (Arabic structured)
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">' +
          '<div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #1e2d3d">' +
            '<div class="sub-hdr" style="color:#10b981">📈 حجج للشراء (' + ((argReport.buyCards || []).length) + ')</div>' +
            buyCardsHtml +
          '</div>' +
          '<div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #1e2d3d">' +
            '<div class="sub-hdr" style="color:#ef4444">📉 حجج للبيع (' + ((argReport.sellCards || []).length) + ')</div>' +
            sellCardsHtml +
          '</div>' +
        '</div>' +

        // v4.6 Phase A — Invalidation scenario
        (invalTriggers ? ('<div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #f59e0b40;margin-bottom:12px">' +
          '<div class="sub-hdr" style="color:#fbbf24">🤔 ماذا لو غلطت؟ — السيناريو المعكوس</div>' +
          '<ul style="list-style:none;font-size:11.5px;line-height:1.7;color:#fde68a;padding:0">' + invalTriggers + '</ul>' +
        '</div>') : '') +

        // v4.6.1 P0 — Judge Override V4 card (only when judge intervened)
        joHtml +

        confHtml +
        fibHtml +
        pivHtml +
        orbHtml +
        divHtml +
        manipHtml +
        kzHtml +
        eodHtml +
        cfHtml +

        // Legacy bull/bear cases (kept for compat)
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">' +
          '<div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #1e2d3d">' +
            '<div class="sub-hdr" style="color:#10b981">▲ الحجج الصاعدة (legacy)</div>' +
            '<ul style="list-style:none;font-size:11px;line-height:1.6;color:#94a3b8">' + bullHtml + '</ul>' +
          '</div>' +
          '<div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #1e2d3d">' +
            '<div class="sub-hdr" style="color:#ef4444">▼ الحجج الهابطة (legacy)</div>' +
            '<ul style="list-style:none;font-size:11px;line-height:1.6;color:#94a3b8">' + bearHtml + '</ul>' +
          '</div>' +
        '</div>' +

        (p.verdict === "WAIT" && ((ve.missing && ve.missing.length) || (ve.nextSteps && ve.nextSteps.length)) ?
          '<div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #1e2d3d;margin-bottom:12px">' +
            '<div class="sub-hdr" style="color:#f59e0b">الشروط الناقصة / الخطوة التالية</div>' +
            (ve.missing || []).map(x => '<p style="font-size:12px;color:#94a3b8;margin:2px 0">• ' + esc(x) + '</p>').join("") +
            (ve.nextSteps || []).map(x => '<p style="font-size:12px;color:#64748b;margin:2px 0">→ ' + esc(x) + '</p>').join("") +
          '</div>'
          : "") +

        // v4.5 — Volume Profile
        (function() {
          var vp = p.volumeProfile;
          if (!vp || !vp.available) return '';
          return '<div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #1e2d3d;margin-bottom:12px">' +
            '<div class="sub-hdr">Volume Profile (يومي)</div>' +
            '<p style="font-size:11px;color:#94a3b8;margin-bottom:6px">' + esc(vp.reasoning || "") + '</p>' +
            '<div class="kv"><span class="kv-key">POC</span><span class="kv-val" style="color:#fbbf24">' + fmt(vp.poc, d) + ' (' + (vp.pocDistancePips >= 0 ? '+' : '') + vp.pocDistancePips + 'p)</span></div>' +
            '<div class="kv"><span class="kv-key">VAH / VAL</span><span class="kv-val">' + fmt(vp.vah, d) + ' / ' + fmt(vp.val, d) + '</span></div>' +
            '<div class="kv"><span class="kv-key">Position</span><span class="kv-val">' + esc(vp.position || "—") + '</span></div>' +
            '</div>';
        })() +

        // v4.5 — Pair correlation top-3 + double-exposure warning
        (function() {
          var sym = p.symbol;
          var corr = snapshotCache && snapshotCache.pairCorrelation;
          if (!corr || !corr.topCorrelated || !corr.topCorrelated[sym]) return '';
          var tops = corr.topCorrelated[sym];
          if (!tops || tops.length === 0) return '';
          var rows = tops.map(function(t) {
            var c = t.corr;
            var col = c > 0.7 ? '#10b981' : c < -0.7 ? '#ef4444' : '#64748b';
            return '<div class="kv"><span class="kv-key">' + esc(t.symbol) + '</span><span class="kv-val" style="color:' + col + ';font-family:monospace">' + (c >= 0 ? '+' : '') + c.toFixed(2) + '</span></div>';
          }).join('');
          return '<div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #1e2d3d;margin-bottom:12px">' +
            '<div class="sub-hdr">أقوى ارتباطات (آخر 24س)</div>' +
            '<p style="font-size:10.5px;color:#64748b;margin-bottom:6px">|ρ| ≥ 0.7 = double exposure إذا فُتح في نفس الاتجاه</p>' +
            rows +
            '</div>';
        })() +

        // v4.6.1 P0 — CB Speech report (placed before news so user sees policy stance first)
        srHtml +

        '<div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #1e2d3d;margin-bottom:12px">' +
          '<div class="sub-hdr">أحدث الأخبار</div>' +
          '<p style="font-size:11px;color:#64748b;margin-bottom:4px">مشاعر: <span class="' + sign(news.pairScore) + '">' + fmtS(news.pairScore) + '</span></p>' +
          breakingLine +
          '<ul style="list-style:none;font-size:12px;line-height:1.8;padding:0">' + newsHtml + '</ul>' +
        '</div>' +

        ((risk.reasons && risk.reasons.length) ?
          '<div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #ef444440">' +
            '<div class="sub-hdr" style="color:#ef4444">بوابة المخاطر (WAIT)</div>' +
            risk.reasons.map(r => '<p style="font-size:12px;color:#94a3b8;margin:2px 0">• ' + esc(r) + '</p>').join("") +
          '</div>'
          : "") +
      '</div>';
  }

  // ── Calendar ──────────────────────────────────────────────────────────────
  function renderCalendar(data) {
    const body = $("#calendar-body");
    const src  = $("#cal-source");
    if (!body) return;

    const all = ((data && data.calendarEvents) || [])
      .filter(e => e.minutesFromNow >= -240 && e.minutesFromNow <= 24 * 60)
      .slice(0, 50);

    // Show source freshness in the header (v3.4.2: faireconomy is the only calendar source)
    if (src) {
      const h = data && data.dataSourceHealth && data.dataSourceHealth["faireconomy"];
      const status = h && h.ok ? "faireconomy" : "calendar offline";
      src.textContent = status + " · " + all.length + " أحداث";
    }

    if (!all.length) {
      body.innerHTML = '<p style="padding:12px;color:#64748b">لا أحداث خلال 24 ساعة</p>';
      return;
    }

    const past     = all.filter(e => e.minutesFromNow < -1);
    const live     = all.filter(e => e.minutesFromNow >= -1 && e.minutesFromNow <= 2);
    const upcoming = all.filter(e => e.minutesFromNow > 2);

    const highToday   = all.filter(e => e.impact === "HIGH").length;
    const betterCount = past.filter(e => e.surpriseDir === "BETTER").length;
    const worseCount  = past.filter(e => e.surpriseDir === "WORSE").length;
    const pending     = past.filter(e => e.pendingActual && (e.impact === "HIGH" || e.impact === "MEDIUM")).length;

    const summaryBar = '<div class="cal-summary">' +
      '<div class="cal-stat high"><strong>' + highToday + '</strong> HIGH اليوم</div>' +
      '<div class="cal-stat better"><strong>' + betterCount + '</strong> أفضل</div>' +
      '<div class="cal-stat worse"><strong>' + worseCount + '</strong> أسوأ</div>' +
      (pending > 0 ? '<div class="cal-stat pending"><strong>' + pending + '</strong> قيد الانتظار ⟳</div>' : "") +
      '<div style="margin-inline-start:auto">' +
        '<button onclick="window.forceCalRefresh()" style="padding:2px 8px;border:1px solid #334155;border-radius:4px;background:transparent;color:#94a3b8;font-size:11px;cursor:pointer">تحديث الكاليندر</button>' +
      '</div>' +
    '</div>';

    const header = '<div class="cal-row" style="font-size:10px;text-transform:uppercase;color:#475569;border-bottom:1px solid #1e2d3d;opacity:.7">' +
      '<span>الوقت</span><span></span><span>عملة</span><span>الحدث</span>' +
      '<span style="text-align:left">السابق</span>' +
      '<span style="text-align:left">التوقع</span>' +
      '<span style="text-align:left">الفعلي/Δ</span>' +
    '</div>';

    function row(e) {
      const mins    = Math.round(e.minutesFromNow);
      const isLive  = mins >= -1 && mins <= 2;
      const isPast  = mins < -1;
      const timeStr = new Date(e.dateUtc).toISOString().slice(11, 16);

      let minsTxt = "", minsCls = "cal-mins-past";
      if (isLive) {
        minsTxt = "LIVE"; minsCls = "cal-mins-now";
      } else if (mins > 0 && mins < 60) {
        minsTxt = mins + "m"; minsCls = mins < 30 ? "cal-mins-now" : "cal-mins-soon";
      } else if (mins >= 60) {
        minsTxt = Math.round(mins / 60) + "h"; minsCls = "cal-mins-soon";
      } else {
        minsTxt = (-mins) + "m ago"; minsCls = "cal-mins-past";
      }

      let actualHtml = '<span class="cal-actual-none">—</span>';
      if (e.actual) {
        const dir = e.surpriseDir;
        const cls = dir === "BETTER" ? "cal-actual-better" : dir === "WORSE" ? "cal-actual-worse" : dir === "INLINE" ? "cal-actual-inline" : "cal-actual-none";
        const arrow = dir === "BETTER" ? " ↑" : dir === "WORSE" ? " ↓" : "";
        let badge = "";
        if (e.deltaAbs != null && Math.abs(e.deltaAbs) >= 0.0001) {
          const bCls = dir === "BETTER" ? "cal-delta-better" : dir === "WORSE" ? "cal-delta-worse" : "cal-delta-inline";
          const sgn  = e.deltaAbs > 0 ? "+" : "";
          const val  = Math.abs(e.deltaAbs) < 1 ? sgn + e.deltaAbs.toFixed(2) : sgn + e.deltaAbs.toFixed(1);
          badge = '<span class="cal-delta ' + bCls + '">' + val + '</span>';
        } else if (dir === "INLINE") {
          badge = '<span class="cal-delta cal-delta-inline">= متوقع</span>';
        }
        const srcLine = e.actualSource ? '<span class="cal-actual-src">via ' + esc(e.actualSource) + '</span>' : '';
        actualHtml = '<div style="display:flex;flex-direction:column;align-items:flex-start;gap:1px">' +
          '<span class="' + cls + '">' + esc(e.actual) + arrow + '</span>' + badge + srcLine + '</div>';
      } else if (e.pendingActual) {
        // v3.4: distinguish recent-pending vs stale-delayed
        if (mins > -90) {
          actualHtml = '<span style="color:#f59e0b;font-size:11px">جاري... ⟳</span>';
        } else {
          actualHtml = '<span style="color:#64748b;font-size:11px">مُتأخر</span>';
        }
      } else if (!isPast) {
        actualHtml = '<span style="color:#334155">—</span>';
      }

      const ctx  = calCtx(e.title);
      const rowC = isLive ? "cal-row cal-live" : isPast ? "cal-row cal-past" : "cal-row";
      return '<div class="' + rowC + '">' +
        '<span class="' + minsCls + '" style="display:flex;flex-direction:column;gap:1px">' +
          '<span style="font-weight:600">' + timeStr + '</span>' +
          '<span style="font-size:10px">' + minsTxt + '</span>' +
        '</span>' +
        '<span style="display:flex;align-items:center"><span class="cal-dot cal-dot-' + e.impact + '"></span></span>' +
        '<span style="font-weight:700;color:#e2e8f0">' + esc(e.country) + '</span>' +
        '<div>' +
          '<span style="color:#e2e8f0">' + esc(e.title) + '</span>' +
          (ctx ? '<span class="cal-ctx">' + ctx + '</span>' : "") +
        '</div>' +
        '<span style="font-family:monospace;color:#64748b">' + esc(e.previous || "—") + '</span>' +
        '<span style="font-family:monospace;color:#64748b">' + esc(e.forecast || "—") + '</span>' +
        '<span>' + actualHtml + '</span>' +
      '</div>';
    }

    let html = summaryBar + header;
    if (past.length || live.length) {
      html += '<div class="cal-section-hdr">أحداث منتهية</div>';
      html += [].concat(live, past.slice().reverse()).map(row).join("");
    }
    if (upcoming.length) {
      html += '<div class="cal-section-hdr cal-section-upcoming">▼ أحداث قادمة</div>';
      html += upcoming.map(row).join("");
    }
    body.innerHTML = html;

    // Auto-refresh aggressively if pending actuals exist
    if (pending > 0 && !window._calTimer) {
      window._calTimer = setInterval(() => {
        loadSnapshot(true).then(() => {
          const events = (snapshotCache && snapshotCache.calendarEvents) || [];
          const still = events.filter(e =>
            e.pendingActual && (e.impact === "HIGH" || e.impact === "MEDIUM")
          ).length;
          if (!still) { clearInterval(window._calTimer); window._calTimer = null; }
        });
      }, 20000);  // every 20s while pending
    }
  }

  function calCtx(title) {
    const t = (title || "").toLowerCase();
    if (/pmi/.test(t))                          return "PMI > 50 = توسع";
    if (/federal funds|interest rate/.test(t))  return "قرار الفائدة";
    if (/non.farm|nfp/.test(t))                 return "NFP — أهم بيان توظيف أمريكي";
    if (/fomc statement/.test(t))               return "بيان مجلس الاحتياطي";
    if (/\\bcpi\\b/.test(t))                      return "التضخم — الأدنى أفضل";
    if (/gdp/.test(t))                          return "الناتج المحلي";
    if (/retail sales/.test(t))                 return "مؤشر الإنفاق";
    if (/unemployment|jobless/.test(t))         return "البطالة — الأدنى أفضل";
    return "";
  }

  window.forceCalRefresh = function() { return loadSnapshot(true); };

  // ── Snapshot loader ───────────────────────────────────────────────────────
  async function loadSnapshot(force) {
    if (force === undefined) force = false;
    setStatus("جاري التحميل...", null);
    const btn = $("#btn-refresh");
    if (btn) { btn.disabled = true; btn.textContent = "⟳ تحميل..."; }

    try {
      const url = force ? "/api/snapshot?force=1" : "/api/snapshot";
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      snapshotCache = data;

      renderSources(data);
      renderGPR(data);
      renderCurrencyStrength(data);
      renderCBStance(data);
      renderVerdictChanges(data);
      renderBreakingBanner(data);
      renderTable(data);
      renderCalendar(data);
      renderCorrelationHeatmap(data);

      // v3.5.3: detect rapid mode DIRECTLY from snapshot data — no race condition,
      // no separate /api/state round-trip. Single source of truth.
      detectAndApplyRapidMode(data);

      const ts = $("#snap-ts");
      if (ts && data.generatedUtc) ts.textContent = new Date(data.generatedUtc).toLocaleTimeString();

      const lu = $("#last-update");
      if (lu) lu.textContent = "آخر تحديث: " + new Date().toLocaleTimeString();

      if (currentSymbol) {
        const p = (data.pairs || []).find(x => x.symbol === currentSymbol);
        if (p) renderDetail(p);
      }

      setStatus("متصل ✓", true);
    } catch (e) {
      setStatus("خطأ: " + e.message, false);
      console.error("Snapshot error:", e);
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-rotate-right"></i> تحديث'; }
      // v3.5.3: schedule next refresh using current rapid state — adaptive polling
      scheduleNextRefresh();
    }
  }

  // ─── v3.5.3: rapid mode detection (from snapshot, not /api/state) ────────
  // Race-free: rapid mode is a function of the snapshot we just loaded.
  let rapidMode = false;
  function setRapidIndicator(on, reasons) {
    const dot = document.getElementById("rapid-dot");
    const txt = document.getElementById("rapid-text");
    if (!dot || !txt) return;
    if (on) {
      dot.style.display = "inline-block";
      dot.classList.add("rapid-pulse");
      txt.textContent = "وضع سريع " + (reasons && reasons.length ? "(" + reasons[0] + ")" : "");
      txt.style.color = "#f97316";
    } else {
      dot.style.display = "none";
      dot.classList.remove("rapid-pulse");
      txt.textContent = "تحديث عادي";
      txt.style.color = "#64748b";
    }
  }

  function detectAndApplyRapidMode(data) {
    if (!data || !Array.isArray(data.pairs)) {
      rapidMode = false;
      setRapidIndicator(false, []);
      return;
    }
    var breakingPairs = data.pairs.filter(function(p) {
      return p && p.news && (p.news.breakingActive || (p.news.interventionRegime && p.news.interventionRegime.active));
    });
    rapidMode = breakingPairs.length > 0;
    var reasons = breakingPairs.slice(0, 2).map(function(p) {
      var t = (p.news.breakingType && p.news.breakingType !== "NONE") ? p.news.breakingType : "BREAKING";
      var ccys = (p.news.breakingCurrencies || []).slice(0, 2).join(",");
      return p.symbol + ": " + t + (ccys ? " " + ccys : "");
    });
    setRapidIndicator(rapidMode, reasons);
  }

  function scheduleNextRefresh() {
    if (!autoEnabled) return;
    if (autoTimer) clearTimeout(autoTimer);
    var delay = rapidMode ? 5000 : 15000;
    autoTimer = setTimeout(function() { loadSnapshot(false); }, delay);
  }

  function toggleAuto() {
    const cb = $("#auto-check");
    autoEnabled = cb ? cb.checked : true;
    if (autoEnabled) {
      scheduleNextRefresh();
    } else {
      if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
      setRapidIndicator(false, []);
    }
  }

  window.toggleAuto = toggleAuto;
  window.refresh = function() { return loadSnapshot(true); };

  function init() {
    const btn = $("#btn-refresh");
    if (btn) btn.addEventListener("click", function() { loadSnapshot(true); });
    const cb = $("#auto-check");
    if (cb) cb.addEventListener("change", toggleAuto);
    // v3.5.3: NO MORE legacy 30s setInterval. loadSnapshot schedules its own
    // next refresh via scheduleNextRefresh() in the finally block.
    loadSnapshot(true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
  window.init = init;
})();
`;

// ─── Dashboard HTML ───────────────────────────────────────────────────────────
app.get("/", c => c.html(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Trading Court Pro v${VERSION}</title>
<link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" rel="stylesheet" crossorigin="anonymous">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
:root {
  --bg:#0a0e1a;--bg2:#111827;--bg3:#1f2937;
  --border:#1e2d3d;--text:#e2e8f0;--text2:#94a3b8;--text3:#64748b;
  --amber:#f59e0b;--green:#10b981;--red:#ef4444;--blue:#3b82f6;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:"IBM Plex Sans Arabic",sans-serif;min-height:100vh}
header{background:linear-gradient(135deg,#0f172a,#1e1b4b);border-bottom:1px solid var(--border);padding:16px 20px;text-align:center}
header h1{font-size:22px;font-weight:700}
header h1 span{color:var(--amber)}
header p{font-size:12px;color:var(--text2);margin-top:4px}
.toolbar{display:flex;align-items:center;justify-content:center;gap:12px;padding:12px 20px;background:var(--bg2);border-bottom:1px solid var(--border);flex-wrap:wrap}
.btn{padding:8px 18px;border-radius:8px;border:none;cursor:pointer;font-weight:600;font-size:13px;transition:all .15s;font-family:inherit}
.btn-primary{background:var(--amber);color:#0a0e1a}
.btn-primary:hover{background:#d97706}
.btn-primary:disabled{opacity:.5;cursor:wait}
.auto-label{font-size:13px;color:var(--text2);display:flex;align-items:center;gap:6px}
.status-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.dot-ok{background:var(--green);box-shadow:0 0 6px #10b981}
.dot-fail{background:var(--red)}
.dot-loading{background:var(--amber);animation:pulseS .8s infinite}
@keyframes pulseS{0%,100%{opacity:1}50%{opacity:.4}}
/* v3.5.2: rapid-mode indicator — orange dot with strong pulse */
.rapid-dot{width:9px;height:9px;border-radius:50%;display:inline-block;background:#f97316;box-shadow:0 0 10px #f97316}
.rapid-pulse{animation:rapidPulse .6s ease-in-out infinite}
@keyframes rapidPulse{
  0%,100%{transform:scale(1);box-shadow:0 0 10px #f97316}
  50%{transform:scale(1.4);box-shadow:0 0 18px #fb923c}
}
main{padding:16px;max-width:1400px;margin:0 auto;display:grid;grid-template-columns:1fr;gap:14px}
@media(min-width:1024px){main{grid-template-columns:7fr 5fr}}
section{background:var(--bg2);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.sec-hdr{padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.sec-hdr h2{font-size:14px;font-weight:600}
.ts{font-size:11px;color:var(--text3)}
table{width:100%;border-collapse:collapse;font-size:12px}
th{padding:8px 10px;color:var(--text2);font-weight:500;text-align:right;border-bottom:1px solid var(--border);background:var(--bg3);font-size:11px;white-space:nowrap}
td{padding:9px 10px;border-bottom:1px solid rgba(30,45,61,.5);vertical-align:middle}
tr:hover td{background:rgba(30,45,61,.4);cursor:pointer}
tr.selected td{background:rgba(245,158,11,.08)}
.detail-empty{color:var(--text3);text-align:center;padding:40px}
.kv{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid rgba(30,45,61,.4);font-size:12px}
.kv:last-child{border-bottom:none}
.kv-key{color:var(--text3);font-size:11px}
.kv-val{font-weight:500;font-family:'SF Mono',Consolas,monospace}
.kv-val.pos{color:var(--green)}.kv-val.neg{color:var(--red)}.kv-val.warn{color:var(--amber)}
.sub-hdr{font-size:11px;font-weight:600;color:var(--amber);text-transform:uppercase;letter-spacing:.05em;margin:10px 0 6px;padding-bottom:4px;border-bottom:1px solid rgba(245,158,11,.2)}
.full-cal{grid-column:1/-1}
footer{text-align:center;padding:20px;font-size:11px;color:var(--text3);border-top:1px solid var(--border);margin-top:8px}
${INLINE_CSS}
</style>
</head>
<body>
<header>
  <h1>⚖️ Trading Court <span>Pro</span> ⚖️</h1>
  <p>FX Majors & Gold • Real-time • محكمة التداول اليومي • v${VERSION}</p>
</header>
<div class="toolbar">
  <button id="btn-refresh" class="btn btn-primary">
    <i class="fa-solid fa-rotate-right"></i> تحديث
  </button>
  <label class="auto-label">
    <input type="checkbox" id="auto-check" checked> تلقائي
  </label>
  <span class="auto-label">
    <span id="rapid-dot" class="rapid-dot" style="display:none"></span>
    <span id="rapid-text" style="font-size:11px;color:var(--text3)">تحديث عادي</span>
  </span>
  <span class="auto-label">
    <span id="status-dot" class="status-dot dot-loading"></span>
    <span id="status-txt">جاري التحميل...</span>
  </span>
  <span id="last-update" class="auto-label" style="font-size:11px;color:var(--text3)"></span>
</div>
<div id="source-bar" class="src-bar"></div>
<div id="gpr-host"></div>
<div id="strength-host"></div>
<div id="cbstance-host"></div>
<div id="changes-host"></div>
<div id="breaking-host"></div>
<main>
  <section>
    <div class="sec-hdr">
      <h2><i class="fa-solid fa-scale-balanced" style="color:var(--amber)"></i> الأحكام</h2>
      <span id="snap-ts" class="ts"></span>
    </div>
    <div style="overflow-x:auto">
      <table>
        <thead><tr>
          <th>الزوج</th><th>السعر (BID/ASK)</th><th>النظام</th>
          <th>MTF</th><th>ثقة</th><th>جلسة</th><th>الفرصة</th><th>الحكم</th>
        </tr></thead>
        <tbody id="pair-rows"></tbody>
      </table>
    </div>
  </section>
  <section>
    <div class="sec-hdr">
      <h2><i class="fa-solid fa-file-lines" style="color:var(--amber)"></i> الملف التفصيلي</h2>
      <span id="detail-ts" class="ts"></span>
    </div>
    <div id="detail-body">
      <p class="detail-empty">انقر على أي زوج لعرض الملف الكامل</p>
    </div>
  </section>
  <section class="full-cal">
    <div class="sec-hdr">
      <h2><i class="fa-solid fa-calendar-days" style="color:var(--amber)"></i> التقويم الاقتصادي (24 ساعة)</h2>
      <span id="cal-source" class="ts">جاري التحميل...</span>
    </div>
    <div id="calendar-body" style="padding:10px"></div>
  </section>
  <section class="full-cal">
    <div class="sec-hdr">
      <h2><i class="fa-solid fa-table-cells" style="color:var(--amber)"></i> مصفوفة الارتباط (13×13)</h2>
      <span class="ts">M15</span>
    </div>
    <div id="heatmap-body" style="padding:6px"></div>
  </section>
</main>
<footer>⚖️ Trading Court Pro v${VERSION} — Decision Support System • لا يستبدل الحكم البشري. لا يرسل أوامر تداول.</footer>
<script>
${INLINE_JS}
</script>
</body>
</html>`));

// ─── Start ────────────────────────────────────────────────────────────────────
console.log("\n⚖️  Trading Court Pro v" + VERSION);
console.log(`🚀 Starting on port ${PORT}...`);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`✅ Running at http://0.0.0.0:${info.port}`);
  setTimeout(() => {
    console.log("⟳  Warming up snapshot cache...");
    getSnapshot(true)
      .then(s => console.log(`✅ Snapshot ready: ${s.pairs.length} pairs, ${s.calendarEvents.length} calendar events, ${(s.breakingNews ?? []).length} breaking news`))
      .catch(e => console.error("⚠️  Warmup error:", e));
  }, 500);
});

export default app;
