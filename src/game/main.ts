/* Hollowmark — playable dungeon-extraction loop (T0). Orchestrates boot, the
   class-select front end, the Solana-gated entry, the run, and the results. */
import "../styles/base.css";
import "../styles/game.css";
import { loadAssets, PLAYER_KEYS } from "./engine/loader";
import { initInput, setEnabled, isTouch, input } from "./engine/input";
import { createDungeon, type Scene } from "./scenes/dungeon";
import { game, load as loadState, save, startRun, endRun, CLASS_STATS, UPGRADES, buyUpgrade, bestRun, type UpgradeKey } from "./state";
import { connectWallet, disconnectWallet, restoreWallet, wallet, hasWallet, sendRunMemo, explorer } from "./chain/solana";
import { enterRunTx, extractRunTx, forfeitRunTx, requestFaucet, walletBalanceSol, PROGRAM_READY, RUN_COST } from "./chain/program";
import { Audio } from "./engine/audio";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>("game");
const ctx = canvas.getContext("2d")!;
let VW = 0, VH = 0;
function resize() {
  VW = canvas.width = window.innerWidth;
  VH = canvas.height = window.innerHeight;
  ctx.imageSmoothingEnabled = false;
}
resize();
window.addEventListener("resize", resize);
const view = () => ({ w: VW, h: VH });

if (isTouch) document.body.classList.add("touch");

/* ---------------- scene ---------------- */
let scene: Scene | null = null;
const dungeon = createDungeon(ctx, view, { onExtract, onDeath, onDepthChange });

/* ---------------- overlays / dom ---------------- */
const selectOverlay = $("selectOverlay");
const classGrid = $("classGrid");
const bootProgress = $("bootProgress");
const bootBar = $("bootBar");
const enterBtn = $<HTMLButtonElement>("enterBtn");
const selectHint = $("selectHint");
const resultsOverlay = $("resultsOverlay");
const controls = $("controls");
const coinHud = $("coinHud");
const coinNow = $("coinNow");
const coinBanked = $("coinBanked");
const keycaps = $("keycaps");
const records = $("records");
const shop = $("shop");

/* keycap legend: press feedback + click-to-act */
function setupKeycaps() {
  const caps = Array.from(document.querySelectorAll<HTMLElement>(".kc"));
  const byKey = (k: string) => caps.filter((c) => c.dataset.k === k);
  window.addEventListener("keydown", (e) => byKey(e.key.toLowerCase()).forEach((c) => c.classList.add("down")));
  window.addEventListener("keyup", (e) => byKey(e.key.toLowerCase()).forEach((c) => c.classList.remove("down")));
  for (const c of caps) {
    const k = c.dataset.k as string;
    const down = (e: Event) => { e.preventDefault(); c.classList.add("down"); window.dispatchEvent(new KeyboardEvent("keydown", { key: k })); };
    const up = () => { c.classList.remove("down"); window.dispatchEvent(new KeyboardEvent("keyup", { key: k })); };
    c.addEventListener("pointerdown", down);
    c.addEventListener("pointerup", up);
    c.addEventListener("pointerleave", () => c.classList.remove("down"));
  }
}
function showRunHud(on: boolean) { coinHud.hidden = !on; keycaps.hidden = !on; }

let assetsReady = false;
let loading = false;

/* class portraits use the regenerated hero idle (south) — one consistent set */
const PORTRAIT: Record<string, string> = {
  knight: "/assets/generated/characters/knight/rotations/south.png",
  archer: "/assets/generated/characters/archer/rotations/south.png",
  mage: "/assets/generated/characters/mage/rotations/south.png",
  assassin: "/assets/generated/characters/assassin/rotations/south.png"
};
const TAGLINE: Record<string, string> = {
  knight: "Holds the line", archer: "Looses from range",
  mage: "Hexes from afar", assassin: "Blinks in for the kill"
};

