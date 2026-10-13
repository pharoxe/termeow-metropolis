const escape = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string);

/** Colours mirror src/lib/themeTokens.ts so the gate reads as part of the terminal. */
export function lockPage({ next, error }: { next: string; error?: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>termeow · locked</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Silkscreen:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #f4f2f9; --panel: #ffffff; --line: #e0dbea; --line2: #cbc4da;
    --text: #1c1825; --muted: #5f5970; --accent: #7c5cf0; --down: #c02d43;
    --glyph: 124, 92, 240;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #050407; --panel: #0b0a10; --line: #1f1c29; --line2: #2f2a3d;
      --text: #e2deea; --muted: #8c8799; --accent: #b9a4ff; --down: #f2788a;
      --glyph: 185, 164, 255;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; display: grid; place-items: center; padding: 16px;
    background: var(--bg); color: var(--text);
    font: 13px/1.5 "Cascadia Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    background-image: radial-gradient(var(--line) 1px, transparent 1px);
    background-size: 14px 14px;
  }
  main { width: min(440px, 100%); }
  .card { background: var(--panel); border: 1px solid var(--line2); padding: 22px 22px 18px; }
  .bar { display: flex; justify-content: space-between; color: var(--muted); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 18px; }
  .bar b { color: var(--accent); font-weight: 400; }
  canvas { display: block; width: 100%; height: 64px; }
  pre.cat { margin: 14px 0 0; color: var(--muted); font-size: 12px; line-height: 1.15; }
  form { margin-top: 18px; border-top: 1px dashed var(--line2); padding-top: 16px; }
  label { display: block; color: var(--muted); margin-bottom: 8px; }
  .prompt { display: flex; align-items: center; gap: 8px; border: 1px solid var(--line2); padding: 9px 10px; }
  .prompt:focus-within { border-color: var(--accent); }
  .prompt span { color: var(--accent); }
  input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text); font: inherit; letter-spacing: .2em; caret-color: var(--accent); }
  button {
    margin-top: 12px; width: 100%; padding: 9px; cursor: pointer;
    font: 700 12px/1 "Silkscreen", monospace; letter-spacing: .12em;
    color: var(--panel); background: var(--accent); border: 1px solid var(--accent);
  }
  button:hover { filter: brightness(1.08); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .error { margin: 10px 0 0; color: var(--down); }
  footer { margin-top: 10px; color: var(--muted); font-size: 11px; text-align: center; }
  @media (prefers-reduced-motion: no-preference) { .blink { animation: blink 1.1s steps(1) infinite; } }
  @keyframes blink { 50% { opacity: 0; } }
</style>
</head>
<body>
<main>
  <div class="card">
    <div class="bar"><span>termeow.trade</span><span><b>●</b> locked</span></div>
    <canvas id="brand" aria-label="TERMEOW" role="img"></canvas>
    <pre class="cat" aria-hidden="true"> /\\_/\\
( o.o )  monad trading desk
 &gt; ^ &lt;   private preview</pre>
    <form method="post" action="/__gate">
      <input type="hidden" name="next" value="${escape(next)}">
      <label for="password">&gt; enter passphrase<span class="blink">_</span></label>
      <div class="prompt"><span>$</span><input id="password" name="password" type="password" autocomplete="current-password" autofocus required></div>
      ${error ? `<p class="error" role="alert">! ${escape(error)}</p>` : ""}
      <button type="submit">[ UNLOCK ]</button>
    </form>
  </div>
  <footer>access is cookie-scoped to this browser for 30 days</footer>
</main>
<script>
(() => {
  const canvas = document.getElementById("brand");
  const ctx = canvas.getContext("2d");
  const glyphs = "+*#%@";
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let w = 0, h = 0, mask = null;
  const rgb = () => getComputedStyle(document.documentElement).getPropertyValue("--glyph").trim();
  function resize() {
    const box = canvas.getBoundingClientRect(), ratio = Math.min(devicePixelRatio || 1, 2);
    w = Math.max(1, Math.round(box.width)); h = Math.max(1, Math.round(box.height));
    canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const sample = document.createElement("canvas"); sample.width = w; sample.height = h;
    const s = sample.getContext("2d", { willReadFrequently: true });
    s.fillStyle = "#fff"; s.font = "700 " + Math.floor(h * .86) + "px Silkscreen, monospace"; s.textBaseline = "middle";
    s.fillText("TERMEOW", 0, h * .52, w);
    mask = s.getImageData(0, 0, w, h).data;
  }
  function draw(time) {
    if (!mask) return;
    const color = rgb();
    ctx.clearRect(0, 0, w, h);
    ctx.font = "700 " + Math.floor(h * .82) + "px Silkscreen, monospace"; ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(" + color + ",.22)"; ctx.fillText("TERMEOW", 0, h * .53, w);
    ctx.font = '7px "Cascadia Mono", monospace'; ctx.textBaseline = "top";
    const tick = Math.floor((time || 0) / 170);
    for (let y = 1; y < h - 2; y += 5) for (let x = 1; x < w - 2; x += 4) {
      if (mask[(y * w + x) * 4 + 3] < 90) continue;
      const n = (x * 7 + y * 13 + tick * 3) % 23;
      ctx.fillStyle = "rgba(" + color + "," + (n < 3 ? .95 : .6) + ")";
      ctx.fillText(glyphs[(x + y + tick) % glyphs.length], x, y);
    }
    if (!reduced) requestAnimationFrame(draw);
  }
  addEventListener("resize", () => { resize(); if (reduced) draw(0); });
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => { resize(); draw(0); });
})();
</script>
</body>
</html>`;
}
