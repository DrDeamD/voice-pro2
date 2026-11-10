// Paper fold geometry for Qimma-1 (mm, paper in the XY plane, z = up).
// A sheet is a stack of flat convex polygons. A fold rotates every polygon part on
// one side of a hinge line by an angle. All values are pure functions of the input,
// so each video frame is deterministic.

export type P2 = [number, number];
export type P3 = [number, number, number];
export type Layer = {poly: P2[]; z: number; tag?: string};
export type Fold = {a: P2; b: P2; mover: P2; under?: boolean; tag?: string};
export type Face = {pts: P3[]; tag?: string};

export const W = 148;
export const H = 210;
export const CX = 74;
export const FY = 122; // first fold line, 12.2 cm from the bottom
export const ROLL = 30; // roll start mark, 3.0 cm from each side
export const BODY = 9; // body height 0.9 cm
const EPS = 0.45;

const side = (p: P2, a: P2, b: P2) =>
  (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);

export const clip = (poly: P2[], a: P2, b: P2, sign: number): P2[] | null => {
  const out: P2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const sp = side(p, a, b) * sign;
    const sq = side(q, a, b) * sign;
    if (sp >= 0) out.push(p);
    if (sp * sq < 0) {
      const t = sp / (sp - sq);
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
    }
  }
  return out.length > 2 ? out : null;
};

const reflect = (p: P2, a: P2, b: P2): P2 => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
  const fx = a[0] + t * dx;
  const fy = a[1] + t * dy;
  return [2 * fx - p[0], 2 * fy - p[1]];
};

// Rotate a 3D point about the axis through a (z = 0) with direction d.
const rotAxis = (p: P3, a: P2, d: P3, th: number): P3 => {
  const v: P3 = [p[0] - a[0], p[1] - a[1], p[2]];
  const c = Math.cos(th);
  const s = Math.sin(th);
  const dot = d[0] * v[0] + d[1] * v[1] + d[2] * v[2];
  const cr: P3 = [d[1] * v[2] - d[2] * v[1], d[2] * v[0] - d[0] * v[2], d[0] * v[1] - d[1] * v[0]];
  return [
    a[0] + v[0] * c + cr[0] * s + d[0] * dot * (1 - c),
    a[1] + v[1] * c + cr[1] * s + d[1] * dot * (1 - c),
    v[2] * c + cr[2] * s + d[2] * dot * (1 - c),
  ];
};

const zTop = (ls: Layer[]) => Math.max(...ls.map((l) => l.z));
const zBot = (ls: Layer[]) => Math.min(...ls.map((l) => l.z));

type Split = {stay: Layer[]; moves: Layer[][]};

const split = (layers: Layer[], folds: Fold[]): Split => {
  const stay: Layer[] = [];
  const moves: Layer[][] = folds.map(() => []);
  for (const l of layers) {
    let rest: P2[] | null = l.poly;
    folds.forEach((f, i) => {
      if (!rest) return;
      const sg = side(f.mover, f.a, f.b) > 0 ? 1 : -1;
      const m = clip(rest, f.a, f.b, sg);
      if (m) moves[i].push({...l, poly: m});
      rest = clip(rest, f.a, f.b, -sg);
    });
    if (rest) stay.push({...l, poly: rest});
  }
  return {stay, moves};
};

/** 3D faces of the sheet while `folds` are rotated by th (0..PI). */
export const pose = (layers: Layer[], folds: Fold[], th: number): Face[] => {
  const {stay, moves} = split(layers, folds);
  const out: Face[] = stay.map((l) => ({pts: l.poly.map(([x, y]) => [x, y, l.z] as P3), tag: l.tag}));
  const top = zTop(layers);
  const bot = zBot(layers);
  folds.forEach((f, i) => {
    const g = moves[i];
    if (!g.length) return;
    let d: P3 = [f.b[0] - f.a[0], f.b[1] - f.a[1], 0];
    const n = Math.hypot(d[0], d[1]);
    d = [d[0] / n, d[1] / n, 0];
    if (d[0] * (f.mover[1] - f.a[1]) - d[1] * (f.mover[0] - f.a[0]) < 0) d = [-d[0], -d[1], 0];
    const dir = f.under ? -1 : 1;
    const zmax = Math.max(...g.map((l) => l.z));
    const zmin = Math.min(...g.map((l) => l.z));
    for (const l of g) {
      const k = th / Math.PI;
      // At th = PI the rotation maps z to -z, so the lift brings each layer to its committed height.
      const target = f.under ? bot - EPS - (l.z - zmin) : top + EPS + (zmax - l.z);
      const lift = k * (target + l.z);
      out.push({
        pts: l.poly.map(([x, y]) => {
          const r = rotAxis([x, y, l.z], f.a, d, dir * th);
          return [r[0], r[1], r[2] + lift] as P3;
        }),
        tag: f.tag ?? l.tag,
      });
    }
  });
  return out;
};

