// ============================================================================
// Kill Zone Engine (NEW) — ICT-style session quality + Day-of-Week filter
//
// Fixes audit flaw #7: session_engine ignored day-of-week.
//   • Sunday < 22:00 UTC     → market closed / pre-open → VETO
//   • Sunday 22:00-22:30 UTC → opening gap window       → VETO
//   • Friday ≥ 18:00 UTC     → weekly close, spreads widen → VETO
//   • Monday 07:00-07:30 UTC → first London candle, gap-risk → CAUTION
//
// Also defines ICT Kill Zones (micro-windows where institutions trade):
//   ASIA KZ       : 00:00-03:00 UTC
//   LONDON KZ     : 07:00-10:00 UTC (first 3h of London)
//   NY AM KZ      : 13:00-15:00 UTC (first 2h of NY)
//   LONDON CLOSE  : 15:00-17:00 UTC (London close / NY continuation)
// ============================================================================
import type { SessionReport } from "../types/index.js";

export type KZQuality = 0 | 1 | 2 | 3;   // 0=dead, 3=premium

export interface KillZoneReport {
  session: SessionReport["name"];
  weekday: number;              // 0=Sun .. 6=Sat (JS)
  killZone: "ASIA_KZ" | "LONDON_KZ" | "NY_AM_KZ" | "LONDON_CLOSE_KZ" | "NONE";
  quality: KZQuality;
  weight: number;               // multiplier for final composite
  vetoed: boolean;
  vetoReason?: string;
  reasoning: string;
  utcNow: string;
  nextKillZoneInMinutes?: number;
}

function hourMin(d: Date): { h: number; m: number } {
  return { h: d.getUTCHours(), m: d.getUTCMinutes() };
}

function isInWindow(h: number, m: number, startH: number, startM: number, endH: number, endM: number): boolean {
  const now = h * 60 + m;
  const s = startH * 60 + startM;
  const e = endH * 60 + endM;
  return now >= s && now < e;
}

// Standard session labels (matches existing session engine)
function classifyBaseSession(h: number): SessionReport["name"] {
  if (h >= 13 && h < 16) return "LONDON_NY_OVERLAP";
  if (h >= 7 && h < 13) return "LONDON";
  if (h >= 13 && h < 21) return "NY";
  if (h >= 0 && h < 7) return "ASIA";
  return "QUIET";
}

function nextKZStartMinutes(h: number, m: number): number {
  const now = h * 60 + m;
  // Kill zone starts in order through the day
  const starts = [
    0,      // Asia KZ 00:00
    7 * 60, // London KZ 07:00
    13 * 60,// NY AM KZ 13:00
    15 * 60,// London close KZ 15:00
  ];
  for (const s of starts) {
    if (s > now) return s - now;
  }
  return 24 * 60 - now + 0; // next day asia open
}

