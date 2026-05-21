// ============================================================================
// Arabic Argument Cards — v4.2 Phase 1
//
// Rule-based, deterministic. Converts the existing analysis into structured
// argument cards (in Arabic) for buy/sell/wait reasoning.
//
// What this is NOT:
//   - An LLM. No model call. Every output is a function of (analysis fields)
//     → (template string). Reproducible exactly given the same analysis.
//
// What this DOES:
//   - Walks the analysis, applies ~25 hand-curated rules, produces sorted
//     argument cards with strength ratings.
//   - Builds an explicit "invalidation scenario" — what would flip the call.
// ============================================================================

import type { PairAnalysis } from "../types/index.js";

export type ArgStrength = "STRONG" | "MEDIUM" | "WEAK";

export interface ArgumentCard {
  /** Bull/Bear/Neutral — does this support buying, selling, or holding? */
  side: "BULL" | "BEAR" | "NEUTRAL";
  strength: ArgStrength;
  titleAr: string;
  titleEn: string;
  detailAr: string;
  evidence: string;
}

export interface InvalidationScenario {
  verdict: string;
  triggersAr: string[];
  triggersEn: string[];
}

export interface ArgumentReport {
  buyCards: ArgumentCard[];
  sellCards: ArgumentCard[];
  invalidation: InvalidationScenario;
  /** "3 of 5 buy arguments, 1 of 5 sell arguments" */
  summary: string;
}

const strengthRank: Record<ArgStrength, number> = {
  STRONG: 3, MEDIUM: 2, WEAK: 1,
};

function dirAr(dir: string): string {
  if (dir === "LONG") return "صعود";
  if (dir === "SHORT") return "هبوط";
  return "محايد";
}

function regimeAr(label: string): string {
  switch (label) {
    case "TREND_UP":   return "ترند صاعد";
    case "TREND_DOWN": return "ترند هابط";
    case "RANGE":      return "تداول جانبي";
    case "VOLATILE":   return "تذبذب عالٍ";
    case "DEAD":       return "سوق هامد";
    case "MARKET_CLOSED": return "السوق مغلق";
    default:           return "غير محدّد";
  }
}