function buildClassGrid() {
  classGrid.innerHTML = "";
  for (const key of PLAYER_KEYS) {
    const cs = CLASS_STATS[key];
    const btn = document.createElement("button");
    btn.className = "classCard";
    btn.dataset.class = key;
    btn.innerHTML =
      `<img class="emblem" src="/assets/generated/ui/emblem_${key}.png" alt="" aria-hidden="true">` +
      `<img src="${PORTRAIT[key]}" alt="${key}">` +
      `<b>${key.toUpperCase()}</b>` +
      `<span class="tl">${TAGLINE[key]}</span>` +
      `<span class="st">HP ${cs.hp} · SPD ${Math.round(cs.speed / 10)} · DMG ${cs.atkDmg}</span>`;
    btn.addEventListener("click", () => selectClass(key, btn));
    classGrid.appendChild(btn);
  }
}

/* ---- town: records (local leaderboard) + the Outfitter (sink) ---- */
function renderRecords() {
  const b = bestRun();
  records.innerHTML =
    `<span><i>BANKED</i><b class="t-gold">${game.balance}</b></span>` +
    `<span><i>BEST DEPTH</i><b>${b.depth || "—"}</b></span>` +
    `<span><i>BEST HAUL</i><b>${b.haul || "—"}</b></span>` +
    `<span><i>RUNS</i><b>${b.runs}</b></span>`;
}
function renderShop() {
  shop.innerHTML = "";
  (Object.keys(UPGRADES) as UpgradeKey[]).forEach((key) => {
    const u = UPGRADES[key];
    const owned = game.shop[key];
    const btn = document.createElement("button");
    btn.className = "shopItem";
    btn.disabled = game.balance < u.price;
    btn.style.setProperty("--c", u.color);
    btn.innerHTML =
      `<b>${u.name}</b><span class="blurb">${u.blurb}</span>` +
      `<span class="buy">${u.price} $OBOL</span>` +
      (owned ? `<span class="owned">▶ ${owned} ready</span>` : `<span class="owned dim">—</span>`);
    btn.addEventListener("click", () => {
      if (buyUpgrade(key)) { Audio.init(); Audio.sfx("coin"); renderShop(); renderRecords(); toast(`${u.name} stocked — applies to your next run`); }
      else toast("Not enough $OBOL — extract a run first");
    });
    shop.appendChild(btn);
  });
}
function refreshTown() { renderRecords(); renderShop(); }

async function selectClass(key: string, btn: HTMLElement) {
  game.classKey = key; save();
  classGrid.querySelectorAll(".classCard").forEach((b) => b.classList.toggle("is-sel", b === btn));
  if (assetsReady) { enterBtn.hidden = false; return; }
  if (loading) return;
  loading = true;
  bootProgress.hidden = false;
  await loadAssets((p) => { bootBar.style.width = `${Math.round(p * 100)}%`; });
  assetsReady = true;
  bootProgress.hidden = true;
  enterBtn.hidden = false;
}

/* ---------------- run flow ---------------- */
const ENTRY_SOL = (RUN_COST / 1e9).toFixed(3);

async function beginRun() {
  if (!assetsReady) return;
  Audio.init();
  // wallet is REQUIRED to enter — the run is gated on a real on-chain payment
  if (!hasWallet()) { setHint("No Solana wallet found — install Phantom or Solflare to play."); return; }
  if (!wallet.address) { setHint("Connect your wallet first ↑"); return; }
  enterBtn.disabled = true;
  setHint(`Approve the entry — ${ENTRY_SOL} devnet SOL — in your wallet…`);
  const r = await enterRunTx(game.classKey);
  enterBtn.disabled = false;
  if (!r.ok) {
    if (r.offline) { setHint("Wallet not ready — reconnect and try again."); return; }
    setHint(r.error);
    if (/SOL|fund|airdrop|lamport|insufficient/i.test(r.error)) { toast("Low on devnet SOL — tap “◎ GET SOL” up top."); await refreshFaucetState(); }
    return; // payment failed → no entry
  }
  game.chainOn = true;
  toast("Entry sealed onchain", explorer(r.sig));
  startRun();
  hide(selectOverlay);
  controls.classList.toggle("show", isTouch);
  showRunHud(true);
  Audio.startMusic();
  scene = dungeon;
  dungeon.enter();
  setHint("");
  refreshFaucetState();
}

