import { useEffect, useRef } from "react";
import type { AgentStatus } from "../voice-agent/runtime/agentTypes";
import { audioReactiveEngine } from "../voice-agent/audio/AudioReactiveEngine";

const GLYPHS = " .:-=+*#%@";

export function AsciiPersona({ status }: { status: AgentStatus }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;
    const source = document.createElement("canvas");
    const sourceContext = source.getContext("2d", { willReadFrequently: true });
    if (!sourceContext) return;
    const image = new Image();
    image.src = "/assets/termeow-persona.webp";
    let frame = 0;
    let cells: Array<{ x: number; y: number; glyph: string; light: number; seed: number }> = [];
    let cellSize = 10;

    const rebuild = () => {
      const bounds = host.getBoundingClientRect();
      const dpr = Math.min(devicePixelRatio || 1, 1.5);
      canvas.width = Math.max(1, Math.round(bounds.width * dpr));
      canvas.height = Math.max(1, Math.round(bounds.height * dpr));
      canvas.style.width = `${bounds.width}px`;
      canvas.style.height = `${bounds.height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const columns = bounds.width < 560 ? 46 : 64;
      cellSize = Math.max(7, bounds.width / columns);
      const rows = Math.ceil(bounds.height / cellSize);
      source.width = columns;
      source.height = rows;
      const imageRatio = image.naturalWidth / image.naturalHeight;
      const targetRatio = columns / rows;
      const drawWidth = targetRatio > imageRatio ? columns : rows * imageRatio;
      const drawHeight = targetRatio > imageRatio ? columns / imageRatio : rows;
      sourceContext.clearRect(0, 0, columns, rows);
      sourceContext.drawImage(image, (columns - drawWidth) / 2, (rows - drawHeight) / 2, drawWidth, drawHeight);
      const pixels = sourceContext.getImageData(0, 0, columns, rows).data;
      cells = [];
      for (let y = 0; y < rows; y += 1) for (let x = 0; x < columns; x += 1) {
        const offset = (y * columns + x) * 4;
        const light = (pixels[offset] * .2 + pixels[offset + 1] * .72 + pixels[offset + 2] * .08) / 255;
        if (light < .08) continue;
        cells.push({ x, y, light, glyph: GLYPHS[Math.min(GLYPHS.length - 1, Math.floor(light * GLYPHS.length))], seed: (x * 13 + y * 29) % 17 });
      }
    };

    const render = (now: number) => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      context.clearRect(0, 0, width, height);
      const audio = audioReactiveEngine.current;
      const active = status === "listening" || status === "speaking";
      const pulse = active ? audio.amplitude : .035;
      context.font = `${Math.ceil(cellSize)}px "Cascadia Mono", monospace`;
      context.textBaseline = "top";
      for (const cell of cells) {
        const wave = Math.sin(now * .0035 + cell.x * .22 + cell.seed) * (1.2 + pulse * 6);
        const shimmer = .68 + Math.sin(now * .002 + cell.seed) * .18;
        context.fillStyle = `rgba(${status === "error" ? "255,72,99" : status === "speaking" ? "115,245,255" : "64,255,137"},${Math.min(.78, .08 + cell.light * .38 + pulse * .32) * shimmer})`;
        context.fillText(cell.glyph, cell.x * cellSize, cell.y * cellSize + wave);
      }
      frame = requestAnimationFrame(render);
    };
    const observer = new ResizeObserver(() => { if (image.complete) rebuild(); });
    observer.observe(host);
    image.onload = () => rebuild();
    frame = requestAnimationFrame(render);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [status]);

  return <canvas ref={canvasRef} className="agent-ascii-layer" aria-hidden="true" />;
}
