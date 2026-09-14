import { useEffect, useRef } from "react";

const STREAM_GLYPHS = "01";
const CAT_GLYPHS = "01";

/** Full-viewport ASCII boot scene. Canvas stays in one layer while the app mounts underneath. */
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
    let pixels: Uint8ClampedArray | undefined;
    let width = 1;
    let height = 1;
    let animation = 0;
    let exitAt = 0;
    let lastFrame = 0;

    const sample = () => {
      if (!image.complete || !image.naturalWidth) return;
      const surface = document.createElement("canvas");
      surface.width = 66;
      surface.height = 66;
      const ctx = surface.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(image, 0, 0, 66, 66);
      pixels = ctx.getImageData(0, 0, 66, 66).data;
    };
    image.addEventListener("load", sample);
    sample();

    const resize = () => {
      width = innerWidth;
      height = innerHeight;
      const ratio = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const draw = (now: number) => {
      animation = requestAnimationFrame(draw);
      if (now - lastFrame < 15 && !reduced) return;
      lastFrame = now;
      if (exitingRef.current && !exitAt) exitAt = now;
      const progress = exitAt ? Math.min(1, (now - exitAt) / (reduced ? 1 : 850)) : 0;
      const eased = 1 - (1 - progress) ** 3;
      context.fillStyle = "#010503";
      context.fillRect(0, 0, width, height);
      context.textBaseline = "top";
      context.font = '11px "Cascadia Mono", monospace';
      const spacing = 26;
      const columns = Math.ceil(width / spacing);
      for (let col = 0; col < columns; col += 1) {
        const seed = (col * 73 % 101) / 101;
        const speed = 16 + seed * 33;
        for (let row = -2; row < Math.ceil(height / 42) + 2; row += 1) {
          const y = ((row * 42 - now * .001 * speed + seed * height) % (height + 84) + height + 84) % (height + 84) - 42;
          const streamPush = eased * Math.sign(col * spacing - width / 2) * width * .08;
          const glyph = STREAM_GLYPHS[(col * 7 + row * 3 + Math.floor(now / 210)) % STREAM_GLYPHS.length];
          context.fillStyle = `rgba(47,223,116,${(.08 + seed * .11) * (1 - eased)})`;
          context.fillText(glyph, col * spacing + streamPush, y - eased * (90 + seed * 80));
        }
      }
      if (!pixels) return;
      const size = Math.min(225, Math.max(140, Math.min(width, height) * .25));
      const step = size / 66;
      const blinkPhase = now % 3300;
      const blink = reduced ? 1 : blinkPhase > 2650 && blinkPhase < 2900 ? Math.max(.08, Math.abs(blinkPhase - 2775) / 125) : 1;
      const x0 = width / 2 - size / 2;
      const y0 = height / 2 - size / 2;
      context.font = `${Math.ceil(step * 1.32)}px "Cascadia Mono", monospace`;
      for (let y = 0; y < 66; y += 1) {
        for (let x = 0; x < 66; x += 1) {
          const offset = (y * 66 + x) * 4;
          const darkness = 1 - pixels[offset] / 255;
          const eyeRegion = y >= 29 && y <= 43 && ((x >= 12 && x <= 32) || (x >= 35 && x <= 55));
          const eye = eyeRegion && darkness < .4;
          if (!eye && darkness < .55) continue;
          if (eye && Math.abs(y - 36) > 7 * blink) continue;
          const scatter = ((x * 37 + y * 71) % 29) / 29;
          const phase = now * .0016 + x * .21 + y * .18;
          const radialX = x - 32.5;
          const radialY = y - 32.5;
          const radialLength = Math.max(1, Math.hypot(radialX, radialY));
          const burst = eased * Math.max(width, height) * (.42 + scatter * .28);
          const driftX = Math.sin(phase) * .35 + radialX / radialLength * burst;
          const driftY = Math.cos(phase) * .35 + radialY / radialLength * burst;
          const intensity = eye ? .85 : .32 + darkness * .27;
          context.fillStyle = `rgba(${eye ? 92 : 37},${eye ? 255 : 181},${eye ? 135 : 85},${intensity * (1 - eased)})`;
          context.fillText(eye ? "1" : CAT_GLYPHS[(x + y * 3 + Math.floor(now / 240)) % CAT_GLYPHS.length], x0 + x * step + driftX, y0 + y * step + driftY);
        }
      }
    };
    resize();
    addEventListener("resize", resize);
    animation = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(animation); removeEventListener("resize", resize); image.removeEventListener("load", sample); };
  }, []);

  return <main className={`agent-loading-screen ${exiting ? "exiting" : ""}`} aria-label={error ? "Agent unavailable" : "Loading Termeow"}>
    <canvas ref={canvasRef} aria-hidden="true" />
    <p>{error || "TUNING THE SIGNAL"}</p>
  </main>;
}
