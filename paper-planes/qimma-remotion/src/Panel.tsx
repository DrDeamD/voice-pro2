import {AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';

const FONT = '"DejaVu Sans", sans-serif';

/** Right-hand text panel. Arabic text: dir="rtl", animated by line (never by letter). */
export const Panel: React.FC<{step?: string; title: string; lines: string[]; note?: string}> = ({
  step,
  title,
  lines,
  note,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  return (
    <AbsoluteFill style={{left: 'auto', width: 430, background: '#1c2430', padding: '44px 40px', fontFamily: FONT}}>
      <div dir="rtl" lang="ar" style={{display: 'flex', alignItems: 'center', gap: 18}}>
        {step && (
          <div
            style={{
              width: 76, height: 76, borderRadius: 38, background: '#f2c200', color: '#16191d', fontSize: 40,
              fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              scale: interpolate(frame, [0, 0.4 * fps], [0.6, 1], {
                extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.spring({damping: 200}),
              }),
            }}
          >
            {step}
          </div>
        )}
        <div style={{color: '#fff', fontSize: 34, fontWeight: 700, lineHeight: 1.25}}>{title}</div>
      </div>
      <div dir="rtl" lang="ar" style={{marginTop: 40}}>
        {lines.map((l, i) => (
          <div
            key={i}
            style={{
              color: '#e9eef4', fontSize: 27, fontWeight: 700, lineHeight: 1.5, marginBottom: 10,
              opacity: interpolate(frame, [(0.3 + i * 0.35) * fps, (0.7 + i * 0.35) * fps], [0, 1], {
                extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
              }),
              translate: interpolate(frame, [(0.3 + i * 0.35) * fps, (0.7 + i * 0.35) * fps], ['0px 14px', '0px 0px'], {
                extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.16, 1, 0.3, 1),
              }),
            }}
          >
            {l}
          </div>
        ))}
      </div>
      {note && (
        <div dir="rtl" lang="ar" style={{position: 'absolute', bottom: 40, right: 40, left: 40, color: '#f2c200', fontSize: 19, lineHeight: 1.4}}>
          {note}
        </div>
      )}
    </AbsoluteFill>
  );
};

export const Footer: React.FC = () => (
  <div style={{position: 'absolute', left: 22, bottom: 16, color: '#e6ecf2', fontSize: 18, fontFamily: FONT}}>
    Qimma-1 · A5 70 g/m²
  </div>
);

export const Card: React.FC<{title: string; lines: string[]; sub?: string}> = ({title, lines, sub}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  return (
    <AbsoluteFill
      dir="rtl"
      lang="ar"
      style={{
        background: '#1c2430', fontFamily: FONT, justifyContent: 'center', alignItems: 'center',
        opacity: interpolate(frame, [0, 0.4 * fps], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}),
      }}
    >
      <div style={{color: '#f2c200', fontSize: 54, fontWeight: 700, marginBottom: 40}}>{title}</div>
      {lines.map((l, i) => (
        <div key={i} style={{color: '#f0f4f8', fontSize: 32, fontWeight: 700, lineHeight: 1.7}}>
          {l}
        </div>
      ))}
      {sub && <div style={{color: '#a0afbe', fontSize: 22, marginTop: 44}}>{sub}</div>}
    </AbsoluteFill>
  );
};
