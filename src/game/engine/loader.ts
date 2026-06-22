/* Asset registry + loader. Heroes and enemies load as per-direction frame arrays
   straight from the PixelLab output; everything is one consistent generated set. */
import { loadImage } from "./sprites";

const DEMO = "/assets/generated/demo/";
const DUN = "/assets/generated/dungeon/";
const CHR = "/assets/generated/characters/";
const UI = "/assets/generated/ui/";

/* dir index 0=down 1=up 2=left 3=right → PixelLab direction folder */
const DIR_NAME = ["south", "north", "west", "east"];

export const PLAYER_KEYS = ["knight", "archer", "mage", "assassin"] as const;
export type PlayerKey = (typeof PLAYER_KEYS)[number];

interface EnemyDef { base: string; cast?: boolean }
export const ENEMY_DEFS: Record<string, EnemyDef> = {
  skeleton: { base: "bone-skeleton/Bone_Skeleton" },
  hound:    { base: "grave-hound/Grave_Hound" },
  cultist:  { base: "hollow-cultist", cast: true },
  warden:   { base: "grave-warden/Grave_Warden" }
};

export interface HeroSprite {
  idle: HTMLImageElement[];      // by dir 0..3
  walk: HTMLImageElement[][];    // [dir][frame]
  attack: HTMLImageElement[][];  // [dir][frame] (falls back to south)
  attack4: boolean;              // true when real N/E/W attack poses exist
  skill: HTMLImageElement[];     // south only
  dash: HTMLImageElement[];      // south only
}
export interface EnemySprite { idle: HTMLImageElement[]; walk: HTMLImageElement[][]; cast?: HTMLImageElement[] }

export const PROP_KEYS = [
  "bone-pile", "wall-torch", "crypt-chest", "cursed-chest",
  "ghost-wisp", "lava-pool", "magma-chest", "sacrificial-altar"
] as const;

export const Assets = {
  heroes: {} as Record<string, HeroSprite>,
  enemies: {} as Record<string, EnemySprite>,
  ui: {} as Record<string, HTMLImageElement>,
  coinSpin: [] as HTMLImageElement[],
  tileset: null as unknown as HTMLImageElement,
  biomeTiles: {} as Record<string, HTMLImageElement>, // crypt | catacombs | lava
  props: {} as Record<string, HTMLImageElement>,
  slash: null as unknown as HTMLImageElement,
  spark: null as unknown as HTMLImageElement,
  arrow: null as unknown as HTMLImageElement,
  bolt: null as unknown as HTMLImageElement,
  coin: null as unknown as HTMLImageElement,
  chest: null as unknown as HTMLImageElement,
  portalTeal: null as unknown as HTMLImageElement,   // 1×4 strip
  portalPurple: null as unknown as HTMLImageElement, // 1×4 strip
  torch: null as unknown as HTMLImageElement         // 1×4 strip
};

// Probe a per-frame folder until the first missing frame (loadImage resolves
// with width 0 on a 404), so variable frame counts just work.
async function loadFrames(dir: string): Promise<HTMLImageElement[]> {
  const out: HTMLImageElement[] = [];
  for (let i = 0; i < 16; i++) {
    const img = await loadImage(`${dir}/frame_${String(i).padStart(3, "0")}.png`);
    if (img.width) out.push(img); else break;
  }
  return out;
}

export async function loadHero(key: string): Promise<HeroSprite> {
  const base = `${CHR}${key}`;
  const idle: HTMLImageElement[] = [];
  const walk: HTMLImageElement[][] = [];
  for (let d = 0; d < 4; d++) {
    idle[d] = await loadImage(`${base}/rotations/${DIR_NAME[d]}.png`);
    walk[d] = await loadFrames(`${base}/animations/walk/${DIR_NAME[d]}`);
  }
  const attack: HTMLImageElement[][] = [];
  let attack4 = false;
  for (let d = 0; d < 4; d++) {
    const real = await loadFrames(`${base}/animations/attack/${DIR_NAME[d]}`);
    if (d !== 0 && real.length) attack4 = true;       // a non-south direction exists
    attack[d] = real.length ? real : await loadFrames(`${base}/animations/attack/south`);
  }
  const [skill, dash] = await Promise.all([
    loadFrames(`${base}/animations/skill/south`),
    loadFrames(`${base}/animations/dash/south`)
  ]);
  return { idle, walk, attack, attack4, skill, dash };
}

export async function loadAssets(onProgress: (p: number) => void): Promise<void> {
  const jobs: Array<() => Promise<void>> = [];

  for (const key of PLAYER_KEYS) {
    jobs.push(async () => { Assets.heroes[key] = await loadHero(key); });
  }

  for (const [key, def] of Object.entries(ENEMY_DEFS)) {
    jobs.push(async () => {
      const base = `${DUN}enemies/${def.base}`;
      const idle: HTMLImageElement[] = [];
      const walk: HTMLImageElement[][] = [];
      for (let d = 0; d < 4; d++) {
        idle[d] = await loadImage(`${base}/rotations/${DIR_NAME[d]}.png`);
        walk[d] = await loadFrames(`${base}/animations/walking/${DIR_NAME[d]}`);
      }
      const sprite: EnemySprite = { idle, walk };
      if (def.cast) sprite.cast = await loadFrames(`${base}/animations/casting/south`);
      Assets.enemies[key] = sprite;
    });
  }

  const single: Array<[keyof typeof Assets, string]> = [
    ["tileset", `${DUN}tileset-dungeon.png`],
    ["slash", `${DUN}fx-slash.png`],
    ["spark", `${DUN}fx-hit-spark.png`],
    ["arrow", `${DUN}fx/arrow.png`],
    ["bolt", `${DUN}fx/bolt.png`],
    ["coin", `${UI}obol_coin_icon.png`],
    ["chest", `${DUN}pickup-cursed-chest.png`],
    ["portalTeal", `${DEMO}demo-fx-portal-teal.png`],
    ["portalPurple", `${DEMO}demo-fx-portal-purple.png`],
    ["torch", `${DEMO}demo-fx-torch-flame.png`]
  ];
  for (const [field, src] of single) {
    jobs.push(async () => { (Assets as Record<string, unknown>)[field] = await loadImage(src); });
  }

  // biome tilesets (all 128×128 4×4 Wang, same layout as tileset-dungeon)
  const biomes: [string, string][] = [
    ["crypt", `${DUN}tileset-crypt.png`],
    ["catacombs", `${DUN}tileset-catacombs.png`],
    ["lava", `${DUN}tileset-lava.png`]
  ];
  for (const [key, src] of biomes) {
    jobs.push(async () => { Assets.biomeTiles[key] = await loadImage(src); });
  }

  for (const key of PROP_KEYS) {
    jobs.push(async () => { Assets.props[key] = await loadImage(`${DUN}props/${key}.png`); });
  }

  // rebrand UI kit
  const UI_KEYS = [
    "logo_hollowmark", "obol_coin_icon", "currency_hud_icon", "panel_frame", "bar_frame_hp",
    "control_move", "control_attack", "control_skill", "control_dash",
    "emblem_knight", "emblem_archer", "emblem_mage", "emblem_assassin",
    "portal_extract", "portal_descend"
  ];
  for (const k of UI_KEYS) jobs.push(async () => { Assets.ui[k] = await loadImage(`${UI}${k}.png`); });
  jobs.push(async () => { Assets.coinSpin = await loadFrames(`${UI}obol_coin_spin`); });

  let done = 0;
  await Promise.all(jobs.map((j) => j().then(() => onProgress(++done / jobs.length))));
}