function onDepthChange(d: number) {
  if (d > 1) toast(`Descending… Depth ${d}`);
}

async function onExtract() {
  const haul = game.run.haul, depth = game.run.depth;
  endRun("extract");
  Audio.sfx("extract"); Audio.duckMusic();
  scene = null;
  controls.classList.remove("show");
  showRunHud(false);
  showResults({
    title: "EXTRACTED", cls: "win",
    body: depth >= 5 ? "You bested the Grave Warden and walked out with the haul." : "You reached the portal alive. The haul is yours.",
    haul, depth, banked: true
  });
  if (hasWallet() && wallet.address) {
    const r = PROGRAM_READY ? await extractRunTx(depth, haul) : await sendRunMemo("extract", { depth, haul });
    if (r.ok) setResultTx(explorer(r.sig));
  }
}

async function onDeath() {
  const haul = game.run.haul, depth = game.run.depth;
  endRun("death");
  Audio.sfx("death"); Audio.duckMusic();
  scene = null;
  controls.classList.remove("show");
  showRunHud(false);
  showResults({
    title: "YOU FELL", cls: "lose",
    body: "The Hollowmark claims what you carried. The death tax feeds the dark for the next soul to descend.",
    haul, depth, banked: false
  });
  // death sweeps your staked entry to the Grave treasury (on-chain death tax)
  if (PROGRAM_READY && hasWallet() && wallet.address) {
    const r = await forfeitRunTx(depth);
    if (r.ok) setResultTx(explorer(r.sig));
  }
}

/* ---------------- results overlay ---------------- */
interface ResultOpts { title: string; cls: string; body: string; haul: number; depth: number; banked: boolean }
function showResults(o: ResultOpts) {
  $("resTitle").textContent = o.title;
  $("resTitle").className = o.cls;
  $("resBody").textContent = o.body;
  $("resStats").innerHTML =
    `<div><span>Depth reached</span><b>${o.depth}</b></div>` +
    `<div><span>Haul</span><b class="${o.banked ? "win" : "lose"}">${o.banked ? "+" : "−"}${o.haul} $OBOL</b></div>` +
    `<div><span>Banked $OBOL</span><b>${game.balance}</b></div>`;
  const tx = $<HTMLAnchorElement>("resTx");
  tx.hidden = true; tx.removeAttribute("href");
  show(resultsOverlay);
}
function setResultTx(url: string) {
  const tx = $<HTMLAnchorElement>("resTx");
  tx.href = url; tx.hidden = false;
}

/* ---------------- wallet + faucet ---------------- */
const walletBtn = $<HTMLButtonElement>("walletBtn");
const faucetBtn = $<HTMLButtonElement>("faucetBtn");
const selectWallet = $("selectWallet");
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

async function doConnect(btn?: HTMLButtonElement) {
  if (btn) { btn.disabled = true; btn.textContent = "CONNECTING…"; }
  const r = await connectWallet();
  if ("error" in r) toast(r.error);
  refreshFaucetState();
}
async function doDisconnect() { await disconnectWallet(); refreshFaucetState(); }
async function doFaucet(btn?: HTMLButtonElement) {
  if (!wallet.address) return;
  if (btn) btn.disabled = true;
  const r = await requestFaucet();
  if (btn) btn.disabled = false;
  toast(r.ok ? (r.sig ? "Devnet SOL dripped to your wallet ✓" : "You already have enough devnet SOL") : (r.error || "Faucet failed"));
  refreshFaucetState();
}

