/* Sprite helpers — shared by the player (grid sheets) and enemies (per-frame PNGs).
   Alpha-aware trimming (ported from the town demo) anchors content by horizontal
   center + lowest opaque pixel (the feet), so off-center generated art lines up. */

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(im); // resolve anyway; a broken sprite shouldn't wedge boot
    im.src = src;
  });
}

export interface Bounds { minX: number; maxX: number; minY: number; maxY: number; area: number }

function findMainAlphaBounds(data: Uint8ClampedArray, fw: number, fh: number): Bounds | null {
  const visited = new Uint8Array(fw * fh);
  const comps: Bounds[] = [];
  const stack: number[] = [];
  const alphaAt = (idx: number) => data[idx * 4 + 3];

  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const start = y * fw + x;
      if (visited[start] || alphaAt(start) <= 24) continue;
      let minX = x, maxX = x, minY = y, maxY = y, area = 0;
      visited[start] = 1;
      stack.push(start);
      while (stack.length) {
        const idx = stack.pop()!;
        const px = idx % fw;
        const py = (idx / fw) | 0;
        area++;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            const nx = px + ox, ny = py + oy;
            if (nx < 0 || nx >= fw || ny < 0 || ny >= fh) continue;
            const ni = ny * fw + nx;
            if (!visited[ni] && alphaAt(ni) > 24) { visited[ni] = 1; stack.push(ni); }
          }
        }
      }
      if (area >= 8) comps.push({ minX, maxX, minY, maxY, area });
    }
  }
  if (!comps.length) return null;
  const largest = comps.reduce((a, b) => (b.area > a.area ? b : a));
  const ex = Math.max(6, Math.round(fw * 0.08));
  const ey = Math.max(6, Math.round(fh * 0.08));
  const overlaps = (c: Bounds) =>
    c.minX <= largest.maxX + ex && c.maxX >= largest.minX - ex &&
    c.minY <= largest.maxY + ey && c.maxY >= largest.minY - ey;
  const keep = Math.max(16, largest.area * 0.08);
  const kept = comps.filter((c) => c === largest || (c.area >= keep && overlaps(c)));
  let minX = fw, maxX = 0, minY = fh, maxY = 0, area = 0;
  for (const c of kept.length ? kept : [largest]) {
    minX = Math.min(minX, c.minX); maxX = Math.max(maxX, c.maxX);
    minY = Math.min(minY, c.minY); maxY = Math.max(maxY, c.maxY);
    area += c.area;
  }
  const pad = 1;
  return { minX: Math.max(0, minX - pad), maxX: Math.min(fw, maxX + pad + 1),
           minY: Math.max(0, minY - pad), maxY: Math.min(fh, maxY + pad + 1), area };
}

/* content bbox within an image, as 0..1 ratios; cached per image */
export interface Trim { x0: number; x1: number; top: number; foot: number }
const trimCache = new WeakMap<HTMLImageElement, Trim>();
const scratch = document.createElement("canvas");
const sctx = scratch.getContext("2d", { willReadFrequently: true })!;

export function trimOf(img: HTMLImageElement): Trim {
  const hit = trimCache.get(img);
  if (hit) return hit;
  const fallback: Trim = { x0: 0, x1: 1, top: 0, foot: 1 };
  if (!img.width || !img.height) return fallback;
  scratch.width = img.width; scratch.height = img.height;
  sctx.clearRect(0, 0, img.width, img.height);
  sctx.drawImage(img, 0, 0);
  let b: Bounds | null = null;
  try { b = findMainAlphaBounds(sctx.getImageData(0, 0, img.width, img.height).data, img.width, img.height); }
  catch { b = null; }
  const t: Trim = b
    ? { x0: b.minX / img.width, x1: b.maxX / img.width, top: b.minY / img.height, foot: b.maxY / img.height }
    : fallback;
  trimCache.set(img, t);
  return t;
}

/* Draw a whole image so its trimmed content is centered on (cx) with feet at (footY),
   scaled so the visible content height equals targetH. Returns the drawn width. */
