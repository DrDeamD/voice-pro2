#!/usr/bin/env python3
"""Build printable A4 paper-plane plans (HTML) from references/planes.json.

Usage: python3 build_plans.py [--config planes.json] [--out plans.html]
Then:  node render_pdf.js plans.html plans.pdf
All drawing units are millimetres. Template pages print at 1:1 (100 %).
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
A4W, A4H = 210.0, 297.0


# ---------- fold simulator (flat-folded layers = list of polygons) ----------
def _side(p, a, b):
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])


def _clip(poly, a, b, sign):
    out = []
    for i, p in enumerate(poly):
        q = poly[(i + 1) % len(poly)]
        sp, sq = _side(p, a, b) * sign, _side(q, a, b) * sign
        if sp >= 0:
            out.append(p)
        if sp * sq < 0:
            t = sp / (sp - sq)
            out.append((p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])))
    return out


def _reflect(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)
    fx, fy = a[0] + t * dx, a[1] + t * dy
    return (2 * fx - p[0], 2 * fy - p[1])


def fold(layers, a, b, mover):
    """Fold all layers on line a-b. The side that holds `mover` is reflected."""
    sign = 1 if _side(mover, a, b) > 0 else -1
    out = []
    for poly in layers:
        stay, move = _clip(poly, a, b, -sign), _clip(poly, a, b, sign)
        if len(stay) > 2:
            out.append(stay)
        if len(move) > 2:
            out.append([_reflect(p, a, b) for p in move])
    return out


# ---------- small SVG helpers ----------
def line(a, b, cls):
    return f'<line x1="{a[0]:.2f}" y1="{a[1]:.2f}" x2="{b[0]:.2f}" y2="{b[1]:.2f}" class="{cls}"/>'


def badge(x, y, n, r=3.2):
    return (f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{r}" class="badge"/>'
            f'<text x="{x:.2f}" y="{y + r * 0.38:.2f}" class="badge-t" font-size="{r * 1.25}">{n}</text>')


def text(x, y, s, size=3.2, cls="lbl", anchor="middle"):
    return (f'<text x="{x:.2f}" y="{y:.2f}" font-size="{size}" class="{cls}" '
            f'text-anchor="{anchor}" direction="rtl">{s}</text>')


def mini(layers, lines=(), marks=(), fold_top=None, k=0.22, caption=""):
    """Scaled step diagram. Input is paper space (y up). fold_top: y that is drawn at the top."""
    pts = [p for poly in layers for p in poly]
    x0, x1 = min(p[0] for p in pts), max(p[0] for p in pts)
    y0, y1 = min(p[1] for p in pts), max(p[1] for p in pts)
    ty = (lambda y: y - y0) if fold_top is not None else (lambda y: y1 - y)
    T = lambda p: (p[0] - x0, ty(p[1]))
    body = ""
    for poly in layers:
        body += '<polygon points="%s" class="paper"/>' % " ".join("%.2f,%.2f" % T(p) for p in poly)
    for a, b, cls in lines:
        body += line(T(a), T(b), cls)
    for m in marks:
        x, y = T(m)
        body += f'<circle cx="{x:.2f}" cy="{y:.2f}" r="2.2" class="mark"/>'
    w, h, pad = x1 - x0, y1 - y0, 3
    svg = (f'<svg class="mini" width="{(w + 2 * pad) * k:.1f}mm" height="{(h + 2 * pad) * k:.1f}mm" '
           f'viewBox="{-pad} {-pad} {w + 2 * pad} {h + 2 * pad}">{body}</svg>')
    return f'<figure>{svg}<figcaption>{caption}</figcaption></figure>'


PLANFORM = {  # schematic top view: span, leading-edge drop, root chord (mm)
    "daybreak": (118, 46, 110), "unite": (115, 50, 105), "haotian": (180, 78, 140),
    "trio": (180, 64, 140), "nasma": (127, 53, 98), "qimma": (120, 50, 105),
}


def planform(pid, k=0.22):
    s, a, cr = PLANFORM[pid]
    h = s / 2
    pts = [(0, 0), (h, a), (h, cr), (-h, cr), (-h, a)]
    b = '<polygon points="%s" class="paper"/>' % " ".join("%.1f,%.1f" % p for p in pts)
    b += line((0, 0), (0, cr), "center")
    for sx in (-1, 1):  # winglets, elevators, tape
        b += line((sx * (h - 5), a + 3), (sx * (h - 5), cr), "valley")
        b += f'<rect x="{sx * h * 0.55 - 9:.1f}" y="{cr - 5}" width="18" height="5" class="elev"/>'
        b += f'<rect x="{sx * 12 - 4:.1f}" y="{cr * 0.45:.1f}" width="8" height="3" class="tape"/>'
    b += f'<rect x="-4" y="6" width="8" height="3" class="tape"/><rect x="-4" y="{cr - 9}" width="8" height="3" class="tape"/>'
    b += text(0, -4, "مقدمة", 8) + text(0, cr + 10, "ذيل", 8)
    pad = 16
    svg = (f'<svg class="mini" width="{(s + 2 * pad) * k:.1f}mm" height="{(cr + 2 * pad) * k:.1f}mm" '
           f'viewBox="{-h - pad} {-pad} {s + 2 * pad} {cr + 2 * pad}">{b}</svg>')
    return (f'<figure>{svg}<figcaption>الشكل النهائي (تخطيطي). أصفر = لصق. رمادي = رافع. '
            f'متقطّع = جنيح.</figcaption></figure>')


# ---------- geometry per plane: template lines (paper space, y up) + step diagrams ----------
def geo_fold_up(p):
    W, H, cx = p["W"], p["H"], p["W"] / 2
    F = H / 2 - p["fold_below_mid"]            # fold line; flap = part below it
    lock, s = p["lock"], H / 2 - p["fold_below_mid"] - p["tip_chord"]
    slope = (s - lock) / cx                    # diagonal runs through the lock mark
    xe = lock / slope                          # extension to the folded edge
    tl = [((cx, 0), (cx, H), "center", 1, (cx, H - 14)),
          ((0, F), (W, F), "valley", 2, (W * 0.2, F))]
    for sx in (-1, 1):
        for sy in (-1, 1):                     # upper layer and flap (mirror)
            tl.append(((cx - sx * xe, F), (cx + sx * cx, F + sy * s), "valley", 3,
                       (cx + sx * cx * 0.6, F + sy * (lock + slope * cx * 0.6))))
    marks = [(cx, F + lock), (cx, F - lock), (cx, H / 2)] + \
            [(x, F + sy * s) for x in (0, W) for sy in (-1, 1)]
    notes = [(W * 0.74, F + 3, "الحافة المطوية = المقدمة"), (cx, H - 5, "الذيل (رافع)"),
             (cx, F - F * 0.80, "② اطوِ هذا الجزء إلى الأعلى"),
             (W - 30, F - s - 6, f"علامة الجانب: {p['tip_chord'] / 10:g} سم من الحافة السفلى"),
             (cx + 24, F - lock - 1, "علامة القفل")]
    sheet = [[(0, 0), (W, 0), (W, H), (0, H)]]
    st = fold(sheet, (0, F), (W, F), (cx, 0))
    dia = [((cx - sx * xe, F), (cx + sx * cx, F + s), "valley") for sx in (-1, 1)]
    st2 = st
    for sx in (-1, 1):
        st2 = fold(st2, (cx - sx * xe, F), (cx + sx * cx, F + s), (cx + sx * cx, F))
    figs = [mini(sheet, [(l[0], l[1], l[2]) for l in tl[:2]], [(cx, H / 2)],
                 caption=f"① المنتصف. ② خط الطيّ على {F / 10:g} سم من الأسفل."),
            mini(st, dia, [(cx, F + lock)], fold_top=F,
                 caption=f"③ من علامة القفل إلى علامة الجانب (وتر {p['tip_chord'] / 10:g} سم)."),
            mini(st2, [], [], fold_top=F, caption="بعد طيّ الزاويتين = بداية لفّ الجناح.")]
    return tl, marks, notes, figs, []


def geo_unite(p):
    W, H, cx = 148.0, 210.0, 74.0
    fy, roll = p.get("fold_y", 122), p.get("roll", 33)   # first fold height, roll start mark
    tl = [((cx, 0), (cx, H), "center", 1, (cx, 20))]
    for sx in (-1, 1):
        tl.append(((cx + sx * 5, H), (cx + sx * cx, H - 69), "valley", 2, (cx + sx * 45, H - 40)))
    tl.append(((0, fy), (W, fy), "valley", 3, (W * 0.12, fy)))
    for sx in (-1, 1):
        tl.append(((cx - sx * 6, fy), (cx + sx * cx, fy - 80), "approx", 4, (cx + sx * 50, fy - 56)))
    marks = [(cx, fy - 6), (roll, fy), (W - roll, fy)]
    notes = [(cx, fy + 4, f"{fy / 10:g} سم من الأسفل"), (cx + 26, fy - 9, "علامة 0.6 سم تحت الحافة"),
             (cx, 26, "④ = تقديري من الفيديو"), (cx, fy + 13, f"علامتا {roll / 10:g} سم: بداية خط اللفّ ⑤")]
    sheet = [[(0, 0), (W, 0), (W, H), (0, H)]]
    s1 = sheet
    for sx in (-1, 1):
        s1 = fold(s1, (cx + sx * 5, H), (cx + sx * cx, H - 69), (cx + sx * cx, H))
    s2 = fold(s1, (0, fy), (W, fy), (cx, H))
    s3 = s2
    for sx in (-1, 1):
        s3 = fold(s3, (cx - sx * 6, fy), (cx + sx * cx, fy - 80), (cx + sx * cx, fy))
    figs = [mini(sheet, [(l[0], l[1], l[2]) for l in tl[:4]],
                 caption=f"①② الزاويتان، فراغ 0.5 + 0.5 سم. ③ خط {fy / 10:g} سم."),
            mini(s1, [((0, fy), (W, fy), "valley")], caption="بعد ②. اطوِ الأعلى للأسفل على ③."),
            mini(s2, [(l[0], l[1], l[2]) for l in tl[4:6]], [(cx, fy - 6), (roll, fy), (W - roll, fy)],
                 caption=f"④ الزاويتان نحو المنتصف (تقديري). علامتا اللفّ {roll / 10:g} سم."),
            mini(s3, [], caption="بعد ④. ثم اللفّ والقفل: انظر الخطوات.")]
    return tl, marks, notes, figs, []


def geo_daybreak(p):
    W, H, cx, fy = 148.0, 192.0, 74.0, 119.0
    tl = [((cx, 0), (cx, H), "center", 2, (cx, 20))]
    for sx in (-1, 1):
        tl.append(((cx + sx * 2, H), (cx + sx * cx, H - 72), "valley", 3, (cx + sx * 45, H - 43)))
    tl.append(((0, fy), (W, fy), "approx", 4, (W * 0.12, fy)))
    for sx in (-1, 1):
        tl.append(((cx + sx * 6, fy), (cx + sx * cx, 63), "valley", 5, (cx + sx * 45, 87)))
    marks = [(30, fy), (W - 30, fy), (0, 63), (W, 63)]
    notes = [(cx, fy + 4, "④ ≈ 11.9 سم من الأسفل (تقديري)"), (W - 12, 55, "6.3 سم"),
             (cx, fy - 6, "0.6 سم"), (30, fy - 5, "3 سم"), (W - 30, fy - 5, "3 سم")]
    sheet = [[(0, 0), (W, 0), (W, H), (0, H)]]
    s1 = sheet
    for sx in (-1, 1):
        s1 = fold(s1, (cx + sx * 2, H), (cx + sx * cx, H - 72), (cx + sx * cx, H))
    s2 = fold(s1, (0, fy), (W, fy), (cx, H))
    s3 = s2
    for sx in (-1, 1):
        s3 = fold(s3, (cx + sx * 6, fy), (cx + sx * cx, 63), (cx + sx * cx, fy))
    figs = [mini(sheet, [(l[0], l[1], l[2]) for l in tl[:3]], caption="②③ الزاويتان نحو المنتصف."),
            mini(s1, [((0, fy), (W, fy), "approx")], caption="④ اطوِ الرأس للأسفل."),
            mini(s2, [(l[0], l[1], l[2]) for l in tl[4:6]], [(0, 63), (W, 63)], caption="⑤ من 0.6 سم إلى 6.3 سم."),
            mini(s3, [], caption="بعد ⑤. ثم القصّ واللفّ: انظر الخطوات.")]
    return tl, marks, notes, figs, []


GEO = {"fold-up": geo_fold_up, "unite": geo_unite, "daybreak": geo_daybreak}


# ---------- pages ----------
def template_group(p, tl, marks, notes):
    """1:1 template in local coords (y down, origin = top-left of the sheet)."""
    W, H = p["W"], p["H"]
    T = lambda q: (q[0], H - q[1])
    g = f'<rect x="0" y="0" width="{W}" height="{H}" class="outline"/>'
    for a, b, cls, n, bp in tl:
        g += line(T(a), T(b), cls)
    for a, b, cls, n, bp in tl:
        g += badge(*T(bp), n)
    for m in marks:
        x, y = T(m)
        g += f'<circle cx="{x:.2f}" cy="{y:.2f}" r="1.1" class="mark"/>'
    for n in notes:
        x, y = T((n[0], n[1]))
        g += text(x, y, n[2], 3.0, "lbl")
    rx = W / 2 - 50
    g += line((rx, H - 9), (rx + 100, H - 9), "ruler") + "".join(
        line((rx + i * 10, H - 10.5), (rx + i * 10, H - 7.5), "ruler") for i in range(11))
    g += text(W / 2, H - 11.5, "اختبار المقياس: هذا الخط = 100 mm", 2.6)
    g += text(W / 2, H - 3, f'{p["name"]} · {W:g} × {H:g} mm · 100%', 2.6, "lbl ltr")
    return g


def page_template(p, tl, marks, notes):
    g = template_group(p, tl, marks, notes)
    if p["W"] > 150:   # full A4 sheet
        body = g
    else:              # two sheets per A4, rotated; cut on the red lines
        body = (f'<g transform="translate(0,{p["W"]:.2f}) rotate(-90)">{g}</g>'
                f'<g transform="translate(0,{A4H:.2f}) rotate(-90)">{g}</g>'
                + line((0, A4H / 2), (A4W, A4H / 2), "cut") + text(A4W - 8, A4H / 2 - 1.5, "قصّ", 3))
        if p["H"] < A4W - 1:
            body += line((p["H"], 0), (p["H"], A4H), "cut") + text(p["H"] + 6, 12, "قصّ", 3)
    return (f'<section class="page tpl"><svg width="210mm" height="297mm" viewBox="0 0 210 297">'
            f'{body}</svg></section>')


def page_steps(p, figs, idx, total_note):
    tag = "من الفيديو" if p["family"] == "video" else "تصميم جديد · نموذج أولي"
    video = p["family"] == "video"
    lead = "".join(f'<p class="lead">{s}</p>' for t, s in p["steps"] if not t)
    steps = "".join((f'<li><b class="t">{t}</b> {s}</li>' if video else f'<li>{s}</li>')
                    for t, s in p["steps"] if t)
    feats = "".join(f"<li>{f}</li>" for f in p["features"])
    extra = ""
    for title, rows in p.get("tables", []):
        extra += f"<h2>{title}</h2><table>" + "".join(
            "<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows) + "</table>"
    legend = ('<p class="legend"><span class="k center"></span> خط المنتصف '
              '<span class="k valley"></span> خط طيّ <span class="k approx"></span> خط تقديري '
              '<span class="k cut"></span> قصّ <span class="dot"></span> علامة</p>')
    return f'''<section class="page">
<header><span class="tag">{tag}</span><h1>{idx}. {p["ar"]} <small>{p["name"]}</small></h1></header>
<p class="facts"><b>الورقة:</b> {p["paper"]}<br><b>الهدف:</b> {p["goal"]}</p>
<div class="figs">{"".join(figs)}{planform(p["id"])}</div>{legend}
<div class="cols"><div class="main"><h2>الخطوات <small>{total_note}</small></h2>{lead}<ol class="steps">{steps}</ol></div>
<div class="side"><h2>المزايا</h2><ul>{feats}</ul>
{extra}<h2>الطباعة</h2><ul><li>اطبع صفحة القالب التالية بحجم 100% (بلا "ملاءمة للصفحة").</li>
<li>قِس خط الاختبار: 100 mm.</li><li>اطوِ والخطوط إلى الداخل أو الخارج: لا فرق.</li></ul></div></div>
</section>'''


def page_overview(planes):
    rows = "".join(
        f'<tr><td><b>{p["ar"]}</b><br><span class="ltr">{p["name"]}</span></td><td>{p["paper"]}</td>'
        f'<td>{p["goal"]}</td><td>{"<br>".join(p["features"][:3])}</td></tr>' for p in planes)
    flow = ["ورقة", "طيّ المقدمة<br><small>وزن أمامي</small>", "ثنيات قطرية<br><small>حافة الجناح</small>",
            "لفّ الحافة<br><small>صلابة</small>", "قفل الدلفين<br><small>يثبّت الطبقات</small>",
            "جسم 1 سم<br><small>مقاومة أقل</small>", "جنيحات + رافع<br><small>اتزان</small>"]
    flow_html = '<span class="arr">←</span>'.join(f'<span class="box">{f}</span>' for f in flow)
    merge = ('<svg width="170mm" height="52mm" viewBox="0 0 170 52">'
             + "".join(f'<rect x="118" y="{2 + i * 17}" width="50" height="13" rx="2" class="bx"/>'
                       + text(143, 8 + i * 17, n, 3.6, "lbl b") + text(143, 12.6 + i * 17, d, 2.9)
                       + line((118, 8.5 + i * 17), (96, 25.5), "arrow")
                       for i, (n, d) in enumerate([("Daybreak", "لفّ مزدوج · وتر طرف كبير"),
                                                    ("Unite", "جسم منخفض · جنيحات · 5 لصقات"),
                                                    ("Haotian-1", "A4 · بلا مقص · تسلسل الطيّ")]))
             + '<rect x="56" y="17" width="40" height="17" rx="2" class="bx hi"/>'
             + text(76, 24, "ثلاثي-1", 4.2, "lbl b") + text(76, 30, "الطائرة المدمجة · A4", 2.9)
             + line((56, 25.5), (42, 25.5), "arrow")
             + '<rect x="2" y="17" width="40" height="17" rx="2" class="bx hi"/>'
             + text(22, 24, "نسمة-1", 4.2, "lbl b") + text(22, 30, "نفس العائلة · A5 × 2", 2.9)
             + '</svg>')
    return f'''<section class="page">
<header><h1>طائرات ورقية للترفيه <small>مخططات للطباعة على A4</small></h1></header>
<p class="facts">3 طائرات من الفيديوهات + طائرة مدمجة + طائرة جديدة + طائرة مرشّحة للرقم القياسي. كل طائرة = صفحة خطوات + صفحة قالب 1:1.</p>
<h2>1. آلية العائلة: كل الطائرات تتبع هذا المسار</h2><div class="flow">{flow_html}</div>
<h2>2. الطائرات</h2>
<table><tr><th>الطائرة</th><th>الورقة</th><th>الهدف</th><th>أهم المزايا</th></tr>{rows}</table>
<h2>3. الدمج: ماذا أُخذ من كل طائرة</h2>{merge}
<h2>4. ما يعنيه هذا لك</h2><ul>
<li>ابدأ بـ <span class="ltr">Haotian-1</span>: A4، بلا مقص، أسهل قفل.</li>
<li>الأرقام بالسنتيمتر من ترجمة الفيديو. كلمة "تقديري" = قياس من الصورة.</li>
<li>ثلاثي-1 ونسمة-1 وقمّة-1 نماذج أولية. اختبرها بصفحة الاختبار الأخيرة.</li></ul>
<p class="src">المصدر: 3 فيديوهات تعليمية لقناة 纸飞君 (bilibili). التصاميم الأصلية ملك لأصحابها.</p>
</section>'''


def page_test(planes):
    fixes = [("يغطس إلى الأسفل", "ارفع الرافع 1 مم."), ("يرتفع ثم يسقط", "أنزل الرافع 1 مم. ارمِ أبطأ."),
             ("ينحرف يميناً", "ارفع رافع الجهة اليمنى 1 مم، أو اثنِ الجنيح الأيسر أقل."),
             ("ينحرف يساراً", "اعكس الحل السابق."), ("يتأرجح يميناً ويساراً", "ارفع طرفي الجناحين قليلاً (شكل V خفيف)."),
             ("الطبقات تنفتح", "أضف لصقة عند المقدمة والمقبض.")]
    fx = "".join(f"<tr><td>{a}</td><td>{b}</td></tr>" for a, b in fixes)
    log = "".join("<tr>" + "<td>&nbsp;</td>" * 8 + "</tr>" for _ in range(12))
    return f'''<section class="page">
<header><h1>الاختبار والضبط <small>اصنع ← ارمِ ← قِس ← أصلح ← كرّر</small></h1></header>
<p class="facts">رمية واحدة جيدة = حظ. ارمِ 5 مرات. سجّل المتوسط والأسوأ. غيّر شيئاً واحداً فقط كل مرة.</p>
<div class="flow"><span class="box">اصنع</span><span class="arr">←</span><span class="box">5 رميات</span>
<span class="arr">←</span><span class="box">سجّل الزمن</span><span class="arr">←</span>
<span class="box">تغيير واحد</span><span class="arr">←</span><span class="box">أبقِ التغيير إذا ارتفع المتوسط ولم ينزل الأسوأ</span></div>
<h2>المشكلة ← الحل</h2><table class="fix"><tr><th>ما تراه</th><th>ما تفعله</th></tr>{fx}</table>
<h2>سجل الطيران (الزمن بالثواني أو المسافة بالمتر)</h2>
<table class="log"><tr><th>الطائرة</th><th>التغيير</th><th>1</th><th>2</th><th>3</th><th>4</th><th>5</th><th>المتوسط / الأسوأ</th></tr>{log}</table>
<p class="src">أمان: ارمِ في مكان مفتوح، بعيداً عن الوجوه. المقص للكبار أو بإشراف.</p>
</section>'''


CSS = '''
@page { size: A4; margin: 0 }
* { box-sizing: border-box }
body { margin: 0; font-family: "DejaVu Sans", sans-serif; font-size: 10.5pt; color: #111; direction: rtl }
.page { width: 210mm; height: 297mm; padding: 11mm 12mm; position: relative; overflow: hidden; page-break-after: always }
.page.tpl { padding: 0 } .page.tpl svg { display: block }
h1 { font-size: 17pt; margin: 0 0 2mm } h1 small { font-size: 10pt; color: #555; font-weight: normal }
h2 { font-size: 11pt; margin: 4mm 0 1.5mm; border-bottom: 0.3mm solid #999; padding-bottom: 0.5mm }
h2 small { font-size: 7.5pt; color: #666; font-weight: normal }
.tag { float: left; font-size: 8pt; border: 0.3mm solid #333; border-radius: 2mm; padding: 0.5mm 2mm }
.facts { margin: 1mm 0 2mm; line-height: 1.6 } .ltr { direction: ltr; unicode-bidi: embed }
.figs { display: flex; gap: 3mm; align-items: flex-end; justify-content: space-between; margin: 2mm 0 }
figure { margin: 0; text-align: center; flex: 1 } figcaption { font-size: 7.3pt; color: #333; margin-top: 1mm; line-height: 1.35 }
.cols { display: flex; gap: 6mm } .cols > .main { flex: 1.5 } .side table { font-size: 7.6pt } .side { flex: 1 }
ol.steps { margin: 0; padding-right: 7mm; line-height: 1.6; font-size: 11pt } ol.steps li { margin-bottom: 0.8mm }
p.lead { font-weight: bold; margin: 1mm 0 }
b.t { font-size: 7.5pt; color: #fff; background: #444; border-radius: 1mm; padding: 0 1mm; direction: ltr; unicode-bidi: embed }
ul { margin: 0; padding-right: 5mm; line-height: 1.6 }
table { border-collapse: collapse; width: 100%; font-size: 8.3pt } td, th { border: 0.25mm solid #777; padding: 1mm 1.5mm; vertical-align: top }
th { background: #eee } table.log td { height: 8.2mm } table.fix td:first-child { width: 32% ; font-weight: bold }
.flow { display: flex; align-items: center; gap: 1mm; flex-wrap: wrap; margin: 2mm 0 }
.box { border: 0.35mm solid #222; border-radius: 1.5mm; padding: 1mm 1.6mm; text-align: center; font-size: 8.3pt; line-height: 1.3 }
.box small { color: #555; font-size: 7pt } .arr { font-size: 12pt }
.src { font-size: 7.5pt; color: #555; margin-top: 3mm }
.legend { font-size: 7.5pt; color: #333; margin: 1mm 0 }
.k { display: inline-block; width: 9mm; height: 0; vertical-align: middle; margin: 0 1mm 0 0.5mm; border-top: 0.4mm dashed #000 }
.k.center { border-top: 0.3mm dotted #666 } .k.approx { border-top: 0.4mm dashed #c60 } .k.cut { border-top: 0.4mm solid #c00 }
.dot { display: inline-block; width: 2mm; height: 2mm; border-radius: 50%; background: #c00; vertical-align: middle }
svg text { font-family: "DejaVu Sans", sans-serif } .lbl { fill: #444 } .lbl.b { font-weight: bold; fill: #111 }
.paper { fill: #cfe0f5; fill-opacity: .55; stroke: #123; stroke-width: 1 }
svg.mini .valley { stroke-width: 1.6; stroke-dasharray: 6 3 } svg.mini .approx { stroke-width: 1.6; stroke-dasharray: 6 3 }
svg.mini .center { stroke-width: 1; stroke-dasharray: 2 3 } svg.mini .mark { r: 3 }
.valley { stroke: #000; stroke-width: .3; stroke-dasharray: 3 1.5; fill: none }
.approx { stroke: #c60; stroke-width: .3; stroke-dasharray: 3 1.5; fill: none }
.center { stroke: #666; stroke-width: .25; stroke-dasharray: .8 1.6; fill: none }
.cut { stroke: #c00; stroke-width: .3 } .outline { fill: none; stroke: #bbb; stroke-width: .2 }
.ruler { stroke: #000; stroke-width: .25 } .mark { fill: #c00 }
.badge { fill: #fff; stroke: #000; stroke-width: .3 } .badge-t { text-anchor: middle; font-weight: bold; fill: #000 }
.tape { fill: #f2c200 } .elev { fill: #999 } .bx { fill: #fff; stroke: #222; stroke-width: .35 } .bx.hi { fill: #e7f0fb }
.arrow { stroke: #222; stroke-width: .4 }
'''


def build(cfg):
    planes = cfg["planes"]
    pages = [page_overview(planes)]
    for i, p in enumerate(planes, 1):
        tl, marks, notes, figs, _ = GEO[p["geometry"]](p)
        note = "(الأرقام = وقت الفيديو ±3 ث)" if p["family"] == "video" else "(الخطوات الأولى = الخطوط المرقّمة في القالب)"
        pages.append(page_steps(p, figs, i, note))
        pages.append(page_template(p, tl, marks, notes))
    pages.append(page_test(planes))
    return ('<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>Paper plane plans</title>'
            f'<style>{CSS}</style><body>{"".join(pages)}</body></html>'), len(pages)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(HERE, "..", "references", "planes.json"))
    ap.add_argument("--out", default="plans.html")
    a = ap.parse_args()
    try:
        with open(a.config, encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, ValueError) as e:
        sys.exit(f"ERROR: cannot read config {a.config}: {e}")
    html, n = build(cfg)
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"OK {a.out} pages={n}")


if __name__ == "__main__":
    main()
