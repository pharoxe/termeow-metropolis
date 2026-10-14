import { useEffect, useRef } from "react";
import { palette, rgba } from "./xbitPalette";
import "../../components/xbit-tokens.css";

// X Bit line-art glyphs (xbit.studio hero) instead of the earlier katakana rain.
const STREAM_GLYPHS = "/\\|-_=+#:.";
const CAT_GLYPHS = "/\\|#=";
type CatPoint = { x: number; y: number; darkness: number; eye: boolean; glyph: string };

/** Full-viewport ASCII boot scene. Expensive glyph layout is cached; animation is one requestAnimationFrame per display frame. */
export function AgentLoadingScreen({ exiting = false, error }: { exiting?: boolean; error?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const exitingRef = useRef(exiting);
  exitingRef.current = exiting;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !context) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const image = new Image();
    image.src = "/assets/loading-cat.png";
    let points: CatPoint[] = [];
    let width = 1;
    let height = 1;
    let animation = 0;
    let exitAt = 0;
    let streamTexture = document.createElement("canvas");
    const catFrames = new Map<string, HTMLCanvasElement>();

    const sample = () => {
      if (!image.complete || !image.naturalWidth) return;
      const surface = document.createElement("canvas");
      surface.width = 66;
      surface.height = 66;
      const ctx = surface.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(image, 0, 0, 66, 66);
      const pixels = ctx.getImageData(0, 0, 66, 66).data;
      points = [];
      for (let y = 0; y < 66; y += 1) for (let x = 0; x < 66; x += 1) {
        const offset = (y * 66 + x) * 4;
        const darkness = 1 - pixels[offset] / 255;
        const eyeRegion = y >= 29 && y <= 43 && ((x >= 12 && x <= 32) || (x >= 35 && x <= 55));
        const eye = eyeRegion && darkness < .4;
        if (eye || darkness >= .55) points.push({ x, y, darkness, eye, glyph: eye ? "1" : CAT_GLYPHS[(x + y * 3) % CAT_GLYPHS.length] });
      }
      catFrames.clear();
    };

    const buildStreams = () => {
      const XB = palette();
      streamTexture = document.createElement("canvas");
      streamTexture.width = Math.max(1, Math.ceil(width));
      streamTexture.height = Math.max(1, Math.ceil(height * 2));
      const ctx = streamTexture.getContext("2d");
      if (!ctx) return;
      ctx.textBaseline = "top";
      ctx.font = '9px "JetBrains Mono", monospace';
      const spacingX = 10;
      const spacingY = 15;
      for (let col = 0; col < Math.ceil(width / spacingX); col += 1) {
        const seed = (col * 73 % 101) / 101;
        for (let row = 0; row < Math.ceil(streamTexture.height / spacingY); row += 1) {
          const alpha = .055 + (((col * 31 + row * 17) % 100) / 100) * .15;
          ctx.fillStyle = rgba(XB.ink, alpha);
          ctx.fillText(STREAM_GLYPHS[(col * 7 + row * 11) % STREAM_GLYPHS.length], col * spacingX, row * spacingY + seed * 5);
        }
      }
    };

    const resize = () => {
      width = innerWidth;
      height = innerHeight;
      const ratio = Math.min(devicePixelRatio || 1, 1.35);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      buildStreams();
      catFrames.clear();
    };

    const catFrame = (blinkStep: number, size: number) => {
      const XB = palette();
      const key = `${size}:${blinkStep}`;
      const cached = catFrames.get(key);
      if (cached) return cached;
      const frame = document.createElement("canvas");
      frame.width = size + 8;
      frame.height = size + 8;
      const ctx = frame.getContext("2d");
      if (!ctx) return frame;
      const step = size / 66;
      const blink = blinkStep / 6;
      ctx.textBaseline = "top";
      ctx.font = `${Math.ceil(step * 1.32)}px "JetBrains Mono", monospace`;
      for (const point of points) {
        if (point.eye && Math.abs(point.y - 36) > 7 * blink) continue;
        const intensity = point.eye ? .95 : .5 + point.darkness * .4;
        ctx.fillStyle = rgba(point.eye ? XB.hi : XB.ink, intensity);
        ctx.fillText(point.glyph, 4 + point.x * step, 4 + point.y * step);
      }
      catFrames.set(key, frame);
      return frame;
    };

    const draw = (now: number) => {
      const XB = palette();
      animation = requestAnimationFrame(draw);
      if (exitingRef.current && !exitAt) exitAt = now;
      const progress = exitAt ? Math.min(1, (now - exitAt) / (reduced ? 1 : 1900)) : 0;
      const eased = progress < .5 ? 2 * progress * progress : 1 - ((-2 * progress + 2) ** 2) / 2;
      context.fillStyle = rgba(XB.bg);
      context.fillRect(0, 0, width, height);

      const streamOffset = (now * .024) % height;
      context.globalAlpha = 1 - eased;
      context.drawImage(streamTexture, 0, -height + streamOffset, width, height * 2);
      context.drawImage(streamTexture, 0, height + streamOffset, width, height * 2);
      context.globalAlpha = 1;
      if (!points.length) return;

      const size = Math.round(Math.min(225, Math.max(140, Math.min(width, height) * .25)));
      const step = size / 66;
      const x0 = width / 2 - size / 2;
      const y0 = height / 2 - size / 2;
      const blinkPhase = now % 3300;
      const blink = reduced ? 1 : blinkPhase > 2650 && blinkPhase < 2900 ? Math.max(.08, Math.abs(blinkPhase - 2775) / 125) : 1;
      if (!exitAt) {
        const frame = catFrame(Math.round(blink * 6), size);
        context.drawImage(frame, x0 - 4, y0 - 4);
        return;
      }

      context.textBaseline = "top";
      context.font = `${Math.ceil(step * 1.32)}px "JetBrains Mono", monospace`;
      for (const point of points) {
        if (point.eye && Math.abs(point.y - 36) > 7 * blink) continue;
        const radialX = point.x - 32.5;
        const radialY = point.y - 32.5;
        const radialLength = Math.max(1, Math.hypot(radialX, radialY));
        const scatter = ((point.x * 37 + point.y * 71) % 29) / 29;
        const burst = eased * Math.max(width, height) * (.42 + scatter * .28);
        const intensity = (point.eye ? .95 : .5 + point.darkness * .4) * (1 - eased);
        context.fillStyle = rgba(point.eye ? XB.hi : XB.ink, intensity);
        context.fillText(point.glyph, x0 + point.x * step + radialX / radialLength * burst, y0 + point.y * step + radialY / radialLength * burst);
      }
    };

    image.addEventListener("load", sample);
    sample();
    resize();
    addEventListener("resize", resize);
    animation = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(animation); removeEventListener("resize", resize); image.removeEventListener("load", sample); };
  }, []);

  return <main className={`agent-loading-screen ${exiting ? "exiting" : ""}`} aria-label={error ? "Agent unavailable" : "Loading Termeow"}>
    <canvas ref={canvasRef} aria-hidden="true" />
    <p>{error || "BOOT SEQUENCE_"}</p>
  </main>;
}
