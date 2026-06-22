// Hollowmark vps1 server: serves the static game build AND a devnet faucet.
//   GET  /*           -> static files from DIST
//   POST /api/faucet  -> { address } -> sends GRANT devnet SOL from the deployer
//                        wallet if the recipient is low (rate-limited per address).
// Run: node server.mjs   (expects ./deployer.json next to it; DIST below)
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection, Keypair, PublicKey, Transaction, SystemProgram,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL
} from "@solana/web3.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = process.env.HM_DIST || "/root/hollowmark-dist";
const PORT = Number(process.env.HM_PORT || 8788);

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(join(HERE, "deployer.json")))));

const GRANT = Math.round(0.1 * LAMPORTS_PER_SOL);       // top-up size
const TOPUP_BELOW = Math.round(0.05 * LAMPORTS_PER_SOL); // only fund wallets under this
const COOLDOWN_MS = 10 * 60 * 1000;                      // per-address cooldown
const last = new Map();

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".json": "application/json", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2", ".woff": "font/woff", ".mp4": "video/mp4", ".gif": "image/gif", ".txt": "text/plain" };

const json = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(obj));
};

async function faucet(res, body) {
  let address;
  try { address = JSON.parse(body).address; } catch { return json(res, 400, { error: "bad request" }); }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address || "")) return json(res, 400, { error: "invalid address" });
  let pk;
  try { pk = new PublicKey(address); } catch { return json(res, 400, { error: "invalid address" }); }

  const now = Date.now();
  if (last.has(address) && now - last.get(address) < COOLDOWN_MS)
    return json(res, 429, { error: "Already topped up recently — try again in ~10 min." });
  try {
    const bal = await conn.getBalance(pk);
    if (bal >= TOPUP_BELOW) return json(res, 200, { ok: true, skipped: true, balanceSol: bal / LAMPORTS_PER_SOL });
    last.set(address, now);
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: pk, lamports: GRANT }));
    const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return json(res, 200, { ok: true, sig, grantedSol: GRANT / LAMPORTS_PER_SOL });
  } catch (e) { last.delete(address); return json(res, 500, { error: String(e?.message || e) }); }
}

async function serveStatic(urlPath, res) {
  let p = decodeURIComponent(new URL(urlPath, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const full = normalize(join(DIST, p));
  if (!full.startsWith(DIST)) { res.writeHead(403); return res.end("forbidden"); }
  try {
    const s = await stat(full);
    if (s.isDirectory()) return serveStatic(p + "/index.html", res);
    const data = await readFile(full);
    res.writeHead(200, { "content-type": MIME[extname(full)] || "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404); res.end("not found"); }
}

createServer((req, res) => {
  if (req.method === "OPTIONS")
    return res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-headers": "content-type" }).end();
  if (req.method === "POST" && req.url === "/api/faucet") {
    let body = ""; req.on("data", (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on("end", () => faucet(res, body));
    return;
  }
  serveStatic(req.url, res);
}).listen(PORT, "127.0.0.1", () => console.log(`hollowmark server (static + faucet) on 127.0.0.1:${PORT}, payer ${payer.publicKey.toBase58()}`));
