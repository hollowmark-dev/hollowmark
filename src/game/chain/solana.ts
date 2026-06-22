/* Solana devnet wiring. Real, signed, verifiable transactions gate the run:
   entering and extracting each write a tagged Memo-program tx. If no wallet is
   present everything degrades to offline play — the game stays fully playable. */
import { Buffer } from "buffer";
// web3.js touches the Buffer global in the browser; make sure it exists.
(globalThis as unknown as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

import {
  Connection, PublicKey, Transaction, TransactionInstruction, clusterApiUrl, LAMPORTS_PER_SOL
} from "@solana/web3.js";

const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
// Base58 sanity check for a Solana account.
const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LS_KEY = "gg-wallet-v1";

interface Provider {
  publicKey?: { toString(): string } | null;
  isPhantom?: boolean;
  connect: (o?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: { toString(): string } }>;
  disconnect: () => Promise<void>;
  signAndSendTransaction?: (tx: Transaction) => Promise<{ signature: string }>;
  signTransaction?: (tx: Transaction) => Promise<Transaction>;
  on?: (e: string, h: (...a: unknown[]) => void) => void;
}

function provider(): Provider | null {
  const w = window as unknown as { solana?: Provider; solflare?: Provider };
  if (typeof w.solana?.connect === "function") return w.solana;
  if (typeof w.solflare?.connect === "function") return w.solflare;
  return null;
}

let conn: Connection | null = null;
const connection = () => (conn ??= new Connection(clusterApiUrl("devnet"), "confirmed"));

export const wallet = { address: null as string | null };
export const hasWallet = () => !!provider();
export const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

export async function connectWallet(): Promise<{ address: string } | { error: string }> {
  const p = provider();
  if (!p) return { error: "No Solana wallet detected. Install Phantom or Solflare — or play offline." };
  try {
    const res = await p.connect();
    const address = (res?.publicKey ?? p.publicKey)?.toString();
    if (!address) return { error: "No account selected." };
    wallet.address = address;
    try { localStorage.setItem(LS_KEY, JSON.stringify({ address })); } catch { /* ignore */ }
    return { address };
  } catch (err) {
    const code = (err as { code?: number })?.code;
    const msg = (err as Error)?.message || "";
    if (code === 4001 || /reject|denied|cancel/i.test(msg)) return { error: "Connection rejected." };
    return { error: msg || "Could not connect." };
  }
}

export async function disconnectWallet() {
  try { await provider()?.disconnect?.(); } catch { /* ignore */ }
  wallet.address = null;
  try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
}

export async function restoreWallet(): Promise<string | null> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const { address } = JSON.parse(raw) as { address?: string };
    if (!address || !SOL_ADDR_RE.test(address)) return null;
    wallet.address = address;
    provider()?.connect?.({ onlyIfTrusted: true })
      .then((r) => { const a = r?.publicKey?.toString(); if (a) wallet.address = a; })
      .catch(() => { /* keep cached */ });
    return address;
  } catch { return null; }
}

/* Top up devnet SOL for fees if the balance is dust. Best-effort (airdrop is
   frequently rate-limited); failure is non-fatal — the tx attempt still happens. */
async function ensureFees(pk: PublicKey) {
  try {
    const bal = await connection().getBalance(pk);
    if (bal >= 0.003 * LAMPORTS_PER_SOL) return;
    const sig = await connection().requestAirdrop(pk, 0.2 * LAMPORTS_PER_SOL);
    const bh = await connection().getLatestBlockhash();
    await connection().confirmTransaction({ signature: sig, ...bh }, "confirmed");
  } catch { /* ignore — proceed and let the send surface any real problem */ }
}

export type MemoResult =
  | { ok: true; sig: string }
  | { ok: false; offline: true }
  | { ok: false; offline: false; error: string };

/* Send a tagged Memo tx. kind is "enter" | "extract". */
export async function sendRunMemo(kind: string, fields: Record<string, string | number>): Promise<MemoResult> {
  const p = provider();
  if (!p || !wallet.address) return { ok: false, offline: true };
  let pk: PublicKey;
  try { pk = new PublicKey(wallet.address); } catch { return { ok: false, offline: true }; }

  const memo = `hollowmark|${kind}|` +
    Object.entries(fields).map(([k, v]) => `${k}=${v}`).join("|") + `|t=${Date.now()}`;

  try {
    await ensureFees(pk);
    const { blockhash, lastValidBlockHeight } = await connection().getLatestBlockhash();
    const tx = new Transaction({ feePayer: pk, blockhash, lastValidBlockHeight });
    tx.add(new TransactionInstruction({
      keys: [{ pubkey: pk, isSigner: true, isWritable: true }],
      programId: MEMO_PROGRAM,
      data: Buffer.from(memo, "utf8")
    }));

    // Prefer sign-only + broadcast through OUR devnet connection so the tx always
    // lands on devnet, no matter which cluster the wallet UI is set to. This keeps
    // entry/extract seamless — the player never has to manually switch networks.
    let sig: string;
    if (p.signTransaction) {
      const signed = await p.signTransaction(tx);
      sig = await connection().sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
    } else if (p.signAndSendTransaction) {
      // fallback: wallet-driven send (uses the wallet's selected cluster)
      ({ signature: sig } = await p.signAndSendTransaction(tx));
    } else {
      return { ok: false, offline: false, error: "Wallet can't sign transactions." };
    }
    return { ok: true, sig };
  } catch (err) {
    const code = (err as { code?: number })?.code;
    const msg = (err as Error)?.message || "Transaction failed.";
    if (code === 4001 || /reject|denied|cancel/i.test(msg)) return { ok: false, offline: false, error: "You rejected the transaction." };
    if (/insufficient|0x1\b|debit an account|lamports/i.test(msg))
      return { ok: false, offline: false, error: "Devnet SOL too low — airdrop is rate-limited. Try again in a minute." };
    if (/blockhash|block height|expired/i.test(msg))
      return { ok: false, offline: false, error: "Network hiccup (stale blockhash). Try again." };
    return { ok: false, offline: false, error: msg };
  }
}
