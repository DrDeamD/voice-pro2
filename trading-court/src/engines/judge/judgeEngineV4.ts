// ============================================================================
// Trading Court — Judge Engine v4.1
//
// Δ from v4:
//   - H4Trend now accepts "UNKNOWN" (regime DEAD/VOLATILE/UNKNOWN/missing).
//     v4 forced "RANGE" in those cases, which silently turned regime-conflict
//     checks off. UNKNOWN now produces an explicit `unknown_h4_trend` risk
//     item worth 12 points so the user sees that structure isn't readable.
//   - premiumPct = null no longer collapses to 0/100 anywhere in this file.
//     Every premium check now requires premiumPct to be a finite number
//     before evaluating.
//
// Soft Risk Scoring instead of hard veto on every single risk.
// Goal: reduce all-day-WAIT without opening the door to traps.
// ============================================================================

export type Verdict = "BUY" | "SELL" | "WAIT";
export type H4Trend = "UP" | "DOWN" | "RANGE" | "UNKNOWN";
export type IntradayBias = "BULL" | "BEAR" | "NEUTRAL";
export type NewsImpact = "HIGH" | "MEDIUM" | "LOW" | "NONE";
export type StructureSignal = "BULL" | "BEAR" | "NONE";

export interface JudgeMessage {
  en: string;
  ar: string;
}

export interface JudgeRiskItem {
  code: string;
  points: number;
  messages: JudgeMessage[];
}

export interface JudgeEngineV4Input {
  verdict: Verdict;
  confidence: number;
  h4Trend: H4Trend;
  premiumPct: number | null;
  intradayBias: IntradayBias;
  newsImpact: NewsImpact;
  sweptHigh?: boolean;
  sweptLow?: boolean;
  bos?: StructureSignal;
  choch?: StructureSignal;
  newsAlignedWithTrade?: boolean;
  entryConfirmation?: boolean;
  // v4.6 Phase A — Fibonacci + Pivot integration
  /** Price in Fib Golden Zone (50-61.8% retracement) AND aligned with H4 trend */
  fibGoldenZoneAligned?: boolean;
  /** Price beyond 1.272 Fibonacci extension in trade direction (overstretched) */
  fibExtendedSameDirection?: boolean;
  /** Daily classic pivot P stands against trade direction */
  dailyPivotAgainst?: boolean;
}

