// ============================================================================
// Trading Court Pro v3.2 — Dashboard JavaScript
// NEW: Source health bar + Calendar actual impact analysis
// ============================================================================
(function () {
  "use strict";

  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);
  const fmt  = (v,d=2) => (typeof v==="number"&&isFinite(v))?v.toFixed(d):"—";
  const fmtS = (v,d=1) => { if(typeof v!=="number"||!isFinite(v))return"—"; return(v>=0?"+":"")+v.toFixed(d); };
  const sign = v => v>0?"pos":v<0?"neg":"neutral";
  const esc  = s => String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
  const decP = p => { const d=p?.display||""; return d.includes("JPY")?3:d.includes("XAU")?2:5; };

  let currentSymbol = null;
  let snapshotCache = null;
  let autoTimer     = null;
  let autoEnabled   = true;

  // ── Status ───────────────────────────────────────────────────────────────
  function setStatus(txt, state) {
    const dot = $("#status-dot");
    const msg = $("#status-txt");
    if (dot) dot.className = "status-dot " + (state==="ok"?"dot-ok":state==="err"?"dot-fail":"dot-loading");
    if (msg) msg.textContent = txt;
  }

  // ── Source Health Bar (NEW) ───────────────────────────────────────────────
  function renderSources(data) {
    const bar = $("#source-bar");
    if (!bar) return;
    const sources = data?.dataSourceHealth || {};
    if (!Object.keys(sources).length) { bar.innerHTML=""; return; }

    const items = Object.entries(sources).map(([name, s]) => {
      const ok    = s.ok;
      const ago   = s.lastSuccessAgo || "";
      const note  = esc(s.note || (ok ? "OK" : "Fehler"));
      const col   = ok ? "#22c55e" : "#ef4444";
      const glow  = ok ? "0 0 6px #22c55e88" : "none";
      const label = name.replace(/_/g," ");
      return `<span class="src-pill" title="${note} ${ago}" style="--c:${col};--glow:${glow}">
        <span class="src-dot-inner"></span>${esc(label)}
      </span>`;
    }).join("");

    const total   = Object.keys(sources).length;
    const healthy = Object.values(sources).filter(s => s.ok).length;
    const allOk   = healthy === total;

    bar.innerHTML = `
      <div class="src-bar-inner">
        <span style="font-size:10px;color:#64748b;font-weight:600;letter-spacing:.04em">مصادر البيانات</span>
        <span class="src-summary" style="color:${allOk?"#22c55e":"#f59e0b"}">
          ${healthy}/${total} متصل
        </span>
        <div class="src-pills">${items}</div>
      </div>`;
  }

  // ── Pairs table ───────────────────────────────────────────────────────────
  function renderTable(data) {
    const tbody = $("#pair-rows");
    if (!tbody) return;
    const pairs = data?.pairs || [];
    if (!pairs.length) {
      tbody.innerHTML=`<tr><td colspan="8" style="text-align:center;color:#64748b;padding:20px">لا بيانات — تحقق من المصادر</td></tr>`;
      return;
    }
    tbody.innerHTML = pairs.map(p => {
      const d  = decP(p);
      const q  = p.quote||{};
      const priceHtml = q.available
        ? `<div style="font-family:monospace"><span style="color:#e2e8f0">${fmt(q.mid,d)}</span><br>
           <span style="font-size:10px;color:#64748b">${fmt(q.bid,d)}/${fmt(q.ask,d)}${q.spread?` (${fmt(q.spread,1)}p)`:""}</span></div>`
        : `<span style="color:#334155">—</span>`;
      const regime = p.regime?.label||"—";
      const regCol = regime==="TREND_UP"?"#4ade80":regime==="TREND_DOWN"?"#f87171":regime==="RANGE"?"#fbbf24":"#64748b";
      const mtf    = p.mtf?.alignment??0;
      const conf   = p.scores?.confidence??0;
      const tier   = p.scores?.confidenceTier||"REJECT";
      const verdict= p.verdict||"WAIT";
      const vCol   = verdict==="BUY"?"#10b981":verdict==="SELL"?"#ef4444":"#64748b";
      const opp    = p.opportunityStatus||"NONE";
      const sel    = currentSymbol===p.symbol?" class=\"selected\"":"";
      return `<tr data-sym="${esc(p.symbol)}"${sel}>
        <td><strong style="color:#e2e8f0">${esc(p.display)}</strong></td>
        <td>${priceHtml}</td>
        <td><span style="color:${regCol};font-weight:600;font-size:11px">${esc(regime)}</span>
            <br><span style="font-size:10px;color:#64748b">ADX ${fmt(p.regime?.adx,1)}</span></td>
        <td><span class="${sign(mtf)}" style="font-weight:600">${fmtS(mtf,0)}</span></td>
        <td><span class="pill pill-${tier.toLowerCase()}">${esc(tier)}</span>
            <br><span style="font-size:10px;color:#64748b">${fmt(conf,0)}/100</span></td>
        <td style="font-size:11px;color:#94a3b8">${esc(p.session?.name||"—")}</td>
        <td><span class="pill pill-${opp.toLowerCase()}">${esc(opp)}</span></td>
        <td><span style="color:${vCol};font-weight:700;font-size:13px">${esc(verdict)}</span></td>
      </tr>`;
    }).join("");

    tbody.querySelectorAll("tr[data-sym]").forEach(tr => {
      tr.addEventListener("click", () => {
        currentSymbol = tr.dataset.sym;
        tbody.querySelectorAll("tr").forEach(r => r.classList.toggle("selected", r===tr));
        const p = pairs.find(x => x.symbol===currentSymbol);
        if (p) renderDetail(p);
      });
    });
  }

  // ── Detail pane ───────────────────────────────────────────────────────────
  function renderDetail(p) {
    const body = $("#detail-body");
    if (!body) return;
    const ts = $("#detail-ts");
    if (ts) ts.textContent = p.generatedUtc ? new Date(p.generatedUtc).toLocaleTimeString() : "";

    const d    = decP(p);
    const plan = p.plan||{};
    const risk = p.risk||{};
    const news = p.news||{};
    const ve   = p.verdictExplanation||{};
    const pa   = p.priceAction||{};
    const sl   = pa.sessionLevels||{};
    const vwap = p.vwap||{};
    const ms   = p.marketStructure||{};
    const m5t  = p.m5Trigger||{};
    const cal  = p.calendarFeedback||{};

    const vCol = p.verdict==="BUY"?"#10b981":p.verdict==="SELL"?"#ef4444":"#64748b";

    // Score bars
    const bars = [
      ["هيكل السوق", p.scores?.marketStructure],
      ["MTF",        p.scores?.mtf],
      ["زخم",        p.scores?.momentum],
      ["VWAP",       p.scores?.vwap],
      ["حركة السعر", p.scores?.priceAction],
      ["نظام",       p.scores?.regime],
      ["ارتباط",     p.scores?.correlation],
      ["أخبار",      p.scores?.news],
    ].filter(([,v])=>v!=null).map(([n,v])=>{
      const w=Math.min(100,Math.abs(v));
      const c=v>0?"#10b981":v<0?"#ef4444":"#475569";
      return `<div style="margin-bottom:5px">
        <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px">
          <span style="color:#94a3b8">${n}</span>
          <span class="${sign(v)}" style="font-family:monospace">${fmtS(v,1)}</span>
        </div>
        <div style="height:4px;background:#1f2937;border-radius:2px">
          <div style="width:${w}%;height:100%;background:${c};border-radius:2px;transition:width .3s"></div>
        </div>
      </div>`;
    }).join("");

    // Plan
    const planHtml = plan.entry!=null ? `
      <div class="kv"><span class="kv-key">الدخول</span><span class="kv-val">${fmt(plan.entry,d)}</span></div>
      <div class="kv"><span class="kv-key">وقف الخسارة</span><span class="kv-val neg">${fmt(plan.stopLoss,d)} (${fmt(plan.stopDistancePips,1)}p)</span></div>
      <div class="kv"><span class="kv-key">TP1 / RR1</span><span class="kv-val pos">${fmt(plan.tp1,d)} / ${fmt(plan.rr1,2)}</span></div>
      <div class="kv"><span class="kv-key">TP2 / RR2</span><span class="kv-val pos">${fmt(plan.tp2,d)} / ${fmt(plan.rr2,2)}</span></div>
      <div class="kv"><span class="kv-key">TP3</span><span class="kv-val pos">${fmt(plan.tp3,d)}</span></div>
      <div class="kv"><span class="kv-key">حجم اللوت (1%)</span><span class="kv-val">${fmt(plan.lotSizePer1Pct,3)} lot</span></div>
    ` : `<p style="color:#64748b;font-size:12px">${esc(plan.notes?.[0]||"لا خطة")}</p>`;

    // Calendar feedback signals in detail
    const calSignals = (cal.signals||[]).map(s => {
      const col = s.direction==="BULLISH"?"#4ade80":s.direction==="BEARISH"?"#f87171":"#94a3b8";
      return `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid #1e2d3d">
        <span style="color:${col};font-weight:700;font-size:11px;width:55px">${s.direction}</span>
        <span style="flex:1;font-size:11px;color:#94a3b8">${esc(s.eventTitle)}</span>
        <span style="font-size:10px;color:#64748b">${s.minutesAgo}m ago • decay ${Math.round(s.decayFactor*100)}%</span>
        <span style="color:${col};font-family:monospace;font-size:11px;font-weight:700">+${s.magnitude}pts</span>
      </div>`;
    }).join("");

    // News items
    const newsHtml = (news.items||[]).slice(0,5).map(n =>
      `<li><a href="${esc(n.url)}" target="_blank" style="color:#94a3b8;text-decoration:none">${esc(n.title)}</a>
       <span style="font-size:10px;color:#475569"> · ${esc(n.source)} · ${n.freshnessHours!=null?n.freshnessHours.toFixed(1)+"h":"?"}</span></li>`
    ).join("")||`<li style="color:#475569">لا أخبار</li>`;

    const bullHtml = (p.bullCase||[]).map(x=>`<li style="margin-bottom:3px">${esc(x)}</li>`).join("")||'<li style="color:#475569">—</li>';
    const bearHtml = (p.bearCase||[]).map(x=>`<li style="margin-bottom:3px">${esc(x)}</li>`).join("")||'<li style="color:#475569">—</li>';

    body.innerHTML = `<div class="detail">
      <!-- Verdict card -->
      <div style="background:#0f172a;border-radius:10px;padding:14px;margin-bottom:12px;border:1px solid ${vCol}40">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <span style="color:${vCol};font-size:20px;font-weight:800">${esc(p.verdict)}</span>
          <span style="font-size:11px;color:#64748b">Composite ${fmtS(p.scores?.composite,1)} · Conf ${fmt(p.scores?.confidence,0)} (${esc(p.scores?.confidenceTier||"—")})</span>
        </div>
        <p style="font-size:13px;color:#e2e8f0;line-height:1.5">${esc(ve.headline||p.summary?.split("\n")[0]||"")}</p>
      </div>

      <!-- Scores + Plan -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #1e2d3d">
          <div class="sub-hdr">توزيع النقاط</div>${bars}
        </div>
        <div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #1e2d3d">
          <div class="sub-hdr">خطة التداول</div>${planHtml}
        </div>
      </div>

      <!-- VWAP + Levels -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #1e2d3d">
          <div class="sub-hdr">VWAP</div>
          ${vwap.daily ? `
            <div class="kv"><span class="kv-key">Daily VWAP</span><span class="kv-val">${fmt(vwap.daily.vwap,d)}</span></div>
            <div class="kv"><span class="kv-key">الموقع</span><span class="kv-val ${vwap.positionVsDaily==="ABOVE"?"pos":vwap.positionVsDaily==="BELOW"?"neg":"neutral"}">${esc(vwap.positionVsDaily||"—")}</span></div>
            <div class="kv"><span class="kv-key">المسافة</span><span class="kv-val">${fmt(vwap.distancePct,4)}%</span></div>
            <div class="kv"><span class="kv-key">Score</span><span class="kv-val ${sign(vwap.score)}">${fmtS(vwap.score,1)}</span></div>
          ` : `<p style="color:#64748b;font-size:12px">لا بيانات</p>`}
        </div>
        <div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #1e2d3d">
          <div class="sub-hdr">المستويات</div>
          <div class="kv"><span class="kv-key">PDH/PDL</span><span class="kv-val">${fmt(sl.pdh,d)}/${fmt(sl.pdl,d)}</span></div>
          <div class="kv"><span class="kv-key">Asia H/L</span><span class="kv-val">${fmt(sl.asiaHigh,d)}/${fmt(sl.asiaLow,d)}</span></div>
          <div class="kv"><span class="kv-key">Weekly Open</span><span class="kv-val">${fmt(sl.weeklyOpen,d)}</span></div>
          <div class="kv"><span class="kv-key">London Open</span><span class="kv-val">${fmt(sl.londonOpen,d)}</span></div>
        </div>
      </div>

      <!-- Calendar Impact Analysis (NEW) -->
      ${calSignals ? `
      <div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #f59e0b40;margin-bottom:12px">
        <div class="sub-hdr" style="color:#f59e0b">📅 تأثير بيانات الكاليندر على هذا الزوج</div>
        <p style="font-size:11px;color:#64748b;margin-bottom:6px">
          مكافأة الكاليندر: Base ${esc(p.display?.split("/")[0]||"")} 
          <span class="${sign(cal.currencyBonus?.[p.symbol?.slice(0,3)]||0)}">${fmtS(cal.currencyBonus?.[p.symbol?.slice(0,3)]||0)}</span>
        </p>
        ${calSignals}
      </div>` : ""}

      <!-- Bull/Bear cases -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #1e2d3d">
          <div class="sub-hdr" style="color:#4ade80">▲ الحجج الصاعدة</div>
          <ul style="list-style:none;font-size:11.5px;line-height:1.7;color:#94a3b8">${bullHtml}</ul>
        </div>
        <div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #1e2d3d">
          <div class="sub-hdr" style="color:#f87171">▼ الحجج الهابطة</div>
          <ul style="list-style:none;font-size:11.5px;line-height:1.7;color:#94a3b8">${bearHtml}</ul>
        </div>
      </div>

      ${p.verdict==="WAIT"&&(ve.missing?.length||ve.nextSteps?.length)?`
      <div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #f59e0b40;margin-bottom:12px">
        <div class="sub-hdr">الشروط الناقصة / الخطوة التالية</div>
        ${(ve.missing||[]).map(x=>`<p style="font-size:12px;color:#94a3b8;margin:2px 0">• ${esc(x)}</p>`).join("")}
        ${(ve.nextSteps||[]).map(x=>`<p style="font-size:12px;color:#64748b;margin:2px 0">→ ${esc(x)}</p>`).join("")}
      </div>`:""}

      <!-- News -->
      <div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #1e2d3d;margin-bottom:12px">
        <div class="sub-hdr">أخبار الزوج (${news.items?.length||0})</div>
        <p style="font-size:11px;color:#64748b;margin-bottom:4px">
          مشاعر: <span class="${sign(news.pairScore)}">${fmtS(news.pairScore)}</span>
        </p>
        <ul style="list-style:none;font-size:12px;line-height:1.8">${newsHtml}</ul>
      </div>

      ${risk.reasons?.length?`
      <div style="background:#0f172a;border-radius:8px;padding:10px;border:1px solid #ef444440">
        <div class="sub-hdr" style="color:#ef4444">بوابة المخاطر</div>
        ${risk.reasons.map(r=>`<p style="font-size:12px;color:#94a3b8;margin:2px 0">• ${esc(r)}</p>`).join("")}
      </div>`:""}
    </div>`;
  }

  // ── Calendar with Impact Analysis (UPGRADED) ──────────────────────────────
  function renderCalendar(data) {
    const body = $("#calendar-body");
    const src  = $("#cal-source");
    if (!body) return;

    const all = (data?.calendarEvents||[])
      .filter(e => e.minutesFromNow >= -240 && e.minutesFromNow <= 24*60)
      .slice(0, 50);

    if (src) src.textContent = `ForexFactory + Investing.com • ${all.length} أحداث`;

    if (!all.length) {
      body.innerHTML=`<p style="padding:16px;color:#64748b;text-align:center">لا أحداث خلال 24 ساعة</p>`;
      return;
    }

    const past     = all.filter(e => e.minutesFromNow < -1);
    const live     = all.filter(e => e.minutesFromNow >= -1 && e.minutesFromNow <= 2);
    const upcoming = all.filter(e => e.minutesFromNow > 2);

    const highToday   = all.filter(e => e.impact==="HIGH").length;
    const betterCount = past.filter(e => e.surpriseDir==="BETTER").length;
    const worseCount  = past.filter(e => e.surpriseDir==="WORSE").length;
    const pending     = past.filter(e => !e.actual && (e.impact==="HIGH"||e.impact==="MEDIUM") && e.minutesFromNow > -120).length;

    const summaryBar = `<div class="cal-summary">
      <div class="cal-stat high"><strong>${highToday}</strong> HIGH اليوم</div>
      <div class="cal-stat better"><strong>${betterCount}</strong> أفضل ↑</div>
      <div class="cal-stat worse"><strong>${worseCount}</strong> أسوأ ↓</div>
      ${pending?`<div class="cal-stat" style="color:#f59e0b"><strong>${pending}</strong> ينتظر الفعلي ⟳</div>`:""}
      <div style="margin-right:auto">
        <button onclick="window.forceCalRefresh()" class="cal-refresh-btn">⟳ تحديث</button>
      </div>
    </div>`;

    const header = `<div class="cal-row" style="font-size:10px;text-transform:uppercase;color:#475569;border-bottom:1px solid #1e2d3d;opacity:.7">
      <span>الوقت</span><span></span><span>عملة</span><span>الحدث</span>
      <span style="text-align:right">السابق</span>
      <span style="text-align:right">التوقع</span>
      <span style="text-align:right">الفعلي / تأثير</span>
    </div>`;

    function row(e) {
      const mins    = Math.round(e.minutesFromNow);
      const isLive  = mins>=-1 && mins<=2;
      const isPast  = mins<-1;
      const timeStr = new Date(e.dateUtc).toISOString().slice(11,16);

      let minsTxt="", minsCls="cal-mins-past";
      if (isLive)           { minsTxt="LIVE";               minsCls="cal-mins-now"; }
      else if(mins>0&&mins<60){ minsTxt=mins+"m";           minsCls=mins<30?"cal-mins-now":"cal-mins-soon"; }
      else if(mins>=60)     { minsTxt=Math.round(mins/60)+"h"; minsCls="cal-mins-soon"; }
      else                  { minsTxt=(-mins)+"m ago";      minsCls="cal-mins-past"; }

      // ── Actual + Impact Analysis (CORE NEW FEATURE) ──────────────────────
      let actualHtml = `<span class="cal-actual-none">—</span>`;

      if (e.actual) {
        const dir   = e.surpriseDir;
        const cls   = dir==="BETTER"?"cal-actual-better":dir==="WORSE"?"cal-actual-worse":dir==="INLINE"?"cal-actual-inline":"cal-actual-none";
        const arrow = dir==="BETTER"?" ↑":dir==="WORSE"?" ↓":"";

        // Delta badge
        let deltaBadge = "";
        if (e.deltaAbs!=null && Math.abs(e.deltaAbs)>=0.0001) {
          const bCls = dir==="BETTER"?"cal-delta-better":dir==="WORSE"?"cal-delta-worse":"cal-delta-inline";
          const s    = e.deltaAbs>0?"+":"";
          const val  = Math.abs(e.deltaAbs)<1 ? s+e.deltaAbs.toFixed(2) : s+e.deltaAbs.toFixed(1);
          deltaBadge = `<span class="cal-delta ${bCls}">${val}</span>`;
        } else if (dir==="INLINE") {
          deltaBadge = `<span class="cal-delta cal-delta-inline">= متوقع</span>`;
        }

        // ── Impact Analysis Badge (NEW) ───────────────────────────────────
        // تحليل التأثير: هل هذه البيانات مؤثرة على التداول؟
        let impactAnalysis = "";
        if (e.impact==="HIGH" || e.impact==="MEDIUM") {
          const analysis = analyzeEventImpact(e);
          impactAnalysis = `<div class="impact-analysis" style="border-top:1px solid #1e2d3d;margin-top:3px;padding-top:3px">
            <span class="impact-badge" style="background:${analysis.bgCol};color:${analysis.txtCol};border:1px solid ${analysis.bdCol}">
              ${analysis.icon} ${analysis.label}
            </span>
            <span class="impact-desc">${analysis.desc}</span>
          </div>`;
        }

        actualHtml = `<div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px">
          <span class="${cls}" style="font-family:monospace;font-weight:700">${esc(e.actual)}${arrow}</span>
          ${deltaBadge}
          ${impactAnalysis}
        </div>`;

      } else if (isPast && (e.impact==="HIGH"||e.impact==="MEDIUM") && mins>-120) {
        // Still waiting for actual — with auto-refresh indicator
        actualHtml = `<div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px">
          <span style="color:#f59e0b;font-size:11px;font-weight:600">جاري النشر ⟳</span>
          <span style="font-size:9px;color:#64748b">تحديث تلقائي</span>
        </div>`;
      } else if (!isPast) {
        actualHtml = `<span style="color:#334155">—</span>`;
      }

      const ctx  = calCtx(e.title);
      const rowC = isLive?"cal-row cal-live":isPast?"cal-row cal-past":"cal-row";

      return `<div class="${rowC}">
        <span class="${minsCls}" style="display:flex;flex-direction:column;gap:1px">
          <span style="font-weight:600;font-size:12px">${timeStr}</span>
          <span style="font-size:10px">${minsTxt}</span>
        </span>
        <span style="display:flex;align-items:center">
          <span class="cal-dot cal-dot-${e.impact}" title="${e.impact}"></span>
        </span>
        <span style="font-weight:700;color:#e2e8f0;font-size:12px">${esc(e.country)}</span>
        <div>
          <span style="color:#e2e8f0;font-size:12px">${esc(e.title)}</span>
          ${ctx?`<span class="cal-ctx">${ctx}</span>`:""}
        </div>
        <span style="font-family:monospace;color:#64748b;text-align:right;font-size:12px">${esc(e.previous||"—")}</span>
        <span style="font-family:monospace;color:#94a3b8;text-align:right;font-size:12px">${esc(e.forecast||"—")}</span>
        <span style="text-align:right">${actualHtml}</span>
      </div>`;
    }

    let html = summaryBar + header;
    if (past.length||live.length) {
      html += `<div class="cal-section-hdr">أحداث منتهية</div>`;
      html += [...live, ...past.slice().reverse()].map(row).join("");
    }
    if (upcoming.length) {
      html += `<div class="cal-section-hdr cal-section-upcoming">▼ أحداث قادمة</div>`;
      html += upcoming.map(row).join("");
    }
    body.innerHTML = html;

    // Auto-refresh if pending actuals
    if (pending>0 && !window._calTimer) {
      window._calTimer = setInterval(() => {
        loadSnapshot(true).then(()=>{
          const still = (snapshotCache?.calendarEvents||[])
            .filter(e=>!e.actual&&e.minutesFromNow<-1&&e.minutesFromNow>-120&&(e.impact==="HIGH"||e.impact==="MEDIUM")).length;
          if (!still) { clearInterval(window._calTimer); window._calTimer=null; }
        });
      }, 30000);
    }
  }

  // ── Impact Analysis Engine (NEW) ──────────────────────────────────────────
  // تحليل: هل هذا الحدث مؤثر على التحليل الحالي؟
  function analyzeEventImpact(e) {
    const dir    = e.surpriseDir;
    const impact = e.impact;
    const delta  = e.deltaAbs;
    const mins   = Math.abs(e.minutesFromNow);

    // No surprise = no market impact
    if (!dir || dir==="INLINE") {
      return { label:"محايد", icon:"⊘", desc:"لا تغيير — كما متوقع",
               bgCol:"rgba(100,116,139,.12)", txtCol:"#64748b", bdCol:"rgba(100,116,139,.25)" };
    }

    // Calculate magnitude
    const isBig = delta!=null && Math.abs(delta)>0;
    const isRecent = mins < 30;
    const isHigh = impact==="HIGH";

    if (dir==="BETTER") {
      if (isHigh && isRecent) {
        return { label:"مؤثر جداً ↑", icon:"🟢", desc:"بيانات قوية — تقوية العملة المحلية حالياً",
                 bgCol:"rgba(16,185,129,.15)", txtCol:"#4ade80", bdCol:"rgba(16,185,129,.35)" };
      } else if (isHigh) {
        return { label:"مؤثر ↑", icon:"🟢", desc:"أفضل من التوقع — تأثير متلاش تدريجياً",
                 bgCol:"rgba(16,185,129,.1)", txtCol:"#4ade80", bdCol:"rgba(16,185,129,.25)" };
      } else {
        return { label:"خفيف ↑", icon:"🟡", desc:"أفضل لكن تأثير محدود",
                 bgCol:"rgba(245,158,11,.08)", txtCol:"#fbbf24", bdCol:"rgba(245,158,11,.2)" };
      }
    } else {
      if (isHigh && isRecent) {
        return { label:"مؤثر جداً ↓", icon:"🔴", desc:"بيانات ضعيفة — ضغط على العملة المحلية حالياً",
                 bgCol:"rgba(239,68,68,.15)", txtCol:"#f87171", bdCol:"rgba(239,68,68,.35)" };
      } else if (isHigh) {
        return { label:"مؤثر ↓", icon:"🔴", desc:"أسوأ من التوقع — تأثير متلاش تدريجياً",
                 bgCol:"rgba(239,68,68,.1)", txtCol:"#f87171", bdCol:"rgba(239,68,68,.25)" };
      } else {
        return { label:"خفيف ↓", icon:"🟡", desc:"أسوأ لكن تأثير محدود",
                 bgCol:"rgba(245,158,11,.08)", txtCol:"#fbbf24", bdCol:"rgba(245,158,11,.2)" };
      }
    }
  }

  function calCtx(title) {
    const t=(title||"").toLowerCase();
    if(/pmi/.test(t))                         return "PMI > 50 = توسع اقتصادي";
    if(/federal funds|interest rate/.test(t)) return "قرار الفائدة — يؤثر مباشرة على USD";
    if(/non.farm|nfp/.test(t))               return "NFP — أهم بيان توظيف أمريكي";
    if(/fomc statement/.test(t))             return "بيان مجلس الاحتياطي الفيدرالي";
    if(/\bcpi\b/.test(t))                    return "التضخم — الأدنى أفضل للاقتصاد";
    if(/gdp/.test(t))                        return "الناتج المحلي — الأعلى = نمو";
    if(/retail sales/.test(t))               return "مؤشر الإنفاق الاستهلاكي";
    if(/unemploy|jobless/.test(t))           return "البطالة — الأدنى أفضل";
    if(/import prices/.test(t))              return "أسعار الاستيراد — مؤشر تضخمي";
    if(/consumer spending/.test(t))          return "الإنفاق الاستهلاكي";
    if(/housing starts/.test(t))             return "بدايات البناء — مؤشر نمو";
    if(/payroll/.test(t))                    return "كشوف الرواتب — مؤشر توظيف";
    if(/consumer confidence/.test(t))        return "ثقة المستهلك — مؤشر مزاج";
    if(/barometer/.test(t))                  return "مؤشر الأعمال الاقتصادية";
    return "";
  }

  window.forceCalRefresh = () => loadSnapshot(true);

  // ── Snapshot loader ───────────────────────────────────────────────────────
  async function loadSnapshot(force=false) {
    setStatus("جاري التحميل...", "loading");
    const btn = $("#btn-refresh");
    if (btn) { btn.disabled=true; btn.innerHTML="⟳ تحميل..."; }

    try {
      const r = await fetch(force?"/api/snapshot?force=1":"/api/snapshot", {cache:"no-store"});
      if (!r.ok) throw new Error("HTTP "+r.status);
      const data = await r.json();
      snapshotCache = data;
      renderSources(data);
      renderTable(data);
      renderCalendar(data);
      const ts = $("#snap-ts");
      if (ts&&data.generatedUtc) ts.textContent = new Date(data.generatedUtc).toLocaleTimeString();
      const lu = $("#last-update");
      if (lu) lu.textContent = "آخر تحديث: "+new Date().toLocaleTimeString();
      if (currentSymbol) {
        const p = (data.pairs||[]).find(x=>x.symbol===currentSymbol);
        if (p) renderDetail(p);
      }
      setStatus("متصل ✓", "ok");
    } catch(e) {
      setStatus("خطأ: "+e.message, "err");
      console.error(e);
    } finally {
      if (btn) { btn.disabled=false; btn.innerHTML='<i class="fa-solid fa-rotate-right"></i> تحديث'; }
    }
  }

  function toggleAuto() {
    const cb = $("#auto-check");
    autoEnabled = cb?cb.checked:true;
    if (autoEnabled&&!autoTimer) autoTimer=setInterval(()=>loadSnapshot(false),30000);
    else if(!autoEnabled&&autoTimer) { clearInterval(autoTimer); autoTimer=null; }
  }
  window.toggleAuto = toggleAuto;
  window.refresh    = ()=>loadSnapshot(true);

  function init() {
    const btn = $("#btn-refresh");
    if (btn) btn.addEventListener("click", ()=>loadSnapshot(true));
    const cb = $("#auto-check");
    if (cb) cb.addEventListener("change", toggleAuto);
    autoTimer = setInterval(()=>{ if(autoEnabled) loadSnapshot(false); }, 30000);
    loadSnapshot(true);
  }

  if (document.readyState==="loading") document.addEventListener("DOMContentLoaded", init);
  else init();
  window.init = init;
})();
