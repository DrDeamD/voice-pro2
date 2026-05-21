# Trading Court v3.7d — No-Assumption Pass

أربعة ملفات. هدف الجولة: حذف كل افتراض من القاضي. كل قيمة إمّا محسوبة من بيانات حقيقية بمعادلة موثَّقة، أو معروضة كـ `null` صريحاً مع تسجيل مصدر "missing".

---

## ما تغيّر فعلياً

### 1. `src/engines/marketStructure.ts` (مُعدَّل)
أضفت دالّة `computeDealingRange()` و حقولاً جديدة على `MarketStructureReport`:

| الحقل الجديد | المصدر | عند الفقد |
|---|---|---|
| `dealingRange.high/low` | swing high/low يحيطان آخر BOS فعلياً | `null` |
| `dealingRange.positionPct` | `(price - low) / (high - low)` بدون clamp | `null` |
| `dealingRange.positionPctScaled` | × 100 | `null` |
| `lastBosKind` | آخر event kind من `events[]` فعلياً | `null` |
| `lastBosFresh` | `event.fresh` boolean | `false` |
| `lastChochKind` | آخر CHoCH event | `null` |
| `lastChochFresh` | نفس | `false` |

**نقطة مهمّة في `computeDealingRange`:** لا أعمل clamp على `positionPct` خارج [0,1]. لو السعر تجاوز الـ dealing range (positionPct = 1.15 مثلاً)، هذه معلومة تشخيصية للقاضي، ليست حالة شاذّة تحتاج إخفاء. أمّا حينما لا تتوفّر swing low قبل breakIdx، النتيجة `null` لا fallback.

### 2. `src/engines/judge/judgeEngineV4.ts` (مُعدَّل)
- `H4Trend` صار يقبل `"UNKNOWN"`. سابقاً كان يفرض "RANGE" لـ DEAD/VOLATILE، ما يخفي حقيقة أن السوق غير مقروء.
- `UNKNOWN` يُضيف `unknown_h4_trend` بـ 12 نقطة خطر — عقوبة معتدلة، لا veto كاسح.
- `isPremiumTrap` و `isDiscountTrap` و `hasBosInWrongLocation` الآن تتحقّق صراحةً `Number.isFinite(premiumPct)` قبل المقارنة. سابقاً كان `(input.premiumPct ?? 0) >= 70` → `null` يصبح `0` (صدفة لا يفعّل، لكن لو الاتجاه معاكس مع `?? 100` كان مزوّراً).

### 3. `src/engines/v36/judgeOverride.ts` (إعادة كتابة كاملة)

**الفلسفة:** كل `read*()` تتبع ثلاث قواعد:
1. تقرأ من حقل موثَّق فقط (موجود في types أو في خرج محرّك).
2. لا regex على نص.
3. لو الحقل غير موجود → `null` أو `"NONE"` صريحاً.

**جدول الإسناد الكامل:**

| القاضي يطلب | المصدر الحقيقي | لو غير موجود |
|---|---|---|
| `h4Trend` | `regime.label` | `"UNKNOWN"` |
| `premiumPct` | `marketStructure.dealingRange.positionPctScaled` | يقع على `premiumDiscount.positionPct × 100`، ثم `null` |
| `intradayBias` | `scores.direction` + corroboration بـ `composite ≥ 30` أو `marketStructure.score ≥ 25` | `"NEUTRAL"` |
| `newsImpact` | `news.breakingActive` أو `news.highImpactPending` | `"NONE"` (لا "MEDIUM" مزوّر) |
| `sweptHigh/Low` | `manipulation.primary.kind` (BULLISH_SWEEP→sweptLow, BEARISH_SWEEP→sweptHigh, JUDAS_BULL→sweptLow, JUDAS_BEAR→sweptHigh) | `null/null` |
| `bos` | `marketStructure.lastBosKind` + `lastBosFresh` | `"NONE"` |
| `choch` | `marketStructure.lastChochKind` + `lastChochFresh` | `"NONE"` |
| `newsAlignedWithTrade` | `news.breakingScore` ضد `direction` (إذا breakingActive) أو `news.pairScore` (إذا highImpactPending) | `false` |
| `entryConfirmation` | `m5Trigger.signal === "BULL_TRIGGER" \|\| "BEAR_TRIGGER"` | `false` |

