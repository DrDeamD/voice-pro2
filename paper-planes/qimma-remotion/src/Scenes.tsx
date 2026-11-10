import {AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {
  BODY, CX, FY, H, L4, L6, LROLL, NOSE, R4, R6, RROLL, ROLL, S4, S6, S7, W,
  bodyPose, commit, pose,
} from './fold';
import type {Face, Fold, Layer, P3} from './fold';
import {Footer, Panel} from './Panel';
import {Stage3D} from './Paper3D';

const PI = Math.PI;
const rad = (d: number) => (d * PI) / 180;
const SCHEMATIC = 'تمثيل تخطيطي مبسّط، ليس طيّاً دقيقاً. تابع فيديو Unite من 1:25 إلى 2:10.';

/** Eased progress 0..1 between two times in seconds. */
const useT = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  return (s0: number, s1: number) =>
    interpolate(frame, [s0 * fps, s1 * fps], [0, 1], {
      extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.45, 0, 0.25, 1),
    });
};

const useSec = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  return frame / fps;
};

const z = (ls: Layer[]) => Math.max(...ls.map((l) => l.z)) + 0.6;
const lineOf = (f: Fold, zz: number): [P3, P3] => [[f.a[0], f.a[1], zz], [f.b[0], f.b[1], zz]];
const FLAT: P3 = [CX, 70, 0];

// ---------- step 5: roll the leading edge, then open ----------
const S5a = commit(S4, [RROLL, LROLL]);
export const Step5: React.FC = () => {
  const t = useT();
  const s = useSec();
  const zz = z(S4);
  let faces: Face[];
  let lines: [P3, P3][] = [];
  let title = 'لفّ الحافة';
  let text = [`علّم ${ROLL / 10} سم من كل جانب`, 'على الحافة العليا.', 'اطوِ من العلامة', 'إلى طرف الجناح.'];
  if (s < 5) {
    faces = pose(S4, [RROLL, LROLL], PI * t(1.8, 4.6));
    if (s < 1.8) lines = [lineOf(RROLL, zz), lineOf(LROLL, zz)];
  } else if (s < 9) {
    faces = pose(S5a, [R4, L4], PI * t(5.6, 8.4));
    if (s < 5.6) lines = [lineOf(R4, z(S5a)), lineOf(L4, z(S5a))];
    title = 'لفّ الحافة: مرة ثانية';
    text = ['اطوِ مرة ثانية', 'على الخط 4.', '= حافة جناح صلبة'];
  } else {
    // open the roll again: reverse both folds
    const back = t(9.6, 11.6);
    faces = back < 1 ? pose(S5a, [R4, L4], PI * (1 - back)) : pose(S4, [RROLL, LROLL], PI * (1 - t(11.6, 13.4)));
    title = 'افتح اللفّ';
    text = ['افتح اللفّ كله.', 'تبقى الثنيات', 'للخطوة 10.'];
  }
  const dots: P3[] = s < 1.8 ? [[W - ROLL, FY, zz], [ROLL, FY, zz]] : [];
  return (
    <AbsoluteFill>
      <Stage3D faces={faces} lines={lines} dots={dots} az={rad(-18 + 2 * s)} el={rad(58)} dist={560} target={[CX, 100, 0]} />
      <Panel step="5" title={title} lines={text} note="الخط 4 تقديري من الفيديو. هندسة الطيّ هنا محاكاة بالقياسات." />
      <Footer />
    </AbsoluteFill>
  );
};

// ---------- step 6: fold the wing flanks behind on line 4 ----------
export const Step6: React.FC = () => {
  const t = useT();
  const s = useSec();
  const faces = pose(S4, [R6, L6], PI * t(1.5, 4.5));
  const lines = s < 1.5 ? [lineOf(R4, z(S4)), lineOf(L4, z(S4))] : [];
  return (
    <AbsoluteFill>
      <Stage3D faces={faces} lines={lines} az={rad(-10 + 6 * t(0, 6))} el={rad(40 - 85 * t(4.3, 5.6))} dist={520} target={[CX, 80, 0]} highlight={{roll: t(4.3, 5.3)}} />
      <Panel step="6" title="الطيّ الداخلي" lines={['اطوِ على ثنيتي', 'الجناحين للخلف.', 'من الخلف: الجزء الملوّن', '= مادة الحافة الملفوفة.']} note={SCHEMATIC} />
      <Footer />
    </AbsoluteFill>
  );
};

// ---------- step 7: nose corners under, cut the excess ----------
export const Step7: React.FC = () => {
  const t = useT();
  const s = useSec();
  const faces = pose(S6, [NOSE], PI * t(1.2, 3.4));
  const lines = s < 1.2 ? [lineOf(NOSE, z(S6))] : [];
  return (
    <AbsoluteFill>
      <Stage3D faces={faces} lines={lines} az={rad(-14)} el={rad(48)} dist={520 - 60 * t(0, 4)} target={[CX, 90, 0]} />
      <Panel step="7" title="زوايا المقدمة" lines={['أعد طيّ الزاويتين', 'الوسطيتين للخلف.', 'قُصّ الجزء الزائد.']} note={SCHEMATIC} />
      <Footer />
    </AbsoluteFill>
  );
};

