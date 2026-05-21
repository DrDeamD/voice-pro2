# Trading Court v3.7c — Engineering Changes

ثلاث ملفات. تعدّل ملفين موجودين، تضيف ملفاً جديداً.

## 1. NEW — `src/engines/dayTradingGate.ts`

ملف جديد يطبّق قاعدتك الصريحة: كل صفقة يجب أن تُغلق في نفس يوم UTC.

**القواعد:**
- نهاية الأسبوع → veto مطلق (لا فتح يوم السبت/الأحد).
- الجمعة بعد 19:00 UTC → veto بسبب gap نهاية الأسبوع.
- بعد 21:00 UTC أو قبل أقل من 1.5 ساعة من 21:00 → veto (وقت غير كافٍ لـ TP1).
- بين 1.5 و 3 ساعات حتى الإغلاق → يُسمح فقط لتركيب STRONG/VALID و SL ≤ 30 pips للفوركس (أو 80 للذهب).
- > 3 ساعات → بدون قيد إضافي.

**ملاحظة على التصميم:** استخدمت 21:00 UTC ثابتة طوال السنة وليس DST دقيقاً. السبب: قاعدتك "نفس اليوم UTC"، وأي حسبة DST معقّدة تجعل القرار صعب التحقّق منه يدوياً. لو أردت DST صارمة (NY close ينقلب 20:00 UTC في الصيف ↔ 21:00 شتاءً) أخبرني.

## 2. REPLACE — `src/engines/court.ts`

تغييران فقط، الباقي مطابق:

### (أ) إصلاح m5Bonus — السطور التي تعالج البونص:
```ts
// قبل: composite يتغيّر، direction يبقى مجمّداً
const m5Bonus = h1h4Aligned ? m5TriggerScore(m5Trigger) : 0;
if (m5Bonus !== 0) {
  const newComposite  = clamp(scores.composite + m5Bonus, -100, 100);
  const newConfidence = clamp(scores.confidence + Math.abs(m5Bonus) * 0.6, 0, 100);
  const [newDir, newTier, newSize] = deriveDecision(newComposite, newConfidence);
  scores.composite     = round(newComposite);
  scores.confidence    = round(newConfidence);
  scores.direction     = newDir;        // ← كان مفقوداً
  scores.confidenceTier = newTier;      // ← كان مفقوداً
  scores.sizeMultiplier = newSize;      // ← كان مفقوداً
  ...
}
```

أضفت `deriveDecision()` كدالّة واحدة تترجم `(composite, confidence) → (direction, tier, sizeMult)`. تُستخدم الآن في مكانين فقط: داخل `composeScores` وبعد تطبيق m5Bonus. هذا يضمن أن أي بونص مستقبلي (مثلاً bonus من VWAP confluence) سيمرّ بنفس الحسبة.

### (ب) ربط EOD Gate بعد كل الفيتوهات الأخرى:
```ts
const eodGate = evaluateDayTradingGate({ now, direction, confidenceTier, stopDistancePips, symbol });
applyDayTradingGate(eodGate, risk, plan, warnings);
```

موضعه مهم: **بعد** killZone و freshness و breakingNews. السبب: EOD gate قاعدة سلوكية لا علاقة لها بحالة السوق، يجب أن تُطبّق على القرار النهائي وليس على أحداث متوسّطة.

### (ج) تنظيف `as any` من composeScores:
كان فيه 3 `as any` في حسبة composite، استبدلتها بـ `WeightMap` typed و `w(W, key)` helper. الفائدة: لو `DYNAMIC_WEIGHTS.breakingNews` نسي مفتاحاً (مثلاً `mtf`)، سترجع 0 بدل `undefined × number = NaN`. النتيجة الآن قابلة للتنبّؤ.

## 3. REPLACE — `src/engines/v36/judgeOverride.ts`

إعادة كتابة كاملة. كل دوال الاستخراج الجديدة (`readH4Trend`, `readPremiumPct`, `readBos`, `readChoch`, `readSweeps`, `readNewsImpact`, ...) تقرأ من **structured fields** في `analysis.regime`, `analysis.marketStructure`, `analysis.news`, `analysis.manipulation`، **بدون أي regex** على `bullCase[]` أو `summary`.

**فائدة مباشرة:** أي تحسين مستقبلي على صياغة `bullCase` لن يكسر القاضي. وإذا كان حقل بنيوي مفقوداً (مثلاً `marketStructure.bos` غير موجود في إصدار قديم)، يرجع `"NONE"` بشكل آمن بدل قرار وهمي مبني على نص.

**تحذير واحد:** افترضت أن `analysis.marketStructure.premiumDiscount.pricePct` موجود. لو محرّك `marketStructure.ts` يستخدم اسماً آخر (مثل `pctOfRange`)، أخبرني وسأعدّل. لي fallback يحسبه من `rangeHigh` و `rangeLow` لكنه أقل دقّة.

---

## ما يلي بعد هذه الجولة

P1 الذي أؤجّله الآن:
1. **معايرة `confidence`** — backtest على 30 يوم عبر 8 أزواج لاستخراج win-rate الفعلي عند كل بنطلون composite [15-25, 25-40, 40-60, 60-80, 80-100]. ثم الـ confidence الحقيقي = win-rate المُلاحَظ، ليس |composite|.
2. **Backtest framework** — عميل CSV يعيد تشغيل `analyzePair` على شموع تاريخية، يحسب PnL لكل قرار. هذا يفتح طريق المعايرة.
3. **Dealing range** بدل H4 lookback في `marketStructure.ts`.

P2 (متاح لاحقاً):
4. **Trade journal** — كل verdict يُحفظ مع outcome (يدوياً منك، اضغط win/loss/breakeven). شهر واحد كافٍ لمعرفة هل القاضي يصنع قرار أفضل من المحرّكات وحدها.

---

## للإختبار قبل الـ deploy

```bash
npm run build
# لا أخطاء TypeScript متوقّعة
npm run preview
curl 'http://localhost:3000/api/snapshot?force=1' | jq '.pairs[0].risk.reasons'
# يجب أن تظهر "Day-trading gate" في الأسباب لو الوقت بعد 19:30 UTC مثلاً
```

اختبار خاص لـ m5Bonus:
- ابحث عن زوج `composite` بين +5 و +14 و `m5Trigger.signal == "BULL_TRIGGER"` و H1/H4 محاذيتين.
- قبل الإصلاح: verdict = WAIT (FLAT)
- بعد الإصلاح: composite يصبح +15 إلى +24، direction = LONG، verdict = BUY (إن مرّ باقي الـ veto).

اختبار لـ Judge:
- بعد deploy، شغّل زوجاً تعرف أن H4=DOWN و premium% > 70 (BUY trap كلاسيكي).
- يجب أن يظهر `judgeOverride.riskScore ≥ 25` و `code` يحتوي `buy_in_bearish_premium`.
- إذا ظهر 0، فحقل `premiumPct` لم يُقرأ — أخبرني وسأفحص اسم الحقل في `marketStructure.ts`.
