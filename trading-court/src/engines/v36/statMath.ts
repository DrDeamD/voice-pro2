// ============================================================================
// Trading Court Pro v3.6 — Statistical Witness Math
// Pure TypeScript. Deterministic. No API calls. No fake data.
// ============================================================================

import type { Candle } from "../../types/index.js";
import type { V36WitnessResult } from "./statTypes.js";

const EPS = 1e-12;
const MU1 = Math.sqrt(2 / Math.PI);

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
}

function std(xs: number[]): number {
  return Math.sqrt(Math.max(0, variance(xs)));
}

export function logReturns(candles: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const p0 = candles[i - 1].c;
    const p1 = candles[i].c;
    if (Number.isFinite(p0) && Number.isFinite(p1) && p0 > 0 && p1 > 0) {
      out.push(Math.log(p1 / p0));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1) Realized Vol + Bipower
// ---------------------------------------------------------------------------
export function realizedVolBipowerWitness(candles: Candle[]): V36WitnessResult {
  const r = logReturns(candles);
  if (r.length < 48) {
    return { name: "RealizedVolBipower", signal: 0, confidence: 0, reliable: false, reasons: ["insufficient_returns"] };
  }

  let rv = 0;
  for (const x of r) rv += x * x;

  let bv = 0;
  for (let i = 1; i < r.length; i++) {
    bv += Math.abs(r[i]) * Math.abs(r[i - 1]);
  }
  bv = bv / (MU1 * MU1);

  if (!Number.isFinite(rv) || !Number.isFinite(bv) || rv <= EPS) {
    return { name: "RealizedVolBipower", signal: 0, confidence: 0, reliable: false, reasons: ["invalid_rv_bv"] };
  }

  const jumpRatio = clamp(Math.max(0, (rv - bv) / (rv + EPS)), 0, 1);
  let signal = +20;
  let confidence = Math.min(1, r.length / 96) * 0.6;
  const reasons = [`jumpRatio=${jumpRatio.toFixed(4)}`];

  if (jumpRatio >= 0.45) {
    signal = -70;
    confidence = Math.min(1, r.length / 96) * 0.85;
    reasons.push("jump_or_spike_risk");
  } else if (jumpRatio >= 0.25) {
    signal = -35;
    confidence = Math.min(1, r.length / 96) * 0.65;
    reasons.push("moderate_jump_risk");
  }

  return {
    name: "RealizedVolBipower",
    signal,
    confidence,
    reliable: confidence >= 0.25,
    reasons,
    metrics: { rv, bv, jumpRatio },
  };
}

// ---------------------------------------------------------------------------
// 2) Hurst Exponent
// ---------------------------------------------------------------------------
function linearRegression(xs: number[], ys: number[]) {
  const xm = mean(xs);
  const ym = mean(ys);
  let num = 0;
  let den = 0;

  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - xm) * (ys[i] - ym);
    den += (xs[i] - xm) ** 2;
  }

  const slope = den <= EPS ? 0 : num / den;
  const intercept = ym - slope * xm;

  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < xs.length; i++) {
    const fitted = intercept + slope * xs[i];
    ssTot += (ys[i] - ym) ** 2;
    ssRes += (ys[i] - fitted) ** 2;
  }

  const r2 = ssTot <= EPS ? 0 : 1 - ssRes / ssTot;
  return { slope, r2: clamp(r2, 0, 1) };
}