/** Make the folds permanent (flat, th = PI). */
export const commit = (layers: Layer[], folds: Fold[]): Layer[] => {
  let cur = layers;
  for (const f of folds) {
    const {stay, moves} = split(cur, [f]);
    const g = moves[0];
    if (!g.length) continue;
    const top = zTop(cur);
    const bot = zBot(cur);
    const zmax = Math.max(...g.map((l) => l.z));
    const zmin = Math.min(...g.map((l) => l.z));
    cur = [
      ...stay,
      ...g.map((l) => ({
        ...l,
        poly: l.poly.map((p) => reflect(p, f.a, f.b)),
        tag: f.tag ?? l.tag,
        z: f.under ? bot - EPS - (l.z - zmin) : top + EPS + (zmax - l.z),
      })),
    ];
  }
  return cur;
};

/** Mirror a fold on the centre line. */
export const mirror = (f: Fold): Fold => ({
  a: [2 * CX - f.a[0], f.a[1]],
  b: [2 * CX - f.b[0], f.b[1]],
  mover: [2 * CX - f.mover[0], f.mover[1]],
  under: f.under,
  tag: f.tag,
});

// ---------- fold sequence ----------
export const SHEET: Layer[] = [{poly: [[0, 0], [W, 0], [W, H], [0, H]], z: 0}];
const CORNER: Fold = {a: [CX + 5, H], b: [W, H - 69], mover: [W, H]};
const TOPDOWN: Fold = {a: [0, FY], b: [W, FY], mover: [CX, H]};
export const S4 = commit(SHEET, [CORNER, mirror(CORNER), TOPDOWN]); // after steps 1-4

// Wing crease (line 4) and the roll line (step 5)
export const R4: Fold = {a: [CX + 6, FY], b: [W, FY - 80], mover: [W, FY]};
export const L4 = mirror(R4);
export const RROLL: Fold = {a: [W - ROLL, FY], b: [W, FY - 80], mover: [W, FY]};
export const LROLL = mirror(RROLL);

// Schematic steps 6-8 (simplified, see README)
export const R6: Fold = {...R4, under: true, tag: 'roll'};
export const L6 = mirror(R6);
export const S6 = commit(S4, [R6, L6]);
export const NOSE: Fold = {a: [0, FY - 6], b: [W, FY - 6], mover: [CX, FY], under: true};
export const S7 = commit(S6, [NOSE]);

/**
 * Body and wing pose for steps 9 and 11.
 * phi: body fold (0 = flat, PI/2 = sides vertical). psi: wing opening (0 = wings hang
 * along the body, PI/2 = wings level). The centre line becomes the keel (z < 0).
 */
export const bodyPose = (layers: Layer[], phi: number, psi: number): Face[] => {
  const out: Face[] = [];
  const cut = (poly: P2[], x0: number, x1: number) => {
    let p: P2[] | null = clip(poly, [x0, 0], [x0, 1], -1); // keep x >= x0
    if (p) p = clip(p, [x1, 0], [x1, 1], 1); // keep x <= x1
    return p;
  };
  const map = (x: number, y: number, z: number): P3 => {
    const sx = x >= CX ? 1 : -1;
    const u = Math.abs(x - CX);
    if (u <= BODY) {
      return [CX + sx * u * Math.cos(phi), y, u * Math.sin(phi) + z];
    }
    const bx = BODY * Math.cos(phi);
    const bz = BODY * Math.sin(phi);
    const ang = phi - psi; // wing direction below horizontal
    const w = u - BODY;
    return [CX + sx * (bx + w * Math.cos(ang)), y, bz - w * Math.sin(ang) + z];
  };
  for (const l of layers) {
    for (const [x0, x1] of [
      [-1, CX - BODY],
      [CX - BODY, CX],
      [CX, CX + BODY],
      [CX + BODY, W + 1],
    ] as [number, number][]) {
      const p = cut(l.poly, x0, x1);
      if (p) out.push({pts: p.map(([x, y]) => map(x, y, l.z * 0.6)), tag: l.tag});
    }
  }
  return out;
};
