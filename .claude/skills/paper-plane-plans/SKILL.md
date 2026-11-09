---
name: paper-plane-plans
description: Turn paper-airplane tutorial videos into printable A4 plans (step diagrams + 1:1 fold templates), plus a merged design and a new design of the same family. Use for "make plans from this plane video", "printable paper plane template", "مخطط طائرة ورقية للطباعة", "استخرج رسوم الطائرات من الفيديو".
---

# Paper Plane Plans

## Goal
Produce one A4 PDF: per plane a steps page and a 1:1 template page, in the user's language.

## Inputs
- Videos of folding tutorials. Example: `daybreak.mp4`.
- Paper size the user prints on. Example: `A4`.
- Assumptions: output language = user's language; the videos carry measurements in subtitles; no flight test is possible here.

## Process
1. Test on one video first. Extract frames: `ffmpeg -ss <start> -i v.mp4 -vf "fps=1/3,scale=640:-1,tile=3x3" out_%02d.jpg`. Read every sheet.
2. Write per step: time, action, each number in the subtitle. Crop at full size (`crop=640:480:320:120`) when a fold is unclear.
3. Mark every value that is measured from frames, not stated, as `approx`.
4. Add the plane to `references/planes.json`. Reuse geometry `fold-up` when the plane follows fold-in-half, fold-up, diagonal creases. Else add a `geo_<name>` function in `scripts/build_plans.py`.
5. Merged plane: take one clear feature from each source plane. New plane: change paper size or one ratio of an existing sequence. Label both "prototype: not flight-tested".
6. Build, then verify. Run the other videos only after the first plane passes.

## Verify
Run the two scripts, then read every PNG in the preview folder. Pass = all yes:
- Page count = 2 x planes + 2, each page 210 x 297 mm (script prints `OK`).
- Each template has the 100 mm test ruler and numbered fold lines.
- No label is on top of another label or a fold line crossing point.
- Each step is one action, max 20 words, with its number from the video.
- Every estimated value shows "تقديري" / "approx".
Fix and rebuild. After 3 failed tries stop and report what fails.

## Scripts
- `python3 scripts/build_plans.py --out plans.html` - builds the HTML from `references/planes.json`.
- `node scripts/render_pdf.js plans.html plans.pdf --png preview --expect <pages>` - renders the PDF, checks page count and size, writes previews.

## Output
`paper-planes/paper-plane-plans.pdf` and `.html`. Tell the user: print at 100 %, measure the 100 mm ruler.

## Known issues
When a step fails, fix it, finish the task, then add one line here: problem -> fix.
- A relative `rm` after `cd` is blocked by the safety check -> write new frames to a new folder instead.
- SVG `text-anchor` start/end flips in RTL text -> use `middle` only and move the x position.
- A list item with `list-style: none` still takes a number -> put lead text in a `<p>` before the `<ol>`.
- A5 templates fill the whole A4 page -> draw the test ruler inside the template tail area, not on the page.
