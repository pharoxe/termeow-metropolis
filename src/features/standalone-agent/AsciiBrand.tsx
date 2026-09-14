import { useEffect, useRef } from "react";

const GLYPHS = "+*#%@";

export function AsciiBrand({ text = "TERMEOW" }: { text?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let animation = 0;
    let width = 0;
    let height = 0;
    let mask: Uint8ClampedArray;

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(devicePixelRatio || 1, 2);
      width = Math.max(1, Math.round(bounds.width));
      height = Math.max(1, Math.round(bounds.height));
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const sample = document.createElement("canvas");
      sample.width = width;
      sample.height = height;
      const sampleContext = sample.getContext("2d", { willReadFrequently: true });
      if (!sampleContext) return;
      sampleContext.fillStyle = "#fff";
      sampleContext.font = `700 ${Math.floor(height * .86)}px "Silkscreen", monospace`;
      sampleContext.textBaseline = "middle";
      sampleContext.fillText(text, 0, height * .52, width);
      mask = sampleContext.getImageData(0, 0, width, height).data;
    };

    const draw = (time = 0) => {
      context.clearRect(0, 0, width, height);
      context.font = `700 ${Math.floor(height * .82)}px "Silkscreen", monospace`;
      context.textBaseline = "middle";
      context.fillStyle = "rgba(69,255,136,.42)";
      context.fillText(text, 0, height * .53, width);
      context.font = '7px "Cascadia Mono", monospace';
      context.textBaseline = "top";
      const tick = Math.floor(time / 170);
      for (let y = 1; y < height - 2; y += 5) {
        for (let x = 1; x < width - 2; x += 4) {
          const offset = (Math.floor(y) * width + Math.floor(x)) * 4 + 3;
          if (!mask || mask[offset] < 65) continue;
          const pulse = .72 + .28 * Math.sin(time * .004 + x * .1);
          const glyph = GLYPHS[(Math.floor(x / 4) + Math.floor(y / 5) + tick) % GLYPHS.length];
          context.fillStyle = `rgba(69,255,136,${pulse})`;
          context.fillText(glyph, x, y);
        }
      }
      if (!reduced) animation = requestAnimationFrame(draw);
    };

    const observer = new ResizeObserver(() => { resize(); if (reduced) draw(); });
    observer.observe(canvas);
    resize();
    draw();
    void document.fonts.ready.then(() => { resize(); if (reduced) draw(); });
    return () => { observer.disconnect(); cancelAnimationFrame(animation); };
  }, [text]);

  return <span className="ascii-brand" aria-label={text}>
    <canvas ref={canvasRef} aria-hidden="true" />
    <span className="ascii-brand-fallback" aria-hidden="true">{text}</span>
  </span>;
}