export function classifyKillZone(nowUtc: Date = new Date()): KillZoneReport {
  const { h, m } = hourMin(nowUtc);
  const weekday = nowUtc.getUTCDay(); // 0 Sun .. 6 Sat
  const iso = nowUtc.toISOString();
  const baseSession = classifyBaseSession(h);

  // -----------------------------------------------------------------
  // Day-of-Week VETOES (critical)
  // -----------------------------------------------------------------

  // Saturday: market closed
  if (weekday === 6) {
    return {
      session: "QUIET", weekday,
      killZone: "NONE", quality: 0, weight: 0,
      vetoed: true, vetoReason: "Saturday — FX market closed",
      reasoning: "السوق مغلق يوم السبت. لا دخول.",
      utcNow: iso,
    };
  }

  // Sunday before 22:00 UTC: market closed (opens Sunday 22:00 UTC)
  if (weekday === 0 && h < 22) {
    return {
      session: "QUIET", weekday,
      killZone: "NONE", quality: 0, weight: 0,
      vetoed: true, vetoReason: "Sunday pre-open — market opens 22:00 UTC",
      reasoning: `الأحد ${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")} UTC — السوق مغلق، يفتح 22:00 UTC.`,
      utcNow: iso,
    };
  }

  // Sunday 22:00-22:30: opening gap window
  if (weekday === 0 && h === 22 && m < 30) {
    return {
      session: "ASIA", weekday,
      killZone: "NONE", quality: 0, weight: 0.3,
      vetoed: true, vetoReason: "Sunday open gap window (22:00-22:30 UTC)",
      reasoning: "أول 30 دقيقة من فتح الأسبوع. السبريد مرتفع ومخاطر gap fill عالية. انتظر.",
      utcNow: iso,
    };
  }

  // Friday after 18:00 UTC: weekly close, spreads widen dramatically
  if (weekday === 5 && h >= 18) {
    return {
      session: "NY", weekday,
      killZone: "NONE", quality: 0, weight: 0.2,
      vetoed: true, vetoReason: "Friday weekly close (≥18:00 UTC) — spreads widen, liquidity dries",
      reasoning: "جمعة بعد 18:00 UTC. السيولة تجف والسبريد يتضاعف. لا دخول جديد.",
      utcNow: iso,
    };
  }

  // -----------------------------------------------------------------
  // Kill Zone windows (premium trading windows)
  // -----------------------------------------------------------------

  // LONDON KZ: 07:00 - 10:00 UTC  (first 3 hours of London) — HIGHEST priority
  if (isInWindow(h, m, 7, 0, 10, 0)) {
    const isMondayFirstCandle = (weekday === 1 && h === 7 && m < 30);
    const quality: KZQuality = isMondayFirstCandle ? 2 : 3;
    const weight = isMondayFirstCandle ? 1.10 : 1.20;
    return {
      session: "LONDON", weekday,
      killZone: "LONDON_KZ", quality, weight,
      vetoed: false,
      reasoning: isMondayFirstCandle
        ? "London Open Kill Zone — لكن هذه أول 30 دقيقة يوم الاثنين (احذر gap من الجمعة)."
        : "🎯 London Open Kill Zone (07:00-10:00 UTC) — أفضل نافذة تداول بعد London Open.",
      utcNow: iso,
    };
  }

  // NY AM KZ: 13:00 - 15:00 UTC
  if (isInWindow(h, m, 13, 0, 15, 0)) {
    return {
      session: "LONDON_NY_OVERLAP", weekday,
      killZone: "NY_AM_KZ", quality: 3, weight: 1.15,
      vetoed: false,
      reasoning: "🎯 NY AM Kill Zone (13:00-15:00 UTC) — overlap مع لندن، أعلى سيولة في اليوم.",
      utcNow: iso,
    };
  }

  // LONDON CLOSE KZ: 15:00 - 17:00 UTC
  if (isInWindow(h, m, 15, 0, 17, 0)) {
    return {
      session: "LONDON_NY_OVERLAP", weekday,
      killZone: "LONDON_CLOSE_KZ", quality: 2, weight: 1.05,
      vetoed: false,
      reasoning: "London Close Kill Zone (15:00-17:00 UTC) — تقلبات عالية من إعادة الوضعية.",
      utcNow: iso,
    };
  }

  // ASIA KZ: 00:00 - 03:00 UTC (Tokyo open)
  if (isInWindow(h, m, 0, 0, 3, 0)) {
    return {
      session: "ASIA", weekday,
      killZone: "ASIA_KZ", quality: 2, weight: 0.95,
      vetoed: false,
      reasoning: "Asia Kill Zone (00:00-03:00 UTC) — جيدة لـ JPY, AUD, NZD فقط.",
      utcNow: iso,
    };
  }

  // -----------------------------------------------------------------
  // Non-KZ — standard sessions
  // -----------------------------------------------------------------
  const mins = nextKZStartMinutes(h, m);

  if (baseSession === "LONDON" || baseSession === "NY" || baseSession === "LONDON_NY_OVERLAP") {
    return {
      session: baseSession, weekday,
      killZone: "NONE", quality: 1, weight: 0.9,
      vetoed: false,
      reasoning: `جلسة ${baseSession} بدون kill zone نشطة. جودة متوسطة.`,
      utcNow: iso,
      nextKillZoneInMinutes: mins,
    };
  }

  if (baseSession === "ASIA") {
    return {
      session: "ASIA", weekday,
      killZone: "NONE", quality: 1, weight: 0.75,
      vetoed: false,
      reasoning: "جلسة آسيا خارج KZ — سيولة محدودة. فضّل JPY/AUD/NZD.",
      utcNow: iso,
      nextKillZoneInMinutes: mins,
    };
  }

  return {
    session: "QUIET", weekday,
    killZone: "NONE", quality: 0, weight: 0.6,
    vetoed: false,
    reasoning: "ساعات هادئة. لا نموذج كافٍ من السيولة للدخول.",
    utcNow: iso,
    nextKillZoneInMinutes: mins,
  };
}