**جديد:** `judgeOverride.inputs` يُلحَق بالمخرَج. الآن كل قرار يأتي مع snapshot لـ ما رآه القاضي من بيانات، بما فيها `premiumPctSource: "dealingRange" \| "premiumDiscount" \| "missing"`. حين يحدث WAIT بسبب premium trap، يمكنك التحقّق فوراً ما إذا كان مصدر النسبة dealing range الحقيقي أم legacy fallback.

**فرق سلوكي مهمّ:** القاضي السابق كان يعتبر BOS صالحاً مهما كان عمره. الآن `readBos` تفلتر `lastBosFresh === true` فقط (ageBars ≤ 3). BOS قبل 10 شموع لا يستحقّ بناء قرار حالي عليه. هذا يقلّل تفعيل `bos_in_wrong_location` في الحالات العشوائية.

### 4. `src/engines/court.ts` (لا يحتاج تغيير)
الإصدار v3.7c يُمرّر `marketStructure` كاملاً للـ `applyV36StatisticalCourt`. الحقول الجديدة (`dealingRange`, `lastBosKind`, إلخ) تنتقل تلقائياً عبر spread.

---

## نقاط قد تثير دهشة

**(أ) عدد قرارات BUY/SELL سيتراجع قليلاً.** لأن:
- `lastBosFresh` filter يحذف BOS القديم من تأثير القاضي.
- `premiumPctSource: missing` لا يولّد premium trap قرار. سابقاً كان ينتج 0 من `?? 0`.
- `H4Trend = UNKNOWN` يضيف 12 نقطة خطر بدل أن يبدو RANGE هادئ.

هذا تراجع متعمَّد. كل ضربة تراجع تأتي من إصلاح بيانات مزوّرة. الباقي قرارات حقيقية.

**(ب) `dealingRange` قد يكون null حتى في وضع طبيعي.** سيناريوهان:
- أوّل تحليل بعد إعادة تشغيل: `events[]` فارغ حتى تكشف الـ pivot algorithm بضع شموع.
- زوج هادئ بدون أي BOS منذ بداية شموع H4 المتاحة (250 شمعة H4 ≈ 41 يوماً).

في كلا الحالتين، القاضي يستخدم legacy `premiumDiscount` كـ source = `"premiumDiscount"`. هذا ليس fallback مزوّر، هو حسبة موثَّقة قديمة. الـ `inputs.premiumPctSource` يُظهر ذلك صراحةً.

**(ج) `readSweeps` قد ترجع `null/null`.** هذا يحدث عندما `manipulation` غير موجود في الـ analysis (نادر لكن ممكن لو شموع H1 تحت 12). سابقاً كان يفترض `false/false` صامتاً. الآن صريح: لا أعرف.

---

## اختبار يدوي مقترَح بعد deploy

```bash
npm run build
npm run preview
curl -s 'http://localhost:3000/api/snapshot?force=1' \
  | jq '.pairs[] | {sym: .symbol, judge: .judgeOverride.inputs}'
```

ابحث عن:
1. أي زوج مع `premiumPctSource: "missing"` → معناه السوق ضيق ولا dealing range قابل للحسبة. القاضي يتجنّب premium-trap rules. هذا متعمَّد.
2. `sweptHigh: null, sweptLow: null` → manipulation engine لم يصدر إشارة. القاضي لا يسجّل risk من هذه القناة.
3. `h4Trend: "UNKNOWN"` → +12 نقطة خطر تظهر في `judgeOverride.code` كـ `unknown_h4_trend`.

---

## ما لم أعمله (متعمَّد)

**معايرة `confidence`** ما زالت مؤجَّلة. هي الإصلاح التالي الأكبر، لكن تتطلّب backtest قبلها. لا أصنع رقماً مسحوباً من الهواء وأسمّيه "احتمال نجاح". لو أردت أن أبني backtest framework صغير على شموع تاريخية من Kraken (مجاناً، لا API key)، أعطني الإذن وأبدأ.

**Trade journal** للقرارات: لم أبنِه. لكن مع `judgeOverride.inputs` الآن مكشوف، أيّ logger خارجي يمكنه ربط القرار بنتيجته.
