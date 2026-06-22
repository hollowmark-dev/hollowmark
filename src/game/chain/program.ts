/* Client for the Hollowmark on-chain vault (native Solana program, devnet).
   Builds the EnterRun / ExtractRun / ForfeitRun instructions by hand (Borsh-tagged,
   no Anchor client dep) and broadcasts through our own devnet connection so the tx
   always lands on devnet regardless of the wallet's selected cluster.

   Until the program is deployed, PROGRAM_ID stays the placeholder and PROGRAM_READY
   is false — the game then falls back to the Memo path in solana.ts. After
   `solana program deploy`, drop the real id below and flip nothing else. */
import { Buffer } from "buffer";
(globalThis as unknown as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

import {
  Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram,
  clusterApiUrl, LAMPORTS_PER_SOL
} from "@solana/web3.js";
import { wallet, explorer } from "./solana";

/* filled in after `solana program deploy` (see onchain/DEPLOY.md) */
export const PROGRAM_ID_STR: string = "CRMmDMi1VXyfGAuKig9NTFta23QbNAQwTqzrSjxJG9rz";
const PLACEHOLDER: string = "Hmust11111111111111111111111111111111111111";
export const PROGRAM_READY = PROGRAM_ID_STR !== PLACEHOLDER;

/* per-run cost in lamports (tiny on devnet): a non-refundable fee burned to the
   treasury + a refundable stake escrowed in the vault (returned on extract). */
export const RUN_FEE = Math.round(0.005 * LAMPORTS_PER_SOL);
export const RUN_STAKE = Math.round(0.005 * LAMPORTS_PER_SOL);
export const RUN_COST = RUN_FEE + RUN_STAKE;

const TREASURY_SEED = Buffer.from("treasury");
const VAULT_SEED = Buffer.from("vault");

let conn: Connection | null = null;
const connection = () => (conn ??= new Connection(clusterApiUrl("devnet"), "confirmed"));

interface Provider {
  publicKey?: { toString(): string } | null;
  signTransaction?: (tx: Transaction) => Promise<Transaction>;
  signAndSendTransaction?: (tx: Transaction) => Promise<{ signature: string }>;
}
function provider(): Provider | null {
  const w = window as unknown as { solana?: Provider; solflare?: Provider };
  return w.solana ?? w.solflare ?? null;
}

function programId(): PublicKey { return new PublicKey(PROGRAM_ID_STR); }
export function treasuryPda(): PublicKey {
  return PublicKey.findProgramAddressSync([TREASURY_SEED], programId())[0];
}
export function vaultPda(player: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([VAULT_SEED, player.toBuffer()], programId())[0];
}

/* ---- instruction data (Borsh enum: 1-byte tag + fields, little-endian) ---- */
function enterData(stakeLamports: number, feeLamports: number, classId: number): Buffer {
  const b = Buffer.alloc(1 + 8 + 8 + 1);
  b.writeUInt8(1, 0);
  b.writeBigUInt64LE(BigInt(stakeLamports), 1);
  b.writeBigUInt64LE(BigInt(feeLamports), 9);
  b.writeUInt8(classId & 0xff, 17);
  return b;
}
function extractData(depth: number, haul: number): Buffer {
  const b = Buffer.alloc(1 + 2 + 8);
  b.writeUInt8(2, 0);
  b.writeUInt16LE(depth & 0xffff, 1);
  b.writeBigUInt64LE(BigInt(Math.max(0, Math.round(haul))), 3);
  return b;
}
function forfeitData(depth: number): Buffer {
  const b = Buffer.alloc(1 + 2);
  b.writeUInt8(3, 0);
  b.writeUInt16LE(depth & 0xffff, 1);
  return b;
}

const CLASS_ID: Record<string, number> = { knight: 0, archer: 1, mage: 2, assassin: 3 };

export type TxResult =
  | { ok: true; sig: string; url: string }
  | { ok: false; offline: true }
  | { ok: false; offline: false; error: string };

/* Top up devnet SOL so the stake + fees clear. Best-effort (airdrop is rate-limited). */
async function ensureFunds(pk: PublicKey, need: number) {
  try {
    const bal = await connection().getBalance(pk);
    if (bal >= need + 0.003 * LAMPORTS_PER_SOL) return;
    const sig = await connection().requestAirdrop(pk, Math.max(0.2 * LAMPORTS_PER_SOL, need * 2));
    const bh = await connection().getLatestBlockhash();
    await connection().confirmTransaction({ signature: sig, ...bh }, "confirmed");
  } catch { /* proceed; the send will surface a real funding error */ }
}

async function signSend(tx: Transaction, pk: PublicKey): Promise<string> {
  const p = provider();
  if (!p) throw new Error("No wallet.");
  const { blockhash, lastValidBlockHeight } = await connection().getLatestBlockhash();
  tx.feePayer = pk; tx.recentBlockhash = blockhash; tx.lastValidBlockHeight = lastValidBlockHeight;
  if (p.signTransaction) {
    const signed = await p.signTransaction(tx);
    return connection().sendRawTransaction(signed.serialize(), { maxRetries: 3 });
  }
  if (p.signAndSendTransaction) return (await p.signAndSendTransaction(tx)).signature;
  throw new Error("Wallet can't sign transactions.");
}

async function send(ix: TransactionInstruction, need = 0): Promise<TxResult> {
  if (!PROGRAM_READY || !provider() || !wallet.address) return { ok: false, offline: true };
  let pk: PublicKey;
  try { pk = new PublicKey(wallet.address); } catch { return { ok: false, offline: true }; }
  try {
    await ensureFunds(pk, need);
    const sig = await signSend(new Transaction().add(ix), pk);
    return { ok: true, sig, url: explorer(sig) };
  } catch (err) {
    const code = (err as { code?: number })?.code;
    const msg = (err as Error)?.message || "Transaction failed.";
    if (code === 4001 || /reject|denied|cancel/i.test(msg)) return { ok: false, offline: false, error: "You rejected the transaction." };
    if (/insufficient|0x1\b|lamports|debit/i.test(msg)) return { ok: false, offline: false, error: "Devnet SOL too low — airdrop is rate-limited. Try again in a minute." };
    return { ok: false, offline: false, error: msg };
  }
}

/* ---- public: the three run-lifecycle calls ---- */
export async function enterRunTx(classKey: string): Promise<TxResult> {
  const pk = new PublicKey(wallet.address!);
  const ix = new TransactionInstruction({
    programId: programId(),
    keys: [
      { pubkey: pk, isSigner: true, isWritable: true },
      { pubkey: vaultPda(pk), isSigner: false, isWritable: true },
      { pubkey: treasuryPda(), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data: enterData(RUN_STAKE, RUN_FEE, CLASS_ID[classKey] ?? 0)
  });
  return send(ix, RUN_COST);
}

/* ---- wallet balance + faucet (devnet) ---- */
export async function walletBalanceSol(): Promise<number> {
  if (!wallet.address) return 0;
  try { return (await connection().getBalance(new PublicKey(wallet.address))) / LAMPORTS_PER_SOL; }
  catch { return 0; }
}

/* Ask the server-side faucet (deployer wallet on vps1) to top up the connected
   wallet with devnet SOL so the player can afford entries. */
export async function requestFaucet(): Promise<{ ok: boolean; sig?: string; error?: string }> {
  if (!wallet.address) return { ok: false, error: "Connect a wallet first." };
  try {
    const res = await fetch("/api/faucet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: wallet.address })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: j.error || `Faucet error (${res.status}).` };
    return { ok: true, sig: j.sig };
  } catch (e) { return { ok: false, error: (e as Error).message || "Faucet unreachable." }; }
}

export async function extractRunTx(depth: number, haul: number): Promise<TxResult> {
  const pk = new PublicKey(wallet.address!);
  const ix = new TransactionInstruction({
    programId: programId(),
    keys: [
      { pubkey: pk, isSigner: true, isWritable: true },
      { pubkey: vaultPda(pk), isSigner: false, isWritable: true }
    ],
    data: extractData(depth, haul)
  });
  return send(ix);
}

export async function forfeitRunTx(depth: number): Promise<TxResult> {
  const pk = new PublicKey(wallet.address!);
  const ix = new TransactionInstruction({
    programId: programId(),
    keys: [
      { pubkey: pk, isSigner: true, isWritable: true },
      { pubkey: vaultPda(pk), isSigner: false, isWritable: true },
      { pubkey: treasuryPda(), isSigner: false, isWritable: true }
    ],
    data: forfeitData(depth)
  });
  return send(ix);
}
