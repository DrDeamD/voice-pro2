// ============================================================================
// Trading Court Pro — Hono entry point
// ============================================================================
import { Hono } from "hono";
import { cors } from "hono/cors";

import { INSTRUMENTS } from "./config";
import { analyzePair } from "./engines/court";
import { fetchCalendar, upcomingFor } from "./fetchers/calendar";
import { sourceHealth } from "./http";
import type { Snapshot } from "./types";

const app = new Hono();

app.use("/api/*", cors());

// -----------------------------------------------------------------------------
// In-memory snapshot cache (KV-free, edge-safe)
// -----------------------------------------------------------------------------
let snapshotCache: { data: Snapshot; expires: number } | null = null;
const SNAPSHOT_TTL_MS = 30_000;

async function getSnapshot(force = false): Promise<Snapshot> {
  if (!force && snapshotCache && snapshotCache.expires > Date.now()) {
    return snapshotCache.data;
  }
  const symbols = Object.keys(INSTRUMENTS);
  const calendarEvents = await fetchCalendar();
  const results = await Promise.allSettled(
    symbols.map(s => analyzePair(s, calendarEvents))
  );
  const pairs: any[] = [];
  const errors: Record<string, string> = {};
  results.forEach((r, i) => {
    if (r.status === "fulfilled") pairs.push(r.value);
    else errors[symbols[i]] = String(r.reason).slice(0, 200);
  });

  const snap: Snapshot = {
    generatedUtc: new Date().toISOString(),
    pairs,
    errors,
    calendarEvents,
    dataSourceHealth: Object.fromEntries(
      Object.entries(sourceHealth)
        .filter(([k]) => ["faireconomy", "swissquote", "tradingview", "kraken", "stooq", "gnews", "tv_context"].includes(k))
        .map(([k, v]) => [k, {
          ok: v.ok,
          lastSuccess: v.lastSuccess,
          note: v.note,
        }])
    ),
  };
  snapshotCache = { data: snap, expires: Date.now() + SNAPSHOT_TTL_MS };
  return snap;
}

// -----------------------------------------------------------------------------
// API
// -----------------------------------------------------------------------------
app.get("/healthz", c => c.json({ ok: true, ts: Date.now() }));

app.get("/api/snapshot", async c => {
  const force = c.req.query("force") === "1";
  const snap = await getSnapshot(force);
  return c.json(snap);
});

app.get("/api/pair/:symbol", async c => {
  const sym = c.req.param("symbol").toUpperCase().replace(/[\/=X-]/g, "");
  if (!INSTRUMENTS[sym]) return c.json({ error: `Unknown symbol ${sym}` }, 404);
  const calendarEvents = await fetchCalendar();
  const analysis = await analyzePair(sym, calendarEvents);
  return c.json(analysis);
});

app.get("/api/calendar", async c => {
  const events = await fetchCalendar();
  const horizon = Number(c.req.query("hours") || "24");
  const ccy = c.req.query("ccy");
  const filtered = ccy
    ? events.filter(e => e.country === ccy.toUpperCase() && e.minutesFromNow > -5 && e.minutesFromNow < horizon * 60)
    : events.filter(e => e.minutesFromNow > -5 && e.minutesFromNow < horizon * 60);
  return c.json({ events: filtered, count: filtered.length });
});

app.get("/api/sources", c => {
  // Only expose real data sources; hide internal/phantom entries
  const KNOWN_SOURCES = ["faireconomy", "swissquote", "tradingview", "kraken", "stooq", "gnews", "tv_context"];
  const filtered: Record<string, any> = {};
  for (const key of KNOWN_SOURCES) {
    if (sourceHealth[key]) filtered[key] = sourceHealth[key];
  }
  return c.json({
    sources: filtered,
    total: Object.keys(filtered).length,
    healthy: Object.values(filtered).filter((s: any) => s.ok).length,
  });
});

