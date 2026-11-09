#!/usr/bin/env python3
"""Render a 3D how-to-fold MP4 for a Unite-geometry plane (default: Qimma-1).

Usage: python3 make_3d_video.py --out qimma-1-3d.mp4 [--plane qimma] [--preview dir]
Needs: numpy, Pillow (with raqm for Arabic), ffmpeg (libx264).
The fold steps 1-5 are a true geometric simulation. Steps 6-10 (inner collapse and lock)
are shown as a text card. The final shape is a simplified model.
"""
import argparse
import json
import math
import os
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
W, H, FPS, SS = 1280, 720, 24, 2
EPS = 0.35
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
BG, FRONT, BACK = (104, 124, 146), np.array([250, 250, 248.0]), np.array([176, 205, 240.0])


def font(sz):
    return ImageFont.truetype(FONT, sz, layout_engine=ImageFont.Layout.RAQM)


def ease(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


# ---------- 2D clipping / folding state ----------
def side(p, a, b):
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])


def clip(poly, a, b, sign):
    out = []
    for i, p in enumerate(poly):
        q = poly[(i + 1) % len(poly)]
        sp, sq = side(p, a, b) * sign, side(q, a, b) * sign
        if sp >= 0:
            out.append(p)
        if sp * sq < 0:
            t = sp / (sp - sq)
            out.append((p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])))
    return out if len(out) > 2 else None


def rot_axis(p, a, d, th):
    v = np.array([p[0] - a[0], p[1] - a[1], p[2]])
    return np.array([a[0], a[1], 0.0]) + v * math.cos(th) + np.cross(d, v) * math.sin(th) + d * d.dot(v) * (1 - math.cos(th))


class Sheet:
    def __init__(self, w, h):
        self.layers = [([(0, 0), (w, 0), (w, h), (0, h)], 0.0)]

    def top(self):
        return max(z for _, z in self.layers)

    def split(self, folds):
        """Return (stay, moves): moves[i] = polygons that rotate about folds[i]."""
        stay, moves = [], [[] for _ in folds]
        for poly, z in self.layers:
            rest = poly
            for i, (a, b, mover) in enumerate(folds):
                if rest is None:
                    break
                sg = 1 if side(mover, a, b) > 0 else -1
                m = clip(rest, a, b, sg)
                if m:
                    moves[i].append((m, z))
                rest = clip(rest, a, b, -sg)
            if rest:
                stay.append((rest, z))
        return stay, moves

    def pose(self, folds, th):
        """3D polygons with the moving parts rotated by th (0..pi)."""
        stay, moves = self.split(folds)
        out = [[np.array([x, y, z]) for x, y in poly] for poly, z in stay]
        ztop = self.top()
        for (a, b, mover), group in zip(folds, moves):
            if not group:
                continue
            d = np.array([b[0] - a[0], b[1] - a[1], 0.0])
            d /= np.linalg.norm(d)
            if d[0] * (mover[1] - a[1]) - d[1] * (mover[0] - a[0]) < 0:
                d = -d
            zmax = max(z for _, z in group)
            for poly, z in group:
                lift = (th / math.pi) * (ztop + EPS + (zmax - z) + z)
                out.append([rot_axis((x, y, z), a, d, th) + np.array([0, 0, lift]) for x, y in poly])
        return out

    def commit(self, folds):
        stay, moves = self.split(folds)
        ztop, new = self.top(), list(stay)
        for f, group in zip(folds, moves):
            if not group:
                continue
            zmax = max(z for _, z in group)
            new += [(self.pose_pts(poly, z, f), ztop + EPS + (zmax - z)) for poly, z in group]
        self.layers = new

    @staticmethod
    def pose_pts(poly, z, f):
        a, b, _ = f
        dx, dy = b[0] - a[0], b[1] - a[1]
        out = []
        for x, y in poly:
            t = ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)
            fx, fy = a[0] + t * dx, a[1] + t * dy
            out.append((2 * fx - x, 2 * fy - y))
        return out


