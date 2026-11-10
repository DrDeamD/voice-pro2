import {AbsoluteFill, CalculateMetadataFunction, Composition, Sequence, useVideoConfig} from 'remotion';
import {Card} from './Panel';
import {Intro, Step10, Step11, Step5, Step6, Step7, Step8, Step9} from './Scenes';

type Props = Record<string, unknown>;

const calculateMetadata: CalculateMetadataFunction<Props> = () => {
  return {};
};

export const MyComposition = () => {
  return (
    <Composition
      id="Qimma1Steps5to11"
      component={MyComponent}
      durationInFrames={1650}
      fps={30}
      width={1280}
      height={720}
      calculateMetadata={calculateMetadata}
    />
  );
};

export const MyComponent: React.FC<Props> = () => {
  const {fps} = useVideoConfig();
  return (
    <AbsoluteFill style={{background: '#1c2430'}}>
      <Sequence name="Intro" durationInFrames={4 * fps}>
        <Intro />
      </Sequence>
      <Sequence name="Step 5 roll" from={4 * fps} durationInFrames={14 * fps}>
        <Step5 />
      </Sequence>
      <Sequence name="Step 6 inner fold" from={18 * fps} durationInFrames={6 * fps}>
        <Step6 />
      </Sequence>
      <Sequence name="Step 7 nose corners" from={24 * fps} durationInFrames={5 * fps}>
        <Step7 />
      </Sequence>
      <Sequence name="Step 8 belly" from={29 * fps} durationInFrames={5 * fps}>
        <Step8 />
      </Sequence>
      <Sequence name="Step 9 body and lock" from={34 * fps} durationInFrames={6 * fps}>
        <Step9 />
      </Sequence>
      <Sequence name="Step 10 roll into pocket" from={40 * fps} durationInFrames={5 * fps}>
        <Step10 />
      </Sequence>
      <Sequence name="Step 11 open wings" from={45 * fps} durationInFrames={7 * fps}>
        <Step11 />
      </Sequence>
      <Sequence name="Outro" from={52 * fps} durationInFrames={3 * fps}>
        <Card
          title="بعد الخطوة 11"
          lines={['12. ألصق 5 نقاط (المجموع لا يتجاوز 3 × 2.5 سم).', '13. ارفع الجنيحين واضبط الرافع.', 'القالب 1:1 في ملف paper-plane-plans.pdf']}
          sub="قمّة-1 نموذج أولي: لم يُختبر بالطيران."
        />
      </Sequence>
    </AbsoluteFill>
  );
};