// -----------------------------------------------------------------------------
// Dashboard
// -----------------------------------------------------------------------------
app.get("/", c => {
  return c.html(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Trading Court Pro ⚖️ — محكمة التداول اليومي</title>
<script src="https://cdn.tailwindcss.com"></script>
<link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
<link href="/static/style.css" rel="stylesheet">
</head>
<body class="bg-slate-950 text-slate-100 font-sans min-h-screen">

<header class="bg-slate-900/80 backdrop-blur border-b border-slate-800 sticky top-0 z-20">
  <div class="max-w-[1600px] mx-auto px-4 py-3 flex items-center justify-between flex-wrap gap-3">
    <div class="flex items-center gap-3">
      <span class="text-3xl">⚖️</span>
      <div>
        <h1 class="text-xl font-bold tracking-tight">Trading Court <span class="text-amber-400">Pro</span></h1>
        <p class="text-xs text-slate-400">محكمة التداول اليومي — FX Majors & Gold • Real-time • No API keys</p>
      </div>
    </div>
    <div class="flex items-center gap-3">
      <span id="data-freshness" class="text-xs text-slate-400">—</span>
      <button id="refresh-btn" class="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded text-sm">
        <i class="fa-solid fa-rotate"></i> تحديث
      </button>
      <label class="flex items-center gap-1.5 text-xs cursor-pointer">
        <input id="auto-refresh" type="checkbox" checked class="accent-amber-500">
        تلقائي
      </label>
    </div>
  </div>
  <div id="source-health" class="max-w-[1600px] mx-auto px-4 pb-2 flex flex-wrap gap-2 text-xs"></div>
</header>

<!-- Opportunity banner -->
<section id="opp-banner" class="max-w-[1600px] mx-auto px-4 pt-4"></section>

<main class="max-w-[1600px] mx-auto px-4 py-4 grid grid-cols-12 gap-4">
  <!-- Left: table -->
  <section class="col-span-12 xl:col-span-7 bg-slate-900/60 rounded-lg border border-slate-800 overflow-hidden">
    <div class="flex items-center justify-between px-4 py-3 border-b border-slate-800">
      <h2 class="font-bold text-slate-200"><i class="fa-solid fa-scale-balanced text-amber-400"></i> الأحكام</h2>
      <span class="text-xs text-slate-500">انقر على أي زوج لعرض الملف الكامل</span>
    </div>
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="bg-slate-800/60 text-xs uppercase tracking-wider text-slate-400">
          <tr>
            <th class="px-3 py-2 text-right">الزوج</th>
            <th class="px-3 py-2">السعر (Bid/Ask)</th>
            <th class="px-3 py-2">النظام</th>
            <th class="px-3 py-2">MTF</th>
            <th class="px-3 py-2">ثقة</th>
            <th class="px-3 py-2">جلسة</th>
            <th class="px-3 py-2">الفرصة</th>
            <th class="px-3 py-2">الحكم</th>
          </tr>
        </thead>
        <tbody id="pair-rows"></tbody>
      </table>
    </div>
  </section>

  <!-- Right: detail pane -->
  <section class="col-span-12 xl:col-span-5 bg-slate-900/60 rounded-lg border border-slate-800 overflow-hidden">
    <div class="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
      <h2 id="detail-title" class="font-bold text-slate-200"><i class="fa-solid fa-file-lines text-amber-400"></i> الملف التفصيلي</h2>
      <span id="detail-ts" class="text-xs text-slate-500"></span>
    </div>
    <div id="detail-body" class="p-4 text-sm text-slate-300">
      <p class="text-slate-500">اختر زوجاً من الجدول لعرض التحليل الكامل</p>
    </div>
  </section>

  <!-- Calendar row -->
  <section class="col-span-12 bg-slate-900/60 rounded-lg border border-slate-800">
    <div class="flex items-center justify-between px-4 py-3 border-b border-slate-800">
      <h2 class="font-bold text-slate-200"><i class="fa-solid fa-calendar-days text-amber-400"></i> التقويم الاقتصادي (24 ساعة)</h2>
      <span class="text-xs text-slate-500">مصدر: FairEconomy (ForexFactory JSON) — UTC صحيح</span>
    </div>
    <div id="calendar-body" class="p-4 text-sm"></div>
  </section>
</main>

<footer class="text-center py-6 text-xs text-slate-600">
  <p>⚖️ Trading Court Pro — Decision Support System • <span class="text-slate-500">لا يستبدل الحكم البشري. لا يرسل أوامر تداول.</span></p>
</footer>

<script src="/static/app.js"></script>
</body>
</html>`);
});

export default app;