# ---------- camera + drawing ----------
class Cam:
    def __init__(self, az, el, scale, target, center=(430, 370), dist=1100.0):
        self.az, self.el, self.scale, self.target, self.center, self.dist = az, el, scale, np.array(target, float), center, dist

    def proj(self, p):
        v = np.asarray(p, float) - self.target
        ca, sa, ce, se = math.cos(self.az), math.sin(self.az), math.cos(self.el), math.sin(self.el)
        x1, y1 = v[0] * ca - v[1] * sa, v[0] * sa + v[1] * ca
        sy, depth = y1 * se + v[2] * ce, -y1 * ce + v[2] * se
        k = self.scale * self.dist / (self.dist - depth)
        return (self.center[0] + x1 * k, self.center[1] - sy * k, depth)

    def view_dir(self):  # unit vector from scene to camera
        ca, sa, ce, se = math.cos(self.az), math.sin(self.az), math.cos(self.el), math.sin(self.el)
        return np.array([-sa * ce, -ca * ce, se])


def shade(poly, cam, col=None):
    n = np.cross(poly[1] - poly[0], poly[2] - poly[0])
    ln = np.linalg.norm(n)
    n = n / ln if ln else np.array([0, 0, 1.0])
    facing = n.dot(cam.view_dir())
    base = col if col is not None else (FRONT if facing > 0 else BACK)
    light = 0.72 + 0.28 * abs(n.dot(np.array([0.25, -0.35, 0.9])))
    return tuple(int(c * light) for c in np.asarray(base, float))


def render(polys, cam, sort="z", lines=(), dots=(), colors=None):
    """polys: list of lists of 3D points. Returns the supersampled RGB image."""
    img = Image.new("RGB", (W * SS, H * SS), BG)
    d = ImageDraw.Draw(img)
    items = []
    for i, poly in enumerate(polys):
        pr = [cam.proj(p) for p in poly]
        key = np.mean([p[2] for p in poly]) if sort == "z" else np.mean([q[2] for q in pr])
        items.append((key, pr, shade(poly, cam, colors[i] if colors else None)))
    for _, pr, col in sorted(items, key=lambda t: t[0]):
        pts = [(x * SS, y * SS) for x, y, _ in pr]
        d.polygon(pts, fill=col)
        d.line(pts + [pts[0]], fill=(40, 52, 66), width=SS)
    for a, b, col in lines:  # dashed 3D line
        pa, pb = cam.proj(a), cam.proj(b)
        n = max(2, int(math.hypot(pb[0] - pa[0], pb[1] - pa[1]) / 9))
        for i in range(0, n, 2):
            t0, t1 = i / n, min(1, (i + 1) / n)
            d.line([((pa[0] + (pb[0] - pa[0]) * t0) * SS, (pa[1] + (pb[1] - pa[1]) * t0) * SS),
                    ((pa[0] + (pb[0] - pa[0]) * t1) * SS, (pa[1] + (pb[1] - pa[1]) * t1) * SS)], fill=col, width=3 * SS)
    for p, col in dots:
        x, y, _ = cam.proj(p)
        d.ellipse([(x - 6) * SS, (y - 6) * SS, (x + 6) * SS, (y + 6) * SS], fill=col, outline=(255, 255, 255), width=SS)
    return img.resize((W, H), Image.BILINEAR)


def overlay(img, num, title, lines, note=None):
    d = ImageDraw.Draw(img)
    d.rectangle([830, 0, W, H], fill=(28, 36, 48))
    if num:
        d.ellipse([1150, 40, 1230, 120], fill=(242, 194, 0))
        d.text((1190, 80), str(num), font=font(44), fill=(20, 20, 20), anchor="mm")
    d.text((1130 if num else 1240, 80), title, font=font(34), fill=(255, 255, 255), anchor="rm", direction="rtl")
    y = 170
    for ln in lines:
        d.text((1240, y), ln, font=font(27), fill=(235, 240, 246), anchor="ra", direction="rtl")
        y += 46
    if note:
        d.text((1240, 660), note, font=font(19), fill=(160, 175, 190), anchor="ra", direction="rtl")
    d.text((20, 690), "Qimma-1  ·  A5 70 g/m²", font=font(18), fill=(225, 232, 240))
    return img