export function drawTrimmed(
  ctx: CanvasRenderingContext2D, img: HTMLImageElement,
  cx: number, footY: number, targetH: number, flip = false, alpha = 1
): number {
  if (!img.width) return 0;
  const t = trimOf(img);
  const cw = (t.x1 - t.x0) * img.width;
  const chh = Math.max(1, (t.foot - t.top) * img.height);
  const scale = targetH / chh;
  const dw = cw * scale, dh = targetH;
  const sx = t.x0 * img.width, sy = t.top * img.height;
  const sw = cw, sh = chh;
  const dx = cx - dw / 2, dy = footY - dh;
  if (alpha !== 1) ctx.globalAlpha = alpha;
  if (flip) {
    ctx.save(); ctx.translate(cx, 0); ctx.scale(-1, 1); ctx.translate(-cx, 0);
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh); ctx.restore();
  } else {
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  }
  if (alpha !== 1) ctx.globalAlpha = 1;
  return dw;
}

/* Draw one frame of an action animation (attack/skill/dash). Frames are
   south-facing only; left is the same frame horizontally flipped. t is 0..1. */
export function drawActionFrame(
  ctx: CanvasRenderingContext2D, frames: HTMLImageElement[], t: number,
  cx: number, footY: number, targetH: number, flip = false, alpha = 1
) {
  if (!frames.length) return;
  const i = Math.min(frames.length - 1, Math.max(0, Math.floor(t * frames.length)));
  drawTrimmed(ctx, frames[i], cx, footY, targetH, flip, alpha);
}

/* Centered soft shadow blob */
export function shadow(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, a = 0.34) {
  ctx.globalAlpha = a; ctx.fillStyle = "#000";
  ctx.beginPath(); ctx.ellipse(cx, cy, rx, rx * 0.34, 0, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
}

/* ---- Player grid-sheet support (existing 3-col × 4-row class sheets) ---- */
export interface FrameMeta { x0: number; x1: number; top: number; foot: number }
export function buildSheetMeta(img: HTMLImageElement, cols: number, rows: number): FrameMeta[][] {
  scratch.width = img.width; scratch.height = img.height;
  sctx.clearRect(0, 0, img.width, img.height);
  sctx.drawImage(img, 0, 0);
  const fw = Math.floor(img.width / cols), fh = Math.floor(img.height / rows);
  const out: FrameMeta[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: FrameMeta[] = [];
    for (let c = 0; c < cols; c++) {
      const data = sctx.getImageData(c * fw, r * fh, fw, fh).data;
      const b = findMainAlphaBounds(data, fw, fh);
      row.push(b ? { x0: b.minX / fw, x1: b.maxX / fw, top: b.minY / fh, foot: b.maxY / fh }
                 : { x0: 0, x1: 1, top: 0, foot: 1 });
    }
    out.push(row);
  }
  return out;
}

const WALK3 = [0, 1, 2, 1];
/* dir: 0=down 1=up 2=left 3=right (matches the town demo) */
export function drawPlayer(
  ctx: CanvasRenderingContext2D, img: HTMLImageElement, meta: FrameMeta[][],
  dir: number, moving: boolean, animT: number, cx: number, footY: number, targetH: number
) {
  const cols = 3, rows = 4;
  const fw = img.width / cols, fh = img.height / rows;
  const frame = moving ? WALK3[((animT * 7) | 0) % 4] : 1;
  const row = dir;
  const m = meta?.[row]?.[frame] ?? { x0: 0, x1: 1, top: 0, foot: 1 };
  const sx = frame * fw + m.x0 * fw, sy = row * fh + m.top * fh;
  const sw = Math.max(1, (m.x1 - m.x0) * fw), sh = Math.max(1, (m.foot - m.top) * fh);
  const scale = targetH / sh;
  const dw = sw * scale, dh = targetH;
  ctx.drawImage(img, sx, sy, sw, sh, cx - dw / 2, footY - dh, dw, dh);
}
