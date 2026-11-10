# Qimma-1: steps 5-11 (Remotion, 3D)

A 55 s video (1280x720, 30 fps) that shows folding steps 5 to 11 of the Qimma-1 paper plane.
Built with Remotion and `@remotion/three`, following the official Remotion agent skills
(`remotion-create`, `remotion-markup`: 3d.md, arabic-text.md, sequencing.md, `remotion-render`).

## What is exact and what is schematic
- Step 5 (roll the leading edge, then open): fold simulation with the template measures
  (roll mark 3.0 cm, line 4). Line 4 is estimated from the source video.
- Steps 6, 7, 8, 10: simplified schematic of the inner collapse, nose corners, belly and roll
  insert. Not an exact crease pattern. Follow the Unite video 1:25-2:10 for the real folds.
- Step 9 (body fold) and step 11 (open the wings, body 0.9 cm): simulated on the schematic shape.
  The dolphin lock itself is not drawn.

## Files
- `src/fold.ts` - fold geometry (flat layers, hinge rotations, body/wing pose). Units: mm.
- `src/Paper3D.tsx` - Three.js paper mesh, dashed fold lines, frame-driven camera.
- `src/Panel.tsx` - Arabic RTL text panel and cards.
- `src/Scenes.tsx` - one component per step. `src/Composition.tsx` - timeline.

## Run
```
npm i
npx remotion studio                      # preview
npx remotion render Qimma1Steps5to11 out/qimma-1-steps-5-11.mp4 --gl=swangle
```
This cloud environment blocks the Remotion browser download (remotion.media) and has no GPU.
There the render used `--browser-executable=<pre-installed chrome-headless-shell> --gl=swangle`.
On a normal machine leave out `--browser-executable`.
