// ============================================================================
// v3.4.1 — Dead Source Lint
//
// Purpose:
//   Prevent regression of the bug DrdreamD spotted in v3.4.0:
//   stale references to dead source names (forexfactory, investing-as-calendar,
//   myfxbook, livesquawk) survived in src/server.ts and src/types/index.ts
//   even after the sources were officially removed from KNOWN_SOURCES.
//
// What it does:
//   Walks every .ts file under src/ (except tests, comments, this file itself)
//   and FAILS if it finds any quoted string literal or array entry that names
//   a dead source.
//
// Why this is in the test runner, not just CI:
//   The user runs `npm test` after every change. If a future patch reintroduces
//   "myfxbook" in a frontend list, this fails immediately with a clear message.
// ============================================================================
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e: any) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("v3.4.1 — Dead Source Lint");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

// Tokens that MUST NOT appear as code identifiers/string literals in
// production source files. Comments and tests are exempt.
const FORBIDDEN_TOKENS: Array<{ token: string; reason: string }> = [
  { token: '"forexfactory"',  reason: "Dead — Cloudflare blocks server IPs on direct endpoint" },
  { token: "'forexfactory'",  reason: "Dead — Cloudflare blocks server IPs on direct endpoint" },
  { token: '"ff_direct"',     reason: "Dead — same endpoint as forexfactory" },
  { token: "'ff_direct'",     reason: "Dead — same endpoint as forexfactory" },
  { token: '"myfxbook"',      reason: "Dead — calendar JSON requires API auth" },
  { token: "'myfxbook'",      reason: "Dead — calendar JSON requires API auth" },
  { token: '"livesquawk"',    reason: "Dead — paid service, no public RSS" },
  { token: "'livesquawk'",    reason: "Dead — paid service, no public RSS" },
  // v3.5.4: fxstreet added — Cloudflare 403 confirmed via web_fetch in audit
  { token: '"fxstreet"',      reason: "Dead in v3.5.4 — Cloudflare blocks server IPs (HTTP 403 on /rss/news; /news/feed returns HTML, not RSS)" },
  { token: "'fxstreet'",      reason: "Dead in v3.5.4 — Cloudflare blocks server IPs (HTTP 403 on /rss/news; /news/feed returns HTML, not RSS)" },
  { token: '"FXStreet"',      reason: "Dead in v3.5.4 — see lowercase entry" },
];

// Note on "investing": the bare token is reused legitimately in candles.ts
// for the Investing.com chart API (different endpoint, no CSRF). v3.4.1 renamed
// that to "investing_candles". So we DO forbid bare "investing" except inside
// the candle-fallback comment header. The lint check accepts "investing_candles"
// and "investing_rss" but flags any standalone "investing" string literal.
const FORBIDDEN_BARE_INVESTING_RE = /["']investing["'](?!_)/;

// Files exempt from this lint:
//   - Anything under src/tests/  (tests assert dead sources are absent → must mention them)
//   - This file itself
//   - Block comments and line comments inside production files (we strip them before checking)
const EXEMPT_DIR_FRAGMENTS = ["/tests/"];

function walkSrc(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkSrc(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

function stripCommentsAndStrings(src: string): { codeOnly: string; rawForReporting: string } {
  // Strip block comments
  let s = src.replace(/\/\*[\s\S]*?\*\//g, "");
  // Strip line comments
  s = s.replace(/\/\/.*$/gm, "");
  return { codeOnly: s, rawForReporting: src };
}

function findInDir(srcRoot: string): { file: string; line: number; snippet: string; reason: string }[] {
  const violations: { file: string; line: number; snippet: string; reason: string }[] = [];
  const files = walkSrc(srcRoot);
  for (const f of files) {
    if (EXEMPT_DIR_FRAGMENTS.some(frag => f.includes(frag))) continue;
    const raw = readFileSync(f, "utf8");
    const { codeOnly } = stripCommentsAndStrings(raw);
    const lines = raw.split("\n");

    // For each forbidden token, check codeOnly first (fast). If found, locate
    // the actual line in the raw text for reporting.
    for (const { token, reason } of FORBIDDEN_TOKENS) {
      if (!codeOnly.includes(token)) continue;
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].replace(/\/\/.*$/, "").replace(/\/\*[\s\S]*?\*\//g, "");
        if (trimmed.includes(token)) {
          violations.push({ file: f, line: i + 1, snippet: lines[i].trim(), reason });
        }
      }
    }

    // Bare "investing" check
    if (FORBIDDEN_BARE_INVESTING_RE.test(codeOnly)) {
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].replace(/\/\/.*$/, "").replace(/\/\*[\s\S]*?\*\//g, "");
        if (FORBIDDEN_BARE_INVESTING_RE.test(trimmed)) {
          violations.push({
            file: f,
            line: i + 1,
            snippet: lines[i].trim(),
            reason: 'Bare "investing" — use "investing_candles" or "investing_rss" to disambiguate from dead POST scraper',
          });
        }
      }
    }
  }
  return violations;
}

// Find src directory (relative to compiled location at dist/tests/)
const SRC_DIR = "src";

test("No dead source name appears in production code", () => {
  const violations = findInDir(SRC_DIR);
  if (violations.length > 0) {
    const msg = violations.map(v =>
      `\n     ${v.file}:${v.line}\n        ${v.snippet}\n        → ${v.reason}`
    ).join("");
    throw new Error(`Found ${violations.length} dead-source reference(s):${msg}`);
  }
});

test("Lint covers expected files", () => {
  const files = walkSrc(SRC_DIR);
  const prodFiles = files.filter(f => !EXEMPT_DIR_FRAGMENTS.some(d => f.includes(d)));
  console.log(`     • scanned ${prodFiles.length} production .ts file(s)`);
  assert.ok(prodFiles.length >= 15, `expected ≥15 production files, found ${prodFiles.length}`);
});

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`v3.4.1 LINT SUMMARY: ${pass} passed, ${fail} failed`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

if (fail > 0) process.exit(1);
