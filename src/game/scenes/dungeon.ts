/* The dungeon run — the heart of the game.
   Room → clear enemies → choose extract (bank haul) or descend (deeper, richer,
   deadlier). Die and the haul is lost to the Grave. */
import { Assets } from "../engine/loader";
import { drawTrimmed, shadow, drawActionFrame } from "../engine/sprites";
import { input, consumeAttack, consumeSkill, consumeDash, setEnabled } from "../engine/input";
import { game, CLASS_STATS, ENEMY_STATS, ACTION_TIMINGS } from "../state";
import { generateCave, type Cave } from "../maps/cave";
import { Audio } from "../engine/audio";

export interface Scene { update(dt: number): void; draw(): void }
export interface DungeonHooks { onExtract(): void; onDeath(): void; onDepthChange(d: number): void }

const TS = 56;                 // on-screen tile size
const COLS = 26, ROWS = 18;    // cavern grid (bigger than a screen → camera follows)
const WORLD_W = COLS * TS, WORLD_H = ROWS * TS;

// Wang key (NW*8+NE*4+SW*2+SE) → tileset grid [col,row]
const WANG: [number, number][] = [
  [2,1],[3,1],[2,2],[1,2],[2,0],[3,2],[0,1],[3,3],
  [1,1],[2,3],[1,0],[0,2],[3,0],[0,0],[1,3],[0,3]
];

const DIR = { down: 0, up: 1, left: 2, right: 3 };
const FACING = [ [0,1], [0,-1], [-1,0], [1,0] ]; // by dir
const MAX_DEPTH = 5;

type Biome = "crypt" | "catacombs" | "ember";
const biomeOf = (d: number): Biome => (d <= 2 ? "crypt" : d <= 4 ? "catacombs" : "ember");
const BIOME_LABEL: Record<Biome, string> = { crypt: "CRYPT", catacombs: "CATACOMBS", ember: "EMBER SANCTUM" };
const BIOME_TILES: Record<Biome, string> = { crypt: "crypt", catacombs: "catacombs", ember: "lava" };
const BIOME_PROPS: Record<Biome, string[]> = {
  crypt: ["bone-pile", "wall-torch", "crypt-chest"],
  catacombs: ["bone-pile", "wall-torch", "cursed-chest", "ghost-wisp"],
  ember: ["lava-pool", "magma-chest", "sacrificial-altar", "wall-torch"]
};
const PROP_H: Record<string, number> = {
  "bone-pile": 40, "wall-torch": 62, "crypt-chest": 48, "cursed-chest": 50,
  "ghost-wisp": 46, "lava-pool": 30, "magma-chest": 48, "sacrificial-altar": 78
};
const FLAT_PROPS = new Set(["lava-pool"]);       // drawn on the ground, no shadow
const FLOAT_PROPS = new Set(["ghost-wisp"]);     // bob, no shadow

interface Enemy {
  type: string; x: number; y: number; hp: number; maxHp: number;
  dir: number; animT: number; moving: boolean; hitFlash: number; touchCd: number;
  kx: number; ky: number;       // knockback / lunge velocity
  castCd: number; lungeCd: number; castAnimT: number;
}
interface Shot { x: number; y: number; vx: number; vy: number; t: number; dmg: number }
interface Coin { x: number; y: number; v: number; t: number; vy: number }
interface Spark { x: number; y: number; t: number }
interface DmgNum { x: number; y: number; t: number; n: number; crit: boolean }
interface Portal { x: number; y: number; kind: "extract" | "descend" }

