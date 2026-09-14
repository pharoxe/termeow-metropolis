import { motion, useSpring, useTransform } from "motion/react";
import { useEffect, useState } from "react";
import { useAgent } from "../voice-agent/context/AgentProvider";

function SpeakerIcon({ loud }: { loud: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z" /><path className="sound-wave" d={loud ? "M16 8c1.2 1 1.2 7 0 8m3-11c3 3 3 11 0 14" : "M17 10l4 4m0-4-4 4"} /></svg>;
}

export function AgentVolumeSlider() {
  const agent = useAgent();
  const [dragging, setDragging] = useState(false);
  const percent = Math.round(agent.volume * 100);
  const spring = useSpring(agent.volume, { stiffness: 360, damping: 28, mass: 0.45 });
  const thumbLeft = useTransform(spring, (value) => `${value * 100}%`);

  useEffect(() => { spring.set(agent.volume); }, [agent.volume, spring]);

  return <label className={`agent-volume ${dragging ? "dragging" : ""}`}>
    <span className="agent-volume-label">AGENT VOLUME</span>
    <div className="elastic-volume-track">
      <SpeakerIcon loud={percent > 0} />
      <div className="elastic-volume-rail">
        <motion.i style={{ scaleX: spring }} />
        <motion.b style={{ left: thumbLeft }} />
        <input
          aria-label="Agent volume"
          type="range"
          min="0"
          max="100"
          step="1"
          value={percent}
          onChange={(event) => agent.setVolume(Number(event.target.value) / 100)}
          onPointerDown={() => setDragging(true)}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
        />
      </div>
      <output>{percent}</output>
    </div>
  </label>;
}
