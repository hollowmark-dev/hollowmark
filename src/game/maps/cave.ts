/* Cellular-automata cave generator. Produces an organic, non-boxy cavern:
   an irregular wall boundary with pillars and alcoves, plus a player-reachable
   floor region. Terrain lives on a vertex grid so the existing Wang autotiler
   renders clean transitions straight from it. */

export interface Cave {
  cols: number; rows: number; ts: number; worldW: number; worldH: number;
  vertAt(vx: number, vy: number): number;   // 1 = wall, 0 = floor
  walkable(x: number, y: number): boolean;   // world coords → standable floor tile
  floorCells: { x: number; y: number }[];    // centers of reachable open tiles
  spawn: { x: number; y: number };
}

const FILL = 0.45;       // initial wall probability
const ITERS = 5;         // smoothing passes
const MIN_OPEN = 0.30;   // require ≥30% of tiles reachable, else re-roll

export function generateCave(cols: number, rows: number, ts: number): Cave {
  const VW = cols + 1, VH = rows + 1;
  const idx = (x: number, y: number) => y * VW + x;
  const wall = new Uint8Array(VW * VH);

  function seed() {
    for (let y = 0; y < VH; y++) for (let x = 0; x < VW; x++) {
      // keep a 2-thick wall frame so the cavern never touches the world edge
      wall[idx(x, y)] = (x <= 1 || x >= VW - 2 || y <= 1 || y >= VH - 2) ? 1 : (Math.random() < FILL ? 1 : 0);
    }
  }
  function smooth() {
    const next = new Uint8Array(VW * VH);
    for (let it = 0; it < ITERS; it++) {
      for (let y = 0; y < VH; y++) for (let x = 0; x < VW; x++) {
        if (x === 0 || y === 0 || x === VW - 1 || y === VH - 1) { next[idx(x, y)] = 1; continue; }
        let n = 0;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          if (ox === 0 && oy === 0) continue;
          const nx = x + ox, ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= VW || ny >= VH || wall[idx(nx, ny)]) n++;
        }
        next[idx(x, y)] = n >= 5 ? 1 : 0;
      }
      wall.set(next);
    }
  }

  const key = (tx: number, ty: number) =>
    wall[idx(tx, ty)] * 8 + wall[idx(tx + 1, ty)] * 4 + wall[idx(tx, ty + 1)] * 2 + wall[idx(tx + 1, ty + 1)];
  const walkTile = (tx: number, ty: number) =>
    tx >= 0 && ty >= 0 && tx < cols && ty < rows && key(tx, ty) === 0;

  const sxT = Math.floor(cols / 2), syT = rows - 3;
  let floorCells: { x: number; y: number }[] = [];

  function carveSpawn() {
    for (let oy = -2; oy <= 2; oy++) for (let ox = -3; ox <= 3; ox++) {
      const vx = sxT + ox, vy = syT + oy;
      if (vx > 1 && vx < VW - 2 && vy > 1 && vy < VH - 2 && (ox * ox) / 9 + (oy * oy) / 4 <= 1) wall[idx(vx, vy)] = 0;
    }
  }
  function flood(): number {
    const seen = new Uint8Array(cols * rows);
    if (!walkTile(sxT, syT)) return 0;
    const stack = [syT * cols + sxT]; seen[stack[0]] = 1;
    const cells: { x: number; y: number }[] = [];
    while (stack.length) {
      const id = stack.pop()!; const tx = id % cols, ty = (id / cols) | 0;
      cells.push({ x: (tx + 0.5) * ts, y: (ty + 0.5) * ts });
      const ns: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (const [dx, dy] of ns) {
        const nx = tx + dx, ny = ty + dy, nid = ny * cols + nx;
        if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && !seen[nid] && walkTile(nx, ny)) { seen[nid] = 1; stack.push(nid); }
      }
    }
    floorCells = cells;
    return cells.length;
  }

  for (let attempt = 0; attempt < 40; attempt++) {
    seed(); smooth(); carveSpawn();
    if (flood() >= cols * rows * MIN_OPEN) break;
  }

  return {
    cols, rows, ts, worldW: cols * ts, worldH: rows * ts,
    vertAt: (vx, vy) => (vx < 0 || vy < 0 || vx >= VW || vy >= VH) ? 1 : wall[idx(vx, vy)],
    walkable: (x, y) => walkTile(Math.floor(x / ts), Math.floor(y / ts)),
    floorCells,
    spawn: { x: (sxT + 0.5) * ts, y: (syT + 0.5) * ts }
  };
}
