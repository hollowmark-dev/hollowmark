/* Central game state + localStorage persistence.
   $OBOL earned in a run is "haul"; it only banks if you extract alive. */

export interface EnemyStat {
  key: string; hp: number; speed: number; touchDmg: number;
  targetH: number; coin: number; name: string; aggro: number;
}
export const ENEMY_STATS: Record<string, EnemyStat> = {
  skeleton: { key: "skeleton", name: "Bone Skeleton",  hp: 30, speed: 56,  touchDmg: 8,  targetH: 76,  coin: 6,  aggro: 460 },
  hound:    { key: "hound",    name: "Grave Hound",    hp: 20, speed: 104, touchDmg: 7,  targetH: 64,  coin: 5,  aggro: 600 },
  cultist:  { key: "cultist",  name: "Hollow Cultist", hp: 34, speed: 64,  touchDmg: 6,  targetH: 78,  coin: 12, aggro: 560 },
  warden:   { key: "warden",   name: "Grave Warden",   hp: 180, speed: 48, touchDmg: 18, targetH: 132, coin: 60, aggro: 700 }
};

// ranged classes fire a projectile on basic attack instead of swinging
export interface ClassStat { hp: number; speed: number; atkDmg: number; atkRange: number; atkCd: number; ranged?: boolean }
export const CLASS_STATS: Record<string, ClassStat> = {
  knight:   { hp: 130, speed: 250, atkDmg: 17, atkRange: 100, atkCd: 0.42 },
  archer:   { hp: 100, speed: 300, atkDmg: 13, atkRange: 300, atkCd: 0.4,  ranged: true },
  mage:     { hp: 104, speed: 262, atkDmg: 18, atkRange: 280, atkCd: 0.52, ranged: true },
  assassin: { hp: 108, speed: 296, atkDmg: 14, atkRange: 86,  atkCd: 0.3 }
};

// action anim durations + skill/dash cooldowns, in seconds
export interface ActionTiming { attack: number; skill: number; dash: number; cd: { skill: number; dash: number } }
export const ACTION_TIMINGS: Record<string, ActionTiming> = {
  knight:   { attack: 0.4,  skill: 0.8, dash: 0.26, cd: { skill: 5, dash: 1.5 } },
  archer:   { attack: 0.42, skill: 0.9, dash: 0.3,  cd: { skill: 6, dash: 1.2 } },
  mage:     { attack: 0.45, skill: 1.0, dash: 0.22, cd: { skill: 7, dash: 2.0 } },
  assassin: { attack: 0.3,  skill: 0.7, dash: 0.24, cd: { skill: 4, dash: 1.0 } }
};

// migrate old class keys saved before the rebrand
const CLASS_ALIAS: Record<string, string> = { ranger: "archer", hexer: "mage", rogue: "assassin" };

export interface RunRecord { at: string; depth: number; haul: number; outcome: "extract" | "death" }

/* The Outfitter — off-chain flywheel SINK. Bank $OBOL by extracting, then spend it
   on consumable boons applied to your next run (one charge each, consumed on entry).
   This is the T0 stand-in for the on-chain gear/consumable market in FLYWHEEL.md. */
export interface Upgrade { name: string; price: number; blurb: string; color: string }
export const UPGRADES: Record<string, Upgrade> = {
  vigor:   { name: "Vigor Draught", price: 40, blurb: "+25 Max HP",      color: "#7aa86a" },
  edge:    { name: "Whetstone",     price: 55, blurb: "+20% damage",     color: "#d96a5a" },
  fortune: { name: "Coin Charm",    price: 35, blurb: "+25% $OBOL haul", color: "#f0cf85" }
};
export type UpgradeKey = keyof typeof UPGRADES;
export type Loadout = Record<UpgradeKey, number>;
const emptyLoadout = (): Loadout => ({ vigor: 0, edge: 0, fortune: 0 });

const LS = "gg-game-v1";
interface Persisted { balance: number; history: RunRecord[]; lastClass: string; shop: Loadout }

export const game = {
  classKey: "knight",
  balance: 0,            // banked $OBOL
  history: [] as RunRecord[],
  shop: emptyLoadout(),  // owned consumable charges (the Outfitter sink)
  wallet: null as string | null,
  chainOn: false,        // true once a real devnet wallet is driving entry/extract
  // active run (dmgMult/coinMult come from consumed boons)
  run: { active: false, depth: 1, haul: 0, hp: 100, maxHp: 100, dmgMult: 1, coinMult: 1 }
};

export function load() {
  try {
    const p = JSON.parse(localStorage.getItem(LS) || "{}") as Partial<Persisted>;
    game.balance = p.balance ?? 0;
    game.history = p.history ?? [];
    game.shop = { ...emptyLoadout(), ...(p.shop ?? {}) };
    if (p.lastClass) game.classKey = CLASS_ALIAS[p.lastClass] ?? p.lastClass;
    if (!CLASS_STATS[game.classKey]) game.classKey = "knight";
  } catch { /* ignore */ }
}
export function save() {
  try {
    const p: Persisted = { balance: game.balance, history: game.history.slice(-20), lastClass: game.classKey, shop: game.shop };
    localStorage.setItem(LS, JSON.stringify(p));
  } catch { /* ignore */ }
}

/* Buy one charge of a boon. Returns false if you can't afford it. */
export function buyUpgrade(key: UpgradeKey): boolean {
  const u = UPGRADES[key];
  if (!u || game.balance < u.price) return false;
  game.balance -= u.price;
  game.shop[key] += 1;
  save();
  return true;
}

/* Personal records for the local leaderboard (the compete-to-earn hook). */
export function bestRun(): { depth: number; haul: number; runs: number } {
  let depth = 0, haul = 0;
  for (const r of game.history) {
    depth = Math.max(depth, r.depth);
    if (r.outcome === "extract") haul = Math.max(haul, r.haul);
  }
  return { depth, haul, runs: game.history.length };
}

export function startRun() {
  const cs = CLASS_STATS[game.classKey];
  let maxHp = cs.hp, dmgMult = 1, coinMult = 1;
  // consume any owned boons into this run (one charge each)
  if (game.shop.vigor > 0)   { maxHp += 25;     game.shop.vigor -= 1; }
  if (game.shop.edge > 0)    { dmgMult *= 1.2;  game.shop.edge -= 1; }
  if (game.shop.fortune > 0) { coinMult *= 1.25; game.shop.fortune -= 1; }
  game.run = { active: true, depth: 1, haul: 0, hp: maxHp, maxHp, dmgMult, coinMult };
  save();
}
export function endRun(outcome: "extract" | "death") {
  const r = game.run;
  if (outcome === "extract") game.balance += r.haul;
  game.history.push({ at: new Date().toISOString(), depth: r.depth, haul: r.haul, outcome });
  r.active = false;
  save();
}