export function buildArgumentCards(a: PairAnalysis): ArgumentReport {
  const cards: ArgumentCard[] = [];

  // ── 1. MTF Alignment ────────────────────────────────────────────────────
  if ((a.mtf?.alignment ?? 0) > 50) {
    cards.push({
      side: "BULL", strength: "STRONG",
      titleAr: "محاذاة فريمات قوية للصعود",
      titleEn: "Strong multi-timeframe bull alignment",
      detailAr: `M15 ${dirAr(a.mtf.m15Dir)}، H1 ${dirAr(a.mtf.h1Dir)}، H4 ${dirAr(a.mtf.h4Dir)}، D1 ${dirAr(a.mtf.d1Dir)} — كلها في صفّ الشراء`,
      evidence: `MTF alignment +${a.mtf.alignment.toFixed(0)}`,
    });
  } else if ((a.mtf?.alignment ?? 0) < -50) {
    cards.push({
      side: "BEAR", strength: "STRONG",
      titleAr: "محاذاة فريمات قوية للهبوط",
      titleEn: "Strong multi-timeframe bear alignment",
      detailAr: `M15 ${dirAr(a.mtf.m15Dir)}، H1 ${dirAr(a.mtf.h1Dir)}، H4 ${dirAr(a.mtf.h4Dir)}، D1 ${dirAr(a.mtf.d1Dir)} — كلها في صفّ البيع`,
      evidence: `MTF alignment ${a.mtf.alignment.toFixed(0)}`,
    });
  } else if (Math.abs(a.mtf?.alignment ?? 0) > 25) {
    const side = a.mtf.alignment > 0 ? "BULL" : "BEAR";
    cards.push({
      side, strength: "MEDIUM",
      titleAr: side === "BULL" ? "ميل صعودي بين الفريمات" : "ميل هبوطي بين الفريمات",
      titleEn: side === "BULL" ? "Moderate bullish MTF lean" : "Moderate bearish MTF lean",
      detailAr: `معظم الفريمات تميل ${dirAr(a.mtf.alignment > 0 ? "LONG" : "SHORT")} لكن بدون اتفاق كامل`,
      evidence: `MTF ${a.mtf.alignment.toFixed(0)}`,
    });
  }

  // ── 2. Regime ───────────────────────────────────────────────────────────
  if (a.regime?.label === "TREND_UP" && a.regime.adx && a.regime.adx > 25) {
    cards.push({
      side: "BULL", strength: "STRONG",
      titleAr: "ترند H4 صاعد مؤكَّد",
      titleEn: "H4 trend up confirmed",
      detailAr: `ADX ${a.regime.adx.toFixed(1)} يؤكّد القوة الاتجاهية، EMA stack بترتيب صاعد`,
      evidence: `regime=TREND_UP, adx=${a.regime.adx.toFixed(1)}`,
    });
  } else if (a.regime?.label === "TREND_DOWN" && a.regime.adx && a.regime.adx > 25) {
    cards.push({
      side: "BEAR", strength: "STRONG",
      titleAr: "ترند H4 هابط مؤكَّد",
      titleEn: "H4 trend down confirmed",
      detailAr: `ADX ${a.regime.adx.toFixed(1)} يؤكّد القوة الاتجاهية، EMA stack بترتيب هابط`,
      evidence: `regime=TREND_DOWN, adx=${a.regime.adx.toFixed(1)}`,
    });
  } else if (a.regime?.label === "DEAD" || a.regime?.label === "UNKNOWN" || a.regime?.label === "MARKET_CLOSED") {
    cards.push({
      side: "NEUTRAL", strength: "STRONG",
      titleAr: `النظام السوقي: ${regimeAr(a.regime.label)}`,
      titleEn: `Market regime: ${a.regime.label}`,
      detailAr: "لا هيكلية اتجاهية واضحة — تجنّب الدخول الآن",
      evidence: `regime=${a.regime.label}`,
    });
  }

  // ── 3. Market Structure (BOS / CHoCH) ───────────────────────────────────
  const ms = (a as any).marketStructure;
  if (ms?.lastBosKind === "BOS_BULL" && ms.lastBosFresh) {
    cards.push({
      side: "BULL", strength: "STRONG",
      titleAr: "اختراق هيكلي حديث للأعلى (BOS)",
      titleEn: "Fresh bullish BOS",
      detailAr: "كسر سعري لقمة هامّة على H4 خلال آخر 3 شموع — institutional bias صاعد",
      evidence: ms.reasoning ?? "BOS_BULL fresh",
    });
  } else if (ms?.lastBosKind === "BOS_BEAR" && ms.lastBosFresh) {
    cards.push({
      side: "BEAR", strength: "STRONG",
      titleAr: "اختراق هيكلي حديث للأسفل (BOS)",
      titleEn: "Fresh bearish BOS",
      detailAr: "كسر سعري لقاع هامّ على H4 خلال آخر 3 شموع — institutional bias هابط",
      evidence: ms.reasoning ?? "BOS_BEAR fresh",
    });
  }
  if (ms?.lastChochKind === "CHOCH_BULL" && ms.lastChochFresh) {
    cards.push({
      side: "BULL", strength: "MEDIUM",
      titleAr: "تغيّر هيكل السوق للصعود (CHoCH)",
      titleEn: "Fresh bullish CHoCH",
      detailAr: "تغيّر اتجاه آخر impulse من هابط إلى صاعد — بداية احتمال انعكاس",
      evidence: "CHOCH_BULL fresh",
    });
  } else if (ms?.lastChochKind === "CHOCH_BEAR" && ms.lastChochFresh) {
    cards.push({
      side: "BEAR", strength: "MEDIUM",
      titleAr: "تغيّر هيكل السوق للهبوط (CHoCH)",
      titleEn: "Fresh bearish CHoCH",
      detailAr: "تغيّر اتجاه آخر impulse من صاعد إلى هابط — بداية احتمال انعكاس",
      evidence: "CHOCH_BEAR fresh",
    });
  }

  // ── 4. Premium / Discount ───────────────────────────────────────────────
  const dr = ms?.dealingRange;
  if (dr && Number.isFinite(dr.positionPctScaled)) {
    const pct = dr.positionPctScaled as number;
    if (pct >= 70) {
      cards.push({
        side: "BEAR", strength: "MEDIUM",
        titleAr: "السعر في منطقة Premium",
        titleEn: "Price in premium zone",
        detailAr: `السعر عند ${pct.toFixed(1)}% من dealing range — منطقة مفضّلة للبيع وفق ICT`,
        evidence: `dealingRange ${pct.toFixed(1)}%`,
      });
    } else if (pct <= 30) {
      cards.push({
        side: "BULL", strength: "MEDIUM",
        titleAr: "السعر في منطقة Discount",
        titleEn: "Price in discount zone",
        detailAr: `السعر عند ${pct.toFixed(1)}% من dealing range — منطقة مفضّلة للشراء وفق ICT`,
        evidence: `dealingRange ${pct.toFixed(1)}%`,
      });
    }
  }

  // ── 5. VWAP ─────────────────────────────────────────────────────────────
  const vw = (a as any).vwap;
  if (vw?.positionVsDaily === "ABOVE") {
    cards.push({
      side: "BULL", strength: "MEDIUM",
      titleAr: "السعر فوق VWAP اليومي",
      titleEn: "Price above daily VWAP",
      detailAr: `المؤسسات في صفّ الشراء على المتوسط المرجّح اليومي (+${vw.distancePct?.toFixed(3)}%)`,
      evidence: `vwap=${vw.daily?.vwap?.toFixed(5)}`,
    });
  } else if (vw?.positionVsDaily === "BELOW") {
    cards.push({
      side: "BEAR", strength: "MEDIUM",
      titleAr: "السعر تحت VWAP اليومي",
      titleEn: "Price below daily VWAP",
      detailAr: `المؤسسات في صفّ البيع على المتوسط المرجّح اليومي (${vw.distancePct?.toFixed(3)}%)`,
      evidence: `vwap=${vw.daily?.vwap?.toFixed(5)}`,
    });
  }

  // ── 6. M5 Trigger ───────────────────────────────────────────────────────
  const m5 = (a as any).m5Trigger;
  if (m5?.signal === "BULL_TRIGGER") {
    cards.push({
      side: "BULL", strength: "STRONG",
      titleAr: "تأكيد دخول M5 صاعد",
      titleEn: "M5 bull entry trigger confirmed",
      detailAr: `EMA9 تجاوز EMA21 + شمعة impulse صاعدة + volume مؤكَّد`,
      evidence: m5.reasoning,
    });
  } else if (m5?.signal === "BEAR_TRIGGER") {
    cards.push({
      side: "BEAR", strength: "STRONG",
      titleAr: "تأكيد دخول M5 هابط",
      titleEn: "M5 bear entry trigger confirmed",
      detailAr: `EMA9 كسر EMA21 + شمعة impulse هابطة + volume مؤكَّد`,
      evidence: m5.reasoning,
    });
  }

  // ── 7. Manipulation / Liquidity Sweep ───────────────────────────────────
  const manip = (a as any).manipulation;
  if (manip?.primary?.kind === "BULLISH_SWEEP" || manip?.primary?.kind === "JUDAS_BULL") {
    cards.push({
      side: "BULL", strength: "STRONG",
      titleAr: "صيد سيولة سفلي (Stop Hunt صاعد)",
      titleEn: "Bullish liquidity sweep",
      detailAr: "السعر شفط السيولة تحت قاع الجلسة ثم ارتدّ — إشارة انعكاس صاعد",
      evidence: manip.primary.note,
    });
  } else if (manip?.primary?.kind === "BEARISH_SWEEP" || manip?.primary?.kind === "JUDAS_BEAR") {
    cards.push({
      side: "BEAR", strength: "STRONG",
      titleAr: "صيد سيولة علوي (Stop Hunt هابط)",
      titleEn: "Bearish liquidity sweep",
      detailAr: "السعر شفط السيولة فوق قمّة الجلسة ثم انعكس — إشارة انعكاس هابط",
      evidence: manip.primary.note,
    });
  }

  // ── 8. RSI Divergence ───────────────────────────────────────────────────
  const divH1 = (a as any).divergenceH1;
  if ((divH1?.score ?? 0) > 30) {
    cards.push({
      side: "BULL", strength: "MEDIUM",
      titleAr: "Divergence صاعد على H1",
      titleEn: "H1 bullish divergence",
      detailAr: "السعر يصنع قاع أدنى بينما RSI يصنع قاع أعلى — احتمال انعكاس صاعد",
      evidence: `H1 div score ${divH1.score}`,
    });
  } else if ((divH1?.score ?? 0) < -30) {
    cards.push({
      side: "BEAR", strength: "MEDIUM",
      titleAr: "Divergence هابط على H1",
      titleEn: "H1 bearish divergence",
      detailAr: "السعر يصنع قمّة أعلى بينما RSI يصنع قمّة أدنى — احتمال انعكاس هابط",
      evidence: `H1 div score ${divH1.score}`,
    });
  }

  // ── 9. Fibonacci Golden Zone ────────────────────────────────────────────
  const fib = (a as any).fibonacci;
  if (fib?.inGoldenZone) {
    const side = fib.legType === "BULL_LEG" ? "BULL" : "BEAR";
    cards.push({
      side, strength: "MEDIUM",
      titleAr: side === "BULL" ? "السعر في Golden Zone (شراء)" : "السعر في Golden Zone (بيع)",
      titleEn: "Price inside Fibonacci Golden Zone",
      detailAr: `السعر بين 50% و 61.8% من آخر impulse ${side === "BULL" ? "صاعد" : "هابط"} — منطقة دخول كلاسيكية`,
      evidence: `pos=${(fib.positionRatio * 100).toFixed(1)}% (${fib.positionLevel})`,
    });
  }

  // ── 10. ORB Breakout ────────────────────────────────────────────────────
  const orb = (a as any).orb;
  if (orb?.london?.status === "BROKE_HIGH" || orb?.ny?.status === "BROKE_HIGH") {
    const which = orb.london.status === "BROKE_HIGH" ? "London" : "NY";
    cards.push({
      side: "BULL", strength: "STRONG",
      titleAr: `اختراق ${which} ORB للأعلى`,
      titleEn: `${which} ORB upside breakout`,
      detailAr: `السعر اخترق قمّة أوّل ساعة من ${which} — استراتيجية intraday كلاسيكية`,
      evidence: `${which} ORB broken at ${orb[which.toLowerCase()].breakoutTimeUtc?.slice(11, 16)}`,
    });
  } else if (orb?.london?.status === "BROKE_LOW" || orb?.ny?.status === "BROKE_LOW") {
    const which = orb.london.status === "BROKE_LOW" ? "London" : "NY";
    cards.push({
      side: "BEAR", strength: "STRONG",
      titleAr: `اختراق ${which} ORB للأسفل`,
      titleEn: `${which} ORB downside breakout`,
      detailAr: `السعر اخترق قاع أوّل ساعة من ${which} — استراتيجية intraday كلاسيكية`,
      evidence: `${which} ORB broken at ${orb[which.toLowerCase()].breakoutTimeUtc?.slice(11, 16)}`,
    });
  }
  // FAKE breakouts as caution
  if (orb?.london?.status === "FAKE_HIGH" || orb?.ny?.status === "FAKE_HIGH") {
    cards.push({
      side: "BEAR", strength: "MEDIUM",
      titleAr: "Fake اختراق علوي على ORB",
      titleEn: "Fake ORB upside breakout",
      detailAr: "اخترق ORB ثم ارتدّ تحته — احذر مصيدة شراء، الميل قد ينقلب هابطاً",
      evidence: "ORB FAKE_HIGH",
    });
  }
  if (orb?.london?.status === "FAKE_LOW" || orb?.ny?.status === "FAKE_LOW") {
    cards.push({
      side: "BULL", strength: "MEDIUM",
      titleAr: "Fake اختراق سفلي على ORB",
      titleEn: "Fake ORB downside breakout",
      detailAr: "اخترق ORB ثم ارتدّ فوقه — احذر مصيدة بيع، الميل قد ينقلب صاعداً",
      evidence: "ORB FAKE_LOW",
    });
  }

  // ── 11. News breaking ──────────────────────────────────────────────────
  const news = a.news as any;
  if (news?.breakingActive && Number.isFinite(news.breakingScore)) {
    const bs = news.breakingScore as number;
    if (bs > 25) {
      cards.push({
        side: "BULL", strength: "STRONG",
        titleAr: "أخبار breaking داعمة للزوج",
        titleEn: "Breaking news supports pair",
        detailAr: `breaking score ${bs > 0 ? "+" : ""}${bs} — ${(news.breakingCurrencies ?? []).join(", ")}`,
        evidence: news.reasoning ?? "breaking active",
      });
    } else if (bs < -25) {
      cards.push({
        side: "BEAR", strength: "STRONG",
        titleAr: "أخبار breaking ضدّ الزوج",
        titleEn: "Breaking news against pair",
        detailAr: `breaking score ${bs} — ${(news.breakingCurrencies ?? []).join(", ")}`,
        evidence: news.reasoning ?? "breaking active",
      });
    }
  }

  // ── 12. Pivot proximity ─────────────────────────────────────────────────
  const piv = (a as any).pivotPoints;
  if (piv?.nearestLevelName && Math.abs(piv.nearestLevelDistancePips ?? 999) < 5) {
    cards.push({
      side: "NEUTRAL", strength: "MEDIUM",
      titleAr: `السعر قرب مستوى ${piv.nearestLevelName}`,
      titleEn: `Price near ${piv.nearestLevelName} pivot`,
      detailAr: `السعر يبعد ${Math.abs(piv.nearestLevelDistancePips)}p عن ${piv.nearestLevelName} — منطقة حسم محتملة`,
      evidence: `nearest=${piv.nearestLevelName} @ ${piv.nearestLevelDistancePips}p`,
    });
  }

  // ── 13. Pre-news Volatility Warning (v4.2 Phase 2) ──────────────────────
  const pnw = (a as any).preNewsWarning;
  if (pnw?.level === "BLOCKER") {
    cards.push({
      side: "NEUTRAL", strength: "STRONG",
      titleAr: "⚠️ خبر HIGH وشيك — لا دخول",
      titleEn: "Imminent HIGH-impact news — no entry",
      detailAr: pnw.reasoningAr,
      evidence: `pre-news BLOCKER, ${pnw.minutesUntil}min`,
    });
  } else if (pnw?.level === "WARNING") {
    cards.push({
      side: "NEUTRAL", strength: "MEDIUM",
      titleAr: "⏰ خبر HIGH قريب — احذر",
      titleEn: "HIGH-impact news soon — caution",
      detailAr: pnw.reasoningAr,
      evidence: `pre-news WARNING, ${pnw.minutesUntil}min`,
    });
  }

  // ── 14. Hawkish/Dovish stance from CB speeches (v4.2 Phase 2) ──────────
  const sr = (a as any).speechReport;
  if (sr?.byCurrency) {
    const meta = (a as any).symbol;
    // base/quote already implicit — derive from symbol
    const base = a.symbol.slice(0, 3);
    const quote = a.symbol.slice(3);

    const bStance = sr.byCurrency[base];
    const qStance = sr.byCurrency[quote];

    if (bStance && Math.abs(bStance.stanceScore) >= 20) {
      const hawk = bStance.stanceScore > 0;
      cards.push({
        side: hawk ? "BULL" : "BEAR",
        strength: Math.abs(bStance.stanceScore) >= 35 ? "STRONG" : "MEDIUM",
        titleAr: `موقف ${base} ${hawk ? "متشدّد" : "تيسيري"} من خطابات البنك المركزي`,
        titleEn: `${base} stance is ${hawk ? "hawkish" : "dovish"} from CB speeches`,
        detailAr: `مجموع ${bStance.speechCount} خطاب${bStance.speechCount > 1 ? "ات" : ""} (آخر 24س) — score ${bStance.stanceScore > 0 ? "+" : ""}${bStance.stanceScore}`,
        evidence: bStance.topSpeech?.title.slice(0, 60) ?? "",
      });
    }
    if (qStance && Math.abs(qStance.stanceScore) >= 20) {
      const hawk = qStance.stanceScore > 0;
      // Quote currency hawkish = pair down (because quote is denominator)
      const side = hawk ? "BEAR" : "BULL";
      cards.push({
        side, strength: Math.abs(qStance.stanceScore) >= 35 ? "STRONG" : "MEDIUM",
        titleAr: `موقف ${quote} ${hawk ? "متشدّد" : "تيسيري"} — ضدّ الزوج`,
        titleEn: `${quote} stance is ${hawk ? "hawkish" : "dovish"} — affects pair direction`,
        detailAr: `مجموع ${qStance.speechCount} خطاب${qStance.speechCount > 1 ? "ات" : ""} (آخر 24س) — score ${qStance.stanceScore > 0 ? "+" : ""}${qStance.stanceScore}`,
        evidence: qStance.topSpeech?.title.slice(0, 60) ?? "",
      });
    }
  }

  // ── 15. Geopolitical risk (GPR — v4.2 Phase 2, attached at snapshot level) ─
  // The GPR field is attached at snapshot level, not per-pair. We read it
  // off (a as any).gpr if it's been forwarded; otherwise skip.
  const gpr = (a as any).gpr;
  if (gpr?.available && typeof gpr.score === "number" && gpr.score >= 50) {
    // Risk-off favours JPY, CHF, USD, XAU. Risk-on hurts AUD.
    const base = a.symbol.slice(0, 3);
    const quote = a.symbol.slice(3);
    const safeHavens = new Set(["JPY", "CHF", "USD", "XAU"]);
    const riskCcys = new Set(["AUD", "NZD", "GBP"]);

    let side: "BULL" | "BEAR" | "NEUTRAL" = "NEUTRAL";
    let why = "";
    if (safeHavens.has(base) && !safeHavens.has(quote)) {
      side = "BULL";
      why = `${base} ملاذ آمن، يستفيد من ارتفاع المخاطر الجيوسياسية`;
    } else if (safeHavens.has(quote) && !safeHavens.has(base)) {
      side = "BEAR";
      why = `${quote} ملاذ آمن، الزوج يضعف عند ارتفاع المخاطر`;
    } else if (riskCcys.has(base)) {
      side = "BEAR";
      why = `${base} عملة risk، تضعف في الـ risk-off`;
    }
    if (side !== "NEUTRAL") {
      cards.push({
        side, strength: gpr.score >= 75 ? "STRONG" : "MEDIUM",
        titleAr: `مؤشّر المخاطر الجيوسياسية مرتفع (${gpr.score}/100)`,
        titleEn: `Geopolitical risk elevated (${gpr.score}/100)`,
        detailAr: why,
        evidence: gpr.reasoning?.slice(0, 80) ?? "GPR elevated",
      });
    }
  }

  // ── Split + sort ────────────────────────────────────────────────────────
  const buyCards = cards
    .filter(c => c.side === "BULL")
    .sort((a, b) => strengthRank[b.strength] - strengthRank[a.strength])
    .slice(0, 5);
  const sellCards = cards
    .filter(c => c.side === "BEAR")
    .sort((a, b) => strengthRank[b.strength] - strengthRank[a.strength])
    .slice(0, 5);

  // ── Invalidation scenario ──────────────────────────────────────────────
  const plan = a.plan;
  const triggersAr: string[] = [];
  const triggersEn: string[] = [];

  if (a.verdict === "BUY" && plan?.stopLoss != null) {
    triggersAr.push(`السعر تحت ${plan.stopLoss.toFixed(5)} يُلغي السيناريو (وقف الخسارة)`);
    triggersEn.push(`Price below ${plan.stopLoss.toFixed(5)} invalidates (stop-loss)`);
    if (ms?.lastBosKind === "BOS_BULL") {
      triggersAr.push("CHoCH هابط على H4 يُلغي الـ BOS الصاعد");
      triggersEn.push("Bearish H4 CHoCH cancels the bullish BOS");
    }
    triggersAr.push("breaking news USD hawkish قوية تضرّ الميل الصاعد");
    triggersEn.push("Strong USD-hawkish breaking news hurts the bullish thesis");
  } else if (a.verdict === "SELL" && plan?.stopLoss != null) {
    triggersAr.push(`السعر فوق ${plan.stopLoss.toFixed(5)} يُلغي السيناريو (وقف الخسارة)`);
    triggersEn.push(`Price above ${plan.stopLoss.toFixed(5)} invalidates (stop-loss)`);
    if (ms?.lastBosKind === "BOS_BEAR") {
      triggersAr.push("CHoCH صاعد على H4 يُلغي الـ BOS الهابط");
      triggersEn.push("Bullish H4 CHoCH cancels the bearish BOS");
    }
    triggersAr.push("breaking news dovish قويّة تنعش الميل الصاعد");
    triggersEn.push("Strong dovish breaking news revives the bullish counter-trend");
  } else {
    triggersAr.push("لا توجد صفقة مفعّلة — لا scenario للإلغاء");
    triggersEn.push("No active trade — no invalidation scenario");
  }

  const summary =
    `${buyCards.length} حجج للشراء، ${sellCards.length} حجج للبيع. ` +
    `القرار: ${a.verdict}`;

  return {
    buyCards,
    sellCards,
    invalidation: { verdict: a.verdict, triggersAr, triggersEn },
    summary,
  };
}
