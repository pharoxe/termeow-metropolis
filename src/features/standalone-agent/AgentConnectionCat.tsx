import { useEffect, useRef } from "react";

const GLYPHS = "01#アネミ";
type Point = { x: number; y: number; eye: boolean; darkness: number; glyph: string };

/** The boot-screen cat, redrawn as a compact blinking signal while ElevenLabs connects. */
export function AgentConnectionCat() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const image = new Image();
    image.src = "/assets/loading-cat.png";
    let points: Point[] = [];
    let frame = 0;
    const sample = () => {
      if (!image.naturalWidth) return;
      const source = document.createElement("canvas");
      source.width = source.height = 66;
      const sourceContext = source.getContext("2d", { willReadFrequently: true });
      if (!sourceContext) return;
      sourceContext.drawImage(image, 0, 0, 66, 66);
      const pixels = sourceContext.getImageData(0, 0, 66, 66).data;
      points = [];
      for (let y = 0; y < 66; y += 1) for (let x = 0; x < 66; x += 1) {
        const darkness = 1 - pixels[(y * 66 + x) * 4] / 255;
        const eye = y >= 29 && y <= 43 && ((x >= 12 && x <= 32) || (x >= 35 && x <= 55)) && darkness < .4;
        if (eye || darkness >= .55) points.push({ x, y, eye, darkness, glyph: eye ? "1" : GLYPHS[(x + y * 3) % GLYPHS.length] });
      }
    };
    const resize = () => {
      const box = canvas.getBoundingClientRect();
      const ratio = Math.min(devicePixelRatio || 1, 1.5);
      canvas.width = Math.max(1, Math.round(box.width * ratio));
      canvas.height = Math.max(1, Math.round(box.height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const { width, height } = canvas.getBoundingClientRect();
      context.clearRect(0, 0, width, height);
      const size = Math.min(width, height) * .88;
      const step = size / 66;
      const x0 = (width - size) / 2;
      const y0 = (height - size) / 2;
      const phase = now % 2600;
      const blink = phase > 2050 && phase < 2310 ? Math.max(.06, Math.abs(phase - 2180) / 130) : 1;
      const pulse = .83 + Math.sin(now / 310) * .1;
      context.textBaseline = "top";
      context.font = `${Math.max(2, Math.ceil(step * 1.32))}px "Cascadia Mono",monospace`;
      context.shadowColor = "#45ff88";
      context.shadowBlur = 7 + pulse * 6;
      for (const point of points) {
        if (point.eye && Math.abs(point.y - 36) > 7 * blink) continue;
        context.fillStyle = point.eye ? `rgba(112,255,155,${pulse})` : `rgba(52,226,116,${(.36 + point.darkness * .38) * pulse})`;
        context.fillText(point.glyph, x0 + point.x * step, y0 + point.y * step);
      }
      context.shadowBlur = 0;
    };
    image.addEventListener("load", sample);
    sample(); resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    frame = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); image.removeEventListener("load", sample); };
  }, []);
  return <div className="agent-connection-cat" aria-label="Connecting to Termeow"><canvas ref={canvasRef} aria-hidden="true" /></div>;
}
