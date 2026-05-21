// ============================================================================
// HTTP client with in-memory TTL cache (Edge-compatible)
// ============================================================================
import { DEFAULT_HEADERS, HTTP_TIMEOUT_MS } from "./config.js";

interface CacheEntry<T> { value: T; expires: number; }
const cache = new Map<string, CacheEntry<any>>();

export const sourceHealth: Record<string, { ok: boolean; lastSuccess: number; lastTry: number; note?: string }> = {};

function mark(source: string, ok: boolean, note?: string) {
  const now = Date.now();
  const prev = sourceHealth[source] || { ok: false, lastSuccess: 0, lastTry: 0 };
  sourceHealth[source] = {
    ok,
    lastSuccess: ok ? now : prev.lastSuccess,
    lastTry: now,
    note,
  };
}

interface FetchOpts {
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  cacheKey?: string;
  ttlSec?: number;
  source?: string;
  retries?: number;
}

export async function httpJSON<T = any>(url: string, opts: FetchOpts = {}): Promise<T | null> {
  const key = opts.cacheKey;
  const ttl = opts.ttlSec ?? 0;
  const source = opts.source ?? new URL(url).hostname;

  if (key && ttl > 0) {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value as T;
  }

  const retries = opts.retries ?? 1;
  let lastErr: any = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? HTTP_TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        method: opts.method ?? "GET",
        headers: { ...DEFAULT_HEADERS, ...(opts.headers ?? {}) },
        body: opts.body,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) {
        mark(source, false, `HTTP ${r.status}`);
        // Retry on 5xx server errors AND 429 rate-limiting
        if ((r.status >= 500 || r.status === 429) && attempt < retries) {
          await sleep(300 * (attempt + 1));
          continue;
        }
        // On failure, return stale cache if available (better than nothing)
        if (key) {
          const stale = cache.get(key);
          if (stale) return stale.value as T;
        }
        return null;
      }
      const text = await r.text();
      let data: any;
      try { data = JSON.parse(text); }
      catch {
        mark(source, false, "JSON parse fail");
        // Return stale cache on parse failure
        if (key) { const stale = cache.get(key); if (stale) return stale.value as T; }
        return null;
      }
      if (key && ttl > 0) cache.set(key, { value: data, expires: Date.now() + ttl * 1000 });
      mark(source, true);
      return data as T;
    } catch (e: any) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retries) { await sleep(300 * (attempt + 1)); continue; }
    }
  }
  // Final fallback: return stale cache if available
  if (key) {
    const stale = cache.get(key);
    if (stale) {
      mark(source, false, `${String(lastErr)} (using stale cache)`);
      return stale.value as T;
    }
  }
  mark(source, false, String(lastErr));
  return null;
}

export async function httpText(url: string, opts: FetchOpts = {}): Promise<string | null> {
  const key = opts.cacheKey;
  const ttl = opts.ttlSec ?? 0;
  const source = opts.source ?? new URL(url).hostname;

  if (key && ttl > 0) {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value as string;
  }

  const retries = opts.retries ?? 1;
  let lastErr: any = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? HTTP_TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        method: opts.method ?? "GET",
        headers: { ...DEFAULT_HEADERS, ...(opts.headers ?? {}) },
        body: opts.body,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) {
        mark(source, false, `HTTP ${r.status}`);
        if ((r.status >= 500 || r.status === 429) && attempt < retries) {
          await sleep(300 * (attempt + 1));
          continue;
        }
        if (key) { const stale = cache.get(key); if (stale) return stale.value as string; }
        return null;
      }
      const text = await r.text();
      if (key && ttl > 0) cache.set(key, { value: text, expires: Date.now() + ttl * 1000 });
      mark(source, true);
      return text;
    } catch (e: any) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retries) { await sleep(300 * (attempt + 1)); continue; }
    }
  }
  if (key) {
    const stale = cache.get(key);
    if (stale) {
      mark(source, false, `${String(lastErr)} (using stale cache)`);
      return stale.value as string;
    }
  }
  mark(source, false, String(lastErr));
  return null;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export function clearCache() { cache.clear(); }
export function cacheStats() {
  return { size: cache.size, keys: Array.from(cache.keys()) };
}