export interface JudgeEngineV4Output {
  active: boolean;
  from: Verdict;
  to: Verdict;
  mode: "NO_OVERRIDE" | "CONFIDENCE_ADJUST" | "WAIT_FOR_CONFIRMATION" | "HARD_WAIT";
  riskScore: number;
  confidenceAdjustment: number;
  adjustedConfidence: number;
  riskItems: JudgeRiskItem[];
  messages: JudgeMessage[];
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function addRisk(
  items: JudgeRiskItem[],
  code: string,
  points: number,
  en: string,
  ar: string,
) {
  items.push({ code, points, messages: [{ en, ar }] });
}

function hasHtfConflict(input: JudgeEngineV4Input): boolean {
  return (
    (input.verdict === "BUY" && input.h4Trend === "DOWN" && input.intradayBias === "BULL") ||
    (input.verdict === "SELL" && input.h4Trend === "UP" && input.intradayBias === "BEAR")
  );
}

function isPremiumTrap(input: JudgeEngineV4Input): boolean {
  return (
    input.verdict === "BUY" &&
    input.h4Trend === "DOWN" &&
    Number.isFinite(input.premiumPct) &&
    (input.premiumPct as number) >= 70
  );
}

function isDiscountTrap(input: JudgeEngineV4Input): boolean {
  return (
    input.verdict === "SELL" &&
    input.h4Trend === "UP" &&
    Number.isFinite(input.premiumPct) &&
    (input.premiumPct as number) <= 30
  );
}

function hasLiquiditySweepAgainstTrade(input: JudgeEngineV4Input): boolean {
  return (
    (input.verdict === "BUY" && input.sweptHigh === true && input.h4Trend === "DOWN") ||
    (input.verdict === "SELL" && input.sweptLow === true && input.h4Trend === "UP")
  );
}

function hasOppositeChoch(input: JudgeEngineV4Input): boolean {
  return (
    (input.verdict === "BUY" && input.choch === "BEAR") ||
    (input.verdict === "SELL" && input.choch === "BULL")
  );
}

function hasBosInWrongLocation(input: JudgeEngineV4Input): boolean {
  // Both branches require a finite premiumPct. Without it, we cannot make
  // this judgement at all.
  if (!Number.isFinite(input.premiumPct)) return false;
  const pct = input.premiumPct as number;
  return (
    (input.verdict === "BUY" &&
      input.bos === "BULL" &&
      input.h4Trend === "DOWN" &&
      pct >= 70) ||
    (input.verdict === "SELL" &&
      input.bos === "BEAR" &&
      input.h4Trend === "UP" &&
      pct <= 30)
  );
}

export function judgeEngineV4(input: JudgeEngineV4Input): JudgeEngineV4Output {
  const riskItems: JudgeRiskItem[] = [];

  if (input.verdict === "WAIT") {
    return {
      active: false,
      from: "WAIT",
      to: "WAIT",
      mode: "NO_OVERRIDE",
      riskScore: 0,
      confidenceAdjustment: 0,
      adjustedConfidence: input.confidence,
      riskItems: [],
      messages: [
        {
          en: "The judge does not convert WAIT into a trade.",
          ar: "القاضي لا يحوّل قرار الانتظار إلى صفقة.",
        },
      ],
    };
  }

  // Honest unknown — explicit, not silently mapped to RANGE.
  if (input.h4Trend === "UNKNOWN") {
    addRisk(
      riskItems,
      "unknown_h4_trend",
      12,
      "Higher-timeframe trend cannot be classified (regime is DEAD/VOLATILE/UNKNOWN).",
      "اتجاه الفريم الأعلى غير قابل للتصنيف (السوق ميّت/مضطرب/مجهول).",
    );
  }

  if (hasHtfConflict(input)) {
    addRisk(
      riskItems,
      "htf_intraday_conflict",
      30,
      "Intraday direction conflicts with the higher-timeframe structure.",
      "اتجاه الحركة داخل اليوم يتعارض مع بنية الفريم الأعلى.",
    );
  }

  if (isPremiumTrap(input)) {
    addRisk(
      riskItems,
      "buy_in_bearish_premium",
      25,
      "Buying in a bearish H4 premium zone increases liquidity-trap risk.",
      "الشراء داخل منطقة Premium في ترند H4 هابط يرفع خطر فخ السيولة.",
    );
  }

  if (isDiscountTrap(input)) {
    addRisk(
      riskItems,
      "sell_in_bullish_discount",
      25,
      "Selling in a bullish H4 discount zone increases liquidity-trap risk.",
      "البيع داخل منطقة Discount في ترند H4 صاعد يرفع خطر فخ السيولة.",
    );
  }

  if (input.newsImpact === "HIGH") {
    if (input.newsAlignedWithTrade) {
      addRisk(
        riskItems,
        "high_impact_news_aligned",
        12,
        "High-impact news is present, but it appears aligned with the trade direction.",
        "يوجد خبر عالي التأثير، لكنه يبدو متوافقاً مع اتجاه الصفقة.",
      );
    } else {
      addRisk(
        riskItems,
        "high_impact_news_risk",
        25,
        "High-impact news increases execution and whipsaw risk.",
        "الخبر عالي التأثير يرفع خطر سوء التنفيذ والحركات الوهمية.",
      );
    }
  } else if (input.newsImpact === "MEDIUM") {
    addRisk(
      riskItems,
      "medium_impact_news_risk",
      10,
      "Medium-impact news adds moderate risk.",
      "الخبر متوسط التأثير يضيف خطراً متوسطاً.",
    );
  }

  if (hasLiquiditySweepAgainstTrade(input)) {
    addRisk(
      riskItems,
      "liquidity_sweep_against_trade",
      25,
      "Liquidity was swept in the direction of the entry, which can mark a trap.",
      "تم سحب السيولة في اتجاه الدخول، وهذا قد يشير إلى فخ.",
    );
  }

  if (hasOppositeChoch(input)) {
    addRisk(
      riskItems,
      "opposite_choch",
      20,
      "CHOCH is pointing against the proposed trade direction.",
      "تغير هيكل السوق يشير عكس اتجاه الصفقة المقترحة.",
    );
  }

  if (hasBosInWrongLocation(input)) {
    addRisk(
      riskItems,
      "bos_in_wrong_location",
      15,
      "BOS appears in the wrong higher-timeframe location, so it may be a trap continuation.",
      "ظهر BOS في مكان خاطئ على الفريم الأعلى، لذلك قد يكون استمراراً فخياً.",
    );
  }

  // v4.6 Phase A — Fibonacci Golden Zone aligned with H4 trend → discount entry
  // Negative points (bonus). E.g. BUY in 50-61.8% retracement during H4 uptrend
  // is the classic ICT/discount entry, so we REDUCE risk by 10.
  if (input.fibGoldenZoneAligned === true) {
    addRisk(
      riskItems,
      "fib_golden_zone_aligned",
      -10,
      "Price in Fibonacci Golden Zone aligned with trend — discount entry.",
      "السعر في منطقة Golden Zone وفق فيبوناتشي ومتوافق مع الترند — دخول بخصم.",
    );
  }

  // v4.6 Phase A — Price beyond 1.272 Fibonacci extension in trade direction.
  // Late in the move; mean-reversion risk increases. +15 risk.
  if (input.fibExtendedSameDirection === true) {
    addRisk(
      riskItems,
      "fib_overstretched_extension",
      15,
      "Price beyond 1.272 Fibonacci extension in trade direction — mean-reversion risk.",
      "السعر تجاوز امتداد 1.272 من فيبوناتشي في اتجاه الصفقة — خطر ارتداد عكسي.",
    );
  }

  // v4.6 Phase A — Daily classic pivot stands AGAINST the trade direction.
  // E.g. BUY but price below P → pivot acts as overhead resistance. +12 risk.
  if (input.dailyPivotAgainst === true) {
    addRisk(
      riskItems,
      "daily_pivot_pressure_against_trade",
      12,
      "Daily pivot stands against trade direction — added resistance/support pressure.",
      "النقطة المحورية اليومية ضدّ اتجاه الصفقة — مقاومة/دعم إضافي.",
    );
  }

  let riskScore = riskItems.reduce((s, x) => s + x.points, 0);

  if (input.entryConfirmation && riskScore > 0) {
    riskScore = Math.max(0, riskScore - 15);
    addRisk(
      riskItems,
      "entry_confirmation_risk_reduction",
      -15,
      "Entry confirmation reduces timing risk, but it does not remove the higher-timeframe context.",
      "تأكيد الدخول يقلل خطر التوقيت، لكنه لا يلغي سياق الفريم الأعلى.",
    );
  }

  riskScore = clamp(riskScore, 0, 100);

  let to: Verdict = input.verdict;
  let mode: JudgeEngineV4Output["mode"] = "NO_OVERRIDE";
  let confidenceAdjustment = 0;

  if (riskScore < 40) {
    mode = riskScore > 0 ? "CONFIDENCE_ADJUST" : "NO_OVERRIDE";
    confidenceAdjustment = riskScore > 0 ? -Math.round(riskScore * 0.15) : 0;
  } else if (riskScore < 70) {
    mode = "WAIT_FOR_CONFIRMATION";
    confidenceAdjustment = -Math.round(riskScore * 0.25);
    to = input.entryConfirmation ? input.verdict : "WAIT";
  } else {
    mode = "HARD_WAIT";
    confidenceAdjustment = -Math.round(riskScore * 0.35);
    to = "WAIT";
  }

  const adjustedConfidence = clamp(input.confidence + confidenceAdjustment, 0, 100);

  const messages: JudgeMessage[] = [];

  if (riskScore === 0) {
    messages.push({
      en: "The judge found no structural reason to change the verdict.",
      ar: "القاضي لم يجد سبباً بنيوياً لتغيير القرار.",
    });
  } else if (mode === "CONFIDENCE_ADJUST") {
    messages.push({
      en: "The judge keeps the verdict but reduces confidence because risk is present but not dominant.",
      ar: "القاضي يُبقي القرار لكنه يخفض الثقة لأن الخطر موجود لكنه ليس مسيطراً.",
    });
  } else if (mode === "WAIT_FOR_CONFIRMATION") {
    messages.push({
      en: "The judge requires entry confirmation because risk is moderate and the setup may still be valid.",
      ar: "القاضي يطلب تأكيد دخول لأن الخطر متوسط وقد تبقى الصفقة صالحة.",
    });
  } else {
    messages.push({
      en: "The judge changes the verdict to WAIT because multiple risks are aligned against the trade.",
      ar: "القاضي يغيّر القرار إلى انتظار لأن عدة مخاطر اجتمعت ضد الصفقة.",
    });
  }

  for (const item of riskItems) {
    for (const msg of item.messages) messages.push(msg);
  }

  return {
    active: to !== input.verdict || confidenceAdjustment !== 0 || riskScore > 0,
    from: input.verdict,
    to,
    mode,
    riskScore,
    confidenceAdjustment,
    adjustedConfidence,
    riskItems,
    messages,
  };
}