export function hurstWitness(candles: Candle[]): V36WitnessResult {
  const prices = candles.map(c => c.c).filter(p => Number.isFinite(p) && p > 0);
  if (prices.length < 128) {
    return { name: "HurstExponent", signal: 0, confidence: 0, reliable: false, reasons: ["insufficient_prices"] };
  }

  const lags = [2, 4, 8, 16, 32];
  const logLags: number[] = [];
  const logVars: number[] = [];

  for (const lag of lags) {
    if (prices.length <= lag + 10) continue;
    const diffs: number[] = [];
    for (let i = lag; i < prices.length; i++) {
      diffs.push(Math.log(prices[i]) - Math.log(prices[i - lag]));
    }
    const v = variance(diffs);
    if (v > EPS && Number.isFinite(v)) {
      logLags.push(Math.log(lag));
      logVars.push(Math.log(v));
    }
  }

  if (logLags.length < 3) {
    return { name: "HurstExponent", signal: 0, confidence: 0, reliable: false, reasons: ["insufficient_lags"] };
  }

  const reg = linearRegression(logLags, logVars);
  const h = clamp(reg.slope / 2, 0, 1);

  if (reg.r2 < 0.30) {
    return {
      name: "HurstExponent",
      signal: 0,
      confidence: 0,
      reliable: false,
      reasons: [`hurst=${h.toFixed(4)}`, `r2=${reg.r2.toFixed(4)}`, "low_r2"],
      metrics: { hurst: h, r2: reg.r2 },
    };
  }

  let signal = 0;
  if (h > 0.58) signal = +30;
  else if (h < 0.42) signal = -30;

  const confidence = reg.r2 < 0.50 ? Math.min(0.35, reg.r2) : Math.min(1, reg.r2);

  return {
    name: "HurstExponent",
    signal,
    confidence,
    reliable: true,
    reasons: [`hurst=${h.toFixed(4)}`, `r2=${reg.r2.toFixed(4)}`],
    metrics: { hurst: h, r2: reg.r2 },
  };
}

// ---------------------------------------------------------------------------
// 3) GARCH(1,1), deterministic grid
// ---------------------------------------------------------------------------
function fitGarchGrid(r: number[]) {
  const var0 = variance(r);
  let best = { alpha: 0.05, beta: 0.90, ll: -Infinity };

  if (var0 <= EPS) return { ...best, reliable: false };

  for (let ai = 3; ai <= 20; ai += 2) {
    const alpha = ai / 100;

    for (let bi = 70; bi <= 96; bi += 2) {
      const beta = bi / 100;
      if (alpha + beta >= 0.98) continue;

      const omega = var0 * (1 - alpha - beta);
      if (omega <= 0) continue;

      let sigma2 = var0;
      let ll = 0;

      for (let t = 1; t < r.length; t++) {
        sigma2 = omega + alpha * r[t - 1] ** 2 + beta * sigma2;
        if (sigma2 <= EPS || !Number.isFinite(sigma2)) {
          ll = -Infinity;
          break;
        }
        ll += -0.5 * (Math.log(2 * Math.PI) + Math.log(sigma2) + (r[t] ** 2) / sigma2);
      }

      if (ll > best.ll) best = { alpha, beta, ll };
    }
  }

  return { ...best, reliable: Number.isFinite(best.ll) };
}

export function garchWitness(candles: Candle[]): V36WitnessResult {
  const r = logReturns(candles);
  if (r.length < 96) {
    return { name: "GARCH", signal: 0, confidence: 0, reliable: false, reasons: ["insufficient_returns"] };
  }

  const fit = fitGarchGrid(r);
  if (!fit.reliable) {
    return { name: "GARCH", signal: 0, confidence: 0, reliable: false, reasons: ["fit_failed"] };
  }

  const persistence = fit.alpha + fit.beta;
  let signal = 0;
  const reasons = [
    `alpha=${fit.alpha.toFixed(2)}`,
    `beta=${fit.beta.toFixed(2)}`,
    `persistence=${persistence.toFixed(2)}`,
  ];

  if (persistence > 0.97) {
    signal = -80;
    reasons.push("non_stationary_risk");
  } else if (persistence > 0.94) {
    signal = -35;
    reasons.push("high_persistence");
  } else if (persistence < 0.85) {
    signal = +20;
    reasons.push("stable_variance");
  }

  const confidence = Math.min(1, r.length / 192);

  return {
    name: "GARCH",
    signal,
    confidence,
    reliable: confidence >= 0.25,
    reasons,
    metrics: { alpha: fit.alpha, beta: fit.beta, persistence },
  };
}

