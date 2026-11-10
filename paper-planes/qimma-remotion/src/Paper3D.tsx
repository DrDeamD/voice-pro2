import {useMemo} from 'react';
import {useThree} from '@react-three/fiber';
import {ThreeCanvas} from '@remotion/three';
import {useCurrentFrame, useVideoConfig} from 'remotion';
import * as THREE from 'three';
import type {Face, P3} from './fold';

const TAG_COLORS: Record<string, {front: string; back: string}> = {
  roll: {front: '#ffd27a', back: '#f5b041'},
  belly: {front: '#ffb38a', back: '#ff8c5a'},
};

const faceGeometry = (faces: Face[]) => {
  const pos: number[] = [];
  for (const f of faces) {
    for (let i = 1; i < f.pts.length - 1; i++) {
      pos.push(...f.pts[0], ...f.pts[i], ...f.pts[i + 1]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
};

const edgeGeometry = (faces: Face[]) => {
  const pos: number[] = [];
  for (const f of faces) {
    f.pts.forEach((p, i) => pos.push(...p, ...f.pts[(i + 1) % f.pts.length]));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
};

const dashGeometry = (lines: [P3, P3][], dash = 4, gap = 3) => {
  const pos: number[] = [];
  for (const [a, b] of lines) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    for (let s = 0; s < len; s += dash + gap) {
      const t0 = s / len;
      const t1 = Math.min(1, (s + dash) / len);
      pos.push(
        a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0, a[2] + (b[2] - a[2]) * t0,
        a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1, a[2] + (b[2] - a[2]) * t1,
      );
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
};

/** Paper faces: front side white, back side blue. Tagged faces get a highlight colour. */
const Paper: React.FC<{faces: Face[]; highlight?: Record<string, number>}> = ({faces, highlight = {}}) => {
  const groups = useMemo(() => {
    const by = new Map<string, Face[]>();
    for (const f of faces) {
      const k = f.tag ?? '';
      by.set(k, [...(by.get(k) ?? []), f]);
    }
    return [...by.entries()].map(([k, fs]) => ({k, geo: faceGeometry(fs)}));
  }, [faces]);
  const edges = useMemo(() => edgeGeometry(faces), [faces]);
  return (
    <>
      {groups.map(({k, geo}) => {
        const tagged = TAG_COLORS[k];
        const h = highlight[k] ?? 0;
        const front = tagged ? new THREE.Color('#f7f7f4').lerp(new THREE.Color(tagged.front), h) : '#f7f7f4';
        const back = tagged ? new THREE.Color('#a9c8ee').lerp(new THREE.Color(tagged.back), h) : '#a9c8ee';
        return (
          <group key={k}>
            <mesh geometry={geo}>
              <meshStandardMaterial color={front} side={THREE.FrontSide} roughness={0.9} />
            </mesh>
            <mesh geometry={geo}>
              <meshStandardMaterial color={back} side={THREE.BackSide} roughness={0.9} />
            </mesh>
          </group>
        );
      })}
      <lineSegments geometry={edges}>
        <lineBasicMaterial color="#2b3a4a" />
      </lineSegments>
    </>
  );
};

/** Camera on a sphere around `target`, driven only by the props (no useFrame). */
const CameraRig: React.FC<{az: number; el: number; dist: number; target: P3}> = ({az, el, dist, target}) => {
  const camera = useThree((s) => s.camera);
  camera.up.set(0, 0, 1);
  camera.position.set(
    target[0] + dist * Math.cos(el) * Math.sin(az),
    target[1] - dist * Math.cos(el) * Math.cos(az),
    target[2] + dist * Math.sin(el),
  );
  camera.lookAt(target[0], target[1], target[2]);
  camera.updateProjectionMatrix();
  return null;
};

export type Stage3DProps = {
  faces: Face[];
  lines?: [P3, P3][];
  dots?: P3[];
  az: number;
  el: number;
  dist: number;
  target: P3;
  highlight?: Record<string, number>;
};

export const Stage3D: React.FC<Stage3DProps> = ({faces, lines = [], dots = [], az, el, dist, target, highlight}) => {
  const {width, height} = useVideoConfig();
  useCurrentFrame();
  const dashes = useMemo(() => dashGeometry(lines), [lines]);
  return (
    <ThreeCanvas width={width - 430} height={height} camera={{fov: 30, near: 5, far: 5000}} style={{background: '#687e96'}}>
      <CameraRig az={az} el={el} dist={dist} target={target} />
      <ambientLight intensity={1.1} />
      <directionalLight position={[120, -200, 400]} intensity={1.6} />
      <directionalLight position={[-200, 150, -150]} intensity={0.5} />
      <Paper faces={faces} highlight={highlight} />
      {lines.length > 0 && (
        <lineSegments geometry={dashes}>
          <lineBasicMaterial color="#e02828" />
        </lineSegments>
      )}
      {dots.map((d, i) => (
        <mesh key={i} position={d}>
          <sphereGeometry args={[2.2, 16, 16]} />
          <meshBasicMaterial color="#e02828" />
        </mesh>
      ))}
    </ThreeCanvas>
  );
};