function renderWallet() {
  if (wallet.address) { walletBtn.textContent = short(wallet.address); walletBtn.dataset.state = "on"; }
  else { walletBtn.textContent = "CONNECT WALLET"; walletBtn.dataset.state = "off"; }
  faucetBtn.hidden = !wallet.address;
}
/* wallet block shown in the select popup — connect FIRST, here, before entering */
function renderSelectWallet(balSol: number | null) {
  if (wallet.address) {
    const low = balSol != null && balSol < RUN_COST / 1e9;
    selectWallet.innerHTML =
      `<span class="sw-on">◎ ${short(wallet.address)}</span>` +
      `<span class="sw-bal${low ? " low" : ""}">${balSol == null ? "…" : balSol.toFixed(3)} SOL</span>` +
      `<button id="swFaucet" class="rbtn rbtn-dark${low ? " sw-pulse" : ""}">◎ GET SOL</button>` +
      `<button id="swDisc" class="sw-link">disconnect</button>`;
    (selectWallet.querySelector("#swFaucet") as HTMLButtonElement).onclick = (e) => doFaucet(e.currentTarget as HTMLButtonElement);
    (selectWallet.querySelector("#swDisc") as HTMLButtonElement).onclick = doDisconnect;
  } else {
    selectWallet.innerHTML =
      `<button id="swConnect" class="rbtn rbtn-gold-frame sw-connect">◎ CONNECT WALLET TO PLAY</button>` +
      `<span class="sw-note">required — every run is a real on-chain stake on devnet</span>`;
    (selectWallet.querySelector("#swConnect") as HTMLButtonElement).onclick = (e) => doConnect(e.currentTarget as HTMLButtonElement);
  }
}
async function refreshFaucetState() {
  renderWallet();
  renderSelectWallet(null);
  if (!wallet.address) return;
  const bal = await walletBalanceSol();
  faucetBtn.dataset.low = bal < (RUN_COST / 1e9) ? "1" : "0"; // glow when you can't afford an entry
  renderSelectWallet(bal);
}
walletBtn.addEventListener("click", () => { if (wallet.address) doDisconnect(); else doConnect(walletBtn); });
faucetBtn.addEventListener("click", (e) => doFaucet(e.currentTarget as HTMLButtonElement));

/* ---------------- mute ---------------- */
const muteBtn = $<HTMLButtonElement>("muteBtn");
muteBtn.addEventListener("click", () => {
  Audio.init();
  const m = Audio.toggleMute();
  muteBtn.dataset.muted = m ? "1" : "0";
  muteBtn.textContent = m ? "♪ OFF" : "♪ ON";
});

/* ---------------- toast ---------------- */
let toastT: number | undefined;
function toast(msg: string, link?: string) {
  const t = $("toast");
  t.innerHTML = link ? `${msg} <a href="${link}" target="_blank" rel="noopener">view tx ↗</a>` : msg;
  t.hidden = false; t.classList.add("show");
  clearTimeout(toastT);
  toastT = window.setTimeout(() => { t.classList.remove("show"); }, link ? 6000 : 2600);
}

const setHint = (s: string) => { selectHint.textContent = s; };
const show = (el: HTMLElement) => { el.hidden = false; };
const hide = (el: HTMLElement) => { el.hidden = true; };

/* ---------------- buttons ---------------- */
enterBtn.addEventListener("click", beginRun);
$("againBtn").addEventListener("click", () => {
  hide(resultsOverlay);
  enterBtn.hidden = !assetsReady ? true : false;
  setHint("");
  refreshTown();          // reflect freshly-banked $OBOL + new records
  show(selectOverlay);
});

/* ---------------- loop ---------------- */
let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  try {
    const s = scene;
    if (s) {
      s.update(dt);
      // a run can end mid-update (death/extract null out `scene`); only draw if it's still live
      if (scene) {
        s.draw();
        coinNow.textContent = String(game.run.haul);
        coinBanked.textContent = String(game.balance);
      }
    } else { ctx.fillStyle = "#070a09"; ctx.fillRect(0, 0, VW, VH); }
  } catch (err) {
    console.error("frame loop error (recovered):", err);
  }
  requestAnimationFrame(frame); // never let an exception kill the loop
}

/* ---------------- boot ---------------- */
(window as unknown as { GG: unknown }).GG = { game, wallet, input, dungeon }; // debug/testing handle
loadState();
initInput();
setupKeycaps();
setEnabled(false);
buildClassGrid();
refreshTown();
refreshFaucetState();
restoreWallet().then(refreshFaucetState);
requestAnimationFrame(frame);