def card(title, lines, sub=None):
    img = Image.new("RGB", (W, H), (28, 36, 48))
    d = ImageDraw.Draw(img)
    d.text((W / 2, 110), title, font=font(46), fill=(242, 194, 0), anchor="mm", direction="rtl")
    y = 210
    for ln in lines:
        d.text((1160, y), ln, font=font(30), fill=(240, 244, 248), anchor="ra", direction="rtl")
        y += 58
    if sub:
        d.text((W / 2, 660), sub, font=font(22), fill=(160, 175, 190), anchor="mm", direction="rtl")
    return img


# ---------- final simplified model ----------
def plane_model(phi, psi, elev, body=9.0, span=120.0, a=50.0, cr=105.0, wl=4.0):
    """phi: body fold 0..pi/2, psi: winglets, elev: elevator angle. Nose at origin, tail at -y."""
    h = span / 2
    le = lambda u: -a * u / h
    polys, cols = [], []

    def P(sx, u, y, zextra=0.0):
        if u <= body:
            return np.array([sx * u * math.cos(phi), y, (u - body) * math.sin(phi) + zextra])
        x = body * math.cos(phi) + min(u, h - wl) - body
        z = 0.0
        if u > h - wl:
            x += (u - (h - wl)) * math.cos(psi)
            z = (u - (h - wl)) * math.sin(psi)
        return np.array([sx * x, y, z + zextra])

    for sx in (-1, 1):
        quads = [[(0, 0), (body, le(body)), (body, -cr), (0, -cr)],
                 [(body, le(body)), (h - wl, le(h - wl)), (h - wl, -cr), (body, -cr)],
                 [(h - wl, le(h - wl)), (h, le(h)), (h, -cr), (h - wl, -cr)]]
        for q in quads:
            pts = [P(sx, u, y) for u, y in q]
            polys.append(pts[::-1] if sx > 0 else pts)
            cols.append(None)
        ev = [(22, -cr + 9), (46, -cr + 9), (46, -cr), (22, -cr)]  # elevator, hinged at its front edge
        pts = [P(sx, u, y, 0.6 + (-cr + 9 - y) * math.sin(elev)) for u, y in ev]
        polys.append(pts[::-1] if sx > 0 else pts)
        cols.append((150, 150, 150))
        tp = [(12, -42), (20, -42), (20, -46), (12, -46)]            # tape under-wing marker
        pts = [P(sx, u, y, 0.5) for u, y in tp]
        polys.append(pts[::-1] if sx > 0 else pts)
        cols.append((242, 194, 0))
    return polys, cols


def move(polys, off, roll=0.0, pitch=0.0):
    cr, sr, cp, sp = math.cos(roll), math.sin(roll), math.cos(pitch), math.sin(pitch)
    out = []
    for poly in polys:
        q = []
        for p in poly:
            x, y, z = p[0] * cr - p[2] * sr, p[1], p[0] * sr + p[2] * cr
            y, z = y * cp - z * sp, y * sp + z * cp
            q.append(np.array([x, y, z]) + off)
        out.append(q)
    return out


