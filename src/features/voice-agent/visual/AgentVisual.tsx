import { useEffect, useRef } from "react";
import type { AgentStatus } from "../runtime/agentTypes";
import { audioReactiveEngine } from "../audio/AudioReactiveEngine";

interface Props { status: AgentStatus; quality?: "low" | "normal" }

function statusColor(status: AgentStatus) {
  if (status === "error" || status === "warning") return "#ff4669";
  if (status === "speaking") return "#35d9ff";
  return "#b293fb";
}

/** Lightweight Canvas2D pixel wave: capped DPR and an allocation-free 60 fps draw loop. */
export default function AgentVisual({ status, quality = "normal" }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: true });
    if (!canvas || !context) return;
    let width = 1, height = 1, frame = 0, last = 0;
    const resize = () => {
      const box = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, quality === "low" ? 1 : 1.5);
      width = Math.max(1, Math.round(box.width * dpr)); height = Math.max(1, Math.round(box.height * dpr));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    };
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (now - last < 1000 / 60) return;
      last = now;
      const audio = audioReactiveEngine.current;
      const current = statusRef.current;
      const active = current === "speaking" || current === "listening";
      const energy = Math.min(1, audio.amplitude * 1.35 + audio.mid * .55 + (active ? .08 : .015));
      const color = statusColor(current);
      context.clearRect(0, 0, width, height); context.fillStyle = color; context.shadowColor = color;
      context.shadowBlur = active ? 10 + energy * 24 : 5;
      const columns = quality === "low" ? 32 : 48, rows = quality === "low" ? 13 : 18;
      const cellW = width / columns, cellH = height / rows, pixel = Math.max(2, Math.min(cellW, cellH) * .54), phase = now * (active ? .007 : .0022);
      for (let column = 0; column < columns; column += 1) {
        const x = (column + .5) * cellW;
        const envelope = Math.sin(Math.PI * column / (columns - 1));
        const wave = Math.sin(column * .42 + phase) * .55 + Math.sin(column * .17 - phase * 1.4) * .28;
        const cells = 2 + Math.round((1.5 + energy * rows * .42) * envelope * (.72 + Math.abs(wave)));
        for (let row = -cells; row <= cells; row += 1) {
          context.globalAlpha = Math.max(.22, (1 - Math.abs(row) / Math.max(1, cells) * .68) * (active ? .95 : .68));
          const y = height / 2 + row * cellH + wave * cellH * (1 + energy * 1.8);
          context.fillRect(Math.round(x - pixel / 2), Math.round(y - pixel / 2), Math.round(pixel), Math.round(pixel));
        }
      }
      context.globalAlpha = 1; context.shadowBlur = 0;
    };
    frame = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [quality]);
  return <canvas ref={canvasRef} className="agent-canvas agent-pixel-wave" aria-hidden="true" />;
}