export function createDungeon(
  ctx: CanvasRenderingContext2D, view: () => { w: number; h: number }, hooks: DungeonHooks
): Scene & { enter(): void; debug(): unknown } {
  const player = {
    x: WORLD_W / 2, y: WORLD_H / 2, dir: DIR.up, animT: 0, atkCd: 0, hurtFlash: 0,
    action: null as null | { kind: "attack" | "skill" | "dash"; t: number; dur: number },
    cdSkill: 0, cdDash: 0, iframe: 0, dvx: 0, dvy: 0
  };
  let enemies: Enemy[] = [];
  let projectiles: { x: number; y: number; vx: number; vy: number; t: number; dmg: number; hit: Set<Enemy>; kind: string; home?: boolean; aoe?: number; range?: number; traveled?: number }[] = [];
  let foeShots: Shot[] = [];   // enemy projectiles (cultist casts) that hit the player
  let rangeRing = { t: 99, r: 0 };  // ground range indicator shown on a ranged attack
  let coins: Coin[] = [];
  let sparks: Spark[] = [];
  let dmgs: DmgNum[] = [];
  let portals: Portal[] = [];
  let props: { x: number; y: number; key: string; h: number; bob: number }[] = [];
  const slashes: { x: number; y: number; ang: number; t: number; flip: boolean }[] = [];
  let cleared = false;
  let time = 0;
  let biome: Biome = "crypt";
  let cave: Cave = generateCave(COLS, ROWS, TS);
  const cam = { x: 0, y: 0 };

  function enemiesForDepth(d: number): string[] {
    if (d >= MAX_DEPTH) return ["warden", "cultist", "skeleton", "skeleton"];
    const list: string[] = [];
    const sk = 2 + Math.floor(d * 0.7);
    const ho = Math.max(0, d - 1);
    const cu = d >= 3 ? d - 2 : 0;        // ranged cultists from depth 3
    for (let i = 0; i < sk; i++) list.push("skeleton");
    for (let i = 0; i < ho; i++) list.push("hound");
    for (let i = 0; i < cu; i++) list.push("cultist");
    return list;
  }

  function spawnRoom() {
    enemies = []; projectiles = []; foeShots = []; coins = []; sparks = []; dmgs = []; portals = []; props = []; slashes.length = 0;
    cleared = false;
    player.action = null; player.cdSkill = 0; player.cdDash = 0; player.iframe = 0; player.dvx = 0; player.dvy = 0;
    biome = biomeOf(game.run.depth);
    cave = generateCave(COLS, ROWS, TS);
    player.x = cave.spawn.x; player.y = cave.spawn.y; player.dir = DIR.up;

    // candidate floor cells, far enough from the spawn that you aren't ambushed instantly
    const cells = cave.floorCells.filter((c) => Math.hypot(c.x - player.x, c.y - player.y) > 220);
    const take = () => (cells.length ? cells.splice((Math.random() * cells.length) | 0, 1)[0] : { x: player.x, y: player.y - 200 });

    for (const t of enemiesForDepth(game.run.depth)) {
      const st = ENEMY_STATS[t];
      const c = take();
      enemies.push({ type: t, x: c.x, y: c.y, hp: st.hp, maxHp: st.hp, dir: DIR.down, animT: Math.random(), moving: false, hitFlash: 0, touchCd: 0, kx: 0, ky: 0, castCd: 1 + Math.random() * 1.5, lungeCd: 1 + Math.random() * 2, castAnimT: 0 });
    }

    // scatter biome decoration across remaining open cells
    const set = BIOME_PROPS[biome];
    const n = 6 + ((Math.random() * 5) | 0);
    for (let i = 0; i < n && cells.length; i++) {
      const c = cells.splice((Math.random() * cells.length) | 0, 1)[0];
      const key = set[(Math.random() * set.length) | 0];
      props.push({ x: c.x, y: c.y, key, h: PROP_H[key] ?? 48, bob: Math.random() * Math.PI * 2 });
    }
  }

  function enter() {
    spawnRoom();
    setEnabled(true);
    hooks.onDepthChange(game.run.depth);
  }

  const clampW = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  // move with per-axis wall collision so bodies slide along cavern walls
  function moveActor(o: { x: number; y: number }, dx: number, dy: number) {
    if (cave.walkable(o.x + dx, o.y)) o.x += dx;
    if (cave.walkable(o.x, o.y + dy)) o.y += dy;
  }

  const setAction = (kind: "attack" | "skill" | "dash") => {
    player.action = { kind, t: 0, dur: ACTION_TIMINGS[game.classKey][kind] };
  };

  function nearestEnemy(x: number, y: number): Enemy | null {
    let best: Enemy | null = null, bd = 1e9;
    for (const e of enemies) { const d = Math.hypot(e.x - x, e.y - y); if (d < bd) { bd = d; best = e; } }
    return best;
  }
  const faceFrom = (fx: number, fy: number) => {
    player.dir = Math.abs(fx) > Math.abs(fy) ? (fx > 0 ? DIR.right : DIR.left) : (fy > 0 ? DIR.down : DIR.up);
  };

  function hurtEnemy(e: Enemy, dmg: number, fromX: number, fromY: number, kb = 150, crit = false) {
    e.hp -= dmg; e.hitFlash = 0.18; Audio.sfx("hit");
    const dx = e.x - fromX, dy = (e.y - 24) - fromY, d = Math.hypot(dx, dy) || 1;
    e.kx += (dx / d) * kb; e.ky += (dy / d) * kb;
    sparks.push({ x: e.x, y: e.y - 24, t: 0 });
    dmgs.push({ x: e.x, y: e.y - 50, t: 0, n: dmg, crit });
  }

  function playerSkill() {
    const cs = CLASS_STATS[game.classKey];
    const dm = game.run.dmgMult ?? 1;          // Whetstone boon
    player.cdSkill = ACTION_TIMINGS[game.classKey].cd.skill;
    setAction("skill");
    const cls = game.classKey;
    if (cls === "knight") {
      // Shield Bash — radial AoE + heavy knockback
      for (const e of enemies) if (Math.hypot(e.x - player.x, e.y - player.y) < 130)
        hurtEnemy(e, Math.round(cs.atkDmg * 1.6 * dm), player.x, player.y - 24, 360);
    } else if (cls === "mage") {
      // Fireball — homing AoE bolt that locks onto the nearest foe
      const tgt = nearestEnemy(player.x, player.y);
      const f2 = FACING[player.dir];
      const a = tgt ? Math.atan2((tgt.y - 24) - (player.y - 30), tgt.x - player.x) : Math.atan2(f2[1], f2[0]);
      faceFrom(Math.cos(a), Math.sin(a));
      const sp = 430;
      rangeRing = { t: 0, r: 380 };
      projectiles.push({ x: player.x + Math.cos(a) * 16, y: player.y - 30 + Math.sin(a) * 16, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t: 0, dmg: Math.round(cs.atkDmg * 2.2 * dm), hit: new Set(), kind: "fireball", home: true, aoe: 95, range: 380, traveled: 0 });
    } else if (cls === "assassin") {
      // Backstab — blink behind nearest enemy, guaranteed big crit
      let best: Enemy | null = null, bd = 1e9;
      for (const e of enemies) { const d = Math.hypot(e.x - player.x, e.y - player.y); if (d < bd) { bd = d; best = e; } }
      if (best) {
        const ang = Math.atan2(best.y - player.y, best.x - player.x);
        const bx = best.x + Math.cos(ang) * 40, by = best.y + Math.sin(ang) * 40;
        if (cave.walkable(bx, by)) { player.x = bx; player.y = by; }
        hurtEnemy(best, Math.round(cs.atkDmg * 3 * dm), player.x, player.y - 24, 80, true);
        player.iframe = Math.max(player.iframe, 0.3);
      }
    } else {
      // Archer Multi-Shot — 3-arrow fan toward the locked target
      const tgt = nearestEnemy(player.x, player.y);
      const f = FACING[player.dir];
      const base = tgt ? Math.atan2((tgt.y - 24) - (player.y - 28), tgt.x - player.x) : Math.atan2(f[1], f[0]);
      faceFrom(Math.cos(base), Math.sin(base));
      for (const off of [-0.26, 0, 0.26]) {
        const a = base + off, sp = 600;
        projectiles.push({ x: player.x, y: player.y - 28, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t: 0, dmg: Math.round(cs.atkDmg * 1.2 * dm), hit: new Set(), kind: "arrow" });
      }
    }
    Audio.sfx("skill");
    navigator.vibrate?.(18);
  }

  function playerDash() {
    const t = ACTION_TIMINGS[game.classKey];
    player.cdDash = t.cd.dash;
    setAction("dash");
    player.iframe = t.dash + 0.06;
    const f = FACING[player.dir];
    const sp = 720;
    player.dvx = f[0] * sp; player.dvy = f[1] * sp;
    Audio.sfx("dash");
    navigator.vibrate?.(10);
  }

  function playerAttack() {
    const cs = CLASS_STATS[game.classKey];
    const dm = game.run.dmgMult ?? 1;          // Whetstone boon
    player.atkCd = cs.atkCd;
    setAction("attack");
    const f = FACING[player.dir];

    if (cs.ranged) {
      // auto-lock only a foe INSIDE the attack range; flash the range ring
      const near = nearestEnemy(player.x, player.y);
      const tgt = near && Math.hypot(near.x - player.x, near.y - player.y) <= cs.atkRange ? near : null;
      const a = tgt ? Math.atan2((tgt.y - 24) - (player.y - 30), tgt.x - player.x) : Math.atan2(f[1], f[0]);
      faceFrom(Math.cos(a), Math.sin(a));
      rangeRing = { t: 0, r: cs.atkRange };
      const isMage = game.classKey === "mage";
      Audio.sfx(isMage ? "cast" : "bow");
      const sp = isMage ? 560 : 700;
      const dmg = Math.round(cs.atkDmg * (isMage ? 1.25 : 1.8) * (0.92 + Math.random() * 0.16) * dm);
      projectiles.push({ x: player.x + Math.cos(a) * 18, y: player.y - 30 + Math.sin(a) * 14, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t: 0, dmg, hit: new Set(), kind: isMage ? "bolt" : "arrow", home: !!tgt, range: cs.atkRange, traveled: 0 });
      navigator.vibrate?.(10);
      return;
    }

    const ox = player.x + f[0] * 34, oy = player.y - 26 + f[1] * 30;
    const ang = Math.atan2(f[1], f[0]);
    slashes.push({ x: ox, y: oy, ang, t: 0, flip: player.dir === DIR.left });
    Audio.sfx("melee");
    // assassin lunges in with the strike
    if (game.classKey === "assassin") { player.dvx += f[0] * 300; player.dvy += f[1] * 300; player.iframe = Math.max(player.iframe, 0.12); }
    let hit = 0;
    for (const e of enemies) {
      const dx = e.x - player.x, dy = (e.y - 24) - (player.y - 24);
      const d = Math.hypot(dx, dy);
      if (d > cs.atkRange) continue;
      const dot = (dx / (d || 1)) * f[0] + (dy / (d || 1)) * f[1];
      if (dot < 0.15 && d > 30) continue; // must be roughly in front (or point-blank)
      const crit = Math.random() < 0.18;
      const dmg = Math.round(cs.atkDmg * (crit ? 1.8 : 1) * (0.85 + Math.random() * 0.3) * dm);
      e.hp -= dmg; e.hitFlash = 0.18;
      e.kx += (dx / (d || 1)) * 150; e.ky += (dy / (d || 1)) * 150;
      sparks.push({ x: e.x, y: e.y - 24, t: 0 });
      dmgs.push({ x: e.x, y: e.y - 50, t: 0, n: dmg, crit });
      hit++;
    }
    if (hit) navigator.vibrate?.(12);
  }

  function killEnemy(e: Enemy) {
    const st = ENEMY_STATS[e.type];
    const drops = e.type === "warden" ? 8 : 1 + (Math.random() < 0.5 ? 1 : 0);
    const per = Math.max(1, Math.round(st.coin / drops));
    for (let i = 0; i < drops; i++) {
      coins.push({ x: e.x + (Math.random() - 0.5) * 30, y: e.y - 18, v: per, t: 0, vy: -90 - Math.random() * 70 });
    }
  }

  function update(dt: number) {
    time += dt;
    rangeRing.t += dt;
    const cs = CLASS_STATS[game.classKey];
    const v = view();

    // ---- player timers ----
    player.atkCd = Math.max(0, player.atkCd - dt);
    player.cdSkill = Math.max(0, player.cdSkill - dt);
    player.cdDash = Math.max(0, player.cdDash - dt);
    player.iframe = Math.max(0, player.iframe - dt);
    player.hurtFlash = Math.max(0, player.hurtFlash - dt);
    if (player.action) { player.action.t += dt; if (player.action.t >= player.action.dur) player.action = null; }

    // ---- player movement ----
    let vx = input.x, vy = input.y;
    const mag = Math.hypot(vx, vy);
    if (mag > 0.01) {
      vx /= mag; vy /= mag;
      player.dir = Math.abs(vx) > Math.abs(vy) ? (vx > 0 ? DIR.right : DIR.left) : (vy > 0 ? DIR.down : DIR.up);
      const sp = cs.speed * Math.min(1, mag);
      moveActor(player, vx * sp * dt, vy * sp * dt);
      player.animT += dt;
    }
    if (player.dvx || player.dvy) { // dash burst
      moveActor(player, player.dvx * dt, player.dvy * dt);
      player.dvx *= 0.86; player.dvy *= 0.86;
      if (Math.hypot(player.dvx, player.dvy) < 24) { player.dvx = 0; player.dvy = 0; }
    }
    // ---- actions ----
    if (consumeAttack() && player.atkCd <= 0) playerAttack();
    if (consumeSkill() && player.cdSkill <= 0) playerSkill();
    if (consumeDash() && player.cdDash <= 0) playerDash();

    // ---- enemies ----
    for (const e of enemies) {
      const st = ENEMY_STATS[e.type];
      e.hitFlash = Math.max(0, e.hitFlash - dt);
      e.touchCd = Math.max(0, e.touchCd - dt);
      e.castCd = Math.max(0, e.castCd - dt);
      e.lungeCd = Math.max(0, e.lungeCd - dt);
      e.castAnimT = Math.max(0, e.castAnimT - dt);
      moveActor(e, e.kx * dt, e.ky * dt); // knockback / lunge velocity
      e.kx *= 0.82; e.ky *= 0.82;
      const dx = player.x - e.x, dy = player.y - e.y;
      const d = Math.hypot(dx, dy) || 1;
      e.moving = false;
      const facePlayer = () => { e.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? DIR.right : DIR.left) : (dy > 0 ? DIR.down : DIR.up); };

      if (e.type === "cultist") {
        // ranged caster: kite to a comfortable range, then hurl a bolt
        if (d < st.aggro) {
          facePlayer();
          let mx = 0, my = 0;
          if (d < 210) { mx = -dx / d; my = -dy / d; }          // back away
          else if (d > 320) { mx = dx / d; my = dy / d; }        // close in
          else { mx = -dy / d * 0.5; my = dx / d * 0.5; }        // strafe
          if (mx || my) { moveActor(e, mx * st.speed * dt, my * st.speed * dt); e.moving = true; e.animT += dt; }
          if (e.castCd <= 0 && d < 380) {
            e.castCd = 2.2; e.castAnimT = 0.5;
            const a = Math.atan2(dy, dx), sp = 300;
            foeShots.push({ x: e.x, y: e.y - 30, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t: 0, dmg: 11 });
          }
        }
      } else {
        // melee chasers
        if (d < st.aggro && d > 26) {
          moveActor(e, (dx / d) * st.speed * dt, (dy / d) * st.speed * dt);
          facePlayer(); e.moving = true; e.animT += dt;
        }
        // lunge — a quick dash that suddenly closes the gap (all melee foes have one)
        if ((e.type === "hound" || e.type === "warden" || e.type === "skeleton") && e.lungeCd <= 0 && d < 260 && d > 48) {
          e.lungeCd = e.type === "hound" ? 2.0 : e.type === "skeleton" ? 3.0 : 3.2;
          const power = e.type === "hound" ? 480 : e.type === "skeleton" ? 300 : 380;
          e.kx += (dx / d) * power; e.ky += (dy / d) * power; facePlayer();
        }
      }

      // contact damage (dash i-frames make you briefly untouchable)
      if (d < 30 && e.touchCd <= 0 && player.iframe <= 0) {
        e.touchCd = 0.7;
        game.run.hp -= st.touchDmg; player.hurtFlash = 0.25; Audio.sfx("hurt");
        navigator.vibrate?.(20);
        if (game.run.hp <= 0) { game.run.hp = 0; setEnabled(false); hooks.onDeath(); return; }
      }
    }

    // ---- player projectiles (arrows / bolts / homing fireball) ----
    for (const p of projectiles) {
      if (p.home) { // auto-lock: steer toward the nearest foe
        const tgt = nearestEnemy(p.x, p.y);
        if (tgt) {
          const sp = Math.hypot(p.vx, p.vy) || 1;
          let diff = Math.atan2((tgt.y - 24) - p.y, tgt.x - p.x) - Math.atan2(p.vy, p.vx);
          while (diff > Math.PI) diff -= 2 * Math.PI; while (diff < -Math.PI) diff += 2 * Math.PI;
          const ang = Math.atan2(p.vy, p.vx) + Math.max(-7 * dt, Math.min(7 * dt, diff));
          p.vx = Math.cos(ang) * sp; p.vy = Math.sin(ang) * sp;
        }
      }
      p.t += dt; const sx = p.vx * dt, sy = p.vy * dt; p.x += sx; p.y += sy;
      if (p.range != null) p.traveled = (p.traveled ?? 0) + Math.hypot(sx, sy);
      for (const e of enemies) {
        if (p.hit.has(e)) continue;
        if (Math.hypot(e.x - p.x, (e.y - 24) - p.y) < (p.aoe ? 32 : 28)) {
          p.hit.add(e); hurtEnemy(e, p.dmg, p.x, p.y, 140);
          if (p.aoe) { // fireball detonation
            Audio.sfx("fireball");
            for (const e2 of enemies) if (e2 !== e && Math.hypot(e2.x - p.x, e2.y - p.y) < p.aoe) hurtEnemy(e2, Math.round(p.dmg * 0.55), p.x, p.y, 110);
            for (let i = 0; i < 3; i++) sparks.push({ x: p.x + (Math.random() - 0.5) * 40, y: p.y - 10 + (Math.random() - 0.5) * 30, t: 0 });
            p.t = 99;
          }
        }
      }
    }
    projectiles = projectiles.filter((p) => p.t < 1.4 && cave.walkable(p.x, p.y) && (p.range == null || (p.traveled ?? 0) < p.range));

    // ---- enemy shots (cultist casts) hit the player ----
    for (const s of foeShots) {
      s.t += dt; s.x += s.vx * dt; s.y += s.vy * dt;
      if (player.iframe <= 0 && Math.hypot(s.x - player.x, s.y - (player.y - 24)) < 22) {
        s.t = 99; game.run.hp -= s.dmg; player.hurtFlash = 0.32; Audio.sfx("hurt"); navigator.vibrate?.(22);
        if (game.run.hp <= 0) { game.run.hp = 0; setEnabled(false); hooks.onDeath(); return; }
      }
    }
    foeShots = foeShots.filter((s) => s.t < 2.2 && cave.walkable(s.x, s.y));

    enemies = enemies.filter((e) => { if (e.hp <= 0) { killEnemy(e); return false; } return true; });

    // ---- coins ----
    for (const c of coins) {
      c.t += dt;
      if (c.t < 0.45) { c.vy += 300 * dt; c.y += c.vy * dt; } // brief pop, then rest
      const d = Math.hypot(c.x - player.x, c.y - (player.y - 16));
      if (c.t > 0.25 && d < 120) { // magnet
        c.x += (player.x - c.x) * Math.min(1, dt * 8);
        c.y += ((player.y - 16) - c.y) * Math.min(1, dt * 8);
      }
    }
    coins = coins.filter((c) => {
      const d = Math.hypot(c.x - player.x, c.y - (player.y - 16));
      if (d < 26) { game.run.haul += Math.round(c.v * (game.run.coinMult ?? 1)); Audio.sfx("coin"); return false; }
      return true;
    });

    // ---- fx ----
    for (const s of slashes) s.t += dt;
    for (const s of sparks) s.t += dt;
    for (const dn of dmgs) { dn.t += dt; dn.y -= 26 * dt; }
    while (slashes.length && slashes[0].t > 0.22) slashes.shift();
    sparks = sparks.filter((s) => s.t < 0.34);
    dmgs = dmgs.filter((d) => d.t < 0.7);

    // ---- room clear → portals ----
    if (!cleared && enemies.length === 0) {
      cleared = true;
      const far = cave.floorCells
        .filter((c) => Math.hypot(c.x - player.x, c.y - player.y) > 200)
        .sort(() => Math.random() - 0.5);
      const at = (i: number) => far[i] ?? cave.floorCells[0] ?? { x: player.x, y: player.y - 150 };
      const e = at(0);
      portals.push({ x: e.x, y: e.y, kind: "extract" });
      if (game.run.depth < MAX_DEPTH) {
        // descend portal: far from the extract one so the choice is deliberate
        const d = far.find((c) => Math.hypot(c.x - e.x, c.y - e.y) > 260) ?? at(1);
        portals.push({ x: d.x, y: d.y, kind: "descend" });
      }
    }
    for (const p of portals) {
      if (Math.hypot(p.x - player.x, p.y - player.y) < 38) {
        if (p.kind === "extract") { setEnabled(false); hooks.onExtract(); return; }
        game.run.depth += 1; spawnRoom(); hooks.onDepthChange(game.run.depth); return;
      }
    }

    // ---- camera ----
    cam.x = clampW(player.x - v.w / 2, 0, Math.max(0, WORLD_W - v.w));
    cam.y = clampW(player.y - v.h / 2 - 30, 0, Math.max(0, WORLD_H - v.h));
    if (WORLD_W < v.w) cam.x = (WORLD_W - v.w) / 2;
    if (WORLD_H < v.h) cam.y = (WORLD_H - v.h) / 2;
  }

  /* ---------------- draw ---------------- */
  const strip = (img: HTMLImageElement, frame: number, frames: number, dx: number, dy: number, dw: number, dh: number) => {
    if (!img?.width) return;
    const fw = img.width / frames;
    ctx.drawImage(img, frame * fw, 0, fw, img.height, dx, dy, dw, dh);
  };
  const fxFrame = (speed = 6, off = 0) => ((time * speed + off) | 0) % 4;

  function drawTiles(v: { w: number; h: number }) {
    const ts = Assets.biomeTiles[BIOME_TILES[biome]] ?? Assets.tileset;
    if (!ts?.width) return;
    const c0 = Math.max(0, Math.floor(cam.x / TS)), c1 = Math.min(COLS - 1, Math.ceil((cam.x + v.w) / TS));
    const r0 = Math.max(0, Math.floor(cam.y / TS)), r1 = Math.min(ROWS - 1, Math.ceil((cam.y + v.h) / TS));
    for (let ty = r0; ty <= r1; ty++) {
      for (let tx = c0; tx <= c1; tx++) {
        const key = cave.vertAt(tx, ty) * 8 + cave.vertAt(tx + 1, ty) * 4 + cave.vertAt(tx, ty + 1) * 2 + cave.vertAt(tx + 1, ty + 1);
        const [sc, sr] = WANG[key];
        ctx.drawImage(ts, sc * 32, sr * 32, 32, 32, tx * TS - cam.x, ty * TS - cam.y, TS + 1, TS + 1);
      }
    }
  }

  function drawProp(p: { x: number; y: number; key: string; h: number; bob: number }) {
    const img = Assets.props[p.key];
    if (!img?.width) return;
    const cx = p.x - cam.x;
    let footY = p.y - cam.y;
    if (FLOAT_PROPS.has(p.key)) footY += Math.sin(time * 2 + p.bob) * 5 - 14;
    else if (!FLAT_PROPS.has(p.key)) shadow(ctx, cx, footY, p.h * 0.32);
    drawTrimmed(ctx, img, cx, footY, p.h, false, FLOAT_PROPS.has(p.key) ? 0.85 : 1);
    if (p.key === "wall-torch" && Assets.torch?.width) {
      const s = p.h * 0.5;
      strip(Assets.torch, fxFrame(9, p.x), 4, cx - s / 2, footY - p.h - s * 0.3, s, s * 1.2);
    }
  }

  function drawEnemy(e: Enemy) {
    const sp = Assets.enemies[e.type];
    const st = ENEMY_STATS[e.type];
    if (!sp) return;
    const cx = e.x - cam.x, footY = e.y - cam.y;
    shadow(ctx, cx, footY, st.targetH * 0.3);
    let img: HTMLImageElement;
    if (e.castAnimT > 0 && sp.cast && sp.cast.length) {
      img = sp.cast[Math.min(sp.cast.length - 1, (((0.5 - e.castAnimT) / 0.5) * sp.cast.length) | 0)];
    } else if (e.moving && sp.walk[e.dir]?.length) {
      const wf = sp.walk[e.dir]; img = wf[((e.animT * 8) | 0) % wf.length];
    } else img = sp.idle[e.dir];
    drawTrimmed(ctx, img, cx, footY, st.targetH);
    if (e.hitFlash > 0) { // quick teal hit overlay
      ctx.globalAlpha = e.hitFlash * 2.2; ctx.fillStyle = "#9fe9da";
      ctx.fillRect(cx - 3, footY - st.targetH, 6, st.targetH); ctx.globalAlpha = 1;
    }
    // hp bar
    if (e.hp < e.maxHp) {
      const w = Math.max(28, st.targetH * 0.42), top = footY - st.targetH - 10;
      ctx.fillStyle = "rgba(0,0,0,.7)"; ctx.fillRect(cx - w / 2, top, w, 5);
      ctx.fillStyle = e.type === "warden" ? "#d96a5a" : e.type === "cultist" ? "#c79bff" : "#7aa86a";
      ctx.fillRect(cx - w / 2, top, w * (e.hp / e.maxHp), 5);
    }
  }

  const HERO_H = 104;
  function drawPlayer() {
    const cx = player.x - cam.x, footY = player.y - cam.y;
    const h = Assets.heroes[game.classKey];
    shadow(ctx, cx, footY, 24);
    if (!h) return;
    let alpha = 1;
    if (player.iframe > 0) alpha = 0.6;
    if (player.hurtFlash > 0 && (time * 20 | 0) % 2) alpha = 0.5;
    const act = player.action;
    // directional attack POSE for heroes that have real N/E/W attack anims
    if (act?.kind === "attack" && h.attack4 && h.attack[player.dir]?.length) {
      drawActionFrame(ctx, h.attack[player.dir], act.t / act.dur, cx, footY, HERO_H, false, alpha);
      return;
    }
    // otherwise render the correct-facing walk/idle frame (so nothing snaps to the
    // wrong way); attack/dash read via a lunge offset + FX.
    const moving = input.x !== 0 || input.y !== 0 || (act?.kind === "dash");
    const wf = h.walk[player.dir];
    const img = (moving && wf && wf.length) ? wf[((player.animT * 8) | 0) % wf.length] : h.idle[player.dir];
    let ox = 0, oy = 0;
    if (act?.kind === "attack" && !CLASS_STATS[game.classKey].ranged) {
      const f = FACING[player.dir], pulse = Math.sin(Math.min(1, act.t / act.dur) * Math.PI) * 10;
      ox = f[0] * pulse; oy = f[1] * pulse;
    }
    if (act?.kind === "dash") drawTrimmed(ctx, img, cx - player.dvx * 0.035, footY - player.dvy * 0.02, HERO_H, false, 0.26);
    drawTrimmed(ctx, img, cx + ox, footY + oy, HERO_H, false, alpha);
  }

  function drawSlashes() {
    for (const s of slashes) {
      const a = 1 - s.t / 0.22, sz = 84;
      ctx.save();
      ctx.globalAlpha = Math.max(0, a);
      ctx.translate(s.x - cam.x, s.y - cam.y);
      ctx.rotate(s.ang);
      if (s.flip) ctx.scale(1, -1);
      if (Assets.slash?.width) ctx.drawImage(Assets.slash, -sz / 2, -sz / 2, sz, sz);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function draw() {
    const v = view();
    ctx.clearRect(0, 0, v.w, v.h);
    ctx.fillStyle = "#070a09"; ctx.fillRect(0, 0, v.w, v.h);
    drawTiles(v);

    // flat ground decals (lava pools) render beneath everything
    for (const p of props) if (FLAT_PROPS.has(p.key)) drawProp(p);

    // ranged attack range ring (ground indicator under the player)
    if (rangeRing.t < 0.6) {
      const a = (1 - rangeRing.t / 0.6) * 0.5;
      ctx.save();
      ctx.strokeStyle = `rgba(111,217,200,${a})`;
      ctx.lineWidth = 2; ctx.setLineDash([9, 7]);
      ctx.beginPath();
      ctx.ellipse(player.x - cam.x, player.y - cam.y - 6, rangeRing.r, rangeRing.r * 0.42, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // depth-sorted actors + standing props
    const items: { y: number; fn: () => void }[] = [];
    for (const e of enemies) items.push({ y: e.y, fn: () => drawEnemy(e) });
    for (const p of props) if (!FLAT_PROPS.has(p.key)) items.push({ y: p.y, fn: () => drawProp(p) });
    items.push({ y: player.y, fn: drawPlayer });
    for (const c of coins) items.push({ y: c.y, fn: () => { if (Assets.coin?.width) ctx.drawImage(Assets.coin, c.x - cam.x - 12, c.y - cam.y - 12 + Math.sin(time * 6 + c.x) * 2, 24, 24); } });
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.fn();

    drawSlashes();
    // player projectiles (arrow / bolt sprites + fireball orb)
    for (const p of projectiles) {
      if (p.kind === "fireball") {
        const r = 12 + Math.sin(time * 22) * 2;
        ctx.save(); ctx.translate(p.x - cam.x, p.y - cam.y);
        ctx.shadowColor = "#ff8a3d"; ctx.shadowBlur = 16;
        const g = ctx.createRadialGradient(0, 0, 2, 0, 0, r);
        g.addColorStop(0, "#fff1c2"); g.addColorStop(0.5, "#ff8a3d"); g.addColorStop(1, "rgba(217,53,53,.15)");
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        continue;
      }
      const img = p.kind === "bolt" ? Assets.bolt : Assets.arrow;
      ctx.save();
      ctx.translate(p.x - cam.x, p.y - cam.y);
      ctx.rotate(Math.atan2(p.vy, p.vx));
      if (img?.width) { const s = 0.72; ctx.drawImage(img, -img.width * s / 2, -img.height * s / 2, img.width * s, img.height * s); }
      else { ctx.fillStyle = "#9fe9da"; ctx.fillRect(-11, -2, 22, 4); }
      ctx.restore();
    }
    // enemy casts (cultist) — glowing purple orbs
    for (const s of foeShots) {
      ctx.save();
      ctx.translate(s.x - cam.x, s.y - cam.y);
      ctx.shadowColor = "#c79bff"; ctx.shadowBlur = 10; ctx.fillStyle = "#d9c2ff";
      ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    ctx.shadowBlur = 0;
    for (const s of sparks) { const f = Math.min(3, (s.t / 0.34) * 4) | 0; strip(Assets.spark, f, 1, s.x - cam.x - 24, s.y - cam.y - 24, 48, 48); }

    // portals
    for (const p of portals) {
      const img = p.kind === "extract" ? Assets.portalTeal : Assets.portalPurple;
      const sz = 120;
      strip(img, fxFrame(6, p.kind === "extract" ? 0 : 2), 4, p.x - cam.x - sz / 2, p.y - cam.y - sz * 0.62, sz, sz);
      ctx.font = "700 13px 'Pixel Operator Mono', monospace"; ctx.textAlign = "center";
      ctx.fillStyle = p.kind === "extract" ? "#6fd9c8" : "#c79bff";
      ctx.fillText(p.kind === "extract" ? "▲ EXTRACT" : "▼ DESCEND", p.x - cam.x, p.y - cam.y + 34);
    }

    // damage numbers
    ctx.textAlign = "center";
    for (const dn of dmgs) {
      ctx.globalAlpha = Math.max(0, 1 - dn.t / 0.7);
      ctx.font = `700 ${dn.crit ? 20 : 15}px 'Pixel Operator Mono', monospace`;
      ctx.fillStyle = dn.crit ? "#f0cf85" : "#ecdfc3";
      ctx.fillText(String(dn.n), dn.x - cam.x, dn.y - cam.y);
    }
    ctx.globalAlpha = 1;

    if (player.hurtFlash > 0) { ctx.fillStyle = `rgba(162,53,53,${player.hurtFlash * 0.7})`; ctx.fillRect(0, 0, v.w, v.h); }
    drawHud(v);
  }

  function drawHud(v: { w: number; h: number }) {
    const r = game.run;
    // HP bar
    const bw = 220, bx = 16, by = 16;
    ctx.fillStyle = "rgba(6,10,9,.85)"; ctx.fillRect(bx - 4, by - 4, bw + 8, 26);
    ctx.strokeStyle = "rgba(212,170,85,.5)"; ctx.lineWidth = 1; ctx.strokeRect(bx - 4, by - 4, bw + 8, 26);
    ctx.fillStyle = "#2a0f0f"; ctx.fillRect(bx, by, bw, 18);
    ctx.fillStyle = "#a23535"; ctx.fillRect(bx, by, bw * Math.max(0, r.hp / r.maxHp), 18);
    ctx.font = "700 12px 'Pixel Operator Mono', monospace"; ctx.textAlign = "left"; ctx.fillStyle = "#ecdfc3";
    ctx.fillText(`HP ${Math.ceil(r.hp)}/${r.maxHp}`, bx + 6, by + 13);
    // skill + dash cooldown chips
    const tcfg = ACTION_TIMINGS[game.classKey], cdY = by + 28;
    const chip = (x: number, label: string, cd: number, max: number, color: string) => {
      const w = 104, h = 15;
      ctx.fillStyle = "rgba(6,10,9,.85)"; ctx.fillRect(x, cdY, w, h);
      const ready = cd <= 0;
      ctx.fillStyle = ready ? color : "rgba(212,170,85,.25)";
      ctx.fillRect(x, cdY, ready ? w : w * (1 - cd / max), h);
      ctx.fillStyle = ready ? "#06100c" : "#cdbf9c";
      ctx.font = "700 10px 'Pixel Operator Mono', monospace"; ctx.textAlign = "left";
      ctx.fillText(label, x + 6, cdY + 11);
    };
    chip(bx, "Q SKILL", player.cdSkill, tcfg.cd.skill, "#c79bff");
    chip(bx + 112, "⇧ DASH", player.cdDash, tcfg.cd.dash, "#6fd9c8");
    // depth
    ctx.textAlign = "center"; ctx.font = "700 15px 'Pixel Operator Mono', monospace";
    ctx.fillStyle = biome === "ember" ? "#d96a5a" : "#9fe9da";
    ctx.fillText(`DEPTH ${r.depth} · ${BIOME_LABEL[biome]}${r.depth >= MAX_DEPTH ? " · BOSS" : ""}`, v.w / 2, 26);
    if (cleared) {
      ctx.textAlign = "center"; ctx.fillStyle = "#ecdfc3"; ctx.font = "700 13px 'Pixel Operator Mono', monospace";
      ctx.fillText("ROOM CLEAR — step into a portal", v.w / 2, v.h - 96);
    }
  }

  const debug = () => ({
    px: Math.round(player.x), py: Math.round(player.y), cleared, enabled: input.enabled,
    biome, floorCells: cave.floorCells.length, props: props.length,
    action: player.action?.kind ?? null, cdSkill: +player.cdSkill.toFixed(2), cdDash: +player.cdDash.toFixed(2),
    iframe: +player.iframe.toFixed(2), projectiles: projectiles.length,
    enemies: enemies.map((e) => ({ x: Math.round(e.x), y: Math.round(e.y), type: e.type })),
    portals: portals.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), kind: p.kind }))
  });
  return { update, draw, enter, debug };
}
