type JudgeOverrideMessage = {
  en: string;
  ar: string;
};

type JudgeOverride = {
  active: boolean;
  from: "BUY" | "SELL" | "WAIT";
  to: "BUY" | "SELL" | "WAIT";
  code: string | null;
  severity: "INFO" | "WARNING" | "BLOCKER";
  mode?: "NO_OVERRIDE" | "CONFIDENCE_ADJUST" | "WAIT_FOR_CONFIRMATION" | "HARD_WAIT";
  riskScore?: number;
  confidenceAdjustment?: number;
  adjustedConfidence?: number;
  messages: JudgeOverrideMessage[];
};

function verdictAr(v: string) {
  if (v === "BUY") return "شراء";
  if (v === "SELL") return "بيع";
  return "انتظار";
}

export function JudgeOverrideBox({ judgeOverride }: { judgeOverride?: JudgeOverride }) {
  if (!judgeOverride) {
    return (
      <section className="rounded-2xl border border-slate-700 bg-slate-950/40 p-4 shadow-sm">
        <h3 className="text-lg font-bold text-slate-200">⚖️ Judge Review</h3>
        <p className="text-sm text-slate-400" dir="rtl">مراجعة القاضي غير متوفرة في هذا الرد.</p>
      </section>
    );
  }

  const active = judgeOverride.active;

  return (
    <section className={`rounded-2xl border p-4 shadow-sm ${
      active ? "border-amber-500/40 bg-amber-950/20" : "border-slate-700 bg-slate-950/40"
    }`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className={`text-lg font-bold ${active ? "text-amber-300" : "text-slate-200"}`}>
            ⚖️ Judge Override: {active ? "ACTIVE" : "NONE"}
          </h3>
          <p className={`text-sm ${active ? "text-amber-200/80" : "text-slate-400"}`} dir="rtl">
            تدخل القاضي: {active ? "مفعّل" : "غير مفعّل"}
          </p>
        </div>

        <div className="text-right text-sm text-slate-200">
          <div>Initial Verdict: <b>{judgeOverride.from}</b></div>
          <div dir="rtl">القرار الأولي: <b>{verdictAr(judgeOverride.from)}</b></div>
          <div className="mt-1">Final Verdict: <b>{judgeOverride.to}</b></div>
          <div dir="rtl">القرار النهائي: <b>{verdictAr(judgeOverride.to)}</b></div>
          {typeof judgeOverride.riskScore === "number" && (
            <>
              <div className="mt-1">Judge Risk: <b>{judgeOverride.riskScore}</b></div>
              <div dir="rtl">خطر القاضي: <b>{judgeOverride.riskScore}</b></div>
            </>
          )}
        </div>
      </div>

      {active ? (
        <div className="space-y-3">
          {judgeOverride.messages.map((m, i) => (
            <div key={i} className="border-t border-amber-500/20 pt-3 first:border-t-0 first:pt-0">
              <p className="text-sm leading-6 text-slate-100">{m.en}</p>
              <p className="mt-1 text-sm leading-6 text-amber-100" dir="rtl">{m.ar}</p>
            </div>
          ))}
        </div>
      ) : (
        <div className="border-t border-slate-700 pt-3">
          <p className="text-sm leading-6 text-slate-300">
            The judge did not change the verdict for this setup.
          </p>
          <p className="mt-1 text-sm leading-6 text-slate-400" dir="rtl">
            القاضي لم يغيّر القرار في هذه الحالة.
          </p>
        </div>
      )}

      {judgeOverride.code && (
        <div className="mt-3 text-xs text-amber-300/70">
          Code: {judgeOverride.code}
        </div>
      )}
    </section>
  );
}
