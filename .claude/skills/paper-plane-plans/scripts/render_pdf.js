#!/usr/bin/env node
// Render plans.html to an A4 PDF at 1:1 and (optionally) PNG previews for the verify step.
// Usage: node render_pdf.js plans.html plans.pdf [--png previewDir] [--expect N]
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

(async () => {
  const [html, pdf] = process.argv.slice(2);
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  if (!html || !pdf) { console.error('Usage: node render_pdf.js plans.html plans.pdf [--png dir] [--expect N]'); process.exit(2); }
  if (!fs.existsSync(html)) { console.error(`ERROR: ${html} not found. Run build_plans.py first.`); process.exit(1); }
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 794, height: 1123 } });
  await page.goto('file://' + path.resolve(html));
  await page.pdf({ path: pdf, format: 'A4', printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  const sections = await page.$$('section.page');
  // 1:1 check: every page box must be 210 x 297 mm (96 dpi -> 793.7 x 1122.5 px)
  for (const [i, s] of sections.entries()) {
    const b = await s.boundingBox();
    if (Math.abs(b.width - 793.7) > 1 || Math.abs(b.height - 1122.5) > 1) { console.error(`FAIL page ${i + 1} size ${b.width}x${b.height}px`); process.exit(1); }
  }
  const png = arg('--png');
  if (png) {
    fs.mkdirSync(png, { recursive: true });
    for (const [i, s] of sections.entries()) await s.screenshot({ path: path.join(png, `p${String(i + 1).padStart(2, '0')}.png`) });
  }
  await browser.close();
  const expect = arg('--expect');
  if (expect && Number(expect) !== sections.length) { console.error(`FAIL pages=${sections.length}, expected ${expect}`); process.exit(1); }
  console.log(`OK ${pdf} pages=${sections.length} size=A4 scale=1:1`);
})().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