// ---------- step 8: belly triangle up ----------
const zb = Math.min(...S7.map((l) => l.z)) - 0.6;
const BELLY: Layer = {poly: [[CX - 18, 52], [CX + 18, 52], [CX, 22]], z: zb, tag: 'belly'};
const BELLY_HINGE: Fold = {a: [0, 52], b: [W, 52], mover: [CX, 22], under: true};
const S8: Layer[] = [...S7, ...commit([BELLY], [BELLY_HINGE])];
export const Step8: React.FC = () => {
  const t = useT();
  // view from below so the belly is visible
  const belly = pose([BELLY], [BELLY_HINGE], PI * t(1.2, 3.6));
  const faces = [...pose(S7, [], 0), ...belly];
  return (
    <AbsoluteFill>
      <Stage3D faces={faces} az={rad(-20)} el={rad(-48)} dist={520} target={[CX, 70, 0]} highlight={{belly: 1}} />
      <Panel step="8" title="البطن" lines={['اقلب الطائرة.', 'علّم العمود من الزاوية', 'إلى خط المنتصف.', 'اطوِ البطن للأعلى عليه.']} note={SCHEMATIC} />
      <Footer />
    </AbsoluteFill>
  );
};

// ---------- step 9: body fold + dolphin lock ----------
export const Step9: React.FC = () => {
  const t = useT();
  const s = useSec();
  const phi = (PI / 2) * t(0.8, 3.6);
  const faces = bodyPose(S8, phi, 0);
  return (
    <AbsoluteFill>
      <Stage3D faces={faces} az={rad(-40 + 25 * t(0, 6))} el={rad(30)} dist={460 - 90 * t(0.8, 3.6)} target={[CX, 70, 20]} highlight={{belly: 1}} />
      <Panel
        step="9"
        title="الجسم وقفل الدلفين"
        lines={['اطوِ الجسم للخلف', 'من المنتصف.', 'اسحب جيب المقدمة', 'للأسفل = قفل الدلفين.']}
        note={s > 3.6 ? 'طيّ الجسم: محاكاة. القفل نفسه غير مرسوم.' : SCHEMATIC}
      />
      <Footer />
    </AbsoluteFill>
  );
};

// ---------- step 10: roll into the pocket ----------
export const Step10: React.FC = () => {
  const t = useT();
  const s = useSec();
  const faces = bodyPose(S8, PI / 2, 0);
  const pulse = 0.5 + 0.5 * Math.sin(s * 5);
  return (
    <AbsoluteFill>
      <Stage3D faces={faces} az={rad(-15 - 40 * t(0, 5))} el={rad(22)} dist={380} target={[CX, 70, 25]} highlight={{roll: pulse, belly: 0.4}} />
      <Panel step="10" title="لفّة الجناح في الجيب" lines={['أعد لفّ الحافة', 'على ثنيات الخطوة 5.', 'أدخل اللفّة في الجيب.', 'اجعلها مسطحة.']} note={SCHEMATIC} />
      <Footer />
    </AbsoluteFill>
  );
};

// ---------- step 11: open the wings, body 0.9 cm ----------
export const Step11: React.FC = () => {
  const t = useT();
  const s = useSec();
  const psi = (PI / 2) * t(1, 4.5);
  const faces = bodyPose(S8, PI / 2, psi);
  return (
    <AbsoluteFill>
      <Stage3D
        faces={faces}
        az={rad(-55 + 80 * t(0, 7))}
        el={rad(26 - 6 * t(4, 7))}
        dist={470}
        target={[CX, 70, 10]}
        highlight={{roll: 0.35, belly: 0.35}}
      />
      <Panel
        step="11"
        title="افتح الجناحين"
        lines={['افتح الجناحين', `على ارتفاع ${BODY / 10} سم`, 'من القفل إلى الذيل.', s > 4.5 ? 'الشكل جاهز للّصق (12).' : '']}
        note="فتح الجناحين وارتفاع الجسم: محاكاة بالقياسات."
      />
      <Footer />
    </AbsoluteFill>
  );
};

// ---------- intro: the sheet after steps 1-4 ----------
export const Intro: React.FC = () => {
  const t = useT();
  return (
    <AbsoluteFill>
      <Stage3D faces={pose(S4, [], 0)} lines={[lineOf(R4, z(S4)), lineOf(L4, z(S4))]} az={rad(-30 + 25 * t(0, 4))} el={rad(55)} dist={620} target={FLAT} />
      <Panel title="قمّة-1: المراحل 5 إلى 11" lines={['البداية: الورقة', 'بعد الخطوات 1 إلى 4.', 'الخط الأحمر = الخط 4', '(ثنية الجناح).']} />
      <Footer />
    </AbsoluteFill>
  );
};

export const SHEET_H = H;