# ---------- timeline ----------
def frames(p):
    Wp, Hp, cx = 148.0, 210.0, 74.0
    fy, roll = float(p.get("fold_y", 122)), float(p.get("roll", 30))
    RED, t = (230, 40, 40), [0]

    def cam():
        t[0] += 1
        return Cam(math.radians(-16 + 7 * math.sin(t[0] / 55)), math.radians(57), 2.55, (cx, 92, 0))

    sh = Sheet(Wp, Hp)
    ttl = card("قمّة-1  ·  Qimma-1", ["كيف تصنعها: فيديو ثلاثي الأبعاد", "الورقة: A5 وزن 70 غ/م²",
                                        "الأدوات: مسطرة، قلم، مقص، شريط لاصق"],
               "نموذج أولي: لم يُختبر بالطيران")
    for _ in range(66):
        yield ttl

    def fold_scene(num, title, text, folds, marks=(), unfold=False, note=None, pre=30, dur=44, post=20):
        z = sh.top() + 0.3
        ln = [((a[0], a[1], z), (b[0], b[1], z), RED) for a, b, _ in folds]
        dt = [((m[0], m[1], z), RED) for m in marks]
        for _ in range(pre):
            yield overlay(render(sh.pose(folds, 0), cam(), lines=ln, dots=dt), num, title, text, note)
        for i in range(dur):
            th = math.pi * ease((i + 1) / dur) * (0.985 if unfold else 1)
            yield overlay(render(sh.pose(folds, th), cam()), num, title, text, note)
        if unfold:
            for i in range(dur * 2 // 3):
                th = math.pi * 0.985 * (1 - ease((i + 1) / (dur * 2 // 3)))
                yield overlay(render(sh.pose(folds, th), cam(), lines=ln), num, title, text, note)
        else:
            for f in folds:
                sh.commit([f])
        for _ in range(post):
            yield overlay(render(sh.pose([], 0), cam(), lines=ln if unfold else ()), num, title, text, note)

    yield from fold_scene(1, "خط المنتصف", ["اطوِ الورقة طولياً", "من المنتصف.", "ثم افتحها."],
                          [((cx, 0), (cx, Hp), (Wp, 100))], unfold=True)
    yield from fold_scene(2, "الزاويتان", ["اطوِ الزاويتين العلويتين", "نحو خط المنتصف.", "الفراغ: 0.5 سم على", "كل جانب من المنتصف."],
                          [((cx + 5, Hp), (Wp, Hp - 69), (Wp, Hp)), ((cx - 5, Hp), (0, Hp - 69), (0, Hp))],
                          marks=[(cx + 5, Hp), (cx - 5, Hp)])
    yield from fold_scene(3, "الطيّة الأولى", ["اطوِ الأعلى إلى الأسفل.", f"الخط: {fy / 10:g} سم", "من الحافة السفلى.", "= وزن في المقدمة"],
                          [((0, fy), (Wp, fy), (cx, Hp))])
    R4 = ((cx - 6, fy), (Wp, fy - 80), (Wp, fy))
    L4 = ((cx + 6, fy), (0, fy - 80), (0, fy))
    n4 = "الخط 4 تقديري من الفيديو"
    yield from fold_scene(4, "ثنية الجناح", ["علّم 0.6 سم تحت", "منتصف الحافة العليا.", "اطوِ الزاوية اليمنى", "عبر العلامة. ثم افتح."],
                          [R4], marks=[(cx, fy - 6)], unfold=True, note=n4, post=8)
    yield from fold_scene(4, "ثنية الجناح", ["كرّر للزاوية اليسرى.", "ثم افتح."], [L4], marks=[(cx, fy - 6)],
                          unfold=True, note=n4, pre=14, post=8)
    yield from fold_scene(5, "لفّ الحافة: 1", [f"علّم {roll / 10:g} سم من كل جانب", "على الحافة العليا.", "اطوِ من العلامة", "إلى طرف الجناح."],
                          [((Wp - roll, fy), (Wp, fy - 80), (Wp, fy)), ((roll, fy), (0, fy - 80), (0, fy))],
                          marks=[(Wp - roll, fy), (roll, fy), (Wp, fy - 80), (0, fy - 80)])
    yield from fold_scene(5, "لفّ الحافة: 2", ["اطوِ مرة ثانية", "على الخط 4.", "= حافة جناح صلبة"], [R4], note=n4, pre=22, post=6)
    yield from fold_scene(5, "لفّ الحافة: 2", ["كرّر لليسار.", "ثم افتح كل اللفّ."], [L4], note=n4, pre=12, post=30)

    c2 = card("الخطوات 6 إلى 10: الطيّ الداخلي والقفل",
              ["6. اطوِ الوسط للأسفل. اطوِ على ثنيتي الجناحين.", "7. أعد طيّ الزاويتين الوسطيتين. قُصّ الزائد.",
               "8. اطوِ البطن للأعلى على خط العمود.", "9. اطوِ الجسم من المنتصف. اسحب جيب المقدمة = قفل الدلفين.",
               "10. أدخل لفّة الجناحين في الجيب. اجعلها مسطحة."],
              "هذه الخطوات غير محاكاة هنا. تابعها في فيديو Unite من 1:25 إلى 2:10")
    for _ in range(190):
        yield c2

    def model_scene(num, title, text, n, f, note="الشكل النهائي: نموذج مبسّط"):
        for i in range(n):
            s = (i + 1) / n
            phi, psi, el, az = f(s)
            polys, cols = plane_model(phi, psi, el, body=10 * p.get("body_cm", 0.9))
            c = Cam(math.radians(az), math.radians(28), 4.3, (0, -55, -2), center=(415, 360))
            yield overlay(render(polys, c, sort="depth", colors=cols), num, title, text, note)

    hp = math.pi / 2
    yield from model_scene(11, "الجسم والجناحان", ["اطوِ الجسم من المنتصف.", "افتح الجناحين", "على ارتفاع 0.9 سم", "من القفل إلى الذيل."],
                           110, lambda s: (hp * ease(s * 1.25), 0, 0, 25 + 20 * s))
    yield from model_scene(12, "اللصق", ["ألصق 5 نقاط:", "تحت الجناحين، المقبض،", "المقدمة، القناة، الذيل.", "المجموع لا يتجاوز", "3 × 2.5 سم"],
                           80, lambda s: (hp, 0, 0, 45 + 150 * ease(s)))
    yield from model_scene(13, "الجنيحان والرافع", ["ارفع جنيحاً 0.4 سم", "عند كل طرف.", "ارفع الرافع قليلاً", "حتى الانزلاق الثابت."],
                           110, lambda s: (hp, math.radians(85) * ease(s * 1.6), math.radians(18) * ease(s * 1.6 - 0.6), 195 - 150 * ease(s)))
    for i in range(130):  # glide
        s = i / 129
        polys, cols = plane_model(hp, math.radians(85), math.radians(18), body=10 * p.get("body_cm", 0.9))
        polys = move(polys, np.array([0, -230 + 460 * s, 55 - 90 * s]), roll=0.06 * math.sin(s * 9), pitch=-0.08)
        c = Cam(math.radians(-62), math.radians(16), 3.0, (0, 0, 0), center=(415, 330))
        yield overlay(render(polys, c, sort="depth", colors=cols), None, "الطيران", ["ارمِ للأعلى بقوة.", "ثم تنزلق ببطء.",
                      "زمن التحليق ≈", "الارتفاع ÷ سرعة الهبوط"], "رسم توضيحي، ليس قياساً")
    end = card("الاختبار", ["ارمِ 5 مرات. سجّل المتوسط والأسوأ.", "قارن مع Unite الأصلية.", "غيّر شيئاً واحداً كل مرة.",
                            "أبقِ التغيير إذا ارتفع المتوسط ولم ينزل الأسوأ."], "القالب 1:1 في ملف paper-plane-plans.pdf")
    for _ in range(110):
        yield end


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(HERE, "..", "references", "planes.json"))
    ap.add_argument("--plane", default="qimma")
    ap.add_argument("--out", default="qimma-1-3d.mp4")
    ap.add_argument("--preview", help="folder for one PNG every 2 seconds")
    a = ap.parse_args()
    try:
        cfg = json.load(open(a.config, encoding="utf-8"))
        p = next(x for x in cfg["planes"] if x["id"] == a.plane)
    except (OSError, ValueError, StopIteration) as e:
        sys.exit(f"ERROR: plane '{a.plane}' not readable from {a.config}: {e}")
    if p["geometry"] != "unite":
        sys.exit("ERROR: only planes with geometry 'unite' are supported.")
    if a.preview:
        os.makedirs(a.preview, exist_ok=True)
    ff = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
                           "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20",
                           "-movflags", "+faststart", a.out], stdin=subprocess.PIPE)
    n = 0
    for img in frames(p):
        ff.stdin.write(img.tobytes())
        if a.preview and n % (FPS * 2) == FPS:
            img.save(os.path.join(a.preview, f"f{n:05d}.png"))
        n += 1
    ff.stdin.close()
    if ff.wait() != 0:
        sys.exit("ERROR: ffmpeg failed.")
    print(f"OK {a.out} frames={n} seconds={n / FPS:.1f} size={W}x{H}")


if __name__ == "__main__":
    main()
