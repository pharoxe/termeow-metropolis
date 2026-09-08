import { Canvas, useFrame } from "@react-three/fiber";
import { Color, MeshBasicMaterial, Object3D } from "three";
import { useMemo, useRef } from "react";
import type { InstancedMesh } from "three";
import type { AgentStatus } from "../runtime/agentTypes";
import { audioReactiveEngine } from "../audio/AudioReactiveEngine";

interface Props { status: AgentStatus; quality?: "low" | "normal" }

function hash(index: number, salt: number) {
  const x = Math.sin(index * 119.71 + salt * 43.13) * 43758.5453;
  return x - Math.floor(x);
}

function VoxelCore({ status, quality = "normal" }: Props) {
  const mesh = useRef<InstancedMesh>(null);
  const count = quality === "low" ? 150 : 280;
  const points = useMemo(() => Array.from({ length: count }, (_, index) => {
    const theta = hash(index, 1) * Math.PI * 2;
    const phi = Math.acos(hash(index, 2) * 2 - 1);
    const radius = .48 + hash(index, 3) * .62;
    return { x: Math.sin(phi) * Math.cos(theta) * radius, y: Math.cos(phi) * radius, z: Math.sin(phi) * Math.sin(theta) * radius, seed: hash(index, 4) * 8 };
  }), [count]);
  const dummy = useMemo(() => new Object3D(), []);
  const neon = useMemo(() => new Color("#2fff8a"), []);
  const cyan = useMemo(() => new Color("#35d9ff"), []);
  const danger = useMemo(() => new Color("#ff4669"), []);

  useFrame(({ clock }) => {
    if (!mesh.current) return;
    const time = clock.elapsedTime;
    const audio = audioReactiveEngine.current;
    const active = status === "speaking" || status === "listening";
    const spin = status === "thinking" ? .42 : status === "connecting" ? .22 : .08;
    const error = status === "error" || status === "warning";
    points.forEach((point, index) => {
      const pulse = Math.sin(time * (active ? 5 : 1.5) + point.seed) * (.025 + audio.high * .13);
      const voice = audio.amplitude * (.2 + hash(index, 5) * .5) * audio.direction;
      const catEar = index < 22 && status === "speaking" ? (index % 2 ? 1 : -1) * .04 : 0;
      const scale = Math.max(.42, .72 + pulse + audio.mid * .42);
      dummy.position.set(
        point.x * (1 + voice) + Math.sin(time + point.seed) * .018,
        point.y * (1 + voice) + (index < 22 ? .2 + catEar : 0),
        point.z * (1 + voice) + Math.cos(time * .8 + point.seed) * .018
      );
      if (status === "executing") dummy.position.multiplyScalar(.76);
      if (error) dummy.position.x += Math.sin(time * 28 + index) * .04;
      dummy.scale.setScalar(scale);
      dummy.rotation.set(time * spin + point.seed, time * spin * .8, point.seed);
      dummy.updateMatrix();
      mesh.current!.setMatrixAt(index, dummy.matrix);
    });
    mesh.current.rotation.y = time * spin;
    mesh.current.rotation.z = Math.sin(time * .45) * .08;
    mesh.current.instanceMatrix.needsUpdate = true;
    const material = mesh.current.material;
    if (material instanceof MeshBasicMaterial) {
      material.color.copy(error ? danger : status === "speaking" ? cyan : neon);
      material.opacity = status === "dormant" ? .6 : .9;
    }
  });

  return <instancedMesh ref={mesh} args={[undefined, undefined, count]}>
    <boxGeometry args={[.09, .09, .09]} />
    <meshBasicMaterial transparent opacity={.9} />
  </instancedMesh>;
}

export default function AgentVisual(props: Props) {
  return <Canvas className="agent-canvas" dpr={[1, 1.25]} camera={{ position: [0, 0, 3.3], fov: 42 }} gl={{ alpha: true, antialias: false, powerPreference: "low-power" }}>
    <VoxelCore {...props} />
  </Canvas>;
}