// ---------------------------------------------------------------------------
// 4) Hawkes-lite, candle-event clustering only
// ---------------------------------------------------------------------------
function extractDirectionalEvents(candles: Candle[], zThreshold = 1.25) {
  const r = logReturns(candles);
  if (r.length < 30) return { longEvents: [] as number[], shortEvents: [] as number[], n: r.length };

  const m = mean(r);
  const s = std(r);
  if (s <= EPS) return { longEvents: [] as number[], shortEvents: [] as number[], n: r.length };

  const longEvents: number[] = [];
  const shortEvents: number[] = [];

  for (let i = 0; i < r.length; i++) {
    const z = (r[i] - m) / (s + EPS);
    const c = candles[i + 1];

    if (z >= zThreshold && c.c > c.o) longEvents.push(i);
    if (z <= -zThreshold && c.c < c.o) shortEvents.push(i);
  }

  return { longEvents, shortEvents, n: r.length };
}

function intensityAt(t: number, events: number[], mu: number, alpha: number, beta: number): number {
  let lambda = mu;
  for (const e of events) {
    if (e < t) lambda += alpha * Math.exp(-beta * (t - e));
  }
  return Math.max(EPS, lambda);
}

function estimateAlpha(events: number[], n: number, beta = 1.0) {
  if (events.length < 2 || n <= 0) return { alpha: 0, reliable: false };

  const mu = events.length / n;
  let bestAlpha = 0;
  let bestLL = -Infinity;

  for (let ai = 0; ai <= 98; ai += 2) {
    const alpha = ai / 100;
    if (alpha / beta >= 1) continue;

    let ll = 0;

    for (const t of events) {
      ll += Math.log(intensityAt(t, events, mu, alpha, beta) + EPS);
    }

    for (let t = 0; t < n; t++) {
      ll -= intensityAt(t, events, mu, alpha, beta);
    }

    if (ll > bestLL) {
      bestLL = ll;
      bestAlpha = alpha;
    }
  }

  return { alpha: bestAlpha, reliable: Number.isFinite(bestLL) };
}

export function hawkesLiteWitness(candles: Candle[]): V36WitnessResult {
  if (candles.length < 80) {
    return { name: "HawkesLite", signal: 0, confidence: 0, reliable: false, reasons: ["insufficient_candles"] };
  }

  const ev = extractDirectionalEvents(candles);
  const totalEvents = ev.longEvents.length + ev.shortEvents.length;

  if (ev.n < 72 || totalEvents < 4) {
    return { name: "HawkesLite", signal: 0, confidence: 0, reliable: false, reasons: ["insufficient_events"] };
  }

  const beta = 1.0;
  const lf = estimateAlpha(ev.longEvents, ev.n, beta);
  const sf = estimateAlpha(ev.shortEvents, ev.n, beta);

  if (!lf.reliable && !sf.reliable) {
    return { name: "HawkesLite", signal: 0, confidence: 0, reliable: false, reasons: ["fit_failed"] };
  }

  const longExcitation = lf.alpha / beta;
  const shortExcitation = sf.alpha / beta;
  const maxExcitation = Math.max(longExcitation, shortExcitation);
  const signal = clamp(100 * (longExcitation - shortExcitation), -100, 100);

  const sampleConfidence = Math.min(1, ev.n / 144);
  const eventConfidence = Math.min(1, totalEvents / 12);
  const stability = Math.max(0, 1 - maxExcitation);
  const confidence = clamp(sampleConfidence * eventConfidence * (0.5 + 0.5 * stability), 0, 1);

  return {
    name: "HawkesLite",
    signal: confidence >= 0.25 && maxExcitation < 1 ? signal : 0,
    confidence: confidence >= 0.25 && maxExcitation < 1 ? confidence : 0,
    reliable: confidence >= 0.25 && maxExcitation < 1,
    reasons: [
      `longEvents=${ev.longEvents.length}`,
      `shortEvents=${ev.shortEvents.length}`,
      `longAlpha=${lf.alpha.toFixed(2)}`,
      `shortAlpha=${sf.alpha.toFixed(2)}`,
    ],
    metrics: {
      longEvents: ev.longEvents.length,
      shortEvents: ev.shortEvents.length,
      longAlpha: lf.alpha,
      shortAlpha: sf.alpha,
    },
  };
}
