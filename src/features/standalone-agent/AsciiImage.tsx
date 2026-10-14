import { useEffect, useRef } from "react";
import type { AgentStatus } from "../voice-agent/runtime/agentTypes";
import { audioReactiveEngine } from "../voice-agent/audio/AudioReactiveEngine";
import { palette, mix, rgba } from "./xbitPalette";

const GLYPHS = "  .,:;-+=*#%@";
const TRANSITION_MS = 900;

type Cell = { light: number; red: number; green: number; blue: number; seed: number };
type Grid = { columns: number; rows: number; step: number; cells: Cell[] };

function sampleImage(image: HTMLImageElement, width: number, height: number): Grid {
  const columns = Math.min(110, Math.max(58, Math.floor(width / 6.67)));
  const step = width / columns;
  const rows = Math.ceil(height / step);
  const sampler = document.createElement("canvas");
  sampler.width = columns;
  sampler.height = rows;
  const context = sampler.getContext("2d", { willReadFrequently: true });
  if (!context) return { columns, rows, step, cells: [] };
  const scale = Math.max(columns / image.naturalWidth, rows / image.naturalHeight);
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  context.drawImage(image, (columns - drawWidth) / 2, (rows - drawHeight) / 2, drawWidth, drawHeight);
  const pixels = context.getImageData(0, 0, columns, rows).data;
  const cells: Cell[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const offset = (row * columns + column) * 4;
      const red = pixels[offset] / 255;
      const green = pixels[offset + 1] / 255;
      const blue = pixels[offset + 2] / 255;
      const luminance = (red * .21 + green * .72 + blue * .07) * pixels[offset + 3] / 255;
      cells.push({
        light: Math.pow(Math.min(1, luminance * 1.5), .8),
        red, green, blue,
        seed: ((column * 47 + row * 101) % 137) / 137
      });
    }
  }
  return { columns, rows, step, cells };
}

/** Any same-origin image can be sampled into this ASCII field; changing src morphs the cells to the new image. */
export function AsciiImage({ src, alt, status, className = "" }: { src: string; alt: string; status: AgentStatus; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const currentRef = useRef<Grid | null>(null);
  const previousRef = useRef<Grid | null>(null);
  const transitionRef = useRef<number | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 1;
    let height = 1;
    let animation = 0;
    let live = true;

    const render = (now: number) => {
      const XB = palette();
      context.fillStyle = rgba(XB.bg);
      context.fillRect(0, 0, width, height);
      const grid = currentRef.current;
      if (!grid) { if (!reduced) animation = requestAnimationFrame(render); return; }
      const old = previousRef.current;
      const elapsed = transitionRef.current == null ? TRANSITION_MS : now - transitionRef.current;
      const progress = reduced ? 1 : Math.min(1, Math.max(0, elapsed / TRANSITION_MS));
      const settled = 1 - (1 - progress) ** 3;
      const mode = statusRef.current;
      const audio = audioReactiveEngine.current.amplitude;
      const speaking = mode === "speaking";
      const active = speaking || mode === "listening";
      const energy = active ? audio : .025;
      context.font = `${Math.ceil(grid.step * 1.16)}px "Cascadia Mono", monospace`;
      context.textBaseline = "top";
      for (let index = 0; index < grid.cells.length; index += 1) {
        const target = grid.cells[index];
        const origin = old?.cells[index];
        const light = (origin?.light ?? 0) * (1 - settled) + target.light * settled;
        if (light < .045) continue;
        const column = index % grid.columns;
        const row = Math.floor(index / grid.columns);
        const scramble = (1 - settled) * (7 + target.seed * 22);
        const driftX = Math.sin(target.seed * 47 + now * .0015) * scramble;
        const driftY = Math.cos(target.seed * 63 + now * .0012) * scramble;
        const wave = Math.sin(now * .0028 + column * .19 + target.seed * 8) * (.45 + energy * 3.2);
        const x = column * grid.step + driftX;
        const y = row * grid.step + driftY + wave;
        const glyphIndex = Math.min(GLYPHS.length - 1, Math.floor(light * (GLYPHS.length - 1)));
        const glyph = progress < 1 && target.seed > progress ? GLYPHS[(glyphIndex + Math.floor(now / 48) + index) % GLYPHS.length] : GLYPHS[glyphIndex];
        const alpha = Math.min(.95, (.23 + light * .9) * (progress < 1 ? .55 + progress * .45 : 1));
        // Shadows read as X Bit lavender-blue and highlights as cream; speech pulls the bright cells toward yellow.
        const base = mix(XB.line2, XB.ink, Math.min(1, light * 1.25));
        const tint = mode === "error" ? XB.down : speaking ? XB.hi : mode === "listening" ? XB.mint : null;
        context.fillStyle = rgba(tint ? mix(base, tint, .35 + light * .55) : base, alpha);
        context.fillText(glyph, x, y);
        if (light > .48 && (index + Math.floor(now / 230)) % 19 === 0) {
          context.fillStyle = rgba(XB.hi, alpha * .34);
          context.fillText(glyph, x - 1.4, y);
          context.fillStyle = rgba(XB.mint, alpha * .3);
          context.fillText(glyph, x + 1.4, y);
        }
      }
      if (progress >= 1) previousRef.current = null;
      if (!reduced) animation = requestAnimationFrame(render);
    };

    const resize = () => {
      const bounds = host.getBoundingClientRect();
      width = Math.max(1, Math.round(bounds.width));
      height = Math.max(1, Math.round(bounds.height));
      const ratio = Math.min(devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      if (imageRef.current?.complete && imageRef.current.naturalWidth) {
        currentRef.current = sampleImage(imageRef.current, width, height);
        previousRef.current = null;
        transitionRef.current = null;
      }
      if (reduced) render(performance.now());
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    if (!reduced) animation = requestAnimationFrame(render);

    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (!live) return;
      previousRef.current = currentRef.current;
      imageRef.current = image;
      currentRef.current = sampleImage(image, width, height);
      transitionRef.current = performance.now();
      if (reduced) render(performance.now());
    };
    image.onerror = () => { if (live) console.warn(`ASCII image could not load: ${src}`); };
    image.src = src;
    return () => { live = false; observer.disconnect(); cancelAnimationFrame(animation); image.onload = null; };
  }, [src]);

  return <canvas ref={canvasRef} className={`agent-ascii-layer ${className}`} role="img" aria-label={alt} />;
}
